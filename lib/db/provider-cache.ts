/**
 * One purchase per business per week, however many scans ask for it.
 *
 * `collectors/scan-cache.ts` already stops a single scan buying the same response six
 * times. This is the other half of the problem, and the billing data is what surfaced it:
 * three runs against the same Birmingham plumber bought review history for the same six
 * place_ids three times over, because nothing survives the end of a process.
 *
 * The re-runs are the small half. The structural waste is that competitor sets overlap:
 * ten plumbers in one city are drawn from a pool of maybe twenty ranking businesses, so
 * scanning all ten buys most of those businesses three or four times.
 *
 * What is safe to cache is decided by whether the answer moves:
 *
 * - **Cached.** Review history, Business Profiles, site vitals. These change over weeks.
 * - **Never cached.** Map-pack positions and AI answers. Those are the measurement —
 *   rankings move daily, and A3 tracks citation movement across runs, so serving a stored
 *   answer would report yesterday's position as today's finding. `scan-cache.ts` says the
 *   same thing about sharing a cache across scans, and it is right about those two.
 *
 * A hit costs nothing, and records nothing, which is what `collector_runs.cost_pence`
 * should say because it is what happened.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { FREE, type Priced } from '../resolve/providers';

export const DAY_MS = 86_400_000;

/** Defaults by source. Long enough to matter, short enough that a report is not stale. */
export const TTL = {
  /** Review counts and ratings drift slowly; velocity is measured over months. */
  reviews: 7 * DAY_MS,
  /** Hours, photos and categories change rarely. */
  gbp: 7 * DAY_MS,
  /** A site is unlikely to be rebuilt mid-week. */
  places: 7 * DAY_MS,
  vitals: 1 * DAY_MS,
} as const;

interface Entry {
  value: unknown;
  stored_at: number;
}

export interface ProviderCache {
  /**
   * Wrap a priced fetch so repeat requests inside the TTL are free.
   *
   * `source` namespaces the key, so two providers asking about the same place_id do not
   * collide.
   */
  wrap<Req, Res>(
    source: string,
    ttlMs: number,
    keyOf: (request: Req) => string,
    fetch: (request: Req) => Promise<Priced<Res>>,
  ): (request: Req) => Promise<Priced<Res>>;
  /** Entries currently held, for reporting. */
  size(): number;
}

/** A cache that never hits. Fixtures and tests want the real call path, not a stored one. */
export function createNullProviderCache(): ProviderCache {
  return {
    wrap: (_source, _ttl, _keyOf, fetch) => fetch,
    size: () => 0,
  };
}

export function createFileProviderCache(path: string): ProviderCache {
  let entries: Record<string, Entry> = {};

  if (existsSync(path)) {
    try {
      entries = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>;
    } catch {
      // A corrupt cache is a cache miss, not a failed scan. Worst case is one more purchase.
      entries = {};
    }
  }

  let dirty = false;

  const flush = (): void => {
    if (!dirty) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(entries), 'utf8');
    dirty = false;
  };

  return {
    wrap<Req, Res>(
      source: string,
      ttlMs: number,
      keyOf: (request: Req) => string,
      fetch: (request: Req) => Promise<Priced<Res>>,
    ) {
      return async (request: Req): Promise<Priced<Res>> => {
        const key = `${source}:${keyOf(request)}`;
        const hit = entries[key];

        if (hit && Date.now() - hit.stored_at < ttlMs) {
          return { value: hit.value as Res, cost: FREE };
        }

        // A throw propagates uncached: a failed request is not an answer, and storing it
        // would turn one bad minute into a week of them.
        const fresh = await fetch(request);

        // `null` is a real answer — "this business has no Business Profile" costs the same
        // to establish as any other and should not be re-bought.
        entries[key] = { value: fresh.value, stored_at: Date.now() };
        dirty = true;
        flush();

        return fresh;
      };
    },

    size: () => Object.keys(entries).length,
  };
}

/** Drop expired entries. Called by the CLI so the file does not grow without bound. */
export function pruneCache(path: string, maxAgeMs: number = 7 * DAY_MS): number {
  if (!existsSync(path)) return 0;

  let entries: Record<string, Entry>;
  try {
    entries = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>;
  } catch {
    return 0;
  }

  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of Object.entries(entries)) {
    if (now - entry.stored_at >= maxAgeMs) {
      delete entries[key];
      removed += 1;
    }
  }

  if (removed > 0) writeFileSync(path, JSON.stringify(entries), 'utf8');
  return removed;
}
