/**
 * Local rank — raw capture shape and the keyword plan it runs against.
 *
 * Unlike every collector before it, the thing being bought here is not per-business. One
 * map pack query returns the subject *and* every competitor in a single response, so the
 * purchase is scan-level even though the capture is per-target. `scanSerpCache` in
 * `./index.ts` is what keeps six targets from buying the same ten queries six times.
 */

import type { MapPackEntry } from '../../resolve/providers';
import type { Timestamp } from '../shared';

export interface Keyword {
  term: string;
  /**
   * Whether this term carries buying intent.
   *
   * "emergency plumber wandsworth" is a job; "how to bleed a radiator" is homework. Which
   * is which is a judgement rather than an observation, and it is why
   * `LOCALRANK_NO_MONEY_KEYWORD_COVERAGE` is the one `estimated` code this collector emits.
   */
  money: boolean;
}

export interface KeywordPlan {
  keywords: Keyword[];
  /**
   * The point positions are measured from.
   *
   * Local rank is not a single number — it is a position at a location. Two postcodes four
   * miles apart see different packs, so the report has to say where it looked.
   */
  near: { lat: number; lng: number };
}

export interface KeywordRank {
  keyword: string;
  money: boolean;
  /** 1-based position in the pack. Null when the business is not in it at all. */
  position: number | null;
  /** The pack as returned, so "who is above you" needs no second query. */
  pack: MapPackEntry[];
}

export interface FailedKeyword {
  keyword: string;
  message: string;
}

export interface LocalRankCapture {
  place_id: string;
  /** Where the pack was measured from. Goes in the report. */
  near: { lat: number; lng: number };
  ranks: KeywordRank[];
  /** Queries that errored. A dead keyword thins the section; it does not fail the scan. */
  failed_keywords: FailedKeyword[];
  captured_at: Timestamp;
}
