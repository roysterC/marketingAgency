import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { MemoryScanStore } from '../db/memory';
import type { AivisProvider, EntityCheck, PromptAnswer } from '../collectors/aivis/types';
import type { Priced } from '../resolve/providers';
import { summarise, trackVisibility } from './track';
import {
  BASELINE_WINDOW,
  MATERIAL_POINTS,
  alertsFrom,
  baselineOf,
  comparable,
  detectMovement,
  incomparableReason,
} from './movement';
import type { PromptSet, TrackedBusiness, VisibilitySnapshot } from './types';

const NOW = new Date('2026-09-06T12:00:00.000Z');

const answer = (cites: Array<[string, number]>, prompt = 'p', model = 'claude'): PromptAnswer => ({
  prompt,
  model,
  text: 'x',
  citations: cites.map(([name, rank]) => ({ name, place_id: null, rank, claims: [] })),
  answered_at: NOW.toISOString(),
});

const snapshot = (over: Partial<VisibilitySnapshot> = {}): VisibilitySnapshot => ({
  id: 's1',
  prompt_set: 'demo',
  run_at: '2026-09-01T00:00:00.000Z',
  prompts: ['a', 'b'],
  models: ['claude'],
  answers: 2,
  entries: [],
  note: null,
  cost_pence: 4,
  ...over,
});

const entry = (name: string, share: number, mean_rank: number | null = 1) => ({
  business_id: null,
  name,
  share,
  cited_in: 1,
  mean_rank,
});

// ------------------------------------------------------------- summarising

describe('turning answers into shares', () => {
  test('share is the fraction of answers naming a business', () => {
    const entries = summarise([answer([['A', 1]]), answer([['A', 1]]), answer([['B', 1]])], []);
    assert.equal(entries.find((e) => e.name === 'A')!.share, 66.7);
    assert.equal(entries.find((e) => e.name === 'B')!.share, 33.3);
  });

  test('a business named twice in one answer counts once', () => {
    // This is share of answers, not share of mentions. A model that repeats a name is not
    // recommending it twice.
    const entries = summarise([answer([['A', 1], ['A', 3]])], []);
    assert.equal(entries[0]!.cited_in, 1);
    assert.equal(entries[0]!.share, 100);
  });

  test('mean rank is kept, because share alone hides a real decline', () => {
    // Still cited everywhere, now listed third where it used to be first.
    const entries = summarise([answer([['A', 1]]), answer([['A', 3]])], []);
    assert.equal(entries[0]!.mean_rank, 2);
  });

  test('a tracked business nobody named is a zero, not a gap', () => {
    // A missing row and a zero mean different things to a chart, and to a client.
    const roster: TrackedBusiness[] = [{ business_id: 'b1', name: 'Riverside Plumbing' }];
    const entries = summarise([answer([['Wandsworth Plumbers', 1]])], roster);

    const riverside = entries.find((e) => e.name === 'Riverside Plumbing')!;
    assert.equal(riverside.share, 0);
    assert.equal(riverside.mean_rank, null);
  });

  test('a business outside the roster still counts — it is real competition', () => {
    const entries = summarise([answer([['Someone Unheard Of', 1]])], []);
    assert.equal(entries[0]!.share, 100);
    assert.equal(entries[0]!.business_id, null);
  });

  test('a roster business is matched through its alias', () => {
    const roster: TrackedBusiness[] = [
      { business_id: 'b1', name: 'Wandsworth Plumbers Ltd', aliases: ['Wandsworth Plumbers'] },
    ];
    const entries = summarise([answer([['Wandsworth Plumbers', 1]])], roster);
    assert.equal(entries.length, 1, 'the alias and the roster entry are one business');
    assert.equal(entries[0]!.business_id, 'b1');
  });

  test('no answers at all is zeroes rather than a divide by nothing', () => {
    const entries = summarise([], [{ business_id: 'b1', name: 'X' }]);
    assert.equal(entries[0]!.share, 0);
  });

  test('entries come back strongest first', () => {
    const entries = summarise([answer([['A', 1]]), answer([['A', 1], ['B', 2]])], []);
    assert.deepEqual(entries.map((e) => e.name), ['A', 'B']);
  });
});

// ------------------------------------------------------------ comparability

describe('a changed prompt set is not a movement', () => {
  test('same questions of the same models are comparable', () => {
    assert.equal(comparable(snapshot(), snapshot({ id: 's2' })), true);
  });

  test('different prompts are not', () => {
    // Every share shifts because you asked something different, not because anything
    // happened. Reporting that as change would be reporting an artefact.
    const changed = snapshot({ prompts: ['a', 'c'] });
    assert.equal(comparable(snapshot(), changed), false);
    assert.equal(incomparableReason(snapshot(), changed), 'the prompts changed');
  });

  test('different models are not', () => {
    const changed = snapshot({ models: ['claude', 'gpt'] });
    assert.equal(comparable(snapshot(), changed), false);
    assert.equal(incomparableReason(snapshot(), changed), 'the models changed');
  });

  test('a different series is not', () => {
    assert.equal(incomparableReason(snapshot(), snapshot({ prompt_set: 'other' })), 'different prompt set');
  });

  test('order does not matter — the same questions asked in any order are the same set', () => {
    assert.equal(comparable(snapshot(), snapshot({ prompts: ['b', 'a'] })), true);
  });
});

// ------------------------------------------------------------------ baseline

describe('the baseline', () => {
  test('is the median, so one odd run does not drag it for weeks', () => {
    const history = [
      snapshot({ run_at: '2026-09-01T00:00:00.000Z', entries: [entry('A', 60)] }),
      // One run where a model happened to name nobody.
      snapshot({ run_at: '2026-09-02T00:00:00.000Z', entries: [entry('A', 0)] }),
      snapshot({ run_at: '2026-09-03T00:00:00.000Z', entries: [entry('A', 60)] }),
    ];
    assert.equal(baselineOf(history).get('name:a')!.share, 60);
  });
});

// ------------------------------------------------------------------ movement

describe('detecting movement', () => {
  const series = (shares: number[]): VisibilitySnapshot[] =>
    shares.map((share, i) =>
      snapshot({
        id: `s${i}`,
        run_at: `2026-09-0${i + 1}T00:00:00.000Z`,
        entries: [entry('A', share)],
      }),
    );

  test('a first run has no movement rather than a baseline of zero', () => {
    // Inventing a zero baseline would report every business as having "entered".
    assert.deepEqual(detectMovement(series([50])), []);
  });

  test('a wobble inside the noise band is flat', () => {
    // Models are not deterministic. Alerting on this is how a tracker gets switched off.
    const movements = detectMovement(series([50, 50, 50, 50 + MATERIAL_POINTS - 1]));
    assert.equal(movements[0]!.direction, 'flat');
  });

  test('a material drop is a loss', () => {
    const movements = detectMovement(series([60, 60, 60, 20]));
    assert.equal(movements[0]!.direction, 'lost');
    assert.equal(movements[0]!.baseline, 60);
    assert.equal(movements[0]!.delta, -40);
  });

  test('a material rise is a gain', () => {
    assert.equal(detectMovement(series([10, 10, 10, 70]))[0]!.direction, 'gained');
  });

  test('disappearing entirely is its own direction', () => {
    const snapshots = [
      snapshot({ id: 's1', run_at: '2026-09-01T00:00:00.000Z', entries: [entry('A', 80)] }),
      snapshot({ id: 's2', run_at: '2026-09-02T00:00:00.000Z', entries: [entry('A', 80)] }),
      // Absent from the latest run entirely — the loop over its entries never sees it.
      snapshot({ id: 's3', run_at: '2026-09-03T00:00:00.000Z', entries: [entry('B', 100)] }),
    ];

    const gone = detectMovement(snapshots).find((m) => m.name === 'A')!;
    assert.equal(gone.direction, 'dropped_out');
    assert.equal(gone.current, 0);
    assert.equal(gone.baseline, 80);
  });

  test('a newcomer is "entered" rather than a gain from nothing', () => {
    const snapshots = [
      snapshot({ id: 's1', run_at: '2026-09-01T00:00:00.000Z', entries: [entry('A', 50)] }),
      snapshot({
        id: 's2',
        run_at: '2026-09-02T00:00:00.000Z',
        entries: [entry('A', 50), entry('B', 40)],
      }),
    ];
    assert.equal(detectMovement(snapshots).find((m) => m.name === 'B')!.direction, 'entered');
  });

  test('runs that asked different questions are excluded from the baseline', () => {
    const snapshots = [
      snapshot({ id: 's1', run_at: '2026-09-01T00:00:00.000Z', prompts: ['x'], entries: [entry('A', 5)] }),
      snapshot({ id: 's2', run_at: '2026-09-02T00:00:00.000Z', entries: [entry('A', 60)] }),
      snapshot({ id: 's3', run_at: '2026-09-03T00:00:00.000Z', entries: [entry('A', 60)] }),
    ];

    // The 5% run asked something else. Including it would invent a rise.
    assert.equal(detectMovement(snapshots)[0]!.baseline, 60);
    assert.equal(detectMovement(snapshots)[0]!.direction, 'flat');
  });

  test('nothing comparable to compare against yields nothing', () => {
    const snapshots = [
      snapshot({ id: 's1', run_at: '2026-09-01T00:00:00.000Z', prompts: ['x'] }),
      snapshot({ id: 's2', run_at: '2026-09-02T00:00:00.000Z', entries: [entry('A', 60)] }),
    ];
    assert.deepEqual(detectMovement(snapshots), []);
  });

  test('the baseline window is bounded, so old runs stop counting', () => {
    const long = series([90, 90, 90, 90, 10, 10, 10, 10]);
    // The last BASELINE_WINDOW comparable runs before the latest are all 10.
    assert.equal(detectMovement(long)[0]!.baseline, 10);
    assert.ok(BASELINE_WINDOW < 8);
  });

  test('worst movement is listed first', () => {
    const snapshots = [
      snapshot({ id: 's1', run_at: '2026-09-01T00:00:00.000Z', entries: [entry('A', 80), entry('B', 20)] }),
      snapshot({ id: 's2', run_at: '2026-09-02T00:00:00.000Z', entries: [entry('A', 10), entry('B', 90)] }),
    ];
    assert.equal(detectMovement(snapshots)[0]!.name, 'A');
  });
});

// -------------------------------------------------------------------- alerts

describe('alerting', () => {
  const lost = {
    business_id: null,
    name: 'Riverside Plumbing',
    direction: 'lost' as const,
    current: 20,
    baseline: 70,
    delta: -50,
    rank_now: 3,
    rank_before: 3,
  };

  test('a material loss is worth a message', () => {
    const alerts = alertsFrom([lost]);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.reason, /down 50 points/);
  });

  test('dropping out leads, because it is the one to look at first', () => {
    const alerts = alertsFrom([{ ...lost, direction: 'dropped_out', current: 0, delta: -70 }]);
    assert.match(alerts[0]!.reason, /No longer named/);
  });

  test('a flat run says nothing', () => {
    // A tracker that reports every wobble trains its reader to ignore it.
    assert.deepEqual(alertsFrom([{ ...lost, direction: 'flat', delta: -2, current: 68 }]), []);
  });

  test('a gain says nothing — this alerts on loss', () => {
    assert.deepEqual(alertsFrom([{ ...lost, direction: 'gained', delta: 30, current: 100 }]), []);
  });

  test('slipping down the order is caught even when share held', () => {
    // The decline share alone hides: still recommended, no longer recommended first.
    const alerts = alertsFrom([
      { ...lost, direction: 'flat', delta: 0, current: 70, rank_before: 1, rank_now: 3 },
    ]);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!.reason, /now listed 3 on average against 1/);
  });

  test('can be narrowed to the businesses being watched', () => {
    const other = { ...lost, business_id: 'b2', name: 'Someone Else' };
    const alerts = alertsFrom([{ ...lost, business_id: 'b1' }, other], { watching: ['b1'] });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.movement.business_id, 'b1');
  });
});

// ------------------------------------------------------------------ tracking

function stubProvider(options: { failOn?: string } = {}): AivisProvider {
  return {
    name: 'stub',
    async ask(model, prompt): Promise<Priced<PromptAnswer>> {
      if (options.failOn === model) throw new Error(`${model} refused`);
      return { value: answer([['Wandsworth Plumbers Ltd', 1]], prompt, model), cost: { pence: 2 } };
    },
    async entity(model): Promise<Priced<EntityCheck>> {
      return { value: { model, recognised: true, text: '' }, cost: { pence: 0 } };
    },
  };
}

describe('taking a snapshot', () => {
  const set: PromptSet = { name: 'demo', prompts: ['a', 'b'], models: ['claude', 'gpt'] };

  test('asks every prompt of every model', async () => {
    const result = await trackVisibility(stubProvider(), set, [], { now: () => NOW, id: () => 's1' });
    assert.equal(result.snapshot.answers, 4);
    assert.equal(result.snapshot.cost_pence, 8);
  });

  test('records exactly what was asked, so the run stays interpretable later', async () => {
    const result = await trackVisibility(stubProvider(), set, [], { now: () => NOW, id: () => 's1' });
    assert.deepEqual(result.snapshot.prompts, ['a', 'b']);
    assert.deepEqual(result.snapshot.models, ['claude', 'gpt']);
  });

  test('a refusing model thins the run rather than ending it', async () => {
    const result = await trackVisibility(stubProvider({ failOn: 'gpt' }), set, [], {
      now: () => NOW,
      id: () => 's1',
    });

    assert.equal(result.snapshot.answers, 2);
    assert.equal(result.failures.length, 2);
    assert.match(result.failures[0]!.message, /refused/);
    // Not billed for the calls that errored.
    assert.equal(result.snapshot.cost_pence, 4);
  });

  test('keeps the note, which is where attribution comes from', async () => {
    // The A3 ship criterion is a movement you can attribute to something you changed, and
    // that half of the sentence cannot be inferred later.
    const result = await trackVisibility(stubProvider(), set, [], {
      now: () => NOW,
      id: () => 's1',
      note: 'added FAQ schema to the services page',
    });
    assert.match(result.snapshot.note!, /FAQ schema/);
  });
});

describe('storing snapshots', () => {
  test('are append-only — a measurement is not rewritten', async () => {
    // Findings get replaced when rules improve. A snapshot records what the models said at
    // a moment, and rewriting it would rewrite the history the product rests on.
    const store = new MemoryScanStore();
    await store.saveSnapshot(snapshot({ id: 's1' }));
    await store.saveSnapshot(snapshot({ id: 's2', run_at: '2026-09-02T00:00:00.000Z' }));

    const series = await store.snapshots('demo');
    assert.deepEqual(series.map((s) => s.id), ['s1', 's2']);
  });

  test('come back oldest first, which is what the baseline window expects', async () => {
    const store = new MemoryScanStore();
    await store.saveSnapshot(snapshot({ id: 'late', run_at: '2026-09-09T00:00:00.000Z' }));
    await store.saveSnapshot(snapshot({ id: 'early', run_at: '2026-09-01T00:00:00.000Z' }));

    assert.deepEqual((await store.snapshots('demo')).map((s) => s.id), ['early', 'late']);
  });

  test('series are kept apart', async () => {
    const store = new MemoryScanStore();
    await store.saveSnapshot(snapshot({ id: 's1', prompt_set: 'demo' }));
    await store.saveSnapshot(snapshot({ id: 's2', prompt_set: 'clinics' }));

    assert.equal((await store.snapshots('demo')).length, 1);
    assert.deepEqual(await store.promptSets(), ['clinics', 'demo']);
  });
});
