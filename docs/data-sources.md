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
| Business listings, reviews | Google Places API | ~£0.15/scan | Clean, official |
| SERP + map pack position | DataForSEO / Serper / SerpAPI | ~£0.30/scan | Clean, pick one |
| Core Web Vitals | PageSpeed Insights API | Free | Clean, rate-limited |
| Site crawl | Own Playwright worker | Infra only | Respect `robots.txt` |
| Tech stack detection | Own — inspect page | Free | Clean |
| AI visibility | Anthropic / OpenAI / Perplexity APIs | ~£0.30/scan | Clean |
| LLM analysis | Anthropic API | ~£0.60/scan | — |
| Ad library (DTC) | Reseller | ~£1/scan | ⚠️ See below |
| Directory citations | Mixed | ~£0.10/scan | Check per-directory terms |

## Cost per cold SMB scan

1 subject + 5 competitors: **~£1.35 – 2.50**. DTC adds ~£1. Budget **£2–5**.

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
