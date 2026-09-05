/**
 * Speed to lead — the read-only probe.
 *
 * **This probe contacts nobody.** Sending enquiries is deferred on social grounds
 * (`docs/teardown-engine.md` §4), and this is the part of `speedtolead` that survives that
 * decision intact: two of the seven codes are established by looking at a site, which the
 * crawler already does anyway.
 *
 * | Code | Needs |
 * |---|---|
 * | `STL_NO_FORM_ON_SITE` | Looking at the page |
 * | `STL_NO_PHONE_VISIBLE_MOBILE` | Looking at the page |
 * | The other five | Sending an enquiry or placing a call |
 *
 * The safety property is structural rather than a promise. `inspect()` reports
 * `form_status: null` — not established — and the collector only calls `submit()` when it
 * reads `ok`. So the sending path is never entered, rather than being entered and refused.
 * `submit()` throws anyway, as a second line: if the collector's logic ever changes, this
 * fails loudly instead of quietly writing to a stranger.
 *
 * Etiquette is the crawler's, because it is the same act: robots.txt is respected, the user
 * agent identifies us and carries a contact URL, and requests are spaced out.
 */

import { FREE, type Cost, type Priced } from '../resolve/providers';
import type {
  ContactSurfaces,
  Enquiry,
  ResponseRecord,
  SpeedToLeadProbe,
  Submission,
} from '../collectors/speedtolead/types';
import { userAgentFor } from './crawler';
import { contactPageLinks, hasContactForm, hasTapToCall, resolveUrl } from './html';
import { requestText } from './http';
import { PERMISSIVE, isAllowed, parseRobots, type RobotsRules } from './robots';
import { parse } from 'node-html-parser';

/**
 * Raised if anything ever asks this probe to send.
 *
 * Should be unreachable: the collector gates submission on `form_status === 'ok'` and this
 * probe never reports that. It exists so the unreachable case is loud rather than silent —
 * the failure being guarded against is contacting a real business by accident.
 */
export class SendingIsDeferred extends Error {
  constructor(url: string) {
    super(
      `Refusing to send an enquiry to ${url}: the read-only probe does not contact anyone. ` +
        `Sending is deferred — see docs/teardown-engine.md §4.`,
    );
    this.name = 'SendingIsDeferred';
  }
}

export interface ReadOnlyProbeConfig {
  /** Same requirement as the crawler: identifiable, with somewhere to complain to. */
  contactUrl: string;
  /** How many contact-page candidates to follow when the homepage has no form. */
  maxContactPages?: number;
  delayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  costPerInspection?: Cost;
}

export const DEFAULT_MAX_CONTACT_PAGES = 3;
/** Worker seconds, amortised. The same page fetch the crawler makes. */
const DEFAULT_COST: Cost = { pence: 1 };

interface Looked {
  form: boolean;
  phone: boolean;
  url: string;
  /** Kept from the same response, so finding the contact page costs no second fetch. */
  contactLinks: string[];
}

export function createReadOnlyProbe(config: ReadOnlyProbeConfig): SpeedToLeadProbe {
  const {
    contactUrl,
    maxContactPages = DEFAULT_MAX_CONTACT_PAGES,
    delayMs = 1_000,
    timeoutMs = 15_000,
    fetchImpl,
    sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    costPerInspection = DEFAULT_COST,
  } = config;

  const options = {
    headers: { 'user-agent': userAgentFor(contactUrl) },
    timeoutMs,
    ...(fetchImpl ? { fetchImpl } : {}),
  };

  const look = async (url: string): Promise<Looked | null> => {
    const response = await requestText(url, options);
    if (response.status >= 400) return null;

    const root = parse(response.text);
    return {
      form: hasContactForm(root),
      phone: hasTapToCall(root),
      url: response.finalUrl,
      contactLinks: contactPageLinks(root),
    };
  };

  return {
    name: 'read-only-probe',

    async inspect(target): Promise<Priced<ContactSurfaces>> {
      const start = target.startsWith('http') ? target : `https://${target}`;
      const origin = new URL(start).origin;

      let rules: RobotsRules = PERMISSIVE;
      try {
        const robots = await requestText(`${origin}/robots.txt`, options);
        if (robots.status === 200) rules = parseRobots(robots.text, userAgentFor(contactUrl));
      } catch {
        // Absent is permissive, by convention.
      }

      const gap = Math.max(delayMs, rules.crawlDelayMs ?? 0);
      const absent: ContactSurfaces = {
        form_url: null,
        form_status: null,
        form_error: null,
        phone_visible_mobile: false,
        screenshot_key: null,
      };

      if (!isAllowed(new URL(start).pathname, rules)) return { value: absent, cost: FREE };

      let home: Looked | null = null;
      try {
        await sleep(gap);
        home = await look(start);
      } catch {
        // An unreachable site tells us nothing. Reporting "no contact form" because the
        // server timed out would be a finding about our network, not their site.
        return { value: absent, cost: costPerInspection };
      }

      if (!home) return { value: absent, cost: costPerInspection };

      // A tap-to-call link anywhere on the homepage is enough to clear the phone finding.
      let phone = home.phone;
      if (home.form) {
        return {
          value: {
            form_url: home.url,
            // Never `ok`. Whether it works cannot be known without sending.
            form_status: null,
            form_error: null,
            phone_visible_mobile: phone,
            screenshot_key: null,
          },
          cost: costPerInspection,
        };
      }

      // --- most sites keep the form on a contact page ----------------------
      const candidates = home.contactLinks
        .map((href) => resolveUrl(href, home.url))
        .filter((u): u is string => u !== null && new URL(u).origin === origin)
        .filter((u) => isAllowed(new URL(u).pathname, rules))
        .slice(0, maxContactPages);

      for (const candidate of candidates) {
        try {
          await sleep(gap);
          const looked = await look(candidate);
          if (!looked) continue;
          phone = phone || looked.phone;
          if (looked.form) {
            return {
              value: {
                form_url: looked.url,
                form_status: null,
                form_error: null,
                phone_visible_mobile: phone,
                screenshot_key: null,
              },
              cost: costPerInspection,
            };
          }
        } catch {
          continue;
        }
      }

      return {
        value: { ...absent, phone_visible_mobile: phone },
        cost: costPerInspection,
      };
    },

    async submit(url: string, _enquiry: Enquiry): Promise<Priced<Submission>> {
      throw new SendingIsDeferred(url);
    },

    async response(_submissionId: string): Promise<Priced<ResponseRecord | null>> {
      // Nothing was ever sent, so nothing can have come back.
      return { value: null, cost: FREE };
    },

    // `call` is deliberately absent rather than throwing. The collector checks for it, so
    // omitting it means the phone test is never attempted.
  };
}
