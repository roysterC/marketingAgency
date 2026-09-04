# Build spec — Research & Teardown Engine

**Phase 1.** Status: specced, not started.

---

## 1. What it is

A pipeline that takes a business — name + postcode, or a domain — and produces a competitive
teardown that would take an agency two weeks. Target run time under 20 minutes (excluding
deliberate wait windows), target cost under £5.

### Three jobs, one system

It has to serve all three from day one, and that constrains the architecture more than the
feature list does:

| Job | Mode | What it needs |
|---|---|---|
| Cold outbound lead magnet | Cold | Zero access. Public data only. Cheap enough to run 200× |
| Paid audit product (£500–1,500) | Warm | Client grants analytics/ads/GBP access. Deeper |
| Live sales demo on a call | Cold | Fast enough to run while talking |

If you build only for warm mode you get a nice audit tool. **The cold-mode requirement is what
makes it a business** — you can run it on 200 plumbers before speaking to any of them.

### The conversion mechanic

The report must produce **two or three findings that are embarrassing, instantly verifiable and
previously unknown.** Impressive-but-abstract does not sell. This does:

> We submitted your website contact form on Tuesday at 10:14. Nobody replied for 31 hours.
> Your nearest competitor replied in 4 minutes.

Undeniable, it stings, and it sells edge service #2 in one line. Design backwards from this —
the `speedtolead` collector is the highest-value part of the system even though it is not the
most technically interesting.

---

## 2. Pipeline

```
resolve  →  collect  →  normalise  →  analyse  →  render
```

Each stage is a queue step. Stages are independently retriable.

### 2.1 Resolve

Input: business name + postcode, or a domain.

Output: a `scan` with `scan_targets` — the subject plus 3–6 competitors.

- Resolve website, GBP listing, social handles, platform (Shopify / Woo / WordPress / custom)
- Select the competitor set

**Competitor selection is the highest-leverage decision in the pipeline.** Get it wrong and
every comparison downstream is meaningless. For local: businesses ranking in the map pack for
the subject's money keywords within radius, filtered to the same primary category. For DTC:
overlapping category SERP + shared ad-library keywords. Store *why* each competitor was chosen
— it goes in the report, and it's the first thing a sceptical prospect challenges.

### 2.2 Collect

Fan out: one job per `(collector × target)`.

Rules:
- Each collector owns exactly one data source
- Each returns raw structured JSON, persisted to `raw_captures`
- Each declares `requires_auth` — cold mode runs the subset that doesn't
- **Each fails independently.** A dead source degrades a report; it never kills a scan
- Each records cost, duration and status in `collector_runs`

### 2.3 Normalise

Separate step. Maps `raw_captures` → `findings` using the closed taxonomy.

**Why this is separate:** raw capture is the expensive part and the rules will change
constantly. Keeping them apart means you can re-normalise every historical scan against
improved rules for free, which also back-fills benchmarks. Do not let collectors emit findings
directly.

### 2.4 Analyse

LLM writes the narrative over the structured findings.

- Input: findings + benchmarks + competitor set. **Never raw HTML, never live retrieval.**
- Output: executive summary, per-section narrative, prioritised recommendations
- The model may rank, group, phrase and explain. It may not introduce a fact that isn't in a
  finding
- Every claim in the narrative must reference a `finding_id`. Unreferenced claims are a bug —
  validate this before render

### 2.5 Render

- Full HTML report (and PDF), branded
- One-page variant for cold outbound
- Every finding renders its evidence: a screenshot, a URL, a timestamp, a raw value

---

## 3. Collectors

`requires_auth: false` unless noted. SMB set is Phase 1; DTC set is Phase 4-adjacent.

### Shared

| Collector | Source | Emits |
|---|---|---|
| `gbp` | Google Places API (cold) / Business Profile API (warm) | Listing completeness, categories, hours, photos, attributes — plus claim status, services, posts and Q&A in warm mode only |
| `localrank` | SERP API | Map pack + organic position across a keyword set |
| `reviews` | Places API + platform | Volume, velocity, rating, response rate, unanswered negatives |
| `sitetech` | Own crawl + PageSpeed Insights | CWV, mobile, indexation, schema, titles, broken links |
| `citations` | Directory lookups | NAP consistency across directories |
| `speedtolead` | Live test — see §4 | Measured response time, form health |
| `aivis` | LLM APIs | Citation presence across buying prompts |

### DTC-only

| Collector | Source | Emits |
|---|---|---|
| `paidcreative` | Ad library data | Creative volume, staleness, format mix, offer variation |
| `store` | Own crawl | PDP quality, trust signals, checkout, collection filters |
| `lifecycle` | Real inbox subscribe | Welcome/abandon flows, first-send latency, SMS capture |
| `measurement` | Page inspection | Server-side tracking, GA4 config, conversion events |

### Warm-mode only (`requires_auth: true`)

GA4, Google Ads, Meta Ads, Search Console, Klaviyo. Phase 2+.

### The cold/warm split inside `gbp`

Worth knowing before pricing the cold audit: **the Places API does not expose everything a
Business Profile contains.** Claim status, the services list, posts and Q&A all come from the
Business Profile API, which needs the owner's authorisation.

So 6 of the 10 `gbp` codes are reachable cold; 4 are warm-only
(`GBP_UNCLAIMED`, `GBP_NO_SERVICES_LISTED`, `GBP_POSTS_STALE`, `GBP_QNA_UNANSWERED`).

This is handled by making those fields optional on the raw capture rather than absent: a cold
provider leaves them undefined and normalise skips the rules, a warm provider populates them
and the same rules light up. Reporting "0 services listed" when we simply couldn't see them
would be a false finding in a paid report.

Commercially this is useful rather than limiting — it gives the free cold teardown a concrete
reason to convert. "Four more checks run once you grant access" is a better upsell than a
vaguer promise, and it's honest about why.

---

## 4. The `speedtolead` collector — read before building

This collector contacts real businesses. That makes it the highest-value module and the one
with a real ethical line running through it.

**The rule: the enquiry must be genuine and identified.**

- ✅ A real question from a named, real inbox: *"Do you cover SW18? What's your callout fee?"*
- ❌ A fabricated job that sends someone to quote work that doesn't exist

The first is a mystery shop — a legitimate, long-established practice, and it measures response
time truthfully. The second wastes a tradesperson's afternoon and is indefensible if it ever
surfaces. Build the first; the measurement is identical.

Implementation constraints:
- One test per business per scan. Hard rate limit
- Real monitored inbox and phone number, attributable to the agency
- Log the exact submission timestamp and the exact first-response timestamp as evidence
- Response window: 48h. Emit `STL_FORM_NO_REPLY` if nothing arrives
- If the form errors, that's `STL_FORM_BROKEN` — the single most valuable finding the engine
  can produce
- In warm mode the client has consented, so none of this applies

---

## 5. Data model

Full DDL in [`schema.md`](schema.md). Core tables:

```
businesses       resolved entities
scans            one run
scan_targets     subject + competitors, with selection rationale
collector_runs   per-collector status, timing, cost, error
raw_captures     unprocessed source responses (re-normalisable)
findings         normalised output, closed taxonomy
evidence_assets  screenshots and captures (object storage refs)
benchmarks       aggregated vertical/region percentiles  ← the moat
reports          rendered output, versioned
prompt_sets      AI visibility prompts per vertical
```

### The finding shape

```ts
{
  code: 'STL_FORM_SLOW_REPLY',      // closed taxonomy
  collector: 'speedtolead',
  severity: 'critical',              // critical | high | medium | low | info
  confidence: 'verified',            // verified | estimated  ← hard distinction
  measured: { value: 31.2, unit: 'hours' },
  benchmark: { value: 0.5, source: 'competitor_best' },
  evidence: {
    submitted_at: '2026-09-01T10:14:00Z',
    responded_at: null,
    form_url: 'https://…/contact',
    screenshot: 'evidence/…png'
  }
}
```

`confidence` is not decoration. Ad spend is `estimated`. A response time you measured is
`verified`. The renderer styles them differently and the narrative must hedge estimates.

---

## 6. Benchmarks — the moat

Every scan writes into `benchmarks`. Worthless at run #1, decisive by month six.

Run #1: *"Your review velocity is 0.4/month."*
Run #50: *"You're in the bottom quartile for review velocity among trades in your region."*

No competitor can make the second claim, because they don't have the dataset. **This is why the
schema must support it before the first commit** — retrofitting means re-scanning everything.

Aggregate on `(vertical, region, code, metric)` → p25/p50/p75 + sample size. Suppress benchmark
claims below a minimum sample size (start at 20) and say so rather than quoting a shaky
percentile.

---

## 7. Stack

| Concern | Choice | Why |
|---|---|---|
| Web / API / report | Next.js App Router | Matches existing projects |
| Data | Supabase Postgres | Findings, benchmarks, raw captures |
| Queue | Inngest | Multi-step, long-running fan-out with retries — exactly this pipeline, and it works on serverless |
| Browser work | Playwright on a dedicated worker | Crawl + screenshots |
| Object storage | Supabase Storage | Evidence assets |

**The one real architectural constraint:** Playwright crawl and screenshot work does not fit
Vercel functions. Either use a browser service (Browserless) or run a small always-on worker
(Fly.io / Railway). Decide this before writing the `sitetech` collector, because it shapes how
collectors are deployed.

### Repo layout

Keep it simple — solo founder, no monorepo on day one.

```
/app          Next.js — dashboard, API routes, report rendering
/lib
  /collectors one module per collector
  /taxonomy   finding codes + shared types
  /db         schema, migrations, client
  /report     templates
/worker       Playwright service (separate deploy)
/docs
```

---

## 8. Cost per scan

Cold SMB scan, 1 subject + 5 competitors:

| Item | Est. |
|---|---|
| Places API | ~£0.15 |
| SERP API (10 keywords) | ~£0.30 |
| PageSpeed Insights | free |
| Own crawl | negligible |
| AI visibility (8 prompts × 3 models) | ~£0.30 |
| LLM analysis (~150k in / 15k out) | ~£0.60 |
| **Total** | **~£1.35 – 2.50** |

DTC adds ad-library data (~£1). Budget **£2–5 per scan**. Against a £500–1,500 product that is
noise, and it's still viable at cold-outbound volume.

---

## 9. Phase 1 MVP

Cut hard. Ship this, then extend.

- **One vertical** (trades or clinics), UK, cold mode only
- **Six collectors:** `gbp`, `localrank`, `reviews`, `sitetech`, `speedtolead`, `aivis`
- LLM narrative + HTML report
- Manual scan trigger from a simple internal dashboard — no self-serve, no auth, no billing

Explicitly **not** in MVP: DTC collectors, warm mode, benchmarks (schema only, no claims yet),
PDF export, outbound automation, client-facing UI.

### Ship criteria

1. Runs end to end on 10 real local businesses with no manual intervention
2. Every report contains ≥2 embarrassing, verifiable, previously-unknown findings
3. Cost per scan under £5
4. A stranger in the target vertical would pay £500 for it

### Build order within the phase

1. Schema + taxonomy + finding types — everything else depends on these
2. Resolve stage + competitor selection
3. `gbp` and `reviews` (cheapest to verify, immediate signal)
4. `sitetech` — forces the Playwright deployment decision
5. `localrank`
6. `speedtolead` — the conversion mechanic
7. `aivis` — the differentiator
8. Analyse + render
9. Run on 10 real businesses; iterate on report quality, not on code

---

## 10. Open questions

Settle these before or during build. None block starting on step 1.

- **Vertical:** trades or clinics? Clinics have higher lead value; trades have worse response
  times and no compliance exposure. Trades is the safer first pick
- **Ad library access** for the DTC phase — official API is restricted to political/issue ads.
  Reseller vs public UI needs a ToS read before that module becomes load-bearing
- **Report delivery** — is the cold-outbound one-pager a PDF attachment or a hosted link?
  Hosted gives you open tracking and lets the report update
- **Benchmark minimum sample size** — starting assumption 20, needs validation
- **Re-scan cadence** for existing clients — monthly is the obvious default and feeds Phase 2
