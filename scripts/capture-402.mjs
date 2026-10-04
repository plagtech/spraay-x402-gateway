// ============================================================
// capture-402.mjs — byte-level check of the unpaid robots/task 402
// ============================================================
// rtp-ext-proof.mjs checks response SHAPE. This records the exact bytes of
// the unpaid POST /api/v1/robots/task 402 (body + PAYMENT-REQUIRED header)
// as sha256 hashes and compares them with the recorded baseline below.
//
// Boots dist/index.js against the same mocks and env as rtp-ext-proof.mjs.
// No network, no database, no funds. Build first (the proof does that).
//
//   node scripts/capture-402.mjs [out.json]
//
// The 402 carries the package version string, so a version bump changes
// both hashes by design: compare at the same version as the baseline.
// Exits 1 if the robots/task hashes differ from the baseline.
// ============================================================

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2];
const GW = "http://127.0.0.1:3499", FAC = "http://127.0.0.1:5592";

// Recorded 2026-10-04 at 3.8.3, before the robots/update secret change.
const BASELINE = {
  version: "3.8.3",
  bodySha256: "cc560f32078bb6a98c3d28a4bd82b5109ab818bb02bd36cbf72144a0bfc474e6",
  paymentRequiredSha256: "9ce55a86850e815528efa9d6a66af5926bde456002c692879b9a7b10852ca855",
};

const kids = [];
const launch = (a, env) => {
  const c = spawn(process.execPath, a, { cwd: REPO, env });
  c.stdout.on("data", () => {}); c.stderr.on("data", () => {});
  kids.push(c);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

launch([join(REPO, "scripts/rtp-proof/mock-supabase.mjs"), "5591"]);
launch([join(REPO, "scripts/rtp-proof/mock-facilitator.mjs"), "5592"]);
await sleep(1500);
launch([join(REPO, "dist/index.js")], { ...process.env, PORT: "3499", BASE_URL: GW,
  SUPABASE_URL: "http://127.0.0.1:5591", SUPABASE_SERVICE_KEY: "proof", SUPABASE_SERVICE_ROLE_KEY: "proof", SUPABASE_ANON_KEY: "proof",
  X402_FACILITATOR_URL: FAC, PAY_TO_ADDRESS: "0x9999999999999999999999999999999999999999",
  SOLANA_RECEIVE_ADDRESS: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5", SOLANA_PAYMENTS_ENABLED: "false",
  RESEND_API_KEY: "re_proof_placeholder", STRIPE_SECRET_KEY: "sk_test_proof_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_proof_placeholder",
  TWILIO_ACCOUNT_SID: "ACproof00000000000000000000000000", TWILIO_AUTH_TOKEN: "proof", NODE_ENV: "development" });

let exitCode = 0;
try {
  let healthy = false;
  for (let i = 0; i < 120 && !healthy; i++) {
    try { healthy = (await fetch(GW + "/health")).ok; } catch {}
    if (!healthy) await sleep(1000);
  }
  if (!healthy) throw new Error("gateway did not start — build first (npx tsc)");

  const sha = s => createHash("sha256").update(s).digest("hex");
  const cap = async (path, init) => {
    const r = await fetch(GW + path, init);
    const body = await r.text();
    const hdr = {};
    for (const k of ["content-type", "payment-required", "www-authenticate"]) {
      const v = r.headers.get(k); if (v != null) hdr[k] = v;
    }
    return { status: r.status, headers: hdr, bodySha256: sha(body),
             paymentRequiredSha256: hdr["payment-required"] ? sha(hdr["payment-required"]) : null, body };
  };
  const json = { "Content-Type": "application/json" };
  const out = {
    robotsTaskUnpaidValid: await cap("/api/v1/robots/task", { method: "POST", headers: json, body: JSON.stringify({ robot_id: "proof_bot_online", task: "pick" }) }),
    robotsTaskUnpaidEmpty: await cap("/api/v1/robots/task", { method: "POST", headers: json, body: "{}" }),
    // Mock robot has no update_secret, so this documents the no-secret path (200).
    robotsUpdateNoCreds: await cap("/api/v1/robots/update", { method: "PATCH", headers: json, body: JSON.stringify({ robot_id: "proof_bot_online", payment_address: "0x3333333333333333333333333333333333333333" }) }),
  };
  if (OUT) writeFileSync(OUT, JSON.stringify(out, null, 2));

  for (const [k, v] of Object.entries(out)) {
    console.log(`${k.padEnd(22)} ${v.status}  body ${v.bodySha256}  PAYMENT-REQUIRED ${v.paymentRequiredSha256 ?? "-"}  (${v.body.length} bytes)`);
  }
  for (const k of ["robotsTaskUnpaidValid", "robotsTaskUnpaidEmpty"]) {
    const v = out[k];
    const ok = v.status === 402 && v.bodySha256 === BASELINE.bodySha256 && v.paymentRequiredSha256 === BASELINE.paymentRequiredSha256;
    console.log(`${k}: ${ok ? "IDENTICAL to" : "DIFFERS from"} baseline (${BASELINE.version})`);
    if (!ok) exitCode = 1;
  }
} catch (err) {
  console.error("capture-402 error:", err.message);
  exitCode = 1;
} finally {
  kids.forEach(k => k.kill());
}
// exitCode, not process.exit(): exiting while the killed children's handles
// are still closing trips a libuv assertion on Windows.
process.exitCode = exitCode;
