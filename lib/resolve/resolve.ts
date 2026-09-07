/**
 * Resolve stage orchestration.
 *
 * Input: a scan request. Output: the subject plus a scored competitor set, ready to
 * persist as `scans` + `scan_targets`.
 *
 * No database writes here. The stage returns a plain result so it can be run end to end
 * in tests against fixture providers.
 */

import type { Segment } from '../taxonomy/enums';
import type { ScanRequest } from '../types/index';
import { groupAppearances, isDirectory, selectCompetitors } from './competitors';
import { PLACES_CONCURRENCY, SERP_CONCURRENCY, settleLimit } from './concurrency';
import { detectPlatform, type Platform } from './platform';
import { toOutwardCode } from './region';
import { CostMeter, type MapPackEntry, type ResolveProviders } from './providers';
import type { Candidate, Place, ResolveResult, SelectionOptions } from './types';
import { toVertical } from './vertical';

/**
 * How many candidates get a paid details lookup.
 *
 * Map packs return far more places than are worth enriching, and every details call costs
 * money. Ranking by raw appearance count first — which is free, it comes from the SERP we
 * already paid for — then enriching only the top slice keeps a scan inside its budget
 * without weakening selection, because a business appearing once was never going to
 * survive scoring anyway.
 */
export const ENRICH_LIMIT = 12;

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

export interface ResolveOptions extends SelectionOptions {
  /** Money keywords for the map pack sweep. */
  keywords: string[];
  enrich_limit?: number;
}

/** Tally how often each place appears across the keyword sweep. */
function tallyAppearances(
  perKeyword: Array<{ keyword: string; entries: MapPackEntry[] }>,
): Map<string, { name: string; hits: Array<{ keyword: string; position: number }> }> {
  const tally = new Map<string, { name: string; hits: Array<{ keyword: string; position: number }> }>();

  for (const { keyword, entries } of perKeyword) {
    for (const entry of entries) {
      const existing = tally.get(entry.place_id);
      if (existing) {
        existing.hits.push({ keyword, position: entry.position });
      } else {
        tally.set(entry.place_id, {
          name: entry.name,
          hits: [{ keyword, position: entry.position }],
        });
      }
    }
  }

  return tally;
}

async function resolveSubject(
  request: ScanRequest,
  providers: ResolveProviders,
  meter: CostMeter,
): Promise<Place> {
  const found =
    request.kind === 'domain'
      ? meter.take(await providers.places.findByDomain(request.domain))
      : meter.take(await providers.places.findByName(request.name, request.postcode));

  if (!found) {
    const what = request.kind === 'domain' ? request.domain : `${request.name}, ${request.postcode}`;
    throw new ResolveError(`Could not resolve a business for "${what}"`);
  }
  return found;
}

async function detectSubjectPlatform(
  subject: Place,
  providers: ResolveProviders,
  meter: CostMeter,
  warnings: string[],
): Promise<Platform | null> {
  if (!subject.domain) {
    warnings.push('No website found for the subject; platform and site checks were skipped.');
    return null;
  }

  try {
    const page = meter.take(await providers.pages.fetch(subject.domain));
    if (!page) {
      warnings.push(`Could not fetch ${subject.domain}; platform detection was skipped.`);
      return null;
    }
    return detectPlatform(page);
  } catch (error) {
    // A stage degrades, it does not die — CLAUDE.md rule 5.
    warnings.push(
      `Platform detection failed for ${subject.domain}: ${(error as Error).message}`,
    );
    return null;
  }
}

/**
 * Run the resolve stage.
 *
 * Throws only when the subject itself cannot be resolved — without it there is no scan.
 * Everything else degrades into `warnings`.
 */
export async function resolveScan(
  request: ScanRequest,
  providers: ResolveProviders,
  options: ResolveOptions,
): Promise<{ result: ResolveResult; cost_pence: number }> {
  const meter = new CostMeter();
  const warnings: string[] = [];
  const enrichLimit = options.enrich_limit ?? ENRICH_LIMIT;

  const subject = await resolveSubject(request, providers, meter);

  // --- keyword sweep -------------------------------------------------------
  //
  // Concurrent: the queries are independent, and serially they were the single largest
  // block of time in a scan. Where two of them want the same response the scan cache
  // hands both callers the same in-flight promise rather than buying it twice.
  const swept = await settleLimit(options.keywords, SERP_CONCURRENCY, (keyword) =>
    providers.serp.mapPack(keyword, subject),
  );

  // Unwound in input order, so cost accounting and warnings do not depend on which
  // request happened to finish first.
  const perKeyword: Array<{ keyword: string; entries: MapPackEntry[] }> = [];
  swept.forEach((outcome, index) => {
    const keyword = options.keywords[index]!;
    if (outcome.value) {
      perKeyword.push({ keyword, entries: meter.take(outcome.value) });
    } else {
      warnings.push(`Map pack lookup failed for "${keyword}": ${outcome.error}`);
    }
  });

  if (perKeyword.length === 0 && options.keywords.length > 0) {
    warnings.push('No map pack data was retrieved; competitor selection was skipped.');
  }

  // --- shortlist before paying for details ---------------------------------
  const tally = tallyAppearances(perKeyword);
  const shortlist = [...tally.entries()]
    .filter(([placeId, info]) => {
      if (placeId === subject.place_id) return false;
      // Cheap name-only directory screen, so we never pay to enrich Checkatrade.
      return !isDirectory({ name: info.name, domain: null });
    })
    .sort((a, b) => b[1].hits.length - a[1].hits.length)
    .slice(0, enrichLimit);

  // --- enrich ---------------------------------------------------------------
  //
  // Also concurrent, and bounded: this is up to `enrich_limit` paid lookups, and finding
  // a provider's rate limit partway through a scan someone is paying for is not the way
  // to discover it.
  const enriched = await settleLimit(shortlist, PLACES_CONCURRENCY, ([placeId]) =>
    providers.places.details(placeId),
  );

  const candidates: Candidate[] = [];
  enriched.forEach((outcome, index) => {
    const [, info] = shortlist[index]!;
    if (!outcome.value) {
      if (outcome.error) {
        warnings.push(`Details lookup failed for "${info.name}": ${outcome.error}`);
      }
      return;
    }

    const place = meter.take(outcome.value);
    if (!place) return;

    candidates.push(
      ...groupAppearances(
        info.hits.map((hit) => ({ keyword: hit.keyword, position: hit.position, place })),
      ),
    );
  });

  // --- select ---------------------------------------------------------------
  const selection = selectCompetitors(subject, candidates, options.keywords.length, options);
  warnings.push(...selection.warnings);

  const platform = await detectSubjectPlatform(subject, providers, meter, warnings);

  const region = toOutwardCode(subject.postcode);
  if (!region) {
    warnings.push('No usable postcode for the subject; regional benchmarks are unavailable.');
  }

  const result: ResolveResult = {
    subject,
    vertical: toVertical(subject.primary_category),
    region,
    platform,
    segment: request.segment satisfies Segment,
    keyword_set: options.keywords,
    competitors: selection.competitors,
    rejected: selection.rejected,
    warnings,
  };

  return { result, cost_pence: meter.pence };
}
