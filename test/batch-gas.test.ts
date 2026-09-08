/**
 * Regression test: batch/execute gas limits vs live Base estimates
 * (src/routes/batch-payments.ts).
 *
 * Guards the class of bug where a static gas formula goes stale: the old
 * 50k + 65k/recipient limit funded a 1-recipient batch with 115k gas against
 * a measured ~129k, so it reverted out of gas on-chain.
 *
 * REQUIRES NETWORK (Base mainnet RPC, read-only — no funds move). Run:
 *   npm run test:gas
 */

import assert from "node:assert";
import { ethers } from "ethers";
import {
  batchPaymentHandler,
  batchGasFloor,
} from "../src/routes/batch-payments.js";

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const SPRAAY_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
// The deployer wallet holds a standing USDC allowance to the Spraay contract
// (granted 2026-09-03), which is what makes sprayToken simulate successfully
// under eth_estimateGas. Without an approved sender the simulation reverts
// and the handler falls back to the floor — which this test must NOT do,
// because the point is to compare the chosen limit against the live estimate.
const ESTIMABLE_SENDER = "0x75F3F4C27BB8DB5d72E82a5359674084025Fc82b";

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
  console.log("batch gas-limit vs live estimate");

  // A FRESH random address is the worst case: zero-balance recipients cost
  // ~20k more gas per transfer than warm ones.
  const freshRecipient = ethers.Wallet.createRandom().address;

  const { status, body } = await callHandler(batchPaymentHandler, {
    token: "USDC",
    recipients: [freshRecipient],
    amounts: ["1000"], // 0.001 USDC raw — estimation only, nothing is sent
    sender: ESTIMABLE_SENDER,
  });
  assert.strictEqual(status, 200);

  const gasLimitHex = body?.transaction?.gasLimit;
  assert.ok(
    typeof gasLimitHex === "string" && gasLimitHex.startsWith("0x"),
    "transaction.gasLimit missing from execute response — the gas fix regressed"
  );
  const chosen = Number(BigInt(gasLimitHex));
  assert.ok(
    chosen >= batchGasFloor(1),
    `chosen gasLimit ${chosen} is below the floor ${batchGasFloor(1)}`
  );
  console.log(`  ✓ execute response carries transaction.gasLimit = ${chosen}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const live = Number(
    await provider.estimateGas({
      from: ESTIMABLE_SENDER,
      to: SPRAAY_CONTRACT,
      data: body.transaction.data,
      value: body.transaction.value,
    })
  );
  assert.ok(
    chosen >= live * 1.2,
    `chosen gasLimit ${chosen} < live estimate ${live} × 1.2 — underfunded, would risk out-of-gas`
  );
  console.log(
    `  ✓ 1-recipient fresh-address batch: gasLimit ${chosen} ≥ live ${live} × 1.2 (margin ${(chosen / live).toFixed(2)}×)`
  );

  console.log("\n2 passed");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFAILED:", err);
  process.exit(1);
});
