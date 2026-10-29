-- ============================================================================
-- API keys for server-side (B2B) clients — allow plan = 'b2b'
-- Run by hand in the Supabase SQL editor, after 2026-10-28-api-keys-b2b.sql
-- and 2026-10-28-api-keys-b2b-nullable.sql.
--
-- The B2B key insert (scripts/generate-api-key.mjs, plan 'b2b') failed on
-- 2026-10-28:
--   new row for relation "api_keys" violates check constraint "api_keys_plan_check"
-- The live definition was not captured beforehand. The Stripe tier only ever
-- writes 'starter' or 'pro' (src/routes/stripe-auth.ts), so the constraint is
-- recreated as: 'starter', 'pro', 'b2b', plus every plan value already present
-- in the table — no existing row can fail it. The old definition is printed
-- as a NOTICE (Messages / Results pane); check it lists nothing besides
-- 'starter' and 'pro' that you still need. LP decision, 2026-10-28.
--
-- Runs in one transaction: if anything fails, the old constraint stays.
-- ============================================================================

begin;

do $$
declare
  old_def text;
  allowed text;
begin
  select pg_get_constraintdef(oid) into old_def
  from pg_constraint
  where conname = 'api_keys_plan_check' and conrelid = 'public.api_keys'::regclass;

  raise notice 'old api_keys_plan_check: %', coalesce(old_def, '(none)');

  select string_agg(quote_literal(p), ', ' order by p) into allowed
  from (
    select unnest(array['starter', 'pro', 'b2b']) as p
    union
    select distinct plan from public.api_keys where plan is not null
  ) s;

  alter table public.api_keys drop constraint if exists api_keys_plan_check;
  execute format('alter table public.api_keys add constraint api_keys_plan_check check (plan in (%s))', allowed);

  raise notice 'new api_keys_plan_check: plan in (%)', allowed;
end $$;

commit;

-- ----------------------------------------------------------------------------
-- After running, confirm:
--
-- select pg_get_constraintdef(oid) from pg_constraint
-- where conname = 'api_keys_plan_check';
-- ----------------------------------------------------------------------------
