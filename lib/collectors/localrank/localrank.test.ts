import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { MapPackEntry, Priced, SerpProvider } from '../../resolve/providers';
import { FINDINGS, type FindingCode } from '../../taxonomy/findings';
import { expandSeed, type NormaliseContext, type PeerStats } from '../types';
import { LOCALRANK_EMITS, createLocalRankCollector, localRankPeerStats, scanSerpCache } from './index';
import {
  MIN_CONTESTED_KEYWORDS,
  MIN_MONEY_COVERAGE_PERCENT,
  PEER_KEYS,
  contestedBy,
  medianPosition,
  moneyCoverage,
  normaliseLocalRank,
} from './normalise';
import {
  NEAR,
  PLAN,
  countingSerpProvider,
  deadSerpProvider,
  emptySerpProvider,
  fixtureSerpProvider,
  flakySerpProvider,
} from './fixtures';
import type { LocalRankCapture } from './types';

const NOW = new Date('2026-09-04T12:00:00.000Z');

const target = (placeId: string) => ({
  target_id: `t_${placeId}`,
  role: 'subject' as const,
  place: {
    place_id: placeId,
    name: placeId,
    primary_category: 'Plumber',
    lat: NEAR.lat,
    lng: NEAR.lng,
    domain: null,
    postcode: 'SW18 4AB',
    phone: null,
  },
});

/** Collect every fixture business once, through one shared scan cache. */
async function collectAll(): Promise<Record<string, LocalRankCapture>> {
  const collector = createLocalRankCollector(scanSerpCache(fixtureSerpProvider), PLAN);
  const ids = ['p_riverside', 'p_wandsworth', 'p_swheating', 'p_quickfix', 'p_invisible'];
  const out: Record<string, LocalRankCapture> = {};
  for (const id of ids) {
    const { value } = await collector.collect(target(id), { mode: 'cold' });
    out[id] = value!;
  }
  return out;
}

const captures = await collectAll();
const peers = localRankPeerStats([
  captures.p_wandsworth!,
  captures.p_swheating!,
  captures.p_quickfix!,
]);

const ctx = (over: Partial<NormaliseContext> = {}): NormaliseContext => ({
  now: NOW,
  role: 'subject',
  segment: 'smb',
  peers,
  ...over,
});

const codes = (seeds: { code: FindingCode }[]): FindingCode[] => seeds.map((s) => s.code);

describe('localrank contract', () => {
  test('every declared code really belongs to this collector', () => {
    for (const code of LOCALRANK_EMITS) {
      assert.equal(FINDINGS[code].collector, 'localrank', code);
    }
  });

  test('declares every localrank code in the registry', () => {
    const registry = Object.keys(FINDINGS).filter(
      (c) => FINDINGS[c as FindingCode].collector === 'localrank',
    );
    assert.deepEqual([...LOCALRANK_EMITS].sort(), registry.sort());
  });

  test('is SMB-only — a pure online brand has no local pack to appear in', () => {
    const collector = createLocalRankCollector(fixtureSerpProvider, PLAN);
    assert.deepEqual(collector.segments, ['smb']);
    for (const code of LOCALRANK_EMITS) {
      assert.deepEqual(FINDINGS[code].segments, ['smb'], code);
    }
  });
});

describe('position is measured over money keywords only', () => {
  test('an advice page ranking well does not flatter the median', () => {
    // Riverside is 5th for one money keyword and 2nd for "how to bleed a radiator".
    // Counting the article would report a median of 3.5 for a business that is nowhere
    // for the work.
    assert.equal(medianPosition(captures.p_riverside!.ranks), 5);

    const withArticle = captures.p_riverside!.ranks
      .map((r) => r.position)
      .filter((p): p is number => p !== null);
    assert.deepEqual(withArticle.sort((a, b) => a - b), [2, 5]);
  });

  test('both sides of the comparison are measured the same way', () => {
    assert.equal(medianPosition(captures.p_wandsworth!.ranks), 1);
    assert.equal(medianPosition(captures.p_swheating!.ranks), 2);
    assert.equal(medianPosition(captures.p_quickfix!.ranks), 2.5);
  });

  test('a business in no pack has no median rather than a zero', () => {
    assert.equal(medianPosition(captures.p_invisible!.ranks), null);
  });
});

describe('money keyword coverage', () => {
  test('counts appearances, not positions', () => {
    assert.equal(moneyCoverage(captures.p_riverside!.ranks), 20);
    assert.equal(moneyCoverage(captures.p_wandsworth!.ranks), 100);
    assert.equal(moneyCoverage(captures.p_quickfix!.ranks), 80);
    assert.equal(moneyCoverage(captures.p_invisible!.ranks), 0);
  });

  test('is the one estimated code here — which terms are money terms is a judgement', () => {
    assert.equal(FINDINGS.LOCALRANK_NO_MONEY_KEYWORD_COVERAGE.confidence, 'estimated');
    for (const code of LOCALRANK_EMITS) {
      if (code === 'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE') continue;
      assert.equal(FINDINGS[code].confidence, 'verified', code);
    }
  });
});

describe('normaliseLocalRank — a business losing the area', () => {
  const seeds = normaliseLocalRank(captures.p_riverside!, ctx());

  test('reports coverage, position and the competitor taking the work', () => {
    assert.deepEqual(codes(seeds).sort(), [
      'LOCALRANK_BELOW_MEDIAN',
      'LOCALRANK_LOST_TO_COMPETITOR',
      'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE',
    ]);
  });

  test('does not claim it is absent when it ranks for one', () => {
    assert.equal(codes(seeds).includes('LOCALRANK_ABSENT'), false);
  });

  test('measures against the strongest competitor, naming it', () => {
    const lost = seeds.find((s) => s.code === 'LOCALRANK_LOST_TO_COMPETITOR')!;
    assert.equal(lost.measured_value, 5);
    assert.equal(lost.benchmark_value, 1);
    assert.equal(lost.evidence.competitor_name, 'Wandsworth Plumbers Ltd');
    assert.equal(lost.evidence.keywords_lost, 5);
    assert.equal(
      lost.measured_text,
      'beaten by Wandsworth Plumbers Ltd on 5 of 5 money keywords',
    );
  });

  test('says where it looked — a position is only meaningful at a location', () => {
    for (const seed of seeds) {
      assert.deepEqual(seed.evidence.measured_near, NEAR, seed.code);
    }
  });

  test('the coverage finding quotes the keywords it is missing from', () => {
    const coverage = seeds.find((s) => s.code === 'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE')!;
    assert.equal(coverage.measured_value, 20);
    const missing = coverage.evidence.missing_keywords as string[];
    assert.equal(missing.length, 4);
    assert.ok(missing.includes('emergency plumber wandsworth'));
  });
});

describe('normaliseLocalRank — a business nobody can find', () => {
  const seeds = normaliseLocalRank(captures.p_invisible!, ctx());

  test('leads with absent, and still records the zero', () => {
    assert.deepEqual(codes(seeds).sort(), [
      'LOCALRANK_ABSENT',
      'LOCALRANK_LOST_TO_COMPETITOR',
      'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE',
    ]);
  });

  test('0% coverage is deliberately not suppressed by the absent finding', () => {
    // LOCALRANK_ABSENT is binary and feeds no benchmark. Dropping the measured zero would
    // leave a hole in the percentiles exactly where the worst businesses are.
    const coverage = seeds.find((s) => s.code === 'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE')!;
    assert.equal(coverage.measured_value, 0);
    assert.equal(FINDINGS.LOCALRANK_ABSENT.benchmarkable, false);
    assert.equal(FINDINGS.LOCALRANK_NO_MONEY_KEYWORD_COVERAGE.benchmarkable, true);
  });

  test('no median to be below, so that finding is not invented', () => {
    assert.equal(codes(seeds).includes('LOCALRANK_BELOW_MEDIAN'), false);
  });

  test('absent counts as worse than any position, so the rival is still named', () => {
    const lost = seeds.find((s) => s.code === 'LOCALRANK_LOST_TO_COMPETITOR')!;
    assert.equal(lost.measured_value, null);
    assert.equal(lost.evidence.keywords_lost, 5);
  });
});

describe('normaliseLocalRank — the business winning the area', () => {
  test('produces nothing against its own competitor set', () => {
    const ownPeers = localRankPeerStats([
      captures.p_swheating!,
      captures.p_quickfix!,
      captures.p_riverside!,
    ]);
    assert.deepEqual(normaliseLocalRank(captures.p_wandsworth!, ctx({ peers: ownPeers })), []);
  });
});

describe('who counts as a competitor', () => {
  test('directories are never named, however often they outrank', () => {
    const contests = contestedBy(captures.p_riverside!.ranks);
    assert.equal(
      contests.some((c) => c.name === 'Checkatrade'),
      false,
    );
    // It is in three of the five packs, above the subject in each.
    assert.ok(
      Object.values(captures.p_riverside!.ranks).some((r) =>
        r.pack.some((e) => e.name === 'Checkatrade'),
      ),
    );
  });

  test('orders by how many money keywords each rival took', () => {
    const contests = contestedBy(captures.p_riverside!.ranks);
    assert.equal(contests[0]!.keywords.length, 5);
    assert.ok(contests[0]!.keywords.length >= contests[contests.length - 1]!.keywords.length);
  });

  test('one contested keyword is a coincidence, not a finding', () => {
    // Wandsworth loses one keyword to SW Heating and one to QuickFix. Neither reaches the
    // threshold, so nobody is named.
    const contests = contestedBy(captures.p_wandsworth!.ranks);
    assert.ok(contests.every((c) => c.keywords.length < MIN_CONTESTED_KEYWORDS));
    const ownPeers = localRankPeerStats([captures.p_swheating!, captures.p_quickfix!]);
    assert.equal(
      codes(normaliseLocalRank(captures.p_wandsworth!, ctx({ peers: ownPeers }))).includes(
        'LOCALRANK_LOST_TO_COMPETITOR',
      ),
      false,
    );
  });

  test('non-money keywords are not contested ground', () => {
    // Wandsworth beats Riverside on the how-to article too, but that is not work.
    const contests = contestedBy(captures.p_riverside!.ranks);
    const wandsworth = contests.find((c) => c.name === 'Wandsworth Plumbers Ltd')!;
    assert.equal(
      wandsworth.keywords.some((k) => k.keyword === 'how to bleed a radiator'),
      false,
    );
  });
});

describe('peer stats respect polarity', () => {
  test('the best position is the lowest number, not the highest', () => {
    assert.equal(peers.median[PEER_KEYS.median_position], 2);
    assert.equal(peers.best[PEER_KEYS.median_position], 1);
    assert.equal(FINDINGS.LOCALRANK_BELOW_MEDIAN.polarity, 'lower_better');
  });

  test('coverage is an ordinary higher-is-better percentage', () => {
    assert.equal(peers.median[PEER_KEYS.coverage], 100);
    assert.equal(peers.best[PEER_KEYS.coverage], 100);
    assert.equal(FINDINGS.LOCALRANK_NO_MONEY_KEYWORD_COVERAGE.polarity, 'higher_better');
  });

  test('a competitor that ranks nowhere contributes no position', () => {
    const stats = localRankPeerStats([captures.p_invisible!]);
    assert.equal(stats.median[PEER_KEYS.median_position], undefined);
    // But its zero coverage is real and does count.
    assert.equal(stats.median[PEER_KEYS.coverage], 0);
  });
});

describe('comparative findings need a comparator', () => {
  const noPeers: NormaliseContext = { now: NOW, role: 'subject', segment: 'smb' };

  test('below-median goes unreported with no peer set', () => {
    const seeds = codes(normaliseLocalRank(captures.p_riverside!, noPeers));
    assert.equal(seeds.includes('LOCALRANK_BELOW_MEDIAN'), false);
    // Coverage has an absolute threshold, so it still fires.
    assert.equal(seeds.includes('LOCALRANK_NO_MONEY_KEYWORD_COVERAGE'), true);
  });

  test('coverage falls back to an absolute threshold', () => {
    const coverage = normaliseLocalRank(captures.p_riverside!, noPeers).find(
      (s) => s.code === 'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE',
    )!;
    assert.equal(coverage.benchmark_source, 'absolute');
    assert.equal(coverage.benchmark_value, null);
    assert.equal(coverage.evidence.threshold_percent, MIN_MONEY_COVERAGE_PERCENT);
  });

  test('a peer set that is only marginally better is not a finding', () => {
    const marginal: PeerStats = {
      median: { [PEER_KEYS.median_position]: 5 },
      best: { [PEER_KEYS.median_position]: 5 },
    };
    assert.equal(
      codes(normaliseLocalRank(captures.p_riverside!, ctx({ peers: marginal }))).includes(
        'LOCALRANK_BELOW_MEDIAN',
      ),
      false,
    );
  });
});

describe('the scan buys each keyword once', () => {
  test('six targets do not buy the same ten queries six times', async () => {
    const counting = countingSerpProvider();
    const collector = createLocalRankCollector(scanSerpCache(counting), PLAN);

    let pence = 0;
    for (const id of ['p_riverside', 'p_wandsworth', 'p_swheating', 'p_quickfix']) {
      pence += (await collector.collect(target(id), { mode: 'cold' })).cost.pence;
    }

    // One call per keyword, not one per (keyword x target).
    assert.equal(counting.calls(), PLAN.keywords.length);
    assert.equal(pence, PLAN.keywords.length * 3);
  });

  test('the first target pays and the rest read the same response free', async () => {
    const collector = createLocalRankCollector(scanSerpCache(fixtureSerpProvider), PLAN);
    const first = await collector.collect(target('p_riverside'), { mode: 'cold' });
    const second = await collector.collect(target('p_wandsworth'), { mode: 'cold' });

    assert.equal(first.cost.pence, PLAN.keywords.length * 3);
    assert.equal(second.cost.pence, 0);
    // Same data, different reading of it.
    assert.equal(second.value?.ranks.length, PLAN.keywords.length);
  });

  test('concurrent targets share the in-flight request rather than racing into two', async () => {
    const counting = countingSerpProvider();
    const cache = scanSerpCache(counting);

    const [a, b] = await Promise.all([
      cache.mapPack('boiler repair sw18', NEAR),
      cache.mapPack('boiler repair sw18', NEAR),
    ]);

    assert.equal(counting.calls(), 1);
    assert.deepEqual(a!.value, b!.value);
    // Charged once between them.
    assert.equal(a!.cost.pence + b!.cost.pence, 3);
  });

  test('a failed query is evicted so a later target can retry', async () => {
    let calls = 0;
    const flakyOnce: SerpProvider = {
      name: 'flaky-once',
      async mapPack(keyword, near): Promise<Priced<MapPackEntry[]>> {
        calls += 1;
        if (calls === 1) throw new Error('transient 503');
        return fixtureSerpProvider.mapPack(keyword, near);
      },
    };
    const cache = scanSerpCache(flakyOnce);

    await assert.rejects(() => cache.mapPack('boiler repair sw18', NEAR));
    const retry = await cache.mapPack('boiler repair sw18', NEAR);
    assert.equal(retry.value.length, 4);
    assert.equal(retry.cost.pence, 3);
  });

  test('keyword matching ignores case and padding', async () => {
    const counting = countingSerpProvider();
    const cache = scanSerpCache(counting);
    await cache.mapPack('boiler repair sw18', NEAR);
    await cache.mapPack('  Boiler Repair SW18  ', NEAR);
    assert.equal(counting.calls(), 1);
  });
});

describe('a dead keyword thins the section without failing the scan', () => {
  test('records the failure and keeps every other keyword', async () => {
    const collector = createLocalRankCollector(
      flakySerpProvider('emergency plumber wandsworth'),
      PLAN,
    );
    const { value, cost } = await collector.collect(target('p_riverside'), { mode: 'cold' });

    assert.equal(value?.ranks.length, PLAN.keywords.length - 1);
    assert.deepEqual(value?.failed_keywords, [
      { keyword: 'emergency plumber wandsworth', message: 'SERP API 429 for "emergency plumber wandsworth"' },
    ]);
    // Not billed for the query that errored.
    assert.equal(cost.pence, (PLAN.keywords.length - 1) * 3);
  });

  test('the failure is carried into every finding, so a thin section is explicable', async () => {
    const collector = createLocalRankCollector(flakySerpProvider('boiler repair sw18'), PLAN);
    const { value } = await collector.collect(target('p_riverside'), { mode: 'cold' });
    const seeds = collector.normalise(value, ctx());

    assert.ok(seeds.length > 0);
    for (const seed of seeds) {
      assert.deepEqual(seed.evidence.keywords_failed, ['boiler repair sw18'], seed.code);
    }
  });

  test('every query failing returns an empty section rather than throwing', async () => {
    const collector = createLocalRankCollector(deadSerpProvider, PLAN);
    const { value, cost } = await collector.collect(target('p_riverside'), { mode: 'cold' });

    assert.equal(value?.ranks.length, 0);
    assert.equal(value?.failed_keywords.length, PLAN.keywords.length);
    assert.equal(cost.pence, 0);
    assert.deepEqual(collector.normalise(value, ctx()), []);
  });

  test('an empty pack is a real answer, not a failure', async () => {
    const collector = createLocalRankCollector(emptySerpProvider, PLAN);
    const { value } = await collector.collect(target('p_riverside'), { mode: 'cold' });

    assert.equal(value?.failed_keywords.length, 0);
    assert.equal(value?.ranks.length, PLAN.keywords.length);
    // Nobody ranks, including the subject.
    assert.deepEqual(codes(collector.normalise(value, ctx())).sort(), [
      'LOCALRANK_ABSENT',
      'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE',
    ]);
  });
});

describe('collector', () => {
  test('runs without auth — this is a cold-mode collector', () => {
    assert.equal(createLocalRankCollector(fixtureSerpProvider, PLAN).requires_auth, false);
  });

  test('says nothing when there is no capture', () => {
    assert.deepEqual(normaliseLocalRank(null, ctx()), []);
  });

  test('only emits codes it declared', () => {
    for (const capture of Object.values(captures)) {
      for (const seed of normaliseLocalRank(capture, ctx())) {
        assert.ok(
          LOCALRANK_EMITS.includes(seed.code as (typeof LOCALRANK_EMITS)[number]),
          seed.code,
        );
      }
    }
  });
});

describe('expandSeed', () => {
  test('takes severity and confidence from the registry, not the collector', () => {
    const draft = expandSeed({ code: 'LOCALRANK_ABSENT', evidence: {} }, 't1');
    assert.equal(draft.severity, 'critical');
    assert.equal(draft.confidence, 'verified');
    assert.equal(draft.collector, 'localrank');
    assert.equal(draft.measured_unit, null);
  });

  test('carries the units the benchmark layer needs', () => {
    assert.equal(
      expandSeed({ code: 'LOCALRANK_BELOW_MEDIAN', measured_value: 5, evidence: {} }, 't')
        .measured_unit,
      'position',
    );
    assert.equal(
      expandSeed({ code: 'LOCALRANK_NO_MONEY_KEYWORD_COVERAGE', evidence: {} }, 't').measured_unit,
      'percent',
    );
  });
});
