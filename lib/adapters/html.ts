/**
 * Reading a page — everything `sitetech` needs out of HTML.
 *
 * All pure functions over markup, so the rules that produce nine of the thirteen findings
 * are testable against a string rather than a live site.
 *
 * A real parser rather than regular expressions. Titles nest, attributes come in three
 * quoting styles, JSON-LD blocks contain angle brackets, and a crawler that mis-reads a
 * `<title>` produces `TECH_TITLE_MISSING` against a page that has one — a false finding in
 * a paid report, which is the failure this whole codebase is arranged to avoid.
 */

import { parse, type HTMLElement } from 'node-html-parser';

/** Elements whose text is markup, not content. */
const NON_CONTENT = ['script', 'style', 'noscript', 'template', 'svg'];

export interface PageFacts {
  title: string | null;
  word_count: number;
  schema_types: string[];
  noindex: boolean;
  /** Every href on the page, unresolved. The crawler resolves them against the page URL. */
  links: string[];
}

/** Collect `@type` values out of a JSON-LD node, including `@graph` and nested objects. */
export function collectJsonLdTypes(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdTypes(item, into);
    return;
  }
  if (node === null || typeof node !== 'object') return;

  const record = node as Record<string, unknown>;
  const type = record['@type'];
  if (typeof type === 'string') into.add(type);
  else if (Array.isArray(type)) for (const t of type) if (typeof t === 'string') into.add(t);

  for (const [key, value] of Object.entries(record)) {
    if (key === '@type') continue;
    if (typeof value === 'object' && value !== null) collectJsonLdTypes(value, into);
  }
}

/**
 * schema.org types on the page, from JSON-LD and microdata.
 *
 * A malformed JSON-LD block is skipped rather than thrown on: plenty of real sites ship
 * one, and it should cost that block rather than the whole crawl.
 */
export function schemaTypes(root: HTMLElement): string[] {
  const types = new Set<string>();

  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      collectJsonLdTypes(JSON.parse(script.rawText), types);
    } catch {
      continue;
    }
  }

  for (const element of root.querySelectorAll('[itemtype]')) {
    const itemtype = element.getAttribute('itemtype');
    if (!itemtype) continue;
    const last = itemtype.split('/').filter(Boolean).pop();
    if (last) types.add(last);
  }

  return [...types];
}

/**
 * Whether the page tells search engines not to index it.
 *
 * Reads the robots meta tag and any engine-specific variant. The `X-Robots-Tag` header
 * says the same thing from the response, and the crawler passes it in — a page noindexed
 * by header looks perfectly normal in its markup.
 */
export function isNoindex(root: HTMLElement, xRobotsTag?: string | null): boolean {
  if (xRobotsTag && /\bnoindex\b/i.test(xRobotsTag)) return true;

  for (const meta of root.querySelectorAll('meta[name]')) {
    const name = meta.getAttribute('name')?.toLowerCase() ?? '';
    if (name !== 'robots' && name !== 'googlebot') continue;
    if (/\bnoindex\b/i.test(meta.getAttribute('content') ?? '')) return true;
  }

  return false;
}

/**
 * Words of body text.
 *
 * Script and style contents are stripped first, or a page with a large inline bundle reads
 * as long-form content. This is the number behind `TECH_THIN_CONTENT`, which is the one
 * `estimated` code in the collector precisely because word count is a proxy for depth
 * rather than a measure of quality.
 */
export function wordCount(root: HTMLElement): number {
  const body = root.querySelector('body') ?? root;
  const clone = parse(body.innerHTML);

  for (const selector of NON_CONTENT) {
    for (const element of clone.querySelectorAll(selector)) element.remove();
  }

  const text = clone.textContent.replace(/\s+/g, ' ').trim();
  return text === '' ? 0 : text.split(' ').length;
}

/** The document title, trimmed. Null when absent or whitespace-only. */
export function titleOf(root: HTMLElement): string | null {
  const title = root.querySelector('title')?.textContent?.trim();
  return title ? title : null;
}

/** Every href, as written. Fragments and non-http schemes are dropped. */
export function linksOf(root: HTMLElement): string[] {
  const hrefs: string[] = [];

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) continue;
    if (href.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
    hrefs.push(href);
  }

  return hrefs;
}

export function readPage(html: string, xRobotsTag?: string | null): PageFacts {
  const root = parse(html);
  return {
    title: titleOf(root),
    word_count: wordCount(root),
    schema_types: schemaTypes(root),
    noindex: isNoindex(root, xRobotsTag),
    links: linksOf(root),
  };
}

/** Absolute URL from an href, or null when it cannot be resolved or is not http(s). */
export function resolveUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

// ------------------------------------------------ contact surfaces (read-only)

/** Names that mark a single-field form as a search box rather than a way to reach anyone. */
const SEARCH_NAMES = new Set(['s', 'q', 'query', 'search', 'keyword', 'keywords']);

/** Text and hrefs that suggest a page exists for getting in touch. */
const CONTACT_HINT = /contact|get[-\s_]?in[-\s_]?touch|enquir|inquir|quote|book/i;

const inputsOf = (form: HTMLElement): HTMLElement[] => [
  ...form.querySelectorAll('input'),
  ...form.querySelectorAll('textarea'),
  ...form.querySelectorAll('select'),
];

/**
 * Whether a form is a search box.
 *
 * Excluded before anything else, because "this site has a form" is otherwise true of
 * almost every WordPress theme ever shipped, and `STL_NO_FORM_ON_SITE` would never fire.
 */
export function looksLikeSearch(form: HTMLElement): boolean {
  if ((form.getAttribute('role') ?? '') === 'search') return true;
  if (form.querySelector('input[type="search"]')) return true;

  const fields = inputsOf(form).filter(
    (f) => (f.getAttribute('type') ?? '').toLowerCase() !== 'hidden',
  );
  if (fields.length > 1) return false;

  const name = (fields[0]?.getAttribute('name') ?? '').toLowerCase();
  return SEARCH_NAMES.has(name);
}

/**
 * Whether a form is somewhere a customer could actually write to you.
 *
 * A textarea is the strongest signal — nobody puts one on a newsletter box. Failing that,
 * an email field alongside at least one other real field. A lone email input is a mailing
 * list signup, and counting it would mean never reporting a site that has no contact form.
 */
export function isContactForm(form: HTMLElement): boolean {
  if (looksLikeSearch(form)) return false;
  if (form.querySelector('textarea')) return true;

  const fields = inputsOf(form).filter(
    (f) => !['hidden', 'submit', 'button'].includes((f.getAttribute('type') ?? '').toLowerCase()),
  );
  const hasEmail = fields.some((f) => {
    const type = (f.getAttribute('type') ?? '').toLowerCase();
    const name = `${f.getAttribute('name') ?? ''} ${f.getAttribute('id') ?? ''}`.toLowerCase();
    return type === 'email' || /e-?mail/.test(name);
  });

  return hasEmail && fields.length >= 2;
}

/** Whether the page carries a form a customer could send an enquiry through. */
export function hasContactForm(root: HTMLElement): boolean {
  return root.querySelectorAll('form').some(isContactForm);
}

/**
 * Whether the page offers a tap-to-call number.
 *
 * Anywhere on the page, not above the fold — see the note on `phone_visible_mobile`. This
 * can only under-report, which is the right direction to be wrong in.
 */
export function hasTapToCall(root: HTMLElement): boolean {
  return root
    .querySelectorAll('a[href]')
    .some((a) => /^tel:/i.test(a.getAttribute('href')?.trim() ?? ''));
}

/** Links that look like they lead to a contact page. Most sites do not put the form home. */
export function contactPageLinks(root: HTMLElement): string[] {
  const found: string[] = [];

  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href || href.startsWith('#')) continue;
    if (/^(mailto|tel|javascript|data):/i.test(href)) continue;
    if (CONTACT_HINT.test(href) || CONTACT_HINT.test(anchor.textContent ?? '')) found.push(href);
  }

  return [...new Set(found)];
}

/** Sitemap locations named in a sitemap index or a robots file. */
export function sitemapUrlsFrom(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  return [...matches].map((m) => m[1]!).filter(Boolean);
}
