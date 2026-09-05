/**
 * The `sitetech` collector.
 *
 * Owns two sources — our own crawl, and PageSpeed Insights for field vitals — which makes
 * it the first place rule 5 has to hold *inside* a collector rather than between
 * collectors. PageSpeed is rate-limited and will refuse on a busy scan; a crawl can time
 * out on a slow host. Either failing degrades this section and nothing more.
 *
 * The transport behind `SiteCrawler` is still undecided — a browser service or a small
 * always-on worker, per the spec's one real architectural constraint. That decision
 * belongs to the adapter: both options return rendered HTML, screenshots and timings, so
 * the capture shape and every rule below are the same either way.
 */

import { FREE, type Cost, type Priced } from '../../resolve/providers';
import type {
  CollectContext,
  CollectTarget,
  Collector,
  FindingSeed,
  NormaliseContext,
} from '../types';
import { normaliseSiteTech } from './normalise';
import type {
  SiteTechCapture,
  SiteTechProviders,
  VitalsStrategy,
} from './types';

/** Every code this collector may emit. Verified against the registry in tests. */
export const SITETECH_EMITS = [
  'TECH_LCP_POOR',
  'TECH_CLS_POOR',
  'TECH_INP_POOR',
  'TECH_MOBILE_UNFRIENDLY',
  'TECH_NO_HTTPS',
  'TECH_INDEXATION_BLOCKED',
  'TECH_MISSING_LOCALBUSINESS_SCHEMA',
  'TECH_MISSING_PRODUCT_SCHEMA',
  'TECH_TITLE_MISSING',
  'TECH_TITLE_DUPLICATE',
  'TECH_BROKEN_LINKS',
  'TECH_NO_SITEMAP',
  'TECH_THIN_CONTENT',
] as const;

/** Codes read off the crawl. Absent when the crawl fails; the vitals codes still run. */
export const FROM_CRAWL = [
  'TECH_NO_HTTPS',
  'TECH_INDEXATION_BLOCKED',
  'TECH_MISSING_LOCALBUSINESS_SCHEMA',
  'TECH_MISSING_PRODUCT_SCHEMA',
  'TECH_TITLE_MISSING',
  'TECH_TITLE_DUPLICATE',
  'TECH_BROKEN_LINKS',
  'TECH_NO_SITEMAP',
  'TECH_THIN_CONTENT',
] as const;

/** Codes read off PageSpeed. Absent when it fails; the crawl codes still run. */
export const FROM_VITALS = [
  'TECH_LCP_POOR',
  'TECH_CLS_POOR',
  'TECH_INP_POOR',
  'TECH_MOBILE_UNFRIENDLY',
] as const;

/**
 * Local search happens on a phone, so mobile is what the report is about.
 * Desktop is available but is not what a plumber's customers are holding.
 */
const DEFAULT_STRATEGY: VitalsStrategy = 'mobile';

interface Attempt<T> {
  value: T | null;
  cost: Cost;
  error: string | null;
}

/**
 * Run one source, surviving its failure.
 *
 * A thrown provider yields a null half and a recorded reason rather than an exception
 * that takes the whole scan down. Cost is zero on failure: a request that errored was not
 * a request we were billed for, and `scans.cost_pence` has to reflect reality.
 */
async function attempt<T>(run: () => Promise<Priced<T>>): Promise<Attempt<T>> {
  try {
    const { value, cost } = await run();
    return { value, cost, error: null };
  } catch (cause) {
    return {
      value: null,
      cost: FREE,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function createSiteTechCollector(
  providers: SiteTechProviders,
  strategy: VitalsStrategy = DEFAULT_STRATEGY,
): Collector<SiteTechCapture> {
  return {
    name: 'sitetech',
    requires_auth: false,
    segments: ['smb', 'dtc'],
    emits: SITETECH_EMITS,

    async collect(
      target: CollectTarget,
      _ctx: CollectContext,
    ): Promise<Priced<SiteTechCapture | null>> {
      const url = target.place.domain;
      // Nothing to crawl. The missing website belongs to resolve, not to this collector.
      if (!url) return { value: null, cost: FREE };

      // Both sources are started together: they are independent, and a scan fans out over
      // six targets, so waiting for the crawl before asking PageSpeed doubles the wall
      // clock for no reason.
      const [crawl, vitals] = await Promise.all([
        attempt(() => providers.crawler.crawl(url)),
        attempt(() => providers.vitals.measure(url, strategy)),
      ]);

      const errors = [
        crawl.error === null ? null : { source: 'crawl' as const, message: crawl.error },
        vitals.error === null ? null : { source: 'vitals' as const, message: vitals.error },
      ].filter((e) => e !== null);

      return {
        value: {
          url,
          crawl: crawl.value,
          vitals: vitals.value,
          source_errors: errors,
          captured_at: new Date().toISOString(),
        },
        cost: { pence: crawl.cost.pence + vitals.cost.pence },
      };
    },

    normalise(raw: SiteTechCapture | null, ctx: NormaliseContext): FindingSeed[] {
      return normaliseSiteTech(raw, ctx);
    },
  };
}

export * from './types';
export * from './normalise';
