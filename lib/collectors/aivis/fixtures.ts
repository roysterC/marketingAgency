/**
 * AI visibility fixtures — four buying prompts across three models, and what each one says.
 *
 * The interesting rows are the two where Riverside *is* named: one states its phone number
 * correctly but written differently, one states a number that is simply wrong. Only the
 * second is a finding, and keeping both in the fixture is what stops the fact check from
 * quietly becoming a formatting check.
 */

import type { Priced } from '../../resolve/providers';
import type {
  AivisProvider,
  EntityCheck,
  KnownFacts,
  ModelClaim,
  ModelCitation,
  PromptAnswer,
  PromptSet,
} from './types';

/** ~24 model calls at 2p is the £0.30 AI-visibility line in the cost table, near enough. */
const ASK_COST = { pence: 2 };
const ENTITY_COST = { pence: 2 };

export const PROMPT_SET: PromptSet = {
  vertical: 'trades.plumbing',
  models: ['claude', 'gpt', 'perplexity'],
  prompts: [
    'best plumber in Wandsworth',
    'emergency plumber near SW18',
    'who should I call for a burst pipe in Wandsworth',
    'recommended boiler engineer in Wandsworth',
  ],
};

/** Names as the models write them, mapped to the scan where we recognise them. */
const PLACE_IDS: Record<string, string | null> = {
  'Riverside Plumbing': 'p_riverside',
  'Wandsworth Plumbers Ltd': 'p_wandsworth',
  'SW Heating & Plumbing': 'p_swheating',
  'QuickFix Plumbing': 'p_quickfix',
  // Named by a model but not in our competitor set. Still someone else getting the work.
  'Thames Valley Plumbing': null,
};

/** What we actually know about the subject, from `gbp` and resolve. */
export const RIVERSIDE_FACTS: KnownFacts = {
  phone: '+442080002222',
  website: 'https://riversideplumbing.example',
  address: '9 River Road, London SW18 4AB',
  // Deliberately absent: we never learned their hours, so a model stating them is
  // unverifiable rather than wrong.
};

export const WANDSWORTH_FACTS: KnownFacts = {
  phone: '+442080001111',
  website: 'https://wandsworthplumbers.example',
};

type Cites = Record<string, string[]>;

const CITATIONS: Record<string, Cites> = {
  'best plumber in Wandsworth': {
    claude: ['Wandsworth Plumbers Ltd', 'SW Heating & Plumbing'],
    gpt: ['Wandsworth Plumbers Ltd', 'QuickFix Plumbing', 'Thames Valley Plumbing'],
    perplexity: ['SW Heating & Plumbing', 'Wandsworth Plumbers Ltd'],
  },
  'emergency plumber near SW18': {
    claude: ['Wandsworth Plumbers Ltd', 'QuickFix Plumbing'],
    gpt: ['Wandsworth Plumbers Ltd', 'SW Heating & Plumbing'],
    perplexity: ['Riverside Plumbing', 'Wandsworth Plumbers Ltd'],
  },
  'who should I call for a burst pipe in Wandsworth': {
    claude: ['SW Heating & Plumbing', 'Wandsworth Plumbers Ltd'],
    gpt: ['Wandsworth Plumbers Ltd'],
    perplexity: ['QuickFix Plumbing', 'Wandsworth Plumbers Ltd'],
  },
  'recommended boiler engineer in Wandsworth': {
    claude: ['Wandsworth Plumbers Ltd', 'SW Heating & Plumbing'],
    gpt: ['Riverside Plumbing', 'Wandsworth Plumbers Ltd'],
    perplexity: ['Wandsworth Plumbers Ltd', 'QuickFix Plumbing'],
  },
};

/** Claims a model made about a named business, keyed by `model::prompt::name`. */
const CLAIMS: Record<string, ModelClaim[]> = {
  // Wrong number. The finding that stops a reader.
  'perplexity::emergency plumber near SW18::Riverside Plumbing': [
    { field: 'phone', stated: '020 8000 9999' },
  ],
  // The same number as the truth, written the way a person writes it. Not a finding.
  // Also states hours we never knew — unverifiable, so also not a finding.
  'gpt::recommended boiler engineer in Wandsworth::Riverside Plumbing': [
    { field: 'phone', stated: '020 8000 2222' },
    { field: 'opening_hours', stated: 'open 24 hours' },
  ],
  'gpt::best plumber in Wandsworth::Wandsworth Plumbers Ltd': [
    { field: 'phone', stated: '+44 20 8000 1111' },
  ],
};

const citation = (model: string, prompt: string, name: string, rank: number): ModelCitation => ({
  name,
  place_id: PLACE_IDS[name] ?? null,
  rank,
  claims: CLAIMS[`${model}::${prompt}::${name}`] ?? [],
});

function buildAnswer(model: string, prompt: string): PromptAnswer {
  const names = CITATIONS[prompt]?.[model] ?? [];
  return {
    prompt,
    model,
    text: `For ${prompt}, the ones that come up most are ${names.join(', ')}.`,
    citations: names.map((name, i) => citation(model, prompt, name, i + 1)),
    answered_at: '2026-09-04T11:00:00.000Z',
  };
}

/** Businesses the models can describe when asked by name. */
const RECOGNISED = new Set(['Wandsworth Plumbers Ltd', 'SW Heating & Plumbing']);

export function fixtureAivisProvider(): AivisProvider & { asks: () => number; entities: () => number } {
  let asks = 0;
  let entities = 0;

  return {
    name: 'fixture-aivis',
    asks: () => asks,
    entities: () => entities,

    async ask(model, prompt): Promise<Priced<PromptAnswer>> {
      asks += 1;
      if (!CITATIONS[prompt]) throw new Error(`no fixture answer for "${prompt}"`);
      return { value: buildAnswer(model, prompt), cost: ASK_COST };
    },

    async entity(model, name, near): Promise<Priced<EntityCheck>> {
      entities += 1;
      const recognised = RECOGNISED.has(name);
      return {
        value: {
          model,
          recognised,
          text: recognised
            ? `${name} is a plumbing firm operating around ${near}.`
            : `I do not have information about a business called ${name}.`,
        },
        cost: ENTITY_COST,
      };
    },
  };
}

/** One model refusing. The other two still answer. */
export function flakyAivisProvider(failOnModel: string): AivisProvider {
  const base = fixtureAivisProvider();
  return {
    name: 'fixture-aivis-flaky',
    async ask(model, prompt): Promise<Priced<PromptAnswer>> {
      if (model === failOnModel) throw new Error(`${model} API 429`);
      return base.ask(model, prompt);
    },
    entity: (model, name, near) => base.entity(model, name, near),
  };
}

/** Every model down. The section empties; the scan continues. */
export const deadAivisProvider: AivisProvider = {
  name: 'fixture-aivis-dead',
  async ask(): Promise<Priced<PromptAnswer>> {
    throw new Error('all model APIs unreachable');
  },
  async entity(): Promise<Priced<EntityCheck>> {
    throw new Error('all model APIs unreachable');
  },
};

export const FACTS: Record<string, KnownFacts> = {
  p_riverside: RIVERSIDE_FACTS,
  p_wandsworth: WANDSWORTH_FACTS,
};
