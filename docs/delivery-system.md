# Delivery system — the human gate

Covers Track B (`D0`–`D2`) in [`roadmap.md`](roadmap.md). This is how the Tier 2 services in
[`strategy.md`](strategy.md) actually get delivered.

---

## 1. Why this is a system and not a habit

The strategy says "AI does 80%, nothing ships unapproved." That sentence is easy to write and
collapses under load.

```
20 clients  ×  <5 hrs each  =  ~100 hrs /mo total delivery
```

At fifteen clients with ad-hoc approval you get one of two failures, and both are quiet:

- **Rubber-stamping** — you approve without reading. This is precisely how the Tier 2 risks
  materialise: the mass-AI-content penalty, the off-brand DM, the campaign killed on a bad
  automated signal.
- **Budget blowout** — you read everything properly and delivery eats 200 hours, which breaks
  the solo arithmetic the whole business rests on.

The gate has to be cheap enough to actually use and strict enough to be worth having. That means
machinery.

---

## 2. Core design

### One queue

A single review surface across every client. Not fifteen inboxes, not a folder per client.
Everything awaiting approval is in one place, sorted by ship deadline.

### Draft state machine

```
generated → in_review → approved → scheduled → published
                ↓
            rejected(reason)
```

Nothing reaches a client without a recorded transition. "What shipped last month and who
approved it" must be answerable from one query — that's the accountability half of what clients
are paying for.

### Rejection reasons feed back

Every `rejected(reason)` becomes a per-client few-shot example for the next generation. The gate
gets measurably cheaper over time.

This is the same compounding-data logic as `benchmarks` in the teardown engine: worthless on day
one, decisive by month six, and impossible to retrofit. Capture reasons as structured values,
not free text, from the first rejection.

### Per-client voice profile

| Field | Purpose |
|---|---|
| `tone` | How they sound |
| `approved_terminology` | Words they use for their own services |
| `banned_claims` | Things they must never say |
| `compliance_rules` | Vertical constraints — hard blockers |
| `examples` | Accumulated from approved and rejected drafts |

### Compliance as hard blockers

For regulated verticals this is not a style note. A clinic client cannot ship treatment
claims — the generator refuses, the queue refuses, and the failure is visible. Enforced, not
advised.

### Batch review

Twenty posts in one sitting, not twenty interruptions. The queue groups by client and content
type so a review session has one context, not twenty.

### Approval-minutes per client

Track time-to-approve against the <5 hrs/month budget.

A client who consistently exceeds it is a **pricing signal, not a work-harder signal.** Either
the scope is wrong, the voice profile is undertrained, or they're underpriced. This metric is
what keeps the twenty-seat ceiling honest, and without it you discover the problem at client
fifteen instead of client five.

---

## 3. The never-automate list, as enforced config

`strategy.md` lists things that must never be automated. Those belong in code as a hard
allowlist: **anything not explicitly permitted to auto-publish routes to the queue.** Default
deny.

| Action | Auto-publish |
|---|---|
| Scheduled social post, already approved | ✅ |
| Negative keyword addition below threshold | ✅ |
| Budget pacing alert (notify only) | ✅ |
| Review response | ❌ queue |
| Any content publish | ❌ queue |
| Any email or SMS send | ❌ queue |
| Social reply, DM, comment | ⛔ **hard block** — never automated |
| Campaign kill decision | ⛔ **hard block** |
| Account structure change | ⛔ **hard block** |
| Offer or pricing change | ⛔ **hard block** |

Three levels, deliberately. `queue` means a human approves it. `hard block` means the system has
no code path to do it at all — the difference matters, because a queue entry at 11pm on a busy
week is a rubber stamp waiting to happen.

---

## 4. Build vs buy

**Do not build a custom approval platform before ~5 clients.** That would violate the roadmap's
own rule — tooling only for offers that have already sold.

| Stage | Clients | Implementation |
|---|---|---|
| **0** | 1–3 | Airtable or Notion queue + n8n or a scheduled job. Manual but structured |
| **1** | 4–10 | Custom queue in the existing Next.js app, reusing the Supabase instance |
| **2** | 10+ | Voice profiles, rejection feedback loop, batch review, approval-time tracking |

Stage 0 is not a placeholder — it's the real system with cheap parts. **Get the states and the
discipline right there**, because that's what Stage 1 ports. If the state machine is sloppy in
Airtable it will be sloppy in Postgres.

---

## 5. Per-service delivery

All four share one spine: `generate → check → queue → approve → ship`. They are adapters on one
system, not four systems.

### Content & copywriting

- Brief seeded from teardown findings — the audit that sold the client becomes the backlog
- Draft against the client voice profile
- **Differentiation check:** does this say anything the top three ranking pages don't? If not,
  it fails before reaching the queue. This is the check that keeps you out of the
  helpful-content penalty
- Human edit → approve → publish

### PPC optimisation

- Automated: search term mining, negative suggestions, pacing alerts, bid rule triggers
- Queued: anything changing spend materially
- Hard-blocked: offer strategy, account structure, campaign kill decisions
- Per-client alert thresholds so the queue doesn't fill with noise

### Social content production

- Repurposing: one asset → N formats
- Scheduling after approval
- Hard-blocked: replies, DMs, comments. Routed to a human or the client, always

### Email & SMS lifecycle

- Flow generation and segmentation automated
- Every send approved — no exceptions, including "just a resend"
- Consent state and unsubscribe handling checked before queueing, not after

---

## 6. Data model sketch

Lives alongside the teardown schema in the same Supabase instance.

```sql
create table clients (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references businesses(id),   -- links back to the teardown
  package       text not null,                    -- smb | dtc
  voice_profile jsonb not null default '{}'::jsonb,
  hours_budget  numeric default 5.0,
  started_at    timestamptz default now()
);

create table drafts (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  service       text not null,        -- content | ppc | social | lifecycle
  kind          text not null,        -- post | email | landing_page | negative_list
  state         text not null default 'generated',
  body          jsonb not null,
  source_finding_id uuid references findings(id),  -- traceable to the audit
  ship_by       timestamptz,
  created_at    timestamptz default now()
);

create table draft_events (
  id           uuid primary key default gen_random_uuid(),
  draft_id     uuid not null references drafts(id) on delete cascade,
  from_state   text,
  to_state     text not null,
  reason_code  text,                  -- closed set, feeds the few-shot loop
  reason_note  text,
  minutes_spent numeric,              -- approval-time tracking
  actor        text not null,
  at           timestamptz default now()
);
```

`draft_events` is the important one. It carries the audit trail, the rejection-reason feedback
loop and the approval-time metric in a single append-only table.

---

## 7. Open questions

- **Rejection reason taxonomy** — needs a closed set, same discipline as the finding taxonomy.
  Draft it at client #1 from real rejections rather than inventing it upfront
- **Client visibility** — do clients see the queue, or only what shipped? Showing it is a
  transparency selling point and a support burden. Default to shipped-only until asked
- **Contractor access** — the model assumes you are the only approver. Adding a contractor means
  a role model and per-service approval rights
