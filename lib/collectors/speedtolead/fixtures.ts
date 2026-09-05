/**
 * Speed-to-lead fixtures — four businesses answering at four speeds, plus the two ways a
 * contact form fails.
 *
 * Nothing here sends anything. That is the point: the whole collector can be exercised,
 * including the enquiry path, without a real inbox and without a real tradesperson's
 * afternoon.
 */

import { FREE, type Priced } from '../../resolve/providers';
import type {
  ContactSurfaces,
  Enquiry,
  PhoneTest,
  ResponseRecord,
  SpeedToLeadProbe,
  Submission,
} from './types';

/** Loading a page and submitting a form: worker seconds, same as the sitetech crawl. */
const INSPECT_COST = { pence: 1 };
/** A tracked call through a telephony provider. */
const CALL_COST = { pence: 2 };

const MS_PER_MINUTE = 60_000;

/**
 * A real question, from a named person, on an inbox we monitor.
 *
 * Cheap for the recipient to answer — thirty seconds — and it measures response time
 * exactly as truthfully as a fabricated job would have. See `./ethics.ts`.
 */
export const GENUINE_ENQUIRY: Enquiry = {
  identity: {
    from_name: 'Roy Cheung',
    reply_to: 'enquiries@growthsystems.example',
    phone: '+442080000000',
    disclosure: 'I run a small marketing consultancy in south London.',
  },
  question: 'Do you cover SW18, and what is your callout fee for a weekday visit?',
};

const surfaces = (over: Partial<ContactSurfaces> = {}): ContactSurfaces => ({
  form_url: 'https://example/contact',
  form_status: 'ok',
  form_error: null,
  phone_visible_mobile: true,
  screenshot_key: 'evidence/contact.png',
  ...over,
});

export interface FixtureSite {
  surfaces: ContactSurfaces;
  /** Minutes until the first reply. Null means nothing ever arrives. */
  reply_after_minutes: number | null;
  phone?: PhoneTest;
}

/**
 * The subject and its competitor set.
 *
 * Riverside takes 31 hours; the fastest competitor takes four minutes. That gap is the
 * line the whole report is designed around.
 */
export const SITES: Record<string, FixtureSite> = {
  'riversideplumbing.example': {
    surfaces: surfaces({
      form_url: 'http://riversideplumbing.example/contact',
      phone_visible_mobile: false,
    }),
    reply_after_minutes: 31 * 60,
  },
  'wandsworthplumbers.example': {
    surfaces: surfaces({ form_url: 'https://wandsworthplumbers.example/contact' }),
    reply_after_minutes: 4,
  },
  'swheating.example': {
    surfaces: surfaces({ form_url: 'https://swheating.example/contact' }),
    reply_after_minutes: 90,
  },
  'quickfix.example': {
    surfaces: surfaces({ form_url: 'https://quickfix.example/contact' }),
    reply_after_minutes: 30,
  },
  /** The form posts and nothing arrives. The most valuable finding the engine produces. */
  'brokenform.example': {
    surfaces: surfaces({
      form_url: 'https://brokenform.example/contact',
      form_status: 'broken',
      form_error: 'POST /contact returned 500',
    }),
    reply_after_minutes: null,
  },
  /** No form at all, and no number visible on a phone either. */
  'noform.example': {
    surfaces: surfaces({
      form_url: null,
      form_status: null,
      phone_visible_mobile: false,
    }),
    reply_after_minutes: null,
  },
  /** Form works, enquiry lands, nobody ever answers it. */
  'silent.example': {
    surfaces: surfaces({ form_url: 'https://silent.example/contact' }),
    reply_after_minutes: null,
    phone: { called_at: '', answered: false, rang_seconds: 45 },
  },
};

const hostOf = (url: string): string =>
  url.replace(/^https?:\/\//, '').split('/')[0]!.toLowerCase();

/**
 * A probe with a fixed clock, so every derived timestamp is arithmetic a test can state.
 *
 * `submitted` records what was actually sent, so the ethics guard can be checked from the
 * outside rather than only by trusting that it ran.
 */
export function fixtureProbe(now: Date): SpeedToLeadProbe & {
  submitted: () => Array<{ url: string; enquiry: Enquiry }>;
  calls: () => number;
} {
  const submitted: Array<{ url: string; enquiry: Enquiry }> = [];
  const byId = new Map<string, { host: string; at: number }>();
  let calls = 0;

  return {
    name: 'fixture-speedtolead',
    submitted: () => submitted,
    calls: () => calls,

    async inspect(url): Promise<Priced<ContactSurfaces>> {
      const site = SITES[hostOf(url)];
      if (!site) throw new Error(`no fixture site for ${url}`);
      return { value: site.surfaces, cost: INSPECT_COST };
    },

    async submit(url, enquiry): Promise<Priced<Submission>> {
      const host = hostOf(url);
      const site = SITES[host];
      if (!site) throw new Error(`no fixture site for ${url}`);

      submitted.push({ url, enquiry });
      const id = `sub_${host}_${submitted.length}`;
      byId.set(id, { host, at: now.getTime() });

      return {
        value: {
          id,
          submitted_at: now.toISOString(),
          form_url: url,
          channel: 'form',
        },
        cost: FREE,
      };
    },

    async response(submissionId): Promise<Priced<ResponseRecord | null>> {
      const sent = byId.get(submissionId);
      if (!sent) return { value: null, cost: FREE };

      const minutes = SITES[sent.host]?.reply_after_minutes ?? null;
      if (minutes === null) return { value: null, cost: FREE };

      return {
        value: {
          first_response_at: new Date(sent.at + minutes * MS_PER_MINUTE).toISOString(),
          channel: 'form',
          excerpt: 'Yes we cover SW18, callout is £70 plus parts.',
        },
        cost: FREE,
      };
    },

    async call(_phone, _enquiry): Promise<Priced<PhoneTest>> {
      calls += 1;
      return {
        value: { called_at: now.toISOString(), answered: false, rang_seconds: 45 },
        cost: CALL_COST,
      };
    },
  };
}

/** A probe whose site inspection fails. The section thins; the scan does not stop. */
export const deadProbe: SpeedToLeadProbe = {
  name: 'fixture-speedtolead-dead',
  async inspect(): Promise<Priced<ContactSurfaces>> {
    throw new Error('crawl worker timed out');
  },
  async submit(): Promise<Priced<Submission>> {
    throw new Error('should never be reached without a form');
  },
  async response(): Promise<Priced<ResponseRecord | null>> {
    return { value: null, cost: FREE };
  },
};

/** Enquiries the guard must refuse, and why. */
export const REFUSED_ENQUIRIES: Array<{ why: string; enquiry: Enquiry }> = [
  {
    why: 'anonymous',
    enquiry: { ...GENUINE_ENQUIRY, identity: { ...GENUINE_ENQUIRY.identity, from_name: '' } },
  },
  {
    why: 'placeholder name',
    enquiry: { ...GENUINE_ENQUIRY, identity: { ...GENUINE_ENQUIRY.identity, from_name: 'Test' } },
  },
  {
    why: 'no monitored inbox',
    enquiry: { ...GENUINE_ENQUIRY, identity: { ...GENUINE_ENQUIRY.identity, reply_to: 'not-an-address' } },
  },
  {
    why: 'placeholder inbox',
    enquiry: {
      ...GENUINE_ENQUIRY,
      identity: { ...GENUINE_ENQUIRY.identity, reply_to: 'test@growthsystems.example' },
    },
  },
  {
    why: 'no monitored phone',
    enquiry: { ...GENUINE_ENQUIRY, identity: { ...GENUINE_ENQUIRY.identity, phone: '  ' } },
  },
  {
    why: 'conceals who is asking',
    enquiry: { ...GENUINE_ENQUIRY, identity: { ...GENUINE_ENQUIRY.identity, disclosure: '' } },
  },
  {
    why: 'asks nothing',
    enquiry: { ...GENUINE_ENQUIRY, question: 'Hello, I am interested in your services.' },
  },
  {
    why: 'too short to be a real question',
    enquiry: { ...GENUINE_ENQUIRY, question: 'price?' },
  },
  {
    why: 'books work that does not exist',
    enquiry: { ...GENUINE_ENQUIRY, question: 'Can you come out on Tuesday to look at my boiler?' },
  },
  {
    why: 'asks for a quote on an invented job',
    enquiry: { ...GENUINE_ENQUIRY, question: 'What is your quote for a new bathroom install?' },
  },
];
