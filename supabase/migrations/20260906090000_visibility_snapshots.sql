-- AI visibility tracking — A3.
--
-- A separate table from `findings` on purpose. Findings are exception-based: AIVIS_NOT_CITED
-- only exists below 20% share, so a business sitting at 60% produces no row at all. A tracker
-- needs the measurement every run, including the good ones, because a series of "nothing to
-- report" is what makes the first drop visible.
--
-- `prompts` and `models` are stored per snapshot rather than looked up from `prompt_sets`.
-- The set on disk changes; a snapshot has to stay interpretable years later, and comparing
-- two runs that asked different questions reports an artefact as a result.

create table visibility_snapshots (
  id          uuid primary key default gen_random_uuid(),
  -- Names the series. A vertical for client work, or a label for our own tracking.
  prompt_set  text not null,
  run_at      timestamptz not null default now(),
  prompts     jsonb not null,
  models      jsonb not null,
  -- Answers actually received. Fewer than prompts x models when a model refused.
  answers     integer not null default 0,
  -- One row per business named, plus a zero for every tracked business that was not.
  entries     jsonb not null default '[]'::jsonb,
  -- What changed since the last run, in the operator's own words. The A3 ship criterion is
  -- a movement you can attribute to something you changed, and attribution is written down
  -- at the time or lost.
  note        text,
  cost_pence  integer not null default 0
);

create index on visibility_snapshots (prompt_set, run_at desc);
