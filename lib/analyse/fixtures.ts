/**
 * A whole scan's worth of findings, and the narrative written over them.
 *
 * The findings are the ones the collectors actually produced against their own fixtures —
 * Riverside taking 31 hours to reply, 0.17 reviews a month, a model giving out the wrong
 * phone number — so what is rendered here is what the engine really says about a business.
 */

import type { Priced } from '../resolve/providers';
import type { Benchmark, Finding, Narrative, Uuid } from '../types/index';
import { FINDINGS, type FindingCode } from '../taxonomy/findings';
import type { NarrativeWriter } from './index';
import type { AnalysisBrief } from './brief';

const SCAN_ID = 'scan_0001';
export const SUBJECT_TARGET = 't_riverside';
export const COMPETITOR_TARGET = 't_wandsworth';

const NORMALISED_AT = '2026-09-04T12:30:00.000Z';

interface FindingSpec {
  id: string;
  code: FindingCode;
  target_id?: string;
  measured_value?: number | null;
  measured_text?: string | null;
  benchmark_value?: number | null;
  benchmark_source?: Finding['benchmark_source'];
  evidence?: Record<string, unknown>;
}

/** Build a persisted finding row, taking severity and confidence from the registry. */
export function finding(spec: FindingSpec): Finding {
  const def = FINDINGS[spec.code];
  return {
    id: spec.id,
    scan_id: SCAN_ID,
    target_id: spec.target_id ?? SUBJECT_TARGET,
    code: spec.code,
    collector: def.collector,
    severity: def.severity,
    confidence: def.confidence,
    measured_value: spec.measured_value ?? null,
    measured_unit: def.unit === 'none' ? null : def.unit,
    measured_text: spec.measured_text ?? null,
    benchmark_value: spec.benchmark_value ?? null,
    benchmark_source: spec.benchmark_source ?? null,
    evidence: spec.evidence ?? {},
    normalised_at: NORMALISED_AT,
  };
}

export const F = {
  slowReply: finding({
    id: 'f_stl',
    code: 'STL_FORM_SLOW_REPLY',
    measured_value: 31,
    measured_text: '31 hours to reply',
    benchmark_value: 4,
    benchmark_source: 'absolute',
    evidence: {
      submitted_at: '2026-09-04T10:14:00.000Z',
      responded_at: '2026-09-05T17:14:00.000Z',
      channel: 'form',
      form_url: 'http://riversideplumbing.example/contact',
      excerpt: 'Yes we cover SW18, callout is £70 plus parts.',
    },
  }),

  velocity: finding({
    id: 'f_reviews',
    code: 'REVIEW_VELOCITY_LOW',
    measured_value: 0.17,
    measured_text: '0.17 a month',
    benchmark_value: 4.1,
    benchmark_source: 'vertical_p50',
    evidence: {
      reviews_per_month: 0.17,
      window_days: 365,
      reviews_url: 'https://search.google.com/local/reviews?placeid=p_riverside',
    },
  }),

  noHttps: finding({
    id: 'f_https',
    code: 'TECH_NO_HTTPS',
    evidence: {
      final_url: 'http://riversideplumbing.example/',
      note: 'Browsers mark the site "Not secure" in the address bar.',
    },
  }),

  wrongFact: finding({
    id: 'f_aivis',
    code: 'AIVIS_OUTDATED_FACT',
    measured_value: 1,
    measured_text: '1 incorrect statement',
    evidence: {
      wrong_claims: [
        {
          model: 'perplexity',
          prompt: 'emergency plumber near SW18',
          field: 'phone',
          stated: '020 8000 9999',
          actual: '+442080002222',
        },
      ],
    },
  }),

  /** The only `estimated` finding here. Any claim on it has to be hedged. */
  category: finding({
    id: 'f_category',
    code: 'GBP_CATEGORY_MISMATCH',
    measured_text: 'Electrician (name suggests plumbing)',
    evidence: {
      business_name: 'Riverside Plumbing',
      listed_category: 'Electrician',
      maps_url: 'https://www.google.com/maps/place/?q=place_id:p_riverside',
    },
  }),

  rank: finding({
    id: 'f_rank',
    code: 'LOCALRANK_BELOW_MEDIAN',
    measured_value: 5,
    measured_text: 'median position 5',
    benchmark_value: 1,
    benchmark_source: 'competitor_best',
    evidence: {
      median_position: 5,
      competitor_best: 1,
      measured_near: { lat: 51.4571, lng: -0.1911 },
    },
  }),

  /** Cites a vertical percentile that does not have the scans behind it yet. */
  thinBenchmark: finding({
    id: 'f_volume',
    code: 'REVIEW_VOLUME_LOW',
    measured_value: 23,
    benchmark_value: 140,
    benchmark_source: 'vertical_p50',
    evidence: { review_count: 23 },
  }),

  /** A competitor's critical finding. Context, not the subject of the report. */
  competitorCritical: finding({
    id: 'f_comp',
    code: 'STL_FORM_NO_REPLY',
    target_id: COMPETITOR_TARGET,
    measured_text: 'no reply in 48 hours',
    evidence: { submitted_at: '2026-09-04T10:14:00.000Z', responded_at: null, channel: 'form' },
  }),

  /** Critical, and carries nothing a reader could check. */
  evidenceless: finding({
    id: 'f_bare',
    code: 'STL_PHONE_UNANSWERED',
    evidence: {},
  }),
} as const;

export const FINDINGS_FOR_SCAN: Finding[] = [
  F.slowReply,
  F.velocity,
  F.noHttps,
  F.wrongFact,
  F.category,
  F.rank,
  F.competitorCritical,
];

export const TARGETS = [
  {
    id: SUBJECT_TARGET,
    role: 'subject' as const,
    selection_reason: null,
    name: 'Riverside Plumbing',
  },
  {
    id: COMPETITOR_TARGET,
    role: 'competitor' as const,
    selection_reason: 'Ranks in the map pack for 5 of 5 money keywords, 0.8 miles away',
    name: 'Wandsworth Plumbers Ltd',
  },
];

export const SUBJECT = {
  name: 'Riverside Plumbing',
  vertical: 'trades.plumbing',
  region: 'SW18',
};

/** Enough scans behind the velocity percentile to quote it; not behind review volume. */
export const BENCHMARKS: Benchmark[] = [
  {
    vertical: 'trades.plumbing',
    region: 'SW18',
    code: 'REVIEW_VELOCITY_LOW',
    metric: 'per_month',
    p25: 1.2,
    p50: 4.1,
    p75: 7.8,
    sample_size: 42,
    updated_at: NORMALISED_AT,
  },
  {
    vertical: 'trades.plumbing',
    region: 'SW18',
    code: 'REVIEW_VOLUME_LOW',
    metric: 'count',
    p25: 40,
    p50: 140,
    p75: 260,
    sample_size: 4,
    updated_at: NORMALISED_AT,
  },
];

const claim = (text: string, finding_id: Uuid) => ({ text, finding_id });

/** A narrative that passes every gate. */
export const GOOD_NARRATIVE: Narrative = {
  executive_summary: [
    claim(
      'We submitted your contact form on Tuesday at 10:14. Nobody replied for 31 hours; your nearest competitor replied in 4 minutes.',
      F.slowReply.id,
    ),
    claim(
      'Perplexity is currently giving people the wrong phone number for your business.',
      F.wrongFact.id,
    ),
    claim(
      'You are gaining 0.17 reviews a month against a local median of 4.1.',
      F.velocity.id,
    ),
    claim('Your website is still served over plain http.', F.noHttps.id),
  ],
  sections: [
    {
      heading: 'Response time',
      collector: 'speedtolead',
      claims: [
        claim(
          'A working enquiry took 31 hours to answer, which is past the point where most callers have booked someone else.',
          F.slowReply.id,
        ),
      ],
    },
    {
      heading: 'Reviews',
      collector: 'reviews',
      claims: [claim('Review velocity is bottom-quartile for plumbers in SW18.', F.velocity.id)],
    },
    {
      heading: 'AI search visibility',
      collector: 'aivis',
      claims: [
        claim(
          'Asked for an emergency plumber near SW18, Perplexity named you and gave a phone number that is not yours.',
          F.wrongFact.id,
        ),
      ],
    },
    {
      heading: 'Site technicals',
      collector: 'sitetech',
      claims: [
        claim('The site is served over http, so browsers mark it "Not secure".', F.noHttps.id),
      ],
    },
    {
      heading: 'Google Business Profile',
      collector: 'gbp',
      claims: [
        // Hedged, because GBP_CATEGORY_MISMATCH is estimated.
        claim(
          'Your listing appears to be filed under Electrician, which suggests it is costing you the map pack for plumbing work.',
          F.category.id,
        ),
      ],
    },
    {
      heading: 'Local ranking',
      collector: 'localrank',
      claims: [
        claim('Your median map pack position is 5, against a competitor best of 1.', F.rank.id),
      ],
    },
  ],
  recommendations: [
    { action: 'Put an enquiry alert on the contact form inbox.', finding_ids: [F.slowReply.id], priority: 1 },
    { action: 'Correct the phone number on every profile the models read from.', finding_ids: [F.wrongFact.id], priority: 2 },
    { action: 'Move the site to https.', finding_ids: [F.noHttps.id], priority: 3 },
    {
      action: 'Start asking every completed job for a review.',
      finding_ids: [F.velocity.id, F.rank.id],
      priority: 4,
    },
  ],
};

export const REPORT_CONTEXT = {
  subject: 'Riverside Plumbing',
  vertical: 'trades.plumbing',
  region: 'SW18',
  competitors: ['Wandsworth Plumbers Ltd', 'SW Heating & Plumbing'],
  scanned_at: '2026-09-04T12:30:00.000Z',
  mode: 'cold' as const,
};

/**
 * A writer that builds a valid narrative from whatever brief it is handed.
 *
 * Deterministic, no model, no key. It exists to exercise the pipeline end to end —
 * `GOOD_NARRATIVE` cannot do that, because its finding ids belong to this file rather than
 * to the scan being run, so every claim comes back unreferenced.
 *
 * **It is not a report anyone would send.** It states each finding in one flat sentence and
 * ranks nothing. What it does do is satisfy every gate in `validate.ts` — cite a real
 * finding for every claim and recommendation, hedge anything `estimated`, and mention every
 * critical finding — which makes it the right thing to prove the plumbing with, and a
 * useful floor to compare a real narrative against.
 */
export function templateWriter(): NarrativeWriter {
  return {
    name: 'template-writer',

    async write(brief): Promise<Priced<Narrative>> {
      const say = (f: (typeof brief.findings)[number]): string => {
        const measured = f.measured.text ?? (f.measured.value === null ? null : `${f.measured.value}`);
        const detail = measured ? `: ${measured}` : '';
        // An estimated finding is inference, and the gate rejects a flat statement of one.
        return f.confidence === 'estimated'
          ? `${f.title} appears to apply to ${brief.subject}${detail}.`
          : `${f.title}${detail}.`;
      };

      const subjectFindings = brief.findings.filter((f) => f.target.role === 'subject');
      const bySeverity = ['critical', 'high', 'medium', 'low', 'info'] as const;

      const collectors = [...new Set(subjectFindings.map((f) => f.collector))];

      return {
        value: {
          // Worst first, and every critical appears here or in a section.
          executive_summary: subjectFindings
            .filter((f) => f.severity === 'critical' || f.severity === 'high')
            .slice(0, 4)
            .map((f) => ({ text: say(f), finding_id: f.finding_id })),

          sections: collectors.map((collector) => ({
            heading: collector,
            collector,
            claims: subjectFindings
              .filter((f) => f.collector === collector)
              .sort((a, b) => bySeverity.indexOf(a.severity) - bySeverity.indexOf(b.severity))
              .map((f) => ({ text: say(f), finding_id: f.finding_id })),
          })),

          recommendations: subjectFindings
            .filter((f) => f.severity === 'critical' || f.severity === 'high')
            .map((f, i) => ({
              action: `Address: ${f.title}`,
              finding_ids: [f.finding_id],
              priority: i + 1,
            })),
        },
        cost: { pence: 0 },
      };
    },
  };
}

/** A writer that returns a prepared narrative. No key, no spend, no model. */
export function fixtureWriter(narrative: Narrative = GOOD_NARRATIVE): NarrativeWriter & {
  briefs: () => AnalysisBrief[];
} {
  const briefs: AnalysisBrief[] = [];
  return {
    name: 'fixture-writer',
    briefs: () => briefs,
    async write(brief): Promise<Priced<Narrative>> {
      briefs.push(brief);
      return { value: narrative, cost: { pence: 60 } };
    },
  };
}
