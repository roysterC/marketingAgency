import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryScanStore } from '../db/memory';
import { MIN_BENCHMARK_SAMPLE } from '../taxonomy/enums';
import { canQuoteBenchmark, percentilesOf, quartileOf } from '../taxonomy/benchmark';
import { aggregate, percentileCont, runBenchmarkAggregation } from './aggregate';
import type { BenchmarkRow } from '../db/store';
import type { FindingDraft } from '../types/index';

const NOW = new Date('2026-09-06T12:00:00.000Z');

const row = (over: Partial<BenchmarkRow> = {}): BenchmarkRow => ({
  business_id: 'b1',
  vertical: 'trades.plumbing',
  region: 'SW18',
  code: 'REVIEW_VELOCITY_LOW',
  metric: 'per_month',
  value: 1,
  measured_at: '2026-09-01T00:00:00.000Z',
  ...over,
});

describe('percentiles match Postgres', () => {
  test('interpolates the way percentile_cont does', () => {
    // Matched deliberately: this runs in TypeScript now and as SQL later, and a percentile
    // that moved when the storage engine changed would rewrite every historical comparison.
    assert.equal(percentileCont([1, 2, 3, 4], 0.5), 2.5);
    assert.equal(percentileCont([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentileCont([1, 2, 3, 4], 0.25), 1.75);
    assert.equal(percentileCont([1, 2, 3, 4], 0.75), 3.25);
  });

  test('lands exactly on a value when the position is whole', () => {
    assert.equal(percentileCont([10, 20, 30], 0.5), 20);
    assert.equal(percentileCont([10, 20, 30], 0), 10);
    assert.equal(percentileCont([10, 20, 30], 1), 30);
  });

  test('a single value is its own percentile', () => {
    assert.equal(percentileCont([7], 0.25), 7);
  });

  test('an empty sample has no percentile rather than a zero', () => {
    assert.equal(percentileCont([], 0.5), null);
  });
});

describe('aggregating', () => {
  test('groups by vertical, region, code and metric', () => {
    const buckets = aggregate(
      [
        row({ business_id: 'b1', value: 1 }),
        row({ business_id: 'b2', value: 3 }),
        row({ business_id: 'b3', code: 'REVIEW_VOLUME_LOW', metric: 'count', value: 50 }),
      ],
      { now: () => NOW },
    );

    const velocity = buckets.filter((b) => b.code === 'REVIEW_VELOCITY_LOW');
    assert.equal(velocity.length, 2, 'regional and national');
    assert.equal(velocity[0]!.p50, 2);
  });

  test('writes a national bucket alongside the regional one', () => {
    // The sketch groups by region only. Ten scans in SW18 will not reach the threshold for
    // months, whereas the same findings pooled nationally get there far sooner — and
    // `benchmarks()` already falls back to a null region.
    const buckets = aggregate([row({ region: 'SW18' }), row({ business_id: 'b2', region: 'SE1' })], {
      now: () => NOW,
    });

    const regions = new Set(buckets.map((b) => b.region));
    assert.equal(regions.size, 3);
    for (const region of [null, 'SE1', 'SW18']) assert.ok(regions.has(region), String(region));
    assert.equal(buckets.find((b) => b.region === null)!.sample_size, 2);
    assert.equal(buckets.find((b) => b.region === 'SW18')!.sample_size, 1);
  });

  test('a row with no region is national only — it has nowhere else to go', () => {
    const buckets = aggregate([row({ region: null })], { now: () => NOW });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0]!.region, null);
  });

  test('every bucket is stamped, so a stale table is visible', () => {
    assert.equal(aggregate([row()], { now: () => NOW })[0]!.updated_at, NOW.toISOString());
  });

  test('thin buckets are written rather than skipped', () => {
    // They are what canQuoteBenchmark refuses to quote. Keeping them is how the CLI can say
    // how close a comparison is to being usable.
    const buckets = aggregate([row()], { now: () => NOW });
    assert.equal(buckets[0]!.sample_size, 1);
    assert.equal(canQuoteBenchmark(percentilesOf(buckets[0]!)), false);
  });
});

describe('sample_size counts businesses, not measurements', () => {
  test('the same business measured repeatedly counts once', async () => {
    // The correction over the SQL sketch's count(*). A plumber that is a competitor in five
    // scans would otherwise be weighted five times, and a sample_size of 20 could be four
    // businesses — which is exactly what the suppression threshold exists to prevent.
    const store = new MemoryScanStore();
    await seed(store, [
      { business: 'b1', place: 'p1', value: 1, at: '2026-01-01T00:00:00.000Z' },
      { business: 'b1', place: 'p1', value: 9, at: '2026-06-01T00:00:00.000Z' },
      { business: 'b1', place: 'p1', value: 5, at: '2026-09-01T00:00:00.000Z' },
    ]);

    const rows = await store.benchmarkRows();
    assert.equal(rows.length, 1);
    // Most recent wins.
    assert.equal(rows[0]!.value, 5);
  });

  test('different businesses each count', async () => {
    const store = new MemoryScanStore();
    await seed(store, [
      { business: 'b1', place: 'p1', value: 1, at: '2026-01-01T00:00:00.000Z' },
      { business: 'b2', place: 'p2', value: 3, at: '2026-01-01T00:00:00.000Z' },
    ]);

    const rows = await store.benchmarkRows();
    assert.equal(rows.length, 2);
    assert.equal(aggregate(rows)[0]!.sample_size, 2);
  });
});

describe('what is eligible for a percentile', () => {
  test('a binary finding contributes nothing — there is no value to rank', async () => {
    const store = new MemoryScanStore();
    await seed(store, [{ business: 'b1', place: 'p1', value: null, at: '2026-01-01T00:00:00.000Z' }]);
    assert.deepEqual(await store.benchmarkRows(), []);
  });

  test('a code the registry marks unbenchmarkable is excluded', async () => {
    const store = new MemoryScanStore();
    await seed(store, [
      {
        business: 'b1',
        place: 'p1',
        value: 3,
        at: '2026-01-01T00:00:00.000Z',
        // Binary in the registry: benchmarkable false.
        code: 'GBP_HOURS_INCOMPLETE',
      },
    ]);
    assert.deepEqual(await store.benchmarkRows(), []);
  });

  test('a business with no vertical is excluded — there is no group to put it in', async () => {
    const store = new MemoryScanStore();
    await seed(store, [
      { business: 'b1', place: 'p1', value: 3, at: '2026-01-01T00:00:00.000Z', vertical: null },
    ]);
    assert.deepEqual(await store.benchmarkRows(), []);
  });

  test('a competitor counts as much as a subject', async () => {
    // Their measured review velocity is just as real, and the percentile describes a
    // population rather than a client list.
    const store = new MemoryScanStore();
    await seed(store, [
      { business: 'b1', place: 'p1', value: 1, at: '2026-01-01T00:00:00.000Z', role: 'subject' },
      { business: 'b2', place: 'p2', value: 5, at: '2026-01-01T00:00:00.000Z', role: 'competitor' },
    ]);
    assert.equal((await store.benchmarkRows()).length, 2);
  });
});

describe('running the aggregation', () => {
  test('replaces the table rather than appending to it', async () => {
    const store = new MemoryScanStore();
    await seed(store, [{ business: 'b1', place: 'p1', value: 1, at: '2026-01-01T00:00:00.000Z' }]);

    await runBenchmarkAggregation(store, { now: () => NOW });
    const first = store.state.benchmarks.length;
    await runBenchmarkAggregation(store, { now: () => NOW });

    assert.equal(store.state.benchmarks.length, first);
  });

  test('reports how far off quotable it is', async () => {
    const store = new MemoryScanStore();
    await seed(store, [
      { business: 'b1', place: 'p1', value: 1, at: '2026-01-01T00:00:00.000Z' },
      { business: 'b2', place: 'p2', value: 2, at: '2026-01-01T00:00:00.000Z' },
    ]);

    const summary = await runBenchmarkAggregation(store, { now: () => NOW });
    assert.equal(summary.businesses, 2);
    assert.equal(summary.quotable, 0);
    assert.ok(summary.written > 0);
    assert.equal(summary.largest?.sample_size, 2);
  });

  test('an empty store aggregates to nothing rather than failing', async () => {
    const summary = await runBenchmarkAggregation(new MemoryScanStore(), { now: () => NOW });
    assert.deepEqual(summary, { written: 0, quotable: 0, businesses: 0, largest: null });
  });

  test('a bucket becomes quotable at the threshold, and only then', async () => {
    const store = new MemoryScanStore();
    const entries = Array.from({ length: MIN_BENCHMARK_SAMPLE }, (_, i) => ({
      business: `b${i}`,
      place: `p${i}`,
      value: i + 1,
      at: '2026-01-01T00:00:00.000Z',
    }));

    await seed(store, entries.slice(0, MIN_BENCHMARK_SAMPLE - 1));
    assert.equal((await runBenchmarkAggregation(store, { now: () => NOW })).quotable, 0);

    await seed(store, entries.slice(MIN_BENCHMARK_SAMPLE - 1));
    const summary = await runBenchmarkAggregation(store, { now: () => NOW });
    assert.ok(summary.quotable > 0);
  });

  test('and the quartile layer can then place a value against it', async () => {
    const store = new MemoryScanStore();
    await seed(
      store,
      Array.from({ length: MIN_BENCHMARK_SAMPLE }, (_, i) => ({
        business: `b${i}`,
        place: `p${i}`,
        value: i + 1,
        at: '2026-01-01T00:00:00.000Z',
      })),
    );
    await runBenchmarkAggregation(store, { now: () => NOW });

    const national = (await store.benchmarks('trades.plumbing', 'SW18')).find(
      (b) => b.region === null,
    )!;

    // Review velocity is higher_better, so 1 out of 1..20 is bottom quartile.
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 1, percentilesOf(national)), 'bottom');
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 20, percentilesOf(national)), 'top');
  });
});

/** Write findings for businesses, the long way round, so the joins are exercised. */
async function seed(
  store: MemoryScanStore,
  entries: Array<{
    business: string;
    place: string;
    value: number | null;
    at: string;
    code?: FindingDraft['code'];
    vertical?: string | null;
    role?: 'subject' | 'competitor';
  }>,
): Promise<void> {
  for (const entry of entries) {
    const business = await store.upsertBusiness({
      name: entry.business,
      domain: null,
      place_id: entry.place,
      vertical: entry.vertical === undefined ? 'trades.plumbing' : entry.vertical,
      region: 'SW18',
      platform: null,
      socials: {},
    });

    const scan = await store.createScan({ subject_id: business.id, mode: 'cold', keyword_set: null });
    const [target] = await store.addTargets(scan.id, [
      { business_id: business.id, role: entry.role ?? 'subject', selection_reason: null },
    ]);

    const code = entry.code ?? 'REVIEW_VELOCITY_LOW';
    await store.saveFindings(scan.id, [
      {
        target_id: target!.id,
        code,
        collector: 'reviews',
        severity: 'critical',
        confidence: 'verified',
        measured_value: entry.value,
        measured_unit: entry.value === null ? null : 'per_month',
        measured_text: null,
        benchmark_value: null,
        benchmark_source: null,
        evidence: {},
      },
    ]);

    // saveFindings stamps normalised_at from the store clock; override it so "most recent
    // wins" is testable rather than dependent on wall time.
    for (const finding of store.state.findings) {
      if (finding.scan_id === scan.id) finding.normalised_at = entry.at;
    }
  }
}
