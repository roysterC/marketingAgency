#!/usr/bin/env node
/**
 * AI visibility tracking — edge service #1, run from the command line.
 *
 *   npm run visibility -- --track --set trades.plumbing --note "added FAQ schema"
 *   npm run visibility -- --report --set trades.plumbing
 *   npm run visibility -- --track --set demo --fixtures
 *
 * `--track` takes one snapshot: every prompt, of every model, recorded whether the news is
 * good or bad. `--report` reads the series back and says what moved.
 *
 * The A3 ship criterion is thirty days of tracking with a movement you can attribute to
 * something you changed, so `--note` matters more than it looks: it is the only place the
 * "what changed" half of that sentence can come from, and it has to be written at the time.
 *
 * Scheduling is deliberately not built in. `--track` is idempotent and cheap to call, so a
 * cron entry or a scheduled job is the whole of it — and building a scheduler before there
 * is a second caller would be tooling ahead of the offer.
 */

import { join } from 'node:path';

import { loadDotEnv } from '../lib/adapters/config.ts';
import { createFileScanStore } from '../lib/db/file.ts';
import { trackVisibility } from '../lib/visibility/track.ts';
import { alertsFrom, detectMovement, incomparableReason } from '../lib/visibility/movement.ts';
import type { PromptSet, TrackedBusiness } from '../lib/visibility/types.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const dim = (s: string) => `[2m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const amber = (s: string) => `[33m${s}[0m`;
const bold = (s: string) => `[1m${s}[0m`;

const storePath = flag('store') ?? join(flag('out') ?? '.scans', 'store.json');
const setName = flag('set') ?? 'default';
const store = createFileScanStore(storePath);

loadDotEnv();

if (!has('track') && !has('report')) {
  console.log(`
  ${bold('npm run visibility')} -- --track  --set trades.plumbing --note "what you changed"
  ${bold('npm run visibility')} -- --report --set trades.plumbing

  ${dim('--prompts')}   comma-separated, for a new series
  ${dim('--models')}    comma-separated (default claude)
  ${dim('--watch')}     comma-separated business names to alert on
  ${dim('--fixtures')}  no keys, no spend
`);
  process.exit(args.length === 0 ? 1 : 0);
}

// --- report -----------------------------------------------------------------

if (has('report')) {
  const snapshots = await store.snapshots(setName);

  if (snapshots.length === 0) {
    const known = await store.promptSets();
    console.log(dim(`\n  Nothing tracked for "${setName}".`));
    if (known.length > 0) console.log(dim(`  Series so far: ${known.join(', ')}`));
    console.log('');
    process.exit(0);
  }

  const latest = snapshots[snapshots.length - 1]!;
  console.log(
    `\n  ${bold(setName)} — ${snapshots.length} run(s), latest ${latest.run_at}` +
      dim(`\n  ${latest.prompts.length} prompts × ${latest.models.length} models · ${latest.answers} answers\n`),
  );

  for (const entry of latest.entries.slice(0, 12)) {
    const rank = entry.mean_rank === null ? '' : dim(` · rank ${entry.mean_rank}`);
    const bar = '█'.repeat(Math.round(entry.share / 5)).padEnd(20);
    console.log(`  ${String(entry.share).padStart(5)}%  ${dim(bar)} ${entry.name}${rank}`);
  }

  // A series that changed its questions is not a series. Say so rather than charting it.
  const broken = snapshots
    .map((s) => incomparableReason(s, latest))
    .filter((r): r is string => r !== null);
  if (broken.length > 0) {
    console.log(
      amber(`\n  ${broken.length} earlier run(s) are not comparable — ${[...new Set(broken)].join(', ')}.`) +
        dim('\n  They are excluded from the movement below rather than charted as change.'),
    );
  }

  const movements = detectMovement(snapshots);
  if (movements.length === 0) {
    console.log(
      dim('\n  No movement yet — a baseline needs at least one earlier comparable run.\n'),
    );
    process.exit(0);
  }

  console.log(`\n  ${bold('Movement')} against the median of the previous runs\n`);
  for (const movement of movements.filter((m) => m.direction !== 'flat')) {
    const sign = movement.delta > 0 ? '+' : '';
    const colour = movement.delta > 0 ? green : red;
    console.log(
      `  ${colour(`${sign}${movement.delta}`.padStart(6))}  ${movement.name.padEnd(30)} ` +
        dim(`${movement.baseline}% → ${movement.current}% · ${movement.direction}`),
    );
  }

  const watching = (flag('watch') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const alerts = alertsFrom(movements).filter(
    (a) => watching.length === 0 || watching.some((w) => a.movement.name.includes(w)),
  );

  if (alerts.length > 0) {
    console.log(`\n  ${red(bold('Alerts'))}\n`);
    for (const alert of alerts) console.log(`  ${alert.movement.name}: ${alert.reason}`);
  }
  console.log('');
  process.exit(0);
}

// --- track ------------------------------------------------------------------

const previous = await store.snapshots(setName);
const last = previous[previous.length - 1];

// Reuse the last run's questions unless told otherwise. Silently drifting prompts is how a
// series stops meaning anything, so continuing one is the default and changing it is explicit.
const promptSet: PromptSet = {
  name: setName,
  prompts: (flag('prompts') ?? '').split(',').map((p) => p.trim()).filter(Boolean),
  models: (flag('models') ?? '').split(',').map((m) => m.trim()).filter(Boolean),
};
if (promptSet.prompts.length === 0) promptSet.prompts = last?.prompts ?? [];
if (promptSet.models.length === 0) promptSet.models = last?.models ?? ['claude'];

if (promptSet.prompts.length === 0) {
  console.error(
    red('\n  No prompts. Pass --prompts "best plumber in wandsworth,emergency plumber sw18"') +
      dim('\n  for a new series; later runs reuse them.\n'),
  );
  process.exit(1);
}

if (last && (promptSet.prompts.join('|') !== last.prompts.join('|'))) {
  console.log(
    amber('\n  The prompts differ from the previous run.') +
      dim('\n  This starts a new baseline — earlier runs will not be compared against it.'),
  );
}

const roster: TrackedBusiness[] = (flag('watch') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((name) => ({ business_id: null, name }));

const provider = has('fixtures')
  ? (await import('../lib/collectors/aivis/fixtures.ts')).fixtureAivisProvider()
  : await (async () => {
      const { answerSourcesFromEnv, claudeExtractor, createAivisProvider, scanPromptCache } =
        await import('../lib/adapters/aivis.ts');
      return scanPromptCache(
        createAivisProvider({
          sources: answerSourcesFromEnv(),
          extractor: claudeExtractor(),
          roster: roster.map((b) => ({ place_id: b.business_id ?? b.name, name: b.name })),
        }),
      );
    })();

console.log(
  `\n  ${bold(setName)} — ${promptSet.prompts.length} prompts × ${promptSet.models.length} models` +
    dim(`\n  ${has('fixtures') ? 'fixtures — no keys, no spend' : 'live models'}\n`),
);

const result = await trackVisibility(provider, promptSet, roster, {
  note: flag('note') ?? null,
  onProgress: (message) => console.log(dim(`  ${message}`)),
});

await store.saveSnapshot(result.snapshot);

console.log('');
for (const failure of result.failures) {
  console.log(amber(`  ${failure.model} refused "${failure.prompt}": ${failure.message}`));
}

for (const entry of result.snapshot.entries.slice(0, 8)) {
  const rank = entry.mean_rank === null ? '' : dim(` · rank ${entry.mean_rank}`);
  console.log(`  ${String(entry.share).padStart(5)}%  ${entry.name}${rank}`);
}

console.log(
  `\n  ${green('Recorded')} run ${previous.length + 1} of "${setName}"` +
    ` for £${(result.snapshot.cost_pence / 100).toFixed(2)}` +
    (result.snapshot.note ? dim(`\n  note: ${result.snapshot.note}`) : '') +
    dim('\n  npm run visibility -- --report --set ' + setName + '\n'),
);
