/**
 * Reviews normalise rules — pure, no I/O.
 *
 * Review velocity is the strongest local finding in the engine: volume is a vanity
 * number a business can point at, velocity is the one that predicts ranking and shows
 * neglect. Every rule here measures rather than asserts, and every rule derived from the
 * review *list* checks that the source actually gave us the whole list first.
 */

import type { FindingSeed, NormaliseContext } from '../types';
import type { Review, ReviewsCapture } from './types';

/** With no competitor data, a listing under this many reviews is thin for a local trade. */
export const MIN_REVIEWS_ABSOLUTE = 20;
/** With competitor data, flag only when meaningfully behind rather than merely below median. */
export const COUNT_LAGGING_RATIO = 0.5;

/** Trailing window for the velocity calculation. */
export const VELOCITY_WINDOW_DAYS = 365;
/** With no competitor data, fewer than one review a month reads as neglect. */
export const MIN_VELOCITY_ABSOLUTE = 1;
export const VELOCITY_LAGGING_RATIO = 0.5;

/**
 * Star ratings are compressed — almost every business sits between 4.0 and 5.0 — so an
 * absolute threshold is useless and a bare "below median" fires on noise. Flag a real gap.
 */
export const RATING_GAP = 0.3;

/** Below this share of reviews answered, the owner is visibly not engaging. */
export const MIN_RESPONSE_RATE_PERCENT = 50;
/** At or below this many stars a review is negative, and an unanswered one costs money. */
export const NEGATIVE_RATING_MAX = 3;
/** No review in this long reads as a business that has stopped asking. */
export const STALE_REVIEW_DAYS = 90;

/** How many unanswered negatives to quote in evidence. The report does not need all of them. */
const MAX_QUOTED = 5;
/** Excerpt length for a quoted review. Long enough to sting, short enough to render. */
const EXCERPT_CHARS = 140;

const MS_PER_DAY = 86_400_000;
const DAYS_PER_MONTH = 30.44;

/** Peer metric keys, shared with the aggregation step. */
export const PEER_KEYS = {
  count: 'reviews.count',
  velocity: 'reviews.velocity_per_month',
  rating: 'reviews.rating',
  response_rate: 'reviews.response_rate',
} as const;

const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);

const round = (n: number, dp: number): number => {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
};

const publishedAt = (r: Review): number => new Date(r.published_at).getTime();

/** Deep link to the review list, so every finding here is one click from being verified. */
export const reviewsUrl = (placeId: string): string =>
  `https://search.google.com/local/reviews?placeid=${encodeURIComponent(placeId)}`;

const peerMedian = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.median[key] ?? null;

const peerBest = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.best[key] ?? null;

/**
 * Whether the source reports owner replies at all.
 *
 * All-or-nothing by design: a provider either exposes the field or it does not, so a
 * partially populated list means a provider bug rather than a business that replied to
 * some reviews. Treat that as unknown instead of quietly counting the gaps as "no reply".
 */
export function repliesVisible(capture: ReviewsCapture): boolean {
  return capture.reviews.length > 0 && capture.reviews.every((r) => r.replied_at !== undefined);
}

/**
 * Reviews per month across the trailing window.
 *
 * `null` when the source gave us a capped sample — a rate computed over five of two
 * hundred reviews is not a rate, and this code is `verified` in the taxonomy.
 *
 * A business younger than the window is measured over its own life rather than punished
 * for the months in which it did not exist.
 */
export function velocityOf(capture: ReviewsCapture, now: Date): number | null {
  // An authoritative zero needs no list: no reviews is no reviews under any coverage.
  if (capture.review_count === 0) return 0;
  if (capture.coverage !== 'complete' || capture.reviews.length === 0) return null;

  const windowOpens = now.getTime() - VELOCITY_WINDOW_DAYS * MS_PER_DAY;
  const oldest = Math.min(...capture.reviews.map(publishedAt));
  const from = Math.max(windowOpens, oldest);

  const months = Math.max(daysBetween(new Date(from), now) / DAYS_PER_MONTH, 1);
  const inWindow = capture.reviews.filter((r) => publishedAt(r) >= from).length;

  return round(inWindow / months, 2);
}

/** Share of reviews the owner answered, 0–100. `null` when the source hides replies. */
export function responseRateOf(capture: ReviewsCapture): number | null {
  if (!repliesVisible(capture) || capture.coverage !== 'complete') return null;
  const replied = capture.reviews.filter((r) => r.replied_at != null).length;
  return round((replied / capture.reviews.length) * 100, 1);
}

const excerpt = (text: string | null): string | null => {
  if (text === null) return null;
  return text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}...`;
};

export function normaliseReviews(
  capture: ReviewsCapture | null,
  ctx: NormaliseContext,
): FindingSeed[] {
  // No reviews surface at all means no Business Profile, which `gbp` already reports as
  // GBP_MISSING. A second finding for the same fact would pad the report.
  if (!capture) return [];

  const seeds: FindingSeed[] = [];
  const url = reviewsUrl(capture.place_id);

  // --- volume --------------------------------------------------------------
  const peerCount = peerMedian(ctx, PEER_KEYS.count);
  const countThreshold =
    peerCount === null ? MIN_REVIEWS_ABSOLUTE : peerCount * COUNT_LAGGING_RATIO;

  if (capture.review_count < countThreshold) {
    seeds.push({
      code: 'REVIEW_VOLUME_LOW',
      measured_value: capture.review_count,
      benchmark_value: peerBest(ctx, PEER_KEYS.count),
      benchmark_source: peerCount === null ? 'absolute' : 'competitor_best',
      evidence: {
        review_count: capture.review_count,
        competitor_median: peerCount,
        competitor_best: peerBest(ctx, PEER_KEYS.count),
        threshold: round(countThreshold, 1),
        reviews_url: url,
      },
    });
  }

  // --- velocity — the strongest local finding ------------------------------
  const velocity = velocityOf(capture, ctx.now);
  if (velocity !== null) {
    const peerVelocity = peerMedian(ctx, PEER_KEYS.velocity);
    const velocityThreshold =
      peerVelocity === null ? MIN_VELOCITY_ABSOLUTE : peerVelocity * VELOCITY_LAGGING_RATIO;

    if (velocity < velocityThreshold) {
      seeds.push({
        code: 'REVIEW_VELOCITY_LOW',
        measured_value: velocity,
        measured_text: `${velocity} a month`,
        benchmark_value: peerBest(ctx, PEER_KEYS.velocity),
        benchmark_source: peerVelocity === null ? 'absolute' : 'competitor_best',
        evidence: {
          reviews_per_month: velocity,
          window_days: VELOCITY_WINDOW_DAYS,
          competitor_median: peerVelocity,
          competitor_best: peerBest(ctx, PEER_KEYS.velocity),
          threshold: round(velocityThreshold, 2),
          reviews_url: url,
        },
      });
    }
  }

  // --- rating --------------------------------------------------------------
  // "Below the set" is comparative by definition: with no competitor set there is no
  // finding to make, and an absolute threshold on a 4.0-5.0 range would be noise.
  const peerRating = peerMedian(ctx, PEER_KEYS.rating);
  if (capture.rating !== null && peerRating !== null && capture.rating < peerRating - RATING_GAP) {
    seeds.push({
      code: 'REVIEW_RATING_BELOW_SET',
      measured_value: capture.rating,
      benchmark_value: peerBest(ctx, PEER_KEYS.rating),
      benchmark_source: 'competitor_best',
      evidence: {
        rating: capture.rating,
        competitor_median: peerRating,
        competitor_best: peerBest(ctx, PEER_KEYS.rating),
        gap: round(peerRating - capture.rating, 2),
        review_count: capture.review_count,
        reviews_url: url,
      },
    });
  }

  // --- response rate -------------------------------------------------------
  const responseRate = responseRateOf(capture);
  if (responseRate !== null && responseRate < MIN_RESPONSE_RATE_PERCENT) {
    const peerRate = peerMedian(ctx, PEER_KEYS.response_rate);
    seeds.push({
      code: 'REVIEW_RESPONSE_RATE_LOW',
      measured_value: responseRate,
      measured_text: `${responseRate}% answered`,
      benchmark_value: peerBest(ctx, PEER_KEYS.response_rate),
      benchmark_source: peerRate === null ? 'absolute' : 'competitor_best',
      evidence: {
        response_rate_percent: responseRate,
        reviews_answered: capture.reviews.filter((r) => r.replied_at != null).length,
        reviews_total: capture.reviews.length,
        competitor_median: peerRate,
        threshold: MIN_RESPONSE_RATE_PERCENT,
        reviews_url: url,
      },
    });
  }

  // --- unanswered negatives ------------------------------------------------
  // Runs on a sample as well as a full history: each unanswered negative is directly
  // observed, so the count is verified even where it is only a floor. `coverage` goes in
  // the evidence so the benchmark pass can exclude partial samples from percentiles.
  if (repliesVisible(capture)) {
    const unanswered = capture.reviews
      .filter((r) => r.rating <= NEGATIVE_RATING_MAX && r.replied_at == null)
      .sort((a, b) => publishedAt(b) - publishedAt(a));

    if (unanswered.length > 0) {
      seeds.push({
        code: 'REVIEW_RESPONSE_ABSENT_NEGATIVE',
        measured_value: unanswered.length,
        measured_text: `${unanswered.length} unanswered`,
        evidence: {
          unanswered_count: unanswered.length,
          coverage: capture.coverage,
          negative_at_or_below: NEGATIVE_RATING_MAX,
          examples: unanswered.slice(0, MAX_QUOTED).map((r) => ({
            review_id: r.id,
            rating: r.rating,
            published_at: r.published_at,
            author: r.author,
            excerpt: excerpt(r.text),
          })),
          reviews_url: url,
        },
      });
    }
  }

  // --- recency -------------------------------------------------------------
  // Only a complete history can establish staleness. A sample whose newest entry is old
  // proves nothing — a newer review may simply not be in the sample.
  if (capture.coverage === 'complete' && capture.reviews.length > 0) {
    const newest = Math.max(...capture.reviews.map(publishedAt));
    const age = daysBetween(new Date(newest), ctx.now);

    if (age > STALE_REVIEW_DAYS) {
      seeds.push({
        code: 'REVIEW_RECENCY_STALE',
        measured_value: age,
        measured_text: `${age} days ago`,
        evidence: {
          last_review_at: new Date(newest).toISOString(),
          days_since: age,
          threshold_days: STALE_REVIEW_DAYS,
          reviews_url: url,
        },
      });
    }
  }

  return seeds;
}
