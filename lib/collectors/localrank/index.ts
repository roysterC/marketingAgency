/**
 * The `localrank` collector.
 *
 * The first collector whose purchase is scan-level rather than per-target. One map pack
 * query returns the subject and every competitor in a single response, so six targets
 * running the same ten keywords is the same data bought six times — £0.30 becoming £1.80
 * against a £5 ceiling for the whole scan, for nothing. `scanSerpCache` fixes that at the
 * provider boundary, leaving the collector interface alone.
 */

import type { MapPackEntry, Priced, SerpProvider } from '../../resolve/providers';
import { createScanCache } from '../scan-cache';
import {
  attempt,
  median,
  type CollectContext,
  type CollectTarget,
  type Collector,
  type FindingSeed,
  type NormaliseContext,
  type PeerStats,
} from '../types';
import { PEER_KEYS, medianPosition, moneyCoverage, normaliseLocalRank } from './normalise';
import type { FailedKeyword, KeywordPlan, KeywordRank, LocalRankCapture } from './types';

/** Every code this collector may emit. Verified against the registry in tests. */
export const LOCALRANK_EMITS = [
  'LOCALRANK_ABSENT',
  'LOCALRANK_BELOW_MEDIAN',
  'LOCALRANK_LOST_TO_COMPETITOR',
  'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE',
] as const;

/**
 * One purchase per keyword, however many targets ask for it.
 *
 * Wrap the SERP provider once per scan and hand the same instance to every target. See
 * `../scan-cache.ts` for what the wrapper guarantees; `aivis` uses the same mechanism for
 * the same reason.
 */
export function scanSerpCache(serp: SerpProvider): SerpProvider {
  const cached = createScanCache(
    (request: { keyword: string; near: { lat: number; lng: number } }) =>
      serp.mapPack(request.keyword, request.near),
    ({ keyword, near }) => `${keyword.trim().toLowerCase()}@${near.lat},${near.lng}`,
  );

  return {
    name: `${serp.name}+scan-cache`,
    mapPack: (keyword, near): Promise<Priced<MapPackEntry[]>> => cached({ keyword, near }),
  };
}

export function createLocalRankCollector(
  serp: SerpProvider,
  plan: KeywordPlan,
): Collector<LocalRankCapture> {
  return {
    name: 'localrank',
    requires_auth: false,
    // A pure online brand has no local pack to appear in.
    segments: ['smb'],
    emits: LOCALRANK_EMITS,

    async collect(
      target: CollectTarget,
      _ctx: CollectContext,
    ): Promise<Priced<LocalRankCapture | null>> {
      // Keywords are queried in parallel; the cache shares in-flight requests, so a scan
      // of six targets still makes one round of calls rather than six.
      const results = await Promise.all(
        plan.keywords.map(async (keyword) => ({
          keyword,
          outcome: await attempt(() => serp.mapPack(keyword.term, plan.near)),
        })),
      );

      const ranks: KeywordRank[] = [];
      const failed: FailedKeyword[] = [];
      let pence = 0;

      for (const { keyword, outcome } of results) {
        pence += outcome.cost.pence;

        if (outcome.value === null) {
          failed.push({ keyword: keyword.term, message: outcome.error ?? 'unknown error' });
          continue;
        }

        const entry = outcome.value.find((e) => e.place_id === target.place.place_id);
        ranks.push({
          keyword: keyword.term,
          money: keyword.money,
          position: entry?.position ?? null,
          pack: outcome.value,
        });
      }

      return {
        value: {
          place_id: target.place.place_id,
          near: plan.near,
          ranks,
          failed_keywords: failed,
          captured_at: new Date().toISOString(),
        },
        cost: { pence },
      };
    },

    normalise(raw: LocalRankCapture | null, ctx: NormaliseContext): FindingSeed[] {
      return normaliseLocalRank(raw, ctx);
    },
  };
}

/**
 * Build peer stats from every competitor's capture.
 *
 * Position is the one metric in the engine where lower is better, so `best` here is the
 * **minimum**, not the maximum. Coverage is an ordinary higher-is-better percentage. Both
 * live in the same `PeerStats` bag, so the polarity has to be applied where the numbers
 * are produced rather than assumed downstream.
 */
export function localRankPeerStats(captures: LocalRankCapture[]): PeerStats {
  const stats: PeerStats = { median: {}, best: {} };

  const positions = captures
    .map((c) => medianPosition(c.ranks))
    .filter((p): p is number => p !== null);

  const positionMedian = median(positions);
  if (positionMedian !== null) {
    stats.median[PEER_KEYS.median_position] = positionMedian;
    // Lower is better: the strongest competitor is the one nearest position 1.
    stats.best[PEER_KEYS.median_position] = Math.min(...positions);
  }

  const coverages = captures
    .map((c) => moneyCoverage(c.ranks))
    .filter((c): c is number => c !== null);

  const coverageMedian = median(coverages);
  if (coverageMedian !== null) {
    stats.median[PEER_KEYS.coverage] = coverageMedian;
    stats.best[PEER_KEYS.coverage] = Math.max(...coverages);
  }

  return stats;
}

export * from './types';
export * from './normalise';
