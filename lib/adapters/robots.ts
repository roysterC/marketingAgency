/**
 * robots.txt — parsing, and the question "may we fetch this?".
 *
 * `docs/data-sources.md` puts respecting robots.txt at the top of the crawl etiquette list,
 * and it is not negotiable: the `sitetech` crawl hits sites belonging to businesses that
 * never agreed to be audited, in a report they did not ask for. Ignoring their robots file
 * while producing a document criticising their SEO would be indefensible.
 *
 * **This is a different question from `blocksEverything` in the sitetech normaliser.** That
 * one asks "is this site telling search engines to go away", which is a finding about the
 * business. This one asks "are we allowed to fetch this page", which is a constraint on us.
 * They read the same file and mean opposite things — one is their problem, one is our
 * obligation — so they are deliberately separate functions.
 */

export interface RobotsRules {
  /** Paths this user-agent may not fetch. */
  disallow: string[];
  /** Explicit exceptions, which win over a longer disallow. */
  allow: string[];
  sitemaps: string[];
  /** `Crawl-delay`, in milliseconds. Null when the site does not ask for one. */
  crawlDelayMs: number | null;
  /** True when robots.txt could not be fetched. Absent is permissive, by convention. */
  absent: boolean;
}

export const PERMISSIVE: RobotsRules = {
  disallow: [],
  allow: [],
  sitemaps: [],
  crawlDelayMs: null,
  absent: true,
};

const directive = (line: string): { key: string; value: string } | null => {
  const withoutComment = line.split('#')[0]!.trim();
  const colon = withoutComment.indexOf(':');
  if (colon === -1) return null;
  return {
    key: withoutComment.slice(0, colon).trim().toLowerCase(),
    value: withoutComment.slice(colon + 1).trim(),
  };
};

/**
 * Rules for one user-agent.
 *
 * Groups are selected the way the standard describes: the most specific matching agent
 * wins, falling back to `*`. Sitemap lines are global rather than per-group, so they are
 * collected from the whole file.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const agent = userAgent.toLowerCase();

  const groups = new Map<string, { disallow: string[]; allow: string[]; delay: number | null }>();
  const sitemaps: string[] = [];

  let current: string[] = [];
  // A blank line ends a group; consecutive User-agent lines share one group.
  let expectingAgents = false;

  for (const line of text.split(/\r?\n/)) {
    const parsed = directive(line);
    if (!parsed) continue;

    if (parsed.key === 'sitemap') {
      if (parsed.value) sitemaps.push(parsed.value);
      continue;
    }

    if (parsed.key === 'user-agent') {
      if (!expectingAgents) current = [];
      expectingAgents = true;
      current.push(parsed.value.toLowerCase());
      for (const name of current) {
        if (!groups.has(name)) groups.set(name, { disallow: [], allow: [], delay: null });
      }
      continue;
    }

    expectingAgents = false;
    for (const name of current) {
      const group = groups.get(name);
      if (!group) continue;
      if (parsed.key === 'disallow') group.disallow.push(parsed.value);
      else if (parsed.key === 'allow') group.allow.push(parsed.value);
      else if (parsed.key === 'crawl-delay') {
        const seconds = Number(parsed.value);
        if (Number.isFinite(seconds)) group.delay = seconds * 1000;
      }
    }
  }

  // Most specific agent wins: an exact-ish token match before the wildcard.
  const named = [...groups.keys()]
    .filter((name) => name !== '*' && agent.includes(name))
    .sort((a, b) => b.length - a.length)[0];

  const chosen = groups.get(named ?? '*');
  if (!chosen) return { disallow: [], allow: [], sitemaps, crawlDelayMs: null, absent: false };

  return {
    disallow: chosen.disallow,
    allow: chosen.allow,
    sitemaps,
    crawlDelayMs: chosen.delay,
    absent: false,
  };
}

/**
 * Whether a rule pattern matches a path.
 *
 * Supports the two wildcards the standard defines: `*` for any run of characters and `$`
 * for end-of-path. Everything else is a prefix match.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === '') return false;

  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;

  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(path);
}

/**
 * May we fetch this path?
 *
 * An empty `Disallow:` means "nothing is disallowed" and is the standard way to say
 * "everything is allowed" — `matchesPattern` returns false for it rather than matching
 * every path, which would invert the whole file.
 *
 * Where both an allow and a disallow match, the longer pattern wins, and a tie goes to
 * allow. That is the rule Google documents, and getting it backwards would have us
 * skipping pages a site explicitly opened up.
 */
export function isAllowed(path: string, rules: RobotsRules): boolean {
  const longest = (patterns: string[]): number =>
    patterns.filter((p) => matchesPattern(path, p)).reduce((max, p) => Math.max(max, p.length), -1);

  const allow = longest(rules.allow);
  const disallow = longest(rules.disallow);

  if (disallow === -1) return true;
  return allow >= disallow;
}

/** Whether the file shuts us out of the whole site. */
export function blocksUsEntirely(rules: RobotsRules): boolean {
  return !isAllowed('/', rules) && !isAllowed('/index.html', rules);
}
