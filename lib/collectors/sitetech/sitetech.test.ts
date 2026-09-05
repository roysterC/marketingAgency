import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FINDINGS, type FindingCode } from '../../taxonomy/findings';
import { appliesTo, expandSeed, type NormaliseContext } from '../types';
import { FROM_CRAWL, FROM_VITALS, SITETECH_EMITS, createSiteTechCollector } from './index';
import {
  CLS_POOR,
  INP_POOR_MS,
  LCP_POOR_SECONDS,
  THIN_CONTENT_WORDS,
  blocksEverything,
  duplicateTitles,
  normaliseSiteTech,
} from './normalise';
import {
  BLOCKED_CRAWL,
  HEALTHY_CRAWL,
  HEALTHY_VITALS,
  NEGLECTED_CRAWL,
  NEGLECTED_VITALS,
  bothFailingProviders,
  crawlOnlyProviders,
  fixtureSiteTechProviders,
  vitalsOnlyProviders,
} from './fixtures';
import type { CrawlResult, SiteTechCapture, VitalsResult } from './types';

const NOW = new Date('2026-09-04T12:00:00.000Z');

const capture = (crawl: CrawlResult | null, vitals: VitalsResult | null): SiteTechCapture => ({
  url: 'riversideplumbing.example',
  crawl,
  vitals,
  source_errors: [],
  captured_at: NOW.toISOString(),
});

const smb: NormaliseContext = { now: NOW, role: 'subject', segment: 'smb' };
const dtc: NormaliseContext = { now: NOW, role: 'subject', segment: 'dtc' };
const ungated: NormaliseContext = { now: NOW, role: 'subject' };

const codes = (seeds: { code: FindingCode }[]): FindingCode[] => seeds.map((s) => s.code);

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
    phone: null,
  },
});

describe('sitetech contract', () => {
  test('every declared code really belongs to this collector', () => {
    for (const code of SITETECH_EMITS) {
      assert.equal(FINDINGS[code].collector, 'sitetech', code);
    }
  });

  test('declares every sitetech code in the registry', () => {
    const registry = Object.keys(FINDINGS).filter(
      (c) => FINDINGS[c as FindingCode].collector === 'sitetech',
    );
    assert.deepEqual([...SITETECH_EMITS].sort(), registry.sort());
  });

  test('the two source halves partition what it emits', () => {
    assert.deepEqual([...FROM_CRAWL, ...FROM_VITALS].sort(), [...SITETECH_EMITS].sort());
  });
});

describe('normaliseSiteTech — a neglected site', () => {
  const seeds = normaliseSiteTech(capture(NEGLECTED_CRAWL, NEGLECTED_VITALS), smb);

  test('finds everything an SMB scan can', () => {
    // All thirteen less the DTC-only Product schema rule.
    assert.equal(seeds.length, 12);
    assert.equal(codes(seeds).includes('TECH_MISSING_PRODUCT_SCHEMA'), false);
  });

  test('counts rather than asserts', () => {
    const byCode = (code: FindingCode) => seeds.find((s) => s.code === code)!;

    assert.equal(byCode('TECH_TITLE_MISSING').measured_value, 2);
    assert.equal(byCode('TECH_TITLE_MISSING').measured_text, '2 of 6 pages');
    assert.equal(byCode('TECH_TITLE_DUPLICATE').measured_value, 2);
    assert.equal(byCode('TECH_TITLE_DUPLICATE').measured_text, '2 pages share 1 title');
    assert.equal(byCode('TECH_BROKEN_LINKS').measured_value, 3);
    assert.equal(byCode('TECH_THIN_CONTENT').measured_value, 4);
    assert.equal(byCode('TECH_INDEXATION_BLOCKED').measured_value, 1);
  });

  test('a whitespace-only title counts as missing', () => {
    const missing = seeds.find((s) => s.code === 'TECH_TITLE_MISSING')!;
    const examples = missing.evidence.examples as string[];
    assert.ok(examples.includes('http://riversideplumbing.example/about'));
  });

  test('quotes the offending URLs so each finding can be checked', () => {
    const broken = seeds.find((s) => s.code === 'TECH_BROKEN_LINKS')!;
    const examples = broken.evidence.examples as Array<Record<string, unknown>>;
    assert.equal(examples.length, 3);
    assert.equal(examples[0]!.status, 404);
  });
});

describe('normaliseSiteTech — a well-built site', () => {
  test('produces nothing for the segment it was built for', () => {
    assert.deepEqual(normaliseSiteTech(capture(HEALTHY_CRAWL, HEALTHY_VITALS), smb), []);
  });
});

describe('segment gating', () => {
  const neglected = capture(NEGLECTED_CRAWL, NEGLECTED_VITALS);

  test('a plumber is never told it is missing Product schema', () => {
    assert.equal(
      codes(normaliseSiteTech(neglected, smb)).includes('TECH_MISSING_PRODUCT_SCHEMA'),
      false,
    );
  });

  test('a store is never told it is missing LocalBusiness schema', () => {
    const seeds = codes(normaliseSiteTech(neglected, dtc));
    assert.equal(seeds.includes('TECH_MISSING_LOCALBUSINESS_SCHEMA'), false);
    assert.equal(seeds.includes('TECH_MISSING_PRODUCT_SCHEMA'), true);
  });

  test('an unstated segment runs every rule', () => {
    assert.equal(normaliseSiteTech(neglected, ungated).length, 13);
  });

  test('gating reads the registry rather than restating it', () => {
    assert.equal(appliesTo('TECH_MISSING_PRODUCT_SCHEMA', 'smb'), false);
    assert.equal(appliesTo('TECH_MISSING_PRODUCT_SCHEMA', 'dtc'), true);
    assert.equal(appliesTo('TECH_MISSING_PRODUCT_SCHEMA', undefined), true);
    assert.equal(appliesTo('TECH_NO_HTTPS', 'smb'), true);
  });

  test('the healthy site would fail a DTC scan it was never built for', () => {
    // Same site, different question: a plumber has no Product markup, and should not.
    assert.deepEqual(codes(normaliseSiteTech(capture(HEALTHY_CRAWL, HEALTHY_VITALS), dtc)), [
      'TECH_MISSING_PRODUCT_SCHEMA',
    ]);
  });
});

describe('HTTPS is judged on where we landed', () => {
  test('plain http is the finding', () => {
    const seeds = normaliseSiteTech(capture(NEGLECTED_CRAWL, null), smb);
    const https = seeds.find((s) => s.code === 'TECH_NO_HTTPS')!;
    assert.equal(https.evidence.final_url, 'http://riversideplumbing.example/');
  });

  test('an http URL that redirects to https passes', () => {
    const redirected = { ...NEGLECTED_CRAWL, final_url: 'https://riversideplumbing.example/' };
    assert.equal(
      codes(normaliseSiteTech(capture(redirected, null), smb)).includes('TECH_NO_HTTPS'),
      false,
    );
  });
});

describe('robots.txt', () => {
  test('a site-wide disallow blocks everything', () => {
    assert.equal(blocksEverything('User-agent: *\nDisallow: /\n'), true);
  });

  test('a partial disallow is housekeeping, not a critical finding', () => {
    assert.equal(blocksEverything('User-agent: *\nDisallow: /wp-admin/\n'), false);
    assert.equal(
      codes(normaliseSiteTech(capture(NEGLECTED_CRAWL, null), smb)).includes(
        'TECH_INDEXATION_BLOCKED',
      ),
      // Still emitted here, but for the noindexed page rather than for robots.txt.
      true,
    );
    const seeds = normaliseSiteTech(capture(NEGLECTED_CRAWL, null), smb);
    const blocked = seeds.find((s) => s.code === 'TECH_INDEXATION_BLOCKED')!;
    assert.equal(blocked.evidence.robots_txt_blocks_all, false);
  });

  test('a disallow under a named user-agent does not count as site-wide', () => {
    assert.equal(blocksEverything('User-agent: AhrefsBot\nDisallow: /\n'), false);
  });

  test('comments are ignored', () => {
    assert.equal(blocksEverything('User-agent: *\nDisallow: / # temporarily\n'), true);
  });

  test('an unreachable robots.txt is not read as a block', () => {
    assert.equal(blocksEverything(null), false);
  });

  test('a blocked site reports every page as blocked', () => {
    const seeds = normaliseSiteTech(capture(BLOCKED_CRAWL, HEALTHY_VITALS), smb);
    assert.deepEqual(codes(seeds), ['TECH_INDEXATION_BLOCKED']);
    const blocked = seeds[0]!;
    assert.equal(blocked.measured_value, HEALTHY_CRAWL.pages.length);
    assert.equal(blocked.measured_text, 'robots.txt blocks the whole site');
  });
});

describe('duplicate titles', () => {
  test('groups the pages that share one', () => {
    const dupes = duplicateTitles(NEGLECTED_CRAWL.pages);
    assert.equal(dupes.size, 1);
    assert.deepEqual(dupes.get('Riverside Plumbing'), [
      'http://riversideplumbing.example/contact',
      'http://riversideplumbing.example/areas/wandsworth',
    ]);
  });

  test('untitled pages are not counted as duplicates of each other', () => {
    // Two pages with no title are a TECH_TITLE_MISSING problem, not a duplication one.
    assert.equal(duplicateTitles(NEGLECTED_CRAWL.pages).has(''), false);
  });
});

describe('vitals against Google thresholds', () => {
  const seeds = normaliseSiteTech(capture(null, NEGLECTED_VITALS), smb);

  test('reports the measured value and the boundary it crossed', () => {
    const lcp = seeds.find((s) => s.code === 'TECH_LCP_POOR')!;
    assert.equal(lcp.measured_value, 6.2);
    assert.equal(lcp.benchmark_value, LCP_POOR_SECONDS);
    assert.equal(lcp.benchmark_source, 'absolute');
    assert.equal(lcp.evidence.google_poor_above, 4.0);
  });

  test('uses the published poor bands, not invented ones', () => {
    assert.equal(LCP_POOR_SECONDS, 4.0);
    assert.equal(CLS_POOR, 0.25);
    assert.equal(INP_POOR_MS, 500);
  });

  test('a page in the amber band is not a finding', () => {
    // Needs-improvement is real but it is not what a paid report leads with.
    const amber: VitalsResult = {
      ...NEGLECTED_VITALS,
      lcp_seconds: 3.2,
      cls: 0.18,
      inp_ms: 340,
      mobile_friendly: true,
    };
    assert.deepEqual(normaliseSiteTech(capture(null, amber), smb), []);
  });

  test('a metric with no field data is skipped rather than read as zero', () => {
    const partial: VitalsResult = {
      ...NEGLECTED_VITALS,
      lcp_seconds: null,
      cls: null,
      inp_ms: null,
      mobile_friendly: null,
    };
    assert.deepEqual(normaliseSiteTech(capture(null, partial), smb), []);
  });

  test('every vitals finding links to the PageSpeed run', () => {
    for (const seed of seeds) {
      assert.equal(seed.evidence.report_url, NEGLECTED_VITALS.report_url, seed.code);
    }
  });
});

describe('thin content', () => {
  test('counts pages under the threshold', () => {
    const seeds = normaliseSiteTech(capture(NEGLECTED_CRAWL, null), smb);
    const thin = seeds.find((s) => s.code === 'TECH_THIN_CONTENT')!;
    assert.equal(thin.evidence.threshold_words, THIN_CONTENT_WORDS);
    const examples = thin.evidence.examples as Array<{ url: string; word_count: number }>;
    assert.ok(examples.every((e) => e.word_count < THIN_CONTENT_WORDS));
  });

  test('is the only estimated code here — word count is a proxy, not a judgement', () => {
    assert.equal(FINDINGS.TECH_THIN_CONTENT.confidence, 'estimated');
    for (const code of SITETECH_EMITS) {
      if (code === 'TECH_THIN_CONTENT') continue;
      assert.equal(FINDINGS[code].confidence, 'verified', code);
    }
  });
});

describe('sources fail independently', () => {
  const t = target('riversideplumbing.example');

  test('both working costs the crawl and nothing for PageSpeed', async () => {
    const collector = createSiteTechCollector(fixtureSiteTechProviders);
    const { value, cost } = await collector.collect(t, { mode: 'cold' });
    assert.equal(cost.pence, 1);
    assert.deepEqual(value?.source_errors, []);
    assert.equal(collector.normalise(value, smb).length, 12);
  });

  test('PageSpeed failing keeps every crawl finding', async () => {
    const collector = createSiteTechCollector(crawlOnlyProviders);
    const { value, cost } = await collector.collect(t, { mode: 'cold' });
    const seeds = collector.normalise(value, smb);

    assert.equal(value?.vitals, null);
    assert.notEqual(value?.crawl, null);
    assert.equal(cost.pence, 1);
    for (const code of FROM_VITALS) {
      assert.equal(codes(seeds).includes(code), false, code);
    }
    // Eight of the nine crawl codes: Product schema is DTC-only.
    assert.equal(seeds.length, 8);
  });

  test('the crawl failing keeps every vitals finding', async () => {
    const collector = createSiteTechCollector(vitalsOnlyProviders);
    const { value, cost } = await collector.collect(t, { mode: 'cold' });
    const seeds = collector.normalise(value, smb);

    assert.equal(value?.crawl, null);
    assert.deepEqual(codes(seeds).sort(), [...FROM_VITALS].sort());
    // A request that errored is not a request we were billed for.
    assert.equal(cost.pence, 0);
  });

  test('records why a source is missing, so a thin report is not a mystery', async () => {
    const collector = createSiteTechCollector(bothFailingProviders);
    const { value } = await collector.collect(t, { mode: 'cold' });

    assert.deepEqual(value?.source_errors, [
      { source: 'crawl', message: 'crawl worker timed out after 30s' },
      { source: 'vitals', message: 'PageSpeed Insights quota exceeded' },
    ]);
    assert.deepEqual(collector.normalise(value, smb), []);
  });

  test('a dead source degrades the section without throwing', async () => {
    const collector = createSiteTechCollector(bothFailingProviders);
    await assert.doesNotReject(() => collector.collect(t, { mode: 'cold' }));
  });
});

describe('collector', () => {
  test('measures mobile by default — local search happens on a phone', async () => {
    const collector = createSiteTechCollector(fixtureSiteTechProviders);
    const { value } = await collector.collect(target('riversideplumbing.example'), {
      mode: 'cold',
    });
    assert.equal(value?.vitals?.strategy, 'mobile');
  });

  test('desktop can be asked for explicitly', async () => {
    const collector = createSiteTechCollector(fixtureSiteTechProviders, 'desktop');
    const { value } = await collector.collect(target('riversideplumbing.example'), {
      mode: 'cold',
    });
    assert.equal(value?.vitals?.strategy, 'desktop');
  });

  test('a business with no website costs nothing and says nothing', async () => {
    const collector = createSiteTechCollector(fixtureSiteTechProviders);
    const { value, cost } = await collector.collect(target(null), { mode: 'cold' });
    assert.equal(value, null);
    assert.equal(cost.pence, 0);
    assert.deepEqual(collector.normalise(value, smb), []);
  });

  test('runs without auth — this is a cold-mode collector', () => {
    assert.equal(createSiteTechCollector(fixtureSiteTechProviders).requires_auth, false);
  });

  test('only emits codes it declared', async () => {
    const collector = createSiteTechCollector(fixtureSiteTechProviders);
    const { value } = await collector.collect(target('riversideplumbing.example'), {
      mode: 'cold',
    });
    for (const seed of collector.normalise(value, ungated)) {
      assert.ok(SITETECH_EMITS.includes(seed.code as (typeof SITETECH_EMITS)[number]), seed.code);
    }
  });
});

describe('expandSeed', () => {
  test('takes severity and confidence from the registry, not the collector', () => {
    const draft = expandSeed({ code: 'TECH_NO_HTTPS', evidence: {} }, 't1');
    assert.equal(draft.severity, 'critical');
    assert.equal(draft.confidence, 'verified');
    assert.equal(draft.collector, 'sitetech');
    assert.equal(draft.measured_unit, null);
  });

  test('carries the units the benchmark layer needs', () => {
    assert.equal(expandSeed({ code: 'TECH_LCP_POOR', evidence: {} }, 't').measured_unit, 'seconds');
    assert.equal(expandSeed({ code: 'TECH_INP_POOR', evidence: {} }, 't').measured_unit, 'ms');
    assert.equal(expandSeed({ code: 'TECH_CLS_POOR', evidence: {} }, 't').measured_unit, 'score');
  });
});
