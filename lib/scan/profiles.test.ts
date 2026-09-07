import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, PROFILE_NAMES, profileByName, runsCollector } from './profiles';

describe('scan profiles', () => {
  test('hook drops the expensive collectors', () => {
    // reviews was the single most expensive collector on the first live scan at 25p, and
    // full review history is audit depth rather than a hook.
    assert.equal(runsCollector(PROFILES.hook, 'reviews'), false);
    assert.equal(runsCollector(PROFILES.hook, 'sitetech'), false);
    assert.equal(runsCollector(PROFILES.hook, 'localrank'), false);
  });

  test('hook keeps what produces the finding that gets a reply', () => {
    // The first live scan's report was carried by AIVIS_NOT_CITED and
    // AIVIS_COMPETITOR_CITED. gbp stays because aivis checks model claims against it.
    assert.equal(runsCollector(PROFILES.hook, 'aivis'), true);
    assert.equal(runsCollector(PROFILES.hook, 'gbp'), true);
  });

  test('full runs everything', () => {
    for (const collector of ['gbp', 'reviews', 'sitetech', 'localrank', 'aivis'] as const) {
      assert.equal(runsCollector(PROFILES.full, collector), true, collector);
    }
  });

  test('hook buys fewer competitors and fewer lookups', () => {
    assert.ok(PROFILES.hook.maxCompetitors < PROFILES.full.maxCompetitors);
    assert.ok(PROFILES.hook.enrichLimit < PROFILES.full.enrichLimit);
  });

  test('hook renders the one-pager only', () => {
    assert.deepEqual(PROFILES.hook.variants, ['onepager']);
    assert.ok(PROFILES.full.variants.includes('full'));
  });

  test('full is strictly a superset of hook', () => {
    for (const collector of PROFILES.hook.collectors) {
      assert.ok(PROFILES.full.collectors.includes(collector), collector);
    }
  });

  test('lookup by name, and a clear error for anything else', () => {
    for (const name of PROFILE_NAMES) {
      assert.equal(profileByName(name).name, name);
    }
    assert.throws(() => profileByName('cheap'), /Unknown scan profile "cheap"/);
    assert.throws(() => profileByName('cheap'), /hook, full/);
  });
});
