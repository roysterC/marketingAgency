import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normaliseSiteTech } from '../collectors/sitetech/normalise';
import { createSiteTechCollector } from '../collectors/sitetech/index';
import {
  CLIENT_RENDERED_WORDS,
  ClientRenderedSite,
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
