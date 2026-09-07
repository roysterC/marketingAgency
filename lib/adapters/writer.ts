/**
 * The narrative writer — `NarrativeWriter` on Claude.
 *
 * The one place in the engine where a model produces something a client reads. Rule 2 is
 * enforced on both sides of it and neither side trusts the prompt:
 *
 * - **Before:** `lib/analyse/brief.ts` decides what the model can see. There is no path
 *   from `raw_captures` into the brief, so there is nothing to hallucinate *from*.
 * - **After:** `lib/analyse/validate.ts` checks what came back, and the render step
 *   refuses a narrative that fails.
 *
 * The system prompt below still states the rules, because a model that understands them
 * produces a better first draft than one that gets rejected and retried. But it is the
 * cheapest of the three defences, not the real one — a prompt is a request, and the
 * validator is the gate.
 *
 * Structured output is used rather than "reply in JSON": `finding_id` has to be exact for
 * the validator to resolve it, and a schema is how that stops being a hope.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { Cost, Priced } from '../resolve/providers';
import type { NarrativeWriter } from '../analyse/index';
import type { AnalysisBrief } from '../analyse/brief';
import { COLLECTORS } from '../taxonomy/enums';
import type { Narrative } from '../types/index';
import { required, type Env } from './config';
import { SONNET, contextWindowOf, thinkingFor } from './models';

/**
 * Sonnet 5 — the deliberate middle of the three tiers.
 *
 * This is the only call in the engine whose output a client reads, which makes it the
 * one place paying more is defensible. Sonnet keeps adaptive thinking and the 1M context
 * window — Haiku's 200K is uncomfortably close to a ~150k-token brief — at 60% under Opus.
 *
 * The writer runs once a scan, so the whole spread between tiers is pennies: 18p on
 * Haiku, 36p here, 60p on Opus. Extraction (`aivis.ts`) is where model choice actually
 * moves the bill, at ~48 calls a scan, and that one is on Haiku.
 */
export const DEFAULT_WRITER_MODEL = SONNET;

/** ~£0.36 for a 150k-in / 15k-out analysis on Sonnet ($2/$10 per MTok). */
const DEFAULT_COST: Cost = { pence: 36 };

const ClaimSchema = z.object({
  text: z.string(),
  finding_id: z.string(),
});

const NarrativeSchema = z.object({
  executive_summary: z.array(ClaimSchema),
  sections: z.array(
    z.object({
      heading: z.string(),
      collector: z.enum(COLLECTORS),
      claims: z.array(ClaimSchema),
    }),
  ),
  recommendations: z.array(
    z.object({
      action: z.string(),
      finding_ids: z.array(z.string()),
      priority: z.number().int(),
    }),
  ),
});

/**
 * What the model is told.
 *
 * Written as constraints rather than encouragement, because the failure modes here are
 * specific and each line below is one the validator will otherwise catch and reject.
 */
export const WRITER_SYSTEM = `You write competitive teardowns for a UK marketing agency. The
reader is the owner of a small local business who did not ask for this report and is
sceptical of it.

You are given findings. Each one was measured or inferred by the engine, and each has an id.

Hard rules. Every one of these is checked after you write, and a narrative that breaks any
of them is rejected rather than sent:

1. Every claim you write must cite the finding_id it rests on. One claim, one finding.
2. Never state a fact that is not in a finding. You may rank, group, phrase and explain.
   You may not add a number, a competitor name, or a cause that was not given to you.
3. A finding marked confidence "estimated" was inferred, not measured. Any claim resting on
   one must be phrased as inference — "appears to be", "suggests", "likely". A flat
   statement of fact on an estimated finding is rejected.
4. Do not quote a vertical percentile for any code listed in unquotable_benchmarks. Say
   "not enough comparable businesses yet" instead, or leave the comparison out.
5. Every critical finding about the subject must appear somewhere in the narrative.
6. Every recommendation must cite the findings that justify it.

Style:
- Plain British English. Short sentences. No marketing language, no adjectives doing work
  that a number should do.
- Lead with what is costing them money now, not with what is easiest to fix.
- Quote the measurement. "31 hours" beats "very slow". The measured value and measured_text
  are already in the brief; use them verbatim.
- Name competitors only where a finding names them.
- Do not apologise, do not flatter, do not pad. The reader's time is the thing you are
  spending.
- The executive summary is three or four claims: the ones that are embarrassing, instantly
  checkable, and previously unknown.
- One section per collector that has findings. Order them worst-first.`;

export interface WriterConfig {
  client?: Anthropic;
  apiKey?: string;
  model?: string;
  cost?: Cost;
  /** Raise for a longer report, lower for a cheaper draft. */
  maxTokens?: number;
}

/** The brief, as the model sees it. JSON because it is structure, not prose. */
export function renderBrief(brief: AnalysisBrief): string {
  return JSON.stringify(brief, null, 2);
}

export function createNarrativeWriter(config: WriterConfig = {}): NarrativeWriter {
  const client = config.client ?? new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
  const model = config.model ?? DEFAULT_WRITER_MODEL;
  const cost = config.cost ?? DEFAULT_COST;
  const maxTokens = config.maxTokens ?? 16000;

  return {
    name: `claude-writer/${model}`,

    async write(brief): Promise<Priced<Narrative>> {
      const rendered = renderBrief(brief);

      // The brief runs ~150k tokens on a full scan and Haiku's window is 200K, against
      // 1M on Opus and Sonnet. Close enough that a findings-heavy scan could cross it, so
      // say which model and how big rather than surfacing a raw 400 halfway through.
      const estimatedTokens = Math.ceil(rendered.length / 4);
      const window = contextWindowOf(model);
      if (estimatedTokens > window * 0.9) {
        throw new Error(
          `The analysis brief is ~${estimatedTokens} tokens, too close to ${model}'s ` +
            `${window}-token window. Use a model with a larger context (SONNET or OPUS ` +
            `in lib/adapters/models.ts) for scans this size.`,
        );
      }

      const response = await client.messages.parse({
        model,
        max_tokens: maxTokens,
        system: WRITER_SYSTEM,
        // Judgement about what matters commercially, over a page of structured findings.
        // Shape depends on the model — adaptive is rejected by Haiku, budget_tokens by Opus.
        thinking: thinkingFor(model),
        messages: [{ role: 'user', content: rendered }],
        output_config: { format: zodOutputFormat(NarrativeSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) {
        // Not recoverable here: an unparsed response has no claims to validate, and
        // guessing at one would be the exact failure the whole stage exists to prevent.
        throw new Error(
          `The writer returned no parsable narrative (stop_reason: ${response.stop_reason}).`,
        );
      }

      return { value: parsed as Narrative, cost };
    },
  };
}

export function writerConfigFromEnv(env: Env = process.env): WriterConfig {
  return {
    apiKey: required(env, 'ANTHROPIC_API_KEY', 'the narrative writer'),
  };
}
