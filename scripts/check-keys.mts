#!/usr/bin/env node
/**
 * Reports which provider credentials are configured, and optionally whether they work.
 *
 *   npm run check:keys           present / missing. No network, no spend.
 *   npm run check:keys -- --live one real call per provider to prove each key is accepted.
 *
 * **It never prints a value.** Not truncated, not masked, not a length — a key that reaches
 * a terminal has reached a scrollback buffer, and this is a file people will run while
 * screen-sharing.
 *
 * The `--live` pass exists because "the variable is set" and "the key works" are different
 * facts, and the gap between them is discovered at the worst possible moment otherwise:
 * halfway through a scan that has already spent money on the providers that came first.
 */

import { CREDENTIALS, loadDotEnv, optional } from '../lib/adapters/config.ts';

const live = process.argv.includes('--live');
const loaded = loadDotEnv();

const env = process.env;
const green = (s: string) => `[32m${s}[0m`;
const red = (s: string) => `[31m${s}[0m`;
const dim = (s: string) => `[2m${s}[0m`;
const amber = (s: string) => `[33m${s}[0m`;

/**
 * Shape problems that do not require looking at the value in the output.
 *
 * All three are ordinary `.env` mistakes and all three produce a 401 that looks like a
 * wrong key rather than a malformed one.
 */
function shapeWarning(value: string): string | null {
  if (/^['"].*['"]$/.test(value)) return 'wrapped in quotes — .env does not need them';
  if (/\s/.test(value)) return 'contains whitespace — check for a wrapped or pasted line break';
  if (/your[-_]|xxx|placeholder|changeme|<.*>/i.test(value)) return 'still looks like a placeholder';
  return null;
}

interface Check {
  ok: boolean;
  detail: string;
}

/** One cheap call per provider. Cost is noted where it is not zero. */
const LIVE: Record<string, () => Promise<Check>> = {
  async GOOGLE_PLACES_API_KEY(): Promise<Check> {
    const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY!,
        'X-Goog-FieldMask': 'places.id',
      },
      body: JSON.stringify({ textQuery: 'plumber SW18', regionCode: 'GB', maxResultCount: 1 }),
    });
    return { ok: response.ok, detail: response.ok ? 'accepted (~3p)' : await reason(response) };
  },

  /**
   * Credentials, then capability — they are not the same fact.
   *
   * `appendix/user_data` answers 20000 with a balance on an account that cannot call a
   * single data endpoint. An unverified account looks exactly like a working one there, and
   * this check said "accepted, balance $1" about credentials whose every SERP call came
   * back 403 / 40104 ("Please verify your account before using the API"). The first live
   * scan found that out after paying for the subject lookup.
   *
   * So the second call is the endpoint the scan actually depends on. It costs a fraction of
   * a penny, which is the point of --live being opt-in.
   */
  async DATAFORSEO_LOGIN(): Promise<Check> {
    const auth = Buffer.from(`${env.DATAFORSEO_LOGIN}:${env.DATAFORSEO_PASSWORD}`).toString('base64');
    const headers = { authorization: `Basic ${auth}`, 'content-type': 'application/json' };

    const identity = await fetch('https://api.dataforseo.com/v3/appendix/user_data', { headers });
    if (!identity.ok) return { ok: false, detail: await reason(identity) };

    // DataForSEO reports auth failures in the body with a 200.
    const body = (await identity.json()) as { status_code?: number; tasks?: Array<{ result?: unknown }> };
    if (body.status_code !== 20000) return { ok: false, detail: `status_code ${body.status_code}` };

    const balance = (body.tasks?.[0] as { result?: Array<{ money?: { balance?: number } }> })
      ?.result?.[0]?.money?.balance;
    const funds = balance === undefined ? '' : `, balance $${balance}`;

    // One real map pack call. Anything other than 20000 here means the scan cannot buy the
    // data it is built on, whatever the credentials say.
    const probe = await fetch('https://api.dataforseo.com/v3/serp/google/maps/live/advanced', {
      method: 'POST',
      headers,
      body: JSON.stringify([
        { keyword: 'plumber', language_code: 'en', location_code: 2826, depth: 1 },
      ]),
    });

    if (!probe.ok) {
      return { ok: false, detail: `credentials fine${funds}, but data endpoints refused: ${await reason(probe)}` };
    }

    const result = (await probe.json()) as { status_code?: number; status_message?: string };
    if (result.status_code !== 20000) {
      return {
        ok: false,
        detail:
          `credentials fine${funds}, but data endpoints refused: ` +
          `${result.status_code} ${result.status_message ?? ''}`.trim(),
      };
    }

    return { ok: true, detail: `accepted, map pack live${funds} (~0.2p)` };
  },

  async ANTHROPIC_API_KEY(): Promise<Check> {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        // Cheapest model that proves the key authenticates — this call is a credential
        // ping, not work, and any model answers the only question being asked.
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // A 400 for max_tokens still proves the key authenticated.
    const authenticated = response.ok || (response.status !== 401 && response.status !== 403);
    return { ok: authenticated, detail: authenticated ? 'accepted' : await reason(response) };
  },

  async PAGESPEED_API_KEY(): Promise<Check> {
    const url =
      'https://www.googleapis.com/pagespeedonline/v5/runPagespeed' +
      `?url=https%3A%2F%2Fexample.com&strategy=mobile&key=${env.PAGESPEED_API_KEY}`;
    const response = await fetch(url);
    return { ok: response.ok, detail: response.ok ? 'accepted (free)' : await reason(response) };
  },

  async OPENAI_API_KEY(): Promise<Check> {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    return { ok: response.ok, detail: response.ok ? 'accepted (free)' : await reason(response) };
  },

  async PERPLEXITY_API_KEY(): Promise<Check> {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.PERPLEXITY_API_KEY}`,
      },
      body: JSON.stringify({ model: 'sonar', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const authenticated = response.ok || (response.status !== 401 && response.status !== 403);
    return { ok: authenticated, detail: authenticated ? 'accepted' : await reason(response) };
  },
};

/** A short failure reason. Provider error bodies do not echo the key back. */
async function reason(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  const line = text.replace(/\s+/g, ' ').slice(0, 120);
  return `HTTP ${response.status}${line ? ` — ${line}` : ''}`;
}

// ------------------------------------------------------------------- report

console.log(
  `\n  ${loaded ? 'Loaded .env' : dim('No .env found — reading the shell environment only')}`,
);
if (live) {
  console.log(dim('  --live: one real call per configured provider. Costs a few pence in total.'));
}
console.log('');

const missingRequired: string[] = [];
const failedLive: string[] = [];

for (const credential of CREDENTIALS) {
  const value = optional(env, credential.variable);
  const label = credential.variable.padEnd(22);
  const tag = credential.required ? '' : dim(' (optional)');

  if (value === undefined) {
    if (credential.required) missingRequired.push(credential.variable);
    const mark = credential.required ? red('missing') : dim('not set');
    console.log(`  ${mark.padEnd(20)} ${label} ${dim(credential.purpose)}${tag}`);
    continue;
  }

  const warning = shapeWarning(value);
  if (warning) {
    // A placeholder is not a credential. Counting it as set would let the readiness check
    // pass on a file nobody has actually filled in.
    if (credential.required) missingRequired.push(credential.variable);
    console.log(`  ${amber('check it').padEnd(20)} ${label} ${amber(warning)}`);
    continue;
  }

  if (!live || !LIVE[credential.variable]) {
    console.log(`  ${green('set').padEnd(20)} ${label} ${dim(credential.purpose)}${tag}`);
    continue;
  }

  try {
    const result = await LIVE[credential.variable]!();
    if (result.ok) {
      console.log(`  ${green('works').padEnd(20)} ${label} ${dim(result.detail)}`);
    } else {
      failedLive.push(credential.variable);
      console.log(`  ${red('rejected').padEnd(20)} ${label} ${red(result.detail)}`);
    }
  } catch (error) {
    failedLive.push(credential.variable);
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  ${red('unreachable').padEnd(20)} ${label} ${red(message.slice(0, 100))}`);
  }
}

console.log('');

// DATAFORSEO_PASSWORD is verified as part of the login check rather than on its own.
if (missingRequired.length > 0) {
  console.error(
    `  ${red('Not ready to scan')} — ${missingRequired.length} required credential(s) ` +
      `missing or unusable:\n` +
      missingRequired.map((v) => `    - ${v}`).join('\n') +
      `\n\n  See .env.example for what each one is for.\n`,
  );
  process.exit(1);
}

if (failedLive.length > 0) {
  console.error(`  ${red('Configured but not working')}: ${failedLive.join(', ')}\n`);
  process.exit(1);
}

console.log(
  `  ${green('Ready')} — every required credential is set${live ? ' and accepted' : ''}.` +
    `${live ? '' : dim('\n  Run with --live to check they actually work.')}\n`,
);
