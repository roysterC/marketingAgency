/**
 * The analysis brief — what the model is allowed to see.
 *
 * CLAUDE.md rule 2 says the analysis layer reasons over structured findings only: never raw
 * HTML, never live retrieval. That is a claim about the *input*, so this is where it is
 * kept true. A brief is assembled from `findings`, the competitor set and the benchmark
 * table, and there is no path from `raw_captures` into it.
 *
 * Evidence is deliberately reduced to its key names. The renderer needs the values — a
 * screenshot, a URL, a timestamp — but the writer does not, because everything it should
 * say about a measurement is already in `measured`. Passing evidence through would hand a
 * model a page of captured markup to quote from, which is exactly the failure the rule
 * exists to prevent.
 */

import { percentilesOf, quartileOf, type Quartile } from '../taxonomy/benchmark';
import { FINDINGS } from '../taxonomy/findings';
import type { FindingCode } from '../taxonomy/findings';
import type { Benchmark, Finding, ScanTarget, Uuid } from '../types/index';
import type {
  BenchmarkSource,
  Collector,
  Confidence,
  Severity,
  TargetRole,
  Unit,
} from '../taxonomy/enums';
import { canQuoteBenchmark } from '../taxonomy/benchmark';

export interface BriefFinding {
  finding_id: Uuid;
  code: FindingCode;
  /** The registry's human label, so the model does not have to invent section headings. */
  title: string;
  collector: Collector;
  severity: Severity;
  confidence: Confidence;
  measured: {
    value: number | null;
    unit: Unit | null;
    text: string | null;
  };
  benchmark: {
    value: number | null;
    source: BenchmarkSource | null;
    /** Where this sits against the vertical, when the benchmark is solid enough to say. */
    quartile: Quartile;
  } | null;
  target: { name: string; role: TargetRole };
  /**
   * Which kinds of proof exist for this finding — key names only, never values.
   * The report renders the proof; the writer only needs to know it is there.
   */
  evidence_keys: string[];
}

export interface BriefCompetitor {
  name: string;
  /** Why this business is in the comparison. The first thing a prospect challenges. */
  selection_reason: string | null;
}

export interface AnalysisBrief {
  subject: string;
  vertical: string | null;
  region: string | null;
  competitors: BriefCompetitor[];
  findings: BriefFinding[];
  /**
   * Codes whose benchmark is too thin to quote.
   *
   * Told to the model explicitly rather than left implied: "not enough comparable
   * businesses yet" is an acceptable sentence, a percentile built on four scans is not.
   */
  unquotable_benchmarks: FindingCode[];
}

export interface BriefInput {
  subject: { name: string; vertical: string | null; region: string | null };
  targets: Array<Pick<ScanTarget, 'id' | 'role' | 'selection_reason'> & { name: string }>;
  findings: Finding[];
  benchmarks: Benchmark[];
}

/** Severity order for presenting findings worst-first. */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** The benchmark row for a finding, matched on code and metric. Null when we have none. */
export function benchmarkFor(finding: Finding, benchmarks: Benchmark[]): Benchmark | null {
  return (
    benchmarks.find(
      (b) => b.code === finding.code && b.metric === (finding.measured_unit ?? ''),
    ) ??
    benchmarks.find((b) => b.code === finding.code) ??
    null
  );
}

/** Evidence key names, minus anything empty. Values never leave this function. */
function evidenceKeys(finding: Finding): string[] {
  return Object.entries(finding.evidence)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key]) => key);
}

export function buildBrief(input: BriefInput): AnalysisBrief {
  const { subject, targets, findings, benchmarks } = input;
  const nameOf = new Map(targets.map((t) => [t.id, t.name]));
  const roleOf = new Map(targets.map((t) => [t.id, t.role]));

  const unquotable = new Set<FindingCode>();

  const briefFindings: BriefFinding[] = findings
    .slice()
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .map((finding) => {
      const row = benchmarkFor(finding, benchmarks);
      const quotable = row !== null && canQuoteBenchmark(percentilesOf(row));

      if (finding.benchmark_source === 'vertical_p50' && !quotable) {
        unquotable.add(finding.code);
      }

      const quartile: Quartile =
        row !== null && quotable && finding.measured_value !== null
          ? quartileOf(finding.code, finding.measured_value, percentilesOf(row))
          : 'unknown';

      return {
        finding_id: finding.id,
        code: finding.code,
        title: FINDINGS[finding.code].title,
        collector: finding.collector,
        severity: finding.severity,
        confidence: finding.confidence,
        measured: {
          value: finding.measured_value,
          unit: finding.measured_unit,
          text: finding.measured_text,
        },
        benchmark:
          finding.benchmark_value === null && finding.benchmark_source === null
            ? null
            : {
                value: finding.benchmark_value,
                source: finding.benchmark_source,
                quartile,
              },
        target: {
          name: nameOf.get(finding.target_id) ?? 'unknown',
          role: roleOf.get(finding.target_id) ?? 'competitor',
        },
        evidence_keys: evidenceKeys(finding),
      };
    });

  return {
    subject: subject.name,
    vertical: subject.vertical,
    region: subject.region,
    competitors: targets
      .filter((t) => t.role === 'competitor')
      .map((t) => ({ name: t.name, selection_reason: t.selection_reason })),
    findings: briefFindings,
    unquotable_benchmarks: [...unquotable],
  };
}
