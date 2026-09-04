/**
 * GBP fixtures — a healthy listing, a neglected one, and a warm-mode variant.
 *
 * Lets the collector run end to end with no Places key and no spend.
 */

import type { Priced } from '../../resolve/providers';
import type { GbpDayHours, GbpProfile, GbpProvider } from './types';

const PLACES_CALL = { pence: 3 };

const fullWeek: GbpDayHours[] = Array.from({ length: 7 }, (_, day) => ({
  day,
  open: '08:00',
  close: '18:00',
}));

const partialWeek: GbpDayHours[] = fullWeek.slice(0, 5);

/** A well-maintained competitor listing. Produces no findings in cold mode. */
export const HEALTHY_PROFILE: GbpProfile = {
  place_id: 'p_wandsworth',
  name: 'Wandsworth Plumbers Ltd',
  primary_category: 'Plumber',
  additional_categories: ['Heating contractor'],
  formatted_address: '1 High Street, London SW18 1AA',
  website: 'https://wandsworthplumbers.example',
  phone: '+442080001111',
  business_status: 'OPERATIONAL',
  rating: 4.8,
  review_count: 214,
  photo_count: 46,
  regular_hours: fullWeek,
  special_days: [{ date: '2026-12-25', closed: true }],
  attributes: {
    wheelchair_accessible: true,
    online_appointments: true,
    onsite_services: true,
    emergency_callout: true,
    card_payments: true,
    free_estimates: true,
  },
  captured_at: '2026-09-04T09:00:00.000Z',
};

/** The subject: miscategorised, half-filled, barely any photos. */
export const NEGLECTED_PROFILE: GbpProfile = {
  place_id: 'p_riverside',
  name: 'Riverside Plumbing',
  // Filed under the wrong trade — costs it the map pack for every job it actually does.
  primary_category: 'Electrician',
  additional_categories: [],
  formatted_address: '9 River Road, London SW18 4AB',
  website: 'https://riversideplumbing.example',
  phone: '+442080002222',
  business_status: 'OPERATIONAL',
  rating: 4.6,
  review_count: 23,
  photo_count: 3,
  regular_hours: partialWeek,
  special_days: [],
  attributes: { card_payments: true, onsite_services: true },
  captured_at: '2026-09-04T09:00:00.000Z',
};

/** The same listing seen with owner authorisation. Four more findings become visible. */
export const NEGLECTED_PROFILE_WARM: GbpProfile = {
  ...NEGLECTED_PROFILE,
  claimed: false,
  services: [],
  last_post_at: '2025-11-02T10:00:00.000Z',
  unanswered_questions: 3,
};

const BY_ID: Record<string, GbpProfile> = {
  p_wandsworth: HEALTHY_PROFILE,
  p_riverside: NEGLECTED_PROFILE,
  p_swheating: { ...HEALTHY_PROFILE, place_id: 'p_swheating', name: 'SW Heating & Plumbing', photo_count: 31 },
  p_quickfix: { ...HEALTHY_PROFILE, place_id: 'p_quickfix', name: 'QuickFix Plumbing', photo_count: 18 },
};

export const fixtureGbpProvider: GbpProvider = {
  name: 'fixture-gbp',
  async fetchProfile(placeId): Promise<Priced<GbpProfile | null>> {
    return { value: BY_ID[placeId] ?? null, cost: PLACES_CALL };
  },
};

/** Warm-mode provider: same listings, owner-authorised fields populated. */
export const fixtureGbpProviderWarm: GbpProvider = {
  name: 'fixture-gbp-warm',
  async fetchProfile(placeId): Promise<Priced<GbpProfile | null>> {
    if (placeId === 'p_riverside') return { value: NEGLECTED_PROFILE_WARM, cost: PLACES_CALL };
    return { value: BY_ID[placeId] ?? null, cost: PLACES_CALL };
  },
};

/** A business with no Business Profile at all. */
export const fixtureGbpProviderMissing: GbpProvider = {
  name: 'fixture-gbp-missing',
  async fetchProfile(): Promise<Priced<GbpProfile | null>> {
    return { value: null, cost: PLACES_CALL };
  },
};
