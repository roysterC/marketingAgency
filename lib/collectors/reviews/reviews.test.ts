import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FINDINGS, type FindingCode } from '../../taxonomy/findings';
import { expandSeed, type NormaliseContext } from '../types';
import {
  NEEDS_FULL_HISTORY,
  NEEDS_REPLIES,
  REVIEWS_EMITS,
  createReviewsCollector,
  reviewsPeerStats,
} from './index';
import {
  MIN_REVIEWS_ABSOLUTE,
  normaliseReviews,
  repliesVisible,
  responseRateOf,
  reviewsUrl,
  velocityOf,
} from './normalise';
import {
  COMPETITOR_REVIEWS,
  HEALTHY_REVIEWS,
  NEGLECTED_REVIEWS,
  asPlacesSample,
  fixtureReviewsProvider,
  fixtureReviewsProviderMissing,
  fixtureReviewsProviderNone,
  fixtureReviewsProviderSample,
} from './fixtures';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const peers = reviewsPeerStats(COMPETITOR_REVIEWS, NOW);

const ctx = (over: Partial<NormaliseContext> = {}): NormaliseContext => ({
  now: NOW,
  role: 'subject',
  peers,
  ...over,
});

/** A scan with no competitor set yet — every rule falls back to absolute thresholds. */
const noPeers: NormaliseContext = { now: NOW, role: 'subject' };

const codes = (seeds: { code: FindingCode }[]): FindingCode[] => seeds.map((s) => s.code);

describe('reviews contract', () => {
  test('every declared code really belongs to this collector', () => {
    for (const code of REVIEWS_EMITS) {
      assert.equal(FINDINGS[code].collector, 'reviews', code);
    }
  });

  test('declares every reviews code in the registry', () => {
    const registry = Object.keys(FINDINGS).filter(
      (c) => FINDINGS[c as FindingCode].collector === 'reviews',
    );
    assert.deepEqual([...REVIEWS_EMITS].sort(), registry.sort());
  });

  test('the source-limited code sets are subsets of what it emits', () => {
    for (const code of [...NEEDS_FULL_HISTORY, ...NEEDS_REPLIES]) {
      assert.ok(REVIEWS_EMITS.includes(code), code);
    }
  });
});

describe('normaliseReviews — neglected listing, full history', () => {
  const seeds = normaliseReviews(NEGLECTED_REVIEWS, ctx());

  test('finds all six', () => {
    assert.deepEqual(codes(seeds).sort(), [
      'REVIEW_RATING_BELOW_SET',
      'REVIEW_RECENCY_STALE',
      'REVIEW_RESPONSE_ABSENT_NEGATIVE',
      'REVIEW_RESPONSE_RATE_LOW',
      'REVIEW_VELOCITY_LOW',
      'REVIEW_VOLUME_LOW',
    ]);
  });

  test('every finding links to the review list so it can be verified', () => {
    for (const seed of seeds) {
      assert.equal(seed.evidence.reviews_url, reviewsUrl('p_riverside'), seed.code);
    }
  });

  test('measures rather than asserts', () => {
    const byCode = (code: FindingCode) => seeds.find((s) => s.code === code)!;

    assert.equal(byCode('REVIEW_VOLUME_LOW').measured_value, 23);
    // 2 reviews in the trailing 365 days, over 11.99 months.
    assert.equal(byCode('REVIEW_VELOCITY_LOW').measured_value, 0.17);
    assert.equal(byCode('REVIEW_RATING_BELOW_SET').measured_value, 4.1);
    assert.equal(byCode('REVIEW_RESPONSE_RATE_LOW').measured_value, 0);
    assert.equal(byCode('REVIEW_RESPONSE_ABSENT_NEGATIVE').measured_value, 4);
    // Newest review 2026-01-15, clock 2026-09-04.
    assert.equal(byCode('REVIEW_RECENCY_STALE').measured_value, 232);
  });

  test('quotes the unanswered negatives, newest first', () => {
    const negatives = seeds.find((s) => s.code === 'REVIEW_RESPONSE_ABSENT_NEGATIVE')!;
    const examples = negatives.evidence.examples as Array<Record<string, unknown>>;

    assert.equal(examples.length, 4);
    assert.equal(examples[0]!.review_id, 'river_r21');
    assert.equal(examples[0]!.rating, 2);
    assert.ok(String(examples[0]!.excerpt).startsWith('Waited in all day'));
    // Newest first, so the report leads with the one still visible on the listing.
    const dates = examples.map((e) => String(e.published_at));
    assert.deepEqual(dates, [...dates].sort().reverse());
  });

  test('benchmarks against the competitor best it names', () => {
    const velocity = seeds.find((s) => s.code === 'REVIEW_VELOCITY_LOW')!;
    assert.equal(velocity.benchmark_source, 'competitor_best');
    assert.equal(velocity.benchmark_value, 5.92);
    // The median decides whether to flag; the best is what the report quotes.
    assert.equal(velocity.evidence.competitor_median, 4.17);
    assert.equal(velocity.evidence.competitor_best, 5.92);
  });
});

describe('normaliseReviews — a well-run listing', () => {
  test('produces nothing against its own peer set', () => {
    assert.deepEqual(normaliseReviews(HEALTHY_REVIEWS, ctx()), []);
  });
});

describe('coverage — what a capped sample can and cannot support', () => {
  const sample = asPlacesSample(NEGLECTED_REVIEWS);
  const seeds = normaliseReviews(sample, ctx());

  test('the aggregates still hold', () => {
    assert.deepEqual(codes(seeds).sort(), ['REVIEW_RATING_BELOW_SET', 'REVIEW_VOLUME_LOW']);
    assert.equal(seeds.find((s) => s.code === 'REVIEW_VOLUME_LOW')!.measured_value, 23);
  });

  test('nothing derived from the list is emitted', () => {
    for (const code of NEEDS_FULL_HISTORY) {
      assert.equal(codes(seeds).includes(code), false, code);
    }
  });

  test('a sample carries no velocity, which is not the same as zero velocity', () => {
    assert.equal(velocityOf(sample, NOW), null);
    assert.equal(velocityOf(NEGLECTED_REVIEWS, NOW), 0.17);
  });

  test('staleness is unprovable from a sample even when its newest entry is old', () => {
    // Same listing, same 232-day-old newest review — but a newer one could simply be
    // outside the five the source returned.
    assert.equal(codes(seeds).includes('REVIEW_RECENCY_STALE'), false);
    assert.equal(
      codes(normaliseReviews(NEGLECTED_REVIEWS, ctx())).includes('REVIEW_RECENCY_STALE'),
      true,
    );
  });

  test('the full history is worth six findings against the sample two', () => {
    assert.equal(normaliseReviews(NEGLECTED_REVIEWS, ctx()).length, 6);
    assert.equal(seeds.length, 2);
  });
});

describe('replies the source does not expose', () => {
  const sample = asPlacesSample(NEGLECTED_REVIEWS);

  test('undefined means unknown, not unanswered', () => {
    assert.equal(repliesVisible(NEGLECTED_REVIEWS), true);
    assert.equal(repliesVisible(sample), false);
    assert.equal(responseRateOf(sample), null);
  });

  test('no reply finding is emitted when replies cannot be seen', () => {
    const seeds = normaliseReviews(sample, ctx());
    for (const code of NEEDS_REPLIES) {
      assert.equal(codes(seeds).includes(code), false, code);
    }
  });

  test('a partially populated list is treated as unknown rather than half-counted', () => {
    const half = {
      ...NEGLECTED_REVIEWS,
      reviews: NEGLECTED_REVIEWS.reviews.map((r, i) => {
        if (i % 2 === 0) return r;
        const { replied_at: _hidden, ...rest } = r;
        return rest;
      }),
    };
    assert.equal(repliesVisible(half), false);
    assert.equal(responseRateOf(half), null);
  });
});

describe('unanswered negatives on a partial sample', () => {
  test('each one is directly observed, so the count survives a sample', () => {
    // Places hides replies entirely, but a source could cap the list and still show
    // them. Every unanswered negative in that list is real; the total is a floor.
    const capped = { ...NEGLECTED_REVIEWS, reviews: NEGLECTED_REVIEWS.reviews.slice(-6), coverage: 'sample' as const };
    const seeds = normaliseReviews(capped, ctx());
    const negatives = seeds.find((s) => s.code === 'REVIEW_RESPONSE_ABSENT_NEGATIVE')!;

    assert.equal(negatives.measured_value, 1);
    // Recorded so the benchmark pass can keep a floor out of the percentiles.
    assert.equal(negatives.evidence.coverage, 'sample');
  });
});

describe('absolute thresholds with no competitor set', () => {
  const seeds = normaliseReviews(NEGLECTED_REVIEWS, noPeers);

  test('rating goes unreported, because "below the set" needs a set', () => {
    assert.equal(codes(seeds).includes('REVIEW_RATING_BELOW_SET'), false);
  });

  test('23 reviews clears the absolute floor that 150 competitors would not', () => {
    assert.ok(NEGLECTED_REVIEWS.review_count > MIN_REVIEWS_ABSOLUTE);
    assert.equal(codes(seeds).includes('REVIEW_VOLUME_LOW'), false);
    assert.equal(
      codes(normaliseReviews(NEGLECTED_REVIEWS, ctx())).includes('REVIEW_VOLUME_LOW'),
      true,
    );
  });

  test('velocity still fires against the absolute floor', () => {
    const velocity = seeds.find((s) => s.code === 'REVIEW_VELOCITY_LOW')!;
    assert.equal(velocity.benchmark_source, 'absolute');
    assert.equal(velocity.benchmark_value, null);
  });
});

describe('a listing with no reviews at all', () => {
  test('reports the emptiness without inventing a date', async () => {
    const collector = createReviewsCollector(fixtureReviewsProviderNone);
    const { value } = await collector.collect(
      { target_id: 't1', role: 'subject', place: place('p_new') },
      { mode: 'cold' },
    );
    const seeds = collector.normalise(value, ctx());

    assert.deepEqual(codes(seeds).sort(), ['REVIEW_VELOCITY_LOW', 'REVIEW_VOLUME_LOW']);
    assert.equal(seeds.find((s) => s.code === 'REVIEW_VOLUME_LOW')!.measured_value, 0);
    // Zero reviews is an authoritative zero rate, not an unknown one.
    assert.equal(seeds.find((s) => s.code === 'REVIEW_VELOCITY_LOW')!.measured_value, 0);
    assert.equal(codes(seeds).includes('REVIEW_RECENCY_STALE'), false);
  });
});

describe('velocity window', () => {
  test('a young business is measured over its own life, not the full window', () => {
    // Six reviews in the two months since it opened is healthy, not neglect.
    const young = {
      ...NEGLECTED_REVIEWS,
      review_count: 6,
      reviews: NEGLECTED_REVIEWS.reviews.slice(0, 6).map((r, i) => ({
        ...r,
        published_at: new Date(NOW.getTime() - (60 - i * 10) * 86_400_000).toISOString(),
      })),
    };
    // 6 reviews across 60 days is ~3/month, not 6/12.
    assert.equal(velocityOf(young, NOW), 3.04);
  });
});

describe('peer stats', () => {
  test('computes medians and bests across the competitor set', () => {
    assert.equal(peers.median['reviews.count'], 150);
    assert.equal(peers.best['reviews.count'], 214);
    assert.equal(peers.median['reviews.velocity_per_month'], 4.17);
    assert.equal(peers.best['reviews.velocity_per_month'], 5.92);
    assert.equal(peers.median['reviews.rating'], 4.8);
  });

  test('a competitor whose source gave a sample is left out of the rate metrics', () => {
    // Not counted as zero — it has no velocity, which is a different claim.
    const mixed = reviewsPeerStats(
      [HEALTHY_REVIEWS, asPlacesSample(COMPETITOR_REVIEWS[1]!), asPlacesSample(COMPETITOR_REVIEWS[2]!)],
      NOW,
    );
    assert.equal(mixed.median['reviews.velocity_per_month'], 5.92);
    // Aggregates survive the sample, so counts still use all three.
    assert.equal(mixed.median['reviews.count'], 150);
  });
});

describe('expandSeed', () => {
  test('takes severity and confidence from the registry, not the collector', () => {
    const draft = expandSeed({ code: 'REVIEW_VELOCITY_LOW', measured_value: 0.17, evidence: {} }, 't1');
    assert.equal(draft.severity, 'critical');
    assert.equal(draft.confidence, 'verified');
    assert.equal(draft.collector, 'reviews');
    assert.equal(draft.measured_unit, 'per_month');
  });

  test('carries the units the benchmark layer needs', () => {
    assert.equal(expandSeed({ code: 'REVIEW_RECENCY_STALE', evidence: {} }, 't').measured_unit, 'days');
    assert.equal(expandSeed({ code: 'REVIEW_RESPONSE_RATE_LOW', evidence: {} }, 't').measured_unit, 'percent');
    assert.equal(expandSeed({ code: 'REVIEW_RATING_BELOW_SET', evidence: {} }, 't').measured_unit, 'score');
  });
});

function place(placeId: string) {
  return {
    place_id: placeId,
    name: 'Riverside Plumbing',
    primary_category: 'Plumber',
    lat: 51.4571,
    lng: -0.1911,
    domain: null,
    postcode: 'SW18 4AB',
    phone: null,
  };
}

describe('collector', () => {
  const target = { target_id: 't1', role: 'subject' as const, place: place('p_riverside') };

  test('collects and reports its cost', async () => {
    const collector = createReviewsCollector(fixtureReviewsProvider);
    const { value, cost } = await collector.collect(target, { mode: 'cold' });
    assert.equal(value?.place_id, 'p_riverside');
    assert.equal(cost.pence, 4);
  });

  test('the Places sample costs nothing extra — gbp already bought that call', async () => {
    const collector = createReviewsCollector(fixtureReviewsProviderSample);
    const { cost } = await collector.collect(target, { mode: 'cold' });
    assert.equal(cost.pence, 0);
  });

  test('says nothing when there is no reviews surface, since gbp reports the missing listing', async () => {
    const collector = createReviewsCollector(fixtureReviewsProviderMissing);
    const { value } = await collector.collect(target, { mode: 'cold' });
    assert.equal(value, null);
    assert.deepEqual(collector.normalise(value, ctx()), []);
  });

  test('runs without auth — this is a cold-mode collector', () => {
    assert.equal(createReviewsCollector(fixtureReviewsProvider).requires_auth, false);
  });

  test('only emits codes it declared', async () => {
    const collector = createReviewsCollector(fixtureReviewsProvider);
    const seeds = collector.normalise((await collector.collect(target, { mode: 'cold' })).value, ctx());
    for (const seed of seeds) {
      assert.ok(REVIEWS_EMITS.includes(seed.code as (typeof REVIEWS_EMITS)[number]), seed.code);
    }
  });
});
