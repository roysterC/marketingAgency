import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FINDINGS, type FindingCode } from '../../taxonomy/findings';
import { expandSeed, type NormaliseContext } from '../types';
import { GBP_EMITS, WARM_ONLY_CODES, createGbpCollector, gbpPeerStats } from './index';
import { impliedVerticalFromName, mapsUrl, normaliseGbp } from './normalise';
import {
  HEALTHY_PROFILE,
  NEGLECTED_PROFILE,
  NEGLECTED_PROFILE_WARM,
  fixtureGbpProvider,
  fixtureGbpProviderMissing,
  fixtureGbpProviderWarm,
} from './fixtures';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const ctx = (over: Partial<NormaliseContext> = {}): NormaliseContext => ({
  now: NOW,
  role: 'subject',
  ...over,
});

const codes = (seeds: { code: FindingCode }[]): FindingCode[] => seeds.map((s) => s.code);

describe('gbp contract', () => {
  test('every declared code really belongs to this collector', () => {
    for (const code of GBP_EMITS) {
      assert.equal(FINDINGS[code].collector, 'gbp', code);
    }
  });

  test('declares every gbp code in the registry', () => {
    const registry = Object.keys(FINDINGS).filter(
      (c) => FINDINGS[c as FindingCode].collector === 'gbp',
    );
    assert.deepEqual([...GBP_EMITS].sort(), registry.sort());
  });

  test('warm-only codes are a subset of what it emits', () => {
    for (const code of WARM_ONLY_CODES) {
      assert.ok(GBP_EMITS.includes(code), code);
    }
  });
});

describe('normaliseGbp — missing listing', () => {
  test('reports GBP_MISSING with what was searched for', () => {
    const seeds = normaliseGbp(null, ctx(), { name: 'Riverside Plumbing', postcode: 'SW18 4AB' });
    assert.deepEqual(codes(seeds), ['GBP_MISSING']);
    assert.equal(seeds[0]!.evidence.searched_name, 'Riverside Plumbing');
    assert.equal(seeds[0]!.evidence.checked_at, NOW.toISOString());
  });
});

describe('normaliseGbp — healthy listing', () => {
  test('a well-maintained profile produces nothing', () => {
    assert.deepEqual(normaliseGbp(HEALTHY_PROFILE, ctx()), []);
  });
});

describe('normaliseGbp — neglected listing', () => {
  const seeds = normaliseGbp(NEGLECTED_PROFILE, ctx());

  test('finds exactly what cold mode can see', () => {
    assert.deepEqual(codes(seeds).sort(), [
      'GBP_ATTRIBUTES_SPARSE',
      'GBP_CATEGORY_MISMATCH',
      'GBP_HOURS_INCOMPLETE',
      'GBP_HOURS_STALE_HOLIDAY',
      'GBP_PHOTOS_SPARSE',
    ]);
  });

  test('emits no warm-only code in cold mode', () => {
    for (const code of WARM_ONLY_CODES) {
      assert.equal(codes(seeds).includes(code), false, code);
    }
  });

  test('every finding links to the listing so it can be verified', () => {
    for (const seed of seeds) {
      assert.equal(seed.evidence.maps_url, mapsUrl('p_riverside'), seed.code);
    }
  });

  test('measures rather than asserts', () => {
    const photos = seeds.find((s) => s.code === 'GBP_PHOTOS_SPARSE')!;
    assert.equal(photos.measured_value, 3);
    assert.equal(photos.evidence.photo_count, 3);

    const hours = seeds.find((s) => s.code === 'GBP_HOURS_INCOMPLETE')!;
    assert.equal(hours.measured_text, '5 of 7 days set');
  });
});

describe('normaliseGbp — warm mode', () => {
  const seeds = normaliseGbp(NEGLECTED_PROFILE_WARM, ctx());

  test('unlocks the owner-authorised findings', () => {
    for (const code of WARM_ONLY_CODES) {
      assert.ok(codes(seeds).includes(code), code);
    }
    assert.equal(seeds.length, 9);
  });

  test('measures post staleness against the injected clock', () => {
    const posts = seeds.find((s) => s.code === 'GBP_POSTS_STALE')!;
    // 2025-11-02 to 2026-09-04.
    assert.equal(posts.measured_value, 306);
    assert.equal(posts.evidence.threshold_days, 30);
  });

  test('does not report a field it merely could not see', () => {
    // Cold mode leaves services undefined; reporting "0 services" would be a false
    // finding in a paid report.
    const cold = normaliseGbp(NEGLECTED_PROFILE, ctx());
    assert.equal(codes(cold).includes('GBP_NO_SERVICES_LISTED'), false);
    assert.equal(codes(seeds).includes('GBP_NO_SERVICES_LISTED'), true);
  });
});

describe('category mismatch heuristic', () => {
  test('reads the trade out of the business name', () => {
    assert.equal(impliedVerticalFromName('Riverside Plumbing'), 'trades.plumbing');
    assert.equal(impliedVerticalFromName('Bright Spark Electrical'), 'trades.electrical');
    assert.equal(impliedVerticalFromName('Acme Holdings'), null);
  });

  test('flags a plumber filed as an electrician', () => {
    const seeds = normaliseGbp(NEGLECTED_PROFILE, ctx());
    const mismatch = seeds.find((s) => s.code === 'GBP_CATEGORY_MISMATCH')!;
    assert.equal(mismatch.evidence.listed_vertical, 'trades.electrical');
    assert.equal(mismatch.evidence.implied_vertical, 'trades.plumbing');
  });

  test('stays quiet when name and category agree', () => {
    const aligned = { ...NEGLECTED_PROFILE, primary_category: 'Plumber' };
    const seeds = normaliseGbp(aligned, ctx());
    assert.equal(codes(seeds).includes('GBP_CATEGORY_MISMATCH'), false);
  });

  test('is marked estimated, since it is inference not observation', () => {
    assert.equal(FINDINGS.GBP_CATEGORY_MISMATCH.confidence, 'estimated');
  });
});

describe('peer comparison', () => {
  const peers = gbpPeerStats([
    HEALTHY_PROFILE, // 46 photos
    { ...HEALTHY_PROFILE, photo_count: 31 },
    { ...HEALTHY_PROFILE, photo_count: 18 },
  ]);

  test('computes medians from the competitor set', () => {
    assert.equal(peers.median['gbp.photo_count'], 31);
    assert.equal(peers.best['gbp.photo_count'], 46);
  });

  test('compares against peers when available', () => {
    const seeds = normaliseGbp(NEGLECTED_PROFILE, ctx({ peers }));
    const photos = seeds.find((s) => s.code === 'GBP_PHOTOS_SPARSE')!;
    assert.equal(photos.benchmark_value, 31);
    assert.equal(photos.benchmark_source, 'competitor_best');
    assert.equal(photos.evidence.competitor_median, 31);
  });

  test('falls back to an absolute threshold with no peers', () => {
    const seeds = normaliseGbp(NEGLECTED_PROFILE, ctx());
    const photos = seeds.find((s) => s.code === 'GBP_PHOTOS_SPARSE')!;
    assert.equal(photos.benchmark_source, 'absolute');
    assert.equal(photos.benchmark_value, null);
  });

  test('a listing ahead of its peers is not flagged', () => {
    // 25 photos against a peer median of 31 clears the 0.6 ratio.
    const decent = { ...NEGLECTED_PROFILE, photo_count: 25 };
    const seeds = normaliseGbp(decent, ctx({ peers }));
    assert.equal(codes(seeds).includes('GBP_PHOTOS_SPARSE'), false);
  });
});

describe('expandSeed', () => {
  test('takes severity and confidence from the registry, not the collector', () => {
    const draft = expandSeed({ code: 'GBP_MISSING', evidence: {} }, 'target-1');
    assert.equal(draft.severity, 'critical');
    assert.equal(draft.confidence, 'verified');
    assert.equal(draft.collector, 'gbp');
    assert.equal(draft.target_id, 'target-1');
  });

  test('drops the unit for binary findings', () => {
    const draft = expandSeed({ code: 'GBP_HOURS_STALE_HOLIDAY', evidence: {} }, 't');
    assert.equal(draft.measured_unit, null);
  });

  test('keeps the unit for measured findings', () => {
    const draft = expandSeed({ code: 'GBP_PHOTOS_SPARSE', measured_value: 3, evidence: {} }, 't');
    assert.equal(draft.measured_unit, 'count');
    assert.equal(draft.measured_value, 3);
  });
});

describe('collector', () => {
  const target = {
    target_id: 't1',
    role: 'subject' as const,
    place: {
      place_id: 'p_riverside', name: 'Riverside Plumbing', primary_category: 'Electrician',
      lat: 51.4571, lng: -0.1911, domain: null, postcode: 'SW18 4AB', phone: null,
    },
  };

  test('collects and reports its cost', async () => {
    const collector = createGbpCollector(fixtureGbpProvider);
    const { value, cost } = await collector.collect(target, { mode: 'cold' });
    assert.equal(value?.place_id, 'p_riverside');
    assert.equal(cost.pence, 3);
  });

  test('handles a business with no profile', async () => {
    const collector = createGbpCollector(fixtureGbpProviderMissing);
    const { value } = await collector.collect(target, { mode: 'cold' });
    assert.equal(value, null);
    assert.deepEqual(codes(collector.normalise(value, ctx())), ['GBP_MISSING']);
  });

  test('warm provider yields more findings from the same listing', async () => {
    const cold = createGbpCollector(fixtureGbpProvider);
    const warm = createGbpCollector(fixtureGbpProviderWarm);

    const coldSeeds = cold.normalise((await cold.collect(target, { mode: 'cold' })).value, ctx());
    const warmSeeds = warm.normalise((await warm.collect(target, { mode: 'warm' })).value, ctx());

    assert.equal(coldSeeds.length, 5);
    assert.equal(warmSeeds.length, 9);
  });

  test('only emits codes it declared', async () => {
    const collector = createGbpCollector(fixtureGbpProviderWarm);
    const seeds = collector.normalise((await collector.collect(target, { mode: 'warm' })).value, ctx());
    for (const seed of seeds) {
      assert.ok(GBP_EMITS.includes(seed.code as (typeof GBP_EMITS)[number]), seed.code);
    }
  });
});
