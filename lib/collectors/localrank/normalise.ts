/**
 * Local rank normalise rules — pure, no I/O.
 *
 * Position is the one metric where lower is better, and getting that backwards would
 * invert every comparison in the section. The registry says so (`polarity: lower_better`)
 * and the peer helper in `./index.ts` takes `best` as the *minimum* rather than the
 * maximum for exactly that reason.
 */

import { isDirectory } from '../../resolve/competitors';
import type { MapPackEntry } from '../../resolve/providers';
import { median, type FindingSeed, type NormaliseContext } from '../types';
import type { KeywordRank, LocalRankCapture } from './types';

/**
 * Positions 1–3 are the map pack proper — what a searcher sees without tapping through.
 * Being ranked 8th and being absent are nearly the same commercial outcome, but they are
 * different facts, and the report reports the fact.
 */
export const MAP_PACK_VISIBLE = 3;

/** Money-keyword coverage below this is a gap rather than a near miss. */
export const MIN_MONEY_COVERAGE_PERCENT = 50;

/**
 * How many money keywords a competitor must beat the subject on before it is worth naming.
 * One is a coincidence; a pattern is the finding.
 */
export const MIN_CONTESTED_KEYWORDS = 2;

/** How many keywords to quote per finding. */
const MAX_QUOTED = 5;

/** Peer metric keys, shared with the aggregation step. */
export const PEER_KEYS = {
  median_position: 'localrank.median_position',
  coverage: 'localrank.money_coverage_percent',
} as const;

const round = (n: number, dp: number): number => {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
};

const peerMedian = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.median[key] ?? null;

const peerBest = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.best[key] ?? null;

/**
 * Median position across the *money* keywords a business appears for. Null if none.
 *
 * Money-only deliberately. A business can rank second for a how-to article it wrote years
 * ago while being invisible for every job in the area, and letting that into the median
 * turns a position of 5 into 3.5 — flattering the number the whole comparison rests on.
 *
 * Both sides of the comparison come through here, so the subject and its peers are always
 * measured the same way.
 */
export function medianPosition(ranks: KeywordRank[]): number | null {
  return median(
    ranks
      .filter((r) => r.money)
      .map((r) => r.position)
      .filter((p): p is number => p !== null),
  );
}

/** Share of money keywords the business appears for at all, 0–100. Null with no money keywords. */
export function moneyCoverage(ranks: KeywordRank[]): number | null {
  const money = ranks.filter((r) => r.money);
  if (money.length === 0) return null;
  const covered = money.filter((r) => r.position !== null).length;
  return round((covered / money.length) * 100, 1);
}

/**
 * Absent counts as worse than any position.
 *
 * Without this, "they rank 4th and we are nowhere" compares 4 against null and quietly
 * decides nobody won.
 */
const worseThan = (subject: number | null, rival: number): boolean =>
  subject === null || subject > rival;

interface Contest {
  place_id: string;
  name: string;
  /** Money keywords where this place ranked above the subject. */
  keywords: Array<{ keyword: string; subject_position: number | null; rival_position: number }>;
}

/**
 * Who is beating the subject on money keywords, most contested first.
 *
 * Directories are excluded: Checkatrade outranking a plumber is a fact about Checkatrade,
 * not a competitive gap the client can act on, and putting it in a paid report as
 * "outranked by a direct competitor" would be wrong.
 */
export function contestedBy(ranks: KeywordRank[]): Contest[] {
  const byPlace = new Map<string, Contest>();

  for (const rank of ranks) {
    if (!rank.money) continue;

    for (const entry of rank.pack) {
      if (entry.place_id === undefined) continue;
      if (!worseThan(rank.position, entry.position)) continue;
      if (isDirectory({ name: entry.name, domain: null })) continue;

      const contest = byPlace.get(entry.place_id) ?? {
        place_id: entry.place_id,
        name: entry.name,
        keywords: [],
      };
      contest.keywords.push({
        keyword: rank.keyword,
        subject_position: rank.position,
        rival_position: entry.position,
      });
      byPlace.set(entry.place_id, contest);
    }
  }

  return [...byPlace.values()].sort((a, b) => b.keywords.length - a.keywords.length);
}

/** The rival's median position across the keywords it contested. */
const rivalMedian = (contest: Contest): number | null =>
  median(contest.keywords.map((k) => k.rival_position));

export function normaliseLocalRank(
  capture: LocalRankCapture | null,
  ctx: NormaliseContext,
): FindingSeed[] {
  // No listing to rank. `gbp` already reports GBP_MISSING for that.
  if (!capture) return [];

  const seeds: FindingSeed[] = [];
  const { ranks } = capture;
  if (ranks.length === 0) return seeds;

  const money = ranks.filter((r) => r.money);
  const coverage = moneyCoverage(ranks);
  const subjectMedian = medianPosition(ranks);

  const measuredAt = {
    measured_near: capture.near,
    keywords_checked: ranks.length,
    money_keywords_checked: money.length,
    keywords_failed: capture.failed_keywords.map((f) => f.keyword),
  };

  // --- absent from every money keyword -------------------------------------
  // Reserved for genuinely invisible: absent for one keyword of ten is a coverage
  // problem, not a critical one, and firing `critical` on it would train the reader to
  // skim past the severity.
  const uncovered = money.filter((r) => r.position === null);
  if (money.length > 0 && uncovered.length === money.length) {
    seeds.push({
      code: 'LOCALRANK_ABSENT',
      measured_text: `absent from all ${money.length} money keywords`,
      evidence: {
        ...measuredAt,
        keywords: uncovered.slice(0, MAX_QUOTED).map((r) => r.keyword),
        note: 'The business does not appear in the local pack for any buying-intent search.',
      },
    });
  }

  // --- money keyword coverage ----------------------------------------------
  // Deliberately overlaps LOCALRANK_ABSENT at 0%. That code is binary and carries no
  // measurement, so suppressing this one at zero would punch a hole in the benchmark
  // exactly where the worst businesses are and bias every percentile optimistic.
  if (coverage !== null && coverage < MIN_MONEY_COVERAGE_PERCENT) {
    seeds.push({
      code: 'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE',
      measured_value: coverage,
      measured_text: `${coverage}% of money keywords`,
      benchmark_value: peerBest(ctx, PEER_KEYS.coverage),
      benchmark_source: peerMedian(ctx, PEER_KEYS.coverage) === null ? 'absolute' : 'competitor_best',
      evidence: {
        ...measuredAt,
        coverage_percent: coverage,
        covered: money.length - uncovered.length,
        threshold_percent: MIN_MONEY_COVERAGE_PERCENT,
        missing_keywords: uncovered.slice(0, MAX_QUOTED).map((r) => r.keyword),
        competitor_median: peerMedian(ctx, PEER_KEYS.coverage),
      },
    });
  }

  // --- position against the competitor set ---------------------------------
  // Comparative by definition: with no peer set there is no median to be below.
  const peerPosition = peerMedian(ctx, PEER_KEYS.median_position);
  if (subjectMedian !== null && peerPosition !== null && subjectMedian > peerPosition) {
    seeds.push({
      code: 'LOCALRANK_BELOW_MEDIAN',
      measured_value: subjectMedian,
      measured_text: `median position ${subjectMedian}`,
      benchmark_value: peerBest(ctx, PEER_KEYS.median_position),
      benchmark_source: 'competitor_best',
      evidence: {
        ...measuredAt,
        median_position: subjectMedian,
        competitor_median: peerPosition,
        competitor_best: peerBest(ctx, PEER_KEYS.median_position),
        in_visible_pack: subjectMedian <= MAP_PACK_VISIBLE,
        visible_pack_size: MAP_PACK_VISIBLE,
      },
    });
  }

  // --- the competitor actually taking the work -----------------------------
  const [worst] = contestedBy(ranks);
  if (worst && worst.keywords.length >= MIN_CONTESTED_KEYWORDS) {
    const theirMedian = rivalMedian(worst);
    seeds.push({
      code: 'LOCALRANK_LOST_TO_COMPETITOR',
      measured_value: subjectMedian,
      measured_text: `beaten by ${worst.name} on ${worst.keywords.length} of ${money.length} money keywords`,
      benchmark_value: theirMedian,
      benchmark_source: 'competitor_best',
      evidence: {
        ...measuredAt,
        competitor_name: worst.name,
        competitor_place_id: worst.place_id,
        keywords_lost: worst.keywords.length,
        money_keywords: money.length,
        subject_median_position: subjectMedian,
        competitor_median_position: theirMedian,
        examples: worst.keywords.slice(0, MAX_QUOTED),
      },
    });
  }

  return seeds;
}

/** Re-exported so the peer helper and tests share one notion of a pack entry. */
export type { MapPackEntry };
