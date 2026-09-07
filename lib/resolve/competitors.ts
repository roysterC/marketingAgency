/**
 * Competitor selection.
 *
 * docs/teardown-engine.md §2.1 calls this the highest-leverage decision in the pipeline:
 * get the set wrong and every comparison downstream is meaningless, benchmarks included.
 *
 * The core signal is keyword overlap. A business appearing in the map pack for 7 of the
 * subject's 10 money keywords is competing for the same jobs; one appearing for a single
 * keyword is a coincidence. Proximity and rank position refine that, they don't drive it.
 *
 * Pure — no I/O. The orchestrator enriches candidates before calling this, so selection
 * can be tested exhaustively without API keys.
 */

import { distanceKm, kmToMiles } from './geo';
import { isComparableCategory, toVertical } from './vertical';
import type {
  Candidate,
  Place,
  RejectedCandidate,
  ScoreBreakdown,
  SelectedCompetitor,
  SelectionOptions,
} from './types';

export const DEFAULT_RADIUS_KM = 16; // ~10 miles
export const DEFAULT_MAX_COMPETITORS = 6;
export const DEFAULT_MIN_COMPETITORS = 3;

/** Weights sum to 1. Exported so they can be tuned against real scans and argued about. */
export const WEIGHTS = {
  keyword_overlap: 0.6,
  position_strength: 0.2,
  proximity: 0.2,
} as const;

/** The actual Google map pack. Three slots — anything past this is the wider local list. */
export const MAP_PACK_SIZE = 3;

/**
 * How deep local results are worth scoring before rank stops meaning anything.
 *
 * The first live scan is what set this. A linear decay over a reference of 10 scored every
 * competitor past position 10 as identically zero, and real data sits well past there —
 * that scan returned medians of 4, 23, 47 and 56. Rank value decays sharply rather than
 * linearly, so a log curve keeps the top three dominant while still telling position 20
 * from position 60 instead of flattening both to nothing.
 */
const POSITION_HORIZON = 100;

/**
 * Median, not mean.
 *
 * Same reasoning as `localrank`: one deep result among strong ones drags an average far
 * enough to misrepresent the business. A local copy rather than the one in
 * `collectors/types` because collectors already import from resolve, and reaching back
 * the other way would close a cycle.
 */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Directories and aggregators. These dominate local map packs and are never competitors —
 * a plumber does not lose work to Checkatrade, they lose it to the plumber ranked above
 * them. Leaving these in produces a report the prospect immediately dismisses.
 *
 * Matching is done on a normalised string (lowercased, non-alphanumerics stripped) because
 * the same brand arrives spelled several ways: "Rated People", "RatedPeople",
 * "ratedpeople.com". Comparing raw text misses most of them.
 */
const DIRECTORY_NEEDLES = [
  'checkatrade',
  'mybuilder',
  'ratedpeople',
  'trustatrader',
  'trustedtrader',
  'thomsonlocal',
  'trustpilot',
  'tripadvisor',
  'houzz',
  'localheroes',
  'threebestrated',
  'freeindex',
  'yellcom',
  'barkcom',
];

/**
 * Names that are only a directory when they are the whole name. Substring matching on
 * these would exclude real businesses — "Yellow Brick Plumbing" contains "yell".
 */
const DIRECTORY_EXACT = ['yell', 'bark', 'facebook', 'google', 'yelp'];

const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

export function isDirectory(place: Pick<Place, 'name' | 'domain'>): boolean {
  const name = normalise(place.name);
  const domain = normalise(place.domain ?? '');

  if (DIRECTORY_EXACT.includes(name)) return true;
  return DIRECTORY_NEEDLES.some((needle) => name.includes(needle) || domain.includes(needle));
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function scoreOf(
  candidate: Candidate,
  subject: Place,
  keywordsTotal: number,
  radiusKm: number,
): { score: number; breakdown: ScoreBreakdown } {
  const matched = candidate.appearances.length;
  const keywordOverlap = keywordsTotal > 0 ? clamp01(matched / keywordsTotal) : 0;

  const positions = candidate.appearances.map((a) => Math.max(1, a.position));
  const medianPosition = medianOf(positions) ?? POSITION_HORIZON;
  const bestPosition = positions.length > 0 ? Math.min(...positions) : POSITION_HORIZON;
  const topThree = positions.filter((p) => p <= MAP_PACK_SIZE).length;

  // Log decay: position 1 scores 1.0, 3 scores 0.76, 10 scores 0.50, 50 scores 0.15.
  const positionStrength = clamp01(
    1 - Math.log(medianPosition) / Math.log(POSITION_HORIZON),
  );

  const dKm = distanceKm(subject, candidate);
  const proximity = radiusKm > 0 ? clamp01(1 - dKm / radiusKm) : 0;

  const score =
    WEIGHTS.keyword_overlap * keywordOverlap +
    WEIGHTS.position_strength * positionStrength +
    WEIGHTS.proximity * proximity;

  return {
    score,
    breakdown: {
      keyword_overlap: keywordOverlap,
      position_strength: positionStrength,
      proximity,
      keywords_matched: matched,
      keywords_total: keywordsTotal,
      median_position: medianPosition,
      best_position: bestPosition,
      top_three: topThree,
      distance_km: dKm,
    },
  };
}

/**
 * The sentence a prospect reads next to a competitor's name.
 *
 * Built from measured values only. "A similar local business" is worthless; "ranks for 7
 * of your 10 money keywords, 0.8 miles away" survives being challenged.
 */
export function buildRationale(
  candidate: Candidate,
  breakdown: ScoreBreakdown,
  subjectCategory: string | null,
): string {
  const parts: string[] = [];

  // "Map pack" means the three-result block, so it is simply false above position 3 — and
  // the first live scan produced medians of 23, 47 and 56 under that wording. A prospect
  // who spots "map pack, average position 52" stops trusting the rest of the document.
  parts.push(
    `Appears in local results for ${breakdown.keywords_matched} of your ` +
      `${breakdown.keywords_total} money keyword${breakdown.keywords_total === 1 ? '' : 's'}` +
      ` — ${breakdown.top_three === 0 ? 'none' : breakdown.top_three} in the top ` +
      `${MAP_PACK_SIZE}, median position ${breakdown.median_position.toFixed(0)}`,
  );

  const miles = kmToMiles(breakdown.distance_km);
  parts.push(miles < 0.1 ? 'at essentially the same location' : `${miles.toFixed(1)} miles away`);

  if (subjectCategory && candidate.primary_category) {
    parts.push(`same primary category (${candidate.primary_category})`);
  }

  return `${parts.join(', ')}.`;
}

export interface SelectionResult {
  competitors: SelectedCompetitor[];
  rejected: RejectedCandidate[];
  warnings: string[];
}

/**
 * Choose the competitor set.
 *
 * Hard filters run before scoring — being the subject, being a directory, being in a
 * different vertical or outside the radius are disqualifying regardless of how well a
 * candidate would otherwise score.
 *
 * A thin result is returned with a warning rather than throwing. The scan proceeds with
 * fewer comparisons; it does not die because a quiet postcode had only two plumbers.
 */
export function selectCompetitors(
  subject: Place,
  candidates: Candidate[],
  keywordsTotal: number,
  options: SelectionOptions = {},
): SelectionResult {
  const radiusKm = options.radius_km ?? DEFAULT_RADIUS_KM;
  const maxCompetitors = options.max_competitors ?? DEFAULT_MAX_COMPETITORS;
  const minCompetitors = options.min_competitors ?? DEFAULT_MIN_COMPETITORS;

  const subjectVertical = toVertical(subject.primary_category);
  const rejected: RejectedCandidate[] = [];
  const scored: SelectedCompetitor[] = [];

  for (const candidate of candidates) {
    const stub = { place_id: candidate.place_id, name: candidate.name };

    if (candidate.place_id === subject.place_id) {
      rejected.push({ ...stub, reason: 'is_subject' });
      continue;
    }
    if (isDirectory(candidate)) {
      rejected.push({ ...stub, reason: 'directory' });
      continue;
    }
    if (!isComparableCategory(subjectVertical, toVertical(candidate.primary_category))) {
      rejected.push({ ...stub, reason: 'category_mismatch' });
      continue;
    }

    const { score, breakdown } = scoreOf(candidate, subject, keywordsTotal, radiusKm);

    if (breakdown.distance_km > radiusKm) {
      rejected.push({ ...stub, reason: 'out_of_radius' });
      continue;
    }

    scored.push({
      place: candidate,
      score,
      breakdown,
      rationale: buildRationale(candidate, breakdown, subject.primary_category),
    });
  }

  // Highest score first; ties broken by keyword overlap so the more direct competitor wins.
  scored.sort(
    (a, b) =>
      b.score - a.score || b.breakdown.keywords_matched - a.breakdown.keywords_matched,
  );

  const competitors = scored.slice(0, maxCompetitors);
  for (const dropped of scored.slice(maxCompetitors)) {
    rejected.push({
      place_id: dropped.place.place_id,
      name: dropped.place.name,
      reason: 'below_cut',
    });
  }

  const warnings: string[] = [];
  if (competitors.length < minCompetitors) {
    warnings.push(
      `Only ${competitors.length} comparable competitor${competitors.length === 1 ? '' : 's'} ` +
        `found within ${kmToMiles(radiusKm).toFixed(0)} miles — comparisons in this report ` +
        `are based on a small set.`,
    );
  }
  if (competitors.length === 0) {
    warnings.push('No competitors selected; competitive sections will be omitted.');
  }

  return { competitors, rejected, warnings };
}

/** Collapse map-pack appearances into one candidate per place. */
export function groupAppearances(
  appearances: Array<{ keyword: string; position: number; place: Place }>,
): Candidate[] {
  const byPlace = new Map<string, Candidate>();

  for (const { keyword, position, place } of appearances) {
    const existing = byPlace.get(place.place_id);
    if (existing) {
      existing.appearances.push({
        keyword,
        position,
        place_id: place.place_id,
        name: place.name,
      });
      continue;
    }
    byPlace.set(place.place_id, {
      ...place,
      appearances: [{ keyword, position, place_id: place.place_id, name: place.name }],
    });
  }

  return [...byPlace.values()];
}
