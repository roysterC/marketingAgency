import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FINDINGS, type FindingCode } from '../../taxonomy/findings';
import { expandSeed, type NormaliseContext, type PeerStats } from '../types';
import {
  SPEEDTOLEAD_EMITS,
  createSpeedToLeadCollector,
  dispatchEnquiry,
  speedToLeadPeerStats,
} from './index';
import { UnethicalEnquiryError, assertGenuineEnquiry, isGenuineEnquiry } from './ethics';
import {
  PEER_KEYS,
  RESPONSE_WINDOW_HOURS,
  SLOW_REPLY_HOURS,
  normaliseSpeedToLead,
  responseHours,
  windowClosed,
} from './normalise';
import { GENUINE_ENQUIRY, REFUSED_ENQUIRIES, deadProbe, fixtureProbe } from './fixtures';
import type { SpeedToLeadCapture } from './types';

/** The moment the enquiry goes out. Spec §4's example is a Tuesday at 10:14. */
const SENT_AT = new Date('2026-09-04T10:14:00.000Z');
/** After the 48-hour window has shut. */
const AFTER_WINDOW = new Date('2026-09-06T12:00:00.000Z');
/** Twenty minutes later — the test is still running. */
const STILL_WAITING = new Date('2026-09-04T10:34:00.000Z');

const target = (placeId: string, domain: string | null, phone: string | null = '+442080002222') => ({
  target_id: `t_${placeId}`,
  role: 'subject' as const,
  place: {
    place_id: placeId,
    name: placeId,
    primary_category: 'Plumber',
    lat: 51.4571,
    lng: -0.1911,
    domain,
    postcode: 'SW18 4AB',
    phone,
  },
});

const codes = (seeds: { code: FindingCode }[]): FindingCode[] => seeds.map((s) => s.code);

/** Collect the subject and its competitor set through one collector, as a scan would. */
async function runScan() {
  const probe = fixtureProbe(SENT_AT);
  const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
  const hosts: Array<[string, string]> = [
    ['p_riverside', 'riversideplumbing.example'],
    ['p_wandsworth', 'wandsworthplumbers.example'],
    ['p_swheating', 'swheating.example'],
    ['p_quickfix', 'quickfix.example'],
  ];

  const captures: Record<string, SpeedToLeadCapture> = {};
  for (const [id, host] of hosts) {
    const { value } = await collector.collect(target(id, host), { mode: 'cold' });
    captures[id] = value!;
  }
  return { probe, collector, captures };
}

const { probe: scanProbe, collector: scanCollector, captures } = await runScan();

const peers = speedToLeadPeerStats([
  captures.p_wandsworth!,
  captures.p_swheating!,
  captures.p_quickfix!,
]);

const ctx = (over: Partial<NormaliseContext> = {}): NormaliseContext => ({
  now: AFTER_WINDOW,
  role: 'subject',
  segment: 'smb',
  peers,
  ...over,
});

describe('speedtolead contract', () => {
  test('every declared code really belongs to this collector', () => {
    for (const code of SPEEDTOLEAD_EMITS) {
      assert.equal(FINDINGS[code].collector, 'speedtolead', code);
    }
  });

  test('declares every speedtolead code in the registry', () => {
    const registry = Object.keys(FINDINGS).filter(
      (c) => FINDINGS[c as FindingCode].collector === 'speedtolead',
    );
    assert.deepEqual([...SPEEDTOLEAD_EMITS].sort(), registry.sort());
  });

  test('every code is verified by construction — we measured it', () => {
    for (const code of SPEEDTOLEAD_EMITS) {
      assert.equal(FINDINGS[code].confidence, 'verified', code);
    }
  });
});

describe('the ethical line', () => {
  test('a genuine, identified enquiry is accepted', () => {
    assert.equal(isGenuineEnquiry(GENUINE_ENQUIRY), true);
    assert.doesNotThrow(() => assertGenuineEnquiry(GENUINE_ENQUIRY));
  });

  for (const { why, enquiry } of REFUSED_ENQUIRIES) {
    test(`refuses an enquiry that is ${why}`, () => {
      assert.throws(() => assertGenuineEnquiry(enquiry), UnethicalEnquiryError);
    });
  }

  test('a fabricated job is refused even though it would measure identically', () => {
    // This is the whole reason the guard exists: the timestamps from a fake lead and a
    // mystery shop are the same numbers, so nothing downstream could ever catch it.
    const fabricated = {
      ...GENUINE_ENQUIRY,
      question: 'Can you come out on Tuesday to look at my boiler?',
    };
    assert.throws(() => assertGenuineEnquiry(fabricated), UnethicalEnquiryError);
  });

  test('nothing is sent when the enquiry is refused', async () => {
    const probe = fixtureProbe(SENT_AT);
    await assert.rejects(
      () => dispatchEnquiry(probe, 'riversideplumbing.example', REFUSED_ENQUIRIES[0]!.enquiry),
      UnethicalEnquiryError,
    );
    // The guard runs before the probe, not after it.
    assert.equal(probe.submitted().length, 0);
  });

  test('the collector refuses to exist with a bad enquiry, before any business is touched', () => {
    const probe = fixtureProbe(SENT_AT);
    assert.throws(
      () => createSpeedToLeadCollector(probe, REFUSED_ENQUIRIES[0]!.enquiry),
      UnethicalEnquiryError,
    );
    assert.equal(probe.submitted().length, 0);
  });

  test('what actually went out is the enquiry we vetted', () => {
    for (const sent of scanProbe.submitted()) {
      assert.equal(sent.enquiry.identity.from_name, GENUINE_ENQUIRY.identity.from_name);
      assert.equal(sent.enquiry.identity.reply_to, GENUINE_ENQUIRY.identity.reply_to);
      assert.ok(sent.enquiry.identity.disclosure.length > 0);
      assert.ok(sent.enquiry.question.includes('?'));
    }
  });
});

describe('one test per business', () => {
  test('re-collecting polls the inbox without writing to anyone again', async () => {
    const before = scanProbe.submitted().length;
    const { value } = await scanCollector.collect(
      target('p_riverside', 'riversideplumbing.example'),
      { mode: 'cold' },
    );

    assert.equal(scanProbe.submitted().length, before);
    // The original submission is still the one being measured.
    assert.equal(value?.submission?.id, captures.p_riverside!.submission?.id);
    assert.equal(responseHours(value!), 31);
  });

  test('each business in the scan was contacted exactly once', () => {
    const urls = scanProbe.submitted().map((s) => s.url);
    assert.equal(new Set(urls).size, urls.length);
  });

  test('a business with a broken form is never written to', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_broken', 'brokenform.example'), {
      mode: 'cold',
    });

    assert.equal(value?.submission, null);
    assert.equal(probe.submitted().length, 0);
    assert.deepEqual(codes(collector.normalise(value, ctx())), ['STL_FORM_BROKEN']);
  });

  test('a business with no form is never written to', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_noform', 'noform.example'), {
      mode: 'cold',
    });

    assert.equal(probe.submitted().length, 0);
    assert.deepEqual(codes(collector.normalise(value, ctx())).sort(), [
      'STL_NO_FORM_ON_SITE',
      'STL_NO_PHONE_VISIBLE_MOBILE',
    ]);
  });
});

describe('silence is only a finding once the window shuts', () => {
  async function silent() {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_silent', 'silent.example'), {
      mode: 'cold',
    });
    return value!;
  }

  test('twenty minutes after writing, there is nothing to report', async () => {
    const capture = await silent();
    assert.equal(windowClosed(capture, STILL_WAITING), false);
    // Reporting here would be reporting our own impatience as their failure.
    assert.deepEqual(normaliseSpeedToLead(capture, ctx({ now: STILL_WAITING })), []);
  });

  test('after 48 hours the same silence is the finding', async () => {
    const capture = await silent();
    assert.equal(windowClosed(capture, AFTER_WINDOW), true);
    const seeds = normaliseSpeedToLead(capture, ctx());
    assert.equal(codes(seeds).includes('STL_FORM_NO_REPLY'), true);

    const noReply = seeds.find((s) => s.code === 'STL_FORM_NO_REPLY')!;
    assert.equal(noReply.evidence.responded_at, null);
    assert.equal(noReply.evidence.window_hours, RESPONSE_WINDOW_HOURS);
    assert.equal(noReply.evidence.submitted_at, SENT_AT.toISOString());
  });

  test('a business never written to has no window and never gets a no-reply', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_noform', 'noform.example'), {
      mode: 'cold',
    });

    assert.equal(value?.window_closes_at, null);
    assert.equal(windowClosed(value!, AFTER_WINDOW), false);
    assert.equal(codes(collector.normalise(value, ctx())).includes('STL_FORM_NO_REPLY'), false);
  });
});

describe('normaliseSpeedToLead — the business losing the leads', () => {
  const seeds = normaliseSpeedToLead(captures.p_riverside!, ctx());

  test('reports the slow reply, the gap, and the missing mobile number', () => {
    assert.deepEqual(codes(seeds).sort(), [
      'STL_COMPETITOR_FASTER',
      'STL_FORM_SLOW_REPLY',
      'STL_NO_PHONE_VISIBLE_MOBILE',
    ]);
  });

  test('measures the reply rather than characterising it', () => {
    const slow = seeds.find((s) => s.code === 'STL_FORM_SLOW_REPLY')!;
    assert.equal(slow.measured_value, 31);
    assert.equal(slow.measured_text, '31 hours to reply');
    assert.equal(slow.benchmark_value, SLOW_REPLY_HOURS);
    assert.equal(slow.evidence.submitted_at, SENT_AT.toISOString());
    assert.equal(slow.evidence.responded_at, '2026-09-05T17:14:00.000Z');
  });

  test('carries the line the report is built around', () => {
    const faster = seeds.find((s) => s.code === 'STL_COMPETITOR_FASTER')!;
    assert.equal(faster.measured_value, 31);
    assert.equal(faster.benchmark_value, 0.07);
    assert.equal(faster.benchmark_source, 'competitor_best');
    assert.equal(faster.measured_text, '31 hours against a competitor best of 0.07');
  });

  test('quotes the reply, so the report shows it rather than asserting it', () => {
    const slow = seeds.find((s) => s.code === 'STL_FORM_SLOW_REPLY')!;
    assert.ok(String(slow.evidence.excerpt).length > 0);
  });
});

describe('normaliseSpeedToLead — the business answering in four minutes', () => {
  test('produces nothing against its own competitor set', () => {
    const ownPeers = speedToLeadPeerStats([
      captures.p_swheating!,
      captures.p_quickfix!,
      captures.p_riverside!,
    ]);
    assert.deepEqual(normaliseSpeedToLead(captures.p_wandsworth!, ctx({ peers: ownPeers })), []);
  });

  test('replying inside the threshold is not a finding', () => {
    const noPeers: NormaliseContext = { now: AFTER_WINDOW, role: 'subject', segment: 'smb' };
    assert.equal(responseHours(captures.p_quickfix!), 0.5);
    assert.ok(0.5 < SLOW_REPLY_HOURS);
    assert.equal(codes(normaliseSpeedToLead(captures.p_quickfix!, noPeers)).length, 0);
  });
});

describe('competitor comparison', () => {
  test('a no-reply is still beaten by a competitor who answered', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_silent', 'silent.example'), {
      mode: 'cold',
    });
    const seeds = normaliseSpeedToLead(value, ctx());
    const faster = seeds.find((s) => s.code === 'STL_COMPETITOR_FASTER')!;

    // No measurable response time, so nothing goes into the benchmark — but the claim
    // still holds and the report can still make it.
    assert.equal(faster.measured_value, null);
    assert.equal(faster.benchmark_value, 0.07);
    assert.equal(
      faster.measured_text,
      `no reply in ${RESPONSE_WINDOW_HOURS} hours against a competitor best of 0.07`,
    );
  });

  test('a marginally faster competitor is not a finding', () => {
    // 31 hours against a competitor best of 30 is not a gap a customer would feel.
    const marginal: PeerStats = { median: {}, best: { [PEER_KEYS.response_hours]: 30 } };
    assert.equal(
      codes(normaliseSpeedToLead(captures.p_riverside!, ctx({ peers: marginal }))).includes(
        'STL_COMPETITOR_FASTER',
      ),
      false,
    );
  });

  test('minutes apart at the fast end is not a finding either', () => {
    // 4 minutes against 2 is twice as fast but half a minute of real difference.
    const twiceAsFast: PeerStats = { median: {}, best: { [PEER_KEYS.response_hours]: 0.03 } };
    assert.equal(
      codes(normaliseSpeedToLead(captures.p_wandsworth!, ctx({ peers: twiceAsFast }))).includes(
        'STL_COMPETITOR_FASTER',
      ),
      false,
    );
  });

  test('a pending test is not compared to anyone', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_silent', 'silent.example'), {
      mode: 'cold',
    });
    assert.deepEqual(normaliseSpeedToLead(value, ctx({ now: STILL_WAITING })), []);
  });
});

describe('peer stats respect polarity', () => {
  test('the best response time is the lowest number', () => {
    assert.equal(peers.best[PEER_KEYS.response_hours], 0.07);
    assert.equal(peers.median[PEER_KEYS.response_hours], 0.5);
    assert.equal(FINDINGS.STL_COMPETITOR_FASTER.polarity, 'lower_better');
  });

  test('a competitor who never replied contributes nothing rather than a zero', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_silent', 'silent.example'), {
      mode: 'cold',
    });

    // We know their time exceeded the window; we do not know what it was.
    const stats = speedToLeadPeerStats([value!]);
    assert.equal(stats.best[PEER_KEYS.response_hours], undefined);
  });
});

describe('the phone test', () => {
  test('is off unless a monitored number is wired up', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value } = await collector.collect(target('p_silent', 'silent.example'), {
      mode: 'cold',
    });

    assert.equal(probe.calls(), 0);
    assert.equal(value?.phone, null);
    assert.equal(
      codes(collector.normalise(value, ctx())).includes('STL_PHONE_UNANSWERED'),
      false,
    );
  });

  test('places one call and reports an unanswered phone', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY, { testPhone: true });
    const { value, cost } = await collector.collect(target('p_silent', 'silent.example'), {
      mode: 'cold',
    });

    assert.equal(probe.calls(), 1);
    assert.equal(cost.pence, 3);
    const unanswered = collector
      .normalise(value, ctx())
      .find((s) => s.code === 'STL_PHONE_UNANSWERED')!;
    assert.equal(unanswered.evidence.rang_seconds, 45);
  });

  test('does not ring a business twice', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY, { testPhone: true });
    const t = target('p_silent', 'silent.example');
    await collector.collect(t, { mode: 'cold' });
    await collector.collect(t, { mode: 'cold' });
    assert.equal(probe.calls(), 1);
  });

  test('a business with no listed number is not called', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY, { testPhone: true });
    await collector.collect(target('p_silent', 'silent.example', null), { mode: 'cold' });
    assert.equal(probe.calls(), 0);
  });
});

describe('a failed probe degrades the section', () => {
  test('an inspection that throws does not take the scan down', async () => {
    const collector = createSpeedToLeadCollector(deadProbe, GENUINE_ENQUIRY);
    const t = target('p_riverside', 'riversideplumbing.example');

    await assert.doesNotReject(() => collector.collect(t, { mode: 'cold' }));
    const { value } = await collector.collect(t, { mode: 'cold' });
    assert.equal(value?.surfaces, null);
    assert.equal(value?.submission, null);
    assert.deepEqual(collector.normalise(value, ctx()), []);
  });

  test('a business with no website is inspected by nobody', async () => {
    const probe = fixtureProbe(SENT_AT);
    const collector = createSpeedToLeadCollector(probe, GENUINE_ENQUIRY);
    const { value, cost } = await collector.collect(target('p_none', null), { mode: 'cold' });

    assert.equal(cost.pence, 0);
    assert.equal(value?.surfaces, null);
    assert.equal(probe.submitted().length, 0);
  });
});

describe('collector', () => {
  test('runs without auth — this is a cold-mode collector', () => {
    const probe = fixtureProbe(SENT_AT);
    assert.equal(createSpeedToLeadCollector(probe, GENUINE_ENQUIRY).requires_auth, false);
  });

  test('only emits codes it declared', () => {
    for (const capture of Object.values(captures)) {
      for (const seed of normaliseSpeedToLead(capture, ctx())) {
        assert.ok(
          SPEEDTOLEAD_EMITS.includes(seed.code as (typeof SPEEDTOLEAD_EMITS)[number]),
          seed.code,
        );
      }
    }
  });

  test('says nothing when there is no capture', () => {
    assert.deepEqual(normaliseSpeedToLead(null, ctx()), []);
  });
});

describe('expandSeed', () => {
  test('takes severity and confidence from the registry, not the collector', () => {
    const draft = expandSeed({ code: 'STL_FORM_BROKEN', evidence: {} }, 't1');
    assert.equal(draft.severity, 'critical');
    assert.equal(draft.confidence, 'verified');
    assert.equal(draft.collector, 'speedtolead');
    assert.equal(draft.measured_unit, null);
  });

  test('the two measured codes carry hours', () => {
    assert.equal(
      expandSeed({ code: 'STL_FORM_SLOW_REPLY', measured_value: 31, evidence: {} }, 't')
        .measured_unit,
      'hours',
    );
    assert.equal(
      expandSeed({ code: 'STL_COMPETITOR_FASTER', evidence: {} }, 't').measured_unit,
      'hours',
    );
  });
});
