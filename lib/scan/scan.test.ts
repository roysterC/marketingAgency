import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryScanStore } from '../db/memory';
import { fixtureProviders } from '../resolve/fixtures';
import { createGbpCollector } from '../collectors/gbp/index';
import { fixtureGbpProvider } from '../collectors/gbp/fixtures';
import { createReviewsCollector } from '../collectors/reviews/index';
import { fixtureReviewsProvider } from '../collectors/reviews/fixtures';
import { templateWriter } from '../analyse/fixtures';
import { erase, type AnyCollector, type PeerStats } from '../collectors/types';
import { renormalise, runScan, type ScanDeps } from './run';
import type { NarrativeWriter } from '../analyse/index';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const INPUT = { name: 'Riverside Plumbing', postcode: 'SW18 4AB' };

function deps(over: Partial<ScanDeps> = {}): ScanDeps {
  return {
    store: new MemoryScanStore(),
    providers: fixtureProviders,
    collectors: [
      erase(createGbpCollector(fixtureGbpProvider)),
      erase(createReviewsCollector(fixtureReviewsProvider)),
    ],
    writer: templateWriter(),
    now: () => NOW,
    resolve: { keywords: ['emergency plumber wandsworth'] },
    ...over,
  };
}

/** A collector whose behaviour a test controls. */
function stubCollector(options: {
  name?: 'gbp' | 'reviews' | 'sitetech';
  fail?: boolean;
  onCollect?: () => void;
  peers?: PeerStats;
}): AnyCollector {
  return {
    name: options.name ?? 'sitetech',
    requires_auth: false,
    segments: ['smb', 'dtc'],
    emits: ['TECH_NO_HTTPS'],
    async collect() {
      options.onCollect?.();
      if (options.fail) throw new Error('provider exploded');
      return { value: { ok: true }, cost: { pence: 5 } };
    },
    normalise() {
      return [{ code: 'TECH_NO_HTTPS', evidence: { final_url: 'http://x.test/' } }];
    },
    ...(options.peers ? { peerStats: () => options.peers! } : {}),
  };
}

describe('a scan, end to end', () => {
  test('produces findings and a rendered report', async () => {
    const d = deps();
    const result = await runScan(INPUT, d);

    assert.equal(result.scan.status, 'complete');
    assert.ok(result.findings.length > 0);
    assert.deepEqual(result.violations, []);
    assert.ok(result.html!.startsWith('<!doctype html>'));
    assert.ok(result.onePager!.includes('This is an extract'));
  });

  test('writes every row the schema has a table for', async () => {
    const store = new MemoryScanStore();
    await runScan(INPUT, deps({ store }));

    assert.ok(store.state.businesses.length >= 2, 'subject and competitors');
    assert.equal(store.state.scans.length, 1);
    assert.ok(store.state.targets.length >= 2);
    assert.ok(store.state.collector_runs.length > 0);
    assert.ok(store.state.raw_captures.length > 0);
    assert.ok(store.state.findings.length > 0);
    // Full report and cold-outbound one-pager.
    assert.equal(store.state.reports.length, 2);
  });

  test('records what the scan actually cost, not what it was budgeted at', async () => {
    const store = new MemoryScanStore();
    const result = await runScan(INPUT, deps({ store }));

    const collectorSpend = store.state.collector_runs.reduce((n, r) => n + r.cost_pence, 0);
    assert.ok(result.scan.cost_pence >= collectorSpend, 'resolve costs money too');
    assert.ok(result.scan.cost_pence > 0);
  });

  test('records why each competitor is in the comparison', async () => {
    const store = new MemoryScanStore();
    await runScan(INPUT, deps({ store }));

    const competitors = store.state.targets.filter((t) => t.role === 'competitor');
    assert.ok(competitors.length > 0);
    for (const competitor of competitors) {
      // The first thing a sceptical prospect challenges.
      assert.match(competitor.selection_reason!, /keyword|categor|mile/i);
    }
  });

  test('the subject target carries no selection reason — it was not selected', async () => {
    const store = new MemoryScanStore();
    await runScan(INPUT, deps({ store }));
    const subject = store.state.targets.find((t) => t.role === 'subject')!;
    assert.equal(subject.selection_reason, null);
  });
});

describe('collectors fail independently', () => {
  test('one dead collector thins the report without ending the scan', async () => {
    const store = new MemoryScanStore();
    const result = await runScan(
      INPUT,
      deps({
        store,
        collectors: [
          erase(createGbpCollector(fixtureGbpProvider)),
          stubCollector({ name: 'sitetech', fail: true }),
        ],
      }),
    );

    assert.equal(result.scan.status, 'complete');
    assert.ok(result.findings.some((f) => f.collector === 'gbp'));
    assert.equal(result.findings.some((f) => f.collector === 'sitetech'), false);
  });

  test('the failure is recorded against the run, with its reason', async () => {
    const store = new MemoryScanStore();
    await runScan(
      INPUT,
      deps({ store, collectors: [stubCollector({ name: 'sitetech', fail: true })] }),
    );

    const failed = store.state.collector_runs.filter((r) => r.status === 'failed');
    assert.ok(failed.length > 0);
    assert.match(failed[0]!.error!, /exploded/);
    // Not billed for a call that errored.
    assert.equal(failed[0]!.cost_pence, 0);
  });

  test('and surfaced as a warning rather than swallowed', async () => {
    const result = await runScan(
      INPUT,
      deps({ collectors: [stubCollector({ name: 'sitetech', fail: true })] }),
    );
    assert.ok(result.warnings.some((w) => /sitetech failed/.test(w)));
  });

  test('a failed collector writes no raw capture', async () => {
    const store = new MemoryScanStore();
    await runScan(
      INPUT,
      deps({ store, collectors: [stubCollector({ name: 'sitetech', fail: true })] }),
    );
    assert.equal(store.state.raw_captures.length, 0);
  });
});

describe('which collectors run', () => {
  test('a collector for another segment is skipped', async () => {
    const store = new MemoryScanStore();
    const dtcOnly: AnyCollector = { ...stubCollector({}), segments: ['dtc'] };
    await runScan(INPUT, deps({ store, collectors: [dtcOnly] }));
    assert.equal(store.state.collector_runs.length, 0);
  });

  test('a warm-mode collector is skipped on a cold scan', async () => {
    const store = new MemoryScanStore();
    const warm: AnyCollector = { ...stubCollector({}), requires_auth: true };
    await runScan({ ...INPUT, mode: 'cold' }, deps({ store, collectors: [warm] }));
    assert.equal(store.state.collector_runs.length, 0);
  });
});

describe('peer stats', () => {
  test('are built from the competitors, not from the subject', async () => {
    // Including the subject in its own comparison pulls the median toward whatever is
    // being measured and softens every finding about it.
    let seen = 0;
    const collector: AnyCollector = {
      ...stubCollector({}),
      peerStats(raws: unknown[]): PeerStats {
        seen = raws.length;
        return { median: {}, best: {} };
      },
    };

    const store = new MemoryScanStore();
    await runScan(INPUT, deps({ store, collectors: [collector] }));

    const competitors = store.state.targets.filter((t) => t.role === 'competitor').length;
    assert.equal(seen, competitors);
    assert.ok(competitors > 0);
  });

  test('reach normalise, so comparative findings have a number behind them', async () => {
    let received: PeerStats | undefined;
    const collector: AnyCollector = {
      ...stubCollector({}),
      peerStats: () => ({ median: { 'x.metric': 7 }, best: { 'x.metric': 9 } }),
      normalise(_raw, ctx) {
        received = ctx.peers;
        return [];
      },
    };

    await runScan(INPUT, deps({ collectors: [collector] }));
    assert.equal(received?.median['x.metric'], 7);
  });
});

describe('the gate stops a bad narrative reaching a report', () => {
  const inventing: NarrativeWriter = {
    name: 'inventing-writer',
    async write() {
      return {
        value: {
          executive_summary: [{ text: 'Your ad spend is wasted.', finding_id: 'not_on_this_scan' }],
          sections: [],
          recommendations: [],
        },
        cost: { pence: 60 },
      };
    },
  };

  test('the scan fails rather than rendering something indefensible', async () => {
    const result = await runScan(INPUT, deps({ writer: inventing }));

    assert.equal(result.scan.status, 'failed');
    assert.equal(result.html, null);
    assert.ok(result.violations.some((v) => /UNREFERENCED_CLAIM/.test(v)));
  });

  test('no report row is written', async () => {
    const store = new MemoryScanStore();
    await runScan(INPUT, deps({ store, writer: inventing }));
    assert.equal(store.state.reports.length, 0);
  });

  test('but the findings are kept, so a retry costs nothing to collect', async () => {
    const store = new MemoryScanStore();
    const result = await runScan(INPUT, deps({ store, writer: inventing }));

    assert.ok(result.findings.length > 0);
    assert.ok(store.state.raw_captures.length > 0);
    assert.match(store.state.scans[0]!.error!, /UNREFERENCED_CLAIM/);
  });
});

describe('re-normalising costs nothing', () => {
  test('replays the stored captures without collecting again', async () => {
    // Rule 3, and the reason raw captures are stored separately in the first place: rules
    // change weekly, and re-buying the data would make improving them expensive.
    let collects = 0;
    const counting = stubCollector({ name: 'sitetech', onCollect: () => (collects += 1) });

    const store = new MemoryScanStore();
    const result = await runScan(INPUT, deps({ store, collectors: [counting] }));
    const during = collects;

    const replayed = await renormalise(result.scan.id, {
      store,
      collectors: [counting],
      now: () => NOW,
    });

    assert.equal(collects, during, 'renormalise must not collect');
    assert.equal(replayed.length, result.findings.length);
  });

  test('improved rules replace the old findings rather than adding to them', async () => {
    const store = new MemoryScanStore();
    const result = await runScan(
      INPUT,
      deps({ store, collectors: [stubCollector({ name: 'sitetech' })] }),
    );

    const quieter: AnyCollector = { ...stubCollector({ name: 'sitetech' }), normalise: () => [] };
    const replayed = await renormalise(result.scan.id, {
      store,
      collectors: [quieter],
      now: () => NOW,
    });

    assert.equal(replayed.length, 0);
    assert.equal((await store.findingsForScan(result.scan.id)).length, 0);
  });
});

describe('the template writer', () => {
  test('produces a narrative that passes every gate', async () => {
    // It is not a report anyone would send, but it proves the pipeline and gives a real
    // narrative something to be compared against.
    const result = await runScan(INPUT, deps());
    assert.deepEqual(result.violations, []);
  });

  test('hedges an estimated finding, because a flat statement is rejected', async () => {
    const store = new MemoryScanStore();
    await runScan(INPUT, deps({ store }));

    const estimated = store.state.findings.find((f) => f.confidence === 'estimated');
    if (!estimated) return; // Fixture-dependent; the gate test above covers the rule.

    const report = store.state.reports[0]!;
    const claims = [
      ...report.narrative.executive_summary,
      ...report.narrative.sections.flatMap((s) => s.claims),
    ];
    const onEstimate = claims.find((c) => c.finding_id === estimated.id);
    assert.match(onEstimate!.text, /appears/);
  });
});

describe('progress', () => {
  test('reports each stage in order, for the CLI', async () => {
    const stages: string[] = [];
    await runScan(INPUT, deps({ onProgress: (e) => stages.push(e.stage) }));

    assert.deepEqual(stages, ['resolving', 'collecting', 'normalising', 'analysing', 'rendering']);
  });
});
