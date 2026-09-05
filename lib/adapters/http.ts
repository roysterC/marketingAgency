/**
 * The HTTP client every non-Anthropic adapter sits on.
 *
 * Written once because the failure modes are the same everywhere and getting them wrong is
 * expensive in a specific way: a scan fans out over six targets and a dozen sources, so a
 * source that rate-limits under load will rate-limit *during a paid scan*, and a retry
 * storm against a metered API costs real money before it costs time.
 *
 * So: bounded retries, exponential backoff with jitter, `Retry-After` honoured when the
 * server sends it, and a hard rule that only 429s, 5xx and transport errors are retried.
 * A 400 is a bug in our request and retrying it just pays for the same mistake again.
 */

/** Everything a caller needs to tell one failure from another. */
export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }

  /** Whether trying again could plausibly work. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export class HttpTimeout extends Error {
  constructor(url: string, ms: number) {
    super(`Timed out after ${ms}ms: ${url}`);
    this.name = 'HttpTimeout';
  }
}

export interface RetryPolicy {
  /** Attempts in total, including the first. */
  attempts: number;
  /** First backoff, doubled each retry. */
  baseDelayMs: number;
  /** Never wait longer than this between attempts. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export interface RequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  retry?: RetryPolicy;
  /** Injectable so tests do not sleep and production does. */
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * How long to wait before attempt `n`.
 *
 * Jittered, because a scan fires its whole fan-out at once and un-jittered backoff would
 * have all six targets retry in the same millisecond — reproducing the burst that caused
 * the 429 in the first place.
 */
export function backoffFor(attempt: number, policy: RetryPolicy, random = Math.random): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return Math.round(capped * (0.5 + random() * 0.5));
}

/** `Retry-After` in seconds or as an HTTP date. Null when absent or unparseable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? null : Math.max(0, when - now);
}

/**
 * One request, with retries.
 *
 * Returns the parsed JSON body. Throws `HttpError` for a non-2xx the policy gave up on,
 * and `HttpTimeout` when the request outlived its budget.
 */
export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retry = DEFAULT_RETRY,
    sleep = realSleep,
    fetchImpl = fetch,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        const error = new HttpError(response.status, url, text);

        if (!error.retryable || attempt === retry.attempts) throw error;

        const advised = retryAfterMs(response.headers.get('retry-after'));
        await sleep(advised ?? backoffFor(attempt, retry));
        lastError = error;
        continue;
      }

      return (await response.json()) as T;
    } catch (cause) {
      // A timeout surfaces as an AbortError; everything else here is a transport failure.
      if (cause instanceof HttpError) {
        if (!cause.retryable || attempt === retry.attempts) throw cause;
        lastError = cause;
        continue;
      }

      const aborted = cause instanceof Error && cause.name === 'AbortError';
      const error = aborted ? new HttpTimeout(url, timeoutMs) : cause;
      if (attempt === retry.attempts) throw error;

      lastError = error;
      await sleep(backoffFor(attempt, retry));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Request failed: ${url}`);
}

/** Fetch a page as text rather than JSON. Used by the crawler and robots.txt lookups. */
export async function requestText(
  url: string,
  options: RequestOptions = {},
): Promise<{ status: number; text: string; finalUrl: string }> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headers = {},
    fetchImpl = fetch,
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { ...headers },
      redirect: 'follow',
      signal: controller.signal,
    });
    return {
      status: response.status,
      text: await response.text(),
      finalUrl: response.url || url,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw new HttpTimeout(url, timeoutMs);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

/** Query string from a record, skipping anything unset. */
export function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  return search.toString();
}
