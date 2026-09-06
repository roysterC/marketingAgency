/**
 * Site technicals normalise rules — pure, no I/O.
 *
 * Two source halves, normalised independently: the crawl rules run whether or not
 * PageSpeed answered, and the vitals rules run whether or not the crawl finished. That is
 * rule 5 expressed in the normaliser rather than only in the collector.
 */

import { appliesTo, type FindingSeed, type NormaliseContext } from '../types';
import type { CrawledPage, SiteTechCapture } from './types';

/**
 * Core Web Vitals "poor" boundaries, as Google publishes them.
 *
 * Not invented thresholds: the report quotes these as Google's own, and a prospect can
 * check them. `good` sits at 2.5s / 0.1 / 200ms; anything past the numbers below is in
 * the red band rather than merely needing improvement, which is where a finding earns
 * its place in a paid report.
 */
export const LCP_POOR_SECONDS = 4.0;
export const CLS_POOR = 0.25;
export const INP_POOR_MS = 500;

/** Below this many words a page is unlikely to rank for anything on its own. */
export const THIN_CONTENT_WORDS = 300;

/** How many offending URLs to quote per finding. The report does not need all of them. */
const MAX_QUOTED = 5;

/**
 * schema.org types that satisfy the LocalBusiness requirement.
 *
 * `LocalBusiness` itself plus the subtypes our verticals actually use. A site marked up
 * with a subtype outside this list would be reported as missing schema when it is not, so
 * this list extends whenever a new vertical is taken on.
 */
export const LOCAL_BUSINESS_TYPES = new Set([
  'LocalBusiness',
  'HomeAndConstructionBusiness',
  'ProfessionalService',
  'Plumber',
  'Electrician',
  'RoofingContractor',
  'HVACBusiness',
  'Locksmith',
  'HousePainter',
  'GeneralContractor',
  'MovingCompany',
  'MedicalBusiness',
  'Dentist',
  'Physician',
  'HealthAndBeautyBusiness',
  'Store',
]);

/** schema.org types that satisfy the Product requirement. */
export const PRODUCT_TYPES = new Set(['Product', 'ProductGroup']);

const quote = (urls: string[]): string[] => urls.slice(0, MAX_QUOTED);

const hasSchema = (pages: CrawledPage[], accepted: Set<string>): boolean =>
  pages.some((p) => p.schema_types.some((t) => accepted.has(t)));

/**
 * Whether robots.txt blocks the whole site.
 *
 * Deliberately narrow: only a bare `Disallow: /` under a wildcard user-agent counts. A
 * partial disallow is normal housekeeping, and reading one as "blocked from search" would
 * be a false critical in a paid report.
 */
export function blocksEverything(robotsTxt: string | null): boolean {
  if (robotsTxt === null) return false;

  let wildcard = false;
  for (const raw of robotsTxt.split('\n')) {
    const line = raw.split('#')[0]!.trim().toLowerCase();
    if (line.startsWith('user-agent:')) {
      wildcard = line.slice('user-agent:'.length).trim() === '*';
      continue;
    }
    if (wildcard && line.startsWith('disallow:')) {
      if (line.slice('disallow:'.length).trim() === '/') return true;
    }
  }
  return false;
}

/**
 * Whether a status means the link is dead, as opposed to closed to us.
 *
 * 404 and 410 are the destination saying it is not there. 0 is no response at all. A 5xx is
 * a user-facing failure at the moment of measurement, so it counts too.
 *
 * 401, 403 and 429 do not. They mean *this crawler* was refused — bot protection, a login
 * wall, a rate limit — and the link works perfectly for the person clicking it. The live
 * scan reported a competitor's Yell listing as broken on a 403 from Yell's bot protection.
 * Calling that a broken link is the same error as ignoring robots.txt: treating "you may
 * not look" as "there is nothing there".
 *
 * This lives here rather than in the crawler because it is a rule, not a fact. The crawler
 * records the status; changing what a status means re-scores every scan already captured.
 */
export function isBrokenStatus(status: number): boolean {
  return status === 0 || status === 404 || status === 410 || (status >= 500 && status < 600);
}

/**
 * URLs a CMS generates rather than pages a business wrote.
 *
 * Author archives, tag and date listings, baskets, checkouts, feeds. They are short by
 * nature and routinely noindexed *on purpose* — noindexing `/author/admin/` or `/basket/`
 * is correct practice, not a defect.
 *
 * The live scan reported `/author/admin/` as `TECH_INDEXATION_BLOCKED` at **critical**, the
 * highest severity in the taxonomy, for a WordPress author archive doing exactly what it
 * should. It also called that page and `/category/blog/` thin content, when neither is
 * content at all.
 *
 * Deliberately conservative. Shopify `/collections/` and WooCommerce `/product-category/`
 * are real landing pages that rank and sell, so they are not here — a false negative costs
 * a finding, a false positive costs the report's credibility.
 *
 * This is computed from the URL at normalise time rather than recorded during the crawl, so
 * improving the list re-scores every scan already captured (CLAUDE.md rule 3).
 */
const CMS_MACHINERY = [
  /^\/author\//i,
  /^\/(?:category|tag|tags)\//i,
  /^\/\d{4}\/(?:\d{2}\/)?$/, // date archives: /2024/ and /2024/05/
  /^\/page\/\d+\/?$/i, // pagination
  /^\/(?:basket|cart|checkout|my-account|account|login|register)\/?$/i,
  /^\/(?:feed|rss|atom)\/?$/i,
  /^\/wp-(?:json|admin|content|includes)\//i,
  /^\/(?:search|\?s=)/i,
  /^\/comments\//i,
];

export function isCmsMachinery(url: string): boolean {
  try {
    return CMS_MACHINERY.some((p) => p.test(new URL(url).pathname));
  } catch {
    return false;
  }
}

/** Titles appearing on more than one page, with the pages that share them. */
export function duplicateTitles(pages: CrawledPage[]): Map<string, string[]> {
  const byTitle = new Map<string, string[]>();
  for (const page of pages) {
    const title = page.title?.trim();
    if (!title) continue;
    byTitle.set(title, [...(byTitle.get(title) ?? []), page.url]);
  }
  return new Map([...byTitle].filter(([, urls]) => urls.length > 1));
}

export function normaliseSiteTech(
  capture: SiteTechCapture | null,
  ctx: NormaliseContext,
): FindingSeed[] {
  // No website to inspect. That is a finding, but it belongs to the resolve stage rather
  // than here — this collector reports on a site, it does not report its absence.
  if (!capture) return [];

  const seeds: FindingSeed[] = [];
  const emit = (seed: FindingSeed): void => {
    if (appliesTo(seed.code, ctx.segment)) seeds.push(seed);
  };

  // --- crawl half ----------------------------------------------------------
  const crawl = capture.crawl;
  if (crawl) {
    const { pages, broken_links: brokenLinks } = crawl;

    // --- HTTPS -------------------------------------------------------------
    // Judged on where we landed, so an http URL that redirects to https passes.
    if (crawl.final_url.startsWith('http://')) {
      emit({
        code: 'TECH_NO_HTTPS',
        evidence: {
          requested_url: capture.url,
          final_url: crawl.final_url,
          note: 'Browsers mark the site "Not secure" in the address bar.',
        },
      });
    }

    // --- indexation --------------------------------------------------------
    // Content pages only. A noindexed basket or author archive is the CMS being configured
    // correctly, and reporting it critical trains the reader to distrust the severity.
    const content = pages.filter((p) => !isCmsMachinery(p.url));
    const noindexed = content.filter((p) => p.noindex);
    const siteWideBlock = blocksEverything(crawl.robots_txt);

    if (noindexed.length > 0 || siteWideBlock) {
      emit({
        code: 'TECH_INDEXATION_BLOCKED',
        measured_value: siteWideBlock ? pages.length : noindexed.length,
        measured_text: siteWideBlock
          ? 'robots.txt blocks the whole site'
          : `${noindexed.length} of ${content.length} content pages`,
        evidence: {
          robots_txt_blocks_all: siteWideBlock,
          noindex_pages: quote(noindexed.map((p) => p.url)),
          noindex_count: noindexed.length,
          content_pages: content.length,
          // Named so the number is checkable: excluded pages are archives and baskets that
          // are supposed to be noindexed, not pages we failed to look at.
          cms_pages_excluded: pages.length - content.length,
          pages_crawled: pages.length,
        },
      });
    }

    // --- structured data ---------------------------------------------------
    if (pages.length > 0 && !hasSchema(pages, LOCAL_BUSINESS_TYPES)) {
      emit({
        code: 'TECH_MISSING_LOCALBUSINESS_SCHEMA',
        evidence: {
          pages_checked: pages.length,
          schema_types_found: [...new Set(pages.flatMap((p) => p.schema_types))],
          accepted_types: [...LOCAL_BUSINESS_TYPES],
        },
      });
    }

    if (pages.length > 0 && !hasSchema(pages, PRODUCT_TYPES)) {
      emit({
        code: 'TECH_MISSING_PRODUCT_SCHEMA',
        evidence: {
          pages_checked: pages.length,
          schema_types_found: [...new Set(pages.flatMap((p) => p.schema_types))],
        },
      });
    }

    // --- titles ------------------------------------------------------------
    const untitled = pages.filter((p) => !p.title?.trim());
    if (untitled.length > 0) {
      emit({
        code: 'TECH_TITLE_MISSING',
        measured_value: untitled.length,
        measured_text: `${untitled.length} of ${pages.length} pages`,
        evidence: {
          missing_count: untitled.length,
          pages_crawled: pages.length,
          examples: quote(untitled.map((p) => p.url)),
        },
      });
    }

    const duplicates = duplicateTitles(pages);
    if (duplicates.size > 0) {
      const affected = [...duplicates.values()].reduce((n, urls) => n + urls.length, 0);
      emit({
        code: 'TECH_TITLE_DUPLICATE',
        measured_value: affected,
        measured_text: `${affected} pages share ${duplicates.size} title${duplicates.size === 1 ? '' : 's'}`,
        evidence: {
          affected_pages: affected,
          distinct_titles: duplicates.size,
          examples: [...duplicates].slice(0, MAX_QUOTED).map(([title, urls]) => ({ title, urls })),
        },
      });
    }

    // --- broken links ------------------------------------------------------
    // The capture holds every link that did not succeed; only the ones that are genuinely
    // gone are a finding. A 403 is a directory refusing our crawler, not a dead link.
    const dead = brokenLinks.filter((l) => isBrokenStatus(l.status));
    if (dead.length > 0) {
      emit({
        code: 'TECH_BROKEN_LINKS',
        measured_value: dead.length,
        evidence: {
          broken_count: dead.length,
          // Distinguishes "we were refused" from "it is not there", so the number is
          // checkable and the difference is visible rather than silently dropped.
          refused_not_counted: brokenLinks.length - dead.length,
          examples: dead.slice(0, MAX_QUOTED),
        },
      });
    }

    // --- sitemap -----------------------------------------------------------
    if (crawl.sitemap_urls.length === 0) {
      emit({
        code: 'TECH_NO_SITEMAP',
        evidence: {
          robots_txt_present: crawl.robots_txt !== null,
          checked: ['robots.txt', '/sitemap.xml'],
        },
      });
    }

    // --- thin content ------------------------------------------------------
    // An archive listing is short because it is a list. Only pages the business wrote are
    // judged on how much is on them.
    const thin = content.filter((p) => p.word_count < THIN_CONTENT_WORDS);
    if (thin.length > 0) {
      emit({
        code: 'TECH_THIN_CONTENT',
        measured_value: thin.length,
        measured_text: `${thin.length} of ${content.length} content pages`,
        evidence: {
          thin_count: thin.length,
          content_pages: content.length,
          cms_pages_excluded: pages.length - content.length,
          pages_crawled: pages.length,
          threshold_words: THIN_CONTENT_WORDS,
          examples: thin
            .slice(0, MAX_QUOTED)
            .map((p) => ({ url: p.url, word_count: p.word_count })),
        },
      });
    }
  }

  // --- vitals half ---------------------------------------------------------
  const vitals = capture.vitals;
  if (vitals) {
    const vitalsEvidence = {
      strategy: vitals.strategy,
      report_url: vitals.report_url,
    };

    if (vitals.mobile_friendly === false) {
      emit({
        code: 'TECH_MOBILE_UNFRIENDLY',
        evidence: {
          ...vitalsEvidence,
          note: 'Most local searches happen on a phone.',
        },
      });
    }

    if (vitals.lcp_seconds !== null && vitals.lcp_seconds > LCP_POOR_SECONDS) {
      emit({
        code: 'TECH_LCP_POOR',
        measured_value: vitals.lcp_seconds,
        measured_text: `${vitals.lcp_seconds}s to render the main content`,
        benchmark_value: LCP_POOR_SECONDS,
        benchmark_source: 'absolute',
        evidence: {
          ...vitalsEvidence,
          lcp_seconds: vitals.lcp_seconds,
          google_poor_above: LCP_POOR_SECONDS,
        },
      });
    }

    if (vitals.cls !== null && vitals.cls > CLS_POOR) {
      emit({
        code: 'TECH_CLS_POOR',
        measured_value: vitals.cls,
        benchmark_value: CLS_POOR,
        benchmark_source: 'absolute',
        evidence: {
          ...vitalsEvidence,
          cls: vitals.cls,
          google_poor_above: CLS_POOR,
          note: 'The page moves under the reader as it loads.',
        },
      });
    }

    if (vitals.inp_ms !== null && vitals.inp_ms > INP_POOR_MS) {
      emit({
        code: 'TECH_INP_POOR',
        measured_value: vitals.inp_ms,
        measured_text: `${vitals.inp_ms}ms to respond to a tap`,
        benchmark_value: INP_POOR_MS,
        benchmark_source: 'absolute',
        evidence: {
          ...vitalsEvidence,
          inp_ms: vitals.inp_ms,
          google_poor_above: INP_POOR_MS,
        },
      });
    }
  }

  return seeds;
}
