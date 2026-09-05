/**
 * AI search visibility — raw capture shape and provider interface.
 *
 * **On rule 2.** CLAUDE.md says the LLM writes, it does not fetch. This collector calls
 * LLM APIs, and that is not a violation of the rule but the other side of it: here the
 * model is the *thing being measured*, not the analyst. We ask ChatGPT what it says about
 * plumbers in Wandsworth and record the answer as raw data, the same way `gbp` records
 * what Places returned. What rule 2 forbids is the analysis layer retrieving facts to put
 * in the narrative, and nothing here does that — these answers become findings through the
 * same closed taxonomy as every other source, and the model's opinion is never treated as
 * true. When a model states something about the business, the interesting case is
 * precisely that it is *wrong*.
 *
 * Like `localrank`, the purchase is scan-level: one answer to "best plumber in Wandsworth"
 * names many businesses, so it is bought once and read by every target. The entity check
 * is the exception — it asks about one business, so it is bought per business.
 */

import type { Priced } from '../../resolve/providers';
import type { Timestamp } from '../shared';

/** Facts a model might state about a business, and that we can check against ground truth. */
export type FactField = 'phone' | 'address' | 'opening_hours' | 'business_status' | 'website';

export interface ModelClaim {
  field: FactField;
  /** What the model said, verbatim enough for the report to quote it. */
  stated: string;
}

export interface ModelCitation {
  /** The business name as the model wrote it. */
  name: string;
  /** Matched to a scan target where we could. Null when the name matched nothing we know. */
  place_id: string | null;
  /** 1-based order of mention. Models list, and being named first carries weight. */
  rank: number;
  /**
   * Structured claims the answer made about this business.
   *
   * Hung off the citation rather than the answer because the answer is shared across every
   * target in the scan — claims about Riverside belong to Riverside's citation, not to the
   * response as a whole.
   */
  claims: ModelClaim[];
}

export interface PromptAnswer {
  prompt: string;
  model: string;
  /** The full response. Evidence: the report quotes it, so it is stored verbatim. */
  text: string;
  citations: ModelCitation[];
  answered_at: Timestamp;
}

/** What one model says when asked about one business by name. */
export interface EntityCheck {
  model: string;
  /**
   * Whether the model recognised the business at all.
   *
   * A model saying "I don't have information about that" is weak evidence — it may simply
   * not have retrieved. Hence `AIVIS_NO_ENTITY` is the one `estimated` code here.
   */
  recognised: boolean;
  text: string;
}

/**
 * Ground truth, from `gbp` and the resolve stage.
 *
 * Every field is optional and only the present ones are checked. A model stating a phone
 * number we never knew is not a wrong answer — it is an unverifiable one, and calling it
 * an error in a paid report would be the same mistake as reporting "0 services listed"
 * for a field Places did not return.
 */
export interface KnownFacts {
  phone?: string;
  address?: string;
  opening_hours?: string;
  business_status?: string;
  website?: string;
}

export interface PromptSet {
  /** Prompt sets are per vertical — see the `prompt_sets` table. */
  vertical: string;
  prompts: string[];
  models: string[];
}

export interface FailedPrompt {
  prompt: string;
  model: string;
  message: string;
}

export interface AivisCapture {
  place_id: string;
  name: string;
  /** Every (prompt x model) answer in the set. Shared across targets. */
  answers: PromptAnswer[];
  /** One per model, about this business specifically. */
  entity_checks: EntityCheck[];
  known_facts: KnownFacts;
  failed_prompts: FailedPrompt[];
  captured_at: Timestamp;
}

export interface AivisProvider {
  readonly name: string;

  /** Ask one model one buying-intent prompt. Scan-level: the answer names many businesses. */
  ask(model: string, prompt: string): Promise<Priced<PromptAnswer>>;

  /** Ask one model what it knows about one business. Per business, so never cached. */
  entity(model: string, name: string, near: string): Promise<Priced<EntityCheck>>;
}
