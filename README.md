# marketingAgency

> Automate to increase throughput and margin, and price on outcome.

The build for an AI-first marketing agency run by a solo technical founder. Sells **systems**,
not hours.

**Current phase: A1 — the Research & Teardown Engine.** The pipeline is built end to end —
resolve, six collectors, analyse and render — and every source has a real adapter. `speedtolead`
runs read-only: sending enquiries is deliberately deferred on social grounds
([spec §4](docs/teardown-engine.md)), so it produces two of its seven codes and contacts nobody.
Nothing has run against a real business yet.

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

Phase 1 MVP, in order — schema + taxonomy ✅ → resolve ✅ → `gbp` ✅ → `reviews` ✅ →
`sitetech` ✅ → `localrank` ✅ → `speedtolead` ◐ → `aivis` ✅ → analyse + render ✅ →
**run on 10 real businesses ←**.

That last step needs keys in `.env` (see [`.env.example`](.env.example)). Every stage still
runs on fixtures with no keys and no spend, which is how the whole test suite works.

`speedtolead` runs read-only until sending is picked up again — a deliberate deferral rather
than an omission. It still reports a missing contact form and a missing tap-to-call number; what
it cannot do is measure a response time, which costs the report its sharpest finding.
[Spec §1](docs/teardown-engine.md) records what carries the conversion mechanic instead.

Ship criteria and the full cut are in the [spec](docs/teardown-engine.md#9-phase-1-mvp).
