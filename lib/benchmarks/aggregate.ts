/**
 * Turning accumulated findings into percentiles — the moat.
 *
 * Worthless at scan one, decisive by month six. Run #1 says "your review velocity is 0.4 a
 * month". Run #50 says "you are bottom-quartile for review velocity among trades in your
 * region", and no competitor can say the second thing because they do not have the dataset.
 * That is why rule 6 puts the schema in before the first commit — this part is arithmetic,
 * but the data behind it cannot be retrofitted.
 *
 * ## Two deliberate differences from the SQL sketch in `docs/schema.md`
 *
 * **`sample_size` counts businesses, not measurements.** The sketch uses `count(*)` over
 * findings. The same plumber is a competitor in five scans and gets measured five times, so
 * a `sample_size` of 20 could be four businesses measured five times each — and then the
 * suppression threshold, which exists to mean "20 comparable businesses", is guarding
 * nothing. The store deduplicates to one row per (business, code, metric), keeping the most
 * recent, and one well-scanned business can no longer set the median on its own.
 *
 * **National buckets as well as regional ones.** The sketch groups by region only. Ten scans
 * in SW18 will not put any code near 20 for months, whereas the same findings pooled
 * nationally get there roughly six times faster — every scan contributes a subject and five
 * competitors. `ScanStore.benchmarks` already falls back to `region = null`, so a national
 * row makes a comparison quotable much sooner, and the regional row takes over when it
 * finally has the samples to be more specific.
 */

import { MIN_BENCHMARK_SAMPLE } from '../taxonomy/enums';
import type { Benchmark } from '../types/index';
import type { BenchmarkRow, ScanStore } from '../db/store';

/**
 * Linear-interpolating percentile, matching Postgres `percentile_cont`.
 *
 * Matched deliberately: this runs in TypeScript today and as SQL once Postgres is wired up,
 * and the two must not produce different numbers for the same data. A percentile that moves
 * when the storage engine changes would quietly rewrite every historical comparison.
 */
export function percentileCont(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;

  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;

  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** The key a benchmark row is stored under. */
const keyOf = (vertical: string, region: string | null, code: string, metric: string): string =>
  `${vertical}|${region ?? ''}|${code}|${metric}`;

export interface AggregateOptions {
  now?: () => Date;
}

/**
 * Percentiles per (vertical, region, code, metric), plus a national row per group.
 *
 * Every input row contributes to both its regional bucket and its national one, so the two
 * are consistent views of the same measurements rather than competing datasets.
 */
export function aggregate(rows: BenchmarkRow[], options: AggregateOptions = {}): Benchmark[] {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const buckets = new Map<string, { row: BenchmarkRow; region: string | null; values: number[] }>();

  const add = (row: BenchmarkRow, region: string | null): void => {
    const key = keyOf(row.vertical, region, row.code, row.metric);
    const bucket = buckets.get(key) ?? { row, region, values: [] };
    bucket.values.push(row.value);
    buckets.set(key, bucket);
  };

  for (const row of rows) {
    add(row, null);
    // A row with no region is only ever national — it has nowhere else to go.
    if (row.region !== null) add(row, row.region);
  }

  return [...buckets.values()].map(({ row, region, values }) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      vertical: row.vertical,
      region,
      code: row.code,
      metric: row.metric,
      p25: percentileCont(sorted, 0.25),
      p50: percentileCont(sorted, 0.5),
      p75: percentileCont(sorted, 0.75),
      // Distinct businesses, because the store deduplicated before this saw them.
      sample_size: sorted.length,
      updated_at: now,
    };
  });
}

export interface AggregationSummary {
  /** Every bucket written, including the ones still too thin to quote. */
  written: number;
  /** How many have enough businesses behind them to appear in a report. */
  quotable: number;
  /** Distinct businesses that contributed at least one measurement. */
  businesses: number;
  /** The largest bucket, for a sense of how close the moat is to being real. */
  largest: { code: string; region: string | null; sample_size: number } | null;
}

/**
 * Recompute the whole benchmark table.
 *
 * Wholesale rather than incremental. Findings are re-normalised against improved rules and
 * businesses are deduplicated across scans, so an incremental update would need to know
 * what changed underneath it — and at this size recomputing everything takes milliseconds.
 *
 * Thin buckets are written rather than skipped. They are what `canQuoteBenchmark` refuses
 * to quote, and keeping them is how the CLI can say how close a comparison is to becoming
 * usable instead of silently reporting nothing.
 */
export async function runBenchmarkAggregation(
  store: ScanStore,
  options: AggregateOptions = {},
): Promise<AggregationSummary> {
  const rows = await store.benchmarkRows();
  const benchmarks = aggregate(rows, options);
  await store.replaceBenchmarks(benchmarks);

  const largest = benchmarks.reduce<Benchmark | null>(
    (best, b) => (best === null || b.sample_size > best.sample_size ? b : best),
    null,
  );

  return {
    written: benchmarks.length,
    quotable: benchmarks.filter((b) => b.sample_size >= MIN_BENCHMARK_SAMPLE).length,
    businesses: new Set(rows.map((r) => r.business_id)).size,
    largest:
      largest === null
        ? null
        : { code: largest.code, region: largest.region, sample_size: largest.sample_size },
  };
}
