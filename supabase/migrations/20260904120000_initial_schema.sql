-- Research & Teardown Engine — initial schema (Phase A1)
--
-- Design notes live in docs/schema.md. Three things here are load-bearing:
--
--   1. raw_captures is separate from findings. Raw data is expensive and rules change
--      weekly; keeping them apart makes re-normalisation free.
--   2. benchmarks ships now, empty and useless, because retrofitting it means rescanning
--      everything ever run.
--   3. scan_targets.selection_reason records WHY a competitor was picked. It goes in the
--      report and is the first thing a sceptical prospect challenges.
--
-- CHECK constraint value lists mirror lib/taxonomy/enums.ts exactly. scripts/check-taxonomy.mjs
-- fails if they drift. Change both in the same commit.
--
-- Track B delivery tables (clients, drafts, draft_events) are deliberately NOT here — they
-- are triggered by signing client #1, not by the calendar. See docs/delivery-system.md.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- businesses

create table businesses (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  domain        text,
  place_id      text unique,
  vertical      text,
  region        text,
  platform      text,
  socials       jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column businesses.vertical is 'Dotted path, e.g. trades.plumbing. Benchmark grouping key.';
comment on column businesses.region   is 'UK postcode district, e.g. SW18. Benchmark grouping key.';

create index businesses_vertical_region_idx on businesses (vertical, region);
create index businesses_domain_idx          on businesses (domain);

-- --------------------------------------------------------------------- scans

create table scans (
  id           uuid primary key default gen_random_uuid(),
  subject_id   uuid not null references businesses(id),
  mode         text not null default 'cold'
                 check (mode in ('cold', 'warm')),
  status       text not null default 'queued'
                 check (status in ('queued','resolving','collecting','normalising',
                                   'analysing','rendering','complete','failed')),
  keyword_set  jsonb,
  cost_pence   integer not null default 0 check (cost_pence >= 0),
  started_at   timestamptz not null default now(),
  completed_at timestamptz,
  error        text
);

create index scans_subject_idx on scans (subject_id, started_at desc);
create index scans_status_idx  on scans (status) where status not in ('complete','failed');

-- -------------------------------------------------------------- scan_targets

create table scan_targets (
  id               uuid primary key default gen_random_uuid(),
  scan_id          uuid not null references scans(id) on delete cascade,
  business_id      uuid not null references businesses(id),
  role             text not null check (role in ('subject','competitor')),
  selection_reason text,
  unique (scan_id, business_id)
);

comment on column scan_targets.selection_reason is
  'Why this competitor was chosen. Rendered in the report.';

create index scan_targets_scan_idx on scan_targets (scan_id);

-- ------------------------------------------------------------ collector_runs

create table collector_runs (
  id            uuid primary key default gen_random_uuid(),
  scan_id       uuid not null references scans(id) on delete cascade,
  target_id     uuid not null references scan_targets(id) on delete cascade,
  collector     text not null
                  check (collector in ('gbp','localrank','reviews','speedtolead','sitetech',
                                       'citations','aivis','paidcreative','store','lifecycle',
                                       'measurement')),
  status        text not null default 'pending'
                  check (status in ('pending','running','ok','failed','skipped')),
  requires_auth boolean not null default false,
  cost_pence    integer not null default 0 check (cost_pence >= 0),
  duration_ms   integer,
  error         text,
  ran_at        timestamptz not null default now(),
  unique (target_id, collector)
);

create index collector_runs_scan_status_idx on collector_runs (scan_id, status);

-- --------------------------------------------------------------- raw_captures

create table raw_captures (
  id               uuid primary key default gen_random_uuid(),
  collector_run_id uuid not null references collector_runs(id) on delete cascade,
  source           text not null,
  payload          jsonb not null,
  captured_at      timestamptz not null default now()
);

comment on table raw_captures is
  'Unprocessed source responses. Never deleted — normalise rules change and re-buying data is expensive.';

create index raw_captures_run_idx on raw_captures (collector_run_id);

-- ------------------------------------------------------------------ findings

create table findings (
  id               uuid primary key default gen_random_uuid(),
  scan_id          uuid not null references scans(id) on delete cascade,
  target_id        uuid not null references scan_targets(id) on delete cascade,
  code             text not null,
  collector        text not null,
  severity         text not null
                     check (severity in ('critical','high','medium','low','info')),
  confidence       text not null
                     check (confidence in ('verified','estimated')),
  measured_value   numeric,
  measured_unit    text
                     check (measured_unit is null or measured_unit in
                       ('count','hours','days','seconds','ms','per_month','per_week',
                        'position','score','percent','gbp','none')),
  measured_text    text,
  benchmark_value  numeric,
  benchmark_source text
                     check (benchmark_source is null or benchmark_source in
                       ('vertical_p50','competitor_best','absolute')),
  evidence         jsonb not null default '{}'::jsonb,
  normalised_at    timestamptz not null default now()
);

comment on column findings.code is
  'From the closed taxonomy in lib/taxonomy/findings.ts. Not constrained here because the
   set changes with code, not with migrations — the application validates on write.';

create index findings_scan_severity_idx on findings (scan_id, severity);
create index findings_code_value_idx    on findings (code, measured_value);
create index findings_target_idx        on findings (target_id);

-- ----------------------------------------------------------- evidence_assets

create table evidence_assets (
  id          uuid primary key default gen_random_uuid(),
  scan_id     uuid not null references scans(id) on delete cascade,
  finding_id  uuid references findings(id) on delete cascade,
  kind        text not null check (kind in ('screenshot','html','email','audio')),
  storage_key text not null,
  captured_at timestamptz not null default now()
);

create index evidence_assets_scan_idx on evidence_assets (scan_id);

-- ---------------------------------------------------------------- benchmarks

create table benchmarks (
  vertical    text not null,
  region      text,
  code        text not null,
  metric      text not null,
  p25         numeric,
  p50         numeric,
  p75         numeric,
  sample_size integer not null default 0 check (sample_size >= 0),
  updated_at  timestamptz not null default now(),
  primary key (vertical, region, code, metric)
);

comment on table benchmarks is
  'Aggregated percentiles across every scan. Worthless at run #1, decisive by month six.
   Suppress claims below sample_size 20 — see MIN_BENCHMARK_SAMPLE in lib/taxonomy/enums.ts.';

-- Postgres treats NULL region as distinct in a primary key, so national rows need their
-- own uniqueness guarantee.
create unique index benchmarks_national_idx
  on benchmarks (vertical, code, metric)
  where region is null;

-- --------------------------------------------------------------- prompt_sets

create table prompt_sets (
  id         uuid primary key default gen_random_uuid(),
  vertical   text not null unique,
  prompts    jsonb not null,
  models     jsonb not null default '["claude","gpt","perplexity"]'::jsonb,
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------- reports

create table reports (
  id          uuid primary key default gen_random_uuid(),
  scan_id     uuid not null references scans(id) on delete cascade,
  version     integer not null default 1 check (version >= 1),
  variant     text not null default 'full' check (variant in ('full','onepager')),
  narrative   jsonb not null,
  storage_key text,
  rendered_at timestamptz not null default now(),
  unique (scan_id, version, variant)
);

comment on column reports.narrative is
  'LLM output. Every claim carries a finding_id; render rejects unreferenced claims.';

-- ------------------------------------------------------- updated_at triggers

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger businesses_updated_at
  before update on businesses
  for each row execute function set_updated_at();

create trigger prompt_sets_updated_at
  before update on prompt_sets
  for each row execute function set_updated_at();

-- ------------------------------------------------------------------------ RLS
--
-- Internal tool: all access is via the service role, which bypasses RLS. Enabling RLS with
-- no policies means anon and authenticated keys get nothing, which is the intent. Add
-- policies only when a client-facing surface actually exists.

alter table businesses      enable row level security;
alter table scans           enable row level security;
alter table scan_targets    enable row level security;
alter table collector_runs  enable row level security;
alter table raw_captures    enable row level security;
alter table findings        enable row level security;
alter table evidence_assets enable row level security;
alter table benchmarks      enable row level security;
alter table prompt_sets     enable row level security;
alter table reports         enable row level security;
