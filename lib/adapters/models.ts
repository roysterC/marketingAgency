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
