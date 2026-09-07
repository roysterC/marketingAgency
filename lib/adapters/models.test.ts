import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CONTEXT_WINDOW,
  HAIKU,
  OPUS,
  SONNET,
  contextWindowOf,
  thinkingFor,
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

  test('the prompt-set model is NOT downgraded for cost', () => {
    // aivis measures what a customer asking Claude actually gets. Making this cheaper
    // would measure something no customer sees, and would break A3's time series by
    // making any movement attributable to the swap.
    assert.equal(DEFAULT_CLAUDE_MODEL, OPUS);
  });
});
