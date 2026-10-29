-- ============================================================================
-- API keys for server-side (B2B) clients — migration
-- Run by hand in the Supabase SQL editor. Additive only: no column, table,
-- constraint or row is altered or removed.
--
-- public.api_keys already exists. It was created for the Stripe subscription
-- tier (6410a84) and src/routes/stripe-auth.ts writes it on checkout:
--   api_key_hash, status ('active' | ...), plan, email, daily_calls,
--   daily_limit, last_reset, stripe_customer_id, stripe_subscription_id
-- B2B keys (scripts/generate-api-key.mjs) live in the same table so that one
-- middleware (src/middleware/apiKeyAuth.ts) serves both. Mapping from the
-- gateway-api-key-auth brief:
--   brief key_hash   -> existing api_key_hash
--   brief is_active  -> existing status = 'active'
--
-- Before running, record the live schema:
--
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'api_keys'
-- order by ordinal_position;
--
-- If email, plan or the stripe_* columns are NOT NULL without a default,
-- B2B inserts fail; generate-api-key.mjs then prints the Postgres error and
-- inserts nothing.
-- ============================================================================

alter table public.api_keys
  add column if not exists label                 text,
  add column if not exists owner                 text,
  add column if not exists allowed_routes        text[]      not null default '{}',  -- empty = every paid route
  add column if not exists rate_limit_per_minute integer     not null default 60,    -- stored only, not enforced
  add column if not exists last_used_at          timestamptz,
  add column if not exists total_requests        bigint      not null default 0;

create index if not exists api_keys_active_hash_idx
  on public.api_keys (api_key_hash) where status = 'active';

-- Raw keys are never stored, but the hashes still authenticate: keep the
-- table service-role only. No grant to anon or authenticated.
alter table public.api_keys enable row level security;
grant select, insert, update, delete on public.api_keys to service_role;

-- ----------------------------------------------------------------------------
-- After running, confirm:
--
-- select column_name, data_type, is_nullable, column_default
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'api_keys'
-- order by ordinal_position;
-- ----------------------------------------------------------------------------
