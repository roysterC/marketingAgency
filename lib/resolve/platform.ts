/**
 * Platform detection from a fetched homepage.
 *
 * Pure over the response so it can be tested against fixtures rather than live sites.
 * Platform drives which store collectors are worth running — there is no point auditing
 * Shopify checkout on a WordPress brochure site.
 */

export const PLATFORMS = [
  'shopify',
  'woocommerce',
  'wordpress',
  'squarespace',
  'wix',
  'bigcommerce',
  'webflow',
  'custom',
] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface PageResponse {
  html: string;
  /** Lowercased header names. */
  headers: Record<string, string>;
}

interface Signature {
  platform: Platform;
  html?: RegExp;
  header?: string;
}

/**
 * Order matters. WooCommerce is WordPress, so it has to be tested first or every Woo
 * store resolves as a plain WordPress site and the store collectors never run.
 */
const SIGNATURES: Signature[] = [
  { platform: 'shopify', html: /cdn\.shopify\.com|Shopify\.theme|shopify-section/i, header: 'x-shopid' },
  { platform: 'woocommerce', html: /woocommerce|wp-content\/plugins\/woocommerce/i },
  { platform: 'bigcommerce', html: /cdn\d*\.bigcommerce\.com|bigcommerce\.js/i },
  { platform: 'squarespace', html: /static1\.squarespace\.com|squarespace-cdn/i },
  { platform: 'wix', html: /_wixCssImports|static\.wixstatic\.com|wix\.com/i },
  { platform: 'webflow', html: /assets\.website-files\.com|webflow\.js/i },
  { platform: 'wordpress', html: /wp-content\/|wp-includes\/|name="generator" content="WordPress/i },
];

/** Best-guess platform. Returns `custom` when nothing matches — never null. */
export function detectPlatform(page: PageResponse): Platform {
  for (const sig of SIGNATURES) {
    if (sig.header && sig.header in page.headers) return sig.platform;
    if (sig.html?.test(page.html)) return sig.platform;
  }
  return 'custom';
}

/** Whether a platform indicates an e-commerce store, which gates the store collectors. */
export function isEcommercePlatform(platform: Platform): boolean {
  return platform === 'shopify' || platform === 'woocommerce' || platform === 'bigcommerce';
}
