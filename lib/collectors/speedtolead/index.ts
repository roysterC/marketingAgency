/**
 * The `speedtolead` collector.
 *
 * The conversion mechanic. It is also the only collector that does something to someone,
 * so two constraints are enforced here rather than described:
 *
 * 1. **The enquiry is genuine and identified.** `dispatchEnquiry` validates through
 *    `./ethics.ts` before the probe is touched, and it is the only path to a submission.
 * 2. **One test per business, ever, per scan.** A ledger in the collector's closure
 *    refuses a second contact. Re-collecting after the window polls the inbox; it does not
 *    write to anyone again.
 *
 * The second is why `collect()` is safe to call twice. The pipeline needs that: the
 * enquiry goes out in minutes and the answer comes back in hours, so the stage runs once
 * to submit and again after the wait to see what arrived.
 */

import { FREE, type Priced } from '../../resolve/providers';
import {
  attempt,
  median,
  type CollectContext,
  type CollectTarget,
  type Collector,
  type FindingSeed,
  type NormaliseContext,
  type PeerStats,
} from '../types';
import { assertGenuineEnquiry } from './ethics';
import { PEER_KEYS, RESPONSE_WINDOW_HOURS, normaliseSpeedToLead, responseHours } from './normalise';
import type {
  ContactSurfaces,
  Enquiry,
  PhoneTest,
  ResponseRecord,
  SpeedToLeadCapture,
  SpeedToLeadProbe,
  Submission,
} from './types';

/** Every code this collector may emit. Verified against the registry in tests. */
export const SPEEDTOLEAD_EMITS = [
  'STL_FORM_BROKEN',
  'STL_FORM_NO_REPLY',
  'STL_FORM_SLOW_REPLY',
  'STL_NO_FORM_ON_SITE',
  'STL_PHONE_UNANSWERED',
  'STL_NO_PHONE_VISIBLE_MOBILE',
  'STL_COMPETITOR_FASTER',
] as const;

const MS_PER_HOUR = 3_600_000;

export interface SpeedToLeadOptions {
  /** Hours before silence becomes a finding. Spec §4 says 48. */
  windowHours?: number;
  /** Whether to place the call test. Off unless a monitored number is wired up. */
  testPhone?: boolean;
}

/**
 * The only way to send an enquiry.
 *
 * Validates first, sends second. Exported so the guard is directly testable and so a
 * caller reaching for the probe instead has to do so visibly.
 */
export async function dispatchEnquiry(
  probe: SpeedToLeadProbe,
  url: string,
  enquiry: Enquiry,
): Promise<Priced<Submission>> {
  assertGenuineEnquiry(enquiry);
  return probe.submit(url, enquiry);
}

export function createSpeedToLeadCollector(
  probe: SpeedToLeadProbe,
  enquiry: Enquiry,
  options: SpeedToLeadOptions = {},
): Collector<SpeedToLeadCapture> {
  const windowHours = options.windowHours ?? RESPONSE_WINDOW_HOURS;

  // Fail loudly at construction rather than on the first business we would have written
  // to. A misconfigured identity should never get as far as a network call.
  assertGenuineEnquiry(enquiry);

  /** Businesses already contacted in this scan. The hard rate limit from spec §4. */
  const contacted = new Map<string, Submission>();

  return {
    name: 'speedtolead',
    requires_auth: false,
    segments: ['smb', 'dtc'],
    emits: SPEEDTOLEAD_EMITS,

    async collect(
      target: CollectTarget,
      _ctx: CollectContext,
    ): Promise<Priced<SpeedToLeadCapture | null>> {
      const url = target.place.domain;
      const placeId = target.place.place_id;
      let pence = 0;

      const empty = (surfaces: ContactSurfaces | null): SpeedToLeadCapture => ({
        place_id: placeId,
        url,
        surfaces,
        submission: null,
        response: null,
        window_closes_at: null,
        phone: null,
        captured_at: new Date().toISOString(),
      });

      // Nothing to inspect and nowhere to write. `gbp` reports the missing web presence.
      if (!url) return { value: empty(null), cost: FREE };

      const inspection = await attempt(() => probe.inspect(url));
      pence += inspection.cost.pence;
      const surfaces = inspection.value;

      // --- the enquiry -------------------------------------------------------
      let submission = contacted.get(placeId) ?? null;
      const alreadyContacted = submission !== null;

      if (!alreadyContacted && surfaces?.form_url && surfaces.form_status === 'ok') {
        const sent = await attempt(() => dispatchEnquiry(probe, surfaces.form_url!, enquiry));
        pence += sent.cost.pence;
        if (sent.value) {
          submission = sent.value;
          contacted.set(placeId, sent.value);
        }
      }

      // --- has anything come back? ------------------------------------------
      let response: ResponseRecord | null = null;
      if (submission) {
        const polled = await attempt(() => probe.response(submission!.id));
        pence += polled.cost.pence;
        response = polled.value;
      }

      // --- the phone ---------------------------------------------------------
      // Only on a business we have not already called, and only when a monitored number is
      // configured. One call per business, same rule as the form.
      let phone: PhoneTest | null = null;
      if (options.testPhone && probe.call && !alreadyContacted && target.place.phone) {
        const called = await attempt(() => probe.call!(target.place.phone!, enquiry));
        pence += called.cost.pence;
        phone = called.value;
      }

      return {
        value: {
          place_id: placeId,
          url,
          surfaces,
          submission,
          response,
          window_closes_at: submission
            ? new Date(
                new Date(submission.submitted_at).getTime() + windowHours * MS_PER_HOUR,
              ).toISOString()
            : null,
          phone,
          captured_at: new Date().toISOString(),
        },
        cost: { pence },
      };
    },

    normalise(raw: SpeedToLeadCapture | null, ctx: NormaliseContext): FindingSeed[] {
      return normaliseSpeedToLead(raw, ctx);
    },

    peerStats(raws: (SpeedToLeadCapture | null)[]): PeerStats {
      return speedToLeadPeerStats(raws.filter((c): c is SpeedToLeadCapture => c !== null));
    },
  };
}

/**
 * Build peer stats from the competitors' tests.
 *
 * Response time is lower-better, so `best` is the **minimum** — the competitor who
 * answered fastest is the one the report quotes. A competitor that never replied
 * contributes nothing rather than a zero: we do not know their response time, only that it
 * exceeded the window.
 */
export function speedToLeadPeerStats(captures: SpeedToLeadCapture[]): PeerStats {
  const stats: PeerStats = { median: {}, best: {} };

  const hours = captures
    .map((c) => responseHours(c))
    .filter((h): h is number => h !== null);

  const mid = median(hours);
  if (mid !== null) {
    stats.median[PEER_KEYS.response_hours] = mid;
    stats.best[PEER_KEYS.response_hours] = Math.min(...hours);
  }

  return stats;
}

export * from './types';
export * from './ethics';
export * from './normalise';
