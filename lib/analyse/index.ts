/**
 * The analyse stage.
 *
 * A model writes the narrative over structured findings, and then the narrative is checked
 * before anything is allowed to render. The order matters: validation is not a lint pass
 * someone runs when they remember, it is the step between writing and sending.
 *
 * The writer sits behind a provider interface like every other paid source (rule 8), so
 * the whole stage runs end to end on a fixture with no API key and no spend.
 */

import type { Priced } from '../resolve/providers';
import type { Benchmark, Finding, Narrative, Uuid } from '../types/index';
import { buildBrief, type AnalysisBrief, type BriefInput } from './brief';
import { assertRenderable, validateForSubject, type Violation } from './validate';

export interface NarrativeWriter {
  readonly name: string;
  /**
   * Turn a brief into a narrative.
   *
   * The brief is all it gets. It may rank, group, phrase and explain; it may not introduce
   * a fact that is not in a finding, and `validate.ts` is what holds it to that.
   */
  write(brief: AnalysisBrief): Promise<Priced<Narrative>>;
}

export interface AnalysisResult {
  brief: AnalysisBrief;
  narrative: Narrative;
  /** Empty when the narrative is safe to send. */
  violations: Violation[];
}

export interface AnalyseInput extends BriefInput {
  subjectTargetId: Uuid;
}

/**
 * Write and check, returning both.
 *
 * Violations are returned rather than thrown so a caller can log them, retry the writer
 * with the failures fed back, or fail the scan — all of which are reasonable. What no
 * caller can do is render anyway: `renderReport` calls `assertRenderable` itself.
 */
export async function analyseScan(
  writer: NarrativeWriter,
  input: AnalyseInput,
): Promise<Priced<AnalysisResult>> {
  const brief = buildBrief(input);
  const { value: narrative, cost } = await writer.write(brief);

  const violations = validateForSubject({
    narrative,
    findings: input.findings,
    benchmarks: input.benchmarks,
    subjectTargetId: input.subjectTargetId,
  });

  return { value: { brief, narrative, violations }, cost };
}

/**
 * Write, check, and refuse to continue if the narrative is not defensible.
 *
 * For a caller that has no retry story and would rather fail the scan than send something
 * it cannot stand behind — which is the right default.
 */
export async function analyseOrThrow(
  writer: NarrativeWriter,
  input: AnalyseInput,
): Promise<Priced<AnalysisResult>> {
  const result = await analyseScan(writer, input);
  assertRenderable(result.value.violations);
  return result;
}

/** Findings referenced anywhere in a narrative, in the order the report will use them. */
export function referencedFindings(narrative: Narrative, findings: Finding[]): Finding[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const seen = new Set<Uuid>();
  const out: Finding[] = [];

  const take = (id: Uuid): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const finding = byId.get(id);
    if (finding) out.push(finding);
  };

  for (const claim of narrative.executive_summary) take(claim.finding_id);
  for (const section of narrative.sections) {
    for (const claim of section.claims) take(claim.finding_id);
  }
  for (const rec of narrative.recommendations) {
    for (const id of rec.finding_ids) take(id);
  }

  return out;
}

export type { Benchmark };
export * from './brief';
export * from './validate';
