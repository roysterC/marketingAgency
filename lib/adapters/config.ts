/**
 * Provider credentials, read from the environment.
 *
 * `docs/data-sources.md` is explicit that keys live in environment variables and never in
 * the repository. This is the one place that reads them, so `.env.example` has exactly one
 * file to stay in step with.
 *
 * Every adapter takes an explicit config object and has a separate `fromEnv()` helper.
 * That split matters: it keeps the adapters constructible in a test without touching
 * `process.env`, and it means a missing key fails at construction with a message naming
 * the variable rather than as a 401 halfway through a paid scan.
 */

/**
 * Load `.env` into `process.env`, if there is one.
 *
 * Node has done this natively since 20, so there is no dotenv dependency. Values already in
 * the environment win — a key exported in the shell or injected by a host should not be
 * silently overridden by a stale local file.
 *
 * Missing is fine and silent: the test suite runs with no `.env` at all, which is the point
 * of every provider having a fixture behind the same interface.
 */
export function loadDotEnv(path = '.env'): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

export class MissingCredential extends Error {
  readonly variable: string;

  constructor(variable: string, purpose: string) {
    super(
      `${variable} is not set. It is needed for ${purpose}. ` +
        `See .env.example for the full set.`,
    );
    this.name = 'MissingCredential';
    this.variable = variable;
  }
}

export type Env = Record<string, string | undefined>;

/** Read a required variable, or fail with something actionable. */
export function required(env: Env, variable: string, purpose: string): string {
  const value = env[variable];
  if (value === undefined || value.trim() === '') {
    throw new MissingCredential(variable, purpose);
  }
  return value.trim();
}

/** Read an optional variable. Undefined rather than empty string when unset. */
export function optional(env: Env, variable: string): string | undefined {
  const value = env[variable];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/**
 * Every variable the engine reads, with what it is for.
 *
 * Exported so `.env.example` and the docs can be checked against it rather than drifting —
 * the same discipline `check:taxonomy` applies to finding codes.
 */
export const CREDENTIALS = [
  {
    variable: 'GOOGLE_PLACES_API_KEY',
    purpose: 'business listings and the gbp collector',
    required: true,
  },
  {
    variable: 'PAGESPEED_API_KEY',
    purpose: 'Core Web Vitals — PageSpeed works unkeyed but is rate-limited hard',
    required: false,
  },
  {
    variable: 'DATAFORSEO_LOGIN',
    purpose: 'map pack positions and full review history',
    required: true,
  },
  {
    variable: 'DATAFORSEO_PASSWORD',
    purpose: 'map pack positions and full review history',
    required: true,
  },
  {
    variable: 'ANTHROPIC_API_KEY',
    purpose: 'the narrative writer, and Claude in the aivis prompt set',
    required: true,
  },
  {
    variable: 'OPENAI_API_KEY',
    purpose: 'GPT in the aivis prompt set',
    required: false,
  },
  {
    variable: 'PERPLEXITY_API_KEY',
    purpose: 'Perplexity in the aivis prompt set',
    required: false,
  },
  {
    variable: 'STL_FROM_NAME',
    purpose: 'the named sender on speed-to-lead enquiries — see the ethics note in the spec',
    required: false,
  },
  {
    variable: 'STL_REPLY_TO',
    purpose: 'the monitored inbox that receives and times replies',
    required: false,
  },
  {
    variable: 'STL_PHONE',
    purpose: 'the monitored number on speed-to-lead enquiries',
    required: false,
  },
  {
    variable: 'STL_DISCLOSURE',
    purpose: 'the one line saying who is asking',
    required: false,
  },
] as const;

/** Which required credentials are missing. For a startup check rather than a scan. */
export function missingCredentials(env: Env): string[] {
  return CREDENTIALS.filter((c) => c.required && optional(env, c.variable) === undefined).map(
    (c) => c.variable,
  );
}
