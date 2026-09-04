/**
 * Closed value sets shared by the taxonomy, the database and the report layer.
 *
 * Every one of these is mirrored by a CHECK constraint in the initial migration.
 * If you add a value here, add it there in the same commit.
 */

/** How much this finding costs the business. */
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Whether the value was measured or inferred.
 *
 * `verified` — we observed it directly (a response time we timed, a missing tag).
 * `estimated` — modelled or inferred (ad spend, category fit).
 *
 * Never render an `estimated` finding as fact. See CLAUDE.md rule 4.
 */
export const CONFIDENCES = ['verified', 'estimated'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/** One module per data source. See docs/teardown-engine.md §3. */
export const COLLECTORS = [
  'gbp',
  'localrank',
  'reviews',
  'speedtolead',
  'sitetech',
  'citations',
  'aivis',
  'paidcreative',
  'store',
  'lifecycle',
  'measurement',
] as const;
export type Collector = (typeof COLLECTORS)[number];

/** Which package a finding is relevant to. Drives which collectors run. */
export const SEGMENTS = ['smb', 'dtc'] as const;
export type Segment = (typeof SEGMENTS)[number];

/** Unit of `measured_value`. `none` means the finding is binary — it just is or isn't. */
export const UNITS = [
  'count',
  'hours',
  'days',
  'seconds',
  'ms',
  'per_month',
  'per_week',
  'position',
  'score',
  'percent',
  'gbp',
  'none',
] as const;
export type Unit = (typeof UNITS)[number];

/**
 * Which direction is good for this metric.
 *
 * Required to place a measured value against a benchmark percentile: 0.4 reviews
 * a month is bottom-quartile, but a 0.4-hour response time is top-quartile. Without
 * polarity the benchmark layer cannot tell those apart.
 */
export const POLARITIES = ['higher_better', 'lower_better', 'none'] as const;
export type Polarity = (typeof POLARITIES)[number];

/** Where a benchmark comparison came from. */
export const BENCHMARK_SOURCES = ['vertical_p50', 'competitor_best', 'absolute'] as const;
export type BenchmarkSource = (typeof BENCHMARK_SOURCES)[number];

/** Lifecycle of a scan. */
export const SCAN_STATUSES = [
  'queued',
  'resolving',
  'collecting',
  'normalising',
  'analysing',
  'rendering',
  'complete',
  'failed',
] as const;
export type ScanStatus = (typeof SCAN_STATUSES)[number];

/** Cold = public data only. Warm = client has granted access. */
export const SCAN_MODES = ['cold', 'warm'] as const;
export type ScanMode = (typeof SCAN_MODES)[number];

/** Per-collector execution outcome. Collectors fail independently — CLAUDE.md rule 5. */
export const COLLECTOR_RUN_STATUSES = [
  'pending',
  'running',
  'ok',
  'failed',
  'skipped',
] as const;
export type CollectorRunStatus = (typeof COLLECTOR_RUN_STATUSES)[number];

/** Role of a business within a scan. */
export const TARGET_ROLES = ['subject', 'competitor'] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];

/**
 * Minimum scans behind a percentile before we are willing to quote it.
 * Below this the report says "not enough comparable businesses yet" rather than
 * citing a number built on four data points. See docs/schema.md.
 */
export const MIN_BENCHMARK_SAMPLE = 20;
