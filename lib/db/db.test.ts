import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryScanStore } from './memory';
import { createFileScanStore } from './file';
import type { ScanStore } from './store';
import type { FindingDraft } from '../types/index';

const business = (over: Partial<Parameters<ScanStore['upsertBusiness']>[0]> = {}) => ({
  name: 'Riverside Plumbing',
  domain: 'riversideplumbing.example',
  place_id: 'p_riverside',
  vertical: 'trades.plumbing',
  region: 'SW18',
  platform: null,
  socials: {},
  ...over,
});

const draft = (over: Partial<FindingDraft> = {}): FindingDraft => ({
  target_id: 't1',
  code: 'TECH_NO_HTTPS',
  collector: 'sitetech',
  severity: 'critical',
  confidence: 'verified',
  measured_value: null,
  measured_unit: null,
  measured_text: null,
  benchmark_value: null,
  benchmark_source: null,
  evidence: { final_url: 'http://x.test/' },
  ...over,
});

describe('businesses are deduplicated on place_id', () => {
  test('the same business seen twice is one row', async () => {
    // The same plumber is the subject of one scan and a competitor in three others. Four
    // rows would put them in the benchmark percentile four times.
    const store = new MemoryScanStore();
    const first = await store.upsertBusiness(business());
    const again = await store.upsertBusiness(business({ name: 'Riverside Plumbing Ltd' }));

    assert.equal(first.id, again.id);
    assert.equal(store.state.businesses.length, 1);
  });

  test('a later scan may know more, and that wins', async () => {
    const store = new MemoryScanStore();
    await store.upsertBusiness(business({ domain: null }));
    const updated = await store.upsertBusiness(business({ domain: 'riversideplumbing.example' }));
    assert.equal(updated.domain, 'riversideplumbing.example');
  });

  test('a business with no place_id is never merged into another', async () => {
    const store = new MemoryScanStore();
    await store.upsertBusiness(business({ place_id: null }));
    await store.upsertBusiness(business({ place_id: null, name: 'Someone Else' }));
    assert.equal(store.state.businesses.length, 2);
  });
});

describe('findings are replaced, not appended', () => {
  test('re-normalising a scan does not leave the old findings behind', async () => {
    // Rule 3: rules change weekly and captures do not. A replay has to be idempotent.
    const store = new MemoryScanStore();
    const scan = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });

    await store.saveFindings(scan.id, [draft(), draft({ code: 'TECH_NO_SITEMAP', severity: 'low' })]);
    const second = await store.saveFindings(scan.id, [draft()]);

    assert.equal(second.length, 1);
    assert.equal((await store.findingsForScan(scan.id)).length, 1);
  });

  test('another scan’s findings are untouched', async () => {
    const store = new MemoryScanStore();
    const a = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });
    const b = await store.createScan({ subject_id: 'b2', mode: 'cold', keyword_set: null });

    await store.saveFindings(a.id, [draft()]);
    await store.saveFindings(b.id, [draft(), draft()]);
    await store.saveFindings(a.id, []);

    assert.equal((await store.findingsForScan(b.id)).length, 2);
  });
});

describe('raw captures are reachable from the scan', () => {
  test('captures come back through their collector run', async () => {
    // Rule 3 again: the replay path needs to find the payloads without a second purchase.
    const store = new MemoryScanStore();
    const scan = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });
    const run = await store.recordCollectorRun({
      scan_id: scan.id,
      target_id: 't1',
      collector: 'gbp',
      status: 'ok',
      requires_auth: false,
      cost_pence: 3,
      duration_ms: 12,
      error: null,
    });
    await store.saveRawCapture({ collector_run_id: run.id, source: 'gbp', payload: { a: 1 } });

    const captures = await store.rawCapturesForScan(scan.id);
    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0]!.payload, { a: 1 });
  });

  test('a capture from another scan does not come back', async () => {
    const store = new MemoryScanStore();
    const a = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });
    const b = await store.createScan({ subject_id: 'b2', mode: 'cold', keyword_set: null });
    const run = await store.recordCollectorRun({
      scan_id: b.id,
      target_id: 't1',
      collector: 'gbp',
      status: 'ok',
      requires_auth: false,
      cost_pence: 3,
      duration_ms: 1,
      error: null,
    });
    await store.saveRawCapture({ collector_run_id: run.id, source: 'gbp', payload: {} });

    assert.equal((await store.rawCapturesForScan(a.id)).length, 0);
  });
});

describe('scan lifecycle', () => {
  test('a scan starts queued and records how it ended', async () => {
    const store = new MemoryScanStore();
    const scan = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });
    assert.equal(scan.status, 'queued');
    assert.equal(scan.completed_at, null);

    await store.updateScan(scan.id, { status: 'complete', cost_pence: 214, completed: true });
    const done = (await store.getScan(scan.id))!;

    assert.equal(done.status, 'complete');
    assert.equal(done.cost_pence, 214);
    assert.notEqual(done.completed_at, null);
  });

  test('a failure keeps its reason', async () => {
    const store = new MemoryScanStore();
    const scan = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });
    await store.updateScan(scan.id, { status: 'failed', error: 'narrative rejected', completed: true });
    assert.match((await store.getScan(scan.id))!.error!, /rejected/);
  });

  test('scans list newest first', async () => {
    let tick = 0;
    const store = new MemoryScanStore({ now: () => new Date(1_700_000_000_000 + tick++ * 1000) });
    const first = await store.createScan({ subject_id: 'b1', mode: 'cold', keyword_set: null });
    const second = await store.createScan({ subject_id: 'b2', mode: 'cold', keyword_set: null });

    const listed = await store.listScans();
    assert.deepEqual(listed.map((s) => s.id), [second.id, first.id]);
  });
});

describe('benchmarks', () => {
  test('are empty until something has aggregated them', async () => {
    // The honest answer at scan one. The brief lists codes it must not quote rather than
    // citing a percentile built on nothing.
    const store = new MemoryScanStore();
    assert.deepEqual(await store.benchmarks('trades.plumbing', 'SW18'), []);
  });

  test('a national row matches any region', async () => {
    const store = new MemoryScanStore();
    store.state.benchmarks.push({
      vertical: 'trades.plumbing',
      region: null,
      code: 'REVIEW_VELOCITY_LOW',
      metric: 'per_month',
      p25: 1,
      p50: 4,
      p75: 8,
      sample_size: 60,
      updated_at: 'x',
    });

    assert.equal((await store.benchmarks('trades.plumbing', 'SW18')).length, 1);
    assert.equal((await store.benchmarks('clinic.dental', 'SW18')).length, 0);
  });
});

describe('the file store', () => {
  test('survives a restart, which is the whole point of it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scans-'));
    const path = join(dir, 'store.json');

    try {
      const first = createFileScanStore(path);
      const b = await first.upsertBusiness(business());
      const scan = await first.createScan({ subject_id: b.id, mode: 'cold', keyword_set: null });
      await first.saveFindings(scan.id, [draft()]);
      await first.updateScan(scan.id, { status: 'complete', cost_pence: 214, completed: true });

      // A second process, reading what the first wrote.
      const reopened = createFileScanStore(path);
      const scans = await reopened.listScans();

      assert.equal(scans.length, 1);
      assert.equal(scans[0]!.cost_pence, 214);
      assert.equal((await reopened.findingsForScan(scan.id)).length, 1);
      assert.equal((await reopened.benchmarks('trades.plumbing', 'SW18')).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a missing file is an empty store rather than a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scans-'));
    try {
      const store = createFileScanStore(join(dir, 'nothing-here.json'));
      assert.deepEqual(await store.listScans(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt file is an empty store rather than a crash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'scans-'));
    const path = join(dir, 'store.json');
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, '{ this is not json');
      const store = createFileScanStore(path);
      assert.deepEqual(await store.listScans(), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('reports where it lives, so a run says which store it wrote to', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scans-'));
    try {
      assert.match(createFileScanStore(join(dir, 's.json')).name, /^file:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
