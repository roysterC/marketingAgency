/**
 * Resolve stage — types.
 *
 * Turns a scan request into a subject plus a competitor set. See docs/teardown-engine.md §2.1.
 *
 * Nothing here touches the database. `resolveScan` returns a plain result and a separate
 * persistence step writes it, so the whole stage is testable without Postgres or API keys.
 */

import type { Segment } from '../taxonomy/enums';

/** A place as returned by the places provider. */
export interface Place {
  place_id: string;
  name: string;
  /** Google's primary category, verbatim. Mapped to a vertical separately. */
  primary_category: string | null;
  lat: number;
  lng: number;
  domain: string | null;
  postcode: string | null;
  phone: string | null;
}

/** One appearance of a place in a map pack, for one keyword. */
export interface MapPackAppearance {
  keyword: string;
  /** 1-based position within the pack. */
  position: number;
  place_id: string;
  name: string;
}

/** A candidate competitor, enriched with the detail needed to judge it. */
export interface Candidate extends Place {
  appearances: MapPackAppearance[];
}

/** A competitor that survived selection, with the reasoning that got it there. */
export interface SelectedCompetitor {
  place: Place;
  /** 0..1. Higher is a closer competitor. */
  score: number;
  /**
   * Human-readable justification, rendered in the report. The first thing a sceptical
   * prospect challenges, so it quotes real numbers rather than asserting relevance.
   */
  rationale: string;
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  /** Fraction of the subject's money keywords this business also ranks for. */
  keyword_overlap: number;
  /** How high it ranks on those keywords, normalised. */
  position_strength: number;
  /** Closeness, normalised against the search radius. */
  proximity: number;
  keywords_matched: number;
  keywords_total: number;
  average_position: number;
  distance_km: number;
}

/** Why a candidate was dropped. Kept for debugging a thin competitor set. */
export interface RejectedCandidate {
  place_id: string;
  name: string;
  reason: 'is_subject' | 'directory' | 'category_mismatch' | 'out_of_radius' | 'below_cut';
}

export interface SelectionOptions {
  radius_km?: number;
  max_competitors?: number;
  min_competitors?: number;
}

/** Output of the resolve stage. */
export interface ResolveResult {
  subject: Place;
  vertical: string | null;
  region: string | null;
  platform: string | null;
  segment: Segment;
  keyword_set: string[];
  competitors: SelectedCompetitor[];
  rejected: RejectedCandidate[];
  /**
   * Non-fatal problems. A thin competitor set degrades the report but does not fail the
   * scan — collectors and stages fail independently (CLAUDE.md rule 5).
   */
  warnings: string[];
}
