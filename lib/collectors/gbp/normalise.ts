/**
 * GBP normalise rules — pure, no I/O.
 *
 * Maps a captured profile to findings. Every rule emits measured values and renderable
 * evidence; nothing here fetches, guesses at severity, or writes to the database.
 *
 * Warm-only fields (claim status, services, posts, Q&A) are skipped when undefined rather
 * than reported as zero. Claiming "no services listed" when we simply couldn't see them
 * would be a false finding in a paid report.
 */

import type { FindingSeed, NormaliseContext } from '../types';
import type { GbpProfile } from './types';

/** Below this many photos with no peer data to compare against, flag it. */
export const MIN_PHOTOS_ABSOLUTE = 10;
/** With peer data, flag only when meaningfully behind rather than merely below median. */
export const PHOTO_SPARSE_RATIO = 0.6;
/** A profile with no post in this long reads as abandoned. */
export const STALE_POST_DAYS = 30;
/** Attribute flags below this count leave obvious ranking signal unused. */
export const MIN_ATTRIBUTES = 5;
/** A complete week of opening hours. */
export const DAYS_IN_WEEK = 7;

/** Peer metric keys, shared with the aggregation step. */
export const PEER_KEYS = {
  photos: 'gbp.photo_count',
  attributes: 'gbp.attribute_count',
  services: 'gbp.service_count',
} as const;

/**
 * Trade words that appear in business names, and the vertical they imply.
 *
 * Used for the category-mismatch heuristic: a business called "Riverside Plumbing" filed
 * under Electrician is almost certainly miscategorised, which costs it the map pack for
 * every job it actually does. Marked `estimated` in the taxonomy because it is inference,
 * not observation.
 */
const NAME_SIGNALS: Array<[RegExp, string]> = [
  [/plumb/i, 'trades.plumbing'],
  [/electric|electrical/i, 'trades.electrical'],
  [/roof/i, 'trades.roofing'],
  [/boiler|heating|gas\s*safe/i, 'trades.hvac'],
  [/locksmith/i, 'trades.locksmith'],
  [/carpent|joiner/i, 'trades.carpentry'],
  [/decorat|painter/i, 'trades.painting'],
  [/landscap|gardening/i, 'trades.landscaping'],
  [/dental|dentist/i, 'clinic.dental'],
  [/physio/i, 'clinic.physio'],
];

export function impliedVerticalFromName(name: string): string | null {
  for (const [pattern, vertical] of NAME_SIGNALS) {
    if (pattern.test(name)) return vertical;
  }
  return null;
}

const daysBetween = (from: Date, to: Date): number =>
  Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/** Deep link to the listing, so every GBP finding is one click from being verified. */
export const mapsUrl = (placeId: string): string =>
  `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;

function peerValue(ctx: NormaliseContext, key: string): number | null {
  return ctx.peers?.median[key] ?? null;
}

export function normaliseGbp(
  profile: GbpProfile | null,
  ctx: NormaliseContext,
  searched?: { name: string; postcode: string | null },
): FindingSeed[] {
  if (!profile) {
    return [
      {
        code: 'GBP_MISSING',
        evidence: {
          searched_name: searched?.name ?? null,
          searched_postcode: searched?.postcode ?? null,
          checked_at: ctx.now.toISOString(),
        },
      },
    ];
  }

  const seeds: FindingSeed[] = [];
  const url = mapsUrl(profile.place_id);

  // --- claim status (warm only) ------------------------------------------
  if (profile.claimed === false) {
    seeds.push({
      code: 'GBP_UNCLAIMED',
      evidence: { place_id: profile.place_id, maps_url: url },
    });
  }

  // --- category ------------------------------------------------------------
  const implied = impliedVerticalFromName(profile.name);
  const listedCategory = profile.primary_category;
  if (implied && listedCategory) {
    const listedVertical = toVerticalSafe(listedCategory);
    if (listedVertical && listedVertical !== implied) {
      seeds.push({
        code: 'GBP_CATEGORY_MISMATCH',
        measured_text: `${listedCategory} (name suggests ${implied.split('.')[1]})`,
        evidence: {
          business_name: profile.name,
          listed_category: listedCategory,
          implied_vertical: implied,
          listed_vertical: listedVertical,
          maps_url: url,
        },
      });
    }
  }

  // --- hours ---------------------------------------------------------------
  const dayCount = profile.regular_hours?.length ?? 0;
  if (dayCount < DAYS_IN_WEEK) {
    seeds.push({
      code: 'GBP_HOURS_INCOMPLETE',
      measured_text: `${dayCount} of ${DAYS_IN_WEEK} days set`,
      evidence: {
        days_set: dayCount,
        days_expected: DAYS_IN_WEEK,
        maps_url: url,
      },
    });
  }

  if (dayCount > 0 && (profile.special_days?.length ?? 0) === 0) {
    seeds.push({
      code: 'GBP_HOURS_STALE_HOLIDAY',
      evidence: {
        special_days_set: 0,
        maps_url: url,
        note: 'Bank holiday hours are not set, so the listing shows normal hours on days you may be closed.',
      },
    });
  }

  // --- photos --------------------------------------------------------------
  const peerPhotos = peerValue(ctx, PEER_KEYS.photos);
  const photoThreshold =
    peerPhotos === null ? MIN_PHOTOS_ABSOLUTE : peerPhotos * PHOTO_SPARSE_RATIO;

  if (profile.photo_count < photoThreshold) {
    seeds.push({
      code: 'GBP_PHOTOS_SPARSE',
      measured_value: profile.photo_count,
      benchmark_value: peerPhotos,
      benchmark_source: peerPhotos === null ? 'absolute' : 'competitor_best',
      evidence: {
        photo_count: profile.photo_count,
        competitor_median: peerPhotos,
        threshold: photoThreshold,
        maps_url: url,
      },
    });
  }

  // --- attributes ----------------------------------------------------------
  const attributeCount = Object.values(profile.attributes).filter(Boolean).length;
  const peerAttributes = peerValue(ctx, PEER_KEYS.attributes);
  const attributeThreshold = peerAttributes ?? MIN_ATTRIBUTES;

  if (attributeCount < attributeThreshold) {
    seeds.push({
      code: 'GBP_ATTRIBUTES_SPARSE',
      measured_value: attributeCount,
      benchmark_value: peerAttributes,
      benchmark_source: peerAttributes === null ? 'absolute' : 'competitor_best',
      evidence: {
        attributes_set: attributeCount,
        competitor_median: peerAttributes,
        maps_url: url,
      },
    });
  }

  // --- services (warm only) ------------------------------------------------
  if (profile.services !== undefined && profile.services.length === 0) {
    seeds.push({
      code: 'GBP_NO_SERVICES_LISTED',
      measured_value: 0,
      benchmark_value: peerValue(ctx, PEER_KEYS.services),
      evidence: { service_count: 0, maps_url: url },
    });
  }

  // --- posts (warm only) ---------------------------------------------------
  if (profile.last_post_at !== undefined) {
    const last = profile.last_post_at;
    const age = last === null ? null : daysBetween(new Date(last), ctx.now);
    if (last === null || (age !== null && age > STALE_POST_DAYS)) {
      seeds.push({
        code: 'GBP_POSTS_STALE',
        measured_value: age,
        measured_text: last === null ? 'never posted' : `${age} days ago`,
        evidence: {
          last_post_at: last,
          days_since: age,
          threshold_days: STALE_POST_DAYS,
          maps_url: url,
        },
      });
    }
  }

  // --- Q&A (warm only) -----------------------------------------------------
  if (profile.unanswered_questions !== undefined && profile.unanswered_questions > 0) {
    seeds.push({
      code: 'GBP_QNA_UNANSWERED',
      measured_value: profile.unanswered_questions,
      evidence: {
        unanswered: profile.unanswered_questions,
        maps_url: url,
      },
    });
  }

  return seeds;
}

/** Local copy to avoid a cycle back into the resolve module. */
function toVerticalSafe(category: string): string | null {
  // Deliberately narrow: only categories the name heuristic could contradict.
  const map: Record<string, string> = {
    plumber: 'trades.plumbing',
    electrician: 'trades.electrical',
    'roofing contractor': 'trades.roofing',
    roofer: 'trades.roofing',
    'hvac contractor': 'trades.hvac',
    'heating contractor': 'trades.hvac',
    locksmith: 'trades.locksmith',
    carpenter: 'trades.carpentry',
    painter: 'trades.painting',
    'painting contractor': 'trades.painting',
    landscaper: 'trades.landscaping',
    dentist: 'clinic.dental',
    'dental clinic': 'clinic.dental',
    physiotherapist: 'clinic.physio',
    'physical therapist': 'clinic.physio',
  };
  return map[category.toLowerCase().trim()] ?? null;
}
