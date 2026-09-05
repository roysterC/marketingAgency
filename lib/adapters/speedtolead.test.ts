import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'node-html-parser';

import { createSpeedToLeadCollector } from '../collectors/speedtolead/index';
import { GENUINE_ENQUIRY } from '../collectors/speedtolead/fixtures';
import { normaliseSpeedToLead } from '../collectors/speedtolead/normalise';
import { SendingIsDeferred, createReadOnlyProbe } from './speedtolead';
import { contactPageLinks, hasContactForm, hasTapToCall, isContactForm, looksLikeSearch } from './html';
import { userAgentFor } from './crawler';

const CONTACT = 'https://growthsystems.example/crawler';
const HOST = 'https://riversideplumbing.example';

const form = (inner: string, attrs = ''): string => `<form ${attrs}>${inner}</form>`;

// ------------------------------------------------------- detecting a form

describe('telling a contact form from everything else on a page', () => {
  test('a textarea is the strongest signal — nobody puts one on a newsletter box', () => {
    assert.equal(isContactForm(parse(form('<input name="name"><textarea name="msg"></textarea>')).querySelector('form')!), true);
  });

  test('an email field plus another real field counts', () => {
    assert.equal(
      isContactForm(parse(form('<input type="email" name="email"><input name="name">')).querySelector('form')!),
      true,
    );
  });

  test('a lone email input is a mailing list, not a way to reach anyone', () => {
    // Counting it would mean STL_NO_FORM_ON_SITE never fires on a site that has no
    // contact form but does have a newsletter box, which is most of them.
    assert.equal(
      isContactForm(parse(form('<input type="email" name="email"><button>Subscribe</button>')).querySelector('form')!),
      false,
    );
  });

  test('a search box is not a contact form', () => {
    // Otherwise "this site has a form" is true of every WordPress theme ever shipped.
    const search = parse(form('<input type="search" name="s">')).querySelector('form')!;
    assert.equal(looksLikeSearch(search), true);
    assert.equal(isContactForm(search), false);
  });

  test('recognises a search box by its field name and by role', () => {
    assert.equal(looksLikeSearch(parse(form('<input name="q">')).querySelector('form')!), true);
    assert.equal(
      looksLikeSearch(parse(form('<input name="anything">', 'role="search"')).querySelector('form')!),
      true,
    );
  });

  test('a multi-field form is not mistaken for a search box', () => {
    assert.equal(
      looksLikeSearch(parse(form('<input name="q"><textarea name="m"></textarea>')).querySelector('form')!),
      false,
    );
  });

  test('finds a contact form anywhere on the page', () => {
    const page = `<body>${form('<input type="search" name="s">')}${form('<textarea name="m"></textarea>')}</body>`;
    assert.equal(hasContactForm(parse(page)), true);
  });

  test('a page with only a search box has no contact form', () => {
    assert.equal(hasContactForm(parse(`<body>${form('<input type="search" name="s">')}</body>`)), false);
  });
});

describe('detecting a tap-to-call number', () => {
  test('finds a tel: link', () => {
    assert.equal(hasTapToCall(parse('<a href="tel:+442080002222">Call us</a>')), true);
    assert.equal(hasTapToCall(parse('<a href="TEL:02080002222">Call</a>')), true);
  });

  test('a printed number that is not a link is not tappable', () => {
    assert.equal(hasTapToCall(parse('<p>Call us on 020 8000 2222</p>')), false);
  });

  test('a mailto is not a phone number', () => {
    assert.equal(hasTapToCall(parse('<a href="mailto:a@b.test">Email</a>')), false);
  });
});

describe('finding the contact page', () => {
  test('spots the usual names, by href and by link text', () => {
    const links = contactPageLinks(
      parse(`<a href="/contact-us">Reach us</a><a href="/x">Get in touch</a><a href="/blog">Blog</a>`),
    );
    assert.deepEqual(links, ['/contact-us', '/x']);
  });

  test('ignores tel and mailto, which are not pages', () => {
    assert.deepEqual(contactPageLinks(parse('<a href="tel:123">Contact</a>')), []);
  });
});

// -------------------------------------------------------------- the probe

type Page = { status: number; body: string };

function fakeSite(pages: Record<string, Page>) {
  const requests: string[] = [];
  const userAgents: (string | undefined)[] = [];

  const impl = (async (url: string, init?: RequestInit) => {
    const key = url.replace(/\/$/, '') === HOST ? `${HOST}/` : url;
    requests.push(key);
    userAgents.push((init?.headers as Record<string, string> | undefined)?.['user-agent']);

    const entry = pages[key] ?? { status: 404, body: 'Not found' };
    return {
      ok: entry.status < 400,
      status: entry.status,
      url: key,
      headers: { get: () => null },
      text: async () => entry.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return { impl, requests, userAgents };
}

const ROBOTS_OPEN: Page = { status: 200, body: 'User-agent: *\nDisallow:\n' };

const probeFor = (pages: Record<string, Page>) => {
  const site = fakeSite(pages);
  const probe = createReadOnlyProbe({
    contactUrl: CONTACT,
    fetchImpl: site.impl,
    sleep: async () => {},
  });
  return { probe, site };
};

describe('inspecting a site without contacting it', () => {
  test('finds a contact form on the homepage', async () => {
    const { probe } = probeFor({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: {
        status: 200,
        body: `<body><a href="tel:+442080002222">Call</a>${form('<input name="name"><textarea name="m"></textarea>')}</body>`,
      },
    });

    const { value } = await probe.inspect(HOST);
    assert.equal(value.form_url, `${HOST}/`);
    assert.equal(value.phone_visible_mobile, true);
  });

  test('follows through to a contact page when the homepage has none', async () => {
    const { probe, site } = probeFor({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: { status: 200, body: '<body><a href="/contact">Contact us</a></body>' },
      [`${HOST}/contact`]: {
        status: 200,
        body: `<body>${form('<input name="name"><textarea name="m"></textarea>')}</body>`,
      },
    });

    const { value } = await probe.inspect(HOST);
    assert.equal(value.form_url, `${HOST}/contact`);
    // The homepage was fetched once, not twice — its links were kept from that response.
    assert.equal(site.requests.filter((r) => r === `${HOST}/`).length, 1);
  });

  test('reports no form when there genuinely is not one', async () => {
    const { probe } = probeFor({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: { status: 200, body: '<body><p>Call us on 020 8000 2222</p></body>' },
    });

    const { value } = await probe.inspect(HOST);
    assert.equal(value.form_url, null);
    assert.equal(value.phone_visible_mobile, false);
  });

  test('a tap-to-call link on the contact page counts too', async () => {
    const { probe } = probeFor({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: { status: 200, body: '<body><a href="/contact">Contact</a></body>' },
      [`${HOST}/contact`]: { status: 200, body: '<body><a href="tel:123">Call</a></body>' },
    });

    const { value } = await probe.inspect(HOST);
    assert.equal(value.form_url, null);
    assert.equal(value.phone_visible_mobile, true);
  });

  test('an unreachable site produces nothing rather than a finding about our network', async () => {
    const dead = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const probe = createReadOnlyProbe({ contactUrl: CONTACT, fetchImpl: dead, sleep: async () => {} });
    const { value } = await probe.inspect(HOST);
    assert.equal(value.form_url, null);
    // Reporting "no phone number" because the server timed out would be a fabricated finding.
    assert.equal(value.form_status, null);
  });

  test('identifies itself and respects robots.txt, same as the crawler', async () => {
    const { probe, site } = probeFor({
      [`${HOST}/robots.txt`]: { status: 200, body: 'User-agent: *\nDisallow: /contact\n' },
      [`${HOST}/`]: { status: 200, body: '<body><a href="/contact">Contact</a></body>' },
      [`${HOST}/contact`]: { status: 200, body: `<body>${form('<textarea name="m"></textarea>')}</body>` },
    });

    await probe.inspect(HOST);

    assert.equal(site.requests.includes(`${HOST}/contact`), false, 'fetched a disallowed path');
    assert.equal(site.requests[0], `${HOST}/robots.txt`);
    for (const agent of site.userAgents) assert.equal(agent, userAgentFor(CONTACT));
  });
});

// ------------------------------------------------------- it contacts nobody

describe('the probe cannot send', () => {
  test('never claims a form works, which is what gates submission', async () => {
    const { probe } = probeFor({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: { status: 200, body: `<body>${form('<textarea name="m"></textarea>')}</body>` },
    });

    const { value } = await probe.inspect(HOST);
    assert.equal(value.form_url, `${HOST}/`);
    // Not `ok`. Whether it works cannot be known without sending, and the collector only
    // submits when this reads `ok`.
    assert.equal(value.form_status, null);
  });

  test('refuses outright if anything asks it to', async () => {
    const { probe } = probeFor({});
    await assert.rejects(() => probe.submit(HOST, GENUINE_ENQUIRY), SendingIsDeferred);
  });

  test('has no phone test at all, so none is attempted', () => {
    const { probe } = probeFor({});
    assert.equal(probe.call, undefined);
  });

  test('the collector never reaches the sending path', async () => {
    const site = fakeSite({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: {
        status: 200,
        body: `<body><a href="tel:1">Call</a>${form('<textarea name="m"></textarea>')}</body>`,
      },
    });

    const probe = createReadOnlyProbe({
      contactUrl: CONTACT,
      fetchImpl: site.impl,
      sleep: async () => {},
    });

    // If submission were attempted the probe would throw, and `attempt` would swallow it —
    // so assert on the structural property instead: nothing was posted anywhere.
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY, { testPhone: true });
    const { value } = await collector.collect(target(HOST), { mode: 'cold' });

    assert.equal(value?.submission, null);
    assert.equal(value?.window_closes_at, null);
    assert.equal(value?.phone, null);
    for (const request of site.requests) {
      assert.match(request, new RegExp(`^${HOST}`), 'the probe left the site it was given');
    }
  });
});

// ------------------------------------------------- what the collector emits

const target = (domain: string | null) => ({
  target_id: 't1',
  role: 'subject' as const,
  place: {
    place_id: 'p_riverside',
    name: 'Riverside Plumbing',
    primary_category: 'Plumber',
    lat: 51.4571,
    lng: -0.1911,
    domain,
    postcode: 'SW18 4AB',
    phone: '+442080002222',
  },
});

describe('the two codes a read-only probe can produce', () => {
  const run = async (body: string) => {
    const site = fakeSite({
      [`${HOST}/robots.txt`]: ROBOTS_OPEN,
      [`${HOST}/`]: { status: 200, body },
    });
    const collector = createSpeedToLeadCollector(
      createReadOnlyProbe({ contactUrl: CONTACT, fetchImpl: site.impl, sleep: async () => {} }),
      GENUINE_ENQUIRY,
    );
    const { value, cost } = await collector.collect(target(HOST), { mode: 'cold' });
    return {
      codes: normaliseSpeedToLead(value, {
        now: new Date('2026-09-08T12:00:00.000Z'),
        role: 'subject',
      }).map((s) => s.code),
      cost,
    };
  };

  test('a site with no form and no tappable number produces both', async () => {
    const { codes } = await run('<body><p>Call us on 020 8000 2222</p></body>');
    assert.deepEqual(codes.sort(), ['STL_NO_FORM_ON_SITE', 'STL_NO_PHONE_VISIBLE_MOBILE']);
  });

  test('a site with both produces neither', async () => {
    const { codes } = await run(
      `<body><a href="tel:+442080002222">Call</a>${form('<textarea name="m"></textarea>')}</body>`,
    );
    assert.deepEqual(codes, []);
  });

  test('the five that need contact never appear, even after the window would have closed', async () => {
    const { codes } = await run('<body><p>Nothing here</p></body>');
    for (const code of [
      'STL_FORM_BROKEN',
      'STL_FORM_NO_REPLY',
      'STL_FORM_SLOW_REPLY',
      'STL_PHONE_UNANSWERED',
      'STL_COMPETITOR_FASTER',
    ]) {
      assert.equal(codes.includes(code as (typeof codes)[number]), false, code);
    }
  });

  test('costs a page fetch, not a scan', async () => {
    const { cost } = await run('<body></body>');
    assert.equal(cost.pence, 1);
  });

  test('a business with no website is not inspected at all', async () => {
    const site = fakeSite({});
    const collector = createSpeedToLeadCollector(
      createReadOnlyProbe({ contactUrl: CONTACT, fetchImpl: site.impl, sleep: async () => {} }),
      GENUINE_ENQUIRY,
    );
    const { value, cost } = await collector.collect(target(null), { mode: 'cold' });

    assert.equal(value?.surfaces, null);
    assert.equal(cost.pence, 0);
    assert.equal(site.requests.length, 0);
  });
});
