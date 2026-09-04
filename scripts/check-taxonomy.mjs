#!/usr/bin/env node
/**
 * Cross-checks the three places the taxonomy is written down:
 *
 *   lib/taxonomy/findings.ts   the source of truth
 *   docs/finding-taxonomy.md   the human-readable view
 *   supabase/migrations/*.sql  the CHECK constraints
 *
 * CLAUDE.md says to keep docs current with the code. This is what makes that enforceable
 * rather than aspirational. Run with `npm run check:taxonomy`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const failures = [];
const fail = (msg) => failures.push(msg);

// ---------------------------------------------------------------- parse TS

const findingsSrc = read('lib/taxonomy/findings.ts');

/** code -> { severity, confidence, collector } */
const ts = new Map();
const blockRe = /^ {2}([A-Z][A-Z0-9_]*): \{\n([\s\S]*?)^ {2}\},$/gm;
for (const [, code, body] of findingsSrc.matchAll(blockRe)) {
  ts.set(code, {
    collector: body.match(/collector: '([a-z]+)'/)?.[1],
    severity: body.match(/severity: '([a-z]+)'/)?.[1],
    confidence: body.match(/confidence: '([a-z]+)'/)?.[1],
  });
}

if (ts.size === 0) fail('parsed 0 finding definitions from lib/taxonomy/findings.ts');

// --------------------------------------------------------------- parse docs

const docSrc = read('docs/finding-taxonomy.md');

/** code -> { severity, confidence } */
const doc = new Map();
const rowRe = /^\| `([A-Z][A-Z0-9_]*)` \| ([a-z]+) \| ([a-z]+) \|/gm;
for (const [, code, severity, confidence] of docSrc.matchAll(rowRe)) {
  doc.set(code, { severity, confidence });
}

if (doc.size === 0) fail('parsed 0 finding rows from docs/finding-taxonomy.md');

// ------------------------------------------------------ compare TS <-> docs

for (const code of ts.keys()) {
  if (!doc.has(code)) fail(`${code}: in findings.ts but missing from finding-taxonomy.md`);
}
for (const code of doc.keys()) {
  if (!ts.has(code)) fail(`${code}: in finding-taxonomy.md but missing from findings.ts`);
}
for (const [code, t] of ts) {
  const d = doc.get(code);
  if (!d) continue;
  if (d.severity !== t.severity) {
    fail(`${code}: severity differs — ts='${t.severity}' doc='${d.severity}'`);
  }
  if (d.confidence !== t.confidence) {
    fail(`${code}: confidence differs — ts='${t.confidence}' doc='${d.confidence}'`);
  }
}

// -------------------------------------------------- enums vs SQL constraints

const enumsSrc = read('lib/taxonomy/enums.ts');

const tsEnum = (name) => {
  const raw = enumsSrc.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`))?.[1];
  if (!raw) return null;
  return [...raw.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
};

const migrationsDir = 'supabase/migrations';
const sql = readdirSync(join(root, migrationsDir))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => read(join(migrationsDir, f)))
  .join('\n');

// Every `in ('a','b',...)` list appearing in a CHECK constraint, whitespace-normalised.
const sqlLists = [...sql.matchAll(/\bin\s*\(([^)]*)\)/g)].map(
  (m) => new Set([...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1])),
);

const sameSet = (a, b) => a.size === b.size && [...a].every((v) => b.has(v));

// Enums that are mirrored by a CHECK constraint in the schema.
for (const name of [
  'SEVERITIES',
  'CONFIDENCES',
  'COLLECTORS',
  'UNITS',
  'BENCHMARK_SOURCES',
  'SCAN_STATUSES',
  'SCAN_MODES',
  'COLLECTOR_RUN_STATUSES',
  'TARGET_ROLES',
]) {
  const values = tsEnum(name);
  if (!values) {
    fail(`${name}: could not parse from lib/taxonomy/enums.ts`);
    continue;
  }
  const want = new Set(values);
  if (!sqlLists.some((got) => sameSet(want, got))) {
    fail(`${name}: no CHECK constraint in the schema matches [${values.join(', ')}]`);
  }
}

// ------------------------------------------------------- internal integrity

const collectors = new Set(tsEnum('COLLECTORS') ?? []);
const used = new Set([...ts.values()].map((d) => d.collector));

for (const c of collectors) {
  if (!used.has(c)) fail(`collector '${c}' is declared but emits no finding codes`);
}
for (const c of used) {
  if (!collectors.has(c)) fail(`collector '${c}' is used by a finding but not in COLLECTORS`);
}

// ------------------------------------------------------------------- report

if (failures.length > 0) {
  console.error(`\n  taxonomy check FAILED — ${failures.length} problem(s):\n`);
  for (const f of failures) console.error(`    - ${f}`);
  console.error('');
  process.exit(1);
}

console.log(
  `\n  taxonomy check passed` +
    `\n    ${ts.size} finding codes, consistent across findings.ts and finding-taxonomy.md` +
    `\n    ${collectors.size} collectors, all emitting at least one code` +
    `\n    9 enums matched to CHECK constraints in the schema\n`,
);
