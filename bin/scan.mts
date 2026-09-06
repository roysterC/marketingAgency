#!/usr/bin/env node
/**
 * The scan trigger.
 *
 * Spec §9 asks for "a manual scan trigger from a simple internal dashboard — no self-serve,
 * no auth, no billing". For ten manual scans run by one person this is that, and a web app
 * would be more to build and more to keep working for no extra capability. A6 puts the site
 * last for the same reason.
 *
 *   npm run scan -- --name "Riverside Plumbing" --postcode "SW18 4AB"
 *   npm run scan -- --domain riversideplumbing.example
 *   npm run scan -- --name "..." --postcode "..." --fixtures   # no keys, no spend
 *   npm run scan -- --list
 *
 * Results are written to `.scans/` — the store, and the rendered HTML for each scan. That
 * directory is gitignored: it holds real businesses' data.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadDotEnv, missingCredentials } from '../lib/adapters/config.ts';
import { createFileScanStore, DEFAULT_STORE_PATH } from '../lib/db/file.ts';
import { runScan, type ProgressEvent } from '../lib/scan/run.ts';
import { erase, type AnyCollector } from '../lib/collectors/types.ts';
import type { ResolveProviders } from '../lib/resolve/providers.ts';
import type { NarrativeWriter } from '../lib/analyse/index.ts';

// --- arguments --------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const has = (name: string): boolean => args.includes(`--${name}`);

const OUT_DIR = flag('out') ?? '.scans';
const storePath = flag('store') ?? join(OUT_DIR, 'store.json');

const dim = (s: string) => `[2m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const bold = (s: string) => `[1m${s}[0m`;

function usage(): never {
  console.log(`
  ${bold('npm run scan')} -- --name "Riverside Plumbing" --postcode "SW18 4AB"
  ${bold('npm run scan')} -- --domain riversideplumbing.example

  ${dim('--fixtures')}   run against fixtures. No keys, no network, no spend
  ${dim('--keywords')}   comma-separated money keywords for the map pack sweep
  ${dim('--out')}        where to write reports (default .scans)
  ${dim('--list')}       list previous scans and stop
`);
  process.exit(args.length === 0 ? 1 : 0);
}

// --- listing ----------------------------------------------------------------

if (has('list')) {
  const store = createFileScanStore(storePath);
  const scans = await store.listScans();

  if (scans.length === 0) {
    console.log(dim(`\n  No scans yet in ${storePath}\n`));
    process.exit(0);
  }

  console.log(`\n  ${scans.length} scan(s) in ${storePath}\n`);
  for (const scan of scans) {
    const cost = `£${(scan.cost_pence / 100).toFixed(2)}`;
    const mark = scan.status === 'complete' ? green('complete') : red(scan.status);
    console.log(`  ${scan.started_at}  ${mark.padEnd(18)} ${cost.padStart(7)}  ${scan.id}`);
    if (scan.error) console.log(`    ${dim(scan.error.slice(0, 140))}`);
  }
  console.log('');
  process.exit(0);
}

if (has('help') || args.length === 0) usage();

const name = flag('name');
const postcode = flag('postcode');
const domain = flag('domain');

if (!domain && !(name && postcode)) {
  console.error(red('\n  Need either --domain, or both --name and --postcode.\n'));
  usage();
}

// --- wiring -----------------------------------------------------------------

const fixtures = has('fixtures');
loadDotEnv();

const keywords = (flag('keywords') ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);

/**
 * Fixture wiring, or the real thing.
 *
 * The two are deliberately the same shape. Every provider in this repo sits behind an
 * interface with a fixture implementation, so `--fixtures` exercises the entire pipeline —
 * resolve, six collectors, analyse, render, persistence — with no key and no spend. It is
 * how you check the plumbing before pointing it at someone's business.
 */
async function wire(): Promise<{
  providers: ResolveProviders;
  collectors: AnyCollector[];
  writer: NarrativeWriter;
  keywords: string[];
}> {
  if (fixtures) {
    const { fixtureProviders } = await import('../lib/resolve/fixtures.ts');
    const { createGbpCollector } = await import('../lib/collectors/gbp/index.ts');
    const { fixtureGbpProvider } = await import('../lib/collectors/gbp/fixtures.ts');
    const { createReviewsCollector } = await import('../lib/collectors/reviews/index.ts');
    const { fixtureReviewsProvider } = await import('../lib/collectors/reviews/fixtures.ts');
    const { templateWriter } = await import('../lib/analyse/fixtures.ts');

    return {
      providers: fixtureProviders,
      collectors: [
        erase(createGbpCollector(fixtureGbpProvider)),
        erase(createReviewsCollector(fixtureReviewsProvider)),
      ],
      // Builds a narrative over this scan's own findings, so a fixture run exercises the
      // gate and the renderer without an LLM call.
      writer: templateWriter(),
      keywords: keywords.length > 0 ? keywords : ['emergency plumber wandsworth'],
    };
  }

  const missing = missingCredentials(process.env);
  if (missing.length > 0) {
    console.error(
      red(`\n  Missing ${missing.length} required credential(s): ${missing.join(', ')}`) +
        dim('\n  Run `npm run check:keys` for the full picture, or --fixtures to run without keys.\n'),
    );
    process.exit(1);
  }

  const { placesConfigFromEnv, createPlacesProvider, createGbpProvider, createPlacesReviewSampleProvider } =
    await import('../lib/adapters/places.ts');
  const { dataForSeoConfigFromEnv, createSerpProvider, createReviewsProvider } = await import(
    '../lib/adapters/dataforseo.ts'
  );
  const { createVitalsProvider, pageSpeedConfigFromEnv } = await import('../lib/adapters/pagespeed.ts');
  const { createSiteCrawler } = await import('../lib/adapters/crawler.ts');
  const { createReadOnlyProbe } = await import('../lib/adapters/speedtolead.ts');
  const { answerSourcesFromEnv, claudeExtractor, createAivisProvider, scanPromptCache } =
    await import('../lib/adapters/aivis.ts');
  const { createNarrativeWriter, writerConfigFromEnv } = await import('../lib/adapters/writer.ts');

  const { createGbpCollector } = await import('../lib/collectors/gbp/index.ts');
  const { createReviewsCollector } = await import('../lib/collectors/reviews/index.ts');
  const { createSiteTechCollector } = await import('../lib/collectors/sitetech/index.ts');
  const { createLocalRankCollector, scanSerpCache } = await import('../lib/collectors/localrank/index.ts');

  const places = placesConfigFromEnv();
  const dfs = dataForSeoConfigFromEnv();
  const serp = scanSerpCache(createSerpProvider(dfs));
  const pages = (await import('../lib/resolve/fixtures.ts')).fixtureProviders.pages;

  const contactUrl = process.env.CRAWLER_CONTACT_URL ?? 'https://example.invalid/crawler';

  return {
    providers: { places: createPlacesProvider(places), serp, pages },
    collectors: [
      erase(createGbpCollector(createGbpProvider(places))),
      erase(
        createReviewsCollector(
          createReviewsProvider({ ...dfs, fallback: createPlacesReviewSampleProvider(places) }),
        ),
      ),
      erase(
        createSiteTechCollector({
          crawler: createSiteCrawler({ contactUrl }),
          vitals: createVitalsProvider(pageSpeedConfigFromEnv()),
        }),
      ),
      erase(
        createLocalRankCollector(serp, {
          near: { lat: 0, lng: 0 },
          keywords: keywords.map((term) => ({ term, money: true })),
        }),
      ),
      erase(
        createAivisCollectorFrom(
          await import('../lib/collectors/aivis/index.ts'),
          scanPromptCache(
            createAivisProvider({
              sources: answerSourcesFromEnv(),
              extractor: claudeExtractor(),
              roster: [],
            }),
          ),
          keywords,
        ),
      ),
    ],
    writer: createNarrativeWriter(writerConfigFromEnv()),
    keywords,
  };
}

/** Keeps the aivis wiring readable — it needs a prompt set rather than a plain provider. */
function createAivisCollectorFrom(
  module: typeof import('../lib/collectors/aivis/index.ts'),
  provider: Parameters<typeof module.createAivisCollector>[0],
  moneyKeywords: string[],
): ReturnType<typeof module.createAivisCollector> {
  return module.createAivisCollector(
    provider,
    {
      vertical: 'trades.plumbing',
      models: ['claude'],
      prompts: moneyKeywords.length > 0 ? moneyKeywords : ['best plumber in Wandsworth'],
    },
    module.NO_KNOWN_FACTS,
  );
}

// --- run --------------------------------------------------------------------

const { providers, collectors, writer, keywords: money } = await wire();
const store = createFileScanStore(storePath);

console.log(
  `\n  ${bold(domain ?? `${name}, ${postcode}`)}` +
    dim(`\n  ${fixtures ? 'fixtures — no keys, no spend' : 'live providers'} · store ${store.name}\n`),
);

const started = Date.now();

try {
  const result = await runScan(
    {
      ...(name ? { name } : {}),
      ...(postcode ? { postcode } : {}),
      ...(domain ? { domain } : {}),
      mode: 'cold',
      segment: 'smb',
    },
    {
      store,
      providers,
      collectors,
      writer,
      resolve: { keywords: money },
      onProgress: (event: ProgressEvent) => console.log(dim(`  ${event.stage}: ${event.message}`)),
    },
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const stem = join(OUT_DIR, result.scan.id);

  if (result.html) writeFileSync(`${stem}.html`, result.html, 'utf8');
  if (result.onePager) writeFileSync(`${stem}.onepager.html`, result.onePager, 'utf8');

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const cost = `£${(result.scan.cost_pence / 100).toFixed(2)}`;

  console.log('');
  for (const warning of result.warnings) console.log(`  ${dim('warning')} ${warning}`);

  if (result.violations.length > 0) {
    console.error(
      `\n  ${red('The narrative was rejected before render')} — ${result.violations.length} violation(s):`,
    );
    for (const violation of result.violations) console.error(`    - ${violation}`);
    console.error(
      dim(
        '\n  The findings are kept. Only the narrative failed, so a retry costs nothing to collect.\n',
      ),
    );
    process.exit(1);
  }

  console.log(
    `\n  ${green('Done')} in ${seconds}s for ${cost}` +
      `\n    ${result.findings.length} findings across ${result.targets.length} businesses` +
      `\n    ${stem}.html` +
      `\n    ${stem}.onepager.html\n`,
  );
} catch (error) {
  console.error(`\n  ${red('Scan failed')}: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

void DEFAULT_STORE_PATH;
