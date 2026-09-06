/**
 * An in-memory `ScanStore`.
 *
 * What the tests run against, and what the file store is built on. Deliberately dumb: maps
 * and arrays, no indexes, no query planning. A scan writes a few hundred rows and a solo
 * founder runs ten of them, so anything cleverer would be solving a problem nobody has.
 *
 * The one thing it does take seriously is `upsertBusiness` deduplicating on `place_id`, and
 * that is not a performance concern — it is what makes benchmarks mean anything. The same
 * plumber is the subject of one scan and a competitor in three others; four rows would put
 * them in the percentile four times.
 */

import { randomUUID } from 'node:crypto';

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
import { FINDINGS } from '../taxonomy/findings';
import type { VisibilitySnapshot } from '../visibility/types';
import type {
  BenchmarkRow,
  NewBusiness,
  NewCollectorRun,
  NewRawCapture,
  NewReport,
  NewScan,
  NewScanTarget,
  ScanOutcome,
  ScanStore,
} from './store';

/** Everything a store holds. Exported so the file store can serialise it whole. */
export interface StoreState {
  businesses: Business[];
  scans: Scan[];
  targets: ScanTarget[];
  collector_runs: CollectorRun[];
  raw_captures: RawCapture[];
  findings: Finding[];
  reports: Report[];
  benchmarks: Benchmark[];
  snapshots: VisibilitySnapshot[];
}

export const emptyState = (): StoreState => ({
  businesses: [],
  scans: [],
  targets: [],
  collector_runs: [],
  raw_captures: [],
  findings: [],
  reports: [],
  benchmarks: [],
  snapshots: [],
});

export interface MemoryStoreOptions {
  state?: StoreState;
  /** What this store calls itself. The file store reports its path. */
  name?: string;
  /** Injected so a test can assert on ids and timestamps rather than tolerate them. */
  now?: () => Date;
  id?: () => Uuid;
  /** Called after every mutation. The file store uses it to flush. */
  onChange?: (state: StoreState) => void | Promise<void>;
}

export class MemoryScanStore implements ScanStore {
  readonly name: string;
  readonly state: StoreState;

  readonly #now: () => Date;
  readonly #id: () => Uuid;
  readonly #onChange: ((state: StoreState) => void | Promise<void>) | undefined;

  constructor(options: MemoryStoreOptions = {}) {
    this.name = options.name ?? 'memory';
    this.state = options.state ?? emptyState();
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => randomUUID());
    this.#onChange = options.onChange;
  }

  async #changed(): Promise<void> {
    if (this.#onChange) await this.#onChange(this.state);
  }

  #stamp(): string {
    return this.#now().toISOString();
  }

  async upsertBusiness(business: NewBusiness): Promise<Business> {
    const existing =
      business.place_id === null
        ? undefined
        : this.state.businesses.find((b) => b.place_id === business.place_id);

    if (existing) {
      // Later scans see a business again and may know more about it than the first did.
      Object.assign(existing, business, { updated_at: this.#stamp() });
      await this.#changed();
      return existing;
    }

    const row: Business = {
      ...business,
      id: this.#id(),
      first_seen_at: this.#stamp(),
      updated_at: this.#stamp(),
    };
    this.state.businesses.push(row);
    await this.#changed();
    return row;
  }

  async createScan(scan: NewScan): Promise<Scan> {
    const row: Scan = {
      ...scan,
      id: this.#id(),
      status: 'queued',
      cost_pence: 0,
      started_at: this.#stamp(),
      completed_at: null,
      error: null,
    };
    this.state.scans.push(row);
    await this.#changed();
    return row;
  }

  async updateScan(scanId: Uuid, outcome: ScanOutcome): Promise<void> {
    const scan = this.state.scans.find((s) => s.id === scanId);
    if (!scan) return;

    scan.status = outcome.status;
    if (outcome.cost_pence !== undefined) scan.cost_pence = outcome.cost_pence;
    if (outcome.error !== undefined) scan.error = outcome.error;
    if (outcome.completed) scan.completed_at = this.#stamp();
    await this.#changed();
  }

  async getScan(scanId: Uuid): Promise<Scan | null> {
    return this.state.scans.find((s) => s.id === scanId) ?? null;
  }

  async addTargets(scanId: Uuid, targets: NewScanTarget[]): Promise<ScanTarget[]> {
    const rows = targets.map((t) => ({ ...t, id: this.#id(), scan_id: scanId }));
    this.state.targets.push(...rows);
    await this.#changed();
    return rows;
  }

  async targetsForScan(scanId: Uuid): Promise<ScanTarget[]> {
    return this.state.targets.filter((t) => t.scan_id === scanId);
  }

  async recordCollectorRun(run: NewCollectorRun): Promise<CollectorRun> {
    const row: CollectorRun = { ...run, id: this.#id(), ran_at: this.#stamp() };
    this.state.collector_runs.push(row);
    await this.#changed();
    return row;
  }

  async collectorRunsForScan(scanId: Uuid): Promise<CollectorRun[]> {
    return this.state.collector_runs.filter((r) => r.scan_id === scanId);
  }

  async saveRawCapture(capture: NewRawCapture): Promise<RawCapture> {
    const row: RawCapture = { ...capture, id: this.#id(), captured_at: this.#stamp() };
    this.state.raw_captures.push(row);
    await this.#changed();
    return row;
  }

  async rawCapturesForScan(scanId: Uuid): Promise<RawCapture[]> {
    const runs = new Set(
      this.state.collector_runs.filter((r) => r.scan_id === scanId).map((r) => r.id),
    );
    return this.state.raw_captures.filter((c) => runs.has(c.collector_run_id));
  }

  async saveFindings(scanId: Uuid, drafts: FindingDraft[]): Promise<Finding[]> {
    // Replace rather than append: re-normalising a scan against improved rules should not
    // leave the old findings behind alongside the new ones.
    this.state.findings = this.state.findings.filter((f) => f.scan_id !== scanId);

    const rows = drafts.map((draft) => ({
      ...draft,
      id: this.#id(),
      scan_id: scanId,
      normalised_at: this.#stamp(),
    }));
    this.state.findings.push(...rows);
    await this.#changed();
    return rows;
  }

  async findingsForScan(scanId: Uuid): Promise<Finding[]> {
    return this.state.findings.filter((f) => f.scan_id === scanId);
  }

  async saveReport(report: NewReport): Promise<Report> {
    const row: Report = { ...report, id: this.#id(), rendered_at: this.#stamp() };
    this.state.reports.push(row);
    await this.#changed();
    return row;
  }

  async reportsForScan(scanId: Uuid): Promise<Report[]> {
    return this.state.reports.filter((r) => r.scan_id === scanId);
  }

  async benchmarks(vertical: string | null, region: string | null): Promise<Benchmark[]> {
    if (vertical === null) return [];
    return this.state.benchmarks.filter(
      (b) => b.vertical === vertical && (b.region === region || b.region === null),
    );
  }

  /**
   * Findings joined to the business that was measured, deduplicated to one row per
   * (business, code, metric).
   *
   * The dedupe is the point. Percentiles are meant to describe a population of businesses,
   * and the same plumber turns up as a competitor in scan after scan — keeping every
   * measurement would let one well-scanned business set the median on its own.
   */
  async benchmarkRows(): Promise<BenchmarkRow[]> {
    const targetById = new Map(this.state.targets.map((t) => [t.id, t]));
    const businessById = new Map(this.state.businesses.map((b) => [b.id, b]));
    const latest = new Map<string, BenchmarkRow>();

    for (const finding of this.state.findings) {
      if (finding.measured_value === null || finding.measured_unit === null) continue;
      if (!FINDINGS[finding.code].benchmarkable) continue;

      const target = targetById.get(finding.target_id);
      const business = target ? businessById.get(target.business_id) : undefined;
      if (!business?.vertical) continue;

      const row: BenchmarkRow = {
        business_id: business.id,
        vertical: business.vertical,
        region: business.region,
        code: finding.code,
        metric: finding.measured_unit,
        value: finding.measured_value,
        measured_at: finding.normalised_at,
      };

      const key = `${business.id}|${finding.code}|${finding.measured_unit}`;
      const seen = latest.get(key);
      if (!seen || seen.measured_at < row.measured_at) latest.set(key, row);
    }

    return [...latest.values()];
  }

  async replaceBenchmarks(rows: Benchmark[]): Promise<void> {
    this.state.benchmarks = rows;
    await this.#changed();
  }

  async saveSnapshot(snapshot: VisibilitySnapshot): Promise<VisibilitySnapshot> {
    // Append-only. A snapshot records what the models said at a moment; replacing one would
    // rewrite the history the whole product is built on.
    this.state.snapshots.push(snapshot);
    await this.#changed();
    return snapshot;
  }

  async snapshots(promptSet: string): Promise<VisibilitySnapshot[]> {
    return this.state.snapshots
      .filter((s) => s.prompt_set === promptSet)
      .sort((a, b) => a.run_at.localeCompare(b.run_at));
  }

  async promptSets(): Promise<string[]> {
    return [...new Set(this.state.snapshots.map((s) => s.prompt_set))].sort();
  }

  async listScans(limit = 50): Promise<Scan[]> {
    return [...this.state.scans]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, limit);
  }
}
