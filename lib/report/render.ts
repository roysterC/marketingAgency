/**
 * Rendering a scan to HTML.
 *
 * Two variants, both from the same narrative: the full report, and the one-page version
 * for cold outbound. PDF is explicitly out of the Phase 1 MVP.
 *
 * Three things this layer is responsible for beyond turning data into markup:
 *
 * 1. **It refuses to render an unvalidated narrative.** `assertRenderable` runs first, so
 *    there is no path from a claim we cannot defend to a document a prospect reads.
 * 2. **Every finding shows its evidence.** A timestamp, a URL, a raw value. A finding a
 *    prospect cannot verify is worth nothing, and one they *can* verify is what sells.
 * 3. **`estimated` never looks like `verified`.** The taxonomy draws that line hard, and
 *    the styling has to keep it — an inference rendered in the same voice as a measurement
 *    is the same lie, just prettier.
 */

import { FINDINGS } from '../taxonomy/findings';
import type { Severity } from '../taxonomy/enums';
import type { Finding, Narrative } from '../types/index';
import { assertRenderable, validateForSubject, type Violation } from '../analyse/validate';
import type { Benchmark, Uuid } from '../types/index';

export interface ReportContext {
  subject: string;
  vertical: string | null;
  region: string | null;
  competitors: string[];
  /** When the scan ran. Rendered, because a teardown ages. */
  scanned_at: string;
  /** Cold reports say so — the reader should know what we could and could not see. */
  mode: 'cold' | 'warm';
}

export interface RenderInput {
  context: ReportContext;
  narrative: Narrative;
  findings: Finding[];
  benchmarks: Benchmark[];
  subjectTargetId: Uuid;
}

/** Escape everything that goes into the document. Business names contain ampersands. */
export function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

/** Keys whose values are a URL worth turning into a link. */
const LINK_KEYS = /_(url|link)$/;
/** Keys that hold an object-storage reference rather than something to print. */
const ASSET_KEYS = /screenshot|storage_key/;

const isUrl = (value: unknown): value is string =>
  typeof value === 'string' && /^https?:\/\//.test(value);

/**
 * One evidence entry, rendered as proof.
 *
 * Values are printed as they were captured. Nested objects and arrays are JSON, because a
 * prospect checking a claim would rather see the raw shape than a prose summary of it.
 */
function renderEvidenceValue(key: string, value: unknown): string {
  if (isUrl(value) && LINK_KEYS.test(key)) {
    const safe = escapeHtml(value);
    return `<a href="${safe}" rel="noopener noreferrer">${safe}</a>`;
  }
  if (typeof value === 'object' && value !== null) {
    return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  }
  return escapeHtml(value);
}

export function renderEvidence(finding: Finding): string {
  const entries = Object.entries(finding.evidence).filter(
    ([, v]) => v !== null && v !== undefined && v !== '',
  );
  if (entries.length === 0) return '';

  const rows = entries
    .map(([key, value]) => {
      const label = escapeHtml(key.replace(/_/g, ' '));
      const rendered = ASSET_KEYS.test(key)
        ? `<span class="asset">${escapeHtml(value)}</span>`
        : renderEvidenceValue(key, value);
      return `<tr><th>${label}</th><td>${rendered}</td></tr>`;
    })
    .join('\n');

  return `<table class="evidence"><caption>Evidence</caption>${rows}</table>`;
}

/** The measured value, with its unit, or the free-text form when there is no number. */
export function renderMeasurement(finding: Finding): string {
  if (finding.measured_text) return escapeHtml(finding.measured_text);
  if (finding.measured_value === null) return '';
  const unit = finding.measured_unit && finding.measured_unit !== 'none'
    ? ` ${escapeHtml(finding.measured_unit)}`
    : '';
  return `${escapeHtml(finding.measured_value)}${unit}`;
}

/**
 * A finding, with its severity, its confidence and its proof.
 *
 * The `confidence` class is not decoration: the stylesheet marks estimates visibly, and
 * the label is written out so the distinction survives being printed in black and white.
 */
export function renderFinding(finding: Finding): string {
  const def = FINDINGS[finding.code];
  const measurement = renderMeasurement(finding);
  const benchmark =
    finding.benchmark_value !== null
      ? `<p class="benchmark">Competitor best: ${escapeHtml(finding.benchmark_value)}` +
        `${def.unit !== 'none' ? ` ${escapeHtml(def.unit)}` : ''}</p>`
      : '';

  return [
    `<article class="finding severity-${finding.severity} confidence-${finding.confidence}" id="finding-${escapeHtml(finding.id)}">`,
    `<h3>${escapeHtml(def.title)}</h3>`,
    `<p class="meta">`,
    `<span class="severity">${escapeHtml(finding.severity)}</span>`,
    `<span class="confidence">${finding.confidence === 'estimated' ? 'estimated — inferred, not measured' : 'verified — measured directly'}</span>`,
    `<code>${escapeHtml(finding.code)}</code>`,
    `</p>`,
    measurement ? `<p class="measurement">${measurement}</p>` : '',
    benchmark,
    renderEvidence(finding),
    `</article>`,
  ]
    .filter(Boolean)
    .join('\n');
}

const STYLES = `
:root { --critical:#b3261e; --high:#a15c00; --medium:#5c5c5c; --low:#767676; --info:#767676; }
body { font: 16px/1.55 -apple-system, Segoe UI, Roboto, sans-serif; max-width: 46rem; margin: 3rem auto; padding: 0 1.25rem; color: #1b1b1b; }
h1 { font-size: 1.9rem; margin-bottom: .25rem; }
.subtitle { color: #5c5c5c; margin-top: 0; }
.finding { border-left: 3px solid var(--medium); padding: .5rem 0 .5rem 1rem; margin: 1.5rem 0; }
.finding.severity-critical { border-color: var(--critical); }
.finding.severity-high { border-color: var(--high); }
.finding h3 { margin: 0 0 .35rem; font-size: 1.1rem; }
.meta { margin: 0 0 .5rem; font-size: .8rem; color: #5c5c5c; display: flex; gap: .75rem; flex-wrap: wrap; }
.meta .severity { text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }
.confidence-estimated .meta .confidence { font-style: italic; }
.confidence-estimated { background: #fbf7ee; }
.measurement { font-size: 1.25rem; font-weight: 600; margin: .25rem 0; }
.benchmark { margin: .1rem 0; color: #5c5c5c; }
table.evidence { border-collapse: collapse; margin-top: .75rem; font-size: .85rem; width: 100%; }
table.evidence caption { text-align: left; color: #767676; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; padding-bottom: .25rem; }
table.evidence th { text-align: left; vertical-align: top; padding: .25rem .75rem .25rem 0; color: #5c5c5c; font-weight: 500; white-space: nowrap; }
table.evidence td { padding: .25rem 0; word-break: break-word; }
table.evidence pre { margin: 0; white-space: pre-wrap; font-size: .8rem; }
.asset { color: #767676; font-family: ui-monospace, monospace; }
.cold-note { background: #f4f4f4; padding: .75rem 1rem; font-size: .85rem; }
ol.recommendations li { margin-bottom: .5rem; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid #e0e0e0; color: #767676; font-size: .8rem; }
`.trim();

function shell(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
  ].join('\n');
}

function header(context: ReportContext, subtitle: string): string {
  const where = [context.vertical, context.region].filter(Boolean).map(escapeHtml).join(' · ');
  return [
    `<h1>${escapeHtml(context.subject)}</h1>`,
    `<p class="subtitle">${escapeHtml(subtitle)}${where ? ` — ${where}` : ''}</p>`,
  ].join('\n');
}

/**
 * The cold-mode note.
 *
 * Says what we could not see and why. It is honest, and it is also the upsell: "four more
 * checks run once you grant access" converts better than a vaguer promise.
 */
function coldNote(context: ReportContext): string {
  if (context.mode !== 'cold') return '';
  return (
    `<p class="cold-note">This teardown used public data only — no access to ` +
    `${escapeHtml(context.subject)}'s analytics, ads or Business Profile. Some checks ` +
    `cannot run without that access, and are not reported either way rather than guessed at.</p>`
  );
}

function competitorNote(context: ReportContext): string {
  if (context.competitors.length === 0) return '';
  return `<p class="subtitle">Compared against ${context.competitors.map(escapeHtml).join(', ')}.</p>`;
}

/** Validate, then render the full report. Throws rather than rendering something unsafe. */
export function renderReport(input: RenderInput): string {
  assertRenderable(violationsOf(input));

  const { context, narrative, findings } = input;
  const byId = new Map(findings.map((f) => [f.id, f]));

  const summary = narrative.executive_summary
    .map((claim) => `<li>${escapeHtml(claim.text)}</li>`)
    .join('\n');

  const sections = narrative.sections
    .map((section) => {
      const prose = section.claims.map((c) => `<p>${escapeHtml(c.text)}</p>`).join('\n');
      const rendered = section.claims
        .map((c) => byId.get(c.finding_id))
        .filter((f): f is Finding => f !== undefined)
        .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
        .map(renderFinding)
        .join('\n');

      return [
        `<section id="section-${escapeHtml(section.collector)}">`,
        `<h2>${escapeHtml(section.heading)}</h2>`,
        prose,
        rendered,
        `</section>`,
      ].join('\n');
    })
    .join('\n');

  const recommendations = narrative.recommendations
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .map((rec) => {
      const links = rec.finding_ids
        .map((id) => byId.get(id))
        .filter((f): f is Finding => f !== undefined)
        .map(
          (f) =>
            `<a href="#finding-${escapeHtml(f.id)}">${escapeHtml(FINDINGS[f.code].title)}</a>`,
        )
        .join(', ');
      return `<li>${escapeHtml(rec.action)}${links ? ` <small>(${links})</small>` : ''}</li>`;
    })
    .join('\n');

  return shell(
    `${context.subject} — competitive teardown`,
    [
      header(context, 'Competitive teardown'),
      competitorNote(context),
      coldNote(context),
      `<section id="summary"><h2>Summary</h2><ul>${summary}</ul></section>`,
      sections,
      recommendations
        ? `<section id="recommendations"><h2>What to do, in order</h2><ol class="recommendations">${recommendations}</ol></section>`
        : '',
      `<footer>Scanned ${escapeHtml(context.scanned_at)}. Every figure above is measured or, where marked, estimated — and every one links to the evidence behind it.</footer>`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * The one-page variant for cold outbound.
 *
 * Same narrative, cut to what makes someone reply: the summary, and the two or three
 * findings that are embarrassing, verifiable and previously unknown. Everything else is
 * what they get on the call.
 */
export function renderOnePager(input: RenderInput, limit = 3): string {
  assertRenderable(violationsOf(input));

  const { context, narrative, findings } = input;
  const byId = new Map(findings.map((f) => [f.id, f]));

  const lead = narrative.executive_summary
    .map((claim) => ({ claim, finding: byId.get(claim.finding_id) }))
    .filter((x): x is { claim: (typeof narrative.executive_summary)[number]; finding: Finding } =>
      x.finding !== undefined,
    )
    .sort((a, b) => SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity])
    .slice(0, limit);

  const body = lead
    .map(({ claim, finding }) => `<p>${escapeHtml(claim.text)}</p>\n${renderFinding(finding)}`)
    .join('\n');

  return shell(
    `${context.subject} — what we found`,
    [
      header(context, 'What we found in 20 minutes'),
      coldNote(context),
      body,
      `<footer>This is an extract. The full teardown covers ${escapeHtml(narrative.sections.length)} areas against ${escapeHtml(context.competitors.length)} competitors.</footer>`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function violationsOf(input: RenderInput): Violation[] {
  return validateForSubject({
    narrative: input.narrative,
    findings: input.findings,
    benchmarks: input.benchmarks,
    subjectTargetId: input.subjectTargetId,
  });
}
