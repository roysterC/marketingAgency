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
| Review history | DataForSEO / equivalent | ~£0.10/scan | Clean. Places alone is not enough — see below |
| SERP + map pack position | DataForSEO / Serper / SerpAPI | ~£0.30/scan | Clean, pick one. Bought once per scan, not once per target |
| Core Web Vitals | PageSpeed Insights API | Free | Clean, rate-limited |
| Site crawl | Own Playwright worker | Infra only | Respect `robots.txt` |
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

## The `speedtolead` exception

This collector contacts real businesses. Ethics rules are in the spec (§4) and are not optional:
genuine, identified enquiries only — a mystery shop, never a fabricated job.

## Keys and secrets

All provider keys in environment variables, never committed. `.env.example` documents the
required set without values.
