# Agency strategy

Status: **locked** as of 2026-09-04. Changes need an explicit decision, not a drift.

## The thesis

A non-technical founder can only *use* AI tools — the same tools competitors and eventually
clients will have. A technical founder can build assets neither can replicate. That difference
is the entire basis for what this agency charges.

**The trap to avoid:** positioning as "the same services, but cheaper because AI." It is a race
to zero, it teaches clients the work is low-value, and the moat evaporates the moment the tools
get one notch easier. Automate for throughput and margin, then price on outcome.

## Profile

- **Market:** local SMBs + e-commerce/DTC
- **Structure:** solo, founder-led with contractors
- **Edge:** technical — can build
- **Binding constraint:** revenue per head

## What to automate

### Tier 1 — automate aggressively
High volume, repetitive, verifiable against something objective.

| Service | AI does | You keep |
|---|---|---|
| Research & competitor analysis | Ad-library scraping, SERP/keyword clustering, review mining, teardowns | The decision that comes out of it |
| Technical SEO | Crawls, schema, internal linking, CWV, log analysis | Prioritisation and implementation calls |
| Local SEO (SMB) | GBP optimisation, citations, location pages at scale, review sequences | Very little — highest-margin SMB service |
| Creative volume (DTC) | Hundreds of ad variants weekly, UGC-style video, hooks and angles | Concept direction, brand guardrails |
| Reporting | Dashboards, anomaly detection, plain-English narratives | The monthly conversation |
| Web build (SMB) | Whole-site generation, copy, layout, deploy | Design taste, CRO decisions |

### Tier 2 — automate behind a human gate
AI does 80%, nothing ships unapproved. Failure here is invisible until it's expensive.

> **How this is actually delivered:** [`delivery-system.md`](delivery-system.md), built in
> Track B of the [roadmap](roadmap.md). The gate is a system with enforced state transitions,
> not a habit — at fifteen clients an ad-hoc gate becomes either rubber-stamping or a blown
> hours budget.

- **Content & copywriting** — AI drafts, human edits for differentiation. Mass unedited AI
  content is a live ranking and reputation liability.
- **PPC** — automate search-term mining, negative lists, pacing alerts, bid rules. Never
  automate offer strategy, account structure, or the decision to kill a campaign.
- **Social content production** — automate drafting, repurposing, scheduling. Never automate
  replies and DMs; brand-voice failures happen in public.
- **Email/SMS lifecycle** — automate flow generation and segmentation, approve every send.

### Tier 3 — keep human
Strategy, positioning, offer design, client relationships, pricing, anything with compliance
exposure (health, finance, legal), and accountability when something goes wrong.

### Deprioritised
- **Social media management** — commoditised, low margin, high touch. Bolt-on or decline.
- **Web design as a standalone product** — great land offer and great infrastructure to keep
  controlling. Terrible thing to compete on price for.

## Edge services

Ranked. Pick three, not six.

1. **AI search visibility (AEO/GEO)** — *the wedge.* Getting brands cited in ChatGPT, AI
   Overviews, Perplexity, Copilot. Every SEO client is asking; most agencies are bluffing
   because they have no measurement. Building the measurement is the moat.
2. **Speed-to-lead / AI reception** — *the profit engine.* Local SMBs lose leads to unanswered
   phones, not bad marketing. Build fee + monthly, extremely sticky, ROI proves itself.
3. **Measurement & attribution** — *the retention lock.* Attribution broke for small brands
   post-iOS. Being the source of truth on performance makes you very hard to fire.

Behind those, worth having but not worth starting with: retention/lifecycle (DTC), creative
testing as a service, custom AI builds.

## Positioning

> We build the growth systems small brands can't hire for.

Not "AI marketing agency" — crowded, vague, and it makes AI the product. AI is *how* you
deliver, not *what* you sell.

## Offer ladder

| Rung | Price | Notes |
|---|---|---|
| Audit / teardown | £500 – 1,500 | AI-generated in hours. Qualifies the client, demos the machine |
| Local SMB package | £750 – 1,500/mo | Local SEO + reviews + speed-to-lead. Target <5 hrs/client/mo |
| DTC growth package | £2,500 – 6,000/mo | Creative volume, paid, retention, measurement as one loop |
| System build | £3–10k + £300–1,000/mo | Reception agent, visibility tracker, attribution stack |

## The solo arithmetic

```
20 clients (max)  ×  ~£1,800 avg/mo   =  ~£36k /mo
20 clients        ×  <5 hrs each      =  ~100 hrs /mo delivery
```

Twenty seats is the whole inventory. Be selective early rather than taking every £500 client.
Pricing is indicative — verify against local market rates.

## Sequencing

Start with **one vertical** inside local SMB (trades or clinics — high lead value, famously bad
response times). The systems only compound if clients look alike; ten identical businesses are
worth more than ten interesting ones. Add DTC once SMB delivery runs itself.

## Risks to design around

- **AI content penalties** — the Tier 2 human gate is not optional
- **Regulated verticals** — clinics, finance, legal need claim review built into the workflow
- **Scraping and ToS** — buy data, don't scrape it. See `data-sources.md`
- **Client disclosure** — "AI-assisted, human-approved" is defensible; concealment isn't
- **Commoditisation** — anything you automate, clients can eventually automate. The durable
  moat is accumulated proprietary data plus accountability, never the tooling
