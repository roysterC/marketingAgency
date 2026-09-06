/**
 * Reading movement out of a series of snapshots.
 *
 * Two things make this harder than subtracting one number from another, and both produce
 * confident nonsense if ignored.
 *
 * **Models are not deterministic.** Ask the same question twice and the answer differs;
 * share moves a few points run to run with nothing having changed. Comparing the latest run
 * against the previous one therefore alerts on noise, and an alerting product that cries
 * wolf gets switched off in a fortnight. So the baseline is the *median of a window* of
 * earlier runs, which absorbs a single odd answer and still moves when something real does.
 *
 * **A changed prompt set is not a movement.** Edit the questions and every share shifts,
 * because you asked something different — not because anything happened. `comparable()`
 * refuses those pairs outright rather than reporting the artefact, which is the same
 * discipline as refusing to compute a rate from a five-review sample.
 */

import { median } from '../collectors/types';
import type {
  Movement,
  VisibilityAlert,
  VisibilityEntry,
  VisibilitySnapshot,
} from './types';

/** Below this many percentage points, a change is inside the noise a model makes anyway. */
export const MATERIAL_POINTS = 10;

/** How many earlier runs the baseline is taken over. */
export const BASELINE_WINDOW = 3;

/** A rank drop worth mentioning even when share held — still cited, but no longer first. */
export const MATERIAL_RANK_SLIP = 1;

const keyOf = (entry: Pick<VisibilityEntry, 'business_id' | 'name'>): string =>
  entry.business_id ?? `name:${entry.name.toLowerCase()}`;

const same = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/**
 * Whether two snapshots measure the same thing.
 *
 * Same series, same prompts, same models. Anything else and the numbers are not on the same
 * axis, however comparable they look.
 */
export function comparable(a: VisibilitySnapshot, b: VisibilitySnapshot): boolean {
  return (
    a.prompt_set === b.prompt_set && same(a.prompts, b.prompts) && same(a.models, b.models)
  );
}

/** Why a pair cannot be compared, for a message a human can act on. */
export function incomparableReason(
  a: VisibilitySnapshot,
  b: VisibilitySnapshot,
): string | null {
  if (a.prompt_set !== b.prompt_set) return 'different prompt set';
  if (!same(a.prompts, b.prompts)) return 'the prompts changed';
  if (!same(a.models, b.models)) return 'the models changed';
  return null;
}

/**
 * The baseline share for each business, over the comparable runs before the latest.
 *
 * Median rather than mean: one run where a model happened to name nobody should not drag a
 * baseline down for weeks.
 */
export function baselineOf(history: VisibilitySnapshot[]): Map<string, VisibilityEntry> {
  const shares = new Map<string, { entry: VisibilityEntry; shares: number[]; ranks: number[] }>();

  for (const snapshot of history) {
    for (const entry of snapshot.entries) {
      const key = keyOf(entry);
      const bucket = shares.get(key) ?? { entry, shares: [], ranks: [] };
      bucket.shares.push(entry.share);
      if (entry.mean_rank !== null) bucket.ranks.push(entry.mean_rank);
      shares.set(key, bucket);
    }
  }

  const baseline = new Map<string, VisibilityEntry>();
  for (const [key, bucket] of shares) {
    baseline.set(key, {
      ...bucket.entry,
      share: median(bucket.shares) ?? 0,
      mean_rank: median(bucket.ranks),
      cited_in: 0,
    });
  }
  return baseline;
}

export interface MovementOptions {
  window?: number;
  material?: number;
}

/**
 * Movement between the latest snapshot and the runs before it.
 *
 * Returns an empty list when there is nothing comparable to measure against — a first run
 * has no movement, and saying so is better than inventing a baseline of zero and reporting
 * every business as having "entered".
 */
export function detectMovement(
  snapshots: VisibilitySnapshot[],
  options: MovementOptions = {},
): Movement[] {
  const window = options.window ?? BASELINE_WINDOW;
  const material = options.material ?? MATERIAL_POINTS;

  const ordered = [...snapshots].sort((a, b) => a.run_at.localeCompare(b.run_at));
  const latest = ordered[ordered.length - 1];
  if (!latest) return [];

  const history = ordered
    .slice(0, -1)
    .filter((s) => comparable(s, latest))
    .slice(-window);

  if (history.length === 0) return [];

  const baseline = baselineOf(history);
  const movements: Movement[] = [];
  const seen = new Set<string>();

  for (const entry of latest.entries) {
    const key = keyOf(entry);
    seen.add(key);
    const before = baseline.get(key);

    const baseShare = before?.share ?? 0;
    const delta = Math.round((entry.share - baseShare) * 10) / 10;

    movements.push({
      business_id: entry.business_id,
      name: entry.name,
      direction: directionOf(entry.share, baseShare, before !== undefined, delta, material),
      current: entry.share,
      baseline: baseShare,
      delta,
      rank_now: entry.mean_rank,
      rank_before: before?.mean_rank ?? null,
    });
  }

  // Someone the models used to name and now do not. Absent from the latest snapshot, so the
  // loop above never sees them — and they are the most interesting row on the page.
  for (const [key, before] of baseline) {
    if (seen.has(key) || before.share === 0) continue;
    movements.push({
      business_id: before.business_id,
      name: before.name,
      direction: 'dropped_out',
      current: 0,
      baseline: before.share,
      delta: -before.share,
      rank_now: null,
      rank_before: before.mean_rank,
    });
  }

  return movements.sort((a, b) => a.delta - b.delta);
}

function directionOf(
  current: number,
  baseline: number,
  known: boolean,
  delta: number,
  material: number,
): Movement['direction'] {
  if (!known || baseline === 0) return current > 0 ? 'entered' : 'flat';
  if (current === 0) return 'dropped_out';
  if (Math.abs(delta) < material) return 'flat';
  return delta > 0 ? 'gained' : 'lost';
}

export interface AlertOptions {
  /** Only alert about these businesses. Empty means everyone in the roster. */
  watching?: Array<string | null>;
}

/**
 * Movements worth telling someone about.
 *
 * Deliberately quiet. A tracker that reports every wobble trains its reader to ignore it,
 * so the bar is a material share drop, a business disappearing from answers it used to
 * appear in, or a slip down the order while share held — the last being the decline that
 * share alone hides.
 */
export function alertsFrom(
  movements: Movement[],
  options: AlertOptions = {},
): VisibilityAlert[] {
  const watching = options.watching;
  const alerts: VisibilityAlert[] = [];

  for (const movement of movements) {
    if (watching && watching.length > 0 && !watching.includes(movement.business_id)) continue;

    if (movement.direction === 'dropped_out') {
      alerts.push({
        movement,
        reason:
          `No longer named in any answer, having been in ${movement.baseline}% of them. ` +
          `This is the one to look at first.`,
      });
      continue;
    }

    if (movement.direction === 'lost') {
      alerts.push({
        movement,
        reason: `Cited in ${movement.current}% of answers, down ${Math.abs(movement.delta)} points from ${movement.baseline}%.`,
      });
      continue;
    }

    // Share held but the order slipped: still recommended, no longer recommended first.
    const slipped =
      movement.rank_now !== null &&
      movement.rank_before !== null &&
      movement.rank_now - movement.rank_before >= MATERIAL_RANK_SLIP;

    if (slipped && movement.direction !== 'gained') {
      alerts.push({
        movement,
        reason:
          `Still cited in ${movement.current}% of answers, but now listed ` +
          `${movement.rank_now} on average against ${movement.rank_before} before.`,
      });
    }
  }

  return alerts;
}
