/**
 * Bounded concurrency.
 *
 * Resolve's two loops were written serially and stayed that way through the first live
 * scan, which spent 467 of its 672 seconds outside the collectors — most of it waiting on
 * one independent request at a time. DataForSEO live turnarounds run 1-47 seconds, so five
 * keywords in series is minutes of doing nothing.
 *
 * Bounded rather than a bare `Promise.all`: enrichment can be a dozen paid lookups, and
 * firing all of them at once is how you discover a provider's rate limit in the middle of
 * a scan someone is paying for. The collectors already parallelise, and their fan-outs are
 * small enough that unbounded is fine there.
 *
 * Results come back in input order however they complete, so warnings and cost accounting
 * stay deterministic and testable.
 */

/** Concurrent SERP queries. DataForSEO is slow per call and fine with several at once. */
export const SERP_CONCURRENCY = 5;
/** Concurrent Places detail lookups. Well inside Google's per-second allowance. */
export const PLACES_CONCURRENCY = 5;

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const workers = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let next = 0;

  const run = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}

/** The outcome of one item, so a failure is data rather than a thrown run. */
export interface Settled<T> {
  value: T | null;
  error: string | null;
}

/**
 * `mapLimit` that never rejects.
 *
 * Rule 5 holds inside a stage as well as between them: one dead lookup thins the scan and
 * records why, it does not end it.
 */
export async function settleLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  return mapLimit(items, limit, async (item, index) => {
    try {
      return { value: await fn(item, index), error: null };
    } catch (cause) {
      return {
        value: null,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
  });
}
