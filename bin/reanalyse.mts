#!/usr/bin/env node
/**
 * Re-run the writer over a scan that is already collected.
 *
 * The spec's instruction after the ten-business run is "iterate on report quality, not on
 * code", and that means running the writer repeatedly over the same findings. Doing that
 * through `npm run scan` re-buys every provider call — the DataForSEO billing export
 * showed exactly that, three runs paying three times for identical review history.
 *
 * This is rule 3 collected on: captures and findings are already paid for and never
 * change, so a rewrite costs one model call.
 *
 *   npm run reanalyse                      # latest scan, current default effort
 *   npm run reanalyse -- --effort medium   # same findings, less thinking
 *   npm run reanalyse -- --scan <id> --write
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadDotEnv } from '../lib/adapters/config.ts';
import { analyseScan } from '../lib/analyse/index.ts';
import { createNarrativeWriter, writerConfigFromEnv, type Effort } from '../lib/adapters/writer.ts';
import { renderOnePager, renderReport } from '../lib/report/render.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const OUT_DIR = flag('out') ?? '.scans';
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

loadDotEnv();

// Read the store file directly: ScanStore has no business lookup, and the render context
// needs names. Worth adding to the interface if this outgrows a comparison tool.
const store = JSON.parse(readFileSync(join(OUT_DIR, 'store.json'), 'utf8')) as {
  scans: Array<{ id: string; started_at: string }>;
  businesses: Array<{ id: string; name: string; vertical: string | null; region: string | null }>;
  targets: Array<{ id: string; scan_id: string; business_id: string; role: string; selection_reason: string | null }>;
  findings: Array<Record<string, unknown> & { id: string; scan_id: string }>;
};

const scanId = flag('scan') ?? store.scans.at(-1)?.id;
const scan = store.scans.find((s) => s.id === scanId);
if (!scan) {
  console.error(red(`\n  No scan ${scanId ?? '(none stored)'} in ${OUT_DIR}/store.json\n`));
  process.exit(1);
}

const businesses = new Map(store.businesses.map((b) => [b.id, b]));
const targets = store.targets.filter((t) => t.scan_id === scan.id);
const findings = store.findings.filter((f) => f.scan_id === scan.id);
const subjectTarget = targets.find((t) => t.role === 'subject');
const subject = subjectTarget ? businesses.get(subjectTarget.business_id) : undefined;

if (!subjectTarget || !subject) {
  console.error(red('\n  That scan has no subject target.\n'));
  process.exit(1);
}

const effort = (flag('effort') ?? 'high') as Effort;

console.log(
  `\n  ${bold(subject.name)}` +
    dim(`\n  scan ${scan.id} · ${findings.length} findings · ${targets.length} businesses · effort=${effort}\n`),
);

const started = Date.now();

try {
  const writer = createNarrativeWriter({ ...writerConfigFromEnv(), effort });
  const { value } = await analyseScan(writer, {
    subject: { name: subject.name, vertical: subject.vertical, region: subject.region },
    targets: targets.map((t) => ({
      id: t.id,
      role: t.role as 'subject' | 'competitor',
      selection_reason: t.selection_reason,
      name: businesses.get(t.business_id)?.name ?? 'unknown',
    })),
    findings: findings as never,
    benchmarks: [],
    subjectTargetId: subjectTarget.id,
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const byId = new Map(findings.map((f) => [f.id, f]));

  console.log(`  ${bold('EXECUTIVE SUMMARY')}`);
  for (const claim of value.narrative.executive_summary) {
    const f = byId.get(claim.finding_id) as { code?: string; confidence?: string } | undefined;
    console.log(`    • ${claim.text}`);
    console.log(dim(`      [${f?.code ?? '??'} / ${f?.confidence ?? '?'}]`));
  }

  console.log(`\n  ${bold('SECTIONS')}`);
  for (const section of value.narrative.sections) {
    console.log(`    ## ${section.heading}  ${dim(`(${section.collector}, ${section.claims.length} claims)`)}`);
    for (const claim of section.claims) console.log(`       - ${claim.text}`);
  }

  const recommendations = (value.narrative as { recommendations?: Array<{ priority: number; action: string }> })
    .recommendations ?? [];
  if (recommendations.length > 0) {
    console.log(`\n  ${bold('RECOMMENDATIONS')}`);
    for (const r of recommendations) console.log(`    ${r.priority}. ${r.action}`);
  }

  if (value.violations.length > 0) {
    console.log(`\n  ${red('VIOLATIONS')} — this narrative would not render`);
    for (const v of value.violations) console.log(`    ! ${v.where}: [${v.code}] ${v.message}`);
  }

  if (has('write') && value.violations.length === 0) {
    mkdirSync(OUT_DIR, { recursive: true });
    const context = {
      subject: subject.name,
      vertical: subject.vertical,
      region: subject.region,
      competitors: targets
        .filter((t) => t.role === 'competitor')
        .map((t) => businesses.get(t.business_id)?.name ?? 'unknown'),
      scanned_at: new Date().toISOString(),
      mode: 'cold' as const,
    };
    const renderInput = {
      context,
      narrative: value.narrative,
      findings: findings as never,
      benchmarks: [],
      subjectTargetId: subjectTarget.id,
    };
    const stem = join(OUT_DIR, `${scan.id}.${effort}`);
    writeFileSync(`${stem}.html`, renderReport(renderInput), 'utf8');
    writeFileSync(`${stem}.onepager.html`, renderOnePager(renderInput), 'utf8');
    console.log(dim(`\n  wrote ${stem}.html`));
  }

  console.log(dim(`\n  ${seconds}s · ${value.violations.length} violation(s)\n`));
} catch (error) {
  console.error(`\n  ${red('Reanalyse failed')}: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
