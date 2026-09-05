# Finding taxonomy

**Closed set.** Collectors emit only these codes. The LLM never invents a finding type.

This is what keeps report quality consistent across runs and makes benchmarking possible — you
cannot compute a percentile over free text.

## Source of truth

[`lib/taxonomy/findings.ts`](../lib/taxonomy/findings.ts) is authoritative. This document is
the human-readable view of it, and `npm run check:taxonomy` fails if the two disagree — so a
code cannot be added in one place and forgotten in the other.

The registry carries three fields beyond the tables below, needed by the benchmark layer:

| Field | Purpose |
|---|---|
| `unit` | Unit of the measured value — `hours`, `per_month`, `position`, `none` for binary findings |
| `polarity` | Which direction is good. Without it a percentile is meaningless: 0.4 reviews/month is bottom-quartile, 0.4 hours to reply is top-quartile |
| `segments` | Which package the code applies to — drives which collectors a scan runs, and which of their codes are emitted |
| `benchmarkable` | Whether the value can feed `benchmarks`. Binary findings have nothing to take a percentile of |

`segments` refines the spec's collector grouping: `gbp`, `localrank` and `citations` are
SMB-only rather than shared, since a pure online brand has no local listing to audit.

It also gates individual codes inside a shared collector. `sitetech` runs for both packages but
emits `TECH_MISSING_LOCALBUSINESS_SCHEMA` only on an SMB scan and `TECH_MISSING_PRODUCT_SCHEMA`
only on a DTC one — a plumber with no Product markup is correct, not broken. Collectors ask the
registry via `appliesTo()` rather than restating the mapping.

## Rules

- Codes are `SCREAMING_SNAKE`, prefixed by collector domain
- Adding a code is a deliberate act: add it here, add its normalise rule, add its render
  template. Never emit an unlisted code
- Every finding carries `severity`, `confidence`, `measured`, `benchmark`, `evidence`
- `confidence: verified` means measured directly. `estimated` means inferred or modelled.
  Never render an estimate as verified

## Severity

| Level | Meaning |
|---|---|
| `critical` | Actively losing money or invisible to buyers right now |
| `high` | Material gap against competitors |
| `medium` | Worth fixing, not urgent |
| `low` | Polish |
| `info` | Context for the narrative, not a recommendation |

---

## `gbp` — Google Business Profile

| Code | Severity | Confidence |
|---|---|---|
| `GBP_MISSING` | critical | verified |
| `GBP_UNCLAIMED` | critical | verified |
| `GBP_CATEGORY_MISMATCH` | high | estimated |
| `GBP_HOURS_INCOMPLETE` | medium | verified |
| `GBP_HOURS_STALE_HOLIDAY` | medium | verified |
| `GBP_PHOTOS_SPARSE` | medium | verified |
| `GBP_NO_SERVICES_LISTED` | high | verified |
| `GBP_POSTS_STALE` | low | verified |
| `GBP_QNA_UNANSWERED` | medium | verified |
| `GBP_ATTRIBUTES_SPARSE` | low | verified |

## `localrank` — map pack and organic position

| Code | Severity | Confidence |
|---|---|---|
| `LOCALRANK_ABSENT` | critical | verified |
| `LOCALRANK_BELOW_MEDIAN` | high | verified |
| `LOCALRANK_LOST_TO_COMPETITOR` | high | verified |
| `LOCALRANK_NO_MONEY_KEYWORD_COVERAGE` | high | estimated |

## `reviews`

| Code | Severity | Confidence |
|---|---|---|
| `REVIEW_VOLUME_LOW` | high | verified |
| `REVIEW_VELOCITY_LOW` | critical | verified |
| `REVIEW_RATING_BELOW_SET` | high | verified |
| `REVIEW_RESPONSE_RATE_LOW` | medium | verified |
| `REVIEW_RESPONSE_ABSENT_NEGATIVE` | high | verified |
| `REVIEW_RECENCY_STALE` | high | verified |

`REVIEW_VELOCITY_LOW` is the strongest local finding — volume is a vanity number, velocity
predicts ranking and shows neglect.

## `speedtolead` — see the ethics note in the spec (§4)

| Code | Severity | Confidence |
|---|---|---|
| `STL_FORM_BROKEN` | critical | verified |
| `STL_FORM_NO_REPLY` | critical | verified |
| `STL_FORM_SLOW_REPLY` | critical | verified |
| `STL_NO_FORM_ON_SITE` | high | verified |
| `STL_PHONE_UNANSWERED` | critical | verified |
| `STL_NO_PHONE_VISIBLE_MOBILE` | high | verified |
| `STL_COMPETITOR_FASTER` | high | verified |

Every code here is `verified` by construction — you measured it. That's the point.

## `sitetech`

| Code | Severity | Confidence |
|---|---|---|
| `TECH_LCP_POOR` | high | verified |
| `TECH_CLS_POOR` | medium | verified |
| `TECH_INP_POOR` | medium | verified |
| `TECH_MOBILE_UNFRIENDLY` | critical | verified |
| `TECH_NO_HTTPS` | critical | verified |
| `TECH_INDEXATION_BLOCKED` | critical | verified |
| `TECH_MISSING_LOCALBUSINESS_SCHEMA` | high | verified |
| `TECH_MISSING_PRODUCT_SCHEMA` | high | verified |
| `TECH_TITLE_MISSING` | high | verified |
| `TECH_TITLE_DUPLICATE` | medium | verified |
| `TECH_BROKEN_LINKS` | medium | verified |
| `TECH_NO_SITEMAP` | low | verified |
| `TECH_THIN_CONTENT` | medium | estimated |

## `citations`

| Code | Severity | Confidence |
|---|---|---|
| `NAP_INCONSISTENT` | high | verified |
| `NAP_MISSING_DIRECTORY` | medium | verified |

## `aivis` — AI search visibility

| Code | Severity | Confidence |
|---|---|---|
| `AIVIS_NOT_CITED` | high | verified |
| `AIVIS_COMPETITOR_CITED` | high | verified |
| `AIVIS_OUTDATED_FACT` | critical | verified |
| `AIVIS_NO_ENTITY` | high | estimated |

`AIVIS_OUTDATED_FACT` — a model stating something wrong about the business — is the single most
attention-getting finding in the whole report. Capture the exact model, prompt and response as
evidence.

---

## DTC collectors — Phase 4-adjacent, specced now for schema stability

### `paidcreative`

| Code | Severity | Confidence |
|---|---|---|
| `ADS_NONE_RUNNING` | info | verified |
| `ADS_CREATIVE_VOLUME_LOW` | high | verified |
| `ADS_CREATIVE_STALE` | high | verified |
| `ADS_SINGLE_FORMAT` | medium | verified |
| `ADS_NO_OFFER_VARIATION` | medium | estimated |
| `ADS_SPEND_ESTIMATE` | info | estimated |

### `store`

| Code | Severity | Confidence |
|---|---|---|
| `PDP_NO_REVIEWS` | high | verified |
| `PDP_IMAGE_COUNT_LOW` | medium | verified |
| `PDP_NO_SIZE_GUIDE` | medium | verified |
| `CART_NO_TRUST_SIGNALS` | medium | verified |
| `CHECKOUT_LIMITED_PAYMENTS` | medium | verified |
| `NO_SHIPPING_THRESHOLD_VISIBLE` | medium | verified |
| `COLLECTION_NO_FILTERS` | medium | verified |

### `lifecycle`

| Code | Severity | Confidence |
|---|---|---|
| `EMAIL_NO_WELCOME_FLOW` | critical | verified |
| `EMAIL_NO_ABANDON_FLOW` | critical | verified |
| `EMAIL_SLOW_FIRST_SEND` | high | verified |
| `EMAIL_SINGLE_TOUCH_WELCOME` | medium | verified |
| `EMAIL_NO_SMS_CAPTURE` | medium | verified |

### `measurement`

| Code | Severity | Confidence |
|---|---|---|
| `TRACK_NO_SERVER_SIDE` | high | verified |
| `TRACK_GA4_MISCONFIGURED` | high | estimated |
| `TRACK_NO_CONVERSION_EVENTS` | critical | verified |
| `TRACK_CONSENT_BLOCKING` | high | estimated |
