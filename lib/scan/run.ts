/**
 * The scan runner — resolve → collect → normalise → analyse → render, as one call.
 *
 * Every stage existed and was tested before this file did; what was missing was the thing
 * that puts them in order and writes the results down. Ship criterion 1 is "runs end to end
 * on 10 real businesses with no manual intervention", and this is what that criterion is
 * about.
 *
 * Three rules from CLAUDE.md meet here for the first time, and each is load-bearing:
 *
 * - **Collectors fail independently** (rule 5). Every collect is wrapped, every outcome
 *   becomes a `collector_runs` row with its status, cost, duration and error. A dead source
 *   thins the report and is explained in the record; it never ends the scan.
 * - **Raw captures are separate from findings** (rule 3). Captures are written before
 *   normalisation and never rewritten, so `renormalise()` can replay a historical scan
 *   against improved rules without buying the data again.
 * - **Cost reflects reality** (rule 8). A `CostMeter` accumulates what each call actually
 *   returned, including the zeroes from scan-level caches and failed requests, so
 *   `scans.cost_pence` is a measurement rather than an estimate.
 */

import { CostMeter, type ResolveProviders } from '../resolve/providers';
import { resolveScan, type ResolveOptions } from '../resolve/resolve';
import { toVertical } from '../resolve/vertical';
import { toOutwardCode } from '../resolve/region';
import type { Place } from '../resolve/types';
import {
  attempt,
  expandSeed,
  type AnyCollector,
  type CollectTarget,
  type PeerStats,
} from '../collectors/types';
import type { Segment } from '../taxonomy/enums';
import { analyseScan, type NarrativeWriter } from '../analyse/index';
import { renderOnePager, renderReport, type ReportContext } from '../report/render';
import type { ScanStore } from '../db/store';
import type {
  Business,
  Finding,
  FindingDraft,
  Scan,
  ScanRequest,
  ScanTarget,
  Uuid,
} from '../types/index';

export interface ScanInput {
  /** Business name plus postcode, or a domain. Resolve accepts either. */
  name?: string;
  postcode?: string;
  domain?: string;
  mode?: 'cold' | 'warm';
  segment?: Segment;
}

export interface ScanDeps {
  store: ScanStore;
  providers: ResolveProviders;
  collectors: AnyCollector[];
  writer: NarrativeWriter;
  /** Injected so a scan's timestamps and date-sensitive rules are testable. */
  now?: () => Date;
  resolve?: ResolveOptions;
  /** Progress, for the CLI. Silent by default. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  stage: Scan['status'];
  message: string;
}

export interface ScanResult {
  scan: Scan;
  targets: ScanTarget[];
  findings: Finding[];
  /** Empty when the narrative passed every gate. */
  violations: string[];
  html: string | null;
  onePager: string | null;
  warnings: string[];
}

/** A place plus the row it was written to. */
interface Target {
  row: ScanTarget;
  place: Place;
}

export async function runScan(input: ScanInput, deps: ScanDeps): Promise<ScanResult> {
  const { store, providers, collectors, writer } = deps;
  const now = deps.now ?? (() => new Date());
  const mode = input.mode ?? 'cold';
  const segment = input.segment ?? 'smb';
  const meter = new CostMeter();
  const warnings: string[] = [];
  const say = (stage: Scan['status'], message: string): void =>
    deps.onProgress?.({ stage, message });

  // --- resolve -------------------------------------------------------------
  say('resolving', 'finding the business and its competitors');

  const request: ScanRequest = input.domain
    ? { kind: 'domain', domain: input.domain, segment }
    : { kind: 'local', name: input.name ?? '', postcode: input.postcode ?? '', segment };

  // resolveScan throws only when the subject itself cannot be found — without it there is
  // no scan. Everything else it degrades into warnings.
  const { result: resolved, cost_pence } = await resolveScan(
    request,
    providers,
    deps.resolve ?? { keywords: [] },
  );
  meter.add({ pence: cost_pence });
  warnings.push(...resolved.warnings);

  const subject = resolved.subject;
  const vertical = resolved.vertical;
  const region = resolved.region;

  const subjectBusiness = await store.upsertBusiness({
    name: subject.name,
    domain: subject.domain,
    place_id: subject.place_id,
    vertical,
    region,
    platform: resolved.platform,
    socials: {},
  });

  const scan = await store.createScan({
    subject_id: subjectBusiness.id,
    mode,
    keyword_set: resolved.keyword_set,
  });

  const competitors = resolved.competitors;
  const competitorBusinesses: Business[] = [];
  for (const competitor of competitors) {
    competitorBusinesses.push(
      await store.upsertBusiness({
        name: competitor.place.name,
        domain: competitor.place.domain,
        place_id: competitor.place.place_id,
        vertical: toVertical(competitor.place.primary_category),
        region: toOutwardCode(competitor.place.postcode),
        platform: null,
        socials: {},
      }),
    );
  }

  const rows = await store.addTargets(scan.id, [
    { business_id: subjectBusiness.id, role: 'subject', selection_reason: null },
    ...competitors.map((c, i) => ({
      business_id: competitorBusinesses[i]!.id,
      role: 'competitor' as const,
      // Why this business is in the comparison. The first thing a prospect challenges.
      selection_reason: c.rationale,
    })),
  ]);

  const targets: Target[] = [
    { row: rows[0]!, place: subject },
    ...competitors.map((c, i) => ({ row: rows[i + 1]!, place: c.place })),
  ];

  say('collecting', `${collectors.length} collectors across ${targets.length} businesses`);
  await store.updateScan(scan.id, { status: 'collecting' });

  // --- collect -------------------------------------------------------------
  // Raw payloads are held per (collector x target) so normalise can run afterwards with
  // peer stats computed across the whole set — a comparative finding needs every target
  // collected before any of them can be judged.
  const captured = new Map<string, Map<Uuid, unknown>>();

  for (const collector of collectors) {
    if (!collector.segments.includes(segment)) continue;
    if (collector.requires_auth && mode === 'cold') continue;

    const byTarget = new Map<Uuid, unknown>();
    captured.set(collector.name, byTarget);

    for (const target of targets) {
      const request: CollectTarget = {
        target_id: target.row.id,
        role: target.row.role,
        place: target.place,
      };

      const startedAt = Date.now();
      const outcome = await attempt(() => collector.collect(request, { mode }));
      meter.add(outcome.cost);

      const run = await store.recordCollectorRun({
        scan_id: scan.id,
        target_id: target.row.id,
        collector: collector.name,
        status: outcome.error ? 'failed' : 'ok',
        requires_auth: collector.requires_auth,
        cost_pence: outcome.cost.pence,
        duration_ms: Date.now() - startedAt,
        error: outcome.error,
      });

      if (outcome.error) {
        // Rule 5. The section thins and the record says why.
        warnings.push(`${collector.name} failed for ${target.place.name}: ${outcome.error}`);
        continue;
      }

      byTarget.set(target.row.id, outcome.value);

      if (outcome.value !== null && outcome.value !== undefined) {
        await store.saveRawCapture({
          collector_run_id: run.id,
          source: collector.name,
          payload: outcome.value,
        });
      }
    }
  }

  // --- normalise -----------------------------------------------------------
  say('normalising', 'turning captures into findings');
  await store.updateScan(scan.id, { status: 'normalising' });

  const drafts = normaliseAll(collectors, captured, targets, { now: now(), segment });
  const findings = await store.saveFindings(scan.id, drafts);

  // --- analyse -------------------------------------------------------------
  say('analysing', `${findings.length} findings`);
  await store.updateScan(scan.id, { status: 'analysing' });

  const benchmarks = await store.benchmarks(vertical, region);
  const analysis = await analyseScan(writer, {
    subject: { name: subject.name, vertical, region },
    targets: targets.map((t) => ({
      id: t.row.id,
      role: t.row.role,
      selection_reason: t.row.selection_reason,
      name: t.place.name,
    })),
    findings,
    benchmarks,
    subjectTargetId: rows[0]!.id,
  });
  meter.add(analysis.cost);

  const violations = analysis.value.violations.map((v) => `${v.where}: [${v.code}] ${v.message}`);

  // --- render --------------------------------------------------------------
  let html: string | null = null;
  let onePager: string | null = null;

  if (violations.length === 0) {
    say('rendering', 'writing the report');
    await store.updateScan(scan.id, { status: 'rendering' });

    const context: ReportContext = {
      subject: subject.name,
      vertical,
      region,
      competitors: competitors.map((c) => c.place.name),
      scanned_at: now().toISOString(),
      mode,
    };
    const renderInput = {
      context,
      narrative: analysis.value.narrative,
      findings,
      benchmarks,
      subjectTargetId: rows[0]!.id,
    };

    html = renderReport(renderInput);
    onePager = renderOnePager(renderInput);

    await store.saveReport({
      scan_id: scan.id,
      version: 1,
      variant: 'full',
      narrative: analysis.value.narrative,
      storage_key: null,
    });
    await store.saveReport({
      scan_id: scan.id,
      version: 1,
      variant: 'onepager',
      narrative: analysis.value.narrative,
      storage_key: null,
    });
  } else {
    // The gate refused. The scan is finished and its findings are kept — what failed is the
    // narrative written over them, and that is worth retrying without re-buying the data.
    warnings.push(`narrative rejected: ${violations.length} violation(s)`);
  }

  const status = violations.length === 0 ? 'complete' : 'failed';
  await store.updateScan(scan.id, {
    status,
    cost_pence: meter.pence,
    error: violations.length === 0 ? null : violations.join('; '),
    completed: true,
  });

  const finalScan = (await store.getScan(scan.id))!;
  return {
    scan: finalScan,
    targets: rows,
    findings,
    violations,
    html,
    onePager,
    warnings,
  };
}

/**
 * Normalise every capture, with peer stats computed across the competitor set.
 *
 * Peers are the competitors only. Including the subject in its own comparison would pull
 * the median towards whatever is being measured and soften every finding about it.
 */
function normaliseAll(
  collectors: AnyCollector[],
  captured: Map<string, Map<Uuid, unknown>>,
  targets: Target[],
  ctx: { now: Date; segment: Segment },
): FindingDraft[] {
  const drafts: FindingDraft[] = [];

  for (const collector of collectors) {
    const byTarget = captured.get(collector.name);
    if (!byTarget) continue;

    const competitorRaws = targets
      .filter((t) => t.row.role === 'competitor')
      .map((t) => byTarget.get(t.row.id))
      .filter((raw) => raw !== undefined);

    const peers: PeerStats | undefined =
      collector.peerStats && competitorRaws.length > 0
        ? collector.peerStats(competitorRaws, { now: ctx.now })
        : undefined;

    for (const target of targets) {
      if (!byTarget.has(target.row.id)) continue;

      const seeds = collector.normalise(byTarget.get(target.row.id), {
        now: ctx.now,
        role: target.row.role,
        segment: ctx.segment,
        ...(peers ? { peers } : {}),
      });

      for (const seed of seeds) drafts.push(expandSeed(seed, target.row.id));
    }
  }

  return drafts;
}

/**
 * Re-run the rules over a scan already collected, without buying anything.
 *
 * This is what rule 3 is for. Rules change weekly; captures cost money and never change.
 * A re-normalise replaces the scan's findings and back-fills benchmarks for free.
 */
export async function renormalise(
  scanId: Uuid,
  deps: Pick<ScanDeps, 'store' | 'collectors' | 'now'> & { segment?: Segment },
): Promise<Finding[]> {
  const { store, collectors } = deps;
  const now = (deps.now ?? (() => new Date()))();

  const targetRows = await store.targetsForScan(scanId);
  const runs = await store.collectorRunsForScan(scanId);
  const captures = await store.rawCapturesForScan(scanId);

  const runById = new Map(runs.map((r) => [r.id, r]));
  const captured = new Map<string, Map<Uuid, unknown>>();

  for (const capture of captures) {
    const run = runById.get(capture.collector_run_id);
    if (!run) continue;
    const byTarget = captured.get(run.collector) ?? new Map<Uuid, unknown>();
    byTarget.set(run.target_id, capture.payload);
    captured.set(run.collector, byTarget);
  }

  // The place is not needed to normalise — only the raw payload and the target's role.
  const targets: Target[] = targetRows.map((row) => ({
    row,
    place: { place_id: '', name: '', primary_category: null, lat: 0, lng: 0, domain: null, postcode: null, phone: null },
  }));

  const drafts = normaliseAll(collectors, captured, targets, {
    now,
    segment: deps.segment ?? 'smb',
  });
  return store.saveFindings(scanId, drafts);
}
