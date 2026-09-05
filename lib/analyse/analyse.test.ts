import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Narrative } from '../types/index';
import { analyseOrThrow, analyseScan, buildBrief, referencedFindings } from './index';
import {
  NarrativeRejected,
  hasRenderableEvidence,
  isHedged,
  validateForSubject,
  validateNarrative,
  type ViolationCode,
} from './validate';
import {
  BENCHMARKS,
  COMPETITOR_TARGET,
  F,
  FINDINGS_FOR_SCAN,
  GOOD_NARRATIVE,
  SUBJECT,
  SUBJECT_TARGET,
  TARGETS,
  fixtureWriter,
} from './fixtures';

const input = {
  subject: SUBJECT,
  targets: TARGETS,
  findings: FINDINGS_FOR_SCAN,
  benchmarks: BENCHMARKS,
  subjectTargetId: SUBJECT_TARGET,
};

const check = (narrative: Narrative, findings = FINDINGS_FOR_SCAN): ViolationCode[] =>
  validateForSubject({
    narrative,
    findings,
    benchmarks: BENCHMARKS,
    subjectTargetId: SUBJECT_TARGET,
  }).map((v) => v.code);

describe('the brief is the whole of what the writer sees', () => {
  const brief = buildBrief(input);

  test('evidence values never reach it — only the key names', () => {
    // Rule 2 is a claim about the input. The reply we quoted is in the evidence bag and
    // must not be in the brief, or a model has captured content to paraphrase from.
    const serialised = JSON.stringify(brief);
    assert.equal(serialised.includes('callout is £70'), false);
    assert.equal(serialised.includes('Not secure'), false);

    const stl = brief.findings.find((f) => f.code === 'STL_FORM_SLOW_REPLY')!;
    assert.ok(stl.evidence_keys.includes('excerpt'));
    assert.ok(stl.evidence_keys.includes('submitted_at'));
  });

  test('everything the narrative needs to say is in `measured`', () => {
    const stl = brief.findings.find((f) => f.code === 'STL_FORM_SLOW_REPLY')!;
    assert.equal(stl.measured.value, 31);
    assert.equal(stl.measured.unit, 'hours');
    assert.equal(stl.measured.text, '31 hours to reply');
  });

  test('findings arrive worst-first', () => {
    assert.equal(brief.findings[0]!.severity, 'critical');
    const severities = brief.findings.map((f) => f.severity);
    assert.deepEqual(
      severities,
      [...severities].sort(
        (a, b) =>
          ['critical', 'high', 'medium', 'low', 'info'].indexOf(a) -
          ['critical', 'high', 'medium', 'low', 'info'].indexOf(b),
      ),
    );
  });

  test('carries why each competitor is in the comparison', () => {
    assert.equal(brief.competitors.length, 1);
    assert.match(brief.competitors[0]!.selection_reason!, /money keywords/);
  });

  test('places a value against the vertical when the benchmark is solid', () => {
    // 0.17 reviews a month against p25 1.2 — bottom quartile, on 42 scans.
    const velocity = brief.findings.find((f) => f.code === 'REVIEW_VELOCITY_LOW')!;
    assert.equal(velocity.benchmark?.quartile, 'bottom');
  });

  test('names the codes whose benchmark is too thin to quote', () => {
    const withThin = buildBrief({ ...input, findings: [...FINDINGS_FOR_SCAN, F.thinBenchmark] });
    assert.deepEqual(withThin.unquotable_benchmarks, ['REVIEW_VOLUME_LOW']);
    const volume = withThin.findings.find((f) => f.code === 'REVIEW_VOLUME_LOW')!;
    assert.equal(volume.benchmark?.quartile, 'unknown');
  });

  test('a target with no findings does not become a phantom competitor', () => {
    assert.equal(
      buildBrief(input).competitors.some((c) => c.name === 'Riverside Plumbing'),
      false,
    );
  });
});

describe('a narrative that is safe to send', () => {
  test('passes every gate', () => {
    assert.deepEqual(check(GOOD_NARRATIVE), []);
  });

  test('mentions every critical finding about the subject', () => {
    const referenced = new Set(referencedFindings(GOOD_NARRATIVE, FINDINGS_FOR_SCAN).map((f) => f.id));
    for (const f of FINDINGS_FOR_SCAN) {
      if (f.severity !== 'critical' || f.target_id !== SUBJECT_TARGET) continue;
      assert.ok(referenced.has(f.id), f.code);
    }
  });
});

describe('claims have to rest on findings', () => {
  test('a claim citing a finding that is not on the scan is rejected', () => {
    const invented: Narrative = {
      ...GOOD_NARRATIVE,
      executive_summary: [
        { text: 'Your ad spend is being wasted.', finding_id: 'f_does_not_exist' },
        ...GOOD_NARRATIVE.executive_summary,
      ],
    };
    assert.deepEqual(check(invented), ['UNREFERENCED_CLAIM']);
  });

  test('a recommendation with nothing behind it is invented work', () => {
    const padded: Narrative = {
      ...GOOD_NARRATIVE,
      recommendations: [
        ...GOOD_NARRATIVE.recommendations,
        { action: 'Rebrand the business.', finding_ids: [], priority: 9 },
      ],
    };
    assert.deepEqual(check(padded), ['RECOMMENDATION_WITHOUT_FINDING']);
  });

  test('a recommendation citing a finding from another scan is rejected too', () => {
    const crossed: Narrative = {
      ...GOOD_NARRATIVE,
      recommendations: [{ action: 'Fix it.', finding_ids: ['f_elsewhere'], priority: 1 }],
    };
    assert.ok(check(crossed).includes('RECOMMENDATION_WITHOUT_FINDING'));
  });
});

describe('an estimate must not be phrased as a fact', () => {
  const gbpSection = (text: string): Narrative => ({
    ...GOOD_NARRATIVE,
    sections: GOOD_NARRATIVE.sections.map((s) =>
      s.collector === 'gbp' ? { ...s, claims: [{ text, finding_id: F.category.id }] } : s,
    ),
  });

  test('a flat statement on an estimated finding is rejected', () => {
    assert.deepEqual(
      check(gbpSection('Your listing is filed under the wrong primary category.')),
      ['ESTIMATE_AS_FACT'],
    );
  });

  test('the same point, hedged, passes', () => {
    assert.deepEqual(
      check(gbpSection('Your listing appears to be filed under the wrong primary category.')),
      [],
    );
  });

  test('the check only applies to estimated findings', () => {
    // The response time was measured, so it is stated flatly and that is correct.
    const stl = GOOD_NARRATIVE.executive_summary[0]!;
    assert.equal(isHedged(stl.text), false);
    assert.deepEqual(check(GOOD_NARRATIVE), []);
  });

  test('recognises the usual hedges', () => {
    assert.equal(isHedged('This appears to be costing you work'), true);
    assert.equal(isHedged('We estimate the gap at 30 hours'), true);
    assert.equal(isHedged('roughly 12 a month'), true);
    assert.equal(isHedged('You are losing work'), false);
  });
});

describe('a thin benchmark must not be quoted', () => {
  test('a vertical percentile on four scans is rejected', () => {
    const withThin = [...FINDINGS_FOR_SCAN, F.thinBenchmark];
    const cites: Narrative = {
      ...GOOD_NARRATIVE,
      sections: [
        ...GOOD_NARRATIVE.sections,
        {
          heading: 'Review volume',
          collector: 'reviews',
          claims: [
            {
              text: 'You have 23 reviews against a vertical median of 140.',
              finding_id: F.thinBenchmark.id,
            },
          ],
        },
      ],
    };
    assert.deepEqual(check(cites, withThin), ['THIN_BENCHMARK_CITED']);
  });

  test('a percentile with enough scans behind it is fine', () => {
    // Velocity has 42 scans; the good narrative quotes it and passes.
    assert.equal(F.velocity.benchmark_source, 'vertical_p50');
    assert.deepEqual(check(GOOD_NARRATIVE), []);
  });
});

describe('critical findings', () => {
  test('one the narrative never mentions is a violation', () => {
    const silent: Narrative = {
      ...GOOD_NARRATIVE,
      executive_summary: GOOD_NARRATIVE.executive_summary.filter(
        (c) => c.finding_id !== F.noHttps.id,
      ),
      sections: GOOD_NARRATIVE.sections.filter((s) => s.collector !== 'sitetech'),
      recommendations: GOOD_NARRATIVE.recommendations.filter(
        (r) => !r.finding_ids.includes(F.noHttps.id),
      ),
    };
    assert.deepEqual(check(silent), ['CRITICAL_UNREPORTED']);
  });

  test('one with nothing checkable behind it is a violation', () => {
    const codes = check(GOOD_NARRATIVE, [...FINDINGS_FOR_SCAN, F.evidenceless]);
    assert.ok(codes.includes('CRITICAL_WITHOUT_EVIDENCE'));
  });

  test("a competitor's critical finding does not have to appear", () => {
    // The report is about the subject. Wandsworth never replying is context.
    assert.equal(F.competitorCritical.severity, 'critical');
    assert.equal(F.competitorCritical.target_id, COMPETITOR_TARGET);
    assert.deepEqual(check(GOOD_NARRATIVE), []);
  });

  test('a measurement counts as something a reader can check', () => {
    assert.equal(hasRenderableEvidence(F.evidenceless), false);
    assert.equal(
      hasRenderableEvidence({ ...F.evidenceless, measured_text: 'rang for 45 seconds' }),
      true,
    );
  });

  test('an evidence bag of empty values is not evidence', () => {
    const hollow = { ...F.evidenceless, evidence: { url: '', note: null, examples: [] } };
    assert.equal(hasRenderableEvidence(hollow), false);
  });
});

describe('validateNarrative without a subject', () => {
  test('checks everything except whether the criticals were reported', () => {
    const silent: Narrative = { ...GOOD_NARRATIVE, executive_summary: [], sections: [], recommendations: [] };
    const codes = validateNarrative({
      narrative: silent,
      findings: FINDINGS_FOR_SCAN,
      benchmarks: BENCHMARKS,
    }).map((v) => v.code);
    assert.deepEqual(codes, []);
  });
});

describe('the analyse stage', () => {
  test('writes, checks, and reports the cost', async () => {
    const writer = fixtureWriter();
    const { value, cost } = await analyseScan(writer, input);

    assert.deepEqual(value.violations, []);
    assert.equal(cost.pence, 60);
    assert.equal(writer.briefs().length, 1);
  });

  test('hands the writer a brief and nothing else', async () => {
    const writer = fixtureWriter();
    await analyseScan(writer, input);
    const brief = writer.briefs()[0]!;
    assert.equal(brief.subject, 'Riverside Plumbing');
    assert.equal(brief.findings.length, FINDINGS_FOR_SCAN.length);
  });

  test('returns violations rather than throwing, so a caller can retry', async () => {
    const broken: Narrative = {
      ...GOOD_NARRATIVE,
      executive_summary: [{ text: 'Invented.', finding_id: 'nope' }],
    };
    const { value } = await analyseScan(fixtureWriter(broken), input);
    assert.ok(value.violations.length > 0);
  });

  test('analyseOrThrow refuses instead', async () => {
    const broken: Narrative = {
      ...GOOD_NARRATIVE,
      executive_summary: [{ text: 'Invented.', finding_id: 'nope' }],
    };
    await assert.rejects(() => analyseOrThrow(fixtureWriter(broken), input), NarrativeRejected);
  });

  test('the rejection names every problem at once', async () => {
    const broken: Narrative = {
      ...GOOD_NARRATIVE,
      executive_summary: [
        { text: 'Invented.', finding_id: 'nope' },
        ...GOOD_NARRATIVE.executive_summary,
      ],
      recommendations: [{ action: 'Rebrand.', finding_ids: [], priority: 1 }],
    };
    try {
      await analyseOrThrow(fixtureWriter(broken), input);
      assert.fail('should have thrown');
    } catch (error) {
      assert.ok(error instanceof NarrativeRejected);
      assert.equal(error.violations.length, 2);
      assert.match(error.message, /UNREFERENCED_CLAIM/);
      assert.match(error.message, /RECOMMENDATION_WITHOUT_FINDING/);
    }
  });
});

describe('referencedFindings', () => {
  test('returns each finding once, in the order the report meets it', () => {
    const referenced = referencedFindings(GOOD_NARRATIVE, FINDINGS_FOR_SCAN);
    const ids = referenced.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(ids[0], F.slowReply.id);
  });

  test('ignores a competitor finding the narrative never cites', () => {
    const ids = referencedFindings(GOOD_NARRATIVE, FINDINGS_FOR_SCAN).map((f) => f.id);
    assert.equal(ids.includes(F.competitorCritical.id), false);
  });
});
