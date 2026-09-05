import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CREDENTIALS, MissingCredential, missingCredentials, optional, required } from './config';
import {
  createPlacesProvider,
  domainOf,
  postcodeOf,
  toAttributes,
  toHours,
  toPlace,
  toProfile,
} from './places';
import { mobileFriendly, readVitals } from './pagespeed';
import { toMapPack, toReviews, unwrap } from './dataforseo';
import { matchPlaceId } from './aivis';
import { normaliseGbp } from '../collectors/gbp/normalise';
import { normaliseReviews } from '../collectors/reviews/normalise';

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://example.test',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const stub = (body: unknown) => (async () => response(200, body)) as unknown as typeof fetch;

/** A Places (New) detail response for the fixture plumber. */
const RAW_PLACE = {
  id: 'p_riverside',
  displayName: { text: 'Riverside Plumbing' },
  formattedAddress: '9 River Road, London SW18 4AB, UK',
  addressComponents: [
    { longText: '9', types: ['street_number'] },
    { longText: 'SW18 4AB', shortText: 'SW18 4AB', types: ['postal_code'] },
  ],
  location: { latitude: 51.4571, longitude: -0.1911 },
  websiteUri: 'https://www.riversideplumbing.example/',
  nationalPhoneNumber: '020 8000 2222',
  businessStatus: 'OPERATIONAL',
  primaryTypeDisplayName: { text: 'Plumber' },
  types: ['plumber', 'point_of_interest'],
  rating: 4.1,
  userRatingCount: 23,
  photos: [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
  regularOpeningHours: {
    periods: [
      { open: { day: 1, hour: 8, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } },
      { open: { day: 2, hour: 8, minute: 30 }, close: { day: 2, hour: 17, minute: 0 } },
    ],
  },
  accessibilityOptions: { wheelchairAccessibleEntrance: true, wheelchairAccessibleParking: false },
  paymentOptions: { acceptsCreditCards: true },
  delivery: false,
  reservable: true,
};

describe('credentials', () => {
  test('a missing key fails with the variable name and what it is for', () => {
    assert.throws(
      () => required({}, 'GOOGLE_PLACES_API_KEY', 'business listings'),
      (error: unknown) =>
        error instanceof MissingCredential &&
        error.variable === 'GOOGLE_PLACES_API_KEY' &&
        /business listings/.test(error.message),
    );
  });

  test('an empty string is as missing as an unset variable', () => {
    assert.throws(() => required({ K: '   ' }, 'K', 'x'), MissingCredential);
    assert.equal(optional({ K: '  ' }, 'K'), undefined);
  });

  test('values are trimmed — a trailing newline in a key is the classic .env mistake', () => {
    assert.equal(required({ K: 'secret\n' }, 'K', 'x'), 'secret');
  });

  test('.env.example documents every variable the code reads', () => {
    // The same discipline check:taxonomy applies to finding codes: a credential added in
    // config.ts and forgotten in .env.example is a scan that fails on someone else's
    // machine for a reason nothing explains.
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const credential of CREDENTIALS) {
      assert.ok(
        example.includes(`${credential.variable}=`),
        `${credential.variable} is read by config.ts but missing from .env.example`,
      );
    }
  });

  test('.env.example carries no actual values', () => {
    const example = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    for (const line of example.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') continue;
      assert.match(line, /=$/, `"${line}" looks like it has a value committed to it`);
    }
  });

  test('reports every required key that is missing, not just the first', () => {
    const missing = missingCredentials({ GOOGLE_PLACES_API_KEY: 'k' });
    assert.ok(missing.includes('DATAFORSEO_LOGIN'));
    assert.ok(missing.includes('ANTHROPIC_API_KEY'));
    assert.equal(missing.includes('GOOGLE_PLACES_API_KEY'), false);
    // Optional providers are not required to run a scan.
    assert.equal(missing.includes('OPENAI_API_KEY'), false);
  });
});

describe('Places to Place', () => {
  test('maps identification fields', () => {
    const place = toPlace(RAW_PLACE)!;
    assert.equal(place.place_id, 'p_riverside');
    assert.equal(place.name, 'Riverside Plumbing');
    assert.equal(place.primary_category, 'Plumber');
    assert.equal(place.lat, 51.4571);
    assert.equal(place.postcode, 'SW18 4AB');
  });

  test('strips protocol and www from the domain, matching how resolve uses it', () => {
    assert.equal(domainOf('https://www.riversideplumbing.example/'), 'riversideplumbing.example');
    assert.equal(domainOf('http://EXAMPLE.test/path'), 'example.test');
    assert.equal(domainOf(undefined), null);
    assert.equal(domainOf('not a url'), null);
  });

  test('finds the postcode among the address components', () => {
    assert.equal(postcodeOf(RAW_PLACE), 'SW18 4AB');
    assert.equal(postcodeOf({ addressComponents: [{ longText: '9', types: ['street_number'] }] }), null);
  });

  test('a response with no id is no place, rather than a place with an empty id', () => {
    assert.equal(toPlace({ displayName: { text: 'Ghost' } }), null);
  });
});

describe('Places to GbpProfile', () => {
  const profile = toProfile(RAW_PLACE, '2026-09-04T12:00:00.000Z')!;

  test('maps what the collector measures', () => {
    assert.equal(profile.photo_count, 3);
    assert.equal(profile.review_count, 23);
    assert.equal(profile.rating, 4.1);
    assert.equal(profile.business_status, 'OPERATIONAL');
  });

  test('reports two of seven days, which is what GBP_HOURS_INCOMPLETE counts', () => {
    assert.equal(profile.regular_hours?.length, 2);
    assert.deepEqual(profile.regular_hours?.[1], { day: 2, open: '08:30', close: '17:00' });
  });

  test('leaves holiday hours unknown rather than reporting none set', () => {
    // Places (New) does not expose them. `null` means unknown; `[]` would mean "none",
    // which would put a finding in a paid report on no evidence.
    assert.equal(profile.special_days, null);
  });

  test('leaves every warm-only field undefined', () => {
    // The cold/warm split the collector rests on.
    assert.equal(profile.claimed, undefined);
    assert.equal(profile.services, undefined);
    assert.equal(profile.last_post_at, undefined);
    assert.equal(profile.unanswered_questions, undefined);
  });

  test('a cold profile produces no warm-only findings', () => {
    const seeds = normaliseGbp(profile, { now: new Date('2026-09-04T12:00:00.000Z'), role: 'subject' });
    const codes = seeds.map((s) => s.code);
    assert.equal(codes.includes('GBP_UNCLAIMED'), false);
    assert.equal(codes.includes('GBP_NO_SERVICES_LISTED'), false);
    // But the cold ones still land.
    assert.ok(codes.includes('GBP_HOURS_INCOMPLETE'));
    assert.ok(codes.includes('GBP_PHOTOS_SPARSE'));
  });

  test('flattens attribute groups and keeps false values as set-but-false', () => {
    const attributes = toAttributes(RAW_PLACE);
    assert.equal(attributes['accessibility.wheelchairAccessibleEntrance'], true);
    assert.equal(attributes['accessibility.wheelchairAccessibleParking'], false);
    assert.equal(attributes['payment.acceptsCreditCards'], true);
    assert.equal(attributes.reservable, true);
  });

  test('a group Places did not return contributes nothing, not a row of false', () => {
    const attributes = toAttributes({ id: 'x' });
    assert.deepEqual(attributes, {});
  });

  test('hours are unknown when the listing declares none', () => {
    assert.equal(toHours({ id: 'x' }), null);
  });
});

describe('finding a business by domain', () => {
  test('confirms the result actually owns the domain', async () => {
    // Places has no domain lookup, so the query is the domain. Without the check, a search
    // for "example.com" returns whatever ranks for the words in it.
    const provider = createPlacesProvider({
      apiKey: 'k',
      fetchImpl: stub({
        places: [
          { id: 'p_wrong', displayName: { text: 'Someone Else' }, websiteUri: 'https://other.test' },
          { ...RAW_PLACE },
        ],
      }),
    });

    const { value } = await provider.findByDomain('riversideplumbing.example');
    assert.equal(value?.place_id, 'p_riverside');
  });

  test('returns nothing when no result owns it', async () => {
    const provider = createPlacesProvider({
      apiKey: 'k',
      fetchImpl: stub({
        places: [{ id: 'p_wrong', displayName: { text: 'X' }, websiteUri: 'https://other.test' }],
      }),
    });
    const { value } = await provider.findByDomain('riversideplumbing.example');
    assert.equal(value, null);
  });

  test('reports what the call cost', async () => {
    const provider = createPlacesProvider({ apiKey: 'k', fetchImpl: stub({ places: [] }) });
    const { cost } = await provider.findByName('Riverside Plumbing', 'SW18 4AB');
    assert.equal(cost.pence, 3);
  });
});

describe('PageSpeed to vitals', () => {
  test('prefers field data — what real visitors experienced', () => {
    const vitals = readVitals(
      {
        loadingExperience: {
          metrics: {
            LARGEST_CONTENTFUL_PAINT_MS: { percentile: 6200 },
            CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 41 },
            INTERACTION_TO_NEXT_PAINT: { percentile: 720 },
          },
        },
      },
      'mobile',
      'https://pagespeed.test',
    );

    assert.equal(vitals.lcp_seconds, 6.2);
    // CrUX scales CLS by 100. Reading 41 as 41 would put every site two orders of
    // magnitude into the red.
    assert.equal(vitals.cls, 0.41);
    assert.equal(vitals.inp_ms, 720);
  });

  test('falls back to lab data, which is the usual case for a local business', () => {
    // A plumber in Wandsworth has too little traffic to be in CrUX at all.
    const vitals = readVitals(
      {
        lighthouseResult: {
          audits: {
            'largest-contentful-paint': { numericValue: 5100 },
            'cumulative-layout-shift': { numericValue: 0.32 },
          },
        },
      },
      'mobile',
      'https://pagespeed.test',
    );

    assert.equal(vitals.lcp_seconds, 5.1);
    assert.equal(vitals.cls, 0.32);
  });

  test('INP is null without field data rather than a lab proxy in disguise', () => {
    // There is no lab INP. Substituting total-blocking-time would be an estimate wearing
    // a verified label, which is the one thing rule 4 forbids.
    const vitals = readVitals(
      { lighthouseResult: { audits: { 'largest-contentful-paint': { numericValue: 5100 } } } },
      'mobile',
      'https://pagespeed.test',
    );
    assert.equal(vitals.inp_ms, null);
  });

  test('an empty response yields nulls, and no findings follow from it', () => {
    const vitals = readVitals({}, 'mobile', 'https://pagespeed.test');
    assert.deepEqual(
      [vitals.lcp_seconds, vitals.cls, vitals.inp_ms, vitals.mobile_friendly],
      [null, null, null, null],
    );
  });

  test('mobile friendliness comes from the viewport and content-width audits', () => {
    assert.equal(mobileFriendly({ viewport: { score: 1 }, 'content-width': { score: 1 } }), true);
    assert.equal(mobileFriendly({ viewport: { score: 0 }, 'content-width': { score: 1 } }), false);
    assert.equal(mobileFriendly({ 'content-width': { score: 0 } }), false);
  });

  test('both audits absent means unknown, not unfriendly', () => {
    assert.equal(mobileFriendly({}), null);
  });
});

describe('DataForSEO envelopes', () => {
  test('reads a success', () => {
    const { id, result } = unwrap({ tasks: [{ id: 't1', status_code: 20000, result: [{ x: 1 }] }] }, 'x');
    assert.equal(id, 't1');
    assert.deepEqual(result, [{ x: 1 }]);
  });

  test('treats "task queued" as accepted rather than failed', () => {
    const { result } = unwrap({ tasks: [{ id: 't1', status_code: 20100, result: null }] }, 'x');
    assert.equal(result, null);
  });

  test('a failure in the body is a failure, even though the HTTP status was 200', () => {
    assert.throws(
      () => unwrap({ tasks: [{ status_code: 40501, status_message: 'Invalid Field' }] }, 'map pack'),
      /40501/,
    );
  });

  test('no task at all is an error rather than an empty result', () => {
    assert.throws(() => unwrap({ tasks: [] }, 'map pack'), /no task/);
  });
});

describe('DataForSEO to map pack', () => {
  test('keeps map results and drops everything else in the response', () => {
    const pack = toMapPack([
      { type: 'maps_search', rank_absolute: 1, title: 'Wandsworth Plumbers Ltd', place_id: 'p_w' },
      { type: 'local_pack_ad', rank_absolute: 2, title: 'An advert', place_id: 'p_ad' },
      { type: 'maps_search', rank_absolute: 3, title: 'Riverside Plumbing', cid: 'c_r' },
    ]);

    assert.equal(pack.length, 2);
    assert.deepEqual(pack[1], { place_id: 'c_r', name: 'Riverside Plumbing', position: 3 });
  });

  test('falls back to arrival order rather than making everything position zero', () => {
    const pack = toMapPack([{ type: 'maps_search', title: 'A', place_id: 'p_a' }]);
    assert.equal(pack[0]!.position, 1);
  });

  test('an item with no identifier is dropped — an unmatchable place is not a competitor', () => {
    assert.deepEqual(toMapPack([{ type: 'maps_search', title: 'Nameless' }]), []);
  });
});

describe('DataForSEO to reviews', () => {
  const items = [
    {
      review_id: 'r1',
      rating: { value: 5 },
      timestamp: '2026-08-01 10:00:00 +00:00',
      review_text: 'Great',
      profile_name: 'Ann',
      owner_answer: 'Thanks!',
      owner_timestamp: '2026-08-02 09:00:00 +00:00',
    },
    {
      review_id: 'r2',
      rating: { value: 2 },
      timestamp: '2026-07-01 10:00:00 +00:00',
      review_text: 'Never turned up',
      profile_name: 'Bob',
      owner_answer: null,
      owner_timestamp: null,
    },
  ];

  test('an unanswered review is null, not undefined — this source can see replies', () => {
    // The distinction the whole reviews collector rests on. Undefined would mean "the
    // source cannot see replies" and would switch off the reply findings entirely.
    const reviews = toReviews(items);
    assert.equal(reviews[0]!.replied_at, '2026-08-02T09:00:00.000Z');
    assert.equal(reviews[1]!.replied_at, null);
  });

  test('so a full history supports the reply findings', () => {
    const capture = {
      place_id: 'p_riverside',
      rating: 3.5,
      review_count: 2,
      reviews: toReviews(items),
      coverage: 'complete' as const,
      captured_at: '2026-09-04T12:00:00.000Z',
    };
    const seeds = normaliseReviews(capture, {
      now: new Date('2026-09-04T12:00:00.000Z'),
      role: 'subject',
    });
    const codes = seeds.map((s) => s.code);

    // Bob's two-star review has no reply, and this source can see that it has no reply.
    assert.ok(codes.includes('REVIEW_RESPONSE_ABSENT_NEGATIVE'));
    assert.equal(seeds.find((s) => s.code === 'REVIEW_RESPONSE_ABSENT_NEGATIVE')!.measured_value, 1);
  });

  test('the timestamps parse, so recency is measured rather than guessed', () => {
    const capture = {
      place_id: 'p_riverside',
      rating: 3.5,
      review_count: 2,
      reviews: toReviews(items),
      coverage: 'complete' as const,
      captured_at: '2026-09-04T12:00:00.000Z',
    };
    // Newest review is 2026-08-01 — 34 days old, inside the 90-day threshold.
    const codes = normaliseReviews(capture, {
      now: new Date('2026-09-04T12:00:00.000Z'),
      role: 'subject',
    }).map((s) => s.code);
    assert.equal(codes.includes('REVIEW_RECENCY_STALE'), false);

    // Six months later, the same capture is stale.
    const later = normaliseReviews(capture, {
      now: new Date('2027-03-04T12:00:00.000Z'),
      role: 'subject',
    }).find((s) => s.code === 'REVIEW_RECENCY_STALE');
    assert.equal(later?.measured_value, 215);
  });

  test('drops a row with no date or no rating rather than inventing one', () => {
    assert.deepEqual(toReviews([{ review_id: 'x', review_text: 'hi' }]), []);
  });
});

describe('matching a model citation to a scan target', () => {
  const roster = [
    { place_id: 'p_wandsworth', name: 'Wandsworth Plumbers Ltd' },
    { place_id: 'p_riverside', name: 'Riverside Plumbing' },
  ];

  test('models rarely write the legal name', () => {
    assert.equal(matchPlaceId('Wandsworth Plumbers', roster), 'p_wandsworth');
    assert.equal(matchPlaceId('wandsworth plumbers ltd.', roster), 'p_wandsworth');
    assert.equal(matchPlaceId('Riverside Plumbing', roster), 'p_riverside');
  });

  test('a business outside the scan matches nothing rather than the nearest name', () => {
    assert.equal(matchPlaceId('Thames Valley Plumbing', roster), null);
  });

  test('an empty name matches nothing', () => {
    assert.equal(matchPlaceId('   ', roster), null);
  });

  test('aliases are honoured', () => {
    assert.equal(
      matchPlaceId('SW Heating', [{ place_id: 'p_sw', name: 'SW Heating & Plumbing', aliases: ['SW Heating'] }]),
      'p_sw',
    );
  });
});
