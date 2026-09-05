/**
 * Google Places API (New) — `PlacesProvider` and `GbpProvider`.
 *
 * One HTTP client behind two interfaces, because both read the same resource: resolve
 * needs enough of a place to identify and locate it, and `gbp` needs the listing detail.
 * Splitting them into two adapters would double the field mask and the spend.
 *
 * **Field masks are not optional and not free.** Places (New) bills by which fields you
 * ask for, so the two masks below are deliberately different sizes: resolve's is the
 * cheap identification set, the collector's is the full listing. Widening either one
 * widens every scan's bill, so they are named constants rather than inline strings.
 *
 * The response shapes here follow the v1 REST documentation. They are typed loosely on
 * purpose — an API that adds a field should not break a scan — and every field read is
 * guarded, so a listing missing half its data degrades rather than throws.
 */

import type {
  Cost,
  PlacesProvider,
  Priced,
} from '../resolve/providers';
import type { Place } from '../resolve/types';
import type { GbpDayHours, GbpProfile, GbpProvider } from '../collectors/gbp/types';
import type { Review, ReviewsCapture, ReviewsProvider } from '../collectors/reviews/types';
import { optional, required, type Env } from './config';
import { requestJson, type RetryPolicy } from './http';

const BASE = 'https://places.googleapis.com/v1';

/** Identification only: what resolve needs to know who and where a business is. */
export const RESOLVE_FIELDS = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.primaryTypeDisplayName',
].join(',');

/** The full listing, for the `gbp` collector. Every extra field here costs money. */
export const PROFILE_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'addressComponents',
  'location',
  'websiteUri',
  'nationalPhoneNumber',
  'businessStatus',
  'primaryTypeDisplayName',
  'types',
  'rating',
  'userRatingCount',
  'photos',
  'regularOpeningHours',
  'accessibilityOptions',
  'paymentOptions',
  'parkingOptions',
  'delivery',
  'takeout',
  'dineIn',
  'reservable',
  'goodForChildren',
].join(',');

/** Details-level fields, for a single place lookup by id from resolve. */
const RESOLVE_DETAIL_FIELDS = RESOLVE_FIELDS.split(',')
  .map((f) => f.replace(/^places\./, ''))
  .join(',');

export interface PlacesConfig {
  apiKey: string;
  /** UK-first, per the conventions in CLAUDE.md. */
  regionCode?: string;
  languageCode?: string;
  costPerCall?: Cost;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
}

/**
 * Places (New) bills per call by field mask tier. Roughly 2-3p at the tiers used here;
 * `docs/data-sources.md` budgets ~£0.15 a scan across six targets, which this fits.
 */
const DEFAULT_COST: Cost = { pence: 3 };

interface RawPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  location?: { latitude?: number; longitude?: number };
  websiteUri?: string;
  nationalPhoneNumber?: string;
  businessStatus?: string;
  primaryTypeDisplayName?: { text?: string };
  types?: string[];
  rating?: number;
  userRatingCount?: number;
  photos?: Array<{ name?: string }>;
  regularOpeningHours?: {
    periods?: Array<{
      open?: { day?: number; hour?: number; minute?: number };
      close?: { day?: number; hour?: number; minute?: number };
    }>;
  };
  accessibilityOptions?: Record<string, boolean>;
  paymentOptions?: Record<string, boolean>;
  parkingOptions?: Record<string, boolean>;
  delivery?: boolean;
  takeout?: boolean;
  dineIn?: boolean;
  reservable?: boolean;
  goodForChildren?: boolean;
  reviews?: Array<{
    name?: string;
    rating?: number;
    publishTime?: string;
    text?: { text?: string };
    authorAttribution?: { displayName?: string };
  }>;
}

const hhmm = (part?: { hour?: number; minute?: number }): string | null => {
  if (part?.hour === undefined) return null;
  return `${String(part.hour).padStart(2, '0')}:${String(part.minute ?? 0).padStart(2, '0')}`;
};

/** UK postcode out of the address components. Null when Places did not return one. */
export function postcodeOf(raw: RawPlace): string | null {
  const component = raw.addressComponents?.find((c) => c.types?.includes('postal_code'));
  return component?.longText ?? component?.shortText ?? null;
}

/** Bare hostname from a website URI, matching how `Place.domain` is used elsewhere. */
export function domainOf(uri: string | undefined): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

export function toPlace(raw: RawPlace): Place | null {
  if (!raw.id) return null;
  return {
    place_id: raw.id,
    name: raw.displayName?.text ?? '',
    primary_category: raw.primaryTypeDisplayName?.text ?? null,
    lat: raw.location?.latitude ?? 0,
    lng: raw.location?.longitude ?? 0,
    domain: domainOf(raw.websiteUri),
    postcode: postcodeOf(raw),
    phone: raw.nationalPhoneNumber ?? null,
  };
}

/**
 * Boolean attribute flags, flattened from the nested option groups.
 *
 * `gbp` counts how many are set, so the shape matters less than the count being honest:
 * a group Places did not return contributes nothing rather than a row of `false`.
 */
export function toAttributes(raw: RawPlace): Record<string, boolean> {
  const attributes: Record<string, boolean> = {};

  const merge = (prefix: string, group?: Record<string, boolean>): void => {
    if (!group) return;
    for (const [key, value] of Object.entries(group)) {
      if (typeof value === 'boolean') attributes[`${prefix}.${key}`] = value;
    }
  };

  merge('accessibility', raw.accessibilityOptions);
  merge('payment', raw.paymentOptions);
  merge('parking', raw.parkingOptions);

  for (const key of ['delivery', 'takeout', 'dineIn', 'reservable', 'goodForChildren'] as const) {
    if (typeof raw[key] === 'boolean') attributes[key] = raw[key];
  }

  return attributes;
}

/**
 * Opening hours, one entry per day the listing declares.
 *
 * A day with no period is genuinely absent rather than closed, which is the distinction
 * `GBP_HOURS_INCOMPLETE` is counting.
 */
export function toHours(raw: RawPlace): GbpDayHours[] | null {
  const periods = raw.regularOpeningHours?.periods;
  if (!periods) return null;

  return periods
    .filter((p) => p.open?.day !== undefined)
    .map((p) => ({
      day: p.open!.day!,
      open: hhmm(p.open),
      close: hhmm(p.close),
    }));
}

export function toProfile(raw: RawPlace, capturedAt: string): GbpProfile | null {
  if (!raw.id) return null;

  return {
    place_id: raw.id,
    name: raw.displayName?.text ?? '',
    primary_category: raw.primaryTypeDisplayName?.text ?? null,
    additional_categories: (raw.types ?? []).slice(1),
    formatted_address: raw.formattedAddress ?? null,
    website: raw.websiteUri ?? null,
    phone: raw.nationalPhoneNumber ?? null,
    business_status: raw.businessStatus ?? null,
    rating: raw.rating ?? null,
    review_count: raw.userRatingCount ?? null,
    photo_count: raw.photos?.length ?? 0,
    regular_hours: toHours(raw),
    // Places (New) does not expose holiday overrides, so this is `null` — unknown —
    // rather than `[]`, which normalise would read as "none set".
    special_days: null,
    attributes: toAttributes(raw),
    captured_at: capturedAt,
    // Claim status, services, posts and Q&A need the Business Profile API and the owner's
    // authorisation. Left undefined so the cold rules skip rather than report a false gap.
  };
}

interface PlacesClient {
  searchText(query: string, fields: string): Promise<RawPlace[]>;
  details(placeId: string, fields: string): Promise<RawPlace | null>;
  readonly cost: Cost;
}

function client(config: PlacesConfig): PlacesClient {
  const {
    apiKey,
    regionCode = 'GB',
    languageCode = 'en-GB',
    costPerCall = DEFAULT_COST,
    retry,
    fetchImpl,
  } = config;

  const headers = (fields: string): Record<string, string> => ({
    'X-Goog-Api-Key': apiKey,
    'X-Goog-FieldMask': fields,
  });

  return {
    cost: costPerCall,

    async searchText(text, fields): Promise<RawPlace[]> {
      const body = await requestJson<{ places?: RawPlace[] }>(`${BASE}/places:searchText`, {
        method: 'POST',
        headers: headers(fields),
        body: { textQuery: text, regionCode, languageCode, maxResultCount: 5 },
        ...(retry ? { retry } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      return body.places ?? [];
    },

    async details(placeId, fields): Promise<RawPlace | null> {
      // Ids from a search already carry the `places/` prefix in some responses.
      const path = placeId.startsWith('places/') ? placeId : `places/${placeId}`;
      const body = await requestJson<RawPlace>(
        `${BASE}/${path}?languageCode=${encodeURIComponent(languageCode)}`,
        {
          headers: headers(fields),
          ...(retry ? { retry } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
        },
      );
      return body.id ? body : null;
    },
  };
}

export function createPlacesProvider(config: PlacesConfig): PlacesProvider {
  const api = client(config);

  return {
    name: 'google-places',

    async findByName(name, postcode): Promise<Priced<Place | null>> {
      const places = await api.searchText(`${name} ${postcode}`, RESOLVE_FIELDS);
      return { value: places[0] ? toPlace(places[0]) : null, cost: api.cost };
    },

    async findByDomain(domain): Promise<Priced<Place | null>> {
      // Places has no domain lookup, so the domain is used as the query and the result is
      // confirmed against it. Without that check a search for "example.com" happily
      // returns whatever business happens to rank for the words in it.
      const places = await api.searchText(domain, RESOLVE_FIELDS);
      const match = places.find((p) => domainOf(p.websiteUri) === domain.toLowerCase());
      return { value: match ? toPlace(match) : null, cost: api.cost };
    },

    async details(placeId): Promise<Priced<Place | null>> {
      const raw = await api.details(placeId, RESOLVE_DETAIL_FIELDS);
      return { value: raw ? toPlace(raw) : null, cost: api.cost };
    },
  };
}

export function createGbpProvider(config: PlacesConfig): GbpProvider {
  const api = client(config);

  return {
    name: 'google-places-gbp',

    async fetchProfile(placeId): Promise<Priced<GbpProfile | null>> {
      const raw = await api.details(placeId, PROFILE_FIELDS);
      return {
        value: raw ? toProfile(raw, new Date().toISOString()) : null,
        cost: api.cost,
      };
    },
  };
}

/** The aggregates plus the five reviews Places returns alongside them. */
export const REVIEW_SAMPLE_FIELDS = ['id', 'rating', 'userRatingCount', 'reviews'].join(',');

/**
 * Reviews as Places sees them — the cheap fallback.
 *
 * Two things make this a `sample` rather than a history, and both are load-bearing:
 * Places returns at most five reviews, and it does not report owner replies at all. So
 * `coverage` is `sample` and `replied_at` is left **undefined** rather than null — undefined
 * means the source cannot see replies, null would mean the owner did not reply. Getting
 * that backwards would put "0% of reviews answered" in a paid report on no evidence.
 *
 * Worth having as `createReviewsProvider`'s fallback: volume and rating still hold, which
 * is two of the six findings, and it costs a details call rather than a review task.
 */
export function createPlacesReviewSampleProvider(config: PlacesConfig): ReviewsProvider {
  const api = client(config);

  return {
    name: 'google-places-reviews-sample',

    async fetchReviews(placeId): Promise<Priced<ReviewsCapture | null>> {
      const raw = await api.details(placeId, REVIEW_SAMPLE_FIELDS);
      if (!raw?.id) return { value: null, cost: api.cost };

      const reviews: Review[] = (raw.reviews ?? [])
        .filter((r) => r.publishTime && typeof r.rating === 'number')
        .map((r, index) => ({
          id: r.name ?? `places_review_${index}`,
          rating: r.rating!,
          published_at: new Date(r.publishTime!).toISOString(),
          text: r.text?.text ?? null,
          author: r.authorAttribution?.displayName ?? null,
          // `replied_at` is deliberately absent. See the note above.
        }));

      return {
        value: {
          place_id: raw.id,
          rating: raw.rating ?? null,
          review_count: raw.userRatingCount ?? reviews.length,
          reviews,
          coverage: 'sample',
          captured_at: new Date().toISOString(),
        },
        cost: api.cost,
      };
    },
  };
}

/** Config from the environment, failing at construction rather than mid-scan. */
export function placesConfigFromEnv(env: Env = process.env): PlacesConfig {
  const config: PlacesConfig = {
    apiKey: required(env, 'GOOGLE_PLACES_API_KEY', 'business listings and the gbp collector'),
  };
  const region = optional(env, 'PLACES_REGION_CODE');
  return region ? { ...config, regionCode: region } : config;
}
