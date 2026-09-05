# Data sources

## The rule: buy data, don't scrape it

Paid APIs over scraping Google, Trustpilot or Yelp. It costs ~£2–5 per scan — noise against a
£500–1,500 product — and it buys removal of ToS risk plus reliability you don't have to
maintain. Scraping saves a few pounds and puts the business itself at risk.

This is a settled decision. See `../CLAUDE.md`.

---

## Providers

| Source | Provider | Cost | Status |
|---|---|---|---|
| Business listings | Google Places API | ~£0.15/scan | Clean, official |
| Review history | DataForSEO | ~£0.10/scan | Clean. Places alone is not enough — see below |
| SERP + map pack position | DataForSEO | ~£0.30/scan | Clean. Bought once per scan, not once per target |
| Core Web Vitals | PageSpeed Insights API | Free | Clean, rate-limited |
| Site crawl | Own fetch crawler | Infra only | Respect `robots.txt`. A browser is only needed for screenshots and client-rendered sites |
| Tech stack detection | Own — inspect page | Free | Clean |
| AI visibility | Anthropic / OpenAI / Perplexity APIs | ~£0.30/scan | Clean |
| LLM analysis | Anthropic API | ~£0.60/scan | — |
| Ad library (DTC) | Reseller | ~£1/scan | ⚠️ See below |
| Directory citations | Mixed | ~£0.10/scan | Check per-directory terms |

## Why reviews need their own source

The Places API returns the aggregate rating and count alongside **at most five reviews**, and it
does not expose owner replies at all. That covers two of the six `reviews` findings — volume and
rating, both aggregates the API states outright — and no more.

Velocity, recency and reply rate are read off the review *list*. A five-review sample cannot
establish that the newest review is eight months old, only that the newest one it happened to
return is; and a reply rate over five of two hundred reviews is not a rate. All six codes are
`verified` in the taxonomy, so those rules skip rather than estimate — the capture carries a
`coverage` field and normalise gates on it.

A reviews API returns the full history with replies, still as bought public data rather than
scraping. It costs roughly ten pence a scan and it is what makes `REVIEW_VELOCITY_LOW` — the
strongest local finding the engine produces — reachable in cold mode. Not a close call.

## Cost per cold SMB scan

1 subject + 5 competitors: **~£1.50 – 2.65**. DTC adds ~£1. Budget **£2–5**.

Track actuals in `collector_runs.cost_pence` from day one — the cold-outbound economics depend
on this number staying low, and it will drift as collectors get added.

---

## ⚠️ Meta Ad Library

The one genuinely awkward source. The official Ad Library API is restricted to political and
issue ads; commercial ad data comes via resellers or the public UI.

**Before the `paidcreative` collector becomes load-bearing for the DTC product, read the terms
properly.** Don't build the DTC offer on a source you might have to remove. This is flagged as
an open question in the spec.

## Crawl etiquette

The `sitetech` and `store` collectors hit real sites. Non-negotiable:

- Respect `robots.txt`
- Identifiable user agent with a contact URL
- Rate limit per host; a scan should be invisible in someone's access log
- Never crawl behind auth in cold mode

All four are implemented rather than intended, in
[`lib/adapters/crawler.ts`](../lib/adapters/crawler.ts) and
[`lib/adapters/robots.ts`](../lib/adapters/robots.ts), and each has a test.

`contactUrl` is a **required** config field with no default, because "identifiable" is not
something to leave to a constant someone forgets to change. Robots governs the link checker
as well as the page walk — a disallowed path goes unchecked, and therefore unreported, since
calling a link broken without having fetched it would be a fabricated finding.

Note that robots.txt is read for two unrelated purposes and the two must not be confused.
`isAllowed` in the adapter asks *may we fetch this* — an obligation on us. `blocksEverything`
in the sitetech normaliser asks *is this site hiding from search engines* — a finding about
them. A site that shuts us out is still reported as blocked; we simply do not crawl it first.

## The `speedtolead` exception

This collector contacts real businesses. Ethics rules are in the spec (§4) and are not optional:
genuine, identified enquiries only — a mystery shop, never a fabricated job.

**Sending is deferred as of 2026-09-06** on social grounds rather than technical ones. Nothing
is being contacted until that is revisited. See the adapter note below.

## Keys and secrets

All provider keys in environment variables, never committed.
[`.env.example`](../.env.example) documents the required set without values, and
[`lib/adapters/config.ts`](../lib/adapters/config.ts) is the only place that reads them — a
test checks the two against each other, so a credential added in one and forgotten in the
other fails the build rather than someone else's first scan.

A missing required key fails at adapter construction, naming the variable and what it is
for. It should never surface as a 401 halfway through a scan that has already spent money.

## Adapters

| Interface | Adapter | Notes |
|---|---|---|
| `PlacesProvider`, `GbpProvider` | `lib/adapters/places.ts` | One client, two field masks. Places (New) bills by mask, so widening one widens every scan |
| `ReviewsProvider` | `lib/adapters/dataforseo.ts` | Task-based: post, poll, collect. Falls back to the Places five-review sample |
| `SerpProvider` | `lib/adapters/dataforseo.ts` | Live endpoint, one call per keyword per scan |
| `VitalsProvider` | `lib/adapters/pagespeed.ts` | Free, rate-limited. Field data first, lab data as fallback |
| `AivisProvider` | `lib/adapters/aivis.ts` | Claude via SDK, GPT and Perplexity via the chat-completions shape |
| `NarrativeWriter` | `lib/adapters/writer.ts` | Claude with a structured output schema |
| `SiteCrawler` | `lib/adapters/crawler.ts` | Fetch + HTML parse. Nine of thirteen sitetech codes; no browser |
| `SpeedToLeadProbe` | `lib/adapters/speedtolead.ts` | **Read-only.** Two of seven codes; contacts nobody. Sending deferred — see below |

Every one of them takes an injectable `fetch` or client, so the whole set is tested without
a network call or a key.

### The read-only speed-to-lead probe

Sending enquiries is deferred (2026-09-06) on social grounds rather than technical ones. What
runs instead is a probe that **contacts nobody** and establishes the two codes that only need
looking at a site:

| Code | Established by |
|---|---|
| `STL_NO_FORM_ON_SITE` | Is there a form a customer could write through? |
| `STL_NO_PHONE_VISIBLE_MOBILE` | Is there a `tel:` link to tap? |
| The other five | Sending an enquiry or placing a call — not built |

**The safety property is structural, not a promise.** `inspect()` reports
`form_status: null` — *not established* — and the collector only calls `submit()` when that
reads `ok`. The sending path is never entered rather than entered and refused. `submit()`
throws anyway as a second line, and `call` is simply absent so the phone test is never
attempted. A test asserts the collector produces no submission, no response window and no
phone test against a site that has a working-looking form.

Two deliberate weakenings, both in the direction of under-reporting:

- **A form is never reported as working.** That takes sending. `STL_FORM_BROKEN` — the most
  valuable code the engine has — stays unreachable.
- **The fold cannot be seen.** `phone_visible_mobile` is read as "a `tel:` link exists at
  all", so a number buried in the footer clears the finding. No link anywhere means there is
  definitely nothing tappable above the fold, which is the only direction it can be certain in.

Detecting a form at all needs care: a search box is not a contact form, and neither is a lone
email input, or `STL_NO_FORM_ON_SITE` would never fire on the many sites that have a newsletter
box and no way to reach anyone.

When sending is picked up again, one thing to carry forward: the sender must not exist before
the monitored inbox and phone number in `.env.example` do. The ethics guard checks that an
identity was *configured*, not that anyone is *reading* it — so a sender alone would make it
possible to contact two hundred businesses from an address nobody answers.
