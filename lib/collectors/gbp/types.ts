/**
 * Google Business Profile — raw capture shape and provider interface.
 *
 * IMPORTANT: the Places API does not expose everything a Business Profile contains.
 * Claim status, services, posts and Q&A come from the Business Profile API, which needs
 * the owner's authorisation — so they are only available in warm mode.
 *
 * Those fields are optional here rather than absent. A cold provider leaves them
 * undefined and normalise simply doesn't emit the corresponding findings; a warm provider
 * fills them in and the same normalise rules light up. No branching, no second raw shape.
 */

import type { Priced } from '../../resolve/providers';
import type { Timestamp } from '../shared';

/** Opening hours for one weekday. `null` periods means closed that day. */
export interface GbpDayHours {
  /** 0 = Sunday. */
  day: number;
  open: string | null;
  close: string | null;
}

export interface GbpSpecialDay {
  date: string;
  closed: boolean;
  open?: string | null;
  close?: string | null;
}

export interface GbpProfile {
  place_id: string;
  name: string;
  primary_category: string | null;
  additional_categories: string[];
  formatted_address: string | null;
  website: string | null;
  phone: string | null;
  /** e.g. OPERATIONAL, CLOSED_TEMPORARILY. */
  business_status: string | null;
  rating: number | null;
  review_count: number | null;
  photo_count: number;
  /** One entry per day the listing declares. Fewer than 7 means incomplete. */
  regular_hours: GbpDayHours[] | null;
  special_days: GbpSpecialDay[] | null;
  /** Boolean amenity/attribute flags the listing has set. */
  attributes: Record<string, boolean>;
  captured_at: Timestamp;

  // --- warm mode only: Business Profile API, requires owner authorisation ---
  /** Undefined in cold mode — Places does not report claim status. */
  claimed?: boolean;
  services?: string[];
  last_post_at?: Timestamp | null;
  unanswered_questions?: number;
}

export interface GbpProvider {
  readonly name: string;
  /** Returns null when the business has no Business Profile at all. */
  fetchProfile(placeId: string): Promise<Priced<GbpProfile | null>>;
}
