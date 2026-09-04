/**
 * Google primary category -> our vertical path.
 *
 * `vertical` is a benchmark grouping key, so it must be stable and coarse enough to
 * accumulate a usable sample. Google has thousands of categories; percentiles over
 * "Emergency Plumber" separately from "Plumber" would never reach the 20-scan threshold.
 *
 * Trades is the beachhead vertical, so it is mapped in the most detail. Everything
 * unmapped falls back to `other.<slug>` rather than null, so it still groups with itself.
 */

const MAP: Record<string, string> = {
  // trades — the beachhead
  plumber: 'trades.plumbing',
  'plumbing supply store': 'trades.plumbing',
  electrician: 'trades.electrical',
  'roofing contractor': 'trades.roofing',
  roofer: 'trades.roofing',
  'hvac contractor': 'trades.hvac',
  'heating contractor': 'trades.hvac',
  'air conditioning contractor': 'trades.hvac',
  'general contractor': 'trades.general',
  builder: 'trades.general',
  locksmith: 'trades.locksmith',
  carpenter: 'trades.carpentry',
  painter: 'trades.painting',
  'painting contractor': 'trades.painting',
  landscaper: 'trades.landscaping',
  'landscape designer': 'trades.landscaping',
  'pest control service': 'trades.pest_control',
  'garage door supplier': 'trades.garage_doors',
  'window installation service': 'trades.windows',
  'flooring contractor': 'trades.flooring',
  'tree service': 'trades.tree_surgery',

  // clinics — second candidate vertical, carries compliance constraints
  dentist: 'clinic.dental',
  'dental clinic': 'clinic.dental',
  'physical therapist': 'clinic.physio',
  physiotherapist: 'clinic.physio',
  chiropractor: 'clinic.chiro',
  optician: 'clinic.optical',
  'veterinary care': 'clinic.veterinary',
  'medical clinic': 'clinic.general',

  // local services
  'hair salon': 'local.hair',
  barber: 'local.hair',
  'beauty salon': 'local.beauty',
  gym: 'local.fitness',
  'fitness center': 'local.fitness',
  restaurant: 'local.restaurant',
  cafe: 'local.cafe',
};

/** Lowercase, collapse punctuation and spaces into underscores. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Map a Google primary category to a vertical path.
 *
 * Returns null only when there is no category at all — an unmapped category still gets a
 * stable `other.*` path so it accumulates benchmarks with its own kind.
 */
export function toVertical(primaryCategory: string | null | undefined): string | null {
  if (!primaryCategory) return null;

  const key = primaryCategory.toLowerCase().trim();
  const mapped = MAP[key];
  if (mapped) return mapped;

  const slug = slugify(primaryCategory);
  return slug.length > 0 ? `other.${slug}` : null;
}

/** The family part, e.g. `trades` from `trades.plumbing`. Coarser benchmark fallback. */
export function verticalFamily(vertical: string | null): string | null {
  if (!vertical) return null;
  return vertical.split('.')[0] ?? null;
}

/**
 * Whether two categories are close enough to count as competitors.
 *
 * Same vertical is the bar. A plumber and an electrician both serve the same postcode
 * but are not competing for the same job, and mixing them makes every benchmark noise.
 */
export function isComparableCategory(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b;
}
