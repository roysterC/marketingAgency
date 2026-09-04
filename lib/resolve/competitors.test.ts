import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { groupAppearances, isDirectory, selectCompetitors } from './competitors';
import type { Candidate, Place } from './types';

const SUBJECT: Place = {
  place_id: 'subject', name: 'Riverside Plumbing', primary_category: 'Plumber',
  lat: 51.4571, lng: -0.1911, domain: 'riverside.example', postcode: 'SW18 4AB', phone: null,
};

function candidate(
  over: Partial<Place> & { place_id: string },
  hits: Array<[string, number]>,
): Candidate {
  const place: Place = {
    name: over.place_id, primary_category: 'Plumber',
    lat: 51.4580, lng: -0.1900, domain: null, postcode: 'SW18 1AA', phone: null,
    ...over,
  };
  return {
    ...place,
    appearances: hits.map(([keyword, position]) => ({
      keyword, position, place_id: place.place_id, name: place.name,
    })),
  };
}

describe('directory detection', () => {
  test('recognises the aggregators that dominate local packs', () => {
    for (const name of ['Checkatrade', 'MyBuilder', 'Rated People', 'Yell', 'Trustpilot']) {
      assert.equal(isDirectory({ name, domain: null }), true, name);
    }
  });

  test('matches however the brand is spelled', () => {
    // The same directory arrives spaced, unspaced and as a domain.
    for (const name of ['Rated People', 'RatedPeople', 'rated people', 'Check a Trade']) {
      assert.equal(isDirectory({ name, domain: null }), true, name);
    }
  });

  test('matches on domain too', () => {
    assert.equal(isDirectory({ name: 'Find a Trade', domain: 'checkatrade.com' }), true);
    assert.equal(isDirectory({ name: 'Local Listings', domain: 'yell.com' }), true);
  });

  test('leaves real businesses alone', () => {
    assert.equal(isDirectory({ name: 'Wandsworth Plumbers Ltd', domain: 'wp.example' }), false);
  });

  test('does not swallow real names that merely contain a directory word', () => {
    // "yell" is only a directory as a whole name — substring matching would exclude
    // a genuine competitor here.
    assert.equal(isDirectory({ name: 'Yellow Brick Plumbing', domain: 'ybp.example' }), false);
    assert.equal(isDirectory({ name: 'Barking Boiler Repairs', domain: 'bbr.example' }), false);
    assert.equal(isDirectory({ name: 'Yell', domain: null }), true);
  });
});

describe('selectCompetitors', () => {
  const world = [
    candidate({ place_id: 'strong', name: 'Wandsworth Plumbers' },
      [['k1', 1], ['k2', 1], ['k3', 2], ['k4', 1], ['k5', 2]]),
    candidate({ place_id: 'medium', name: 'SW Heating' },
      [['k1', 4], ['k2', 3], ['k3', 1]]),
    candidate({ place_id: 'weak', name: 'QuickFix' },
      [['k2', 4]]),
    candidate({ place_id: 'directory', name: 'Checkatrade', domain: 'checkatrade.com' },
      [['k1', 1], ['k2', 1], ['k3', 1], ['k4', 1], ['k5', 1]]),
    candidate({ place_id: 'wrongcat', name: 'Bright Spark', primary_category: 'Electrician' },
      [['k1', 2], ['k2', 2], ['k3', 2]]),
    candidate({ place_id: 'faraway', name: 'Croydon Plumbing', lat: 51.32, lng: -0.05 },
      [['k1', 3], ['k2', 3]]),
  ];

  test('excludes directories however well they rank', () => {
    const { competitors, rejected } = selectCompetitors(SUBJECT, world, 5);
    assert.equal(competitors.some((c) => c.place.place_id === 'directory'), false);
    assert.equal(rejected.find((r) => r.place_id === 'directory')?.reason, 'directory');
  });

  test('excludes a different trade in the same postcode', () => {
    const { rejected } = selectCompetitors(SUBJECT, world, 5);
    assert.equal(rejected.find((r) => r.place_id === 'wrongcat')?.reason, 'category_mismatch');
  });

  test('excludes businesses outside the radius', () => {
    const { rejected } = selectCompetitors(SUBJECT, world, 5);
    assert.equal(rejected.find((r) => r.place_id === 'faraway')?.reason, 'out_of_radius');
  });

  test('excludes the subject itself', () => {
    const withSelf = [...world, candidate({ place_id: 'subject' }, [['k1', 1]])];
    const { rejected } = selectCompetitors(SUBJECT, withSelf, 5);
    assert.equal(rejected.find((r) => r.place_id === 'subject')?.reason, 'is_subject');
  });

  test('ranks by keyword overlap first', () => {
    const { competitors } = selectCompetitors(SUBJECT, world, 5);
    assert.deepEqual(competitors.map((c) => c.place.place_id), ['strong', 'medium', 'weak']);
    assert.ok(competitors[0]!.score > competitors[1]!.score);
  });

  test('caps the set and records what fell below the cut', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      candidate({ place_id: `c${i}` }, [['k1', i + 1]]),
    );
    const { competitors, rejected } = selectCompetitors(SUBJECT, many, 5, { max_competitors: 4 });
    assert.equal(competitors.length, 4);
    assert.equal(rejected.filter((r) => r.reason === 'below_cut').length, 6);
  });

  test('rationale quotes real numbers, not adjectives', () => {
    const { competitors } = selectCompetitors(SUBJECT, world, 5);
    const top = competitors[0]!;
    assert.match(top.rationale, /5 of your 5 money keywords/);
    assert.match(top.rationale, /average position 1\.4/);
    assert.match(top.rationale, /miles away|same location/);
    assert.match(top.rationale, /same primary category \(Plumber\)/);
  });

  test('warns on a thin set instead of failing', () => {
    // A quiet postcode must degrade the report, not kill the scan.
    const { competitors, warnings } = selectCompetitors(SUBJECT, [world[2]!], 5);
    assert.equal(competitors.length, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Only 1 comparable competitor/);
  });

  test('warns when nothing survives', () => {
    const { competitors, warnings } = selectCompetitors(SUBJECT, [], 5);
    assert.equal(competitors.length, 0);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => /competitive sections will be omitted/.test(w)));
  });

  test('breakdown is auditable', () => {
    const { competitors } = selectCompetitors(SUBJECT, world, 5);
    const b = competitors[0]!.breakdown;
    assert.equal(b.keywords_matched, 5);
    assert.equal(b.keywords_total, 5);
    assert.equal(b.keyword_overlap, 1);
    assert.ok(b.distance_km >= 0 && b.distance_km < 1);
  });
});

describe('groupAppearances', () => {
  test('collapses one place appearing across many keywords', () => {
    const p: Place = { ...SUBJECT, place_id: 'x', name: 'X' };
    const grouped = groupAppearances([
      { keyword: 'a', position: 1, place: p },
      { keyword: 'b', position: 3, place: p },
    ]);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0]!.appearances.length, 2);
    assert.deepEqual(grouped[0]!.appearances.map((a) => a.keyword), ['a', 'b']);
  });
});
