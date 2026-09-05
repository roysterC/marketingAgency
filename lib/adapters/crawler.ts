/**
 * The site crawler — `SiteCrawler` over plain HTTP.
 *
 * **Why this exists without the Playwright decision.** Spec §7 listed the browser-service
 * question as a blocker on `sitetech`. Working through the thirteen codes, it turns out not
 * to be: titles, duplicate titles, schema, indexation, broken links, thin content, sitemap
 * and HTTPS are all read out of markup, not out of a rendered page. Nine of the thirteen
 * land here. A browser is needed for two things — screenshots, and sites that render
 * client-side — and that is a smaller decision than "how do we deploy the crawler".
 *
 * The limitation is real and worth stating: a site that ships an empty `<body>` and paints
 * itself with JavaScript will read as having no title and no content. That is a false
 * finding, and the guard against it is `looksClientRendered`, which flags the shape rather
 * than reporting a site that is fine as broken.
 *
 * **Crawl etiquette is not optional here.** `docs/data-sources.md` lists four rules and all
 * four are implemented rather than intended: robots.txt is respected, the user agent
 * identifies us and carries a contact URL, requests to a host are spaced out, and nothing
 * behind auth is touched. These sites belong to businesses who never asked to be audited.
 */

import type { Cost, Priced } from '../resolve/providers';
import type {
  BrokenLink,
  CrawlResult,
  CrawledPage,
  SiteCrawler,
} from '../collectors/sitetech/types';
import { readPage, resolveUrl, sitemapUrlsFrom } from './html';
import { requestText, type TextResponse } from './http';
import {
  PERMISSIVE,
  blocksUsEntirely,
  isAllowed,
  parseRobots,
  type RobotsRules,
} from './robots';

export interface CrawlerConfig {
  /**
   * A page a site owner can visit to find out who just crawled them.
   *
   * Required, not defaulted. "Identifiable user agent with a contact URL" is one of the
   * four etiquette rules, and a default would let it be forgotten.
   */
  contactUrl: string;
  /** A teardown does not need the whole site. */
  maxPages?: number;
  /** Minimum gap between requests to the host. Raised if robots.txt asks for more. */
  delayMs?: number;
  /** Checking every link on every page is a second crawl. */
  maxLinkChecks?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  costPerCrawl?: Cost;
}

export const DEFAULT_MAX_PAGES = 25;
/** Slow enough to be invisible in an access log. */
export const DEFAULT_DELAY_MS = 1_000;
export const DEFAULT_MAX_LINK_CHECKS = 40;

/** Worker seconds, amortised. Not a per-call fee, but not free either. */
const DEFAULT_COST: Cost = { pence: 1 };

/**
 * Below this many words with a script-heavy page, the markup is probably a shell.
 *
 * Not a finding — a signal that this crawler is the wrong tool for this site, and that the
 * numbers it produced should not be believed.
 */
export const CLIENT_RENDERED_WORDS = 40;

export const userAgentFor = (contactUrl: string): string =>
  `marketingAgencyTeardown/1.0 (+${contactUrl})`;

const originOf = (url: string): string => new URL(url).origin;
const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

/**
 * Whether a page looks like a JavaScript shell rather than a thin page.
 *
 * A near-empty body with scripts in it is a site this crawler cannot read; a near-empty
 * body without them is a page that is genuinely thin. Telling them apart is the difference
 * between a real `TECH_THIN_CONTENT` and a fabricated one.
 */
export function looksClientRendered(html: string, words: number): boolean {
  if (words > CLIENT_RENDERED_WORDS) return false;
  return /<script[\s>]/i.test(html);
}

/**
 * Raised when the homepage is a shell this crawler cannot read.
 *
 * Thrown rather than returned, so the collector's existing rule-5 handling catches it and
 * records the reason in `source_errors`. The section goes missing and says why, which is
 * the honest outcome — the alternative is reporting a perfectly good site as having no
 * title, no content and no structured data, which is three false findings in a paid report.
 *
 * This is the case a browser is actually needed for.
 */
export class ClientRenderedSite extends Error {
  constructor(url: string) {
    super(
      `${url} renders client-side: its markup carries no readable content. ` +
        `This needs a browser rather than a fetch — see docs/teardown-engine.md §7.`,
    );
    this.name = 'ClientRenderedSite';
  }
}

interface Fetched {
  url: string;
  response: TextResponse;
}

export function createSiteCrawler(config: CrawlerConfig): SiteCrawler {
  const {
    contactUrl,
    maxPages = DEFAULT_MAX_PAGES,
    delayMs = DEFAULT_DELAY_MS,
    maxLinkChecks = DEFAULT_MAX_LINK_CHECKS,
    timeoutMs = 15_000,
    fetchImpl,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    costPerCrawl = DEFAULT_COST,
  } = config;

  const headers = { 'user-agent': userAgentFor(contactUrl) };
  const options = {
    headers,
    timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  return {
    name: 'fetch-crawler',

    async crawl(target): Promise<Priced<CrawlResult>> {
      const start = target.startsWith('http') ? target : `https://${target}`;
      const origin = originOf(start);

      // --- robots first, always -------------------------------------------
      let robotsTxt: string | null = null;
      let rules: RobotsRules = PERMISSIVE;
      let resolvedOrigin = origin;

      try {
        const robots = await requestText(`${origin}/robots.txt`, options);
        if (robots.status === 200) {
          robotsTxt = robots.text;
          rules = parseRobots(robots.text, userAgentFor(contactUrl));
        }
        // Even a 404 tells us the scheme the host actually serves, which is what the
        // HTTPS finding is judged on.
        resolvedOrigin = originOf(robots.finalUrl);
      } catch {
        // An unreachable robots.txt is permissive by convention. It is not a finding.
      }

      const gap = Math.max(delayMs, rules.crawlDelayMs ?? 0);
      const sitemaps = [...rules.sitemaps];

      // --- shut out entirely ----------------------------------------------
      // Nothing is fetched. The site telling every crawler to go away is itself the
      // finding — `blocksEverything` in the normaliser reads the same file and reports it.
      if (blocksUsEntirely(rules)) {
        return {
          value: {
            final_url: `${resolvedOrigin}/`,
            pages: [],
            broken_links: [],
            robots_txt: robotsTxt,
            sitemap_urls: sitemaps,
          },
          cost: costPerCrawl,
        };
      }

      // --- walk the site ---------------------------------------------------
      const queue: string[] = [start];
      const seen = new Set<string>();
      const pages: CrawledPage[] = [];
      const outbound: Array<{ from: string; to: string }> = [];
      const statuses = new Map<string, number>();
      let finalUrl = start;
      let first = true;
      // Set from the very first response, not the first *successful* one: a homepage that
      // 404s still tells us the scheme the host settled on, which is what HTTPS is judged on.
      let resolvedFinalUrl = false;

      while (queue.length > 0 && pages.length < maxPages) {
        const url = queue.shift()!;
        if (seen.has(url)) continue;
        seen.add(url);
        if (!isAllowed(pathOf(url), rules)) continue;

        if (!first) await sleep(gap);
        first = false;

        let fetched: Fetched;
        try {
          fetched = { url, response: await requestText(url, options) };
        } catch {
          // A page that will not load is a dead page, and a dead page is the finding.
          statuses.set(url, 0);
          continue;
        }

        const { response } = fetched;
        statuses.set(url, response.status);
        if (!resolvedFinalUrl) {
          finalUrl = response.finalUrl;
          resolvedFinalUrl = true;
        }

        if (response.status >= 400) continue;

        const facts = readPage(response.text, response.headers.get('x-robots-tag'));

        // Judged on the homepage only. One thin page deep in a site is a finding; a
        // homepage with nothing in it is a tool mismatch.
        if (pages.length === 0 && looksClientRendered(response.text, facts.word_count)) {
          throw new ClientRenderedSite(response.finalUrl);
        }

        pages.push({
          url: response.finalUrl,
          status: response.status,
          title: facts.title,
          word_count: facts.word_count,
          schema_types: facts.schema_types,
          noindex: facts.noindex,
        });

        for (const href of facts.links) {
          const resolved = resolveUrl(href, response.finalUrl);
          if (!resolved) continue;
          outbound.push({ from: response.finalUrl, to: resolved });
          if (originOf(resolved) === resolvedOrigin && !seen.has(resolved)) queue.push(resolved);
        }
      }

      // --- check the links -------------------------------------------------
      const broken: BrokenLink[] = [];
      const checked = new Set<string>(statuses.keys());
      let checks = 0;

      for (const link of outbound) {
        if (checks >= maxLinkChecks) break;

        const known = statuses.get(link.to);
        if (known !== undefined) {
          if (known >= 400 || known === 0) broken.push({ ...link, status: known });
          continue;
        }
        if (checked.has(link.to)) continue;

        // Robots governs every fetch, not only the ones that walk the site. A disallowed
        // path stays unchecked — and therefore unreported, because claiming a link is
        // broken without having verified it would be a fabricated finding.
        if (originOf(link.to) === resolvedOrigin && !isAllowed(pathOf(link.to), rules)) {
          checked.add(link.to);
          continue;
        }

        checked.add(link.to);
        checks += 1;

        await sleep(gap);
        try {
          const probe = await requestText(link.to, { ...options, method: 'GET' });
          statuses.set(link.to, probe.status);
          if (probe.status >= 400) broken.push({ ...link, status: probe.status });
        } catch {
          // The type documents 0 as "the host did not respond at all".
          statuses.set(link.to, 0);
          broken.push({ ...link, status: 0 });
        }
      }

      // --- sitemap ---------------------------------------------------------
      // robots.txt is the canonical place to declare one. The well-known path is only
      // probed when it does not, so a site that declares its sitemap costs one fetch fewer.
      if (sitemaps.length === 0) {
        try {
          await sleep(gap);
          const probe = await requestText(`${resolvedOrigin}/sitemap.xml`, options);
          if (probe.status === 200 && /<(urlset|sitemapindex)/i.test(probe.text)) {
            sitemaps.push(probe.finalUrl);
          }
        } catch {
          // No sitemap is a finding, not an error.
        }
      }

      return {
        value: {
          final_url: finalUrl,
          pages,
          broken_links: broken,
          robots_txt: robotsTxt,
          sitemap_urls: sitemaps,
        },
        cost: costPerCrawl,
      };
    },
  };
}

export { sitemapUrlsFrom };
