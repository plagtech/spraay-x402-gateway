/**
 * Regression tests for batch-payment body-shape + unit semantics
 * (src/routes/batch-payments.ts).
 *
 * Run with ts-node (no framework). The test tsconfig enables experimentalResolver
 * so the source's NodeNext `.js` import specifiers resolve to their .ts files:
 *   npx ts-node --project test/tsconfig.json test/batch-shape.test.ts   (npm run test:batch)
 *
 * Covers the two accepted shapes and their DIFFERENT unit rules:
 *   • Flat format   — recipients: string[], amounts: string[] in RAW base units
 *                     ("310000" @ 6dp = 0.31 USDC), BigInt directly.
 *   • Legacy object — recipients: [{address, amount}] human-decimal ("0.31"),
 *                     scaled with parseUnits.
 * Both must converge on identical raw totals, and the estimate path must agree
 * with the execute path.
 */

import assert from "node:assert";
import { ethers } from "ethers";
// NodeNext ESM resolution (run via `ts-node --esm`) maps this `.js` specifier to
// the .ts source — required because batch-payments transitively imports other
// `.js` modules that only resolve under ESM.
import {
  resolveBatchAmounts,
  batchFee,
  SPRAAY_FEE_BPS,
  batchPaymentHandler,
  batchEstimateHandler,
} from "../src/routes/batch-payments.js";

// Valid 40-hex addresses (ABI encoding in the execute path needs real addresses).
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";

let passed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed++;
    console.log(`  ✓ ${name}`);
  });
}

/** Drive an async Express handler with a fake req/res; resolve the JSON + status. */
function callHandler(
  handler: (req: any, res: any) => any,
  body: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req: any = { body };
    const res: any = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: any) {
        resolve({ status: this.statusCode, body: payload });
        return this;
      },
    };
    Promise.resolve(handler(req, res)).catch((err) =>
      resolve({ status: 599, body: { error: String(err) } })
    );
  });
}

async function main() {
  console.log("batch shape + unit semantics");

  // ── Flat format: RAW units, BigInt directly (the client's real payload) ──
  await test('flat: amounts are raw base units — "310000" @ 6dp = 0.31, no parseUnits', () => {
    const { onchainRecipients, totalRaw } = resolveBatchAmounts([A1], ["310000"], 6);
    assert.strictEqual(totalRaw, 310000n);
    assert.strictEqual(onchainRecipients[0].recipient, A1);
    assert.strictEqual(onchainRecipients[0].amount, 310000n);
    assert.strictEqual(ethers.formatUnits(totalRaw, 6), "0.31");
  });

  await test("flat: multiple recipients sum in raw units", () => {
    const { totalRaw } = resolveBatchAmounts([A1, A2], ["310000", "690000"], 6);
    assert.strictEqual(totalRaw, 1_000_000n);
    assert.strictEqual(ethers.formatUnits(totalRaw, 6), "1.0");
  });

  // ── Legacy object format: HUMAN-DECIMAL, scaled with parseUnits ──
  await test('object: amounts are human-decimal — "0.31" @ 6dp scales to 310000', () => {
    const { onchainRecipients, totalRaw } = resolveBatchAmounts(
      [{ address: A1, amount: "0.31" }],
      undefined,
      6
    );
    assert.strictEqual(totalRaw, 310000n);
    assert.strictEqual(onchainRecipients[0].recipient, A1);
    assert.strictEqual(onchainRecipients[0].amount, 310000n);
  });

  // ── The two shapes converge on the SAME raw units ──
  await test('equivalence: flat "310000" === object "0.31" (6dp) at the raw level', () => {
    const flat = resolveBatchAmounts([A1], ["310000"], 6).totalRaw;
    const obj = resolveBatchAmounts([{ address: A1, amount: "0.31" }], undefined, 6).totalRaw;
    assert.strictEqual(flat, obj);
    assert.strictEqual(flat, 310000n);
  });

  await test('equivalence at 18dp: flat "1500000000000000000" === object "1.5"', () => {
    const flat = resolveBatchAmounts([A1], ["1500000000000000000"], 18).totalRaw;
    const obj = resolveBatchAmounts([{ address: A1, amount: "1.5" }], undefined, 18).totalRaw;
    assert.strictEqual(flat, obj);
    assert.strictEqual(flat, 1_500_000_000_000_000_000n);
  });

  // ── Fee math: 0.3% (30 bps) of the raw total ──
  await test("fee: 30 bps of 1_000_000 raw = 3000 (0.003 @ 6dp)", () => {
    assert.strictEqual(SPRAAY_FEE_BPS, 30);
    const fee = batchFee(1_000_000n);
    assert.strictEqual(fee, 3000n);
    assert.strictEqual(ethers.formatUnits(fee, 6), "0.003");
  });

  // ── Validation ──
  await test("flat without amounts[] is rejected (400)", () => {
    assert.throws(() => resolveBatchAmounts([A1], undefined, 6), /amounts/);
  });

  await test("flat with mismatched amounts length is rejected", () => {
    assert.throws(() => resolveBatchAmounts([A1, A2], ["310000"], 6), /same length/);
  });

  await test('flat with a decimal (non-integer) amount is rejected — raw units only', () => {
    assert.throws(() => resolveBatchAmounts([A1], ["0.31"], 6), /raw base-unit integer/);
  });

  await test("object with a missing amount is rejected (no more parseUnits('undefined'))", () => {
    assert.throws(() => resolveBatchAmounts([{ address: A1 }], undefined, 6), /amount is required/);
  });

  // ── End-to-end: execute succeeds on the flat payload that used to 500 ──
  await test("execute: flat payload (the client's real body) returns 200, not 500", async () => {
    const { status, body } = await callHandler(batchPaymentHandler, {
      token: "USDC",
      chain: "base",
      recipients: [A1, A2],
      amounts: ["310000", "690000"],
      sender: A1,
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.batch.totalAmount, "1.0");
    assert.strictEqual(body.batch.fee, "0.003");
  });

  // ── The estimate path agrees with the execute path (same interpretation) ──
  await test("estimate === execute totals for the SAME flat body", async () => {
    const flatBody = { token: "USDC", recipients: [A1, A2], amounts: ["310000", "690000"], sender: A1 };
    const exec = await callHandler(batchPaymentHandler, flatBody);
    const est = await callHandler(batchEstimateHandler, flatBody);
    assert.strictEqual(exec.status, 200);
    assert.strictEqual(est.status, 200);
    assert.strictEqual(est.body.totalAmount, exec.body.batch.totalAmount);
    assert.strictEqual(est.body.fee, exec.body.batch.fee);
    assert.strictEqual(est.body.totalWithFee, exec.body.batch.totalWithFee);
  });

  await test("execute: flat and object bodies yield identical totals end-to-end", async () => {
    const flat = await callHandler(batchPaymentHandler, {
      token: "USDC",
      recipients: [A1],
      amounts: ["310000"],
      sender: A1,
    });
    const obj = await callHandler(batchPaymentHandler, {
      token: "USDC",
      recipients: [{ address: A1, amount: "0.31" }],
      sender: A1,
    });
    assert.strictEqual(flat.status, 200);
    assert.strictEqual(obj.status, 200);
    assert.strictEqual(flat.body.batch.totalAmount, "0.31");
    assert.strictEqual(flat.body.batch.totalAmount, obj.body.batch.totalAmount);
    assert.strictEqual(flat.body.batch.totalWithFee, obj.body.batch.totalWithFee);
  });

  await test("execute: bad body (missing amounts on flat) returns 400, not 500", async () => {
    const { status } = await callHandler(batchPaymentHandler, {
      token: "USDC",
      recipients: [A1, A2],
      sender: A1,
    });
    assert.strictEqual(status, 400);
  });

  console.log(`\n${passed} passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
