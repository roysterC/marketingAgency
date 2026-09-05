/**
 * Reviews — raw capture shape and provider interface.
 *
 * Two things a source may not give us. Both are handled the way `gbp` handles its
 * warm-only fields: absent rather than zero, because reporting a gap we merely could not
 * see would be a false finding in a paid report.
 *
 * 1. **Coverage.** The Places API returns the aggregate rating and count alongside at most
 *    five reviews. Volume and rating survive that cap because they are aggregates;
 *    velocity, recency and reply rate do not, because they are derived from the list
 *    itself. A five-review sample cannot establish that the newest review is eight months
 *    old — only that the newest one it happened to return is.
 * 2. **Replies.** Places does not expose owner responses at all. A dedicated reviews API
 *    does, and that is still public data bought properly rather than scraped — see
 *    `docs/data-sources.md`. When the source is silent, `replied_at` is undefined and the
 *    reply rules do not run.
 *
 * The practical consequence, worth knowing before pricing the cold audit: a Places-only
 * provider supports two of the six codes. A reviews API supports all six, cold. See
 * `NEEDS_FULL_HISTORY` and `NEEDS_REPLIES` in `./index.ts`.
 */

import type { Priced } from '../../resolve/providers';
import type { Timestamp } from '../shared';

export interface Review {
  /** Stable per-source id, so the same review is recognisable across scans. */
  id: string;
  /** Stars, 1–5. */
  rating: number;
  published_at: Timestamp;
  text: string | null;
  author: string | null;
  /**
   * When the owner replied; `null` when they have not.
   *
   * `undefined` means the source does not report replies — which is not the same as
   * there being no reply, and the reply rules skip it accordingly.
   */
  replied_at?: Timestamp | null;
}

/**
 * How much of the review history the source returned.
 *
 * `complete` — every review is present, so rates and dates derived from the list hold.
 * `sample`   — a capped subset. Only the aggregate count and rating can be trusted.
 */
export type ReviewCoverage = 'complete' | 'sample';

export interface ReviewsCapture {
  place_id: string;
  /** Mean star rating as the source reports it. Aggregate — trustworthy under `sample`. */
  rating: number | null;
  /** Total reviews as the source reports it. Aggregate — trustworthy under `sample`. */
  review_count: number;
  reviews: Review[];
  coverage: ReviewCoverage;
  captured_at: Timestamp;
}

export interface ReviewsProvider {
  readonly name: string;
  /** Returns null when the place has no reviews surface at all. */
  fetchReviews(placeId: string): Promise<Priced<ReviewsCapture | null>>;
}
