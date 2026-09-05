/**
 * AI visibility — `AivisProvider` across Claude, GPT and Perplexity.
 *
 * **The measurement has to be a real answer to a real question.** The buying prompt goes
 * to each model exactly as a customer would ask it — "best plumber in Wandsworth" — and
 * what comes back is stored verbatim. Asking the model to "return the businesses as JSON"
 * would be cheaper and much easier to parse, and it would measure something no customer
 * ever sees. The whole finding rests on the answer being the one a real person gets.
 *
 * Structure is therefore a *second*, separate pass: a cheap extraction call turns that
 * verbatim answer into citations and claims. That pass is not part of the measurement, and
 * nothing it produces is treated as true — `AIVIS_OUTDATED_FACT` fires precisely when a
 * model's claim disagrees with ground truth we hold from `gbp`.
 *
 * This is the same rule-2 boundary as everywhere else: the model here is the subject, not
 * the analyst.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

import type { Cost, Priced } from '../resolve/providers';
import type {
  AivisProvider,
  EntityCheck,
  ModelCitation,
  PromptAnswer,
} from '../collectors/aivis/types';
import { optional, required, type Env } from './config';
import { requestJson, type RetryPolicy } from './http';

/** The model the extraction pass runs on. Configurable — it is the volume call. */
export const DEFAULT_EXTRACTION_MODEL = 'claude-opus-5';
/** The model answering the buying prompts, when Claude is in the prompt set. */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5';

/** Roughly 2p an answer is the £0.30 AI-visibility line across 8 prompts x 3 models. */
const DEFAULT_ANSWER_COST: Cost = { pence: 2 };
const DEFAULT_EXTRACTION_COST: Cost = { pence: 1 };

/** One model, answering a question the way a customer would ask it. */
export interface AnswerSource {
  readonly model: string;
  ask(prompt: string): Promise<Priced<string>>;
}

/** A business the scan knows about, so extracted names can be matched back to it. */
export interface RosterEntry {
  place_id: string;
  name: string;
  /** Other ways the business is written. Models rarely use the legal name. */
  aliases?: string[];
}

const FACT_FIELDS = ['phone', 'address', 'opening_hours', 'business_status', 'website'] as const;

const ExtractionSchema = z.object({
  citations: z.array(
    z.object({
      name: z.string(),
      rank: z.number().int(),
      claims: z.array(
        z.object({
          field: z.enum(FACT_FIELDS),
          stated: z.string(),
        }),
      ),
    }),
  ),
});

const EXTRACTION_SYSTEM = `You extract structure from an AI assistant's answer about local businesses.

Rules:
- List every business named in the answer, in the order they appear. rank starts at 1.
- Use the business name exactly as the answer writes it. Do not correct or expand it.
- Record a claim ONLY when the answer states that specific fact about that specific
  business. Do not infer, complete or normalise it — record it verbatim.
- If the answer states no facts about a business, its claims array is empty.
- Never add a business the answer does not name.`;

const ENTITY_SYSTEM = `You judge whether an AI assistant's answer shows it recognises a
specific named business.

Answer "yes" only if the response describes what the business is or does. A response that
says it has no information, cannot find it, or describes a different business is "no".`;

const EntitySchema = z.object({
  recognised: z.boolean(),
});

/** Loose name matching. Models write "Wandsworth Plumbers" for "Wandsworth Plumbers Ltd". */
const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/\b(ltd|limited|plc|llp|co|company|the)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

export function matchPlaceId(name: string, roster: RosterEntry[]): string | null {
  const needle = normalise(name);
  if (needle === '') return null;

  for (const entry of roster) {
    const candidates = [entry.name, ...(entry.aliases ?? [])].map(normalise);
    if (candidates.some((c) => c === needle || c.includes(needle) || needle.includes(c))) {
      return entry.place_id;
    }
  }
  return null;
}

// ------------------------------------------------------------ answer sources

export interface ClaudeSourceConfig {
  client?: Anthropic;
  apiKey?: string;
  model?: string;
  cost?: Cost;
}

/**
 * Claude, answering as it would for anyone.
 *
 * Adaptive thinking is on — it is what a user actually gets — and the answer is taken
 * verbatim from the text blocks.
 */
export function claudeSource(config: ClaudeSourceConfig = {}): AnswerSource {
  const client = config.client ?? new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
  const model = config.model ?? DEFAULT_CLAUDE_MODEL;
  const cost = config.cost ?? DEFAULT_ANSWER_COST;

  return {
    model: 'claude',
    async ask(prompt): Promise<Priced<string>> {
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      return { value: text, cost };
    },
  };
}

export interface OpenAiCompatibleConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** The label recorded on the capture, e.g. `gpt` or `perplexity`. */
  label: string;
  cost?: Cost;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
}

interface ChatCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * GPT and Perplexity, both of which speak the OpenAI chat-completions shape.
 *
 * One adapter rather than two: the only differences are the base URL, the model id and the
 * key, and a second copy would be two places to fix the same bug.
 */
export function openAiCompatibleSource(config: OpenAiCompatibleConfig): AnswerSource {
  const {
    apiKey,
    model,
    baseUrl = 'https://api.openai.com/v1',
    label,
    cost = DEFAULT_ANSWER_COST,
    retry,
    fetchImpl,
  } = config;

  return {
    model: label,
    async ask(prompt): Promise<Priced<string>> {
      const body = await requestJson<ChatCompletion>(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model, messages: [{ role: 'user', content: prompt }] },
        timeoutMs: 60_000,
        ...(retry ? { retry } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      return { value: body.choices?.[0]?.message?.content ?? '', cost };
    },
  };
}

export const gptSource = (apiKey: string, model = 'gpt-4o'): AnswerSource =>
  openAiCompatibleSource({ apiKey, model, label: 'gpt' });

export const perplexitySource = (apiKey: string, model = 'sonar'): AnswerSource =>
  openAiCompatibleSource({
    apiKey,
    model,
    label: 'perplexity',
    baseUrl: 'https://api.perplexity.ai',
  });

// --------------------------------------------------------------- extraction

export interface Extractor {
  extract(answer: string, roster: RosterEntry[]): Promise<Priced<ModelCitation[]>>;
  recognises(answer: string, businessName: string): Promise<Priced<boolean>>;
}

export interface ExtractorConfig {
  client?: Anthropic;
  apiKey?: string;
  model?: string;
  cost?: Cost;
}

export function claudeExtractor(config: ExtractorConfig = {}): Extractor {
  const client = config.client ?? new Anthropic(config.apiKey ? { apiKey: config.apiKey } : {});
  const model = config.model ?? DEFAULT_EXTRACTION_MODEL;
  const cost = config.cost ?? DEFAULT_EXTRACTION_COST;

  return {
    async extract(answer, roster): Promise<Priced<ModelCitation[]>> {
      if (answer.trim() === '') return { value: [], cost };

      const response = await client.messages.parse({
        model,
        max_tokens: 4000,
        system: EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: answer }],
        output_config: { format: zodOutputFormat(ExtractionSchema) },
      });

      const parsed = response.parsed_output;
      if (!parsed) return { value: [], cost };

      const citations: ModelCitation[] = parsed.citations.map((c) => ({
        name: c.name,
        place_id: matchPlaceId(c.name, roster),
        rank: c.rank,
        claims: c.claims.map((claim) => ({ field: claim.field, stated: claim.stated })),
      }));

      return { value: citations, cost };
    },

    async recognises(answer, businessName): Promise<Priced<boolean>> {
      const response = await client.messages.parse({
        model,
        max_tokens: 1000,
        system: ENTITY_SYSTEM,
        messages: [
          { role: 'user', content: `Business: ${businessName}\n\nAnswer:\n${answer}` },
        ],
        output_config: { format: zodOutputFormat(EntitySchema) },
      });

      return { value: response.parsed_output?.recognised ?? false, cost };
    },
  };
}

// ----------------------------------------------------------------- provider

export interface AivisAdapterConfig {
  /** One per model in the prompt set, keyed by the label the capture records. */
  sources: AnswerSource[];
  extractor: Extractor;
  /** The scan's businesses, so extracted names map back to targets. */
  roster: RosterEntry[];
}

export function createAivisProvider(config: AivisAdapterConfig): AivisProvider {
  const { sources, extractor, roster } = config;
  const byLabel = new Map(sources.map((s) => [s.model, s]));

  const sourceFor = (model: string): AnswerSource => {
    const source = byLabel.get(model);
    if (!source) {
      throw new Error(
        `No answer source configured for "${model}". ` +
          `The prompt set names it; check the API key for that provider is set.`,
      );
    }
    return source;
  };

  return {
    name: 'aivis-multi-model',

    async ask(model, prompt): Promise<Priced<PromptAnswer>> {
      const answered = await sourceFor(model).ask(prompt);
      const extracted = await extractor.extract(answered.value, roster);

      return {
        value: {
          prompt,
          model,
          text: answered.value,
          citations: extracted.value,
          answered_at: new Date().toISOString(),
        },
        cost: { pence: answered.cost.pence + extracted.cost.pence },
      };
    },

    async entity(model, name, near): Promise<Priced<EntityCheck>> {
      const question = near
        ? `What do you know about ${name}, a business near ${near}?`
        : `What do you know about the business ${name}?`;

      const answered = await sourceFor(model).ask(question);
      const judged = await extractor.recognises(answered.value, name);

      return {
        value: { model, recognised: judged.value, text: answered.value },
        cost: { pence: answered.cost.pence + judged.cost.pence },
      };
    },
  };
}

/**
 * Whichever models have keys configured.
 *
 * A prompt set naming a model with no key fails loudly at `ask` rather than quietly
 * producing a thinner citation share — an absent model is not the same as a model that
 * did not mention you.
 */
export function answerSourcesFromEnv(env: Env = process.env): AnswerSource[] {
  const sources: AnswerSource[] = [
    claudeSource({
      apiKey: required(env, 'ANTHROPIC_API_KEY', 'Claude in the aivis prompt set'),
    }),
  ];

  const openai = optional(env, 'OPENAI_API_KEY');
  if (openai) sources.push(gptSource(openai));

  const perplexity = optional(env, 'PERPLEXITY_API_KEY');
  if (perplexity) sources.push(perplexitySource(perplexity));

  return sources;
}
