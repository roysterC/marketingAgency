/**
 * Speed to lead — raw capture shape and probe interface.
 *
 * This is the only collector that makes something happen at the other end. Everything it
 * touches is a real business with a real inbox and a real phone, so the shapes here are
 * built around what we are allowed to send rather than only around what we want to learn.
 * See `./ethics.ts`, which is the load-bearing part of this module.
 *
 * The second thing that makes it different: the measurement is not over when `collect()`
 * returns. We submit, and the reply arrives minutes or days later — or never. So the
 * capture models a test in flight, and `window_closes_at` is what lets normalise tell
 * "they have not replied yet" apart from "they never replied".
 */

import type { Priced } from '../../resolve/providers';
import type { Timestamp } from '../shared';

/**
 * Who the enquiry is from.
 *
 * Every field is required, and that is the point: there is no shape of this type that
 * describes an anonymous enquiry. A mystery shop is identified by construction.
 */
export interface EnquiryIdentity {
  /** A real person's name, on a real inbox we monitor. */
  from_name: string;
  /** A monitored address we own. This is where the reply lands and how it is timed. */
  reply_to: string;
  /** A monitored number we own. */
  phone: string;
  /** One line saying who we are, included in the body of the enquiry. */
  disclosure: string;
}

export interface Enquiry {
  identity: EnquiryIdentity;
  /**
   * A genuine question we actually want the answer to.
   *
   * "Do you cover SW18? What's your callout fee?" — a real question, cheap to answer,
   * measures response time truthfully. Never a job that does not exist.
   */
  question: string;
}

/** What the site offers as a way of getting in touch. */
export interface ContactSurfaces {
  form_url: string | null;
  /**
   * Whether the form actually accepted a submission.
   *
   * Null means **not established**, which happens two ways: there was no form to try, or
   * the probe does not submit. A read-only probe always reports null here, and that is
   * load-bearing — the collector only submits when this reads `ok`, so a probe that never
   * claims a form works is never asked to send anything.
   *
   * `broken` is the single most valuable finding the engine can produce — the business is
   * paying for traffic into a dead end — and it cannot be established without submitting.
   */
  form_status: 'ok' | 'broken' | null;
  form_error: string | null;
  /**
   * A tap-to-call number visible without scrolling, at a 375px viewport.
   *
   * A read-only probe cannot see the fold, so it reads this as the weaker "a tap-to-call
   * link exists at all". That can only under-report: no `tel:` link anywhere means there is
   * definitely nothing tappable above the fold, while a link in the footer is left alone
   * rather than guessed at. False negatives are acceptable here; false positives are not.
   */
  phone_visible_mobile: boolean;
  screenshot_key: string | null;
}

export type EnquiryChannel = 'form' | 'phone' | 'chat';

export interface Submission {
  /** Opaque id for polling the monitored inbox later. */
  id: string;
  submitted_at: Timestamp;
  form_url: string;
  channel: EnquiryChannel;
}

export interface ResponseRecord {
  first_response_at: Timestamp;
  channel: EnquiryChannel;
  /** A short quote, so the report can show the reply rather than assert it. */
  excerpt: string | null;
}

export interface PhoneTest {
  called_at: Timestamp;
  answered: boolean;
  rang_seconds: number;
}

export interface SpeedToLeadCapture {
  place_id: string;
  url: string | null;
  surfaces: ContactSurfaces | null;
  /** Null when there was no form to submit to, or when this business was already tested. */
  submission: Submission | null;
  /** Null while we are still waiting, and also when nothing ever came. */
  response: ResponseRecord | null;
  /**
   * When the 48-hour window shuts.
   *
   * Before it, silence is an unfinished test. After it, silence is the finding. Without
   * this field normalise cannot tell those apart, and would report a business as
   * unresponsive twenty minutes after we contacted it.
   */
  window_closes_at: Timestamp | null;
  phone: PhoneTest | null;
  captured_at: Timestamp;
}

export interface SpeedToLeadProbe {
  readonly name: string;

  /** Look at the site. Contacts nobody. */
  inspect(url: string): Promise<Priced<ContactSurfaces>>;

  /**
   * Send the enquiry.
   *
   * The one call in this repo that reaches a real person. Rate-limited by the collector to
   * once per business, and refused outright unless the enquiry passes `./ethics.ts`.
   */
  submit(url: string, enquiry: Enquiry): Promise<Priced<Submission>>;

  /** Poll the monitored inbox for a reply. Contacts nobody. */
  response(submissionId: string): Promise<Priced<ResponseRecord | null>>;

  /**
   * Place one call and record whether a human picked up.
   *
   * Optional: a scan without a phone probe simply does not produce the phone findings,
   * rather than producing them wrongly.
   */
  call?(phone: string, enquiry: Enquiry): Promise<Priced<PhoneTest>>;
}
