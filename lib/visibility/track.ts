/**
 * Taking one visibility snapshot.
 *
 * Asks every prompt of every model exactly as a customer would, and records who was named.
 * The measurement is deliberately the same one `aivis` makes during a scan — same provider,
 * same extraction — so a tracked series and a teardown never disagree about the same
 * business on the same day.
 *
 * What differs is what gets kept. A scan keeps findings, which only exist when something is
 * wrong. This keeps the numbers every time, including the good ones, because a series of
 * "nothing to report" is what makes the first drop visible.
 */

import { attempt } from '../collectors/types';
import { matchPlaceId, type RosterEntry } from '../adapters/aivis';
import type { AivisProvider, PromptAnswer } from '../collectors/aivis/types';
import type { PromptSet, TrackedBusiness, VisibilityEntry, VisibilitySnapshot } from './types';

export interface TrackOptions {
  note?: string | null;
  now?: () => Date;
  id?: () => string;
  onProgress?: (message: string) => void;
}

export interface TrackResult {
  snapshot: VisibilitySnapshot;
  /** Prompts a model refused. A thin run is worth knowing about before reading it. */
  failures: Array<{ model: string; prompt: string; message: string }>;
  answers: PromptAnswer[];
}

const round = (n: number, dp = 1): number => {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
};

/**
 * Turn a set of answers into per-business shares.
 *
 * Every named business gets an entry, including ones outside the roster — a model
 * recommending a firm you have never heard of is exactly the thing worth seeing early.
 * Tracked businesses that were never named get a zero rather than being absent, because a
 * missing row and a zero mean different things to a chart.
 */
export function summarise(
  answers: PromptAnswer[],
  roster: TrackedBusiness[],
): VisibilityEntry[] {
  const total = answers.length;
  const tally = new Map<string, { name: string; business_id: string | null; cites: number; ranks: number[] }>();

  const rosterEntries: RosterEntry[] = roster
    .filter((b): b is TrackedBusiness & { business_id: string } => b.business_id !== null)
    .map((b) => ({
      place_id: b.business_id,
      name: b.name,
      ...(b.aliases ? { aliases: b.aliases } : {}),
    }));

  for (const answer of answers) {
    // One business named twice in one answer still counts once: this is share of answers,
    // not share of mentions.
    const seen = new Set<string>();

    for (const citation of answer.citations) {
      const businessId = citation.place_id ?? matchPlaceId(citation.name, rosterEntries);
      const key = businessId ?? `name:${citation.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entry = tally.get(key) ?? {
        name: citation.name,
        business_id: businessId,
        cites: 0,
        ranks: [],
      };
      entry.cites += 1;
      entry.ranks.push(citation.rank);
      tally.set(key, entry);
    }
  }

  // A tracked business nobody mentioned is a zero, not a gap.
  for (const business of roster) {
    const key = business.business_id ?? `name:${business.name.toLowerCase()}`;
    if (!tally.has(key)) {
      tally.set(key, { name: business.name, business_id: business.business_id, cites: 0, ranks: [] });
    }
  }

  return [...tally.values()]
    .map((entry) => ({
      business_id: entry.business_id,
      name: entry.name,
      share: total === 0 ? 0 : round((entry.cites / total) * 100),
      cited_in: entry.cites,
      mean_rank:
        entry.ranks.length === 0
          ? null
          : round(entry.ranks.reduce((a, b) => a + b, 0) / entry.ranks.length, 2),
    }))
    .sort((a, b) => b.share - a.share || (a.mean_rank ?? 99) - (b.mean_rank ?? 99));
}

export async function trackVisibility(
  provider: AivisProvider,
  promptSet: PromptSet,
  roster: TrackedBusiness[],
  options: TrackOptions = {},
): Promise<TrackResult> {
  const now = options.now ?? (() => new Date());
  const id = options.id ?? (() => crypto.randomUUID());

  const pairs = promptSet.models.flatMap((model) =>
    promptSet.prompts.map((prompt) => ({ model, prompt })),
  );

  const answers: PromptAnswer[] = [];
  const failures: TrackResult['failures'] = [];
  let pence = 0;

  for (const pair of pairs) {
    options.onProgress?.(`${pair.model}: ${pair.prompt}`);
    const outcome = await attempt(() => provider.ask(pair.model, pair.prompt));
    pence += outcome.cost.pence;

    if (outcome.value === null) {
      // A model refusing thins the run rather than ending it — same rule as a collector.
      failures.push({ ...pair, message: outcome.error ?? 'unknown error' });
      continue;
    }
    answers.push(outcome.value);
  }

  return {
    snapshot: {
      id: id(),
      prompt_set: promptSet.name,
      run_at: now().toISOString(),
      prompts: [...promptSet.prompts],
      models: [...promptSet.models],
      answers: answers.length,
      entries: summarise(answers, roster),
      note: options.note ?? null,
      cost_pence: pence,
    },
    failures,
    answers,
  };
}
