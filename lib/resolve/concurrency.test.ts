import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  PLACES_CONCURRENCY,
  SERP_CONCURRENCY,
  mapLimit,
  settleLimit,
} from './concurrency';

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Records the highest number of calls in flight at once. */
function watcher() {
  let inFlight = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    async run<T>(work: () => Promise<T>): Promise<T> {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await work();
      } finally {
        inFlight -= 1;
      }
    },
  };
}

describe('mapLimit', () => {
  test('returns results in input order however they finish', async () => {
    // Reverse the durations so completion order is the opposite of input order.
    const out = await mapLimit([30, 20, 10, 1], 4, async (ms, i) => {
      await tick(ms);
      return i;
    });
    assert.deepEqual(out, [0, 1, 2, 3]);
  });

  test('actually runs concurrently', async () => {
    const w = watcher();
    await mapLimit([1, 2, 3, 4, 5, 6], 3, (_, i) => w.run(async () => { await tick(); return i; }));
    assert.ok(w.peak > 1, `expected concurrency, saw peak of ${w.peak}`);
  });

  test('never exceeds the limit', async () => {
    // The point of bounding: a dozen paid lookups at once is how you find a rate limit
    // in the middle of a scan someone is paying for.
    const w = watcher();
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, (_, i) =>
      w.run(async () => { await tick(); return i; }),
    );
    assert.ok(w.peak <= 4, `peak ${w.peak} exceeded the limit of 4`);
  });

  test('handles an empty list and a limit above the item count', async () => {
    assert.deepEqual(await mapLimit([], 5, async () => 1), []);
    assert.deepEqual(await mapLimit([1, 2], 99, async (n) => n * 2), [2, 4]);
  });

  test('visits every item exactly once', async () => {
    const seen: number[] = [];
    await mapLimit(Array.from({ length: 25 }, (_, i) => i), 6, async (n) => {
      await tick(1);
      seen.push(n);
      return n;
    });
    assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i));
  });
});

describe('settleLimit', () => {
  test('a failure is data, not a thrown run', async () => {
    // Rule 5 inside a stage: one dead lookup thins the scan and records why.
    const out = await settleLimit(['ok', 'boom', 'ok'], 3, async (item) => {
      if (item === 'boom') throw new Error('provider down');
      return item.toUpperCase();
    });

    assert.deepEqual(out.map((o) => o.value), ['OK', null, 'OK']);
    assert.equal(out[1]!.error, 'provider down');
    assert.equal(out[0]!.error, null);
  });

  test('keeps failures in position, so callers can name what failed', async () => {
    const keywords = ['a', 'b', 'c'];
    const out = await settleLimit(keywords, 2, async (k) => {
      if (k === 'b') throw new Error('nope');
      return k;
    });
    // The caller pairs by index to build "lookup failed for b".
    assert.equal(out[1]!.value, null);
    assert.equal(keywords[1], 'b');
  });

  test('survives a non-Error throw', async () => {
    const out = await settleLimit([1], 1, async () => {
      throw 'a bare string';
    });
    assert.equal(out[0]!.error, 'a bare string');
  });
});

describe('limits', () => {
  test('are bounded, not unbounded', () => {
    assert.ok(SERP_CONCURRENCY > 1 && SERP_CONCURRENCY <= 10);
    assert.ok(PLACES_CONCURRENCY > 1 && PLACES_CONCURRENCY <= 10);
  });
});
