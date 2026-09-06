import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseSiteTech } from '../collectors/sitetech/normalise';
import { createSiteTechCollector } from '../collectors/sitetech/index';
import {
  CLIENT_RENDERED_WORDS,
  ClientRenderedSite,
  createPageFetcher,
  createSiteCrawler,
  looksClientRendered,
  userAgentFor,
} from './crawler';
import {
  collectJsonLdTypes,
  isNoindex,
  linksOf,
  readPage,
  resolveUrl,
  schemaTypes,
  sitemapUrlsFrom,
  titleOf,
  wordCount,
} from './html';
import { blocksUsEntirely, isAllowed, matchesPattern, parseRobots } from './robots';
import { parse } from 'node-html-parser';

const CONTACT = 'https://growthsystems.example/crawler';

// ------------------------------------------------------------------- robots

describe('reading robots.txt', () => {
  test('picks the wildcard group when no agent matches', () => {
    const rules = parseRobots('User-agent: *\nDisallow: /wp-admin/\n', 'someBot/1.0');
    assert.deepEqual(rules.disallow, ['/wp-admin/']);
  });

  test('a rule naming us wins over the wildcard', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /', '', 'User-agent: marketingagencyteardown', 'Disallow: /admin/'].join('\n'),
      'marketingAgencyTeardown/1.0 (+https://x.test)',
    );
    assert.deepEqual(rules.disallow, ['/admin/']);
    assert.equal(isAllowed('/services', rules), true);
  });

  test('consecutive user-agent lines share one group', () => {
    const rules = parseRobots(
      ['User-agent: AhrefsBot', 'User-agent: SemrushBot', 'Disallow: /', '', 'User-agent: *', 'Disallow: /tmp/'].join('\n'),
      'marketingAgencyTeardown/1.0',
    );
    // We are neither of the named agents, so the wildcard group applies.
    assert.deepEqual(rules.disallow, ['/tmp/']);
  });

  test('an empty Disallow means nothing is disallowed', () => {
    // The standard way of saying "everything is allowed". Treating it as matching every
    // path would invert the entire file.
    const rules = parseRobots('User-agent: *\nDisallow:\n', 'x');
    assert.equal(isAllowed('/anything', rules), true);
    assert.equal(blocksUsEntirely(rules), false);
  });

  test('collects sitemaps, which are global rather than per-group', () => {
    const rules = parseRobots(
      ['Sitemap: https://x.test/sitemap.xml', 'User-agent: *', 'Disallow:'].join('\n'),
      'x',
    );
    assert.deepEqual(rules.sitemaps, ['https://x.test/sitemap.xml']);
  });

  test('reads Crawl-delay in milliseconds', () => {
    const rules = parseRobots('User-agent: *\nCrawl-delay: 5\n', 'x');
    assert.equal(rules.crawlDelayMs, 5000);
  });

  test('ignores comments', () => {
    const rules = parseRobots('User-agent: * # everyone\nDisallow: /x/ # staging\n', 'x');
    assert.deepEqual(rules.disallow, ['/x/']);
  });

  test('a missing file is permissive, by convention', () => {
    const rules = parseRobots('', 'x');
    assert.equal(isAllowed('/anything', rules), true);
  });
});

describe('deciding whether we may fetch a path', () => {
  test('matches a prefix', () => {
    assert.equal(matchesPattern('/wp-admin/edit', '/wp-admin/'), true);
    assert.equal(matchesPattern('/services', '/wp-admin/'), false);
  });

  test('supports the two wildcards the standard defines', () => {
    assert.equal(matchesPattern('/a/b/private.php', '/*/private.php'), true);
    assert.equal(matchesPattern('/page.php', '/*.php$'), true);
    assert.equal(matchesPattern('/page.php?id=1', '/*.php$'), false);
  });

  test('a longer allow beats a shorter disallow', () => {
    // Google's rule. Backwards, we would skip pages a site explicitly opened up.
    const rules = parseRobots('User-agent: *\nDisallow: /docs/\nAllow: /docs/public/\n', 'x');
    assert.equal(isAllowed('/docs/private', rules), false);
    assert.equal(isAllowed('/docs/public/guide', rules), true);
  });

  test('recognises a site that shuts every crawler out', () => {
    assert.equal(blocksUsEntirely(parseRobots('User-agent: *\nDisallow: /\n', 'x')), true);
    assert.equal(blocksUsEntirely(parseRobots('User-agent: *\nDisallow: /wp-admin/\n', 'x')), false);
  });

  test('a disallow aimed at another bot does not shut us out', () => {
    const rules = parseRobots('User-agent: AhrefsBot\nDisallow: /\n', 'marketingAgencyTeardown/1.0');
    assert.equal(blocksUsEntirely(rules), false);
  });
});

// --------------------------------------------------------------------- html

const PAGE = `<!doctype html><html><head>
<title>  Emergency Plumber in Wandsworth  </title>
<meta name="robots" content="index, follow">
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"Plumber","name":"X"},{"@type":["WebSite","Thing"]}]}
</script>
<script type="application/ld+json">{ not json }</script>
</head><body>
<div itemscope itemtype="https://schema.org/BreadcrumbList"></div>
<p>We cover SW18 and the surrounding area for emergency callouts.</p>
<a href="/services">Services</a>
<a href="https://checkatrade.example/x">Checkatrade</a>
<a href="#top">Top</a>
<a href="mailto:a@b.test">Email</a>
<script>var tracking = "one two three four five six seven eight nine ten";</script>
<style>.a{color:red}</style>
</body></html>`;

describe('reading a page', () => {
  const root = parse(PAGE);

  test('trims the title', () => {
    assert.equal(titleOf(root), 'Emergency Plumber in Wandsworth');
  });

  test('a whitespace-only title is missing, which is what the finding counts', () => {
    assert.equal(titleOf(parse('<title>   </title>')), null);
    assert.equal(titleOf(parse('<html></html>')), null);
  });

  test('script and style text is not content', () => {
    // The inline script holds ten more words. A page with a large bundle would otherwise
    // read as long-form writing, and TECH_THIN_CONTENT would never fire on the sites that
    // deserve it.
    assert.equal(PAGE.includes('var tracking'), true);
    // Ten words of prose plus four of link text, which is content.
    assert.equal(wordCount(root), 14);
    assert.equal(wordCount(parse('<body><p>a b c</p><script>d e f g</script></body>')), 3);
  });

  test('collects schema types from JSON-LD, including @graph', () => {
    const types = schemaTypes(root);
    assert.ok(types.includes('Plumber'));
    assert.ok(types.includes('WebSite'));
    assert.ok(types.includes('Thing'));
  });

  test('collects microdata types too', () => {
    assert.ok(schemaTypes(root).includes('BreadcrumbList'));
  });

  test('a malformed JSON-LD block costs that block, not the crawl', () => {
    // Plenty of real sites ship one.
    assert.ok(schemaTypes(root).length >= 4);
  });

  test('finds a nested @type', () => {
    const types = new Set<string>();
    collectJsonLdTypes({ '@type': 'Organization', address: { '@type': 'PostalAddress' } }, types);
    assert.deepEqual([...types].sort(), ['Organization', 'PostalAddress']);
  });

  test('keeps real links and drops fragments, mailto and tel', () => {
    assert.deepEqual(linksOf(root), ['/services', 'https://checkatrade.example/x']);
  });

  test('reads noindex from the meta tag', () => {
    assert.equal(isNoindex(root), false);
    assert.equal(isNoindex(parse('<meta name="robots" content="noindex, nofollow">')), true);
    assert.equal(isNoindex(parse('<meta name="googlebot" content="NOINDEX">')), true);
  });

  test('reads noindex from the header, where the markup looks perfectly normal', () => {
    assert.equal(isNoindex(root, 'noindex'), true);
    assert.equal(isNoindex(root, 'nosnippet'), false);
  });

  test('resolves relative links against the page', () => {
    assert.equal(resolveUrl('/services', 'https://x.test/a/b'), 'https://x.test/services');
    assert.equal(resolveUrl('c', 'https://x.test/a/b'), 'https://x.test/a/c');
    assert.equal(resolveUrl('#top', 'https://x.test/'), 'https://x.test/');
    assert.equal(resolveUrl('ftp://x.test/f', 'https://x.test/'), null);
  });

  test('reads sitemap locations out of xml', () => {
    assert.deepEqual(
      sitemapUrlsFrom('<urlset><url><loc>https://x.test/a</loc></url><url><loc>https://x.test/b</loc></url></urlset>'),
      ['https://x.test/a', 'https://x.test/b'],
    );
  });

  test('readPage returns everything the collector needs in one pass', () => {
    const facts = readPage(PAGE);
    assert.equal(facts.title, 'Emergency Plumber in Wandsworth');
    assert.equal(facts.noindex, false);
    assert.ok(facts.schema_types.includes('Plumber'));
    assert.equal(facts.links.length, 2);
  });
});

describe('telling a JavaScript shell from a genuinely thin page', () => {
  test('an empty body with scripts is a site we cannot read', () => {
    assert.equal(looksClientRendered('<body><div id="root"></div><script src="/app.js"></script></body>', 2), true);
  });

  test('an empty body without scripts is a thin page, which is a real finding', () => {
    assert.equal(looksClientRendered('<body><p>Call us</p></body>', 2), false);
  });

  test('a page with real content is never a shell, scripts or not', () => {
    assert.equal(looksClientRendered('<script src="/a.js"></script>', CLIENT_RENDERED_WORDS + 1), false);
  });
});

// ------------------------------------------------------------------ crawling

const HOST = 'https://riversideplumbing.example';

const page = (title: string | null, body: string): string =>
  `<html><head>${title === null ? '' : `<title>${title}</title>`}</head><body>${body}</body></html>`;

const FILLER = 'We cover SW18 for emergency plumbing callouts and boiler repairs across the area. '.repeat(6);

const SITE: Record<string, { status: number; body: string; headers?: Record<string, string> }> = {
  [`${HOST}/robots.txt`]: { status: 200, body: 'User-agent: *\nDisallow: /wp-admin/\n' },
  [`${HOST}/`]: {
    status: 200,
    body: page(
      'Emergency Plumber in Wandsworth',
      `${FILLER}<a href="/services">Services</a><a href="/wp-admin/secret">Admin</a>
       <a href="/boiler-servicing">Boilers</a><a href="https://checkatrade.example/riverside">Checkatrade</a>`,
    ),
  },
  [`${HOST}/services`]: { status: 200, body: page(null, `${FILLER}<a href="/old-offer">Offer</a>`) },
  [`${HOST}/old-offer`]: {
    status: 200,
    body: page('Old offer', 'Short.'),
    headers: { 'x-robots-tag': 'noindex' },
  },
  [`${HOST}/boiler-servicing`]: { status: 404, body: 'Not found' },
  [`${HOST}/sitemap.xml`]: { status: 404, body: '' },
  'https://checkatrade.example/riverside': { status: 404, body: 'Gone' },
};

/** Serves SITE, recording every request. Anything unlisted is a 404. */
function fakeWeb() {
  const requests: Array<{ url: string; userAgent: string | undefined }> = [];

  const impl = (async (url: string, init?: RequestInit) => {
    const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    requests.push({ url: key, userAgent: headers['user-agent'] });

    const entry = SITE[key] ?? { status: 404, body: 'Not found' };
    return {
      ok: entry.status < 400,
      status: entry.status,
      url: key,
      headers: { get: (h: string) => entry.headers?.[h.toLowerCase()] ?? null },
      text: async () => entry.body,
      json: async () => ({}),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, requests };
}

async function crawl(overrides: Partial<Parameters<typeof createSiteCrawler>[0]> = {}) {
  const web = fakeWeb();
  const waits: number[] = [];
  const crawler = createSiteCrawler({
    contactUrl: CONTACT,
    delayMs: 1000,
    fetchImpl: web.impl,
    sleep: async (ms) => {
      waits.push(ms);
    },
    ...overrides,
  });
  const { value, cost } = await crawler.crawl(HOST);
  return { result: value, cost, requests: web.requests, waits };
}

describe('crawling a site', () => {
  test('finds the pages and reads each one', async () => {
    const { result } = await crawl();
    const urls = result.pages.map((p) => p.url).sort();

    assert.deepEqual(urls, [`${HOST}/`, `${HOST}/old-offer`, `${HOST}/services`]);
    assert.equal(result.pages.find((p) => p.url === `${HOST}/`)?.title, 'Emergency Plumber in Wandsworth');
    assert.equal(result.pages.find((p) => p.url === `${HOST}/services`)?.title, null);
  });

  test('reads noindex from the response header', async () => {
    const { result } = await crawl();
    assert.equal(result.pages.find((p) => p.url === `${HOST}/old-offer`)?.noindex, true);
  });

  test('records the final URL, which is what the HTTPS finding is judged on', async () => {
    const { result } = await crawl();
    assert.equal(result.final_url, `${HOST}/`);
  });

  test('finds the broken links, internal and external', async () => {
    const { result } = await crawl();
    const broken = result.broken_links.map((b) => `${b.to} ${b.status}`).sort();

    assert.deepEqual(broken, [
      'https://checkatrade.example/riverside 404',
      `${HOST}/boiler-servicing 404`,
    ]);
  });

  test('reports no sitemap when neither robots nor the well-known path has one', async () => {
    const { result } = await crawl();
    assert.deepEqual(result.sitemap_urls, []);
  });

  test('the whole thing feeds the collector', async () => {
    const { result } = await crawl();
    const codes = normaliseSiteTech(
      {
        url: HOST,
        crawl: result,
        vitals: null,
        source_errors: [],
        captured_at: '2026-09-04T12:00:00.000Z',
      },
      { now: new Date('2026-09-04T12:00:00.000Z'), role: 'subject', segment: 'smb' },
    ).map((s) => s.code);

    assert.ok(codes.includes('TECH_TITLE_MISSING'));
    assert.ok(codes.includes('TECH_BROKEN_LINKS'));
    assert.ok(codes.includes('TECH_NO_SITEMAP'));
    assert.ok(codes.includes('TECH_INDEXATION_BLOCKED'));
    assert.ok(codes.includes('TECH_MISSING_LOCALBUSINESS_SCHEMA'));
    // Served over https, so this one correctly stays quiet.
    assert.equal(codes.includes('TECH_NO_HTTPS'), false);
  });
});

describe('crawl etiquette', () => {
  test('never fetches a path robots.txt disallows', async () => {
    const { requests } = await crawl();
    assert.equal(
      requests.some((r) => r.url.includes('/wp-admin/')),
      false,
      'the crawler fetched a disallowed path',
    );
  });

  test('reads robots.txt before anything else', async () => {
    const { requests } = await crawl();
    assert.equal(requests[0]!.url, `${HOST}/robots.txt`);
  });

  test('identifies itself, with somewhere to complain to', async () => {
    const { requests } = await crawl();
    for (const request of requests) {
      assert.equal(request.userAgent, userAgentFor(CONTACT));
      assert.match(request.userAgent!, /\+https:\/\//);
    }
  });

  test('spaces requests out, so a scan is invisible in an access log', async () => {
    const { waits } = await crawl();
    assert.ok(waits.length > 0);
    assert.ok(waits.every((ms) => ms >= 1000));
  });

  test('honours a Crawl-delay longer than our own', async () => {
    const web = fakeWeb();
    const waits: number[] = [];
    const slowSite = { ...SITE };
    slowSite[`${HOST}/robots.txt`] = { status: 200, body: 'User-agent: *\nCrawl-delay: 3\n' };

    const impl = (async (url: string, init?: RequestInit) => {
      const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
      const entry = slowSite[key] ?? { status: 404, body: '' };
      void init;
      return {
        ok: entry.status < 400,
        status: entry.status,
        url: key,
        headers: { get: () => null },
        text: async () => entry.body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const crawler = createSiteCrawler({
      contactUrl: CONTACT,
      delayMs: 1000,
      fetchImpl: impl,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await crawler.crawl(HOST);
    void web;

    assert.ok(waits.every((ms) => ms >= 3000), `expected >=3000ms gaps, got ${waits.join(',')}`);
  });

  test('stops at the page limit rather than crawling the whole site', async () => {
    const { result } = await crawl({ maxPages: 1 });
    assert.equal(result.pages.length, 1);
  });

  test('caps how many links it verifies', async () => {
    const { result } = await crawl({ maxLinkChecks: 0 });
    // Internal statuses are already known from the crawl; only unvisited links need a probe.
    assert.deepEqual(result.broken_links, []);
  });
});

describe('a site that shuts every crawler out', () => {
  const blockedWeb = () =>
    (async (url: string) => {
      const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
      const body = key.endsWith('/robots.txt') ? 'User-agent: *\nDisallow: /\n' : page('Hidden', 'x');
      return {
        ok: true,
        status: 200,
        url: key,
        headers: { get: () => null },
        text: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

  test('is not crawled at all', async () => {
    const crawler = createSiteCrawler({
      contactUrl: CONTACT,
      fetchImpl: blockedWeb(),
      sleep: async () => {},
    });
    const { value } = await crawler.crawl(HOST);

    assert.deepEqual(value.pages, []);
    assert.equal(value.robots_txt, 'User-agent: *\nDisallow: /\n');
  });

  test('but the block is still reported, because it is the finding', async () => {
    const crawler = createSiteCrawler({
      contactUrl: CONTACT,
      fetchImpl: blockedWeb(),
      sleep: async () => {},
    });
    const { value } = await crawler.crawl(HOST);

    const codes = normaliseSiteTech(
      { url: HOST, crawl: value, vitals: null, source_errors: [], captured_at: 'x' },
      { now: new Date(), role: 'subject', segment: 'smb' },
    ).map((s) => s.code);

    assert.ok(codes.includes('TECH_INDEXATION_BLOCKED'));
  });
});

describe('a site this crawler cannot read', () => {
  const shellWeb = () =>
    (async (url: string) => {
      const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
      const body = key.endsWith('/robots.txt')
        ? 'User-agent: *\nDisallow:\n'
        : '<html><head></head><body><div id="root"></div><script src="/app.js"></script></body></html>';
      return {
        ok: true,
        status: 200,
        url: key,
        headers: { get: () => null },
        text: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

  test('a client-rendered homepage is refused rather than reported as empty', async () => {
    // The alternative is three false findings — no title, no content, no schema — against
    // a site that is perfectly fine.
    const crawler = createSiteCrawler({
      contactUrl: CONTACT,
      fetchImpl: shellWeb(),
      sleep: async () => {},
    });

    await assert.rejects(() => crawler.crawl(HOST), ClientRenderedSite);
  });

  test('and the collector turns that into a recorded reason, not a silent gap', async () => {
    const collector = createSiteTechCollector({
      crawler: createSiteCrawler({
        contactUrl: CONTACT,
        fetchImpl: shellWeb(),
        sleep: async () => {},
      }),
      vitals: {
        name: 'stub',
        async measure(_url, strategy) {
          return {
            value: {
              strategy,
              lcp_seconds: 6.2,
              cls: null,
              inp_ms: null,
              mobile_friendly: null,
              report_url: null,
            },
            cost: { pence: 0 },
          };
        },
      },
    });

    const { value } = await collector.collect(
      {
        target_id: 't1',
        role: 'subject',
        place: {
          place_id: 'p1',
          name: 'X',
          primary_category: null,
          lat: 0,
          lng: 0,
          domain: HOST,
          postcode: null,
          phone: null,
        },
      },
      { mode: 'cold' },
    );

    assert.equal(value?.crawl, null);
    assert.equal(value?.source_errors[0]?.source, 'crawl');
    assert.match(value!.source_errors[0]!.message, /renders client-side/);

    // The vitals half is untouched, which is rule 5 doing its job.
    const codes = collector
      .normalise(value, { now: new Date(), role: 'subject', segment: 'smb' })
      .map((s) => s.code);
    assert.deepEqual(codes, ['TECH_LCP_POOR']);
  });

  test('a thin page that is not a shell is still a real finding', async () => {
    // No script tag: the page is genuinely thin rather than unreadable.
    assert.equal(looksClientRendered('<body><p>Call us on 020</p></body>', 4), false);
  });
});

describe('a site that will not load', () => {
  test('an unreachable host yields an empty crawl rather than throwing', async () => {
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const crawler = createSiteCrawler({
      contactUrl: CONTACT,
      fetchImpl: dead,
      sleep: async () => {},
    });

    await assert.doesNotReject(() => crawler.crawl(HOST));
    const { value } = await crawler.crawl(HOST);
    assert.deepEqual(value.pages, []);
    assert.equal(value.robots_txt, null);
  });
});

// -------------------------------------------------------------- page fetcher

describe('fetching a homepage for platform detection', () => {
  const respond = (
    body: string,
    init: { status?: number; headers?: Record<string, string> } = {},
  ): typeof fetch =>
    (async () =>
      new Response(body, {
        status: init.status ?? 200,
        headers: init.headers ?? {},
      })) as unknown as typeof fetch;

  test('returns markup and lowercased headers', async () => {
    const fetcher = createPageFetcher({
      contactUrl: CONTACT,
      fetchImpl: respond('<html><body>hi</body></html>', {
        headers: { 'X-Powered-By': 'Shopify' },
      }),
    });

    const { value } = await fetcher.fetch('https://roofers.test');
    assert.ok(value);
    assert.match(value.html, /hi/);
    // detectPlatform reads headers by lowercase name; a raw Headers object would miss this.
    assert.equal(value.headers['x-powered-by'], 'Shopify');
  });

  test('identifies itself, because we are on someone else\'s server', async () => {
    let sent: Record<string, string> = {};
    const fetcher = createPageFetcher({
      contactUrl: CONTACT,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = init.headers as Record<string, string>;
        return new Response('<html></html>', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await fetcher.fetch('https://roofers.test');
    assert.equal(sent['user-agent'], userAgentFor(CONTACT));
    assert.match(sent['user-agent']!, /\+https:\/\//);
  });

  test('a bare domain is fetched over https', async () => {
    let asked = '';
    const fetcher = createPageFetcher({
      contactUrl: CONTACT,
      fetchImpl: (async (url: string) => {
        asked = url;
        return new Response('<html></html>', { status: 200 });
      }) as unknown as typeof fetch,
    });

    // Places returns domains, not URLs.
    await fetcher.fetch('roofers.test');
    assert.equal(asked, 'https://roofers.test');
  });

  test('a dead homepage is unknown, not a platform', async () => {
    const fetcher = createPageFetcher({
      contactUrl: CONTACT,
      fetchImpl: respond('not found', { status: 404 }),
    });

    // Null makes resolve warn and leave businesses.platform null. Returning the error page
    // would let detectPlatform match a signature in a hosting company's 404 template.
    const { value } = await fetcher.fetch('https://roofers.test');
    assert.equal(value, null);
  });
});

// ------------------------------------------- what the first live crawl got wrong

/**
 * Every case below was found by pointing the crawler at a real Birmingham roofer and
 * auditing the report against the site. Each produced a confident, false finding, and none
 * could have been caught by a fixture: they are all shapes the real web has and a
 * hand-written fixture does not.
 */
describe('things a real site does that a fixture does not', () => {
  interface Entry {
    status: number;
    body: string;
    headers?: Record<string, string>;
    /** Where the request landed, when it is not where it was sent. */
    finalUrl?: string;
  }

  async function crawlSite(site: Record<string, Entry>, overrides = {}) {
    const asked: string[] = [];
    const impl = (async (url: string) => {
      const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
      asked.push(key);
      const entry = site[key] ?? { status: 404, body: 'Not found' };
      return {
        ok: entry.status < 400,
        status: entry.status,
        url: entry.finalUrl ?? key,
        headers: { get: (h: string) => entry.headers?.[h.toLowerCase()] ?? null },
        text: async () => entry.body,
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const crawler = createSiteCrawler({
      contactUrl: CONTACT,
      fetchImpl: impl,
      sleep: async () => {},
      ...overrides,
    });
    const { value } = await crawler.crawl(HOST);
    return { result: value, asked };
  }

  const ROBOTS = { status: 200, body: 'User-agent: *\nAllow: /\n' };

  test('an image in an uploads folder is not a page with a missing title', async () => {
    const { result, asked } = await crawlSite({
      [`${HOST}/robots.txt`]: ROBOTS,
      [`${HOST}/`]: {
        status: 200,
        body: page(
          'Roofers in Birmingham',
          `${FILLER}<a href="/wp-content/uploads/2022/11/WhatsApp-Image.jpeg">Photo</a>`,
        ),
      },
      [`${HOST}/wp-content/uploads/2022/11/WhatsApp-Image.jpeg`]: {
        status: 200,
        body: '\xff\xd8\xff\xe0JFIF binary',
        headers: { 'content-type': 'image/jpeg' },
      },
    });

    // The live report said "2 of 25 pages have no title tag at all". Both were photographs.
    assert.deepEqual(
      result.pages.filter((p) => p.title === null),
      [],
    );
    assert.equal(result.pages.length, 1);
    assert.ok(!result.pages.some((p) => p.url.endsWith('.jpeg')));
    // It is still link-checked — a 404 image is a real problem — so the request is made.
    // What changed is that a 200 image is no longer a titleless page.
    assert.ok(asked.some((u) => u.endsWith('.jpeg')));
    assert.deepEqual(result.broken_links, []);
  });

  test('a non-HTML response is not read as a page even without a telltale extension', async () => {
    const { result } = await crawlSite({
      [`${HOST}/robots.txt`]: ROBOTS,
      [`${HOST}/`]: {
        status: 200,
        body: page('Roofers in Birmingham', `${FILLER}<a href="/brochure">Brochure</a>`),
      },
      [`${HOST}/brochure`]: {
        status: 200,
        body: '%PDF-1.4 binary',
        headers: { 'content-type': 'application/pdf' },
      },
    });

    assert.deepEqual(result.pages.map((p) => p.url), [`${HOST}/`]);
    // A 200 PDF is a working link. It is only not a page.
    assert.deepEqual(result.broken_links, []);
  });

  test('two URLs that redirect to one page are one page, not a duplicate title', async () => {
    const { result } = await crawlSite({
      [`${HOST}/robots.txt`]: ROBOTS,
      [`${HOST}/`]: {
        status: 200,
        body: page(
          'Roofers in Birmingham',
          `${FILLER}<a href="/about-us">About</a><a href="/about-us/">About again</a>`,
        ),
      },
      [`${HOST}/about-us`]: {
        status: 200,
        body: page('About Windsor Roofing', FILLER),
        finalUrl: `${HOST}/about-us/`,
      },
      [`${HOST}/about-us/`]: { status: 200, body: page('About Windsor Roofing', FILLER) },
    });

    // The live crawl fetched four URLs twice and then reported each title as duplicating
    // itself. `seen` tracked what was requested; pages recorded where it landed.
    const abouts = result.pages.filter((p) => p.url === `${HOST}/about-us/`);
    assert.equal(abouts.length, 1);
    assert.equal(result.pages.length, 2);
  });

  test('one dead URL linked from every page is one broken link, not one per page', async () => {
    const dead = `${HOST}/quote-form`;
    const linkTo = `${FILLER}<a href="/quote-form">Get a quote</a>`;
    const { result } = await crawlSite({
      [`${HOST}/robots.txt`]: ROBOTS,
      [`${HOST}/`]: {
        status: 200,
        body: page('Home', `${linkTo}<a href="/services">Services</a><a href="/contact">Contact</a>`),
      },
      [`${HOST}/services`]: { status: 200, body: page('Services', linkTo) },
      [`${HOST}/contact`]: { status: 200, body: page('Contact', linkTo) },
      [dead]: { status: 404, body: 'Not found' },
    });

    assert.equal(result.broken_links.length, 1);
    assert.equal(result.broken_links[0]!.to, dead);
    // The information is kept rather than dropped: one dead link, on three pages.
    assert.equal(result.broken_links[0]!.occurrences, 3);
  });

  test("Cloudflare's email obfuscation is never checked and never reported", async () => {
    const { result, asked } = await crawlSite({
      [`${HOST}/robots.txt`]: ROBOTS,
      [`${HOST}/`]: {
        status: 200,
        body: page(
          'Roofers in Birmingham',
          `${FILLER}<a href="/cdn-cgi/l/email-protection#abc">Email us</a>`,
        ),
      },
    });

    // It answers 404 to everything that is not a browser, where it decodes to a mailto.
    // The live report called this sixteen broken links.
    assert.deepEqual(result.broken_links, []);
    assert.ok(!asked.some((u) => u.includes('cdn-cgi')));
  });
});

describe('the crawler records what happened and judges nothing', () => {
  test('a refused link and a dead link are both recorded, with their status', async () => {
    const impl = (async (url: string) => {
      const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
      if (key.includes('yell.example')) {
        return { ok: false, status: 403, url: key, headers: { get: () => null }, text: async () => 'Forbidden' } as unknown as Response;
      }
      if (key.includes('gone.example')) {
        return { ok: false, status: 404, url: key, headers: { get: () => null }, text: async () => 'Not found' } as unknown as Response;
      }
      const body = key.endsWith('/robots.txt')
        ? ['User-agent: *', 'Allow: /', ''].join('\n')
        : page('Roofers', `${FILLER}<a href="https://yell.example/biz/x">Yell</a><a href="https://gone.example/x">Dead</a>`);
      return { ok: true, status: 200, url: key, headers: { get: () => null }, text: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;

    const crawler = createSiteCrawler({ contactUrl: CONTACT, fetchImpl: impl, sleep: async () => {} });
    const { value } = await crawler.crawl(HOST);

    // Both are kept with their status. Which of them is a *finding* is normalise's call,
    // so changing that rule re-scores scans already on disk rather than needing a re-crawl.
    assert.deepEqual(
      value.broken_links.map((b) => [b.to, b.status]).sort(),
      [['https://gone.example/x', 404], ['https://yell.example/biz/x', 403]],
    );
  });
});
