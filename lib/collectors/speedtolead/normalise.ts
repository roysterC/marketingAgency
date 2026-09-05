/**
 * Speed to lead normalise rules — pure, no I/O.
 *
 * Every code here is `verified` by construction: we submitted at a timestamp we recorded
 * and something arrived at a timestamp we recorded, or it did not. That is the whole point
 * of the collector, and it is why this section carries the report.
 *
 * The rule that needs the most care is the one about silence. A business that has not
 * replied twenty minutes after we wrote to it has not failed anything — the test is still
 * running. Only a closed window turns silence into a finding.
 */

import type { SpeedToLeadEvidence } from '../../types/index';
import type { FindingSeed, NormaliseContext } from '../types';
import type { SpeedToLeadCapture } from './types';

/**
 * Past this, a website enquiry has gone cold.
 *
 * Half a working day. Deliberately not one hour: plenty of good local businesses reply
 * within the morning, and a `critical` finding that fires on nearly everyone teaches the
 * reader to skim past severity — which costs us the findings that matter. The sharper
 * claim is comparative anyway, and `STL_COMPETITOR_FASTER` makes it.
 */
export const SLOW_REPLY_HOURS = 4;

/** How long we wait before silence becomes a finding. Spec §4. */
export const RESPONSE_WINDOW_HOURS = 48;

/**
 * A competitor is only "faster" if the gap is one a customer would feel.
 * Twice as fast, and at least half an hour of real difference.
 */
export const COMPETITOR_FASTER_FACTOR = 2;
export const COMPETITOR_FASTER_MIN_GAP_HOURS = 0.5;

/** Peer metric keys, shared with the aggregation step. */
export const PEER_KEYS = {
  response_hours: 'speedtolead.response_hours',
} as const;

const MS_PER_HOUR = 3_600_000;

const round = (n: number, dp: number): number => {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
};

export const hoursBetween = (from: string, to: string): number =>
  round((new Date(to).getTime() - new Date(from).getTime()) / MS_PER_HOUR, 2);

const peerBest = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.best[key] ?? null;

const peerMedian = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.median[key] ?? null;

/** Hours from submission to first reply. Null when nothing has arrived. */
export function responseHours(capture: SpeedToLeadCapture): number | null {
  if (!capture.submission || !capture.response) return null;
  return hoursBetween(capture.submission.submitted_at, capture.response.first_response_at);
}

/**
 * Whether the 48-hour window has shut.
 *
 * False while a test is still in flight, which is the difference between "we are waiting"
 * and "nobody answered".
 */
export function windowClosed(capture: SpeedToLeadCapture, now: Date): boolean {
  if (!capture.window_closes_at) return false;
  return now.getTime() >= new Date(capture.window_closes_at).getTime();
}

export function normaliseSpeedToLead(
  capture: SpeedToLeadCapture | null,
  ctx: NormaliseContext,
): FindingSeed[] {
  if (!capture) return [];

  const seeds: FindingSeed[] = [];
  const { surfaces, submission, response } = capture;

  // --- what the site offers -----------------------------------------------
  if (surfaces) {
    if (surfaces.form_url === null) {
      seeds.push({
        code: 'STL_NO_FORM_ON_SITE',
        evidence: {
          url: capture.url,
          checked_at: capture.captured_at,
          screenshot_key: surfaces.screenshot_key,
          note: 'Every enquiry has to become a phone call, which loses everyone who cannot ring during the working day.',
        },
      });
    }

    if (surfaces.form_status === 'broken') {
      seeds.push({
        code: 'STL_FORM_BROKEN',
        evidence: {
          form_url: surfaces.form_url,
          error: surfaces.form_error,
          checked_at: capture.captured_at,
          screenshot_key: surfaces.screenshot_key,
          note: 'Enquiries submitted through this form do not arrive. Traffic is being paid for and dropped.',
        },
      });
    }

    if (!surfaces.phone_visible_mobile) {
      seeds.push({
        code: 'STL_NO_PHONE_VISIBLE_MOBILE',
        evidence: {
          url: capture.url,
          viewport: '375px',
          screenshot_key: surfaces.screenshot_key,
          note: 'No tap-to-call number without scrolling, on the device most local searches happen on.',
        },
      });
    }
  }

  // --- the enquiry we sent -------------------------------------------------
  const hours = responseHours(capture);
  const closed = windowClosed(capture, ctx.now);

  if (submission) {
    const evidence: SpeedToLeadEvidence = {
      submitted_at: submission.submitted_at,
      responded_at: response?.first_response_at ?? null,
      channel: submission.channel,
      form_url: submission.form_url,
    };

    if (hours !== null && hours > SLOW_REPLY_HOURS) {
      seeds.push({
        code: 'STL_FORM_SLOW_REPLY',
        measured_value: hours,
        measured_text: `${hours} hours to reply`,
        benchmark_value: SLOW_REPLY_HOURS,
        benchmark_source: 'absolute',
        evidence: {
          ...evidence,
          hours_to_reply: hours,
          threshold_hours: SLOW_REPLY_HOURS,
          excerpt: response?.excerpt ?? null,
        },
      });
    }

    // Silence only counts once the window has shut. Before that the test is still running,
    // and reporting it would be reporting our own impatience as their failure.
    if (hours === null && closed) {
      seeds.push({
        code: 'STL_FORM_NO_REPLY',
        measured_text: `no reply in ${RESPONSE_WINDOW_HOURS} hours`,
        evidence: {
          ...evidence,
          window_hours: RESPONSE_WINDOW_HOURS,
          window_closed_at: capture.window_closes_at,
        },
      });
    }
  }

  // --- against the competitor set ------------------------------------------
  // Fires on a no-reply as well as a slow reply: "nobody replied for 48 hours, your
  // nearest competitor replied in four minutes" is the single most persuasive line the
  // report can carry, and it needs both halves.
  const best = peerBest(ctx, PEER_KEYS.response_hours);
  if (submission && best !== null && (hours !== null || closed)) {
    const beaten =
      hours === null || (hours > best * COMPETITOR_FASTER_FACTOR && hours - best >= COMPETITOR_FASTER_MIN_GAP_HOURS);

    if (beaten) {
      seeds.push({
        code: 'STL_COMPETITOR_FASTER',
        measured_value: hours,
        measured_text:
          hours === null
            ? `no reply in ${RESPONSE_WINDOW_HOURS} hours against a competitor best of ${best}`
            : `${hours} hours against a competitor best of ${best}`,
        benchmark_value: best,
        benchmark_source: 'competitor_best',
        evidence: {
          submitted_at: submission.submitted_at,
          responded_at: response?.first_response_at ?? null,
          hours_to_reply: hours,
          competitor_best_hours: best,
          competitor_median_hours: peerMedian(ctx, PEER_KEYS.response_hours),
        },
      });
    }
  }

  // --- the phone -----------------------------------------------------------
  if (capture.phone && !capture.phone.answered) {
    seeds.push({
      code: 'STL_PHONE_UNANSWERED',
      evidence: {
        called_at: capture.phone.called_at,
        rang_seconds: capture.phone.rang_seconds,
        channel: 'phone',
        note: 'One call, during advertised opening hours, unanswered.',
      },
    });
  }

  return seeds;
}
