# Build spec — Research & Teardown Engine

**Phase 1.** Status: in progress. The pipeline is built end to end, with real adapters for
every source but one — see [`data-sources.md`](data-sources.md#adapters). What remains is the
speed-to-lead probe (needs a monitored inbox), keys, and the run on 10 real businesses. See §9.

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
- Each collector owns one data source. `sitetech` is the single exception, with two — and it
  carries the failure handling that buys, see §3
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

Rule 2 is a claim about the *input*, so it is kept true in `lib/analyse/brief.ts`: the brief is
assembled from findings, the competitor set and the benchmark table, and there is no path from
`raw_captures` into it. Evidence is reduced to its key names — the renderer needs the values, the
writer does not, and passing them through would hand a model a page of captured markup to
paraphrase from. Everything the narrative should say about a measurement is already in
`measured`.

The gate that runs afterwards is in [`schema.md`](schema.md#validation-before-render), and the
render step calls it rather than trusting a caller to have done so.

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
| `reviews` | Reviews API — Places alone covers 2 of 6, see below | Volume, velocity, rating, recency, response rate, unanswered negatives |
| `sitetech` | Own crawl + PageSpeed Insights | CWV, mobile, indexation, schema, titles, broken links |
| `citations` | Directory lookups | NAP consistency across directories |
| `speedtolead` | Live test — see §4 | Measured response time, form health |
| `aivis` | LLM APIs — the model is the subject, see below | Citation share, competitor citations, incorrect claims, entity presence |

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

### What `reviews` needs from its source

A different split, and this one is about which provider you buy rather than warm access.

Places returns the aggregate rating and count plus **at most five reviews**, with no owner
replies. Volume and rating survive that, because they are aggregates the API states outright.
Velocity, recency and reply rate do not, because they are read off the review list — a
five-review sample cannot establish that the newest review is eight months old, only that the
newest one it returned is.

So the capture carries a `coverage` field (`complete` or `sample`) and the list-derived rules
skip when it is a sample, exactly as the warm-only `gbp` fields skip when undefined. Every
`reviews` code is `verified` in the taxonomy; a rate over five of two hundred reviews would be
an estimate wearing a verified label, which is the one thing rule 4 forbids.

The consequence is a purchasing decision, settled: **buy the full review history.** It runs
about ten pence a scan and it is what makes `REVIEW_VELOCITY_LOW` reachable cold — the strongest
finding in the local report, and the one a prospect cannot argue with. See
[`data-sources.md`](data-sources.md).

The one exception is `REVIEW_RESPONSE_ABSENT_NEGATIVE`, which runs on a sample too: each
unanswered one-star review is directly observed, so the count is verified even where it is only
a floor. The capture's `coverage` goes into the evidence so the benchmark pass can keep a floor
out of the percentiles.

### Two sources inside `sitetech`

Every other collector owns one source. `sitetech` owns two — our own crawl, and PageSpeed
Insights for field vitals — which is where "collectors fail independently" has to hold one level
lower than the rule states it.

Neither failure is exotic. PageSpeed is rate-limited and will refuse partway through a scan that
fans out over six targets; a crawl times out on a slow host. So `crawl` and `vitals` are
independently nullable on the capture, each half normalises on its own, and `source_errors`
records what went missing and why — otherwise a half-collected site reads in the report as a
healthy one.

Nine of the thirteen codes come off the crawl, four off PageSpeed. Losing either half costs that
section and nothing else.

### One purchase per keyword in `localrank`

Every other collector buys per business. `localrank` does not: one map pack query returns the
subject *and* every competitor in a single response, so the purchase is scan-level even though
the capture is per-target.

Left alone, the fan-out in §2.2 would buy the same ten queries once per target — £0.30 becoming
£1.80 against a £5 ceiling for the whole scan, for data already in hand. So the SERP provider is
wrapped once per scan and shared: the first target pays, the rest read the same response for
free, and `collector_runs.cost_pence` records what actually happened rather than a per-target
estimate. Concurrent targets share the in-flight request; a failed query is evicted so a later
target retries rather than inheriting the error.

The other rule worth knowing here: **position is measured over money keywords only.** A business
can rank second for a how-to article it wrote years ago while being invisible for every job in
the area, and letting that into the median turns a position of 5 into 3.5 — flattering the
number the whole section rests on. Directories are excluded from "outranked by a competitor" for
the same reason: a plumber does not lose work to Checkatrade.

### `aivis` and rule 2

CLAUDE.md rule 2 says the LLM writes and does not fetch. `aivis` calls LLM APIs, and that reads
like a contradiction until you notice which side of the rule it sits on: **here the model is the
thing being measured, not the analyst.**

We ask ChatGPT what it says about plumbers in Wandsworth and store the answer as raw data, the
same way `gbp` stores what Places returned. What rule 2 forbids is the *analysis* layer
retrieving facts to put in the narrative. Nothing here does that — these answers become findings
through the same closed taxonomy as every other source, and a model's claim is never treated as
true. The most valuable case is precisely when it is false.

`AIVIS_OUTDATED_FACT` is that case, and the taxonomy calls it the most attention-getting finding
in the report: a model telling a customer the wrong phone number is concrete, checkable in ten
seconds, and something almost nobody thinks to look for. It is also the rule most able to
embarrass *us*, so it only ever compares against a fact we actually hold, and it compares
loosely enough that `020 8000 2222` and `+442080002222` are the same number. Stating hours we
never learned is unverifiable, not wrong — the same discipline as the warm-only `gbp` fields.

Prompts are a scan-level purchase, cached exactly like `localrank`'s keywords. The entity check
is not: it asks about one named business, so caching it would hand every business the first
one's answer.

---

## 4. The `speedtolead` collector — read before changing

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

### Where the rule is enforced

In [`lib/collectors/speedtolead/ethics.ts`](../lib/collectors/speedtolead/ethics.ts), not here.

The reason it needs code rather than a paragraph is that **the measurement is identical either
way.** A mystery shop and a fabricated job produce the same two timestamps; nothing downstream
can tell them apart, and no test of the output would ever catch the difference. The only place
the distinction exists is in what we sent — so that is the only place it can be checked.

`assertGenuineEnquiry` refuses an enquiry with no named sender, no monitored reply address or
phone, no disclosure of who is asking, or a question that is not a question. It also refuses
phrasings that book work rather than ask something — a backstop for the likely mistake, not a
substitute for judgement when the enquiry text is written. `dispatchEnquiry` is the only path to
a submission and validates first, and the collector runs the same check at construction, so a
misconfigured identity stops before the first business is touched rather than after.

The one-test-per-business limit is a ledger in the collector, which is what makes `collect()`
safe to call twice: the enquiry goes out in minutes and the answer comes back in hours, so the
stage runs once to submit and again after the wait. The second run polls the inbox and writes to
nobody.

Silence is handled the same way. `window_closes_at` is what separates "they have not replied
yet" from "they never replied" — before it, a quiet business produces no finding at all, because
reporting it would be reporting our own impatience as their failure.

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
(Fly.io / Railway).

Still open, and now much smaller than it looked. `sitetech` is written against a `SiteCrawler`
interface, and the adapter behind it — [`lib/adapters/crawler.ts`](../lib/adapters/crawler.ts) —
is plain HTTP plus an HTML parser. Titles, duplicate titles, schema, indexation, broken links,
thin content, sitemap and HTTPS are all read out of markup. **Nine of the thirteen codes need no
browser at all.**

A browser is needed for exactly two things:

1. **Screenshots.** Evidence, not findings. Every finding renders without one; a screenshot
   makes some of them more persuasive.
2. **Client-rendered sites.** A marketing site that ships an empty `<body>` and paints itself
   with JavaScript is unreadable to a fetch. The crawler detects that shape and *refuses*,
   raising `ClientRenderedSite` — the collector records it in `source_errors` and the section
   goes missing with a reason. Reporting such a site as having no title, no content and no
   structured data would be three false findings against a site that is fine.

So the question is no longer "how do we deploy the crawler" but "when do we want screenshots and
JS-rendered sites". That can wait until the ten real scans show how often the second case comes
up.

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
| Review history | ~£0.10 |
| SERP API (10 keywords) | ~£0.30 — per scan, not per target |
| PageSpeed Insights | free |
| Own crawl | negligible |
| Speed-to-lead test (form probe + one call) | ~£0.03 |
| AI visibility (8 prompts × 3 models) | ~£0.30 |
| LLM analysis (~150k in / 15k out) | ~£0.60 |
| **Total** | **~£1.50 – 2.65** |

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

1. ✅ Schema + taxonomy + finding types — everything else depends on these
2. ✅ Resolve stage + competitor selection
3. ✅ `gbp` and `reviews` (cheapest to verify, immediate signal)
4. ✅ `sitetech` — written behind a crawler interface; the Playwright deployment decision
   moved to the adapter, see §7
5. ✅ `localrank`
6. ✅ `speedtolead` — the conversion mechanic. Ethics enforced in code, see §4
7. ✅ `aivis` — the differentiator. See the rule-2 note in §3
8. ✅ Analyse + render — the pre-render gate is in `lib/analyse/validate.ts`, see
   [`schema.md`](schema.md#validation-before-render)
9. Run on 10 real businesses ← **next**; iterate on report quality, not on code. Needs the
   real provider adapters and the §7 Playwright decision first

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
