import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resolveScan, ResolveError } from './resolve';
import { FIXTURE_KEYWORDS, failingProviders, fixtureProviders } from './fixtures';
import type { ScanRequest } from '../types/index';

const REQUEST: ScanRequest = {
  kind: 'local',
  name: 'Riverside Plumbing',
  postcode: 'SW18 4AB',
  segment: 'smb',
};

const OPTIONS = { keywords: FIXTURE_KEYWORDS };

describe('resolveScan', () => {
  test('resolves the subject and derives its attributes', async () => {
    const { result } = await resolveScan(REQUEST, fixtureProviders, OPTIONS);

    assert.equal(result.subject.place_id, 'p_riverside');
    assert.equal(result.vertical, 'trades.plumbing');
    assert.equal(result.region, 'SW18');
    assert.equal(result.platform, 'wordpress');
    assert.equal(result.segment, 'smb');
    assert.deepEqual(result.keyword_set, FIXTURE_KEYWORDS);
  });

  test('resolves by domain as well as by name', async () => {
    const byDomain: ScanRequest = {
      kind: 'domain', domain: 'riversideplumbing.example', segment: 'smb',
    };
    const { result } = await resolveScan(byDomain, fixtureProviders, OPTIONS);
    assert.equal(result.subject.place_id, 'p_riverside');
  });

  test('selects the right competitors in the right order', async () => {
    const { result } = await resolveScan(REQUEST, fixtureProviders, OPTIONS);

    assert.deepEqual(
      result.competitors.map((c) => c.place.place_id),
      ['p_wandsworth', 'p_swheating', 'p_quickfix', 'p_thames'],
    );
  });

  test('drops the directory, the wrong trade and the distant business', async () => {
    const { result } = await resolveScan(REQUEST, fixtureProviders, OPTIONS);
    const reason = (id: string) => result.rejected.find((r) => r.place_id === id)?.reason;

    assert.equal(reason('p_brightspark'), 'category_mismatch');
    assert.equal(reason('p_croydon'), 'out_of_radius');
    // Checkatrade is screened by name before we pay to enrich it, so it never becomes a
    // candidate at all.
    assert.equal(result.competitors.some((c) => c.place.name === 'Checkatrade'), false);
  });

  test('never includes the subject in its own competitor set', async () => {
    const { result } = await resolveScan(REQUEST, fixtureProviders, OPTIONS);
    assert.equal(result.competitors.some((c) => c.place.place_id === 'p_riverside'), false);
  });

  test('accounts for spend', async () => {
    const { cost_pence } = await resolveScan(REQUEST, fixtureProviders, OPTIONS);
    // 1 subject lookup + 5 map packs + 6 enriched candidates, at 3p each.
    assert.equal(cost_pence, 36);
  });

  test('only enriches up to the limit', async () => {
    const { cost_pence } = await resolveScan(REQUEST, fixtureProviders, {
      ...OPTIONS,
      enrich_limit: 2,
    });
    // 1 + 5 + 2 calls.
    assert.equal(cost_pence, 24);
  });

  test('is clean of warnings on a healthy scan', async () => {
    const { result } = await resolveScan(REQUEST, fixtureProviders, OPTIONS);
    assert.deepEqual(result.warnings, []);
  });
});

describe('resolveScan concurrency', () => {
  /** Wraps the fixture providers, timing and counting overlapping calls. */
  function instrumented(delayMs: number) {
    let serpInFlight = 0;
    let serpPeak = 0;
    let placesInFlight = 0;
    let placesPeak = 0;

    const slow = async <T>(work: () => Promise<T>, track: 'serp' | 'places'): Promise<T> => {
      if (track === 'serp') {
        serpInFlight += 1;
        serpPeak = Math.max(serpPeak, serpInFlight);
      } else {
        placesInFlight += 1;
        placesPeak = Math.max(placesPeak, placesInFlight);
      }
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        return await work();
      } finally {
        if (track === 'serp') serpInFlight -= 1;
        else placesInFlight -= 1;
      }
    };

    return {
      get serpPeak() {
        return serpPeak;
      },
      get placesPeak() {
        return placesPeak;
      },
      providers: {
        ...fixtureProviders,
        serp: {
          name: 'slow-serp',
          mapPack: (k: string, near: { lat: number; lng: number }) =>
            slow(() => fixtureProviders.serp.mapPack(k, near), 'serp'),
        },
        places: {
          ...fixtureProviders.places,
          details: (id: string) => slow(() => fixtureProviders.places.details(id), 'places'),
        },
      },
    };
  }

  test('sweeps keywords concurrently rather than one at a time', async () => {
    // The first live scan spent 467 of 672 seconds outside the collectors, most of it
    // awaiting one independent request at a time.
    const rig = instrumented(20);
    await resolveScan(REQUEST, rig.providers, OPTIONS);

    assert.ok(rig.serpPeak > 1, `keyword sweep ran serially (peak ${rig.serpPeak})`);
    assert.ok(rig.placesPeak > 1, `enrichment ran serially (peak ${rig.placesPeak})`);
  });

  test('is faster than the serial equivalent', async () => {
    const rig = instrumented(30);
    const started = Date.now();
    await resolveScan(REQUEST, rig.providers, OPTIONS);
    const elapsed = Date.now() - started;

    // 5 keywords + 6 enrichments at 30ms each is 330ms serially. Concurrency should beat
    // that comfortably; the bound is loose so a slow CI box does not fail it.
    assert.ok(elapsed < 300, `expected concurrency to beat serial, took ${elapsed}ms`);
  });

  test('still accounts cost in input order, whatever finishes first', async () => {
    const rig = instrumented(5);
    const { cost_pence } = await resolveScan(REQUEST, rig.providers, OPTIONS);
    // Same total as the serial version: 1 subject + 5 sweeps + 6 enrichments at 3p.
    assert.equal(cost_pence, 36);
  });
});

describe('resolveScan degradation', () => {
  test('throws only when the subject cannot be resolved', async () => {
    const missing: ScanRequest = {
      kind: 'domain', domain: 'does-not-exist.example', segment: 'smb',
    };
    await assert.rejects(
      () => resolveScan(missing, fixtureProviders, OPTIONS),
      ResolveError,
    );
  });

  test('survives every downstream provider failing', async () => {
    // CLAUDE.md rule 5: a stage degrades, it does not die.
    const { result } = await resolveScan(REQUEST, failingProviders(), OPTIONS);

    assert.equal(result.subject.place_id, 'p_riverside');
    assert.equal(result.competitors.length, 0);
    assert.equal(result.platform, null);
    // Still derives what it can from the subject alone.
    assert.equal(result.vertical, 'trades.plumbing');
    assert.equal(result.region, 'SW18');
  });

  test('explains each failure in warnings', async () => {
    const { result } = await resolveScan(REQUEST, failingProviders('boom'), OPTIONS);

    assert.ok(result.warnings.some((w) => /Map pack lookup failed/.test(w)));
    assert.ok(result.warnings.some((w) => /No map pack data/.test(w)));
    assert.ok(result.warnings.some((w) => /Platform detection failed/.test(w)));
    assert.ok(result.warnings.some((w) => /competitive sections will be omitted/.test(w)));
  });

  test('handles a scan with no keywords', async () => {
    const { result } = await resolveScan(REQUEST, fixtureProviders, { keywords: [] });
    assert.equal(result.competitors.length, 0);
    assert.equal(result.subject.place_id, 'p_riverside');
  });
});
