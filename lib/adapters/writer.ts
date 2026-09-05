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

export const DEFAULT_WRITER_MODEL = 'claude-opus-5';

/** ~£0.60 for a 150k-in / 15k-out analysis, per the cost table. */
const DEFAULT_COST: Cost = { pence: 60 };

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
      const response = await client.messages.parse({
        model,
        max_tokens: maxTokens,
        system: WRITER_SYSTEM,
        // Judgement about what matters commercially, over a page of structured findings.
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: renderBrief(brief) }],
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
