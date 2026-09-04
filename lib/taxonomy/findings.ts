/**
 * The closed finding taxonomy.
 *
 * This registry is the single source of truth. `docs/finding-taxonomy.md` is the
 * human-readable view of it; `scripts/check-taxonomy.mjs` fails the build if the two
 * disagree.
 *
 * CLAUDE.md rule 1: collectors emit codes from this set and nothing else. Adding a code
 * means adding it here, adding its normalise rule, and adding its render template — in
 * that order. `FindingCode` is derived from the registry keys, so an unlisted code is a
 * compile error rather than a runtime surprise.
 */

import type { Collector, Confidence, Polarity, Segment, Severity, Unit } from './enums';

export interface FindingDefinition {
  /** Which collector may emit this. */
  readonly collector: Collector;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** Unit of the measured value. `none` for binary findings. */
  readonly unit: Unit;
  /** Which direction is good. `none` for binary findings. */
  readonly polarity: Polarity;
  /** Packages this applies to. Drives which collectors run for a given scan. */
  readonly segments: readonly Segment[];
  /**
   * Whether this finding's measured value can feed the benchmarks table.
   * Binary findings ("the listing is missing") have nothing to take a percentile of.
   */
  readonly benchmarkable: boolean;
  /** Short human label. The report's section heading for this finding. */
  readonly title: string;
}

const LOCAL: readonly Segment[] = ['smb'];
const BOTH: readonly Segment[] = ['smb', 'dtc'];
const ECOM: readonly Segment[] = ['dtc'];

export const FINDINGS = {
  // ---------------------------------------------------------------- gbp
  GBP_MISSING: {
    collector: 'gbp', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'No Google Business Profile found',
  },
  GBP_UNCLAIMED: {
    collector: 'gbp', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'Business Profile is unclaimed',
  },
  GBP_CATEGORY_MISMATCH: {
    collector: 'gbp', severity: 'high', confidence: 'estimated',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'Primary category does not match services offered',
  },
  GBP_HOURS_INCOMPLETE: {
    collector: 'gbp', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'Opening hours incomplete',
  },
  // Binary: holiday hours are either set or they aren't. There is no percentile of
  // "absent", so this carries no unit and never feeds benchmarks.
  GBP_HOURS_STALE_HOLIDAY: {
    collector: 'gbp', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'Holiday hours not set',
  },
  GBP_PHOTOS_SPARSE: {
    collector: 'gbp', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: LOCAL, benchmarkable: true,
    title: 'Few photos compared with competitors',
  },
  GBP_NO_SERVICES_LISTED: {
    collector: 'gbp', severity: 'high', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: LOCAL, benchmarkable: true,
    title: 'No services listed on the profile',
  },
  GBP_POSTS_STALE: {
    collector: 'gbp', severity: 'low', confidence: 'verified',
    unit: 'days', polarity: 'lower_better', segments: LOCAL, benchmarkable: true,
    title: 'No recent profile posts',
  },
  GBP_QNA_UNANSWERED: {
    collector: 'gbp', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: LOCAL, benchmarkable: true,
    title: 'Unanswered questions on the profile',
  },
  GBP_ATTRIBUTES_SPARSE: {
    collector: 'gbp', severity: 'low', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: LOCAL, benchmarkable: true,
    title: 'Few profile attributes set',
  },

  // ---------------------------------------------------------- localrank
  LOCALRANK_ABSENT: {
    collector: 'localrank', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'Not ranking for a money keyword',
  },
  LOCALRANK_BELOW_MEDIAN: {
    collector: 'localrank', severity: 'high', confidence: 'verified',
    unit: 'position', polarity: 'lower_better', segments: LOCAL, benchmarkable: true,
    title: 'Ranking below the local median',
  },
  LOCALRANK_LOST_TO_COMPETITOR: {
    collector: 'localrank', severity: 'high', confidence: 'verified',
    unit: 'position', polarity: 'lower_better', segments: LOCAL, benchmarkable: true,
    title: 'Outranked by a direct competitor',
  },
  LOCALRANK_NO_MONEY_KEYWORD_COVERAGE: {
    collector: 'localrank', severity: 'high', confidence: 'estimated',
    unit: 'percent', polarity: 'higher_better', segments: LOCAL, benchmarkable: true,
    title: 'Money keywords not covered by any page',
  },

  // ------------------------------------------------------------ reviews
  REVIEW_VOLUME_LOW: {
    collector: 'reviews', severity: 'high', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: BOTH, benchmarkable: true,
    title: 'Fewer reviews than competitors',
  },
  REVIEW_VELOCITY_LOW: {
    collector: 'reviews', severity: 'critical', confidence: 'verified',
    unit: 'per_month', polarity: 'higher_better', segments: BOTH, benchmarkable: true,
    title: 'Reviews arriving more slowly than competitors',
  },
  REVIEW_RATING_BELOW_SET: {
    collector: 'reviews', severity: 'high', confidence: 'verified',
    unit: 'score', polarity: 'higher_better', segments: BOTH, benchmarkable: true,
    title: 'Rating below the competitor set',
  },
  REVIEW_RESPONSE_RATE_LOW: {
    collector: 'reviews', severity: 'medium', confidence: 'verified',
    unit: 'percent', polarity: 'higher_better', segments: BOTH, benchmarkable: true,
    title: 'Most reviews go unanswered',
  },
  REVIEW_RESPONSE_ABSENT_NEGATIVE: {
    collector: 'reviews', severity: 'high', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Negative reviews with no reply',
  },
  REVIEW_RECENCY_STALE: {
    collector: 'reviews', severity: 'high', confidence: 'verified',
    unit: 'days', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'No recent reviews',
  },

  // -------------------------------------------------------- speedtolead
  // Every code here is `verified` by construction — we measured it. That is the point.
  STL_FORM_BROKEN: {
    collector: 'speedtolead', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'Contact form is broken',
  },
  STL_FORM_NO_REPLY: {
    collector: 'speedtolead', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'No reply to a website enquiry',
  },
  STL_FORM_SLOW_REPLY: {
    collector: 'speedtolead', severity: 'critical', confidence: 'verified',
    unit: 'hours', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Slow reply to a website enquiry',
  },
  STL_NO_FORM_ON_SITE: {
    collector: 'speedtolead', severity: 'high', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'No contact form on the site',
  },
  STL_PHONE_UNANSWERED: {
    collector: 'speedtolead', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'Phone went unanswered',
  },
  STL_NO_PHONE_VISIBLE_MOBILE: {
    collector: 'speedtolead', severity: 'high', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'No phone number visible on mobile',
  },
  STL_COMPETITOR_FASTER: {
    collector: 'speedtolead', severity: 'high', confidence: 'verified',
    unit: 'hours', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'A competitor replied faster',
  },

  // ----------------------------------------------------------- sitetech
  TECH_LCP_POOR: {
    collector: 'sitetech', severity: 'high', confidence: 'verified',
    unit: 'seconds', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Largest Contentful Paint is slow',
  },
  TECH_CLS_POOR: {
    collector: 'sitetech', severity: 'medium', confidence: 'verified',
    unit: 'score', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Layout shifts during load',
  },
  TECH_INP_POOR: {
    collector: 'sitetech', severity: 'medium', confidence: 'verified',
    unit: 'ms', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Slow response to interaction',
  },
  TECH_MOBILE_UNFRIENDLY: {
    collector: 'sitetech', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'Site is not mobile friendly',
  },
  TECH_NO_HTTPS: {
    collector: 'sitetech', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'Site is not served over HTTPS',
  },
  TECH_INDEXATION_BLOCKED: {
    collector: 'sitetech', severity: 'critical', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Pages blocked from search indexing',
  },
  TECH_MISSING_LOCALBUSINESS_SCHEMA: {
    collector: 'sitetech', severity: 'high', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: LOCAL, benchmarkable: false,
    title: 'No LocalBusiness structured data',
  },
  TECH_MISSING_PRODUCT_SCHEMA: {
    collector: 'sitetech', severity: 'high', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No Product structured data',
  },
  TECH_TITLE_MISSING: {
    collector: 'sitetech', severity: 'high', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Pages missing a title tag',
  },
  TECH_TITLE_DUPLICATE: {
    collector: 'sitetech', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Duplicate page titles',
  },
  TECH_BROKEN_LINKS: {
    collector: 'sitetech', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Broken links on the site',
  },
  TECH_NO_SITEMAP: {
    collector: 'sitetech', severity: 'low', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'No XML sitemap',
  },
  TECH_THIN_CONTENT: {
    collector: 'sitetech', severity: 'medium', confidence: 'estimated',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Pages with very little content',
  },

  // ---------------------------------------------------------- citations
  NAP_INCONSISTENT: {
    collector: 'citations', severity: 'high', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: LOCAL, benchmarkable: true,
    title: 'Name, address or phone inconsistent across directories',
  },
  NAP_MISSING_DIRECTORY: {
    collector: 'citations', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: LOCAL, benchmarkable: true,
    title: 'Missing from key directories',
  },

  // -------------------------------------------------------------- aivis
  AIVIS_NOT_CITED: {
    collector: 'aivis', severity: 'high', confidence: 'verified',
    unit: 'percent', polarity: 'higher_better', segments: BOTH, benchmarkable: true,
    title: 'Not cited in AI answers for buying prompts',
  },
  AIVIS_COMPETITOR_CITED: {
    collector: 'aivis', severity: 'high', confidence: 'verified',
    unit: 'percent', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'Competitors cited instead',
  },
  AIVIS_OUTDATED_FACT: {
    collector: 'aivis', severity: 'critical', confidence: 'verified',
    unit: 'count', polarity: 'lower_better', segments: BOTH, benchmarkable: true,
    title: 'AI answers state something incorrect about the business',
  },
  AIVIS_NO_ENTITY: {
    collector: 'aivis', severity: 'high', confidence: 'estimated',
    unit: 'none', polarity: 'none', segments: BOTH, benchmarkable: false,
    title: 'No recognisable entity presence',
  },

  // ------------------------------------------------------- paidcreative
  ADS_NONE_RUNNING: {
    collector: 'paidcreative', severity: 'info', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No ads currently running',
  },
  ADS_CREATIVE_VOLUME_LOW: {
    collector: 'paidcreative', severity: 'high', confidence: 'verified',
    unit: 'per_week', polarity: 'higher_better', segments: ECOM, benchmarkable: true,
    title: 'Fewer new creatives than competitors',
  },
  ADS_CREATIVE_STALE: {
    collector: 'paidcreative', severity: 'high', confidence: 'verified',
    unit: 'days', polarity: 'lower_better', segments: ECOM, benchmarkable: true,
    title: 'Same creative running unchanged',
  },
  ADS_SINGLE_FORMAT: {
    collector: 'paidcreative', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: ECOM, benchmarkable: true,
    title: 'Only one creative format in use',
  },
  ADS_NO_OFFER_VARIATION: {
    collector: 'paidcreative', severity: 'medium', confidence: 'estimated',
    unit: 'count', polarity: 'higher_better', segments: ECOM, benchmarkable: true,
    title: 'No variation in offers tested',
  },
  ADS_SPEND_ESTIMATE: {
    collector: 'paidcreative', severity: 'info', confidence: 'estimated',
    unit: 'gbp', polarity: 'none', segments: ECOM, benchmarkable: true,
    title: 'Estimated monthly ad spend',
  },

  // -------------------------------------------------------------- store
  PDP_NO_REVIEWS: {
    collector: 'store', severity: 'high', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'Product pages have no reviews',
  },
  PDP_IMAGE_COUNT_LOW: {
    collector: 'store', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: ECOM, benchmarkable: true,
    title: 'Few images per product',
  },
  PDP_NO_SIZE_GUIDE: {
    collector: 'store', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No size guide on product pages',
  },
  CART_NO_TRUST_SIGNALS: {
    collector: 'store', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No trust signals in the cart',
  },
  CHECKOUT_LIMITED_PAYMENTS: {
    collector: 'store', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: ECOM, benchmarkable: true,
    title: 'Limited payment options at checkout',
  },
  NO_SHIPPING_THRESHOLD_VISIBLE: {
    collector: 'store', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'Free shipping threshold not shown',
  },
  COLLECTION_NO_FILTERS: {
    collector: 'store', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'Collection pages have no filtering',
  },

  // ---------------------------------------------------------- lifecycle
  EMAIL_NO_WELCOME_FLOW: {
    collector: 'lifecycle', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No welcome email flow',
  },
  EMAIL_NO_ABANDON_FLOW: {
    collector: 'lifecycle', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No abandoned cart flow',
  },
  EMAIL_SLOW_FIRST_SEND: {
    collector: 'lifecycle', severity: 'high', confidence: 'verified',
    unit: 'hours', polarity: 'lower_better', segments: ECOM, benchmarkable: true,
    title: 'Slow first email after signup',
  },
  EMAIL_SINGLE_TOUCH_WELCOME: {
    collector: 'lifecycle', severity: 'medium', confidence: 'verified',
    unit: 'count', polarity: 'higher_better', segments: ECOM, benchmarkable: true,
    title: 'Welcome flow is a single email',
  },
  EMAIL_NO_SMS_CAPTURE: {
    collector: 'lifecycle', severity: 'medium', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No SMS capture on signup',
  },

  // -------------------------------------------------------- measurement
  TRACK_NO_SERVER_SIDE: {
    collector: 'measurement', severity: 'high', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No server-side tracking',
  },
  TRACK_GA4_MISCONFIGURED: {
    collector: 'measurement', severity: 'high', confidence: 'estimated',
    unit: 'count', polarity: 'lower_better', segments: ECOM, benchmarkable: true,
    title: 'GA4 configuration problems',
  },
  TRACK_NO_CONVERSION_EVENTS: {
    collector: 'measurement', severity: 'critical', confidence: 'verified',
    unit: 'none', polarity: 'none', segments: ECOM, benchmarkable: false,
    title: 'No conversion events firing',
  },
  TRACK_CONSENT_BLOCKING: {
    collector: 'measurement', severity: 'high', confidence: 'estimated',
    unit: 'percent', polarity: 'lower_better', segments: ECOM, benchmarkable: true,
    title: 'Consent banner is blocking measurement',
  },
} as const satisfies Record<string, FindingDefinition>;

/** Every valid finding code. Derived from the registry — the closed set, enforced. */
export type FindingCode = keyof typeof FINDINGS;

/** All codes, as an array. */
export const FINDING_CODES = Object.keys(FINDINGS) as FindingCode[];

/** Runtime guard, for values arriving from the database or an external payload. */
export function isFindingCode(value: unknown): value is FindingCode {
  return typeof value === 'string' && Object.hasOwn(FINDINGS, value);
}

/** Definition lookup. Total over `FindingCode`, so no undefined check needed. */
export function definitionOf(code: FindingCode): FindingDefinition {
  return FINDINGS[code];
}

/** Codes a given collector is allowed to emit. */
export function codesForCollector(collector: string): FindingCode[] {
  return FINDING_CODES.filter((code) => FINDINGS[code].collector === collector);
}

/** Codes relevant to a package. Use to decide which collectors a scan runs. */
export function codesForSegment(segment: string): FindingCode[] {
  return FINDING_CODES.filter((code) =>
    (FINDINGS[code].segments as readonly string[]).includes(segment),
  );
}

/** Codes whose measured value can feed the benchmarks table. */
export function benchmarkableCodes(): FindingCode[] {
  return FINDING_CODES.filter((code) => FINDINGS[code].benchmarkable);
}
