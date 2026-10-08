-- ============================================================================
-- cron scheduler v1 (trigger-only) — migration
-- Run by hand in the Supabase SQL editor. Additive only: no column, table,
-- constraint or row is altered or removed.
--
-- Written against the live schema as reported 2026-10-08 (Phase 0, Q1–Q4):
--   cron_jobs.id            text  (PK, no default)
--   cron_jobs.next_run      timestamptz, nullable
--   cron_jobs.last_run      timestamptz, nullable  -- already exists, not added
--   cron_jobs.status        text, default 'active', no check constraint
--   webhook_events.id       uuid  (PK, default gen_random_uuid())
--   webhook_events.event_type  text, no check constraint -> 'cron.triggered' OK
--   row-level security      ON for cron_jobs and webhook_events
--   legacy rows             9 in cron_jobs, all status 'active'
--                           (7 batch.execute, 2 webhook.trigger)
--
-- Legacy rows get callback_url = NULL from the new column and are excluded
-- by the worker's due query (callback_url is not null) and by the partial
-- index below, so they never fire. They are left untouched.
-- ============================================================================

alter table public.cron_jobs
  add column if not exists owner        text,
  add column if not exists callback_url text,
  add column if not exists hmac_secret  text,
  add column if not exists claim_seq    integer not null default 0,
  add column if not exists missed_count integer not null default 0,
  add column if not exists last_error   text,
  add column if not exists cancelled_at timestamptz;

create index if not exists cron_jobs_due_idx
  on public.cron_jobs (next_run) where status = 'active' and callback_url is not null;
create index if not exists cron_jobs_owner_idx on public.cron_jobs (owner);

create table if not exists public.cron_runs (
  id               uuid primary key default gen_random_uuid(),
  job_id           text not null,          -- cron_jobs.id (text); no FK, matching the rest of the schema
  claim_seq        integer not null,
  run_number       integer,
  scheduled_for    timestamptz not null,
  fired_at         timestamptz not null default now(),
  status           text not null check (status in ('queued', 'missed', 'queue_failed', 'blocked')),
  webhook_event_id uuid,                   -- webhook_events.id (uuid)
  error            text,
  unique (job_id, claim_seq)
);
create index if not exists cron_runs_job_idx on public.cron_runs (job_id, fired_at desc);
alter table public.cron_runs enable row level security;

-- ----------------------------------------------------------------------------
-- After running, confirm (Phase 2 step 1):
--
-- select table_name, column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name in ('cron_jobs', 'cron_runs')
-- order by table_name, ordinal_position;
-- ----------------------------------------------------------------------------
