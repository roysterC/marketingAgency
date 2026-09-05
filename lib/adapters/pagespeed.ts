/**
 * PageSpeed Insights — `VitalsProvider`.
 *
 * Free, and rate-limited hard without a key. That is why `sitetech` was built to survive
 * this source failing: on a scan fanning out over six targets, PSI refusing partway
 * through is the ordinary case, not the exotic one.
 *
 * **Field data is usually absent for a local SMB.** PSI returns real-user metrics from
 * CrUX only for origins with enough traffic to be in the dataset, and a plumber in
 * Wandsworth is not. So the adapter falls back to Lighthouse's lab measurements for LCP
 * and CLS — but *not* for INP, which has no lab equivalent. When there is no field data
 * `inp_ms` is null, and `TECH_INP_POOR` simply does not run. Reporting a lab proxy as a
 * measured interaction delay would be an estimate wearing a `verified` label.
 */

import { FREE, type Cost, type Priced } from '../resolve/providers';
import type { VitalsProvider, VitalsResult, VitalsStrategy } from '../collectors/sitetech/types';
import { optional, type Env } from './config';
import { query, requestJson, type RetryPolicy } from './http';

const ENDPOINT = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export interface PageSpeedConfig {
  /** Optional. Without one the API allows only a trickle of requests. */
  apiKey?: string;
  /** PSI takes 10-30s on a slow site. */
  timeoutMs?: number;
  retry?: RetryPolicy;
  fetchImpl?: typeof fetch;
  costPerCall?: Cost;
}

interface RawPsi {
  loadingExperience?: {
    metrics?: Record<string, { percentile?: number; category?: string }>;
  };
  lighthouseResult?: {
    audits?: Record<string, { numericValue?: number; score?: number | null }>;
    finalUrl?: string;
  };
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const round = (n: number, dp: number): number => {
  const factor = 10 ** dp;
  return Math.round(n * factor) / factor;
};

/**
 * Pull the three vitals out of a PSI response.
 *
 * Field data wins where it exists — it is what real visitors experienced. CrUX reports
 * CLS as an integer scaled by 100, so 41 means 0.41; getting that wrong would put every
 * site two orders of magnitude into the red.
 */
export function readVitals(raw: RawPsi, strategy: VitalsStrategy, reportUrl: string): VitalsResult {
  const field = raw.loadingExperience?.metrics ?? {};
  const audits = raw.lighthouseResult?.audits ?? {};

  const fieldLcpMs = num(field.LARGEST_CONTENTFUL_PAINT_MS?.percentile);
  const fieldCls = num(field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile);
  const fieldInpMs = num(field.INTERACTION_TO_NEXT_PAINT?.percentile);

  const labLcpMs = num(audits['largest-contentful-paint']?.numericValue);
  const labCls = num(audits['cumulative-layout-shift']?.numericValue);

  const lcpMs = fieldLcpMs ?? labLcpMs;
  const cls = fieldCls !== null ? fieldCls / 100 : labCls;

  return {
    strategy,
    lcp_seconds: lcpMs === null ? null : round(lcpMs / 1000, 2),
    cls: cls === null ? null : round(cls, 3),
    // No lab equivalent exists. Null rather than a proxy dressed up as a measurement.
    inp_ms: fieldInpMs === null ? null : Math.round(fieldInpMs),
    mobile_friendly: mobileFriendly(audits),
    report_url: reportUrl,
  };
}

/**
 * Whether the page is usable on a phone.
 *
 * Google retired the standalone Mobile-Friendly Test, so this reads the two Lighthouse
 * audits that covered most of what it checked: a configured viewport, and content that
 * fits the screen. Both absent means unknown rather than unfriendly.
 */
export function mobileFriendly(
  audits: Record<string, { score?: number | null }>,
): boolean | null {
  const viewport = audits.viewport?.score;
  const width = audits['content-width']?.score;
  if (viewport === undefined && width === undefined) return null;
  return (viewport ?? 1) === 1 && (width ?? 1) === 1;
}

export function createVitalsProvider(config: PageSpeedConfig = {}): VitalsProvider {
  const { apiKey, timeoutMs = 60_000, retry, fetchImpl, costPerCall = FREE } = config;

  return {
    name: 'pagespeed-insights',

    async measure(url, strategy): Promise<Priced<VitalsResult>> {
      const params = query({
        url,
        strategy,
        category: 'PERFORMANCE',
        key: apiKey,
      });

      const raw = await requestJson<RawPsi>(`${ENDPOINT}?${params}`, {
        timeoutMs,
        ...(retry ? { retry } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });

      const reportUrl = `https://pagespeed.web.dev/report?url=${encodeURIComponent(url)}`;
      return { value: readVitals(raw, strategy, reportUrl), cost: costPerCall };
    },
  };
}

export function pageSpeedConfigFromEnv(env: Env = process.env): PageSpeedConfig {
  const apiKey = optional(env, 'PAGESPEED_API_KEY');
  return apiKey ? { apiKey } : {};
}
