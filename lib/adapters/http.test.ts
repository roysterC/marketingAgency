import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RETRY,
  HttpError,
  HttpTimeout,
  backoffFor,
  query,
  requestJson,
  retryAfterMs,
} from './http';

/** A Response-shaped stub. Enough of the interface for the client to read. */
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://example.test/x',
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Returns the queued responses in order, recording how many calls were made. */
function stubFetch(queue: Array<Response | Error>) {
  let calls = 0;
  const impl = (async () => {
    const next = queue[calls];
    calls += 1;
    if (next instanceof Error) throw next;
    if (!next) throw new Error('stub fetch ran out of responses');
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const noSleep = async (): Promise<void> => {};
const fast = { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 };

describe('retrying', () => {
  test('a 429 is retried and then succeeds', async () => {
    const fetchStub = stubFetch([response(429, { error: 'slow down' }), response(200, { ok: 1 })]);
    const body = await requestJson<{ ok: number }>('https://example.test/x', {
      retry: fast,
      sleep: noSleep,
      fetchImpl: fetchStub.impl,
    });

    assert.equal(body.ok, 1);
    assert.equal(fetchStub.calls(), 2);
  });

  test('a 500 is retried', async () => {
    const fetchStub = stubFetch([response(503, {}), response(200, { ok: 1 })]);
    await requestJson('https://example.test/x', {
      retry: fast,
      sleep: noSleep,
      fetchImpl: fetchStub.impl,
    });
    assert.equal(fetchStub.calls(), 2);
  });

  test('a 400 is not retried — the request is wrong, and paying twice will not fix it', async () => {
    const fetchStub = stubFetch([response(400, { error: 'bad field mask' })]);

    await assert.rejects(
      () =>
        requestJson('https://example.test/x', {
          retry: fast,
          sleep: noSleep,
          fetchImpl: fetchStub.impl,
        }),
      HttpError,
    );
    assert.equal(fetchStub.calls(), 1);
  });

  test('a 401 is not retried either', async () => {
    const fetchStub = stubFetch([response(401, {})]);
    await assert.rejects(() =>
      requestJson('https://example.test/x', {
        retry: fast,
        sleep: noSleep,
        fetchImpl: fetchStub.impl,
      }),
    );
    assert.equal(fetchStub.calls(), 1);
  });

  test('gives up after the configured number of attempts', async () => {
    const fetchStub = stubFetch([response(429, {}), response(429, {}), response(429, {})]);

    await assert.rejects(
      () =>
        requestJson('https://example.test/x', {
          retry: fast,
          sleep: noSleep,
          fetchImpl: fetchStub.impl,
        }),
      (error: unknown) => error instanceof HttpError && error.status === 429,
    );
    assert.equal(fetchStub.calls(), 3);
  });

  test('a transport failure is retried', async () => {
    const fetchStub = stubFetch([new TypeError('fetch failed'), response(200, { ok: 1 })]);
    await requestJson('https://example.test/x', {
      retry: fast,
      sleep: noSleep,
      fetchImpl: fetchStub.impl,
    });
    assert.equal(fetchStub.calls(), 2);
  });

  test('a timeout surfaces as HttpTimeout rather than an AbortError', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const fetchStub = stubFetch([abort, abort, abort]);

    await assert.rejects(
      () =>
        requestJson('https://example.test/x', {
          retry: fast,
          sleep: noSleep,
          fetchImpl: fetchStub.impl,
        }),
      HttpTimeout,
    );
  });
});

describe('waiting the right amount of time', () => {
  test('honours Retry-After in seconds', async () => {
    const waits: number[] = [];
    const fetchStub = stubFetch([
      response(429, {}, { 'retry-after': '7' }),
      response(200, { ok: 1 }),
    ]);

    await requestJson('https://example.test/x', {
      retry: fast,
      sleep: async (ms) => {
        waits.push(ms);
      },
      fetchImpl: fetchStub.impl,
    });

    assert.deepEqual(waits, [7000]);
  });

  test('parses Retry-After as an HTTP date', () => {
    const now = Date.parse('2026-09-04T12:00:00.000Z');
    assert.equal(retryAfterMs('Fri, 04 Sep 2026 12:00:30 GMT', now), 30_000);
  });

  test('ignores a Retry-After it cannot read', () => {
    assert.equal(retryAfterMs('soon'), null);
    assert.equal(retryAfterMs(null), null);
  });

  test('backs off exponentially', () => {
    const noJitter = () => 1;
    assert.equal(backoffFor(1, DEFAULT_RETRY, noJitter), 500);
    assert.equal(backoffFor(2, DEFAULT_RETRY, noJitter), 1000);
    assert.equal(backoffFor(3, DEFAULT_RETRY, noJitter), 2000);
  });

  test('caps the wait', () => {
    assert.equal(backoffFor(10, DEFAULT_RETRY, () => 1), DEFAULT_RETRY.maxDelayMs);
  });

  test('jitters, so a six-target fan-out does not retry in lockstep', () => {
    // Un-jittered backoff reproduces the burst that caused the 429.
    const low = backoffFor(3, DEFAULT_RETRY, () => 0);
    const high = backoffFor(3, DEFAULT_RETRY, () => 1);
    assert.equal(low, 1000);
    assert.equal(high, 2000);
    assert.ok(low < high);
  });
});

describe('query strings', () => {
  test('skips anything unset, so an absent key is absent rather than "undefined"', () => {
    assert.equal(query({ url: 'https://x.test', key: undefined, strategy: 'mobile' }),
      'url=https%3A%2F%2Fx.test&strategy=mobile');
  });

  test('encodes values', () => {
    assert.equal(query({ q: 'a b&c' }), 'q=a+b%26c');
  });
});

describe('HttpError', () => {
  test('knows which failures are worth retrying', () => {
    assert.equal(new HttpError(429, 'u', '').retryable, true);
    assert.equal(new HttpError(500, 'u', '').retryable, true);
    assert.equal(new HttpError(400, 'u', '').retryable, false);
    assert.equal(new HttpError(404, 'u', '').retryable, false);
  });

  test('carries enough to debug without re-running the request', () => {
    const error = new HttpError(400, 'https://places.test/v1', '{"error":"bad field mask"}');
    assert.equal(error.status, 400);
    assert.match(error.message, /bad field mask/);
    assert.match(error.message, /places\.test/);
  });
});
