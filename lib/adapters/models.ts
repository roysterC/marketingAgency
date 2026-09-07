/**
 * Model ids, and the request shape each one needs.
 *
 * The model is configurable at every call site, but the thinking parameter is not
 * interchangeable across models — so hardcoding one shape next to a configurable model id
 * is a latent 400 waiting for whoever swaps it next. `thinkingFor()` derives the right
 * shape from the id instead.
 *
 * Current generation takes `{type: 'adaptive'}` and rejects `budget_tokens` outright.
 * Haiku 4.5 is the other way round: it predates adaptive thinking and still takes an
 * explicit budget.
 */

import type Anthropic from '@anthropic-ai/sdk';

/** Cheap, fast, 200K context. The volume tier. */
export const HAIKU = 'claude-haiku-4-5';
/** Mid tier, 1M context, adaptive thinking. */
export const SONNET = 'claude-sonnet-5';
/** Top tier, 1M context. */
export const OPUS = 'claude-opus-5';

/** Models that take adaptive thinking. Everything else needs an explicit budget. */
const ADAPTIVE_THINKING = new Set([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-fable-5',
  'claude-fable-5-1',
]);

/** Context window in tokens, for guarding a brief before it is sent. */
export const CONTEXT_WINDOW: Record<string, number> = {
  'claude-haiku-4-5': 200_000,
};
export const DEFAULT_CONTEXT_WINDOW = 1_000_000;

export function contextWindowOf(model: string): number {
  return CONTEXT_WINDOW[model] ?? DEFAULT_CONTEXT_WINDOW;
}

/**
 * The thinking parameter this model accepts.
 *
 * `budgetTokens` is ignored on adaptive models and must be below `max_tokens` (and at
 * least 1024) on the rest.
 */
export function thinkingFor(
  model: string,
  budgetTokens = 4000,
): NonNullable<Anthropic.MessageCreateParams['thinking']> {
  if (ADAPTIVE_THINKING.has(model)) return { type: 'adaptive' };
  return { type: 'enabled', budget_tokens: budgetTokens };
}

// ------------------------------------------------------------------ pricing

/**
 * What a model charges, in USD per million tokens.
 *
 * Until this existed, every LLM call reported a hardcoded constant. Those constants were
 * calibrated for Opus and never updated, so moving the writer to Sonnet and extraction to
 * Haiku cut the real bill by about 60% and changed the reported figure by exactly nothing
 * — two consecutive scans both reported £1.53. Rule 8 says cost_pence is a measurement;
 * for these adapters it was a guess.
 */
export interface ModelPricing {
  input: number;
  output: number;
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

/**
 * Unknown models price as the most expensive tier.
 *
 * A budget wants to be wrong in the safe direction: over-reporting a scan is a smaller
 * problem than discovering a ceiling was breached after the fact.
 */
export const FALLBACK_PRICING: ModelPricing = { input: 5, output: 25 };

export function pricingFor(model: string): ModelPricing {
  return PRICING[model] ?? FALLBACK_PRICING;
}

/** Approximate. The engine reports in pence and Anthropic bills in dollars. */
export const USD_TO_GBP = 0.79;

/** Cached input is billed at a tenth; a 5-minute cache write at 1.25x. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** The token counts an Anthropic response reports back. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/**
 * Price real usage, in pence.
 *
 * Fractional by design: one extraction call is about 0.06p, and rounding each to a whole
 * penny would report a scan's 48 of them as either nothing or five times their cost.
 * Rounding happens once, where the total is persisted.
 */
export function priceUsage(model: string, usage: TokenUsage): { pence: number } {
  const price = pricingFor(model);

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;

  const usd =
    ((usage.input_tokens * price.input +
      cacheRead * price.input * CACHE_READ_MULTIPLIER +
      cacheWrite * price.input * CACHE_WRITE_MULTIPLIER +
      usage.output_tokens * price.output) /
      1_000_000);

  return { pence: usd * USD_TO_GBP * 100 };
}
