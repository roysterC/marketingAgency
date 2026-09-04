/**
 * UK postcode handling.
 *
 * `region` on a business is the outward code (`SW18`, `M1`, `EC1A`) — it is one of the two
 * grouping keys for benchmarks, so it has to normalise consistently or percentiles fragment
 * across spellings of the same district.
 */

/** Full postcode, e.g. `SW18 4AB` or `sw184ab`. */
const FULL = /^([A-Z]{1,2}\d{1,2}[A-Z]?)\s*(\d[A-Z]{2})$/;
/** Outward code on its own, e.g. `SW18`. */
const OUTWARD_ONLY = /^([A-Z]{1,2}\d{1,2}[A-Z]?)$/;

/**
 * Extract the outward code from a postcode.
 *
 * Accepts a full postcode or an outward code already. Returns null for anything that
 * isn't recognisably a UK postcode — callers treat that as "region unknown" rather than
 * guessing, since a wrong region silently poisons the benchmark table.
 */
export function toOutwardCode(input: string | null | undefined): string | null {
  if (!input) return null;

  const cleaned = input.trim().toUpperCase().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return null;

  const full = FULL.exec(cleaned.replace(/\s/g, ''));
  if (full?.[1]) return full[1];

  const outward = OUTWARD_ONLY.exec(cleaned);
  if (outward?.[1]) return outward[1];

  return null;
}

/** The area letters, e.g. `SW` from `SW18`. Coarser fallback when a district is too thin. */
export function toPostcodeArea(input: string | null | undefined): string | null {
  const outward = toOutwardCode(input);
  if (!outward) return null;
  return /^([A-Z]{1,2})/.exec(outward)?.[1] ?? null;
}
