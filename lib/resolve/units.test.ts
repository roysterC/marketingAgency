import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { distanceKm, kmToMiles } from './geo';
import { toOutwardCode, toPostcodeArea } from './region';
import { detectPlatform, isEcommercePlatform } from './platform';
import { isComparableCategory, toVertical, verticalFamily } from './vertical';

describe('region', () => {
  test('extracts the outward code from a full postcode', () => {
    assert.equal(toOutwardCode('SW18 4AB'), 'SW18');
    assert.equal(toOutwardCode('EC1A 1BB'), 'EC1A');
    assert.equal(toOutwardCode('M1 1AE'), 'M1');
  });

  test('normalises spacing and case', () => {
    assert.equal(toOutwardCode('sw18 4ab'), 'SW18');
    assert.equal(toOutwardCode('  SW184AB '), 'SW18');
    assert.equal(toOutwardCode('SW18   4AB'), 'SW18');
  });

  test('accepts an outward code on its own', () => {
    assert.equal(toOutwardCode('SW18'), 'SW18');
    assert.equal(toOutwardCode('cr0'), 'CR0');
  });

  test('returns null rather than guessing', () => {
    // A wrong region silently poisons the benchmark table, so no fuzzy matching.
    assert.equal(toOutwardCode('not a postcode'), null);
    assert.equal(toOutwardCode(''), null);
    assert.equal(toOutwardCode(null), null);
    assert.equal(toOutwardCode('90210'), null);
  });

  test('derives the postcode area', () => {
    assert.equal(toPostcodeArea('SW18 4AB'), 'SW');
    assert.equal(toPostcodeArea('M1 1AE'), 'M');
    assert.equal(toPostcodeArea('rubbish'), null);
  });
});

describe('platform', () => {
  const page = (html: string, headers: Record<string, string> = {}) => ({ html, headers });

  test('detects by markup', () => {
    assert.equal(detectPlatform(page('<script src="https://cdn.shopify.com/x.js">')), 'shopify');
    assert.equal(detectPlatform(page('<link href="/wp-content/themes/a.css">')), 'wordpress');
    assert.equal(detectPlatform(page('<div class="squarespace-cdn">')), 'squarespace');
  });

  test('detects Shopify by header when markup is opaque', () => {
    assert.equal(detectPlatform(page('<html></html>', { 'x-shopid': '123' })), 'shopify');
  });

  test('prefers WooCommerce over WordPress', () => {
    // Woo sites are WordPress sites. Matching WordPress first would mean the store
    // collectors never run against a Woo store.
    const woo = page('<link href="/wp-content/plugins/woocommerce/style.css">');
    assert.equal(detectPlatform(woo), 'woocommerce');
  });

  test('falls back to custom', () => {
    assert.equal(detectPlatform(page('<html><body>hand rolled</body></html>')), 'custom');
  });

  test('knows which platforms are stores', () => {
    assert.equal(isEcommercePlatform('shopify'), true);
    assert.equal(isEcommercePlatform('woocommerce'), true);
    assert.equal(isEcommercePlatform('wordpress'), false);
    assert.equal(isEcommercePlatform('custom'), false);
  });
});

describe('vertical', () => {
  test('maps known categories', () => {
    assert.equal(toVertical('Plumber'), 'trades.plumbing');
    assert.equal(toVertical('plumber'), 'trades.plumbing');
    assert.equal(toVertical('Electrician'), 'trades.electrical');
    assert.equal(toVertical('Dentist'), 'clinic.dental');
  });

  test('gives unmapped categories a stable path so they still group', () => {
    assert.equal(toVertical('Alpaca Farm'), 'other.alpaca_farm');
    assert.equal(toVertical('Alpaca  Farm!'), 'other.alpaca_farm');
  });

  test('returns null only when there is no category', () => {
    assert.equal(toVertical(null), null);
    assert.equal(toVertical(''), null);
  });

  test('extracts the family', () => {
    assert.equal(verticalFamily('trades.plumbing'), 'trades');
    assert.equal(verticalFamily(null), null);
  });

  test('only the same vertical counts as comparable', () => {
    assert.equal(isComparableCategory('trades.plumbing', 'trades.plumbing'), true);
    // Same postcode, different job. Mixing them makes every benchmark noise.
    assert.equal(isComparableCategory('trades.plumbing', 'trades.electrical'), false);
    assert.equal(isComparableCategory(null, 'trades.plumbing'), false);
  });
});

describe('geo', () => {
  test('measures a known distance', () => {
    // Wandsworth to Croydon, roughly 18 km.
    const d = distanceKm({ lat: 51.4571, lng: -0.1911 }, { lat: 51.32, lng: -0.05 });
    assert.ok(d > 16 && d < 20, `expected ~18km, got ${d.toFixed(2)}`);
  });

  test('is zero for the same point', () => {
    assert.equal(distanceKm({ lat: 51.4, lng: -0.1 }, { lat: 51.4, lng: -0.1 }), 0);
  });

  test('converts to miles', () => {
    assert.ok(Math.abs(kmToMiles(1.60934) - 1) < 0.001);
  });
});
