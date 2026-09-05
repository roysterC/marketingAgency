# Data model

Postgres (Supabase). Sketch DDL — types are indicative, migrations are the source of truth once
they exist.

## Design notes

Three things in here are load-bearing and easy to get wrong:

1. **`raw_captures` is separate from `findings`.** Raw data is expensive; rules are cheap and
   will change weekly. Keeping them apart makes re-normalisation free and back-fills benchmarks
   for every historical scan.
2. **`benchmarks` exists from the first commit** even though it's empty and useless. Retrofitting
   it means re-scanning everything you've ever run.
3. **`scan_targets.selection_reason`** — record *why* each competitor was picked. It's the first
   thing a sceptical prospect challenges, and it goes in the report.

---

```sql
-- Resolved business entities. Deduplicated across scans.
create table businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  domain        text,
  place_id      text unique,              -- Google Places
  vertical      text,                     -- 'trades.plumbing', 'clinic.dental', 'dtc.apparel'
  region        text,                     -- UK postcode district, e.g. 'SW18'
  platform      text,                     -- shopify | woocommerce | wordpress | custom
  socials       jsonb default '{}'::jsonb,
  first_seen_at timestamptz default now(),
  updated_at    timestamptz default now()
);
create index on businesses (vertical, region);

-- One run of the engine.
create table scans (
  id            uuid primary key default gen_random_uuid(),
  subject_id    uuid not null references businesses(id),
  mode          text not null default 'cold',   -- cold | warm
  status        text not null default 'queued', -- queued|resolving|collecting|normalising|analysing|rendering|complete|failed
  keyword_set   jsonb,                          -- money keywords used for localrank
  cost_pence    integer default 0,
  started_at    timestamptz default now(),
  completed_at  timestamptz,
  error         text
);

-- Subject + competitors for a given scan.
create table scan_targets (
  id               uuid primary key default gen_random_uuid(),
  scan_id          uuid not null references scans(id) on delete cascade,
  business_id      uuid not null references businesses(id),
  role             text not null,          -- subject | competitor
  selection_reason text,                   -- why this competitor. Goes in the report.
  unique (scan_id, business_id)
);

-- Per-collector execution record. One row per (collector x target).
create table collector_runs (
  id           uuid primary key default gen_random_uuid(),
  scan_id      uuid not null references scans(id) on delete cascade,
  target_id    uuid not null references scan_targets(id) on delete cascade,
  collector    text not null,              -- gbp | localrank | reviews | sitetech | ...
  status       text not null,              -- pending | running | ok | failed | skipped
  requires_auth boolean default false,
  cost_pence   integer default 0,
  duration_ms  integer,
  error        text,
  ran_at       timestamptz default now()
);
create index on collector_runs (scan_id, status);

-- Unprocessed source responses. Never deleted; re-normalisable.
create table raw_captures (
  id                uuid primary key default gen_random_uuid(),
  collector_run_id  uuid not null references collector_runs(id) on delete cascade,
  source            text not null,         -- 'places.details', 'serp.local', 'psi.mobile'
  payload           jsonb not null,
  captured_at       timestamptz default now()
);
create index on raw_captures (collector_run_id);

-- Normalised output. Codes come from docs/finding-taxonomy.md — closed set.
create table findings (
  id               uuid primary key default gen_random_uuid(),
  scan_id          uuid not null references scans(id) on delete cascade,
  target_id        uuid not null references scan_targets(id) on delete cascade,
  code             text not null,
  collector        text not null,
  severity         text not null,          -- critical | high | medium | low | info
  confidence       text not null,          -- verified | estimated
  measured_value   numeric,
  measured_unit    text,
  measured_text    text,
  benchmark_value  numeric,
  benchmark_source text,                   -- vertical_p50 | competitor_best | absolute
  evidence         jsonb not null default '{}'::jsonb,
  normalised_at    timestamptz default now()
);
create index on findings (scan_id, severity);
create index on findings (code, measured_value);

-- Screenshots and captured assets referenced from findings.evidence.
create table evidence_assets (
  id          uuid primary key default gen_random_uuid(),
  scan_id     uuid not null references scans(id) on delete cascade,
  finding_id  uuid references findings(id) on delete cascade,
  kind        text not null,               -- screenshot | html | email | audio
  storage_key text not null,               -- Supabase Storage path
  captured_at timestamptz default now()
);

-- THE MOAT. Aggregated from findings across every scan ever run.
create table benchmarks (
  vertical    text not null,
  region      text,                        -- null = national
  code        text not null,
  metric      text not null,
  p25         numeric,
  p50         numeric,
  p75         numeric,
  sample_size integer not null default 0,
  updated_at  timestamptz default now(),
  primary key (vertical, region, code, metric)
);

-- AI visibility prompt sets, per vertical.
create table prompt_sets (
  id         uuid primary key default gen_random_uuid(),
  vertical   text not null,
  prompts    jsonb not null,               -- ["best plumber in Wandsworth", ...]
  models     jsonb not null default '["claude","gpt","perplexity"]'::jsonb,
  updated_at timestamptz default now()
);

-- Rendered reports, versioned so a re-render doesn't destroy what a client was sent.
create table reports (
  id           uuid primary key default gen_random_uuid(),
  scan_id      uuid not null references scans(id) on delete cascade,
  version      integer not null default 1,
  variant      text not null default 'full',  -- full | onepager
  narrative    jsonb not null,                -- LLM output; every claim references a finding_id
  storage_key  text,                          -- rendered HTML/PDF
  rendered_at  timestamptz default now(),
  unique (scan_id, version, variant)
);
```

## Benchmark aggregation

Recomputed on a schedule, not per-scan.

```sql
-- Sketch: percentiles per (vertical, region, code, metric)
insert into benchmarks (vertical, region, code, metric, p25, p50, p75, sample_size, updated_at)
select
  b.vertical,
  b.region,
  f.code,
  f.measured_unit as metric,
  percentile_cont(0.25) within group (order by f.measured_value),
  percentile_cont(0.50) within group (order by f.measured_value),
  percentile_cont(0.75) within group (order by f.measured_value),
  count(*),
  now()
from findings f
join scan_targets t on t.id = f.target_id
join businesses  b on b.id = t.business_id
where f.measured_value is not null
group by b.vertical, b.region, f.code, f.measured_unit
on conflict (vertical, region, code, metric) do update set
  p25 = excluded.p25, p50 = excluded.p50, p75 = excluded.p75,
  sample_size = excluded.sample_size, updated_at = now();
```

**Suppress benchmark claims below `sample_size` 20.** Say "not enough comparable businesses yet"
rather than quoting a percentile built on four data points — one shaky claim discredits the
whole report.

## Validation before render

Hard gate, not a warning. Implemented in
[`lib/analyse/validate.ts`](../lib/analyse/validate.ts), and called by the render step itself
rather than by whoever remembers — there is no path from a claim we cannot defend to a document
a prospect reads.

| Violation | Check |
|---|---|
| `UNREFERENCED_CLAIM` | Every narrative claim references a real `finding_id` on this scan |
| `ESTIMATE_AS_FACT` | No `estimated` finding is phrased as measured fact |
| `THIN_BENCHMARK_CITED` | No `vertical_p50` benchmark cited below `sample_size` 20 |
| `CRITICAL_WITHOUT_EVIDENCE` | Every `critical` finding has something a reader can check |
| `CRITICAL_UNREPORTED` | Every `critical` finding **about the subject** appears in the narrative |
| `RECOMMENDATION_WITHOUT_FINDING` | Every recommendation is justified by findings |

The last two are additions to the original four. `CRITICAL_UNREPORTED` catches a report that
quietly omits its own worst finding — the model ranked it away, and nothing else would notice.
`RECOMMENDATION_WITHOUT_FINDING` is the same rule as an unreferenced claim, applied to the
half of the output that tells a client what to do.

`ESTIMATE_AS_FACT` is the only one that cannot be exact. It requires a claim resting on an
estimated finding to carry hedging language, which is a backstop rather than a judgement of
whether a sentence overstates its evidence. A false positive costs a rewrite; a false negative
costs a claim we cannot defend, so it errs towards the rewrite.
