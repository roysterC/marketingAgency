/**
 * The `gbp` collector.
 *
 * Cold mode reads what the Places API exposes. Claim status, services, posts and Q&A need
 * the Business Profile API and the owner's authorisation, so they only appear in warm
 * mode — see `./types.ts`. The normalise rules are shared; warm mode simply has more
 * fields populated.
 */

import type { Priced } from '../../resolve/providers';
import { median, type CollectContext, type CollectTarget, type Collector, type FindingSeed, type NormaliseContext, type PeerStats } from '../types';
import { PEER_KEYS, normaliseGbp } from './normalise';
import type { GbpProfile, GbpProvider } from './types';

/** Every code this collector may emit. Verified against the registry in tests. */
export const GBP_EMITS = [
  'GBP_MISSING',
  'GBP_UNCLAIMED',
  'GBP_CATEGORY_MISMATCH',
  'GBP_HOURS_INCOMPLETE',
  'GBP_HOURS_STALE_HOLIDAY',
  'GBP_PHOTOS_SPARSE',
  'GBP_NO_SERVICES_LISTED',
  'GBP_POSTS_STALE',
  'GBP_QNA_UNANSWERED',
  'GBP_ATTRIBUTES_SPARSE',
] as const;

/**
 * Codes that cold mode can never produce, because the Places API does not carry the data.
 *
 * Kept explicit so a thin cold report is an understood limitation rather than a mystery,
 * and so the warm-mode upsell has a concrete list behind it.
 */
export const WARM_ONLY_CODES = [
  'GBP_UNCLAIMED',
  'GBP_NO_SERVICES_LISTED',
  'GBP_POSTS_STALE',
  'GBP_QNA_UNANSWERED',
] as const;

export function createGbpCollector(provider: GbpProvider): Collector<GbpProfile> {
  return {
    name: 'gbp',
    requires_auth: false,
    segments: ['smb'],
    emits: GBP_EMITS,

    async collect(target: CollectTarget, _ctx: CollectContext): Promise<Priced<GbpProfile | null>> {
      return provider.fetchProfile(target.place.place_id);
    },

    normalise(raw: GbpProfile | null, ctx: NormaliseContext): FindingSeed[] {
      return normaliseGbp(raw, ctx);
    },

    peerStats(raws: (GbpProfile | null)[]): PeerStats {
      return gbpPeerStats(raws.filter((p): p is GbpProfile => p !== null));
    },
  };
}

/**
 * Build peer medians from every profile collected in a scan.
 *
 * Runs after collection, before normalisation, so comparative findings can say "12 photos
 * against a competitor median of 40" rather than asserting sparseness against nothing.
 */
export function gbpPeerStats(competitorProfiles: GbpProfile[]): PeerStats {
  const photos = competitorProfiles.map((p) => p.photo_count);
  const attributes = competitorProfiles.map(
    (p) => Object.values(p.attributes).filter(Boolean).length,
  );
  const services = competitorProfiles
    .map((p) => p.services?.length)
    .filter((n): n is number => n !== undefined);

  const stats: PeerStats = { median: {}, best: {} };

  const photoMedian = median(photos);
  if (photoMedian !== null) {
    stats.median[PEER_KEYS.photos] = photoMedian;
    stats.best[PEER_KEYS.photos] = Math.max(...photos);
  }

  const attributeMedian = median(attributes);
  if (attributeMedian !== null) {
    stats.median[PEER_KEYS.attributes] = attributeMedian;
    stats.best[PEER_KEYS.attributes] = Math.max(...attributes);
  }

  const serviceMedian = median(services);
  if (serviceMedian !== null) {
    stats.median[PEER_KEYS.services] = serviceMedian;
    stats.best[PEER_KEYS.services] = Math.max(...services);
  }

  return stats;
}

export * from './types';
export * from './normalise';
