import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DAY_MS,
  TTL,
  createFileProviderCache,
  createNullProviderCache,
  pruneCache,
} from './provider-cache';
import { FREE, type Priced } from '../resolve/providers';

const dirs: string[] = [];
const tempPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'cache-'));
  dirs.push(dir);
  return join(dir, 'cache.json');
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A provider that counts how often it was actually paid for. */
function countingProvider(value: unknown = { ok: true }) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fetch: async (_id: string): Promise<Priced<unknown>> => {
      calls += 1;
      return { value, cost: { pence: 3 } };
    },
  };
}

describe('file provider cache', () => {
  test('buys once, then serves free', async () => {
    const cache = createFileProviderCache(tempPath());
    const provider = countingProvider();
    const fetch = cache.wrap('reviews', TTL.reviews, (id: string) => id, provider.fetch);

    const first = await fetch('place-1');
    const second = await fetch('place-1');

    assert.equal(provider.calls, 1);
    assert.equal(first.cost.pence, 3);
    // A hit records nothing, because nothing happened — collector_runs.cost_pence has to
    // stay a measurement.
    assert.deepEqual(second.cost, FREE);
    assert.deepEqual(second.value, first.value);
  });

  test('different places are different purchases', async () => {
    const cache = createFileProviderCache(tempPath());
    const provider = countingProvider();
    const fetch = cache.wrap('reviews', TTL.reviews, (id: string) => id, provider.fetch);

    await fetch('place-1');
    await fetch('place-2');
    assert.equal(provider.calls, 2);
  });

  test('sources are namespaced, so two providers do not collide on a place_id', async () => {
    const cache = createFileProviderCache(tempPath());
    const reviews = countingProvider('reviews-payload');
    const gbp = countingProvider('gbp-payload');

    const a = cache.wrap('reviews', TTL.reviews, (id: string) => id, reviews.fetch);
    const b = cache.wrap('gbp', TTL.gbp, (id: string) => id, gbp.fetch);

    assert.equal((await a('same-id')).value, 'reviews-payload');
    assert.equal((await b('same-id')).value, 'gbp-payload');
  });

  test('survives the process — this is the whole point', async () => {
    // The billing data showed three runs re-buying the same six place_ids, because the
    // per-scan cache dies with the process.
    const path = tempPath();
    const first = countingProvider();
    await createFileProviderCache(path).wrap('reviews', TTL.reviews, (id: string) => id, first.fetch)('p1');

    const second = countingProvider();
    const reopened = createFileProviderCache(path);
    const hit = await reopened.wrap('reviews', TTL.reviews, (id: string) => id, second.fetch)('p1');

    assert.equal(second.calls, 0, 'a second run must not re-buy');
    assert.deepEqual(hit.cost, FREE);
  });

  test('re-buys once the entry is older than its TTL', async () => {
    const path = tempPath();
    const provider = countingProvider();
    // A TTL of zero expires immediately.
    const fetch = createFileProviderCache(path).wrap('reviews', 0, (id: string) => id, provider.fetch);

    await fetch('p1');
    await fetch('p1');
    assert.equal(provider.calls, 2);
  });

  test('caches a null answer', async () => {
    // "This business has no Business Profile" costs the same to establish as any other
    // answer and should not be re-bought.
    const cache = createFileProviderCache(tempPath());
    let calls = 0;
    const fetch = cache.wrap('gbp', TTL.gbp, (id: string) => id, async () => {
      calls += 1;
      return { value: null, cost: { pence: 3 } };
    });

    assert.equal((await fetch('missing')).value, null);
    assert.equal((await fetch('missing')).value, null);
    assert.equal(calls, 1);
  });

  test('does not cache a failure', async () => {
    // Storing an error would turn one bad minute into a week of them.
    const cache = createFileProviderCache(tempPath());
    let calls = 0;
    const fetch = cache.wrap('reviews', TTL.reviews, (id: string) => id, async () => {
      calls += 1;
      throw new Error('provider down');
    });

    await assert.rejects(() => fetch('p1'), /provider down/);
    await assert.rejects(() => fetch('p1'), /provider down/);
    assert.equal(calls, 2);
  });

  test('a corrupt cache file is a miss, not a crash', async () => {
    const path = tempPath();
    const { writeFileSync, mkdirSync } = await import('node:fs');
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'not json at all', 'utf8');

    const provider = countingProvider();
    const fetch = createFileProviderCache(path).wrap('reviews', TTL.reviews, (id: string) => id, provider.fetch);

    assert.deepEqual((await fetch('p1')).value, { ok: true });
    assert.equal(provider.calls, 1);
  });
});

describe('null provider cache', () => {
  test('never hits, so fixtures exercise the real call path', async () => {
    const cache = createNullProviderCache();
    const provider = countingProvider();
    const fetch = cache.wrap('reviews', TTL.reviews, (id: string) => id, provider.fetch);

    await fetch('p1');
    await fetch('p1');
    assert.equal(provider.calls, 2);
    assert.equal(cache.size(), 0);
  });
});

describe('pruneCache', () => {
  test('removes expired entries and keeps fresh ones', async () => {
    const path = tempPath();
    const cache = createFileProviderCache(path);
    await cache.wrap('reviews', TTL.reviews, (id: string) => id, async () => ({
      value: 1,
      cost: { pence: 1 },
    }))('fresh');

    assert.equal(pruneCache(path, DAY_MS), 0, 'a fresh entry survives');
    // Everything is expired against a max age of zero.
    assert.equal(pruneCache(path, 0), 1);
    assert.equal(createFileProviderCache(path).size(), 0);
  });

  test('no cache file is not an error', () => {
    assert.equal(pruneCache(join(tmpdir(), 'does-not-exist-cache.json')), 0);
  });

  test('TTLs are long enough to matter', () => {
    assert.ok(TTL.reviews >= 7 * DAY_MS);
    assert.ok(TTL.gbp >= 7 * DAY_MS);
    // Vitals move with a deploy, so they get a shorter life than a review history.
    assert.ok(TTL.vitals < TTL.gbp);
  });

  test('the cache file is only created once something is stored', () => {
    const path = tempPath();
    createFileProviderCache(path);
    assert.equal(existsSync(path), false);
  });
});
