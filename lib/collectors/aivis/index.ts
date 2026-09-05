/**
 * The `aivis` collector.
 *
 * The differentiator. Every SEO client is asking whether they show up in AI answers and
 * most agencies are bluffing, because nobody has the measurement — so building the
 * measurement is the moat, and in phase A3 this collector is promoted into edge service #1
 * on its own retainer. See `docs/roadmap.md`.
 *
 * Two things it shares with `localrank`: the buying prompts are a scan-level purchase, so
 * they go through `createScanCache` and are bought once however many targets read them;
 * and a failed prompt thins the section rather than failing the scan. The entity check is
 * per business and is never cached.
 */

import type { Priced } from '../../resolve/providers';
import { createScanCache } from '../scan-cache';
import {
  attempt,
  median,
  type CollectContext,
  type CollectTarget,
  type Collector,
  type FindingSeed,
  type NormaliseContext,
  type PeerStats,
} from '../types';
import { PEER_KEYS, citationShare, normaliseAivis } from './normalise';
import type {
  AivisCapture,
  AivisProvider,
  EntityCheck,
  FailedPrompt,
  KnownFacts,
  PromptAnswer,
  PromptSet,
} from './types';

/** Every code this collector may emit. Verified against the registry in tests. */
export const AIVIS_EMITS = [
  'AIVIS_NOT_CITED',
  'AIVIS_COMPETITOR_CITED',
  'AIVIS_OUTDATED_FACT',
  'AIVIS_NO_ENTITY',
] as const;

/**
 * One purchase per (model, prompt), however many targets read the answer.
 *
 * Only `ask` is cached. `entity` asks about one named business, so it is genuinely
 * per-target and caching it would hand every business the first one's answer.
 */
export function scanPromptCache(provider: AivisProvider): AivisProvider {
  const cached = createScanCache(
    (request: { model: string; prompt: string }) => provider.ask(request.model, request.prompt),
    ({ model, prompt }) => `${model}::${prompt.trim().toLowerCase()}`,
  );

  return {
    name: `${provider.name}+scan-cache`,
    ask: (model, prompt): Promise<Priced<PromptAnswer>> => cached({ model, prompt }),
    entity: (model, name, near) => provider.entity(model, name, near),
  };
}

export interface AivisOptions {
  /**
   * Whether to ask each model about the business by name.
   *
   * One extra call per model per business, and the only route to `AIVIS_NO_ENTITY`.
   */
  checkEntity?: boolean;
}

/**
 * Ground truth for one target, assembled by the caller from `gbp` and resolve.
 *
 * Passed in rather than fetched here: this collector owns LLM answers, and a second source
 * inside it would make the same mistake `sitetech` had to handle deliberately.
 */
export type KnownFactsFor = (target: CollectTarget) => KnownFacts;

export function createAivisCollector(
  provider: AivisProvider,
  promptSet: PromptSet,
  knownFactsFor: KnownFactsFor,
  options: AivisOptions = {},
): Collector<AivisCapture> {
  return {
    name: 'aivis',
    requires_auth: false,
    segments: ['smb', 'dtc'],
    emits: AIVIS_EMITS,

    async collect(
      target: CollectTarget,
      _ctx: CollectContext,
    ): Promise<Priced<AivisCapture | null>> {
      let pence = 0;

      // Every (model x prompt) pair. The cache shares in-flight requests, so a scan over
      // six targets still makes one round of calls.
      const pairs = promptSet.models.flatMap((model) =>
        promptSet.prompts.map((prompt) => ({ model, prompt })),
      );

      const asked = await Promise.all(
        pairs.map(async (pair) => ({
          pair,
          outcome: await attempt(() => provider.ask(pair.model, pair.prompt)),
        })),
      );

      const answers: PromptAnswer[] = [];
      const failed: FailedPrompt[] = [];

      for (const { pair, outcome } of asked) {
        pence += outcome.cost.pence;
        if (outcome.value === null) {
          failed.push({ ...pair, message: outcome.error ?? 'unknown error' });
          continue;
        }
        answers.push(outcome.value);
      }

      // --- does anything know this business by name? --------------------------
      const entityChecks: EntityCheck[] = [];
      if (options.checkEntity) {
        const near = target.place.postcode ?? '';
        const checks = await Promise.all(
          promptSet.models.map((model) =>
            attempt(() => provider.entity(model, target.place.name, near)),
          ),
        );
        for (const check of checks) {
          pence += check.cost.pence;
          if (check.value) entityChecks.push(check.value);
        }
      }

      return {
        value: {
          place_id: target.place.place_id,
          name: target.place.name,
          answers,
          entity_checks: entityChecks,
          known_facts: knownFactsFor(target),
          failed_prompts: failed,
          captured_at: new Date().toISOString(),
        },
        cost: { pence },
      };
    },

    normalise(raw: AivisCapture | null, ctx: NormaliseContext): FindingSeed[] {
      return normaliseAivis(raw, ctx);
    },
  };
}

/**
 * Build peer stats from the competitors' captures.
 *
 * Citation share is higher-better, so `best` is the maximum — the competitor the models
 * name most often is the one the report holds up.
 */
export function aivisPeerStats(captures: AivisCapture[]): PeerStats {
  const stats: PeerStats = { median: {}, best: {} };

  const shares = captures
    .map((c) => citationShare(c))
    .filter((s): s is number => s !== null);

  const mid = median(shares);
  if (mid !== null) {
    stats.median[PEER_KEYS.citation_share] = mid;
    stats.best[PEER_KEYS.citation_share] = Math.max(...shares);
  }

  return stats;
}

/** No ground truth for this target. Every fact check is skipped rather than guessed. */
export const NO_KNOWN_FACTS: KnownFactsFor = () => ({});

export * from './types';
export * from './normalise';
