/**
 * DataForSEO — `SerpProvider` (map pack) and `ReviewsProvider` (full review history).
 *
 * One vendor behind two interfaces, because the account and the auth are shared. Both are
 * bought data rather than scraped, which is the settled decision in `data-sources.md`.
 *
 * The two endpoints behave differently and the difference matters:
 *
 * - **Map pack is live.** One request, one response, priced per call. `localrank` buys
 *   each keyword once per scan through `scanSerpCache`.
 * - **Reviews are a task.** You post a task, it queues, you collect it. That is why
 *   `fetchReviews` polls, and why its timeout budget is minutes rather than seconds.
 *
 * The polling is bounded. A review task that never completes returns a Places-shaped
 * sample if one was supplied, and otherwise fails the collector — which degrades the
 * reviews section rather than the scan.
 */

import type { Cost, MapPackEntry, Priced, SerpProvider } from '../resolve/providers';
import type { Review, ReviewsCapture, ReviewsProvider } from '../collectors/reviews/types';
import { required, type Env } from './config';
import { HttpError, requestJson, type RetryPolicy } from './http';

const BASE = 'https://api.dataforseo.com/v3';

export interface DataForSeoConfig {
  login: string;
  password: string;
  languageCode?: string;
  locationCode?: number;
  serpCost?: Cost;
  reviewsCost?: Cost;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
  /** Injected so the poll loop does not sleep in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for a review task, and how often to check. */
  poll?: { attempts: number; intervalMs: number };
}

/** ~3p a keyword is the £0.30 SERP line for a ten-keyword set. */
const DEFAULT_SERP_COST: Cost = { pence: 3 };
/** ~10p a business is the review-history line in the cost table. */
const DEFAULT_REVIEWS_COST: Cost = { pence: 10 };

/** United Kingdom, in DataForSEO's location codes. */
const UK_LOCATION_CODE = 2826;

const DEFAULT_POLL = { attempts: 20, intervalMs: 3_000 };

const authHeader = (login: string, password: string): string =>
  `Basic ${Buffer.from(`${login}:${password}`).toString('base64')}`;

interface TaskEnvelope<T> {
  status_code?: number;
  status_message?: string;
  tasks?: Array<{
    id?: string;
    status_code?: number;
    status_message?: string;
    result?: T[] | null;
  }>;
}

/**
 * DataForSEO reports failures in the body with a 200 status.
 *
 * Its own codes are the ones that matter: 20000 is success, 20100 means the task is
 * accepted but not ready, and anything else is a real failure that should not be retried
 * as though it were a network blip.
 */
export function unwrap<T>(body: TaskEnvelope<T>, what: string): { id: string | null; result: T[] | null } {
  const task = body.tasks?.[0];
  if (!task) throw new Error(`DataForSEO returned no task for ${what}: ${body.status_message ?? ''}`);

  const code = task.status_code ?? body.status_code ?? 0;
  const accepted = code === 20000 || code === 20100;
  if (!accepted) {
    throw new Error(`DataForSEO ${what} failed (${code}): ${task.status_message ?? 'no message'}`);
  }

  return { id: task.id ?? null, result: task.result ?? null };
}

// --------------------------------------------------------------------- SERP

interface RawMapItem {
  type?: string;
  rank_absolute?: number;
  title?: string;
  place_id?: string;
  cid?: string;
}

export function toMapPack(items: RawMapItem[]): MapPackEntry[] {
  return items
    .filter((item) => item.type === 'maps_search' && (item.place_id ?? item.cid))
    .map((item, index) => ({
      place_id: (item.place_id ?? item.cid)!,
      name: item.title ?? '',
      // Prefer the rank the API states; fall back to arrival order so a missing field
      // never silently makes everything position 0.
      position: item.rank_absolute ?? index + 1,
    }));
}

export function createSerpProvider(config: DataForSeoConfig): SerpProvider {
  const {
    login,
    password,
    languageCode = 'en',
    locationCode = UK_LOCATION_CODE,
    serpCost = DEFAULT_SERP_COST,
    retry,
    fetchImpl,
  } = config;

  return {
    name: 'dataforseo-maps',

    async mapPack(keyword, near): Promise<Priced<MapPackEntry[]>> {
      const body = await requestJson<TaskEnvelope<{ items?: RawMapItem[] }>>(
        `${BASE}/serp/google/maps/live/advanced`,
        {
          method: 'POST',
          headers: { authorization: authHeader(login, password) },
          body: [
            {
              keyword,
              language_code: languageCode,
              location_code: locationCode,
              // Positions are only meaningful from a point — the same reason the capture
              // records `near`.
              location_coordinate: `${near.lat},${near.lng},10`,
              device: 'mobile',
            },
          ],
          timeoutMs: 45_000,
          ...(retry ? { retry } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
        },
      );

      const { result } = unwrap(body, `map pack for "${keyword}"`);
      return { value: toMapPack(result?.[0]?.items ?? []), cost: serpCost };
    },
  };
}

// ------------------------------------------------------------------ reviews

interface RawReview {
  review_id?: string;
  rating?: { value?: number };
  timestamp?: string;
  review_text?: string;
  profile_name?: string;
  owner_answer?: string | null;
  owner_timestamp?: string | null;
}

interface RawReviewsResult {
  rating?: { value?: number; votes_count?: number };
  reviews_count?: number;
  items?: RawReview[];
  items_count?: number;
}

export function toReviews(items: RawReview[]): Review[] {
  return items
    .filter((r) => r.timestamp && typeof r.rating?.value === 'number')
    .map((r, index) => ({
      id: r.review_id ?? `review_${index}`,
      rating: r.rating!.value!,
      published_at: new Date(r.timestamp!).toISOString(),
      text: r.review_text ?? null,
      author: r.profile_name ?? null,
      // The distinction the reviews collector rests on: this source *does* report owner
      // replies, so `null` here means genuinely unanswered rather than unknown.
      replied_at: r.owner_timestamp
        ? new Date(r.owner_timestamp).toISOString()
        : r.owner_answer
          ? new Date(r.timestamp!).toISOString()
          : null,
    }));
}

export interface ReviewsAdapterConfig extends DataForSeoConfig {
  /**
   * Used when the review task cannot be collected.
   *
   * A Places-shaped five-review sample is worth more than nothing: `coverage: 'sample'`
   * still supports the volume and rating findings, and the collector already knows not to
   * compute rates from it.
   */
  fallback?: ReviewsProvider;
}

export function createReviewsProvider(config: ReviewsAdapterConfig): ReviewsProvider {
  const {
    login,
    password,
    languageCode = 'en',
    locationCode = UK_LOCATION_CODE,
    reviewsCost = DEFAULT_REVIEWS_COST,
    retry,
    fetchImpl,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    poll = DEFAULT_POLL,
    fallback,
  } = config;

  const headers = { authorization: authHeader(login, password) };
  const options = {
    ...(retry ? { retry } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  return {
    name: 'dataforseo-reviews',

    async fetchReviews(placeId): Promise<Priced<ReviewsCapture | null>> {
      try {
        const posted = await requestJson<TaskEnvelope<unknown>>(
          `${BASE}/business_data/google/reviews/task_post`,
          {
            method: 'POST',
            headers,
            body: [
              {
                place_id: placeId,
                language_code: languageCode,
                location_code: locationCode,
                // The whole history is the point — a capped sample cannot carry velocity.
                depth: 700,
                sort_by: 'newest',
              },
            ],
            ...options,
          },
        );

        const { id } = unwrap(posted, `review task for ${placeId}`);
        if (!id) throw new Error(`DataForSEO accepted the review task but returned no id`);

        for (let attempt = 1; attempt <= poll.attempts; attempt += 1) {
          await sleep(poll.intervalMs);

          const collected = await requestJson<TaskEnvelope<RawReviewsResult>>(
            `${BASE}/business_data/google/reviews/task_get/${id}`,
            { headers, ...options },
          );

          const { result } = unwrap(collected, `review task ${id}`);
          const first = result?.[0];
          if (!first) continue;

          const items = first.items ?? [];
          return {
            value: {
              place_id: placeId,
              rating: first.rating?.value ?? null,
              review_count: first.reviews_count ?? first.rating?.votes_count ?? items.length,
              reviews: toReviews(items),
              // The whole reason to buy this rather than read Places' five.
              coverage: 'complete',
              captured_at: new Date().toISOString(),
            },
            cost: reviewsCost,
          };
        }

        throw new Error(`DataForSEO review task ${id} did not complete in time`);
      } catch (cause) {
        if (!fallback) throw cause;
        // Degrade to the aggregates rather than losing the section entirely.
        return fallback.fetchReviews(placeId);
      }
    },
  };
}

export function dataForSeoConfigFromEnv(env: Env = process.env): DataForSeoConfig {
  return {
    login: required(env, 'DATAFORSEO_LOGIN', 'map pack positions and full review history'),
    password: required(env, 'DATAFORSEO_PASSWORD', 'map pack positions and full review history'),
  };
}

export { HttpError };
