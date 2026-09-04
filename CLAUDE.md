# marketingAgency — working context

Read this first. It exists so a fresh session can pick up without re-deriving decisions.

## What this repo is

The build for an AI-first marketing agency run by a solo technical founder. The agency
sells **systems**, not hours. This repo holds the strategy of record and the code for the
tools that make the strategy deliverable.

Current focus: **Phase A1 — the Research & Teardown Engine**.
Spec: [`docs/teardown-engine.md`](docs/teardown-engine.md).

Delivery capability (Track B) starts the moment A1 lands its first retainer — see
[`docs/delivery-system.md`](docs/delivery-system.md). Don't let it slip behind the next tool.

## Locked decisions

These are settled. Don't reopen them without the user explicitly saying so.

| Decision | Value |
|---|---|
| Market | Local SMB (primary, start here) + e-commerce/DTC (second) |
| Beachhead vertical | One local vertical first — trades or clinics |
| Structure | Solo, founder-led. ~20 client ceiling |
| Positioning | "We build the growth systems small brands can't hire for" — **not** "AI marketing agency" |
| Pricing stance | Price on outcome. Never "same service, cheaper because AI" |
| Edge services | 1. AI search visibility (AEO) · 2. Speed-to-lead / AI reception · 3. Measurement & attribution |
| Deprioritised | Social media management, standalone web design |
| Build order | Two tracks — **A: Product** (sequential, self-paced) and **B: Delivery** (triggered by client signings) |
| Track priority | **Track B interrupts Track A.** A paying client outranks the next tool |

Full reasoning in [`docs/strategy.md`](docs/strategy.md).

## Non-negotiable engineering rules

These came out of the design and are load-bearing. Breaking them breaks the product.

1. **Findings come from a closed taxonomy.** Collectors emit codes from
   [`docs/finding-taxonomy.md`](docs/finding-taxonomy.md). Never free-text findings, never
   LLM-invented finding types. This is what keeps reports consistent and benchmarks possible.
2. **The LLM writes, it does not fetch.** The analysis layer reasons over structured findings
   only. It never retrieves facts. A hallucinated competitor stat in a £1,000 report is fatal.
3. **Raw captures are stored separately from findings.** Collectors persist raw responses;
   a separate normalise step maps raw → findings. Rules will change constantly and re-buying
   data is expensive — re-normalisation must be free.
4. **Every finding carries evidence and a confidence level.** `verified` vs `estimated` is a
   hard distinction. Ad spend is estimated. A response time you measured is verified. Never
   render one as the other.
5. **Collectors fail independently.** One dead third-party source degrades a report; it never
   kills a scan.
6. **Benchmarks are written from day one.** Worthless at run #1, decisive by month six. The
   schema must support it before the first commit, not after.
7. **The never-automate list is enforced config, not documentation.** Default deny: anything
   not on the auto-publish allowlist routes to the approval queue, and the hard-blocked actions
   (social replies and DMs, campaign kill decisions, account structure changes, offer changes)
   have no code path at all. See [`docs/delivery-system.md`](docs/delivery-system.md).

## Ethical line on the speed-to-lead collector

The response-time test contacts real businesses. The enquiry must be **genuine and
identified** — a real question from a named inbox ("do you cover SW18? what's your callout
fee?"). Never a fabricated job that wastes someone's time. This is a mystery shop, not a fake
lead. See the collector notes in the spec.

## Stack

- **Next.js (App Router)** — dashboard, API, report rendering
- **Supabase / Postgres** — findings, benchmarks, raw captures
- **Inngest** — job queue; the pipeline is multi-step, long-running fan-out with retries
- **Playwright worker** — crawl and screenshots. Does *not* fit serverless; needs a
  Browserless-style service or a small always-on worker
- Paid data APIs over scraping. Always. See [`docs/data-sources.md`](docs/data-sources.md)

## Docs index

| File | What's in it |
|---|---|
| [`docs/strategy.md`](docs/strategy.md) | Agency strategy, positioning, offer ladder, edge services |
| [`docs/roadmap.md`](docs/roadmap.md) | Both tracks, with the offer-ladder coverage table and ship criteria |
| [`docs/teardown-engine.md`](docs/teardown-engine.md) | **The Phase A1 build spec** |
| [`docs/delivery-system.md`](docs/delivery-system.md) | Track B — the human gate, and how Tier 2 services actually ship |
| [`docs/finding-taxonomy.md`](docs/finding-taxonomy.md) | The closed finding code set |
| [`docs/schema.md`](docs/schema.md) | Data model |
| [`docs/data-sources.md`](docs/data-sources.md) | Providers, costs per scan, ToS notes |

## Conventions

- Currency GBP, UK-first (postcodes, GBP listings, UK SERPs)
- Dates ISO-8601
- Finding codes `SCREAMING_SNAKE`, collectors `lowercase`
- Row types use `snake_case` to match Postgres exactly — no translation layer
- Keep docs current: if a decision changes in conversation, update the doc in the same commit
  as the code that reflects it

## Checks

```bash
npm run check          # both of the below
npm run typecheck      # tsc --noEmit
npm run check:taxonomy # findings.ts <-> finding-taxonomy.md <-> SQL CHECK constraints
```

`check:taxonomy` is what makes "keep docs current" enforceable rather than aspirational. It
fails if a finding code, its severity or its confidence differs between the registry and the
doc, if a declared collector emits no codes, or if a TypeScript enum has drifted from its
CHECK constraint in the schema. Run it before committing taxonomy or schema changes.
