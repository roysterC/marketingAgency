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
import {
  TTL,
  createFileProviderCache,
  createNullProviderCache,
  pruneCache,
} from '../lib/db/provider-cache.ts';
import { runScan, type CollectorFactory, type ProgressEvent } from '../lib/scan/run.ts';
import { profileByName, runsCollector, type ScanProfile } from '../lib/scan/profiles.ts';
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

/**
 * How much engine to spend. `full` for the paid audit and the demo, `hook` for outbound.
 * Run hook over a list, full on whoever replies — see lib/scan/profiles.ts.
 */
const profile: ScanProfile = profileByName(flag('profile') ?? 'full');

const dim = (s: string) => `[2m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const bold = (s: string) => `[1m${s}[0m`;

function usage(): never {
  console.log(`
  ${bold('npm run scan')} -- --name "Riverside Plumbing" --postcode "SW18 4AB"
  ${bold('npm run scan')} -- --domain riversideplumbing.example

  ${dim('--profile')}    ${bold('full')} (default) the paid audit and the demo — every collector
                ${bold('hook')} cold outbound — gbp + aivis, one-pager, a fraction of the cost
  ${dim('--fixtures')}   run against fixtures. No keys, no network, no spend
  ${dim('--keywords')}   comma-separated money keywords. Required for a live scan:
                competitors are chosen from the local results for these terms
  ${dim('--no-cache')}   ignore the stored provider cache and re-buy everything
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
  collectors: CollectorFactory;
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

    // Filtered by the same profile as the live path, so `--fixtures --profile hook`
    // exercises the real collector selection rather than a fixed pair.
    const fixtureBuild: Record<string, () => AnyCollector> = {
      gbp: () => erase(createGbpCollector(fixtureGbpProvider)),
      reviews: () => erase(createReviewsCollector(fixtureReviewsProvider)),
    };

    return {
      providers: fixtureProviders,
      collectors: () =>
        profile.collectors.flatMap((name) =>
          fixtureBuild[name] ? [fixtureBuild[name]!()] : [],
        ),
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

  // Competitor selection is entirely driven by the map pack sweep, so no keywords means no
  // sweep, no candidates and a "teardown" comparing the subject against nobody. It fails
  // here rather than producing that report.
  if (keywords.length === 0) {
    console.error(
      red('\n  --keywords is required for a live scan.') +
        dim(
          '\n  Competitors are chosen from the local results for these terms, so without them the' +
            '\n  scan resolves the subject and finds nobody to compare it against.' +
            '\n\n  --keywords "emergency roofer birmingham,roof repair birmingham"\n',
        ),
    );
    process.exit(1);
  }

  const { placesConfigFromEnv, createPlacesProvider, createGbpProvider, createPlacesReviewSampleProvider } =
    await import('../lib/adapters/places.ts');
  const { dataForSeoConfigFromEnv, createSerpProvider, createReviewsProvider } = await import(
    '../lib/adapters/dataforseo.ts'
  );
  const { createVitalsProvider, pageSpeedConfigFromEnv } = await import('../lib/adapters/pagespeed.ts');
  const { createPageFetcher, createSiteCrawler } = await import('../lib/adapters/crawler.ts');
  const { answerSourcesFromEnv, claudeExtractor, createAivisProvider } = await import(
    '../lib/adapters/aivis.ts'
  );
  const { createNarrativeWriter, writerConfigFromEnv } = await import('../lib/adapters/writer.ts');

  const { createGbpCollector } = await import('../lib/collectors/gbp/index.ts');
  const { createReviewsCollector } = await import('../lib/collectors/reviews/index.ts');
  const { createSiteTechCollector } = await import('../lib/collectors/sitetech/index.ts');
  const { createLocalRankCollector, scanSerpCache } = await import('../lib/collectors/localrank/index.ts');
  // scanPromptCache belongs to the collector, not the adapter — it is the same
  // one-purchase-per-scan wrapper localrank uses, and it lives beside the collector it caches.
  const { createAivisCollector, scanPromptCache, NO_KNOWN_FACTS } = await import(
    '../lib/collectors/aivis/index.ts'
  );

  const places = placesConfigFromEnv();
  const dfs = dataForSeoConfigFromEnv();

  // Survives the process, unlike the per-scan caches. The billing data showed three runs
  // against one plumber buying review history for the same six place_ids three times, and
  // competitor sets overlap heavily inside one vertical and city — ten plumbers are drawn
  // from a pool of maybe twenty. Only the sources that hold still are wrapped: map-pack
  // positions and AI answers are the measurement and are never served from disk.
  const cache = has('no-cache')
    ? createNullProviderCache()
    : createFileProviderCache(join(OUT_DIR, 'cache.json'));

  const identity = (placeId: string): string => placeId;

  // One cache instance shared by resolve and localrank. They ask for the same keywords at
  // the same point, so this is the difference between one round of SERP calls and two.
  const serp = scanSerpCache(createSerpProvider(dfs));

  const contactUrl = process.env.CRAWLER_CONTACT_URL ?? 'https://example.invalid/crawler';

  return {
    providers: {
      places: createPlacesProvider(places),
      serp,
      pages: createPageFetcher({ contactUrl }),
    },

    // Built after resolve — `near` and the aivis roster are both facts about the resolved
    // business, and guessing either produces confident nonsense rather than a thin report.
    // Built after resolve — `near` and the aivis roster are both facts about the resolved
    // business, and guessing either produces confident nonsense rather than a thin report.
    //
    // Each entry is built lazily, so a collector the profile excludes is never constructed
    // and therefore never billed.
    collectors: (ctx) => {
      const gbp = createGbpProvider(places);
      const reviews = createReviewsProvider({
        ...dfs,
        fallback: createPlacesReviewSampleProvider(places),
      });

      const build: Record<string, () => AnyCollector> = {
        gbp: () =>
          erase(
            createGbpCollector({
              ...gbp,
              fetchProfile: cache.wrap('gbp', TTL.gbp, identity, gbp.fetchProfile),
            }),
          ),

        reviews: () =>
          erase(
            createReviewsCollector({
              ...reviews,
              fetchReviews: cache.wrap('reviews', TTL.reviews, identity, reviews.fetchReviews),
            }),
          ),

        sitetech: () =>
          erase(
            createSiteTechCollector({
              crawler: createSiteCrawler({ contactUrl }),
              vitals: createVitalsProvider(pageSpeedConfigFromEnv()),
            }),
          ),

        localrank: () =>
          erase(
            createLocalRankCollector(serp, {
              near: { lat: ctx.subject.lat, lng: ctx.subject.lng },
              keywords: ctx.keywords.map((term) => ({ term, money: true })),
            }),
          ),

        aivis: () =>
          erase(
            createAivisCollector(
              scanPromptCache(
                createAivisProvider({
                  sources: answerSourcesFromEnv(),
                  extractor: claudeExtractor(),
                  // Every business in the scan. A citation the extractor cannot place
                  // against this list matches nobody, and an empty roster therefore
                  // reports the whole set as invisible to AI whatever the models said.
                  roster: [ctx.subject, ...ctx.competitors].map((p) => ({
                    place_id: p.place_id,
                    name: p.name,
                  })),
                }),
              ),
              {
                // The real category, not a placeholder. This selects the prompt set and
                // labels the benchmark the finding is compared against.
                vertical: ctx.vertical ?? 'unknown',
                models: ['claude'],
                prompts: ctx.keywords,
              },
              NO_KNOWN_FACTS,
            ),
          ),
      };

      return profile.collectors
        .filter((name) => runsCollector(profile, name))
        .flatMap((name) => (build[name] ? [build[name]!()] : []));
    },
    writer: createNarrativeWriter(writerConfigFromEnv()),
    keywords,
  };
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
      resolve: {
        keywords: money,
        max_competitors: profile.maxCompetitors,
        enrich_limit: profile.enrichLimit,
      },
      onProgress: (event: ProgressEvent) => console.log(dim(`  ${event.stage}: ${event.message}`)),
    },
  );

  mkdirSync(OUT_DIR, { recursive: true });
  const stem = join(OUT_DIR, result.scan.id);

  // A hook scan writes the one-pager only. The full report exists in the store either
  // way; what the profile decides is which of them is worth putting in front of anyone.
  const wrote: string[] = [];
  if (result.html && profile.variants.includes('full')) {
    writeFileSync(`${stem}.html`, result.html, 'utf8');
    wrote.push(`${stem}.html`);
  }
  if (result.onePager && profile.variants.includes('onepager')) {
    writeFileSync(`${stem}.onepager.html`, result.onePager, 'utf8');
    wrote.push(`${stem}.onepager.html`);
  }

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

  const pruned = has('no-cache') ? 0 : pruneCache(join(OUT_DIR, 'cache.json'));

  console.log(
    `\n  ${green('Done')} in ${seconds}s for ${cost}` +
      `\n    ${result.findings.length} findings across ${result.targets.length} businesses` +
      wrote.map((f) => `\n    ${f}`).join('') +
      (pruned > 0 ? dim(`\n    ${pruned} expired cache entries pruned`) : '') +
      '\n',
  );
} catch (error) {
  console.error(`\n  ${red('Scan failed')}: ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}

void DEFAULT_STORE_PATH;
