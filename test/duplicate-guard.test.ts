/**
 * Regression tests for the duplicate-payment guard (src/middleware/loop-safety.ts).
 *
 * These drive the middleware directly with fake req/res objects — no network,
 * no framework — so they run with just ts-node:
 *
 *   npx ts-node --transpile-only test/duplicate-guard.test.ts
 *
 * The headline case is the x402 two-leg flow:
 *   leg 1 — same body, NO payment header  → must pass through, leave NO guard
 *           entry (the 402 itself comes from the downstream payment middleware)
 *   leg 2 — same body, WITH X-PAYMENT     → must pass the guard (not 409)
 */

import assert from "node:assert";
// Extensionless import: this test runs under ts-node's CommonJS resolution
// (`npx ts-node --transpile-only`) and is excluded from the tsc build, so it
// doesn't need the NodeNext `.js` specifier the rest of the codebase uses.
import { duplicatePaymentGuard } from "../src/middleware/loop-safety";

const guard = duplicatePaymentGuard();

interface Outcome {
  nexted: boolean;
  status?: number;
  body?: any;
}

/** Invoke the guard once with the given headers + body; report what it did. */
function call(headers: Record<string, string>, body: unknown): Outcome {
  const out: Outcome = { nexted: false };
  const req: any = {
    method: "POST",
    path: "/api/v1/batch/execute",
    ip: "10.0.0.1",
    headers,
    body,
  };
  const res: any = {
    statusCode: 200,
    status(code: number) {
      this.statusCode = code;
      out.status = code;
      return this;
    },
    json(payload: any) {
      out.body = payload;
      return this;
    },
    setHeader() {
      return this;
    },
  };
  guard(req, res, () => {
    out.nexted = true;
  });
  return out;
}

const PAID = { "x-payment": "0xdeadbeefsignatureblob" };
const UNPAID = {}; // leg 1 of x402 — no payment credential
const batchBody = {
  token: "USDC",
  recipients: [{ address: "0xRecipient", amount: "10.00" }],
  sender: "0xSender0000000000000000000000000000000001",
};

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log("duplicate-payment guard — two-leg x402 flow");

// ── The regression: leg 1 (unpaid) must not poison leg 2 (paid) ──────────────
test("leg 1: same body WITHOUT payment header passes and registers nothing", () => {
  const leg1 = call(UNPAID, batchBody);
  assert.strictEqual(leg1.nexted, true, "unpaid probe must call next()");
  assert.strictEqual(leg1.status, undefined, "unpaid probe must not be 409'd");
});

test("leg 2: identical body WITH X-PAYMENT passes the guard (not 409)", () => {
  const leg2 = call(PAID, batchBody);
  assert.strictEqual(leg2.nexted, true, "first paid submission must pass");
  assert.strictEqual(
    leg2.status,
    undefined,
    "leg 2 must NOT be 409 — leg 1 should never have registered the payload"
  );
});

// ── The guard still does its real job for genuine paid duplicates ────────────
test("leg 3: replaying the SAME paid body within cooldown IS blocked (409)", () => {
  const leg3 = call(PAID, batchBody);
  assert.strictEqual(leg3.status, 409, "genuine paid duplicate must be 409");
  assert.strictEqual(leg3.body?.error, "duplicate_payment_detected");
  assert.strictEqual(leg3.nexted, false, "blocked request must not reach the route");
});

// ── idempotency_key is used as the dedupe key ────────────────────────────────
test("idempotency_key: first use passes, exact replay is 409", () => {
  const body = { ...batchBody, idempotency_key: "run-42" };
  const first = call(PAID, body);
  assert.strictEqual(first.nexted, true, "new idempotency_key must pass");
  const replay = call(PAID, body);
  assert.strictEqual(replay.status, 409, "same idempotency_key must be blocked");
});

test("idempotency_key: a different key with identical payload is NOT blocked", () => {
  // Same recipients/amounts as the key above, but a fresh idempotency_key.
  const body = { ...batchBody, idempotency_key: "run-43" };
  const out = call(PAID, body);
  assert.strictEqual(out.nexted, true, "distinct idempotency_key must pass");
  assert.strictEqual(out.status, undefined);
});

// ── Keyed by payer, not payload alone ────────────────────────────────────────
test("different payer with an identical body is NOT blocked by another's entry", () => {
  // batchBody already 409's for the default payer (see leg 3). A different
  // payer (distinct API key) submitting the very same body must still pass.
  const out = call({ ...PAID, "x-api-key": "someone-elses-key" }, batchBody);
  assert.strictEqual(out.nexted, true, "a different payer must not be 409'd");
  assert.strictEqual(out.status, undefined);
});

console.log(`\n${passed} passed`);
// Module-level cleanup intervals in loop-safety keep the event loop alive.
process.exit(0);
