/**
 * Placing a measured value against a benchmark.
 *
 * This is why `polarity` exists on every finding definition: 0.4 reviews a month is
 * bottom-quartile, but a 0.4-hour reply time is top-quartile. The same arithmetic gives
 * opposite answers, so direction has to be declared per code rather than guessed.
 */

import type { Benchmark } from '../types/index';
import { MIN_BENCHMARK_SAMPLE } from './enums';
import { FINDINGS, type FindingCode } from './findings';

export type Quartile = 'top' | 'upper_mid' | 'lower_mid' | 'bottom' | 'unknown';

/** The percentile trio a comparison needs. */
export interface Percentiles {
  p25: number | null;
  p50: number | null;
  p75: number | null;
  sample_size: number;
}

/**
 * Whether a benchmark is solid enough to quote in a report.
 *
 * Below the sample threshold the report says "not enough comparable businesses yet"
 * rather than citing a percentile built on four data points. One shaky claim discredits
 * the whole document.
 */
export function canQuoteBenchmark(b: Percentiles): boolean {
  return (
    b.sample_size >= MIN_BENCHMARK_SAMPLE &&
    b.p25 !== null &&
    b.p50 !== null &&
    b.p75 !== null
  );
}

/**
 * Place a measured value in a quartile, respecting the finding's polarity.
 *
 * Returns `unknown` when the benchmark is too thin to quote, when the code has no
 * meaningful direction, or when the code is not benchmarkable at all.
 */
export function quartileOf(
  code: FindingCode,
  value: number,
  benchmark: Percentiles,
): Quartile {
  const def = FINDINGS[code];
  if (!def.benchmarkable || def.polarity === 'none') return 'unknown';
  if (!canQuoteBenchmark(benchmark)) return 'unknown';

  // Non-null after canQuoteBenchmark.
  const p25 = benchmark.p25 as number;
  const p50 = benchmark.p50 as number;
  const p75 = benchmark.p75 as number;

  if (def.polarity === 'higher_better') {
    if (value >= p75) return 'top';
    if (value >= p50) return 'upper_mid';
    if (value >= p25) return 'lower_mid';
    return 'bottom';
  }

  // lower_better
  if (value <= p25) return 'top';
  if (value <= p50) return 'upper_mid';
  if (value <= p75) return 'lower_mid';
  return 'bottom';
}

/** Narrow a Benchmark row to the fields a comparison needs. */
export function percentilesOf(b: Benchmark): Percentiles {
  return { p25: b.p25, p50: b.p50, p75: b.p75, sample_size: b.sample_size };
}
