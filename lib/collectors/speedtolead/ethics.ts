/**
 * The line this collector must not cross.
 *
 * `speedtolead` contacts real businesses. CLAUDE.md and spec §4 state the rule the same
 * way: the enquiry must be **genuine and identified** — a real question from a named inbox
 * we monitor. Never a fabricated job that sends a tradesperson out to quote work that does
 * not exist.
 *
 * What makes this worth code rather than a paragraph is that the *measurement is identical
 * either way*. The timestamps from a mystery shop and from a fake lead are the same
 * numbers; nothing downstream can tell them apart, and no test of the output would ever
 * catch the difference. The only place the distinction exists is in what we sent, so this
 * is the place it has to be enforced.
 *
 * That is CLAUDE.md rule 7's principle — the ethical constraint is enforced config, not
 * documentation — applied to the one collector in the repo that can do harm to someone who
 * never agreed to be part of this.
 *
 * `dispatchEnquiry` in `./index.ts` is the only path to a submission, and it calls
 * `assertGenuineEnquiry` before the probe is touched. A caller cannot route around it
 * without deleting this file, which is the intended level of difficulty.
 */

import type { Enquiry } from './types';

/** Raised before anything is sent. A failing enquiry is a misconfiguration, not a result. */
export class UnethicalEnquiryError extends Error {
  constructor(message: string) {
    super(`Refusing to contact a real business: ${message}`);
    this.name = 'UnethicalEnquiryError';
  }
}

/** Long enough to be a real question rather than a probe someone forgot to fill in. */
export const MIN_QUESTION_CHARS = 20;

/** Values that mean a field was never actually filled in. */
const PLACEHOLDERS = new Set([
  'test',
  'testing',
  'tester',
  'asdf',
  'qwerty',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'example',
  'foo',
  'bar',
  'baz',
  'xxx',
  'tbc',
  'tbd',
]);

/**
 * Phrasings that describe work rather than ask a question.
 *
 * A backstop, not a substitute for judgement. It cannot tell a real enquiry from an
 * invented one in general — that is a human call made when the enquiry text is written.
 * What it does catch is the specific, likely mistake: someone reaching for a realistic
 * enquiry and writing one that books a job. "What's your callout fee?" costs the recipient
 * thirty seconds. "Can you come out Tuesday?" costs them an afternoon.
 */
export const BOOKING_PHRASES: RegExp[] = [
  /\bbook\s+(a|an|me|us|in)\b/i,
  /\bcome\s+(out|round|over)\b/i,
  /\bappointment\b/i,
  /\bquote\s+for\b/i,
  /when\s+can\s+you\s+(start|come|do)\b/i,
  /\bsend\s+someone\b/i,
  /\bneed\s+(it|this|someone)\s+(done|out)\b/i,
];

const isPlaceholder = (value: string): boolean =>
  PLACEHOLDERS.has(value.trim().toLowerCase().replace(/[.\s]+$/, ''));

const blank = (value: string | undefined | null): boolean => !value || value.trim().length === 0;

/** Deliberately loose — this checks the field was filled in, not that the inbox exists. */
const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

/**
 * Refuse anything that is not a genuine, identified enquiry.
 *
 * Throws rather than returning a reason: this runs before contact, and a caller that has
 * misconfigured the identity should stop, not degrade.
 */
export function assertGenuineEnquiry(enquiry: Enquiry): void {
  const { identity, question } = enquiry;

  if (blank(identity.from_name) || isPlaceholder(identity.from_name)) {
    throw new UnethicalEnquiryError('the enquiry has no real sender name');
  }

  if (blank(identity.reply_to) || !looksLikeEmail(identity.reply_to)) {
    throw new UnethicalEnquiryError('the enquiry has no monitored reply address');
  }

  if (isPlaceholder(identity.reply_to.split('@')[0] ?? '')) {
    throw new UnethicalEnquiryError('the reply address is a placeholder');
  }

  if (blank(identity.phone)) {
    throw new UnethicalEnquiryError('the enquiry has no monitored phone number');
  }

  if (blank(identity.disclosure)) {
    // The recipient is entitled to know who is asking. "AI-assisted, human-approved" is
    // defensible; concealment is not — see the risk list in docs/strategy.md.
    throw new UnethicalEnquiryError('the enquiry does not say who it is from');
  }

  const text = question.trim();

  if (text.length < MIN_QUESTION_CHARS || isPlaceholder(text)) {
    throw new UnethicalEnquiryError('the question is not a real question');
  }

  if (!text.includes('?')) {
    throw new UnethicalEnquiryError('the enquiry asks nothing — a mystery shop asks a question');
  }

  const booking = BOOKING_PHRASES.find((pattern) => pattern.test(text));
  if (booking) {
    throw new UnethicalEnquiryError(
      `the enquiry reads as booking work rather than asking a question (matched ${booking})`,
    );
  }
}

/** Whether an enquiry would be accepted, without throwing. For tests and config checks. */
export function isGenuineEnquiry(enquiry: Enquiry): boolean {
  try {
    assertGenuineEnquiry(enquiry);
    return true;
  } catch {
    return false;
  }
}
