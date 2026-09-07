import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_WINDOW,
  HAIKU,
  OPUS,
  SONNET,
  contextWindowOf,
  thinkingFor,
  priceUsage,
} from './models';
import { DEFAULT_WRITER_MODEL } from './writer';
import { DEFAULT_CLAUDE_MODEL, DEFAULT_EXTRACTION_MODEL } from './aivis';

describe('thinkingFor', () => {
  test('adaptive on the current generation', () => {
    for (const model of [OPUS, SONNET, 'claude-opus-4-8', 'claude-sonnet-4-6']) {
      assert.deepEqual(thinkingFor(model), { type: 'adaptive' }, model);
    }
  });

  test('an explicit budget on Haiku, which predates adaptive', () => {
    // Sending adaptive here is a 400. This function exists so swapping the model
    // constant cannot silently produce one.
    assert.deepEqual(thinkingFor(HAIKU), { type: 'enabled', budget_tokens: 4000 });
  });

  test('budget is configurable and must sit under max_tokens', () => {
    assert.deepEqual(thinkingFor(HAIKU, 2000), { type: 'enabled', budget_tokens: 2000 });
  });

  test('an unknown model gets the budget form, which is the safer default', () => {
    // Adaptive is the newer contract; assuming it for an unrecognised id would fail on
    // exactly the older models this guard is for.
    assert.equal(thinkingFor('claude-something-old').type, 'enabled');
  });
});

describe('contextWindowOf', () => {
  test('knows Haiku is the small one', () => {
    assert.equal(contextWindowOf(HAIKU), 200_000);
  });

  test('defaults to the large window', () => {
    assert.equal(contextWindowOf(OPUS), DEFAULT_CONTEXT_WINDOW);
    assert.equal(contextWindowOf(SONNET), DEFAULT_CONTEXT_WINDOW);
  });
});

describe('model choices', () => {
  test('the volume call runs on the cheap model', () => {
    // Extraction runs ~48x a scan against the writer's 1 — this is the one that moves
    // the bill.
    assert.equal(DEFAULT_EXTRACTION_MODEL, HAIKU);
  });

  test('the writer runs on the configured model with a matching thinking shape', () => {
    assert.doesNotThrow(() => thinkingFor(DEFAULT_WRITER_MODEL));
  });

  test('the prompt-set model tracks what a customer actually gets', () => {
    // aivis measures the model, it does not use it, so this is chosen for
    // representativeness rather than cost. Changing it is a break in A3's time series —
    // snapshots either side of a swap measure the swap as much as anything else.
    assert.equal(DEFAULT_CLAUDE_MODEL, SONNET);
    assert.notEqual(DEFAULT_CLAUDE_MODEL, HAIKU, 'never the cheap tier — nobody asks Haiku');
  });
});

describe('priceUsage', () => {
  test('prices a real writer call from the billing export', () => {
    // req_011CepmziHEuEsQBcRrpNEBv: sonnet, 14,338 in / 28,632 out.
    const { pence } = priceUsage(SONNET, { input_tokens: 14_338, output_tokens: 28_632 });
    // (14338 x $2 + 28632 x $10) / 1M = $0.3150 -> ~25p
    assert.ok(pence > 24 && pence < 26, `expected ~25p, got ${pence.toFixed(2)}p`);
  });

  test('prices a real aivis answer', () => {
    // ~15 in / ~570 out on Sonnet: fractions of a penny, and it has to stay that way.
    const { pence } = priceUsage(SONNET, { input_tokens: 15, output_tokens: 570 });
    assert.ok(pence < 1, `an answer should cost under a penny, got ${pence.toFixed(3)}p`);
    assert.ok(pence > 0, 'but not zero');
  });

  test('keeps fractions, because rounding per call destroys the total', () => {
    // 48 extraction calls at ~0.06p each is ~3p. Rounded individually it is 0p or 48p.
    const one = priceUsage(HAIKU, { input_tokens: 950, output_tokens: 8 });
    assert.notEqual(one.pence, Math.round(one.pence));
    assert.ok(one.pence * 48 > 1);
  });

  test('the tiers are priced in the right order', () => {
    const usage = { input_tokens: 10_000, output_tokens: 10_000 };
    assert.ok(priceUsage(HAIKU, usage).pence < priceUsage(SONNET, usage).pence);
    assert.ok(priceUsage(SONNET, usage).pence < priceUsage(OPUS, usage).pence);
  });

  test('output costs five times input, which is why thinking dominates', () => {
    const inOnly = priceUsage(SONNET, { input_tokens: 10_000, output_tokens: 0 });
    const outOnly = priceUsage(SONNET, { input_tokens: 0, output_tokens: 10_000 });
    assert.ok(Math.abs(outOnly.pence / inOnly.pence - 5) < 0.01);
  });

  test('an unknown model prices as the most expensive tier', () => {
    // A budget should be wrong in the safe direction.
    const usage = { input_tokens: 1000, output_tokens: 1000 };
    assert.equal(priceUsage('claude-not-released-yet', usage).pence, priceUsage(OPUS, usage).pence);
  });

  test('cached input is billed at a tenth', () => {
    const fresh = priceUsage(SONNET, { input_tokens: 10_000, output_tokens: 0 });
    const cached = priceUsage(SONNET, {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 10_000,
    });
    assert.ok(Math.abs(cached.pence / fresh.pence - 0.1) < 0.001);
  });

  test('zero usage costs nothing', () => {
    assert.equal(priceUsage(SONNET, { input_tokens: 0, output_tokens: 0 }).pence, 0);
  });
});
