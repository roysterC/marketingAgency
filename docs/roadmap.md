# Roadmap

Two tracks, different triggers.

- **Track A — Product.** Sequential and self-paced. You choose when each phase starts.
- **Track B — Delivery.** Triggered by client signings, never by the calendar.

**Track B interrupts Track A.** A paying client outranks the next tool. The first delivery
trigger fires the moment Phase A1 converts its first retainer — that's month two, not month
eight.

Governing principle, unchanged: **build tooling only for offers that have already sold at least
once.** Track B exists because delivery capability is sold the instant a retainer is signed.

---

## Coverage

Every capability the offer ladder sells maps to something below. Keep this table honest — it is
the check that catches a gap before a client does.

| Package | Capability | Where it's built |
|---|---|---|
| Audit / teardown | Teardown engine | A1 |
| Local SMB | Local SEO execution | D1 |
| Local SMB | Review engine | D1 |
| Local SMB | Content / local pages | D1 (gated) |
| Local SMB | Speed-to-lead | A4 |
| DTC | Creative volume | D2 (gated) |
| DTC | Paid / PPC | D2 (gated) |
| DTC | Retention / lifecycle | D2 (gated) |
| DTC | Measurement | A5 |
| System build | AI visibility tracker | A3 |

Tier 3 work from [`strategy.md`](strategy.md) appears nowhere by design — it's human judgment,
not built capability.

---

# Track A — Product

## A1 — Research & Teardown Engine ← current

**Why first:** it is three things at once — free lead magnet, paid audit product (£500–1,500),
and live sales demo. It's the only asset that pays for itself before you have clients.

Spec: [`teardown-engine.md`](teardown-engine.md)

**Scope:** cold-mode scan, one local vertical, six collectors, LLM narrative, HTML report.

**Ship criteria**
- Runs end to end on 10 real local businesses without manual intervention
- Every report contains ≥2 findings that are embarrassing, verifiable and previously unknown
- Cost per scan under £5
- A stranger in the target vertical would pay £500 for it

---

## A2 — Benchmarks & competitor comparison

Turn accumulated scans into the thing nobody else has.

- Aggregate findings into vertical/region percentiles
- Reports shift from "you're slow" to "you're bottom-quartile among trades in your region"
- Re-normalise historical raw captures against improved rules

**Ship criteria:** 50+ scans in one vertical; benchmark claims survive spot-checking.

---

## A3 — AI Visibility Tracker (edge service #1) ← built, not yet proven

Promote the `aivis` collector into a standalone monitored product.

- Prompt sets per vertical, tracked on a schedule rather than one-shot ✅
- Citation share-of-voice over time, competitor citation tracking ✅
- Alerting on visibility loss ✅
- Sold as its own retainer — not yet

**Ship criteria:** tracking your own agency's prompts for 30 days, with a movement you can
attribute to something you changed.

The code is in [`lib/visibility/`](../lib/visibility/), run with `npm run visibility`. What
remains is **elapsed time**, which is the one thing that cannot be built: the criterion needs
thirty days of runs. Start the clock early — it is the only phase gated on the calendar rather
than on work.

Two things the implementation had to get right, both recorded in
[`movement.ts`](../lib/visibility/movement.ts):

- **Models are not deterministic.** Share moves a few points run to run with nothing having
  changed, so the baseline is the median of a window of earlier runs rather than the previous
  run. A tracker that alerts on noise gets switched off in a fortnight.
- **A changed prompt set is not a movement.** Edit the questions and every share shifts because
  you asked something different. Runs that are not comparable are excluded from the baseline
  rather than charted as change.

Scheduling itself is deliberately not built. `--track` is idempotent and cheap, so a cron entry
is the whole of it, and a scheduler before a second caller would be tooling ahead of the offer.

---

## A4 — Speed-to-Lead System (edge service #2)

The teardown proves the problem; this sells the fix.

- Voice, SMS, web chat capture
- Calendar booking
- Templated once, resold per client
- Reports back into the teardown as before/after proof

**Ship criteria:** one paying client live, with measured response-time improvement.

---

## A5 — Measurement & attribution (edge service #3)

Server-side tracking, GA4 done properly, blended ROAS/MER dashboards.

**Ship criteria:** one DTC client where you are the agreed source of truth on performance.

---

## A6 — Site, offer pages, pricing

**Last.** A site built before the offer is settled is a site you rebuild. By this point the
teardown output *is* the marketing material.

---

# Track B — Delivery

The production line for retainer work. Spec: [`delivery-system.md`](delivery-system.md).

Each stage is triggered by a client event. Do not build ahead of the trigger — that's
speculative tooling. Do not build behind it either; by then you've already sold the work.

---

## D0 — The gate · *trigger: client #1*

The approval system itself. **Must exist before any Tier 2 work ships to anyone.**

- One review queue across all clients
- Draft state machine: `generated → in_review → approved → scheduled → published`
- Per-client voice profile and compliance constraints
- Never-automate allowlist enforced as config
- Approval-minutes tracked against the <5 hrs/client/month budget

At clients 1–3 this is Airtable/Notion plus a scheduled job, not software. The states and the
discipline matter more than the tooling. See the staging table in `delivery-system.md`.

**Ship criteria:** nothing reaches a client without passing a recorded approval state, and you
can answer "what shipped for this client last month, and who approved it" from one place.

---

## D1 — SMB delivery · *trigger: first SMB retainer*

Covers the Local SMB package. The teardown that sold the client becomes the work plan — its
findings seed the backlog, which is why the audit and the delivery share a data model.

| Capability | Automation | Gate |
|---|---|---|
| Local SEO execution | GBP updates, citation fixes, location pages at scale | Publish approval |
| Review engine | Request sequences, response drafting | Responses approved before send |
| Local content | Draft generation from findings | Full edit before publish |

**Ship criteria:** one SMB client delivered for a full month inside the 5-hour budget, with
every output traceable to an approval.

---

## D2 — DTC delivery · *trigger: first DTC retainer*

Covers the DTC growth package.

| Capability | Automation | Gate / hard block |
|---|---|---|
| Creative volume | Variant generation, hooks, angles, UGC-style video | Concept direction stays human |
| Paid / PPC | Search term mining, negative lists, pacing alerts, bid rules | **Hard-blocked:** offer strategy, account structure, campaign kill decisions |
| Retention / lifecycle | Flow generation, segmentation | Every send approved |

**Ship criteria:** one DTC client delivered for a full month with the PPC hard-blocks enforced
in config, not by memory.

---

## Deliberately not on this roadmap

Social media management as a core offer. Standalone web design. Anything requiring hiring.
Custom AI builds beyond the three edge services — that's a strategic fork to take consciously,
not drift into.
