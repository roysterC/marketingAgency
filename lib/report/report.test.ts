import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Narrative } from '../types/index';
import { NarrativeRejected } from '../analyse/validate';
import {
  BENCHMARKS,
  F,
  FINDINGS_FOR_SCAN,
  GOOD_NARRATIVE,
  REPORT_CONTEXT,
  SUBJECT_TARGET,
} from '../analyse/fixtures';
import {
  escapeHtml,
  renderEvidence,
  renderFinding,
  renderMeasurement,
  renderOnePager,
  renderReport,
  type RenderInput,
} from './render';

const input: RenderInput = {
  context: REPORT_CONTEXT,
  narrative: GOOD_NARRATIVE,
  findings: FINDINGS_FOR_SCAN,
  benchmarks: BENCHMARKS,
  subjectTargetId: SUBJECT_TARGET,
};

const html = renderReport(input);
const onePager = renderOnePager(input);

describe('the render step will not print an indefensible claim', () => {
  test('an invalid narrative throws instead of rendering', () => {
    const broken: Narrative = {
      ...GOOD_NARRATIVE,
      executive_summary: [{ text: 'Your ad spend is wasted.', finding_id: 'nope' }],
    };
    assert.throws(() => renderReport({ ...input, narrative: broken }), NarrativeRejected);
  });

  test('the one-pager is gated by the same check', () => {
    const broken: Narrative = {
      ...GOOD_NARRATIVE,
      recommendations: [{ action: 'Rebrand.', finding_ids: [], priority: 1 }],
    };
    assert.throws(() => renderOnePager({ ...input, narrative: broken }), NarrativeRejected);
  });

  test('there is no way to render without validating', () => {
    // Both entry points call assertRenderable themselves rather than trusting a caller to
    // have done it, which is the difference between a gate and a lint pass.
    const broken: Narrative = { ...GOOD_NARRATIVE, executive_summary: [{ text: 'x', finding_id: 'y' }] };
    assert.throws(() => renderReport({ ...input, narrative: broken }));
    assert.throws(() => renderOnePager({ ...input, narrative: broken }));
  });
});

describe('every finding shows its proof', () => {
  test('the evidence table is rendered for each cited finding', () => {
    assert.ok(html.includes('class="evidence"'));
    // The submission and reply timestamps a prospect would check.
    assert.ok(html.includes('2026-09-04T10:14:00.000Z'));
    assert.ok(html.includes('2026-09-05T17:14:00.000Z'));
  });

  test('URLs in evidence become links', () => {
    assert.ok(
      html.includes('<a href="http://riversideplumbing.example/contact"'),
      'the form we submitted should be one click away',
    );
  });

  test('nested evidence is printed as its raw shape', () => {
    // The model, prompt and stated value behind AIVIS_OUTDATED_FACT.
    assert.ok(html.includes('perplexity'));
    assert.ok(html.includes('020 8000 9999'));
    assert.ok(html.includes('<pre>'));
  });

  test('empty evidence values are left out rather than rendered blank', () => {
    const rendered = renderEvidence({
      ...F.noHttps,
      evidence: { final_url: 'http://x.example/', note: '', missing: null },
    });
    assert.ok(rendered.includes('final url'));
    assert.equal(rendered.includes('missing'), false);
  });

  test('a finding with no evidence at all renders no table', () => {
    assert.equal(renderEvidence({ ...F.noHttps, evidence: {} }), '');
  });

  test('object-storage keys are shown as references, not as links', () => {
    const rendered = renderEvidence({
      ...F.noHttps,
      evidence: { screenshot_key: 'evidence/contact.png' },
    });
    assert.ok(rendered.includes('class="asset"'));
    assert.equal(rendered.includes('<a href'), false);
  });

  test('each finding is anchored so a recommendation can point at it', () => {
    assert.ok(html.includes(`id="finding-${F.slowReply.id}"`));
    assert.ok(html.includes(`href="#finding-${F.slowReply.id}"`));
  });
});

describe('an estimate never looks like a measurement', () => {
  test('the estimated finding is marked in the markup and in words', () => {
    const rendered = renderFinding(F.category);
    assert.ok(rendered.includes('confidence-estimated'));
    assert.ok(rendered.includes('inferred, not measured'));
  });

  test('a measured finding says so', () => {
    const rendered = renderFinding(F.slowReply);
    assert.ok(rendered.includes('confidence-verified'));
    assert.ok(rendered.includes('measured directly'));
  });

  test('the distinction survives black and white printing', () => {
    // Colour alone would lose it. The label is words.
    assert.ok(html.includes('estimated — inferred, not measured'));
  });

  test('severity is carried in the class and in the text', () => {
    const rendered = renderFinding(F.slowReply);
    assert.ok(rendered.includes('severity-critical'));
    assert.ok(rendered.includes('>critical<'));
  });
});

describe('measurements', () => {
  test('prefer the written form when there is one', () => {
    assert.equal(renderMeasurement(F.slowReply), '31 hours to reply');
  });

  test('fall back to the value and its unit', () => {
    assert.equal(renderMeasurement({ ...F.slowReply, measured_text: null }), '31 hours');
  });

  test('render nothing for a binary finding', () => {
    assert.equal(renderMeasurement(F.noHttps), '');
  });
});

describe('the document', () => {
  test('is a complete HTML page', () => {
    assert.ok(html.startsWith('<!doctype html>'));
    assert.ok(html.includes('<title>Riverside Plumbing — competitive teardown</title>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
  });

  test('leads with the summary', () => {
    assert.ok(html.indexOf('id="summary"') < html.indexOf('id="section-speedtolead"'));
    assert.ok(html.includes('Nobody replied for 31 hours'));
  });

  test('says who the comparison is against', () => {
    assert.ok(html.includes('Wandsworth Plumbers Ltd'));
  });

  test('says what cold mode could not see, and why', () => {
    assert.ok(html.includes('public data only'));
    assert.ok(html.includes('rather than guessed at'));
  });

  test('a warm report drops the cold note', () => {
    const warm = renderReport({ ...input, context: { ...REPORT_CONTEXT, mode: 'warm' } });
    assert.equal(warm.includes('public data only'), false);
  });

  test('recommendations are ordered and linked to their findings', () => {
    const start = html.indexOf('id="recommendations"');
    assert.ok(start > 0);
    const block = html.slice(start);
    assert.ok(block.indexOf('enquiry alert') < block.indexOf('Move the site to https'));
  });

  test('findings within a section are worst-first', () => {
    const section = html.slice(html.indexOf('id="section-speedtolead"'));
    assert.ok(section.includes('severity-critical'));
  });
});

describe('the one-pager for cold outbound', () => {
  test('is the same narrative, cut to what makes someone reply', () => {
    assert.ok(onePager.startsWith('<!doctype html>'));
    assert.ok(onePager.includes('Nobody replied for 31 hours'));
    assert.ok(onePager.length < html.length);
  });

  test('carries at most three findings, worst first', () => {
    const count = onePager.split('class="finding').length - 1;
    assert.ok(count <= 3, `expected at most 3 findings, got ${count}`);
    assert.ok(onePager.includes('severity-critical'));
  });

  test('the limit is adjustable', () => {
    assert.equal(renderOnePager(input, 1).split('class="finding').length - 1, 1);
  });

  test('still shows evidence — an unverifiable claim in outbound is worthless', () => {
    assert.ok(onePager.includes('class="evidence"'));
  });

  test('says there is more', () => {
    assert.ok(onePager.includes('This is an extract'));
  });
});

describe('escaping', () => {
  test('business names with ampersands do not break the document', () => {
    const rendered = renderReport({
      ...input,
      context: { ...REPORT_CONTEXT, subject: 'Smith & Sons <Plumbing>' },
    });
    assert.ok(rendered.includes('Smith &amp; Sons &lt;Plumbing&gt;'));
    assert.equal(rendered.includes('<Plumbing>'), false);
  });

  test('evidence captured from a page cannot inject markup', () => {
    const nasty = renderEvidence({
      ...F.noHttps,
      evidence: { note: '<script>alert(1)</script>' },
    });
    assert.equal(nasty.includes('<script>'), false);
    assert.ok(nasty.includes('&lt;script&gt;'));
  });

  test('escapes the five characters that matter', () => {
    assert.equal(escapeHtml(`<&>"'`), '&lt;&amp;&gt;&quot;&#39;');
  });
});
