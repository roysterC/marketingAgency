import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { canQuoteBenchmark, quartileOf, type Percentiles } from './benchmark';

/** A solid benchmark: low numbers, plenty of samples. */
const solid: Percentiles = { p25: 1, p50: 2, p75: 4, sample_size: 50 };

describe('canQuoteBenchmark', () => {
  test('requires enough samples', () => {
    assert.equal(canQuoteBenchmark(solid), true);
    assert.equal(canQuoteBenchmark({ ...solid, sample_size: 19 }), false);
    assert.equal(canQuoteBenchmark({ ...solid, sample_size: 20 }), true);
  });

  test('requires all three percentiles', () => {
    assert.equal(canQuoteBenchmark({ ...solid, p50: null }), false);
  });
});

describe('quartileOf', () => {
  test('higher_better: more is better', () => {
    // REVIEW_VELOCITY_LOW is per_month, higher_better.
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 5, solid), 'top');
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 3, solid), 'upper_mid');
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 1.5, solid), 'lower_mid');
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 0.4, solid), 'bottom');
  });

  test('lower_better: less is better', () => {
    // STL_FORM_SLOW_REPLY is hours, lower_better. Same numbers, opposite verdicts —
    // this is the whole reason polarity exists.
    assert.equal(quartileOf('STL_FORM_SLOW_REPLY', 0.4, solid), 'top');
    assert.equal(quartileOf('STL_FORM_SLOW_REPLY', 1.5, solid), 'upper_mid');
    assert.equal(quartileOf('STL_FORM_SLOW_REPLY', 3, solid), 'lower_mid');
    assert.equal(quartileOf('STL_FORM_SLOW_REPLY', 31, solid), 'bottom');
  });

  test('the same value lands in opposite quartiles depending on polarity', () => {
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 0.4, solid), 'bottom');
    assert.equal(quartileOf('STL_FORM_SLOW_REPLY', 0.4, solid), 'top');
  });

  test('refuses to guess on a thin benchmark', () => {
    const thin: Percentiles = { ...solid, sample_size: 4 };
    assert.equal(quartileOf('REVIEW_VELOCITY_LOW', 5, thin), 'unknown');
  });

  test('returns unknown for findings with nothing to measure', () => {
    // GBP_MISSING is binary — there is no percentile of "absent".
    assert.equal(quartileOf('GBP_MISSING', 1, solid), 'unknown');
  });
});
