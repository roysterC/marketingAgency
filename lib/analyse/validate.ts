/**
 * The gate between a narrative and a rendered report.
 *
 * `docs/schema.md` calls this a hard gate, not a warning, and the reason is commercial
 * rather than tidy: a £1,000 report is bought on the assumption that every sentence in it
 * is checkable. One invented statistic discredits the whole document and the agency behind
 * it, and the reader who finds it will be the prospect, not us.
 *
 * So the render step will not accept a narrative that fails here. This is the same
 * pattern as `check:taxonomy` making "keep docs current" enforceable and
 * `speedtolead/ethics.ts` making the mystery-shop rule enforceable: the constraint lives
 * where it cannot be skipped, rather than in a paragraph someone has to remember.
 *
 * Five of the six checks are mechanical and exact. The sixth — an estimate phrased as
 * fact — cannot be, and is honest about being a backstop.
 */

import { canQuoteBenchmark, percentilesOf } from '../taxonomy/benchmark';
import { MIN_BENCHMARK_SAMPLE } from '../taxonomy/enums';
import type { Benchmark, Finding, Narrative, NarrativeClaim, Uuid } from '../types/index';
import { benchmarkFor } from './brief';

export type ViolationCode =
  /** A claim points at a finding that is not on this scan. */
  | 'UNREFERENCED_CLAIM'
  /** An `estimated` finding stated as though it were measured. */
  | 'ESTIMATE_AS_FACT'
  /** A vertical percentile quoted on too few scans to mean anything. */
  | 'THIN_BENCHMARK_CITED'
  /** A `critical` finding with nothing a reader could check. */
  | 'CRITICAL_WITHOUT_EVIDENCE'
  /** A `critical` finding about the subject that the narrative never mentions. */
  | 'CRITICAL_UNREPORTED'
  /** A recommendation with no finding behind it — invented work. */
  | 'RECOMMENDATION_WITHOUT_FINDING';

export interface Violation {
  code: ViolationCode;
  /** Human-readable, and specific enough to fix without opening a debugger. */
  message: string;
  /** Which part of the narrative, e.g. `executive_summary[1]`. */
  where: string;
  finding_id?: Uuid;
}

/**
 * Language that marks a sentence as inference rather than observation.
 *
 * This is a backstop and is documented as one. It cannot tell, in general, whether a
 * sentence overstates its evidence — that is a judgement. What it does catch is the
 * specific, likely failure: a model handed `GBP_CATEGORY_MISMATCH` (which is `estimated`,
 * because it is a guess from the business name) writing "your listing is in the wrong
 * category" as a flat statement of fact.
 *
 * A false positive here costs a rewrite. A false negative costs a claim we cannot defend.
 */
export const HEDGES: RegExp[] = [
  /\bestimat\w*/i,
  /\bappears?\b/i,
  /\bappear to\b/i,
  /\blikely\b/i,
  /\bprobabl\w*/i,
  /\bsuggests?\b/i,
  /\bindicat\w*/i,
  /\bseems?\b/i,
  /\baround\b/i,
  /\bapproximat\w*/i,
  /\broughly\b/i,
  /\bmay\b/i,
  /\bsigns? that\b/i,
];

export const isHedged = (text: string): boolean => HEDGES.some((h) => h.test(text));

/**
 * Whether a finding carries something a reader could actually check.
 *
 * A bare `{}` is not evidence, and neither is an object whose every value is empty. For a
 * `critical` finding this is a hard requirement: it is the one the report leads with, and
 * it is the one a sceptical prospect will try to verify first.
 */
export function hasRenderableEvidence(finding: Finding): boolean {
  const values = Object.values(finding.evidence).filter(
    (v) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0),
  );
  if (values.length > 0) return true;
  // A measurement is itself checkable, even with a thin evidence bag.
  return finding.measured_value !== null || finding.measured_text !== null;
}

const claimsOf = (narrative: Narrative): Array<{ claim: NarrativeClaim; where: string }> => [
  ...narrative.executive_summary.map((claim, i) => ({
    claim,
    where: `executive_summary[${i}]`,
  })),
  ...narrative.sections.flatMap((section, s) =>
    section.claims.map((claim, i) => ({
      claim,
      where: `sections[${s}].claims[${i}]`,
    })),
  ),
];

export interface ValidateInput {
  narrative: Narrative;
  findings: Finding[];
  benchmarks: Benchmark[];
}

/**
 * Every way this narrative is not safe to send.
 *
 * Returns them all rather than the first, so one pass tells you everything to fix.
 */
export function validateNarrative(input: ValidateInput): Violation[] {
  const { narrative, findings, benchmarks } = input;
  const byId = new Map(findings.map((f) => [f.id, f]));
  const violations: Violation[] = [];

  for (const { claim, where } of claimsOf(narrative)) {
    const finding = byId.get(claim.finding_id);

    if (!finding) {
      violations.push({
        code: 'UNREFERENCED_CLAIM',
        message: `Claim cites finding ${claim.finding_id}, which is not on this scan.`,
        where,
        finding_id: claim.finding_id,
      });
      continue;
    }

    if (finding.confidence === 'estimated' && !isHedged(claim.text)) {
      violations.push({
        code: 'ESTIMATE_AS_FACT',
        message:
          `Claim rests on ${finding.code}, which is estimated, but reads as measured fact. ` +
          `Phrase it as an inference.`,
        where,
        finding_id: finding.id,
      });
    }

    if (finding.benchmark_source === 'vertical_p50') {
      const row = benchmarkFor(finding, benchmarks);
      if (row === null || !canQuoteBenchmark(percentilesOf(row))) {
        violations.push({
          code: 'THIN_BENCHMARK_CITED',
          message:
            `Claim quotes a vertical percentile for ${finding.code} with ` +
            `${row?.sample_size ?? 0} comparable scans behind it, under the minimum of ` +
            `${MIN_BENCHMARK_SAMPLE}.`,
          where,
          finding_id: finding.id,
        });
      }
    }
  }

  // --- recommendations -----------------------------------------------------
  narrative.recommendations.forEach((rec, i) => {
    if (rec.finding_ids.length === 0) {
      violations.push({
        code: 'RECOMMENDATION_WITHOUT_FINDING',
        message: `Recommendation "${rec.action}" cites no finding.`,
        where: `recommendations[${i}]`,
      });
      return;
    }
    for (const id of rec.finding_ids) {
      if (!byId.has(id)) {
        violations.push({
          code: 'RECOMMENDATION_WITHOUT_FINDING',
          message: `Recommendation "${rec.action}" cites finding ${id}, which is not on this scan.`,
          where: `recommendations[${i}]`,
          finding_id: id,
        });
      }
    }
  });

  // --- the critical findings -----------------------------------------------
  for (const finding of findings) {
    if (finding.severity !== 'critical') continue;

    if (!hasRenderableEvidence(finding)) {
      violations.push({
        code: 'CRITICAL_WITHOUT_EVIDENCE',
        message: `${finding.code} is critical but carries nothing a reader could check.`,
        where: `findings.${finding.code}`,
        finding_id: finding.id,
      });
    }
  }

  return violations;
}

/**
 * As `validateNarrative`, plus the requirement that the subject's critical findings are
 * actually in the narrative.
 *
 * Split out because it needs to know which target is the subject, and because a scan of
 * competitors alone is a legitimate thing to validate without it.
 */
export function validateForSubject(
  input: ValidateInput & { subjectTargetId: Uuid },
): Violation[] {
  const violations = validateNarrative(input);
  const referenced = new Set<Uuid>();

  for (const { claim } of claimsOf(input.narrative)) referenced.add(claim.finding_id);
  for (const rec of input.narrative.recommendations) {
    for (const id of rec.finding_ids) referenced.add(id);
  }

  for (const finding of input.findings) {
    if (finding.severity !== 'critical') continue;
    if (finding.target_id !== input.subjectTargetId) continue;
    if (referenced.has(finding.id)) continue;

    violations.push({
      code: 'CRITICAL_UNREPORTED',
      message:
        `${finding.code} is critical for the subject and the narrative never mentions it. ` +
        `A report that omits its worst finding is not finished.`,
      where: `findings.${finding.code}`,
      finding_id: finding.id,
    });
  }

  return violations;
}

export class NarrativeRejected extends Error {
  readonly violations: Violation[];

  constructor(violations: Violation[]) {
    const lines = violations.map((v) => `  ${v.where}: [${v.code}] ${v.message}`);
    super(`Narrative is not safe to render:\n${lines.join('\n')}`);
    this.name = 'NarrativeRejected';
    this.violations = violations;
  }
}

/** Throw unless the narrative is safe to send. The render step calls this first. */
export function assertRenderable(violations: Violation[]): void {
  if (violations.length > 0) throw new NarrativeRejected(violations);
}
