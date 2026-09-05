/**
 * Site technicals — raw capture shape and provider interfaces.
 *
 * This is the first collector with two sources: our own crawl, and PageSpeed Insights for
 * field vitals. The spec's collector table says so, and it makes rule 5 — collectors fail
 * independently — bite one level lower than it has so far. PageSpeed is rate-limited and
 * will refuse requests on a busy scan; a crawl can time out on a slow host. Either one
 * failing must degrade the section, never lose the other half of it.
 *
 * So `crawl` and `vitals` are independently nullable, and `source_errors` records why,
 * rather than leaving a thin report looking like a healthy site.
 */

import type { Priced } from '../../resolve/providers';
import type { Timestamp } from '../shared';

export interface CrawledPage {
  url: string;
  /** HTTP status as fetched. */
  status: number;
  title: string | null;
  /**
   * Words of body text.
   *
   * A proxy for depth, not a judgement of quality — which is why `TECH_THIN_CONTENT` is
   * the only `estimated` code this collector emits.
   */
  word_count: number;
  /** schema.org `@type` values found in JSON-LD or microdata on this page. */
  schema_types: string[];
  /** True when a robots meta tag or `X-Robots-Tag` header blocks indexing. */
  noindex: boolean;
}

export interface BrokenLink {
  from: string;
  to: string;
  /** 0 when the host did not respond at all. */
  status: number;
}

export interface CrawlResult {
  /**
   * The URL we ended on after redirects.
   *
   * HTTPS is judged on this rather than the requested URL: a site that redirects http to
   * https is fine, and one that does the reverse is the finding.
   */
  final_url: string;
  pages: CrawledPage[];
  broken_links: BrokenLink[];
  /** Null when robots.txt could not be fetched at all — absent is not the same as empty. */
  robots_txt: string | null;
  /** Sitemaps discovered from robots.txt or the well-known path. */
  sitemap_urls: string[];
}

/** Which form factor the vitals were measured on. */
export type VitalsStrategy = 'mobile' | 'desktop';

export interface VitalsResult {
  strategy: VitalsStrategy;
  /** Largest Contentful Paint, seconds. Null when the URL has no field data. */
  lcp_seconds: number | null;
  /** Cumulative Layout Shift. Unitless by definition. */
  cls: number | null;
  /** Interaction to Next Paint, milliseconds. */
  inp_ms: number | null;
  mobile_friendly: boolean | null;
  /** Link to the PageSpeed run, so the finding is one click from being verified. */
  report_url: string | null;
}

export interface SourceError {
  source: 'crawl' | 'vitals';
  message: string;
}

export interface SiteTechCapture {
  /** The URL we were pointed at, before redirects. */
  url: string;
  crawl: CrawlResult | null;
  vitals: VitalsResult | null;
  /** Why a source is null, when it is. Empty when both succeeded. */
  source_errors: SourceError[];
  captured_at: Timestamp;
}

export interface SiteCrawler {
  readonly name: string;
  crawl(url: string): Promise<Priced<CrawlResult>>;
}

export interface VitalsProvider {
  readonly name: string;
  measure(url: string, strategy: VitalsStrategy): Promise<Priced<VitalsResult>>;
}

export interface SiteTechProviders {
  crawler: SiteCrawler;
  vitals: VitalsProvider;
}
