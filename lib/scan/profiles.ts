/**
 * Scan profiles — how much engine to spend on a given prospect.
 *
 * The spec's §1 table already says cold outbound and the paid audit are different jobs
 * with different constraints; this is that difference made explicit instead of every scan
 * costing the same regardless of why it was run.
 *
 * **hook** is for outbound at volume. It buys the one finding that gets a reply and stops.
 * The first live scan is the evidence for what that finding is: the subject was a
 * well-run business with five findings, and the two that carried the report were
 * `AIVIS_NOT_CITED` and `AIVIS_COMPETITOR_CITED` — competitors named in 100% of AI answers
 * and the subject in none. That needs `gbp` (for the ground truth a citation is checked
 * against) and `aivis`. It does not need review history, Core Web Vitals or a crawl.
 *
 * **full** is the £500–1,500 audit, and the sales demo. Everything.
 *
 * Ordering matters more than the flag: run `hook` over a list, run `full` on whoever
 * replies. Spending audit money on someone who never answers is the thing to avoid.
 */

import type { Collector as CollectorName } from '../taxonomy/enums';
import type { Effort } from '../adapters/writer';

export const PROFILE_NAMES = ['hook', 'full'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

export interface ScanProfile {
  readonly name: ProfileName;
  /** Collectors to run. Anything absent is never constructed, so never billed. */
  readonly collectors: readonly CollectorName[];
  /** Competitors to select. Fewer means fewer paid detail lookups. */
  readonly maxCompetitors: number;
  /** How many map-pack candidates get a paid Places lookup. */
  readonly enrichLimit: number;
  /** Which report variants to render. */
  readonly variants: readonly ('full' | 'onepager')[];
  /**
   * How hard the writer thinks.
   *
   * Measured, not assumed. Re-running the writer over one scan's 42 findings at `medium`
   * produced sentences that were, if anything, better written — and chose worse things to
   * say. It dropped "a competitor 0.3 miles away outranks you on all five keywords" from
   * the executive summary in favour of an `estimated` finding about thin content, and
   * padded the sections from 24 claims to 37 by walking through each competitor in turn.
   *
   * The cost is in selection, so it scales with how much there is to select from. A full
   * scan has 42 findings to prioritise and needs the judgement. A hook scan has about
   * five, where there is nothing to get wrong.
   */
  readonly effort: Effort;
  readonly description: string;
}

export const PROFILES: Record<ProfileName, ScanProfile> = {
  hook: {
    name: 'hook',
    // gbp earns its place here despite the cost: aivis compares what a model claims
    // against ground truth, and without a profile to check against, AIVIS_OUTDATED_FACT —
    // the taxonomy's own most attention-getting finding — cannot fire at all.
    collectors: ['gbp', 'aivis'],
    maxCompetitors: 3,
    enrichLimit: 6,
    variants: ['onepager'],
    effort: 'medium',
    description: 'Cold outbound. The finding that gets a reply, and nothing else.',
  },
  full: {
    name: 'full',
    collectors: ['gbp', 'reviews', 'sitetech', 'localrank', 'aivis'],
    maxCompetitors: 6,
    enrichLimit: 12,
    variants: ['full', 'onepager'],
    effort: 'high',
    description: 'The paid audit, and the live demo. Every collector.',
  },
};

export function profileByName(name: string): ScanProfile {
  const profile = PROFILES[name as ProfileName];
  if (!profile) {
    throw new Error(
      `Unknown scan profile "${name}". Options: ${PROFILE_NAMES.join(', ')}.`,
    );
  }
  return profile;
}

/** Whether a profile runs a given collector. */
export function runsCollector(profile: ScanProfile, collector: CollectorName): boolean {
  return profile.collectors.includes(collector);
}
