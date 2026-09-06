/**
 * AI visibility tracking — the shapes behind edge service #1.
 *
 * A3 promotes the `aivis` collector into a monitored product: the same questions, asked on
 * a schedule, so movement becomes visible. Two things make that a different job from a scan
 * rather than a repeat of one.
 *
 * **Findings cannot carry the time series.** `AIVIS_NOT_CITED` only fires below 20% share,
 * so a business sitting at 60% produces no finding at all — and a tracker needs the
 * measurement every run, not only when it crosses a line. Findings are exception-based by
 * design; this is continuous. Hence a snapshot table rather than a query over `findings`.
 *
 * **A prompt set is part of the measurement.** Change the questions and the series breaks:
 * a share that moves because you asked something different is not a movement, it is a
 * different experiment. So each snapshot records exactly what was asked, and
 * `movement.ts` refuses to compare across a change rather than reporting an artefact as a
 * result.
 */

import type { Timestamp, Uuid } from '../types/index';

/** What is asked, and of whom. Changing either starts a new series. */
export interface PromptSet {
  /** Names the series. A vertical for client work, or a label for your own tracking. */
  name: string;
  prompts: string[];
  models: string[];
}

/** A business we are watching, and the names a model might write it as. */
export interface TrackedBusiness {
  business_id: Uuid | null;
  name: string;
  aliases?: string[];
}

export interface VisibilityEntry {
  /** Null when a model named someone outside the roster — still real competition. */
  business_id: Uuid | null;
  name: string;
  /** Share of answers naming this business, 0–100. The headline number. */
  share: number;
  /** How many answers named it. `share` is this over `answers`. */
  cited_in: number;
  /**
   * Mean 1-based position when named, or null when never named.
   *
   * Share alone hides a real kind of decline: still cited everywhere, but now listed third
   * where it used to be first.
   */
  mean_rank: number | null;
}

export interface VisibilitySnapshot {
  id: Uuid;
  /** Which series this belongs to. */
  prompt_set: string;
  run_at: Timestamp;
  /**
   * Exactly what was asked. Stored per snapshot rather than looked up, because the prompt
   * set on disk changes and a snapshot has to stay interpretable years later.
   */
  prompts: string[];
  models: string[];
  /** Answers actually received. Fewer than prompts × models when a model refused. */
  answers: number;
  entries: VisibilityEntry[];
  /**
   * What changed since the last run, in your own words.
   *
   * The A3 ship criterion is "a movement you can attribute to something you changed", and
   * attribution is not something the engine can infer — it is something you write down at
   * the time and are grateful for later.
   */
  note: string | null;
  cost_pence: number;
}

export type MovementDirection = 'gained' | 'lost' | 'entered' | 'dropped_out' | 'flat';

export interface Movement {
  business_id: Uuid | null;
  name: string;
  direction: MovementDirection;
  /** Share now. */
  current: number;
  /** What it is being compared against — see `baselineOf`. */
  baseline: number;
  /** Percentage points. Negative is a loss. */
  delta: number;
  /** Mean rank now and at baseline, where both are known. */
  rank_now: number | null;
  rank_before: number | null;
}

export interface VisibilityAlert {
  movement: Movement;
  /** Why this is worth a message rather than noise. */
  reason: string;
}
