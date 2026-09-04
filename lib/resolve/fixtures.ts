/**
 * Deterministic fixture providers.
 *
 * A small Wandsworth plumbing world containing every case selection has to handle: direct
 * competitors, a directory that dominates the map pack, an adjacent trade in the wrong
 * category, and a business outside the radius. Used by tests and local development so the
 * whole stage runs with no API keys and no spend.
 */

import type { PageResponse } from './platform';
import type {
  Cost,
  MapPackEntry,
  PageFetcher,
  PlacesProvider,
  Priced,
  ResolveProviders,
  SerpProvider,
} from './providers';
import type { Place } from './types';

/** Indicative real-world pricing, so cost accounting is exercised in tests. */
const PLACES_CALL: Cost = { pence: 3 };
const SERP_CALL: Cost = { pence: 3 };
const PAGE_FETCH: Cost = { pence: 0 };

const place = (
  place_id: string,
  name: string,
  primary_category: string | null,
  lat: number,
  lng: number,
  domain: string | null,
  postcode: string | null,
): Place => ({ place_id, name, primary_category, lat, lng, domain, postcode, phone: null });

export const SUBJECT = place(
  'p_riverside', 'Riverside Plumbing', 'Plumber',
  51.4571, -0.1911, 'riversideplumbing.example', 'SW18 4AB',
);

export const PLACES: Place[] = [
  SUBJECT,
  // Direct competitors, decreasing overlap.
  place('p_wandsworth', 'Wandsworth Plumbers Ltd', 'Plumber',
    51.4590, -0.1880, 'wandsworthplumbers.example', 'SW18 1AA'),
  place('p_swheating', 'SW Heating & Plumbing', 'Plumber',
    51.4520, -0.2000, 'swheating.example', 'SW18 2BB'),
  place('p_quickfix', 'QuickFix Plumbing', 'Plumber',
    51.4650, -0.1750, 'quickfixplumbing.example', 'SW17 9CC'),
  place('p_thames', 'Thames Drainage & Plumbing', 'Plumber',
    51.4480, -0.1990, 'thamesdrainage.example', 'SW18 5DD'),
  // A directory that outranks everyone and is not a competitor.
  place('p_checkatrade', 'Checkatrade', 'Website',
    51.4575, -0.1905, 'checkatrade.com', null),
  // Adjacent trade, wrong category.
  place('p_brightspark', 'Bright Spark Electrical', 'Electrician',
    51.4580, -0.1900, 'brightspark.example', 'SW18 3EE'),
  // Correct category, too far to be competing for the same jobs.
  place('p_croydon', 'Croydon Plumbing Co', 'Plumber',
    51.3200, -0.0500, 'croydonplumbing.example', 'CR0 1AA'),
];

const BY_ID = new Map(PLACES.map((p) => [p.place_id, p]));

/** Which places appear for which keywords, and where in the pack. */
const MAP_PACK: Record<string, Array<[string, number]>> = {
  'emergency plumber wandsworth': [
    ['p_checkatrade', 1], ['p_wandsworth', 2], ['p_riverside', 3], ['p_swheating', 4],
  ],
  'plumber sw18': [
    ['p_wandsworth', 1], ['p_riverside', 2], ['p_swheating', 3], ['p_quickfix', 4],
  ],
  'boiler repair wandsworth': [
    ['p_swheating', 1], ['p_wandsworth', 2], ['p_checkatrade', 3], ['p_croydon', 4],
  ],
  'blocked drain wandsworth': [
    ['p_wandsworth', 1], ['p_thames', 2], ['p_riverside', 5],
  ],
  'bathroom fitter wandsworth': [
    ['p_wandsworth', 2], ['p_quickfix', 3], ['p_brightspark', 4],
  ],
};

export const FIXTURE_KEYWORDS = Object.keys(MAP_PACK);

const SHOPIFY_HTML = '<html><head><script src="https://cdn.shopify.com/s/f.js"></script></head></html>';
const WORDPRESS_HTML = '<html><head><link href="/wp-content/themes/x/style.css"></head></html>';

export const fixturePlaces: PlacesProvider = {
  name: 'fixture-places',
  async findByName(name, postcode): Promise<Priced<Place | null>> {
    const needle = name.toLowerCase();
    const outward = postcode.toUpperCase().split(/\s/)[0];
    const found =
      PLACES.find(
        (p) => p.name.toLowerCase().includes(needle) && p.postcode?.startsWith(outward ?? ''),
      ) ?? PLACES.find((p) => p.name.toLowerCase().includes(needle)) ?? null;
    return { value: found, cost: PLACES_CALL };
  },
  async findByDomain(domain): Promise<Priced<Place | null>> {
    const needle = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    return { value: PLACES.find((p) => p.domain === needle) ?? null, cost: PLACES_CALL };
  },
  async details(placeId): Promise<Priced<Place | null>> {
    return { value: BY_ID.get(placeId) ?? null, cost: PLACES_CALL };
  },
};

export const fixtureSerp: SerpProvider = {
  name: 'fixture-serp',
  async mapPack(keyword): Promise<Priced<MapPackEntry[]>> {
    const rows = MAP_PACK[keyword] ?? [];
    const entries: MapPackEntry[] = rows.map(([placeId, position]) => ({
      place_id: placeId,
      name: BY_ID.get(placeId)?.name ?? placeId,
      position,
    }));
    return { value: entries, cost: SERP_CALL };
  },
};

export const fixturePages: PageFetcher = {
  name: 'fixture-pages',
  async fetch(url): Promise<Priced<PageResponse | null>> {
    const html = url.includes('quickfix') ? SHOPIFY_HTML : WORDPRESS_HTML;
    return { value: { html, headers: {} }, cost: PAGE_FETCH };
  },
};

export const fixtureProviders: ResolveProviders = {
  places: fixturePlaces,
  serp: fixtureSerp,
  pages: fixturePages,
};

/** A provider set where every call rejects, for exercising graceful degradation. */
export function failingProviders(message = 'provider unavailable'): ResolveProviders {
  const boom = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    places: {
      name: 'failing-places',
      findByName: fixturePlaces.findByName,
      findByDomain: fixturePlaces.findByDomain,
      details: boom,
    },
    serp: { name: 'failing-serp', mapPack: boom },
    pages: { name: 'failing-pages', fetch: boom },
  };
}
