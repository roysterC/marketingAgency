/**
 * Site technicals fixtures — a well-built site and a neglected one, plus the failure
 * modes that matter.
 *
 * Both sources have a provider that throws, because "one dead source degrades a report,
 * it never kills a scan" is a claim worth a test rather than a comment.
 *
 * Domains match `../gbp/fixtures.ts` so a scan can be assembled across collectors.
 */

import { FREE, type Priced } from '../../resolve/providers';
import type {
  CrawlResult,
  CrawledPage,
  SiteCrawler,
  SiteTechProviders,
  VitalsProvider,
  VitalsResult,
  VitalsStrategy,
} from './types';

/**
 * Worker seconds, amortised.
 *
 * The crawl has no per-call fee — it is our own infrastructure — but it is not free
 * either, and `collector_runs.cost_pence` is supposed to reflect reality rather than
 * only the invoices. PageSpeed genuinely is free.
 */
const CRAWL_COST = { pence: 1 };

const page = (over: Partial<CrawledPage> & Pick<CrawledPage, 'url'>): CrawledPage => ({
  status: 200,
  title: 'Untitled',
  word_count: 800,
  schema_types: [],
  noindex: false,
  ...over,
});

/** Built properly: HTTPS, marked up, unique titles, a sitemap, nothing broken. */
export const HEALTHY_CRAWL: CrawlResult = {
  final_url: 'https://wandsworthplumbers.example/',
  pages: [
    page({
      url: 'https://wandsworthplumbers.example/',
      title: 'Emergency Plumber in Wandsworth | Wandsworth Plumbers',
      word_count: 1240,
      schema_types: ['Plumber', 'WebSite'],
    }),
    page({
      url: 'https://wandsworthplumbers.example/services',
      title: 'Boiler Repair, Leaks and Bathrooms | Wandsworth Plumbers',
      word_count: 980,
    }),
    page({
      url: 'https://wandsworthplumbers.example/areas/sw18',
      title: 'Plumbers in SW18 | Wandsworth Plumbers',
      word_count: 720,
    }),
    page({
      url: 'https://wandsworthplumbers.example/reviews',
      title: 'Customer Reviews | Wandsworth Plumbers',
      word_count: 640,
    }),
    page({
      url: 'https://wandsworthplumbers.example/contact',
      title: 'Contact Us | Wandsworth Plumbers',
      word_count: 410,
    }),
  ],
  broken_links: [],
  robots_txt: 'User-agent: *\nAllow: /\nSitemap: https://wandsworthplumbers.example/sitemap.xml\n',
  sitemap_urls: ['https://wandsworthplumbers.example/sitemap.xml'],
};

export const HEALTHY_VITALS: VitalsResult = {
  strategy: 'mobile',
  lcp_seconds: 2.1,
  cls: 0.04,
  inp_ms: 150,
  mobile_friendly: true,
  report_url: 'https://pagespeed.web.dev/report?url=wandsworthplumbers.example',
};

/**
 * The subject: served over plain http, half the pages untitled, two sharing a title,
 * nothing marked up, no sitemap, three dead links, and an abandoned offer page left
 * noindexed.
 */
export const NEGLECTED_CRAWL: CrawlResult = {
  final_url: 'http://riversideplumbing.example/',
  pages: [
    page({ url: 'http://riversideplumbing.example/', title: 'Home', word_count: 180 }),
    page({ url: 'http://riversideplumbing.example/services', title: null, word_count: 420 }),
    page({ url: 'http://riversideplumbing.example/about', title: '   ', word_count: 90 }),
    page({
      url: 'http://riversideplumbing.example/contact',
      title: 'Riverside Plumbing',
      word_count: 60,
    }),
    page({
      url: 'http://riversideplumbing.example/areas/wandsworth',
      title: 'Riverside Plumbing',
      word_count: 310,
    }),
    page({
      url: 'http://riversideplumbing.example/old-offer',
      title: 'Old offer',
      word_count: 150,
      noindex: true,
    }),
  ],
  broken_links: [
    {
      from: 'http://riversideplumbing.example/',
      to: 'http://riversideplumbing.example/boiler-servicing',
      status: 404,
    },
    {
      from: 'http://riversideplumbing.example/services',
      to: 'http://checkatrade.example/riverside',
      status: 404,
    },
    {
      from: 'http://riversideplumbing.example/contact',
      to: 'http://riversideplumbing.example/quote-form',
      status: 500,
    },
  ],
  // A partial disallow is ordinary housekeeping, and must not read as "blocked from
  // search". No Sitemap line, and no /sitemap.xml either.
  robots_txt: 'User-agent: *\nDisallow: /wp-admin/\n',
  sitemap_urls: [],
};

export const NEGLECTED_VITALS: VitalsResult = {
  strategy: 'mobile',
  lcp_seconds: 6.2,
  cls: 0.41,
  inp_ms: 720,
  mobile_friendly: false,
  report_url: 'https://pagespeed.web.dev/report?url=riversideplumbing.example',
};

/** A site that has accidentally told every search engine to go away. */
export const BLOCKED_CRAWL: CrawlResult = {
  ...HEALTHY_CRAWL,
  robots_txt: 'User-agent: *\nDisallow: /\n',
};

const CRAWLS: Record<string, CrawlResult> = {
  'wandsworthplumbers.example': HEALTHY_CRAWL,
  'riversideplumbing.example': NEGLECTED_CRAWL,
};

const VITALS: Record<string, VitalsResult> = {
  'wandsworthplumbers.example': HEALTHY_VITALS,
  'riversideplumbing.example': NEGLECTED_VITALS,
};

/** Domain out of a bare hostname or a full URL, so fixtures can be keyed either way. */
const hostOf = (url: string): string =>
  url.replace(/^https?:\/\//, '').split('/')[0]!.toLowerCase();

export const fixtureCrawler: SiteCrawler = {
  name: 'fixture-crawler',
  async crawl(url): Promise<Priced<CrawlResult>> {
    const result = CRAWLS[hostOf(url)];
    if (!result) throw new Error(`no fixture crawl for ${url}`);
    return { value: result, cost: CRAWL_COST };
  },
};

export const fixtureVitals: VitalsProvider = {
  name: 'fixture-psi',
  async measure(url, strategy: VitalsStrategy): Promise<Priced<VitalsResult>> {
    const result = VITALS[hostOf(url)];
    if (!result) throw new Error(`no fixture vitals for ${url}`);
    return { value: { ...result, strategy }, cost: FREE };
  },
};

/** A Playwright worker that gave up on a slow host. */
export const failingCrawler: SiteCrawler = {
  name: 'fixture-crawler-timeout',
  async crawl(): Promise<Priced<CrawlResult>> {
    throw new Error('crawl worker timed out after 30s');
  },
};

/** PageSpeed refusing on a busy scan — the ordinary case, not an exotic one. */
export const failingVitals: VitalsProvider = {
  name: 'fixture-psi-quota',
  async measure(): Promise<Priced<VitalsResult>> {
    throw new Error('PageSpeed Insights quota exceeded');
  },
};

export const fixtureSiteTechProviders: SiteTechProviders = {
  crawler: fixtureCrawler,
  vitals: fixtureVitals,
};

export const crawlOnlyProviders: SiteTechProviders = {
  crawler: fixtureCrawler,
  vitals: failingVitals,
};

export const vitalsOnlyProviders: SiteTechProviders = {
  crawler: failingCrawler,
  vitals: fixtureVitals,
};

export const bothFailingProviders: SiteTechProviders = {
  crawler: failingCrawler,
  vitals: failingVitals,
};
