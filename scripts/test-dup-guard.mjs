/**
 * 💧 Duplicate-guard regression gate — run after `npm run build`:
 *
 *     node scripts/test-dup-guard.mjs
 *
 * Locks in the route-scoped dedupe key: the documented quote→pay sequence
 * (estimate then execute, same body, same payer, seconds apart) must PASS,
 * while a genuine duplicate (same call repeated) must still 409.
 */
import { duplicatePaymentGuard } from "../dist/middleware/loop-safety.js";

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "OK  " : "FAIL"}  ${name}`);
  if (!cond) failures++;
}

function makeReq({ path, body, payment = "x402-sig", apiKey = "test-key" }) {
  const headers = { authorization: `Bearer ${apiKey}` };
  if (payment) headers["x-payment"] = payment;
  return {
    method: "POST",
    headers,
    body,
    baseUrl: "/api/v1/batch",
    path, // mount-relative, as Express provides under app.use("/api/v1/batch", ...)
    ip: "10.0.0.1",
    socket: { remoteAddress: "10.0.0.1" },
  };
}

function run(guard, req) {
  let status = 0, json = null, nexted = false;
  const res = {
    status(s) { status = s; return this; },
    json(j) { json = j; return this; },
    setHeader() {},
  };
  guard(req, res, () => { nexted = true; });
  return { status, json, nexted };
}

const batchBody = {
  token: "USDC",
  recipients: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
  amounts: ["20000", "20000"],
  sender: "0xcccccccccccccccccccccccccccccccccccccccc",
};

// Fresh guard instance per scenario group (isolated in-memory store per closure
// would be ideal; the module store is shared, so vary payer/body per scenario).
const guard = duplicatePaymentGuard();

// ── 1. THE BUG: quote→pay must pass ────────────────────────────────────────
const est = run(guard, makeReq({ path: "/estimate", body: { ...batchBody } }));
const exe = run(guard, makeReq({ path: "/execute", body: { ...batchBody } }));
check("estimate passes", est.nexted && est.status === 0);
check("execute after estimate passes (was 409 before fix)", exe.nexted && exe.status === 0);

// ── 2. Real duplicate still caught ──────────────────────────────────────────
const dup = run(guard, makeReq({ path: "/execute", body: { ...batchBody } }));
check("identical execute repeat still 409s", dup.status === 409 && dup.json?.error === "duplicate_payment_detected");
check("409 shape intact (cooldown/retry/hint keys)",
  dup.json && "cooldown_seconds" in dup.json && "retry_after_seconds" in dup.json &&
  "original_endpoint" in dup.json && "hint" in dup.json && "message" in dup.json);

// ── 3. Unpaid probe: never checked, never recorded ──────────────────────────
const probeBody = { ...batchBody, amounts: ["77000", "77000"] };
const probe = run(guard, makeReq({ path: "/execute", body: probeBody, payment: null }));
const paidLeg2 = run(guard, makeReq({ path: "/execute", body: probeBody }));
check("unpaid probe passes", probe.nexted);
check("paid leg 2 with same body passes (probe was not recorded)", paidLeg2.nexted);

// ── 4. Different payer never collides ───────────────────────────────────────
const otherPayer = run(guard, makeReq({ path: "/execute", body: { ...batchBody }, apiKey: "other-key" }));
check("different payer, identical body passes", otherPayer.nexted);

// ── 5. Different body on same route passes ──────────────────────────────────
const diffBody = run(guard, makeReq({ path: "/execute", body: { ...batchBody, amounts: ["1", "2"] } }));
check("same route, different amounts passes", diffBody.nexted);

// ── 6. idempotency_key: route-scoped, same-key dup still blocked ────────────
const idemA = run(guard, makeReq({ path: "/estimate", body: { ...batchBody, idempotency_key: "k1" } }));
const idemB = run(guard, makeReq({ path: "/execute", body: { ...batchBody, idempotency_key: "k1" } }));
const idemDup = run(guard, makeReq({ path: "/execute", body: { ...batchBody, idempotency_key: "k1" } }));
check("same idempotency_key across estimate/execute passes", idemA.nexted && idemB.nexted);
check("same idempotency_key repeated on same route 409s", idemDup.status === 409);

// ── 7. Bodies with no payment-relevant fields stay exempt ───────────────────
const fund = run(guard, makeReq({ path: "/fund", body: { escrowId: "ESC-1" } }));
const fund2 = run(guard, makeReq({ path: "/fund", body: { escrowId: "ESC-1" } }));
check("no-payment-fields body exempt (fund x2 passes)", fund.nexted && fund2.nexted);

console.log(failures === 0 ? "\nAll duplicate-guard checks passed." : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
