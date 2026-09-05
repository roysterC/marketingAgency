import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FINDINGS, type FindingCode } from '../../taxonomy/findings';
import { expandSeed, type NormaliseContext } from '../types';
import {
  AIVIS_EMITS,
  NO_KNOWN_FACTS,
  aivisPeerStats,
  createAivisCollector,
  scanPromptCache,
} from './index';
import {
  COMPETITOR_CITED_PERCENT,
  MIN_CITATION_SHARE_PERCENT,
  PEER_KEYS,
  citationShare,
  competitorOnlyShare,
  contradicts,
  normaliseAivis,
  wrongClaims,
} from './normalise';
import {
  FACTS,
  PROMPT_SET,
  RIVERSIDE_FACTS,
  deadAivisProvider,
  fixtureAivisProvider,
  flakyAivisProvider,
} from './fixtures';
import type { AivisCapture } from './types';

const NOW = new Date('2026-09-04T12:00:00.000Z');

const target = (placeId: string, name: string) => ({
  target_id: `t_${placeId}`,
  role: 'subject' as const,
  place: {
    place_id: placeId,
    name,
    primary_category: 'Plumber',
    lat: 51.4571,
    lng: -0.1911,
    domain: null,
    postcode: 'SW18 4AB',
    phone: null,
  },
});

const knownFacts = (t: { place: { place_id: string } }) => FACTS[t.place.place_id] ?? {};

async function runScan() {
  const provider = fixtureAivisProvider();
  const collector = createAivisCollector(
    scanPromptCache(provider),
    PROMPT_SET,
    knownFacts,
    { checkEntity: true },
  );

  const businesses: Array<[string, string]> = [
    ['p_riverside', 'Riverside Plumbing'],
    ['p_wandsworth', 'Wandsworth Plumbers Ltd'],
    ['p_swheating', 'SW Heating & Plumbing'],
    ['p_quickfix', 'QuickFix Plumbing'],
  ];

  const captures: Record<string, AivisCapture> = {};
  const costs: Record<string, number> = {};
  for (const [id, name] of businesses) {
    const { value, cost } = await collector.collect(target(id, name), { mode: 'cold' });
    captures[id] = value!;
    costs[id] = cost.pence;
  }
  return { provider, collector, captures, costs };
}

const { provider: scanProvider, captures, costs } = await runScan();

const peers = aivisPeerStats([
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

describe('aivis contract', () => {
  test('every declared code really belongs to this collector', () => {
    for (const code of AIVIS_EMITS) {
      assert.equal(FINDINGS[code].collector, 'aivis', code);
    }
  });

  test('declares every aivis code in the registry', () => {
    const registry = Object.keys(FINDINGS).filter(
      (c) => FINDINGS[c as FindingCode].collector === 'aivis',
    );
    assert.deepEqual([...AIVIS_EMITS].sort(), registry.sort());
  });

  test('only the entity check is estimated — the rest are things we observed', () => {
    assert.equal(FINDINGS.AIVIS_NO_ENTITY.confidence, 'estimated');
    for (const code of AIVIS_EMITS) {
      if (code === 'AIVIS_NO_ENTITY') continue;
      assert.equal(FINDINGS[code].confidence, 'verified', code);
    }
  });
});

describe('checking a model against the truth', () => {
  test('the same number written differently is not an error', () => {
    // The way this rule most plausibly goes wrong: reporting a correct answer as wrong
    // because a model wrote 020 8000 2222 and we hold +442080002222.
    assert.equal(contradicts('phone', '020 8000 2222', RIVERSIDE_FACTS), false);
    assert.equal(contradicts('phone', '+44 20 8000 2222', RIVERSIDE_FACTS), false);
    assert.equal(contradicts('phone', '02080002222', RIVERSIDE_FACTS), false);
  });

  test('a different number is an error', () => {
    assert.equal(contradicts('phone', '020 8000 9999', RIVERSIDE_FACTS), true);
  });

  test('a fact we do not hold is unverifiable, not wrong', () => {
    // We never learned their hours. Calling a stated one an error would be the same
    // mistake as reporting "0 services listed" for a field Places did not return.
    assert.equal(RIVERSIDE_FACTS.opening_hours, undefined);
    assert.equal(contradicts('opening_hours', 'open 24 hours', RIVERSIDE_FACTS), false);
  });

  test('a shortened address is the same address', () => {
    assert.equal(contradicts('address', '9 River Road', RIVERSIDE_FACTS), false);
    assert.equal(contradicts('address', '11 Bridge Lane, SW11', RIVERSIDE_FACTS), true);
  });

  test('protocol and www are not part of what a website is', () => {
    assert.equal(contradicts('website', 'riversideplumbing.example', RIVERSIDE_FACTS), false);
    assert.equal(contradicts('website', 'www.riversideplumbing.example/', RIVERSIDE_FACTS), false);
    assert.equal(contradicts('website', 'riverside-plumbers.example', RIVERSIDE_FACTS), true);
  });

  test('an empty known value is not something to check against', () => {
    assert.equal(contradicts('phone', '020 8000 9999', { phone: '  ' }), false);
  });
});

describe('normaliseAivis — a business the models have never heard of', () => {
  const seeds = normaliseAivis(captures.p_riverside!, ctx());

  test('finds all four', () => {
    assert.deepEqual(codes(seeds).sort(), [
      'AIVIS_COMPETITOR_CITED',
      'AIVIS_NOT_CITED',
      'AIVIS_NO_ENTITY',
      'AIVIS_OUTDATED_FACT',
    ]);
  });

  test('leads with the incorrect statement', () => {
    // Ordering matters here: it is the only critical code, and the one a reader can check
    // in ten seconds.
    assert.equal(seeds[0]!.code, 'AIVIS_OUTDATED_FACT');
    assert.equal(FINDINGS.AIVIS_OUTDATED_FACT.severity, 'critical');
  });

  test('captures the exact model, prompt and response behind the wrong claim', () => {
    const wrong = seeds.find((s) => s.code === 'AIVIS_OUTDATED_FACT')!;
    assert.equal(wrong.measured_value, 1);
    assert.equal(wrong.measured_text, '1 incorrect statement');

    const claims = wrong.evidence.wrong_claims as Array<Record<string, unknown>>;
    assert.equal(claims.length, 1);
    assert.equal(claims[0]!.model, 'perplexity');
    assert.equal(claims[0]!.prompt, 'emergency plumber near SW18');
    assert.equal(claims[0]!.field, 'phone');
    assert.equal(claims[0]!.stated, '020 8000 9999');
    assert.equal(claims[0]!.actual, '+442080002222');
    assert.ok(String(claims[0]!.excerpt).length > 0);
  });

  test('the correctly-stated number is not counted as a second error', () => {
    // Riverside is named twice: once with the right number written differently, once
    // with a wrong one. Only the second is a finding.
    assert.equal(wrongClaims(captures.p_riverside!).length, 1);
  });

  test('measures citation share', () => {
    const notCited = seeds.find((s) => s.code === 'AIVIS_NOT_CITED')!;
    assert.equal(notCited.measured_value, 16.7);
    assert.equal(notCited.benchmark_value, 100);
    assert.equal(notCited.benchmark_source, 'competitor_best');
    assert.equal(notCited.evidence.competitor_median, 41.7);
  });

  test('names who got recommended instead', () => {
    const instead = seeds.find((s) => s.code === 'AIVIS_COMPETITOR_CITED')!;
    assert.equal(instead.measured_value, 83.3);
    const named = instead.evidence.named_instead as Array<{ name: string; answers: number }>;
    assert.equal(named[0]!.name, 'Wandsworth Plumbers Ltd');
    assert.ok(named[0]!.answers > 0);
  });

  test('a business named by a model but outside our set still counts as someone else', () => {
    const cited = captures.p_riverside!.answers.flatMap((a) => a.citations);
    const unmatched = cited.find((c) => c.name === 'Thames Valley Plumbing')!;
    assert.equal(unmatched.place_id, null);
    // It is still a competitor taking the recommendation.
    assert.ok(competitorOnlyShare(captures.p_riverside!)! > COMPETITOR_CITED_PERCENT);
  });

  test('no model can say what the business is', () => {
    const entity = seeds.find((s) => s.code === 'AIVIS_NO_ENTITY')!;
    assert.deepEqual(entity.evidence.models_checked, ['claude', 'gpt', 'perplexity']);
    assert.equal(entity.measured_text, 'unrecognised by 3 of 3 models');
  });
});

describe('normaliseAivis — the business the models recommend', () => {
  test('produces nothing', () => {
    assert.equal(citationShare(captures.p_wandsworth!), 100);
    assert.deepEqual(normaliseAivis(captures.p_wandsworth!, ctx()), []);
  });

  test('one model naming a rival instead is not a finding', () => {
    assert.equal(competitorOnlyShare(captures.p_wandsworth!), 0);
  });
});

describe('shares are measured over the whole prompt set', () => {
  test('citation share counts answers naming the business', () => {
    // Named in 2 of 12 (prompt x model) answers.
    assert.equal(citationShare(captures.p_riverside!), 16.7);
    assert.ok(16.7 < MIN_CITATION_SHARE_PERCENT);
  });

  test('competitor share counts answers naming someone else and not us', () => {
    assert.equal(competitorOnlyShare(captures.p_riverside!), 83.3);
  });

  test('an empty answer set has no share rather than a zero', () => {
    const empty: AivisCapture = { ...captures.p_riverside!, answers: [] };
    assert.equal(citationShare(empty), null);
    assert.equal(competitorOnlyShare(empty), null);
    assert.equal(codes(normaliseAivis(empty, ctx())).includes('AIVIS_NOT_CITED'), false);
  });
});

describe('the prompt set is bought once for the scan', () => {
  test('four targets ask twelve times, not forty-eight', () => {
    assert.equal(scanProvider.asks(), PROMPT_SET.models.length * PROMPT_SET.prompts.length);
  });

  test('the first target pays for the prompts and the rest read them free', () => {
    // 12 answers at 2p plus 3 entity checks at 2p.
    assert.equal(costs.p_riverside, 30);
    // Entity checks only — the answers were already bought.
    assert.equal(costs.p_wandsworth, 6);
  });

  test('the entity check is never cached, because it is about one business', () => {
    // One per model per target, or every business would inherit the first one's answer.
    assert.equal(scanProvider.entities(), 4 * PROMPT_SET.models.length);
    assert.equal(captures.p_wandsworth!.entity_checks.every((e) => e.recognised), true);
    assert.equal(captures.p_riverside!.entity_checks.every((e) => !e.recognised), true);
  });

  test('concurrent targets share the in-flight request', async () => {
    const provider = fixtureAivisProvider();
    const cache = scanPromptCache(provider);
    const [a, b] = await Promise.all([
      cache.ask('claude', 'best plumber in Wandsworth'),
      cache.ask('claude', 'best plumber in Wandsworth'),
    ]);

    assert.equal(provider.asks(), 1);
    assert.deepEqual(a!.value.citations, b!.value.citations);
    assert.equal(a!.cost.pence + b!.cost.pence, 2);
  });
});

describe('a model that will not answer', () => {
  test('one failing model thins the set and is not billed for', async () => {
    const collector = createAivisCollector(flakyAivisProvider('gpt'), PROMPT_SET, knownFacts);
    const { value, cost } = await collector.collect(
      target('p_riverside', 'Riverside Plumbing'),
      { mode: 'cold' },
    );

    assert.equal(value?.answers.length, 8);
    assert.equal(value?.failed_prompts.length, 4);
    assert.equal(value?.failed_prompts.every((f) => f.model === 'gpt'), true);
    assert.equal(cost.pence, 16);
  });

  test('the surviving models still produce findings', async () => {
    const collector = createAivisCollector(flakyAivisProvider('gpt'), PROMPT_SET, knownFacts);
    const { value } = await collector.collect(target('p_riverside', 'Riverside Plumbing'), {
      mode: 'cold',
    });
    const seeds = collector.normalise(value, ctx());

    assert.ok(seeds.length > 0);
    for (const seed of seeds) {
      assert.equal(seed.evidence.prompts_failed, 4, seed.code);
      assert.deepEqual(seed.evidence.models, ['claude', 'perplexity'], seed.code);
    }
  });

  test('every model failing empties the section without throwing', async () => {
    const collector = createAivisCollector(deadAivisProvider, PROMPT_SET, knownFacts);
    const t = target('p_riverside', 'Riverside Plumbing');

    await assert.doesNotReject(() => collector.collect(t, { mode: 'cold' }));
    const { value, cost } = await collector.collect(t, { mode: 'cold' });
    assert.equal(value?.answers.length, 0);
    assert.equal(cost.pence, 0);
    assert.deepEqual(collector.normalise(value, ctx()), []);
  });
});

describe('ground truth is supplied, not fetched', () => {
  test('with no known facts, nothing is ever called wrong', async () => {
    const collector = createAivisCollector(
      scanPromptCache(fixtureAivisProvider()),
      PROMPT_SET,
      NO_KNOWN_FACTS,
    );
    const { value } = await collector.collect(target('p_riverside', 'Riverside Plumbing'), {
      mode: 'cold',
    });

    assert.deepEqual(value?.known_facts, {});
    assert.equal(wrongClaims(value!).length, 0);
    assert.equal(
      codes(collector.normalise(value, ctx())).includes('AIVIS_OUTDATED_FACT'),
      false,
    );
  });

  test('the entity check is off unless asked for', async () => {
    const provider = fixtureAivisProvider();
    const collector = createAivisCollector(scanPromptCache(provider), PROMPT_SET, knownFacts);
    const { value } = await collector.collect(target('p_riverside', 'Riverside Plumbing'), {
      mode: 'cold',
    });

    assert.equal(provider.entities(), 0);
    assert.deepEqual(value?.entity_checks, []);
    assert.equal(codes(collector.normalise(value, ctx())).includes('AIVIS_NO_ENTITY'), false);
  });
});

describe('peer stats respect polarity', () => {
  test('the best citation share is the highest', () => {
    assert.equal(peers.best[PEER_KEYS.citation_share], 100);
    assert.equal(peers.median[PEER_KEYS.citation_share], 41.7);
    assert.equal(FINDINGS.AIVIS_NOT_CITED.polarity, 'higher_better');
  });

  test('citation share falls back to an absolute threshold with no peers', () => {
    const noPeers: NormaliseContext = { now: NOW, role: 'subject', segment: 'smb' };
    const notCited = normaliseAivis(captures.p_riverside!, noPeers).find(
      (s) => s.code === 'AIVIS_NOT_CITED',
    )!;
    assert.equal(notCited.benchmark_source, 'absolute');
    assert.equal(notCited.benchmark_value, null);
    assert.equal(notCited.evidence.threshold_percent, MIN_CITATION_SHARE_PERCENT);
  });
});

describe('collector', () => {
  test('runs without auth — this is a cold-mode collector', () => {
    const collector = createAivisCollector(fixtureAivisProvider(), PROMPT_SET, knownFacts);
    assert.equal(collector.requires_auth, false);
  });

  test('says nothing when there is no capture', () => {
    assert.deepEqual(normaliseAivis(null, ctx()), []);
  });

  test('only emits codes it declared', () => {
    for (const capture of Object.values(captures)) {
      for (const seed of normaliseAivis(capture, ctx())) {
        assert.ok(AIVIS_EMITS.includes(seed.code as (typeof AIVIS_EMITS)[number]), seed.code);
      }
    }
  });
});

describe('expandSeed', () => {
  test('takes severity and confidence from the registry, not the collector', () => {
    const draft = expandSeed({ code: 'AIVIS_OUTDATED_FACT', measured_value: 1, evidence: {} }, 't1');
    assert.equal(draft.severity, 'critical');
    assert.equal(draft.confidence, 'verified');
    assert.equal(draft.collector, 'aivis');
    assert.equal(draft.measured_unit, 'count');
  });

  test('carries the units the benchmark layer needs', () => {
    assert.equal(expandSeed({ code: 'AIVIS_NOT_CITED', evidence: {} }, 't').measured_unit, 'percent');
    assert.equal(
      expandSeed({ code: 'AIVIS_COMPETITOR_CITED', evidence: {} }, 't').measured_unit,
      'percent',
    );
    assert.equal(expandSeed({ code: 'AIVIS_NO_ENTITY', evidence: {} }, 't').measured_unit, null);
  });
});
