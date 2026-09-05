/**
 * Reviews fixtures — a well-run competitor set and a neglected subject.
 *
 * Lets the collector run end to end with no reviews-API key and no spend, and gives the
 * cold/sample distinction something concrete to be tested against: the same business,
 * seen through a full-history source and through Places' five-review sample, yields six
 * findings or two.
 *
 * Place ids match `../gbp/fixtures.ts` so a scan can be assembled from both.
 */

import type { Priced } from '../../resolve/providers';
import type { Review, ReviewsCapture, ReviewsProvider } from './types';

/** A reviews API call, per place. */
const REVIEWS_CALL = { pence: 4 };
/**
 * The Places sample costs nothing extra: `gbp` already bought the details call that
 * carries it. Rule 9 — free signals before paid enrichment.
 */
const RIDES_ON_PLACES = { pence: 0 };

const DAY_MS = 86_400_000;

interface ReviewSpec {
  prefix: string;
  count: number;
  /** ISO date of the oldest review. */
  from: string;
  /** ISO date of the newest. */
  to: string;
  /** Stars for review `i`, so a fixture can plant negatives at known positions. */
  rating: (i: number) => number;
  /** Whether the owner replied to review `i`. */
  replied: (i: number) => boolean;
}

/**
 * Evenly spaced reviews between two dates.
 *
 * Even spacing is deliberate: it makes every derived value — velocity across the trailing
 * window, recency, reply rate — arithmetic a test can state exactly rather than a number
 * copied out of a failing run.
 */
function makeReviews(spec: ReviewSpec): Review[] {
  const from = new Date(spec.from).getTime();
  const to = new Date(spec.to).getTime();
  const step = spec.count > 1 ? (to - from) / (spec.count - 1) : 0;

  return Array.from({ length: spec.count }, (_, i) => {
    const publishedMs = from + i * step;
    const rating = spec.rating(i);
    const negative = rating <= 3;

    return {
      id: `${spec.prefix}_r${i}`,
      rating,
      published_at: new Date(publishedMs).toISOString(),
      text: negative
        ? 'Waited in all day and nobody turned up. Rang three times, no answer.'
        : 'Turned up on time, sorted it properly, fair price.',
      author: `Customer ${i}`,
      replied_at: spec.replied(i) ? new Date(publishedMs + 2 * DAY_MS).toISOString() : null,
    };
  });
}

/** No review under four stars, answered nine times out of ten. */
const wellRun = {
  from: '2023-09-01T09:00:00.000Z',
  to: '2026-09-01T09:00:00.000Z',
  rating: (i: number) => (i % 5 === 0 ? 4 : 5),
  replied: (i: number) => i % 10 !== 0,
};

/** The competitor everything is measured against: 214 reviews, still arriving. */
export const HEALTHY_REVIEWS: ReviewsCapture = {
  place_id: 'p_wandsworth',
  rating: 4.8,
  review_count: 214,
  reviews: makeReviews({ prefix: 'wand', count: 214, ...wellRun }),
  coverage: 'complete',
  captured_at: '2026-09-04T09:00:00.000Z',
};

const SW_HEATING_REVIEWS: ReviewsCapture = {
  place_id: 'p_swheating',
  rating: 4.7,
  review_count: 150,
  reviews: makeReviews({ prefix: 'swh', count: 150, ...wellRun }),
  coverage: 'complete',
  captured_at: '2026-09-04T09:00:00.000Z',
};

const QUICKFIX_REVIEWS: ReviewsCapture = {
  place_id: 'p_quickfix',
  rating: 4.9,
  review_count: 96,
  reviews: makeReviews({ prefix: 'qf', count: 96, ...wellRun }),
  coverage: 'complete',
  captured_at: '2026-09-04T09:00:00.000Z',
};

/**
 * The subject: 23 reviews over five years, nothing since January, four unanswered
 * two-star reviews sitting at the top of the listing.
 */
export const NEGLECTED_REVIEWS: ReviewsCapture = {
  place_id: 'p_riverside',
  rating: 4.1,
  review_count: 23,
  reviews: makeReviews({
    prefix: 'river',
    count: 23,
    from: '2021-03-01T09:00:00.000Z',
    to: '2026-01-15T09:00:00.000Z',
    rating: (i) => (i % 7 === 0 ? 2 : 5),
    replied: () => false,
  }),
  coverage: 'complete',
  captured_at: '2026-09-04T09:00:00.000Z',
};

/** The competitor set, for `reviewsPeerStats`. */
export const COMPETITOR_REVIEWS = [HEALTHY_REVIEWS, SW_HEATING_REVIEWS, QUICKFIX_REVIEWS];

const BY_ID: Record<string, ReviewsCapture> = {
  p_wandsworth: HEALTHY_REVIEWS,
  p_swheating: SW_HEATING_REVIEWS,
  p_quickfix: QUICKFIX_REVIEWS,
  p_riverside: NEGLECTED_REVIEWS,
};

/** How many reviews the Places API returns alongside the aggregates. */
const PLACES_SAMPLE_SIZE = 5;

/**
 * Reduce a full capture to what the Places API would have shown: the aggregates intact,
 * five reviews, and no owner replies at all.
 */
export function asPlacesSample(capture: ReviewsCapture): ReviewsCapture {
  const newest = [...capture.reviews]
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
    .slice(0, PLACES_SAMPLE_SIZE)
    .map(({ replied_at: _dropped, ...rest }) => rest);

  return { ...capture, reviews: newest, coverage: 'sample' };
}

/** A reviews API: full history, owner replies included. */
export const fixtureReviewsProvider: ReviewsProvider = {
  name: 'fixture-reviews',
  async fetchReviews(placeId): Promise<Priced<ReviewsCapture | null>> {
    const capture = BY_ID[placeId];
    return { value: capture ?? null, cost: REVIEWS_CALL };
  },
};

/** Places only: aggregates plus five reviews, no replies. Two codes are reachable. */
export const fixtureReviewsProviderSample: ReviewsProvider = {
  name: 'fixture-reviews-places',
  async fetchReviews(placeId): Promise<Priced<ReviewsCapture | null>> {
    const capture = BY_ID[placeId];
    return { value: capture ? asPlacesSample(capture) : null, cost: RIDES_ON_PLACES };
  },
};

/** A listing that exists but has never been reviewed. */
export const fixtureReviewsProviderNone: ReviewsProvider = {
  name: 'fixture-reviews-none',
  async fetchReviews(placeId): Promise<Priced<ReviewsCapture | null>> {
    return {
      value: {
        place_id: placeId,
        rating: null,
        review_count: 0,
        reviews: [],
        coverage: 'complete',
        captured_at: '2026-09-04T09:00:00.000Z',
      },
      cost: REVIEWS_CALL,
    };
  },
};

/** No reviews surface at all — `gbp` reports the missing listing. */
export const fixtureReviewsProviderMissing: ReviewsProvider = {
  name: 'fixture-reviews-missing',
  async fetchReviews(): Promise<Priced<ReviewsCapture | null>> {
    return { value: null, cost: REVIEWS_CALL };
  },
};
