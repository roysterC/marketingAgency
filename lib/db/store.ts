/**
 * Where a scan's results go.
 *
 * The ten tables in `supabase/migrations/` have existed since the first commit and until
 * now nothing wrote to any of them. This is the interface that changes that, and it is
 * shaped by two rules already settled elsewhere:
 *
 * - **Raw captures are stored separately from findings** (rule 3). `saveRawCapture` and
 *   `saveFindings` are different calls against different tables, because re-normalising
 *   every historical scan against improved rules has to be free. Data is expensive; rules
 *   are cheap and will change weekly.
 * - **Benchmarks are written from day one** (rule 6). Worthless at scan one, decisive by
 *   month six, and impossible to retrofit — so findings land in a shape the aggregation
 *   query can read from the start, whether or not anyone is reading it yet.
 *
 * Two implementations, same interface, same reasoning as every provider in `lib/adapters`:
 * an in-memory store for tests, and a file store the CLI uses. A Postgres implementation
 * drops in behind this without the runner noticing.
 */

import type {
  Benchmark,
  Business,
  CollectorRun,
  Finding,
  FindingDraft,
  RawCapture,
  Report,
  Scan,
  ScanTarget,
  Uuid,
} from '../types/index';
import type { ScanStatus } from '../taxonomy/enums';
import type { FindingCode } from '../taxonomy/findings';

/** One business's measurement of one code, ready to be aggregated. */
export interface BenchmarkRow {
  business_id: Uuid;
  vertical: string;
  region: string | null;
  code: FindingCode;
  metric: string;
  value: number;
  /** Which measurement this is. The most recent wins when a business appears twice. */
  measured_at: string;
}

/** A row before the database has given it an id or a timestamp. */
export type New<T, K extends keyof T = never> = Omit<T, 'id' | K>;

export type NewBusiness = Omit<Business, 'id' | 'first_seen_at' | 'updated_at'>;
export type NewScan = Omit<Scan, 'id' | 'started_at' | 'completed_at' | 'status' | 'cost_pence' | 'error'>;
export type NewScanTarget = Omit<ScanTarget, 'id' | 'scan_id'>;
export type NewCollectorRun = Omit<CollectorRun, 'id' | 'ran_at'>;
export type NewRawCapture = Omit<RawCapture, 'id' | 'captured_at'>;
export type NewReport = Omit<Report, 'id' | 'rendered_at'>;

/** How a scan ended. Kept separate so a failure records its reason. */
export interface ScanOutcome {
  status: ScanStatus;
  cost_pence?: number;
  error?: string | null;
  completed?: boolean;
}

export interface ScanStore {
  readonly name: string;

  /**
   * Insert or return the existing business.
   *
   * Deduplicated on `place_id`, because the same plumber appears as the subject of one scan
   * and a competitor in three others, and benchmarks are only meaningful if that is one row
   * rather than four.
   */
  upsertBusiness(business: NewBusiness): Promise<Business>;

  createScan(scan: NewScan): Promise<Scan>;
  updateScan(scanId: Uuid, outcome: ScanOutcome): Promise<void>;
  getScan(scanId: Uuid): Promise<Scan | null>;

  addTargets(scanId: Uuid, targets: NewScanTarget[]): Promise<ScanTarget[]>;
  targetsForScan(scanId: Uuid): Promise<ScanTarget[]>;

  recordCollectorRun(run: NewCollectorRun): Promise<CollectorRun>;
  collectorRunsForScan(scanId: Uuid): Promise<CollectorRun[]>;

  saveRawCapture(capture: NewRawCapture): Promise<RawCapture>;
  rawCapturesForScan(scanId: Uuid): Promise<RawCapture[]>;

  /** Findings are written per scan, so a re-normalise can replace them wholesale. */
  saveFindings(scanId: Uuid, drafts: FindingDraft[]): Promise<Finding[]>;
  findingsForScan(scanId: Uuid): Promise<Finding[]>;

  saveReport(report: NewReport): Promise<Report>;
  reportsForScan(scanId: Uuid): Promise<Report[]>;

  /**
   * Percentiles for a vertical and region.
   *
   * Empty until enough scans exist, which is the honest answer — the analyse brief lists
   * the codes it must not quote rather than quoting a percentile built on four data points.
   */
  benchmarks(vertical: string | null, region: string | null): Promise<Benchmark[]>;

  /**
   * Every measurement that can feed a percentile, with its grouping keys joined on.
   *
   * One row per (business, code, metric) — deliberately *not* one per finding. The same
   * plumber is a competitor in five scans and gets measured five times; counting all five
   * would weight it five times in the percentile and make `sample_size` a count of
   * measurements rather than of businesses, which is not what the suppression threshold
   * means.
   */
  benchmarkRows(): Promise<BenchmarkRow[]>;

  /** Replace the benchmark table wholesale. Recomputed on a schedule, not per scan. */
  replaceBenchmarks(rows: Benchmark[]): Promise<void>;

  /** Every scan, newest first. What the CLI lists and the aggregation job walks. */
  listScans(limit?: number): Promise<Scan[]>;
}
