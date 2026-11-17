/**
 * Offline tests for /api/v1/swap-and-pay/{estimate,execute} (src/routes/swap-and-pay.ts).
 *
 *   npx ts-node --project test/tsconfig.json test/swap-and-pay.test.ts   (npm run test:swap-and-pay)
 *
 * No network: on-chain reads (router.requiredOutput, V4Quoter, StateView,
 * eth_estimateGas) go through a stub installed with __setSwapAndPayChainForTests.
 */

import assert from "node:assert";
import { ethers } from "ethers";
import {
  swapAndPayEstimateHandler,
  swapAndPayExecuteHandler,
  __setSwapAndPayChainForTests,
  swapAndSprayRouterInterface,
  SWAP_AND_SPRAY_SELECTOR,
  SWAP_AND_SPRAY_ROUTER,
  SWAP_AND_PAY_SPRAY,
  BASE_USDC,
  ETH_USDC_POOL_ID,
  swapAndPayGasFloor,
  usdcPerEthFromSqrtPrice,
  type SwapAndPayChain,
} from "../src/routes/swap-and-pay.js";

const SENDER = "0xe0DAa969c50ed9353bCDB9Fd6A3B3EA510F567E3";
const A1 = "0x1111111111111111111111111111111111111111";
const A2 = "0x2222222222222222222222222222222222222222";
// Real slot0 read on 2026-11-17 (~1790.45 USDC/ETH).
const SQRT_PRICE = 3352438120954210978629992n;
const QUOTE_WEI = 1_124_322_279_709n;

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function callHandler(handler: (req: any, res: any) => any, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const res: any = {
      statusCode: 200,
      status(code: number) { this.statusCode = code; return this; },
      json(payload: any) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    handler({ body }, res);
  });
}

interface StubOpts {
  gas?: bigint | Error;
  quote?: bigint | Error;
  feeBps?: bigint;
}
const calls: { estimateGas: any[]; quote: bigint[] } = { estimateGas: [], quote: [] };
function installStub(opts: StubOpts = {}) {
  calls.estimateGas = [];
  calls.quote = [];
  const stub: SwapAndPayChain = {
    async requiredOutput(spec) {
      const total = spec[5].reduce((a, b) => a + b, 0n);
      return total + (total * (opts.feeBps ?? 30n)) / 10_000n;
    },
    async quoteExactOutput(out) {
      calls.quote.push(out);
      if (opts.quote instanceof Error) throw opts.quote;
      return opts.quote ?? QUOTE_WEI;
    },
    async slot0() { return { sqrtPriceX96: SQRT_PRICE, tick: -201419 }; },
    async estimateGas(tx) {
      calls.estimateGas.push(tx);
      if (opts.gas instanceof Error) throw opts.gas;
      return opts.gas ?? 383_166n;
    },
  };
  __setSwapAndPayChainForTests(() => stub);
}

const good = () => ({ sender: SENDER, recipients: [A1, A2], amounts: ["1000", "1000"], inputToken: "ETH" });

async function main() {
  installStub();

  console.log("constants");
  await test("selector is swapAndSpray 0x04846b1d (matches on-chain recon)", () => {
    assert.strictEqual(SWAP_AND_SPRAY_SELECTOR, "0x04846b1d");
  });
  await test("poolId matches the hookless ETH/USDC 0.30% pool", () => {
    assert.strictEqual(ETH_USDC_POOL_ID, "0xe070797535b13431808f8fc81fdbe7b41362960ed0b55bc2b6117c49c51b7eb9");
  });
  await test("sqrtPrice → USDC/ETH", () => {
    const p = Number(ethers.formatUnits(usdcPerEthFromSqrtPrice(SQRT_PRICE), 6));
    assert.ok(p > 1790 && p < 1791, String(p));
  });

  console.log("validation (both endpoints)");
  const cases: Array<[string, any, RegExp]> = [
    ["missing sender", { ...good(), sender: undefined }, /sender is required/],
    ["bad sender", { ...good(), sender: "0x123" }, /sender is required/],
    ["zero sender", { ...good(), sender: ethers.ZeroAddress }, /sender is required/],
    ["missing recipients", { ...good(), recipients: undefined }, /recipients array required/],
    ["empty recipients", { ...good(), recipients: [], amounts: [] }, /recipients array required/],
    ["201 recipients", { ...good(), recipients: Array(201).fill(A1), amounts: Array(201).fill("1") }, /Maximum 200/],
    ["length mismatch", { ...good(), amounts: ["1000"] }, /same length/],
    ["invalid recipient", { ...good(), recipients: [A1, "0xnope"] }, /recipients\[1\] must be a 0x address/],
    ["zero-address recipient", { ...good(), recipients: [A1, ethers.ZeroAddress] }, /zero address/],
    ["Spray as recipient", { ...good(), recipients: [SWAP_AND_PAY_SPRAY, A2] }, /Spray contract/],
    ["router as recipient", { ...good(), recipients: [A1, SWAP_AND_SPRAY_ROUTER.toLowerCase()] }, /router/],
    ["zero amount", { ...good(), amounts: ["0", "1"] }, /greater than zero/],
    ["decimal amount", { ...good(), amounts: ["1.5", "1"] }, /raw base-unit integer/],
    ["negative amount", { ...good(), amounts: ["-1", "1"] }, /raw base-unit integer/],
    ["slippage too high", { ...good(), slippageBps: 501 }, /slippageBps/],
    ["fractional slippage", { ...good(), slippageBps: 1.5 }, /slippageBps/],
  ];
  for (const handler of [swapAndPayEstimateHandler, swapAndPayExecuteHandler]) {
    for (const [name, body, msg] of cases) {
      await test(`${handler.name}: ${name} → 400`, async () => {
        const r = await callHandler(handler, body);
        assert.strictEqual(r.status, 400, JSON.stringify(r.body));
        assert.match(r.body.error, msg);
      });
    }
    await test(`${handler.name}: inputToken DAI → 400 with supportedInputTokens`, async () => {
      const r = await callHandler(handler, { ...good(), inputToken: "DAI" });
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /Unsupported inputToken "DAI"/);
      assert.deepStrictEqual(r.body.supportedInputTokens, ["ETH"]);
    });
    await test(`${handler.name}: validation failures make no chain calls`, async () => {
      installStub();
      await callHandler(handler, { ...good(), sender: undefined });
      assert.strictEqual(calls.quote.length + calls.estimateGas.length, 0);
    });
  }
  await test("execute: past deadline → 400", async () => {
    const r = await callHandler(swapAndPayExecuteHandler, { ...good(), deadline: 1000 });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /not in the future/);
  });
  await test("inputToken omitted or lowercase eth is accepted", async () => {
    const { inputToken, ...noToken } = good();
    assert.strictEqual((await callHandler(swapAndPayEstimateHandler, noToken)).status, 200);
    assert.strictEqual((await callHandler(swapAndPayEstimateHandler, { ...good(), inputToken: "eth" })).status, 200);
  });

  console.log("estimate");
  await test("returns expected shape and math", async () => {
    installStub();
    const r = await callHandler(swapAndPayEstimateHandler, good());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    for (const k of ["success", "chainId", "router", "sprayContract", "inputToken", "outputToken", "supportedInputTokens", "pool", "payout", "quote", "suggestedGasLimit", "gasLimitSource", "note"]) {
      assert.ok(k in b, `missing ${k}`);
    }
    assert.strictEqual(b.router, SWAP_AND_SPRAY_ROUTER);
    assert.strictEqual(b.sprayContract, SWAP_AND_PAY_SPRAY);
    assert.strictEqual(b.outputToken.address, BASE_USDC);
    assert.deepStrictEqual(b.supportedInputTokens, ["ETH"]);
    assert.strictEqual(b.payout.totalAmount, "0.002");
    assert.strictEqual(b.payout.fee, "0.000006"); // floor(2000 * 30 / 10000) = 6
    assert.strictEqual(b.payout.requiredOutputRaw, "2006");
    assert.deepStrictEqual(calls.quote, [2006n], "quotes exactly requiredOutput");
    assert.strictEqual(b.quote.ethIn, QUOTE_WEI.toString());
    assert.strictEqual(b.quote.slippageBps, 50);
    assert.strictEqual(b.quote.maxEthIn, ((QUOTE_WEI * 10050n + 9999n) / 10000n).toString());
    assert.strictEqual(b.suggestedGasLimit, "574749", "383,166 × 1.5, above the 570k floor");
    assert.strictEqual(b.gasLimitSource, "estimate");
  });

  console.log("execute");
  await test("unsigned tx targets router on chain 8453 with correct calldata", async () => {
    installStub();
    const before = Math.floor(Date.now() / 1000);
    const r = await callHandler(swapAndPayExecuteHandler, { ...good(), slippageBps: 100 });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const tx = r.body.transaction;
    assert.strictEqual(tx.to, SWAP_AND_SPRAY_ROUTER);
    assert.strictEqual(tx.from, SENDER);
    assert.strictEqual(tx.chainId, 8453);
    assert.ok(tx.data.startsWith("0x04846b1d"));
    assert.ok(!("approvalRequired" in r.body), "native ETH input needs no approval");
    const maxIn = (QUOTE_WEI * 10100n + 9999n) / 10000n;
    assert.strictEqual(tx.value, maxIn.toString());

    const [key, params, amountLimit, spec, deadline] = swapAndSprayRouterInterface.decodeFunctionData("swapAndSpray", tx.data);
    assert.deepStrictEqual([key[0], key[1], key[2], key[3], key[4]], [ethers.ZeroAddress, BASE_USDC, 3000n, 60n, ethers.ZeroAddress]);
    assert.strictEqual(params[0], true, "zeroForOne");
    assert.strictEqual(params[1], 2006n, "exact-output: amountSpecified = +requiredOutput");
    assert.strictEqual(params[2], 4295128740n, "MIN_SQRT_PRICE + 1");
    assert.strictEqual(amountLimit, maxIn, "amountLimit = msg.value = max ETH in");
    assert.strictEqual(spec[0], 1n, "AMOUNTS mode");
    assert.strictEqual(spec[1], SENDER, "payer = sender");
    assert.strictEqual(spec[3], 30n, "maxFeeBps");
    assert.deepStrictEqual([...spec[4]], [A1, A2]);
    assert.deepStrictEqual([...spec[5]], [1000n, 1000n]);
    const d = Number(deadline);
    assert.ok(d >= before + 300 && d <= before + 302, `default deadline ${d}`);
    assert.strictEqual(r.body.deadline, d);
  });
  await test("explicit deadline is passed through", async () => {
    const want = Math.floor(Date.now() / 1000) + 900;
    const r = await callHandler(swapAndPayExecuteHandler, { ...good(), deadline: want });
    const decoded = swapAndSprayRouterInterface.decodeFunctionData("swapAndSpray", r.body.transaction.data);
    assert.strictEqual(Number(decoded[4]), want);
  });
  await test("gas estimate is run on the exact tx from sender", async () => {
    installStub();
    const r = await callHandler(swapAndPayExecuteHandler, good());
    assert.strictEqual(calls.estimateGas.length, 1);
    const g = calls.estimateGas[0];
    assert.strictEqual(g.from, SENDER);
    assert.strictEqual(g.to, SWAP_AND_SPRAY_ROUTER);
    assert.strictEqual(g.data, r.body.transaction.data);
    assert.strictEqual(g.value, r.body.transaction.value);
  });

  console.log("gas limit");
  await test("estimate × 1.5 when above the floor", async () => {
    installStub({ gas: 1_000_000n });
    const r = await callHandler(swapAndPayExecuteHandler, good());
    assert.strictEqual(r.body.transaction.gasLimit, "0x" + (1_500_000).toString(16));
    assert.strictEqual(r.body.gasLimitSource, "estimate");
  });
  await test("never below floor (500k + 35k/recipient)", async () => {
    installStub({ gas: 100_000n });
    const r = await callHandler(swapAndPayExecuteHandler, good());
    assert.strictEqual(parseInt(r.body.transaction.gasLimit, 16), 570_000);
  });
  await test("estimateGas failure → floor", async () => {
    installStub({ gas: new Error("insufficient funds") });
    const r = await callHandler(swapAndPayEstimateHandler, good());
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.suggestedGasLimit, "570000");
    assert.strictEqual(r.body.gasLimitSource, "floor");
  });
  await test("200-recipient floor covers GAS.md's 6.89M minimum working limit", () => {
    assert.ok(swapAndPayGasFloor(200) >= 6_890_389, String(swapAndPayGasFloor(200)));
  });

  console.log("quote failures");
  await test("pool cannot fill (CALL_EXCEPTION) → 400", async () => {
    const e: any = new Error("revert");
    e.code = "CALL_EXCEPTION";
    installStub({ quote: e });
    const r = await callHandler(swapAndPayExecuteHandler, good());
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /cannot fill/);
  });
  await test("RPC failure → 502", async () => {
    installStub({ quote: new Error("ECONNRESET") });
    const r = await callHandler(swapAndPayEstimateHandler, good());
    assert.strictEqual(r.status, 502);
  });

  __setSwapAndPayChainForTests(null);
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
