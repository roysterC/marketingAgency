/**
 * Provider boundary for the resolve stage.
 *
 * Every paid data source sits behind one of these interfaces. Two reasons, both from the
 * spec: collectors must be testable without burning API budget, and they must fail
 * independently (CLAUDE.md rule 5) — which is only possible if the I/O is isolated.
 *
 * Real HTTP adapters land when keys exist. `lib/resolve/fixtures.ts` implements the same
 * interfaces deterministically for tests and local development.
 */

import type { PageResponse } from './platform';
import type { Place } from './types';

/** Every call reports what it cost, so scans.cost_pence reflects reality from day one. */
export interface Cost {
  pence: number;
}

export type Priced<T> = { value: T; cost: Cost };

export interface MapPackEntry {
  place_id: string;
  name: string;
  /** 1-based position within the pack. */
  position: number;
}

/** Google Places, or an equivalent. */
export interface PlacesProvider {
  readonly name: string;
  findByName(name: string, postcode: string): Promise<Priced<Place | null>>;
  findByDomain(domain: string): Promise<Priced<Place | null>>;
  details(placeId: string): Promise<Priced<Place | null>>;
}

/** A SERP API — DataForSEO, Serper, SerpAPI. */
export interface SerpProvider {
  readonly name: string;
  mapPack(keyword: string, near: { lat: number; lng: number }): Promise<Priced<MapPackEntry[]>>;
}

/** Fetches a homepage for platform detection. Own infrastructure, so effectively free. */
export interface PageFetcher {
  readonly name: string;
  fetch(url: string): Promise<Priced<PageResponse | null>>;
}

export interface ResolveProviders {
  places: PlacesProvider;
  serp: SerpProvider;
  pages: PageFetcher;
}

/** Accumulates spend across a stage. */
export class CostMeter {
  #pence = 0;

  add(cost: Cost): void {
    this.#pence += cost.pence;
  }

  /** Unwrap a priced result, recording its cost. */
  take<T>(priced: Priced<T>): T {
    this.add(priced.cost);
    return priced.value;
  }

  get pence(): number {
    return this.#pence;
  }
}

export const FREE: Cost = { pence: 0 };
