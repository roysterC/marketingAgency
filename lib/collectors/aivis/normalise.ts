/**
 * AI visibility normalise rules — pure, no I/O.
 *
 * `AIVIS_OUTDATED_FACT` is the one that stops a reader: a model telling their customers
 * the wrong phone number is concrete, checkable in ten seconds, and something almost
 * nobody has thought to look for. It is also the rule most able to embarrass *us* if it
 * fires wrongly, so it only ever compares against a fact we actually hold.
 */

import type { FindingSeed, NormaliseContext } from '../types';
import type { AivisCapture, FactField, KnownFacts, ModelCitation, PromptAnswer } from './types';

/**
 * Below this share of answers naming the business, it is effectively invisible to anyone
 * asking a model for a recommendation.
 *
 * This fires often, and that is not a calibration problem — it is the finding. Most local
 * businesses are cited in nothing, which is exactly why AI visibility is the wedge service
 * in `strategy.md` rather than a nice-to-have.
 */
export const MIN_CITATION_SHARE_PERCENT = 20;

/** Above this share of answers naming a competitor while not naming the subject, say so. */
export const COMPETITOR_CITED_PERCENT = 50;

/** How many answers to quote per finding. */
const MAX_QUOTED = 3;
/** Enough of the answer to show the claim in context. */
const EXCERPT_CHARS = 300;

/** Peer metric keys, shared with the aggregation step. */
export const PEER_KEYS = {
  citation_share: 'aivis.citation_share_percent',
} as const;

const round = (n: number, dp: number): number => {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
};

const peerMedian = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.median[key] ?? null;

const peerBest = (ctx: NormaliseContext, key: string): number | null =>
  ctx.peers?.best[key] ?? null;

const excerpt = (text: string): string =>
  text.length <= EXCERPT_CHARS ? text : `${text.slice(0, EXCERPT_CHARS)}...`;

/** Loose comparison: case, punctuation and spacing never make a fact wrong. */
const loose = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * UK numbers arrive written several ways — `+44 20 8000 2222`, `020 8000 2222`,
 * `02080002222` — and all three are the same number. Comparing them raw would report a
 * correct answer as an error, which is the worst way for this finding to be wrong.
 */
const ukPhone = (value: string): string => {
  const digits = value.replace(/\D/g, '');
  if (digits.startsWith('44')) return digits.slice(2);
  if (digits.startsWith('0')) return digits.slice(1);
  return digits;
};

/** Protocol, `www.` and a trailing slash are not part of what a website *is*. */
const site = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');

/**
 * Whether a stated value contradicts what we know.
 *
 * False whenever we do not hold the fact: unverifiable is not the same as wrong.
 */
export function contradicts(field: FactField, stated: string, known: KnownFacts): boolean {
  const truth = known[field];
  if (truth === undefined || truth.trim() === '') return false;

  if (field === 'phone') return ukPhone(stated) !== ukPhone(truth);
  if (field === 'website') return site(stated) !== site(truth);

  // Addresses and hours are written a hundred ways. Containment either direction is close
  // enough to be the same answer — "1 High St" against "1 High Street, London SW18 1AA".
  const a = loose(stated);
  const b = loose(truth);
  if (a === '' || b === '') return false;
  return !a.includes(b) && !b.includes(a);
}

const citationOf = (answer: PromptAnswer, placeId: string): ModelCitation | undefined =>
  answer.citations.find((c) => c.place_id === placeId);

/** Share of answers naming this business, 0–100. Null when nothing was asked. */
export function citationShare(capture: AivisCapture): number | null {
  if (capture.answers.length === 0) return null;
  const cited = capture.answers.filter((a) => citationOf(a, capture.place_id)).length;
  return round((cited / capture.answers.length) * 100, 1);
}

/** Share of answers naming someone else but not this business, 0–100. */
export function competitorOnlyShare(capture: AivisCapture): number | null {
  if (capture.answers.length === 0) return null;
  const lost = capture.answers.filter(
    (a) => !citationOf(a, capture.place_id) && a.citations.length > 0,
  ).length;
  return round((lost / capture.answers.length) * 100, 1);
}

interface WrongClaim {
  model: string;
  prompt: string;
  field: FactField;
  stated: string;
  actual: string;
  excerpt: string;
}

/** Every claim across the set that contradicts a fact we hold. */
export function wrongClaims(capture: AivisCapture): WrongClaim[] {
  const wrong: WrongClaim[] = [];

  for (const answer of capture.answers) {
    const citation = citationOf(answer, capture.place_id);
    if (!citation) continue;

    for (const claim of citation.claims) {
      if (!contradicts(claim.field, claim.stated, capture.known_facts)) continue;
      wrong.push({
        model: answer.model,
        prompt: answer.prompt,
        field: claim.field,
        stated: claim.stated,
        actual: capture.known_facts[claim.field] ?? '',
        excerpt: excerpt(answer.text),
      });
    }
  }

  return wrong;
}

export function normaliseAivis(
  capture: AivisCapture | null,
  ctx: NormaliseContext,
): FindingSeed[] {
  if (!capture) return [];

  const seeds: FindingSeed[] = [];
  const asked = {
    prompts_asked: capture.answers.length,
    models: [...new Set(capture.answers.map((a) => a.model))],
    prompts_failed: capture.failed_prompts.length,
  };

  // --- a model stating something wrong -------------------------------------
  // First because it is the finding that lands hardest, and because it is the only
  // critical one here.
  const wrong = wrongClaims(capture);
  if (wrong.length > 0) {
    seeds.push({
      code: 'AIVIS_OUTDATED_FACT',
      measured_value: wrong.length,
      measured_text: `${wrong.length} incorrect ${wrong.length === 1 ? 'statement' : 'statements'}`,
      evidence: {
        ...asked,
        // The exact model, prompt and response, per the taxonomy note. A claim like this
        // is worthless in a report unless the reader can reproduce it.
        wrong_claims: wrong.slice(0, MAX_QUOTED),
        fields: [...new Set(wrong.map((w) => w.field))],
      },
    });
  }

  // --- citation share -------------------------------------------------------
  const share = citationShare(capture);
  if (share !== null && share < MIN_CITATION_SHARE_PERCENT) {
    seeds.push({
      code: 'AIVIS_NOT_CITED',
      measured_value: share,
      measured_text: `named in ${share}% of answers`,
      benchmark_value: peerBest(ctx, PEER_KEYS.citation_share),
      benchmark_source: peerMedian(ctx, PEER_KEYS.citation_share) === null ? 'absolute' : 'competitor_best',
      evidence: {
        ...asked,
        citation_share_percent: share,
        threshold_percent: MIN_CITATION_SHARE_PERCENT,
        competitor_median: peerMedian(ctx, PEER_KEYS.citation_share),
        competitor_best: peerBest(ctx, PEER_KEYS.citation_share),
        uncited_prompts: capture.answers
          .filter((a) => !a.citations.some((c) => c.place_id === capture.place_id))
          .slice(0, MAX_QUOTED)
          .map((a) => ({ prompt: a.prompt, model: a.model })),
      },
    });
  }

  // --- someone else got named ----------------------------------------------
  const lostShare = competitorOnlyShare(capture);
  if (lostShare !== null && lostShare > COMPETITOR_CITED_PERCENT) {
    const rivals = new Map<string, number>();
    for (const answer of capture.answers) {
      if (citationOf(answer, capture.place_id)) continue;
      for (const c of answer.citations) {
        rivals.set(c.name, (rivals.get(c.name) ?? 0) + 1);
      }
    }
    const named = [...rivals].sort((a, b) => b[1] - a[1]);

    seeds.push({
      code: 'AIVIS_COMPETITOR_CITED',
      measured_value: lostShare,
      measured_text: `competitors named instead in ${lostShare}% of answers`,
      evidence: {
        ...asked,
        competitor_only_share_percent: lostShare,
        threshold_percent: COMPETITOR_CITED_PERCENT,
        named_instead: named.slice(0, MAX_QUOTED).map(([name, count]) => ({ name, answers: count })),
        examples: capture.answers
          .filter((a) => !citationOf(a, capture.place_id) && a.citations.length > 0)
          .slice(0, MAX_QUOTED)
          .map((a) => ({ prompt: a.prompt, model: a.model, excerpt: excerpt(a.text) })),
      },
    });
  }

  // --- does the model know the business exists at all? ---------------------
  if (capture.entity_checks.length > 0 && capture.entity_checks.every((e) => !e.recognised)) {
    seeds.push({
      code: 'AIVIS_NO_ENTITY',
      measured_text: `unrecognised by ${capture.entity_checks.length} of ${capture.entity_checks.length} models`,
      evidence: {
        business_name: capture.name,
        models_checked: capture.entity_checks.map((e) => e.model),
        responses: capture.entity_checks.slice(0, MAX_QUOTED).map((e) => ({
          model: e.model,
          excerpt: excerpt(e.text),
        })),
        note: 'Asked directly, no model could say what this business is or does.',
      },
    });
  }

  return seeds;
}
