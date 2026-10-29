/**
 * 💧 Issue a server-side (B2B) gateway API key.
 *
 *     node scripts/generate-api-key.mjs --label "WooCommerce Store A" --owner "merchant-123" \
 *       [--email ops@example.com] [--routes "POST /api/v1/batch/execute,/api/v1/batch/estimate"] \
 *       [--daily-limit 100000]
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY), from the
 * environment or .env — the same variables src/db.ts reads. Requires
 * docs/sql/2026-10-28-api-keys-b2b.sql to have been run.
 *
 * Writes to the existing api_keys table (shared with the Stripe tier) with
 * plan "b2b" and status "active". Only the SHA-256 hash is stored; the raw
 * key is printed once and cannot be recovered. Deactivate a key with
 *     update api_keys set status = 'revoked' where id = '<id>';
 */
import { createRequire } from "module";
import { randomBytes, createHash } from "crypto";

const require = createRequire(import.meta.url);
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const label = arg("label");
const owner = arg("owner");
const email = arg("email");
const routes = arg("routes");
const dailyLimit = arg("daily-limit") ?? "100000";

if (!label || !owner) {
  console.error('Usage: node scripts/generate-api-key.mjs --label "<label>" --owner "<owner>" [--email <email>] [--routes "<r1>,<r2>"] [--daily-limit <n>]');
  process.exit(1);
}
if (!/^\d+$/.test(dailyLimit)) {
  console.error(`--daily-limit must be a non-negative integer, got "${dailyLimit}"`);
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY (or SUPABASE_KEY) are required");
  process.exit(1);
}

const rawKey = `sk_spraay_${randomBytes(32).toString("hex")}`;
// Must match hashApiKey() in src/middleware/apiKeyAuth.ts
const keyHash = createHash("sha256").update(rawKey).digest("hex");

const row = {
  api_key_hash: keyHash,
  label,
  owner,
  plan: "b2b",
  status: "active",
  daily_calls: 0,
  daily_limit: Number(dailyLimit),
  allowed_routes: routes ? routes.split(",").map((r) => r.trim()).filter(Boolean) : [],
};
if (email) row.email = email;

const supabase = createClient(url, key);
const { data, error } = await supabase.from("api_keys").insert(row).select("id").single();
if (error) {
  console.error(`Insert failed: ${error.message}`);
  process.exit(1);
}

console.log(`Key id:  ${data.id}`);
console.log(`Label:   ${label}`);
console.log(`Owner:   ${owner}`);
console.log(`Routes:  ${row.allowed_routes.length ? row.allowed_routes.join(", ") : "all paid routes"}`);
console.log("");
console.log(`API Key (save this — it won't be shown again): ${rawKey}`);
