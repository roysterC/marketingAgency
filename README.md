# marketingAgency

> Automate to increase throughput and margin, and price on outcome.

The build for an AI-first marketing agency run by a solo technical founder. Sells **systems**,
not hours.

**Current phase: A1 — the Research & Teardown Engine.** Built end to end and passing on
fixtures; not yet pointed at a live API. See [where this is](#where-this-is).

The roadmap runs two tracks: **A (Product)** is sequential and self-paced; **B (Delivery)** is
triggered by client signings and interrupts A. A paying client outranks the next tool.

## What the teardown engine is

A pipeline that takes a business — name + postcode, or a domain — and produces a competitive
teardown that would take an agency two weeks. Under 20 minutes, under £5 a run.

It serves three jobs at once: a free cold-outbound lead magnet, a £500–1,500 paid audit, and a
live sales demo. The cold-mode requirement (zero access to the prospect) is what makes it a
business rather than just a nice audit tool.

```
resolve  →  collect  →  normalise  →  analyse  →  render
```

## Where this is

**A scan runs end to end.** One command takes a business name and postcode through resolve →
collect → normalise → analyse → render, writes every row the schema has a table for, and
produces a report. On fixtures today; on live providers as soon as there are keys.

```bash
npm run scan -- --name "Riverside Plumbing" --postcode "SW18 4AB" --fixtures
```

| Stage | State |
|---|---|
| Schema + closed taxonomy | ✅ 68 finding codes across 11 collectors, enforced against the docs and the SQL constraints |
| Resolve + competitor selection | ✅ |
| `gbp` · `reviews` · `sitetech` · `localrank` · `aivis` | ✅ |
| `speedtolead` | ◐ read-only — two of seven codes, contacts nobody ([why](docs/teardown-engine.md)) |
| Analyse — brief, LLM narrative, pre-render gate | ✅ |
| Render — full report + cold-outbound one-pager | ✅ |
| Real provider adapters | ✅ Places, DataForSEO, PageSpeed, three LLMs, site crawler |
| Persistence + scan runner + CLI | ✅ |
| Benchmark aggregation (A2's engine) | ✅ produces nothing until ~20 businesses, by design |
| A3 — AI visibility tracking, movement, alerts | ✅ needs 30 days of runs to prove |
| **Run on 10 real businesses** | ← next, needs keys |

**~11,500 lines of source, ~6,500 of tests, 539 tests passing.** `npm run check` runs typecheck,
the taxonomy consistency check and the full suite — with no API keys and no spend, because every
provider has a fixture implementation behind the same interface. `--fixtures` runs the whole
pipeline the same way.

### What the engine actually says

Against the fixture set, the subject comes out with: a **31-hour** reply against a competitor
best of **4 minutes**, **0.17 reviews a month** against a local median of 4.1, a model handing
customers the **wrong phone number**, median map-pack position **5** against a competitor best of
**1**, four unanswered two-star reviews, and a site served over plain http.

### The rules that shaped it

Most of the design work went into places where being wrong would be expensive in front of a
client, rather than into features:

- **A closed taxonomy.** Collectors emit codes from a fixed set. `npm run check:taxonomy` fails
  if the registry, the docs and the SQL constraints disagree.
- **Estimated never renders as verified.** Findings carry a confidence, the report styles and
  labels them differently, and the pre-render gate rejects a narrative that states an estimate
  as fact.
- **The LLM writes, it never fetches.** The analysis brief is built from findings only — there
  is no path from raw captures into it — and every claim must reference a real finding before
  the report will render.
- **Unknown is not the same as absent.** A field a source could not see stays undefined rather
  than becoming a zero. This is why `reviews` will not compute a rate from a five-review sample,
  why `sitetech` reports no INP without field data, and why the read-only probe never says a
  contact form works.
- **Sources fail independently.** A dead provider thins a section and records why; it never
  kills a scan.

### Not built, deliberately

- **Sending speed-to-lead enquiries** — deferred on social grounds, not technical ones. The
  collector, its taxonomy codes and its ethics guard are all built and tested; only the sender
  is absent, and the read-only probe covers what needs no contact.
- **Screenshots and client-rendered sites** — the only two things that genuinely need a browser.
  The crawler detects a JavaScript shell and refuses rather than reporting a good site as empty.
- **Warm mode, DTC collectors, benchmark claims, PDF export, any client-facing UI** — all out of
  the Phase 1 cut by design.

## Docs

| File | What's in it |
|---|---|
| [`CLAUDE.md`](CLAUDE.md) | **Start here.** Locked decisions, engineering rules, stack |
| [`docs/strategy.md`](docs/strategy.md) | Agency strategy, positioning, offer ladder, edge services |
| [`docs/roadmap.md`](docs/roadmap.md) | Both tracks, offer-ladder coverage table, ship criteria |
| [`docs/teardown-engine.md`](docs/teardown-engine.md) | The Phase A1 build spec |
| [`docs/delivery-system.md`](docs/delivery-system.md) | The human gate — how Tier 2 services ship |
| [`docs/finding-taxonomy.md`](docs/finding-taxonomy.md) | The closed finding code set |
| [`docs/schema.md`](docs/schema.md) | Data model |
| [`docs/data-sources.md`](docs/data-sources.md) | Providers, costs, ToS notes |

## Next step

**Run it on 10 real local businesses.** That needs keys in `.env` — copy
[`.env.example`](.env.example), which documents every variable and what it is for, then:

```bash
npm run check:keys -- --live
```

Four are required: `GOOGLE_PLACES_API_KEY`, `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` and
`ANTHROPIC_API_KEY`. The speed-to-lead identity variables are not needed while sending is
deferred.

The four ship criteria are in the [spec](docs/teardown-engine.md#9-phase-1-mvp), and none of them
can be signed off from here. One is budgeted rather than met — a scan is costed at £1.50–2.65
against a £5 ceiling, but `collector_runs.cost_pence` records actuals and only a real run proves
it. The other three need the reports to exist: that it runs unattended on ten businesses, that
every report carries two findings which are embarrassing, verifiable and previously unknown, and
that a stranger in the vertical would pay £500 for it.

From that point the spec is explicit: **iterate on report quality, not on code.**

## Commands

```bash
npm run check
```

Typecheck, the taxonomy consistency check, and 539 tests. No keys, no network, no spend.

```bash
npm run scan -- --name "Riverside Plumbing" --postcode "SW18 4AB" --fixtures
npm run scan -- --list
npm run benchmarks          # recompute percentiles across every scan so far
npm run check:keys -- --live

npm run visibility -- --track  --set trades.plumbing --note "what you changed"
npm run visibility -- --report --set trades.plumbing
```

Scans write to `.scans/` — the store, and a rendered report per scan. That directory is
gitignored, because it holds real businesses' data.
