/**
 * The shared collector contract.
 *
 * Every collector is one object satisfying `Collector<Raw>`. The two halves are kept
 * apart deliberately (CLAUDE.md rule 3):
 *
 *   collect()   does I/O, returns a raw payload, costs money
 *   normalise() is pure, maps raw -> findings, costs nothing
 *
 * That split is what makes re-normalising every historical scan against improved rules
 * free. Collectors never write findings directly.
 */

import type {
  BenchmarkSource,
  Collector as CollectorName,
  Segment,
  TargetRole,
} from '../taxonomy/enums';
import { FINDINGS, type FindingCode } from '../taxonomy/findings';
import type { Evidence, FindingDraft, Place, Uuid } from './shared';
import { FREE, type Cost, type Priced } from '../resolve/providers';

/**
 * What normalise emits.
 *
 * Note what is absent: severity and confidence. Those are properties of the *code*, not
 * of the instance, so they come from the registry rather than being restated at every
 * emit site. A collector cannot accidentally downgrade GBP_MISSING to 'low'.
 */
export interface FindingSeed {
  code: FindingCode;
  measured_value?: number | null;
  measured_text?: string | null;
  benchmark_value?: number | null;
  benchmark_source?: BenchmarkSource | null;
  /** Must be renderable as proof. A finding a prospect cannot verify is worth nothing. */
  evidence: Evidence;
}

/** Expand a seed into a persistable draft, filling metadata from the taxonomy. */
export function expandSeed(seed: FindingSeed, targetId: Uuid): FindingDraft {
  const def = FINDINGS[seed.code];
  return {
    target_id: targetId,
    code: seed.code,
    collector: def.collector,
    severity: def.severity,
    confidence: def.confidence,
    measured_value: seed.measured_value ?? null,
    measured_unit: def.unit === 'none' ? null : def.unit,
    measured_text: seed.measured_text ?? null,
    benchmark_value: seed.benchmark_value ?? null,
    benchmark_source: seed.benchmark_source ?? null,
    evidence: seed.evidence,
  };
}

/** The business a collector is pointed at. */
export interface CollectTarget {
  target_id: Uuid;
  role: TargetRole;
  place: Place;
}

export interface CollectContext {
  /** Cold = public data only. Warm = the client has granted access. */
  mode: 'cold' | 'warm';
}

/**
 * Peer values for comparative findings.
 *
 * Populated after every target has been collected, so "fewer photos than competitors" can
 * be stated with a number behind it. Absent on the first pass and for single-target runs,
 * in which case normalise falls back to absolute thresholds.
 */
export interface PeerStats {
  median: Partial<Record<string, number>>;
  best: Partial<Record<string, number>>;
}

export interface NormaliseContext {
  /** Injected rather than read from the clock, so date-sensitive rules are testable. */
  now: Date;
  role: TargetRole;
  peers?: PeerStats;
  /**
   * Which package this scan is for.
   *
   * Codes declare the segments they apply to, so a plumber is never told it is missing
   * Product schema. Undefined runs every rule — acceptable in a focused unit test, wrong
   * for a real scan.
   */
  segment?: Segment;
}

/**
 * Whether a code is worth emitting for the scan's segment.
 *
 * The registry already knows — `segments` on each definition — so a collector asks rather
 * than restating it. An undefined segment means the caller has not said, and every rule
 * runs.
 */
export function appliesTo(code: FindingCode, segment?: Segment): boolean {
  return segment === undefined || FINDINGS[code].segments.includes(segment);
}

export interface Collector<Raw> {
  readonly name: CollectorName;
  readonly requires_auth: boolean;
  /** Which packages this collector is worth running for. */
  readonly segments: readonly Segment[];
  /** Codes this collector may emit. Checked against the registry in tests. */
  readonly emits: readonly FindingCode[];
  collect(target: CollectTarget, ctx: CollectContext): Promise<Priced<Raw | null>>;
  normalise(raw: Raw | null, ctx: NormaliseContext): FindingSeed[];
}

/** The outcome of one fallible piece of collection. */
export interface Attempt<T> {
  value: T | null;
  cost: Cost;
  error: string | null;
}

/**
 * Run one fallible piece of collection, surviving its failure.
 *
 * Rule 5 says a dead source degrades a report rather than killing a scan, and that has to
 * hold inside a collector as well as between them — `sitetech` owns two sources, and
 * `localrank` buys one map pack per keyword. A thrown provider yields a null result and a
 * recorded reason rather than an exception that takes the run down.
 *
 * Cost is zero on failure: a request that errored is not a request we were billed for, and
 * `scans.cost_pence` has to reflect what actually happened.
 */
export async function attempt<T>(run: () => Promise<Priced<T>>): Promise<Attempt<T>> {
  try {
    const { value, cost } = await run();
    return { value, cost, error: null };
  } catch (cause) {
    return {
      value: null,
      cost: FREE,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Median of a numeric sample. Null for an empty sample rather than NaN. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return ((sorted[mid - 1]! + sorted[mid]!) / 2);
}
