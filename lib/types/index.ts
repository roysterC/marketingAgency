/**
 * Shared domain types.
 *
 * These mirror the tables in `supabase/migrations/`. Row shapes use `snake_case` to match
 * Postgres exactly, so a row can be read or written without a translation layer.
 */

import type {
  BenchmarkSource,
  Collector,
  CollectorRunStatus,
  Confidence,
  ScanMode,
  ScanStatus,
  Segment,
  Severity,
  TargetRole,
  Unit,
} from '../taxonomy/enums';
import type { FindingCode } from '../taxonomy/findings';

export type Uuid = string;
/** ISO-8601. */
export type Timestamp = string;

/** A resolved business entity, deduplicated across scans. */
export interface Business {
  id: Uuid;
  name: string;
  domain: string | null;
  /** Google Places id. The dedupe key where we have one. */
  place_id: string | null;
  /** Dotted path, e.g. `trades.plumbing`, `dtc.apparel`. Benchmark grouping key. */
  vertical: string | null;
  /** UK postcode district, e.g. `SW18`. Benchmark grouping key. */
  region: string | null;
  platform: string | null;
  socials: Record<string, string>;
  first_seen_at: Timestamp;
  updated_at: Timestamp;
}

/** One run of the engine. */
export interface Scan {
  id: Uuid;
  subject_id: Uuid;
  mode: ScanMode;
  status: ScanStatus;
  /** Money keywords used by the localrank collector. */
  keyword_set: string[] | null;
  cost_pence: number;
  started_at: Timestamp;
  completed_at: Timestamp | null;
  error: string | null;
}

/** Subject plus competitors for a scan. */
export interface ScanTarget {
  id: Uuid;
  scan_id: Uuid;
  business_id: Uuid;
  role: TargetRole;
  /**
   * Why this competitor was chosen. Goes in the report — it is the first thing a
   * sceptical prospect challenges.
   */
  selection_reason: string | null;
}

/** Per-collector execution record. One row per (collector x target). */
export interface CollectorRun {
  id: Uuid;
  scan_id: Uuid;
  target_id: Uuid;
  collector: Collector;
  status: CollectorRunStatus;
  requires_auth: boolean;
  cost_pence: number;
  duration_ms: number | null;
  error: string | null;
  ran_at: Timestamp;
}

/**
 * Unprocessed source response. Never deleted.
 *
 * Kept separate from findings so re-normalising against improved rules is free —
 * CLAUDE.md rule 3.
 */
export interface RawCapture {
  id: Uuid;
  collector_run_id: Uuid;
  /** e.g. `places.details`, `serp.local`, `psi.mobile`. */
  source: string;
  payload: unknown;
  captured_at: Timestamp;
}

/** A normalised finding. `code` is from the closed taxonomy. */
export interface Finding {
  id: Uuid;
  scan_id: Uuid;
  target_id: Uuid;
  code: FindingCode;
  collector: Collector;
  severity: Severity;
  confidence: Confidence;
  measured_value: number | null;
  measured_unit: Unit | null;
  measured_text: string | null;
  benchmark_value: number | null;
  benchmark_source: BenchmarkSource | null;
  evidence: Evidence;
  normalised_at: Timestamp;
}

/** What a collector passes to the normaliser. The DB fills in the rest. */
export type FindingDraft = Omit<Finding, 'id' | 'scan_id' | 'normalised_at'>;

/** Screenshot or capture backing a finding. */
export interface EvidenceAsset {
  id: Uuid;
  scan_id: Uuid;
  finding_id: Uuid | null;
  kind: 'screenshot' | 'html' | 'email' | 'audio';
  storage_key: string;
  captured_at: Timestamp;
}

/** Aggregated percentiles. The moat. */
export interface Benchmark {
  vertical: string;
  /** `null` means national. */
  region: string | null;
  code: FindingCode;
  metric: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  sample_size: number;
  updated_at: Timestamp;
}

/** AI visibility prompts, per vertical. */
export interface PromptSet {
  id: Uuid;
  vertical: string;
  prompts: string[];
  models: string[];
  updated_at: Timestamp;
}

/** A rendered report. Versioned so a re-render never destroys what a client was sent. */
export interface Report {
  id: Uuid;
  scan_id: Uuid;
  version: number;
  variant: 'full' | 'onepager';
  narrative: Narrative;
  storage_key: string | null;
  rendered_at: Timestamp;
}

/**
 * LLM output. Every claim references a finding — CLAUDE.md rule 2.
 * The render step rejects a narrative containing an unreferenced claim.
 */
export interface Narrative {
  executive_summary: NarrativeClaim[];
  sections: NarrativeSection[];
}

export interface NarrativeSection {
  heading: string;
  collector: Collector;
  claims: NarrativeClaim[];
}

export interface NarrativeClaim {
  text: string;
  /** Must resolve to a real finding on this scan. Unreferenced claims are a bug. */
  finding_id: Uuid;
}

// ---------------------------------------------------------------- evidence

/**
 * Evidence backing a finding. Always renderable as proof — a timestamp, a URL, a raw
 * value, a screenshot key. A finding a prospect cannot verify is worth nothing.
 */
export type Evidence = Record<string, unknown>;

/** Evidence for the speed-to-lead test. The report quotes these timestamps verbatim. */
export interface SpeedToLeadEvidence extends Evidence {
  submitted_at: Timestamp;
  responded_at: Timestamp | null;
  channel: 'form' | 'phone' | 'chat';
  form_url?: string;
  screenshot_key?: string;
}

/** Evidence for an AI visibility finding. Capture the exact exchange. */
export interface AiVisEvidence extends Evidence {
  model: string;
  prompt: string;
  response_excerpt: string;
  cited_domains: string[];
  queried_at: Timestamp;
}

/** Evidence for a technical finding. */
export interface SiteTechEvidence extends Evidence {
  url: string;
  observed?: number | string;
  threshold?: number | string;
  screenshot_key?: string;
}

// ------------------------------------------------------------------ inputs

/** What starts a scan. Either a domain or a name plus a location. */
export type ScanRequest =
  | { kind: 'domain'; domain: string; segment: Segment }
  | { kind: 'local'; name: string; postcode: string; segment: Segment };
