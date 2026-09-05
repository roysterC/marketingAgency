/**
 * Local rank fixtures — one SW18 keyword set, five packs, and the businesses in them.
 *
 * Place ids match `../gbp/fixtures.ts` and `../reviews/fixtures.ts`, so a scan can be
 * assembled across all four collectors.
 */

import { FREE, type MapPackEntry, type Priced, type SerpProvider } from '../../resolve/providers';
import type { KeywordPlan } from './types';

/** Ten keywords at ~3p each is the £0.30 SERP line in the cost table. */
const SERP_CALL = { pence: 3 };

/** Wandsworth. Positions are only meaningful relative to a point. */
export const NEAR = { lat: 51.4571, lng: -0.1911 };

const entry = (place_id: string, name: string, position: number): MapPackEntry => ({
  place_id,
  name,
  position,
});

const WANDSWORTH = 'Wandsworth Plumbers Ltd';
const SW_HEATING = 'SW Heating & Plumbing';
const QUICKFIX = 'QuickFix Plumbing';
const RIVERSIDE = 'Riverside Plumbing';

/**
 * Five buying-intent terms and one piece of homework.
 *
 * The informational keyword earns its place in the fixture: a business can rank well for
 * advice it wrote years ago while being invisible for every job, and the rules must not
 * let that flatter the numbers.
 */
export const PLAN: KeywordPlan = {
  near: NEAR,
  keywords: [
    { term: 'emergency plumber wandsworth', money: true },
    { term: 'boiler repair sw18', money: true },
    { term: 'plumber near me sw18', money: true },
    { term: 'bathroom fitting wandsworth', money: true },
    { term: 'blocked drain wandsworth', money: true },
    { term: 'how to bleed a radiator', money: false },
  ],
};

/** Checkatrade sits in most of these packs and is never a competitor. */
export const PACKS: Record<string, MapPackEntry[]> = {
  'emergency plumber wandsworth': [
    entry('p_wandsworth', WANDSWORTH, 1),
    entry('p_swheating', SW_HEATING, 2),
    entry('p_quickfix', QUICKFIX, 3),
    entry('dir_checkatrade', 'Checkatrade', 4),
  ],
  'boiler repair sw18': [
    entry('p_wandsworth', WANDSWORTH, 1),
    entry('p_quickfix', QUICKFIX, 2),
    entry('dir_checkatrade', 'Checkatrade', 3),
    entry('p_swheating', SW_HEATING, 4),
  ],
  // The one money keyword the subject shows up for at all, and only just.
  'plumber near me sw18': [
    entry('p_swheating', SW_HEATING, 1),
    entry('p_wandsworth', WANDSWORTH, 2),
    entry('p_quickfix', QUICKFIX, 3),
    entry('dir_checkatrade', 'Checkatrade', 4),
    entry('p_riverside', RIVERSIDE, 5),
  ],
  'bathroom fitting wandsworth': [
    entry('p_quickfix', QUICKFIX, 1),
    entry('p_wandsworth', WANDSWORTH, 2),
    entry('p_swheating', SW_HEATING, 3),
  ],
  'blocked drain wandsworth': [
    entry('p_wandsworth', WANDSWORTH, 1),
    entry('p_swheating', SW_HEATING, 2),
    entry('dir_checkatrade', 'Checkatrade', 3),
  ],
  // Ranks second for the advice page, nowhere for the work.
  'how to bleed a radiator': [
    entry('p_wandsworth', WANDSWORTH, 1),
    entry('p_riverside', RIVERSIDE, 2),
  ],
};

export const fixtureSerpProvider: SerpProvider = {
  name: 'fixture-serp',
  async mapPack(keyword): Promise<Priced<MapPackEntry[]>> {
    const pack = PACKS[keyword.trim().toLowerCase()];
    if (!pack) throw new Error(`no fixture pack for "${keyword}"`);
    return { value: pack, cost: SERP_CALL };
  },
};

/** Counts calls that reached the provider, so the scan cache can be proved rather than assumed. */
export function countingSerpProvider(): SerpProvider & { calls: () => number } {
  let calls = 0;
  return {
    name: 'fixture-serp-counting',
    calls: () => calls,
    async mapPack(keyword, near): Promise<Priced<MapPackEntry[]>> {
      calls += 1;
      return fixtureSerpProvider.mapPack(keyword, near);
    },
  };
}

/** One keyword the SERP API refuses. The rest of the set still lands. */
export function flakySerpProvider(failOn: string): SerpProvider {
  return {
    name: 'fixture-serp-flaky',
    async mapPack(keyword, near): Promise<Priced<MapPackEntry[]>> {
      if (keyword === failOn) throw new Error(`SERP API 429 for "${keyword}"`);
      return fixtureSerpProvider.mapPack(keyword, near);
    },
  };
}

/** Every query fails — the collector must still return, thinly. */
export const deadSerpProvider: SerpProvider = {
  name: 'fixture-serp-dead',
  async mapPack(): Promise<Priced<MapPackEntry[]>> {
    throw new Error('SERP API unreachable');
  },
};

/** A provider that always returns an empty pack at no cost. */
export const emptySerpProvider: SerpProvider = {
  name: 'fixture-serp-empty',
  async mapPack(): Promise<Priced<MapPackEntry[]>> {
    return { value: [], cost: FREE };
  },
};
