/**
 * The `reviews` collector.
 *
 * Sits on whatever source can see the review list. What that source exposes decides how
 * much of the taxonomy is reachable, so the limits are declared here rather than
 * discovered in a thin report:
 *
 * - A Places-only provider returns the aggregates plus a five-review sample and no owner
 *   replies. Two codes are reachable.
 * - A reviews API returns the full history with replies. All six are reachable, cold.
 *
 * The difference is roughly ten pence a scan against the sharpest findings the local
 * report has, which is not a close call. See `docs/data-sources.md`.
 */

import type { Priced } from '../../resolve/providers';
import {
  median,
  type CollectContext,
  type CollectTarget,
  type Collector,
  type FindingSeed,
  type NormaliseContext,
  type PeerStats,
} from '../types';
import {
  PEER_KEYS,
  normaliseReviews,
  repliesVisible,
  responseRateOf,
  velocityOf,
} from './normalise';
import type { ReviewsCapture, ReviewsProvider } from './types';

/** Every code this collector may emit. Verified against the registry in tests. */
export const REVIEWS_EMITS = [
  'REVIEW_VOLUME_LOW',
  'REVIEW_VELOCITY_LOW',
  'REVIEW_RATING_BELOW_SET',
  'REVIEW_RESPONSE_RATE_LOW',
  'REVIEW_RESPONSE_ABSENT_NEGATIVE',
  'REVIEW_RECENCY_STALE',
] as const;

/**
 * Codes a capped sample cannot support, because they are rates and dates read off the
 * review list rather than aggregates the source states outright.
 */
export const NEEDS_FULL_HISTORY = [
  'REVIEW_VELOCITY_LOW',
  'REVIEW_RESPONSE_RATE_LOW',
  'REVIEW_RECENCY_STALE',
] as const;

/** Codes that need the source to expose owner replies. */
export const NEEDS_REPLIES = [
  'REVIEW_RESPONSE_RATE_LOW',
  'REVIEW_RESPONSE_ABSENT_NEGATIVE',
] as const;

export function createReviewsCollector(provider: ReviewsProvider): Collector<ReviewsCapture> {
  return {
    name: 'reviews',
    requires_auth: false,
    segments: ['smb', 'dtc'],
    emits: REVIEWS_EMITS,

    async collect(
      target: CollectTarget,
      _ctx: CollectContext,
    ): Promise<Priced<ReviewsCapture | null>> {
      return provider.fetchReviews(target.place.place_id);
    },

    normalise(raw: ReviewsCapture | null, ctx: NormaliseContext): FindingSeed[] {
      return normaliseReviews(raw, ctx);
    },

    peerStats(raws: (ReviewsCapture | null)[], ctx: { now: Date }): PeerStats {
      return reviewsPeerStats(
        raws.filter((c): c is ReviewsCapture => c !== null),
        ctx.now,
      );
    },
  };
}

/**
 * Build peer medians and bests from every capture in a scan.
 *
 * Runs after collection, before normalisation, so the report can say "0.2 reviews a month
 * against a competitor best of 5.9" rather than asserting neglect against nothing.
 *
 * Metrics a given competitor's source could not support are left out of that metric's
 * sample rather than counted as zero — a competitor whose reviews came back as a sample
 * has no velocity, which is not the same as having no reviews.
 */
export function reviewsPeerStats(captures: ReviewsCapture[], now: Date): PeerStats {
  const stats: PeerStats = { median: {}, best: {} };

  const put = (key: string, values: number[]): void => {
    const mid = median(values);
    if (mid === null) return;
    stats.median[key] = mid;
    stats.best[key] = Math.max(...values);
  };

  put(
    PEER_KEYS.count,
    captures.map((c) => c.review_count),
  );

  put(
    PEER_KEYS.rating,
    captures.map((c) => c.rating).filter((r): r is number => r !== null),
  );

  put(
    PEER_KEYS.velocity,
    captures.map((c) => velocityOf(c, now)).filter((v): v is number => v !== null),
  );

  put(
    PEER_KEYS.response_rate,
    captures
      .filter(repliesVisible)
      .map(responseRateOf)
      .filter((r): r is number => r !== null),
  );

  return stats;
}

export * from './types';
export * from './normalise';
