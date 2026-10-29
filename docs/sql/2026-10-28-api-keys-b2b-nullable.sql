-- ============================================================================
-- API keys for server-side (B2B) clients — follow-on to 2026-10-28-api-keys-b2b.sql
-- Run by hand in the Supabase SQL editor, after that file.
--
-- B2B keys (scripts/generate-api-key.mjs) have no Stripe customer, so the
-- first insert failed on 2026-10-28:
--   null value in column "stripe_customer_id" of relation "api_keys"
--   violates not-null constraint
-- These columns are relaxed to nullable (LP decision, 2026-10-28). The
-- Stripe checkout insert in src/routes/stripe-auth.ts always sets all three,
-- so its rows are unaffected. No column, row or other constraint changes.
-- DROP NOT NULL on a column that is already nullable is a no-op.
-- ============================================================================

alter table public.api_keys
  alter column stripe_customer_id     drop not null,
  alter column stripe_subscription_id drop not null,
  alter column email                  drop not null;

-- ----------------------------------------------------------------------------
-- After running, confirm all three show is_nullable = 'YES':
--
-- select column_name, is_nullable
-- from information_schema.columns
-- where table_schema = 'public' and table_name = 'api_keys'
--   and column_name in ('stripe_customer_id', 'stripe_subscription_id', 'email');
-- ----------------------------------------------------------------------------
