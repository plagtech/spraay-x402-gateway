#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
// swap-and-pay mainnet dust proof (Phase 2)
//
//   node scripts/swap-and-pay-dust-proof.mjs              dry run: no signing
//   node scripts/swap-and-pay-dust-proof.mjs --broadcast  sign + send (needs key)
//
// Boots the local dist/ gateway against the rtp-proof mock Supabase + mock
// x402 facilitator (x402 is not under test here), calls the NEW endpoints
// over HTTP, and signs exactly the transaction /api/v1/swap-and-pay/execute
// returns. Chain reads/writes are real Base mainnet.
//
// Key: SWAPSPRAY_DUST_KEY from the process env, else the Windows user-scope
// env var of the same name. It must derive to the dust wallet, or we abort.
// The key is never printed.
//
// Hard spend cap: $1.00 worst case (value + gasLimit × maxFeePerGas + L1 fee).
// ════════════════════════════════════════════════════════════════════
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(REPO, "package.json"));
const { ethers } = require("ethers");

const BROADCAST = process.argv.includes("--broadcast");
const CAP_USD = 1.0;
const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const DUST = "0xe0DAa969c50ed9353bCDB9Fd6A3B3EA510F567E3";
const ROUTER = "0x8cfb5eBa99170d284120B885A47b08E28FD27379";
const SPRAY = "0x4B1d57EBFaBDF3F21F30f210a1d95f649E9edD4c";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const GAS_ORACLE = "0x420000000000000000000000000000000000000F";
const AMOUNT = 1000n; // 0.001 USDC each
const N = 3;
const GW_PORT = 3497, SB_PORT = 5595, FAC_PORT = 5596;
const GW = `http://127.0.0.1:${GW_PORT}`;

// Keyless recipients: nobody holds these keys.
const recipients = Array.from({ length: N }, (_, i) =>
  ethers.getAddress("0x" + ethers.solidityPackedKeccak256(["string", "uint256"], ["spraay.gateway.swapandpay.recipient.", i + 1]).slice(26)));

const provider = new ethers.JsonRpcProvider(RPC, 8453, { staticNetwork: true });
const usdc = new ethers.Contract(USDC, ["function balanceOf(address) view returns (uint256)", "event Transfer(address indexed from, address indexed to, uint256 value)"], provider);
const routerEvents = new ethers.Interface(["event SwapSettled(address indexed payer, bytes32 indexed poolId, address indexed currencyOut, uint256 output, uint256 total, uint256 fee, uint256 recipientCount, uint256 failedCount, uint256 refund)"]);
const pmEvents = new ethers.Interface(["event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)"]);

const kids = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (m) => { throw new Error(m); };
function launch(args, env = {}) {
  const c = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.log = ""; c.stdout.on("data", (d) => (c.log += d)); c.stderr.on("data", (d) => (c.log += d));
  kids.push(c); return c;
}
async function post(path, body, headers = {}) {
  const r = await fetch(GW + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}
// Mock-facilitator payment header (same as rtp-ext-proof): only gets us past the x402 gate.
function payHeader(accepted) {
  return Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature: "0x" + "ab".repeat(65), authorization: {
    from: "0xC0FFEE0000000000000000000000000000000003", to: accepted.payTo, value: accepted.amount, validAfter: "0",
    validBefore: String(Math.floor(Date.now() / 1000) + 3600), nonce: ethers.hexlify(ethers.randomBytes(32)) } } })).toString("base64");
}
async function paidPost(path, body) {
  const ch = await post(path, body);
  if (ch.status !== 402) fail(`${path}: expected 402 challenge, got ${ch.status}`);
  const acc = (ch.body.accepts || []).find((a) => String(a.network).startsWith("eip155")) || fail("no EVM accepts");
  return post(path, body, { "PAYMENT-SIGNATURE": payHeader(acc) });
}
function loadKey() {
  if (process.env.SWAPSPRAY_DUST_KEY) return process.env.SWAPSPRAY_DUST_KEY.trim();
  try {
    return execFileSync("powershell", ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('SWAPSPRAY_DUST_KEY','User')"], { encoding: "utf8" }).trim() || null;
  } catch { return null; }
}

const report = { date: new Date().toISOString(), mode: BROADCAST ? "broadcast" : "dry-run", recipients, amountEach: AMOUNT.toString() };

async function main() {
  let wallet = null;
  if (BROADCAST) {
    const key = loadKey() || fail("SWAPSPRAY_DUST_KEY not set (process env or Windows user env)");
    wallet = new ethers.Wallet(key, provider);
    if (wallet.address !== DUST) fail(`key derives to ${wallet.address}, not the dust wallet — aborting`);
    console.log("▸ key loaded, derives to dust wallet");
  }

  console.log("▸ building dist/ (tsc)");
  execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", ["tsc"], { cwd: REPO, stdio: "inherit", shell: process.platform === "win32" });

  console.log("▸ booting local gateway (mock supabase + mock facilitator, real Base RPC)");
  launch([join(REPO, "scripts/rtp-proof/mock-supabase.mjs"), String(SB_PORT)]);
  launch([join(REPO, "scripts/rtp-proof/mock-facilitator.mjs"), String(FAC_PORT)]);
  await sleep(1500);
  const gw = launch([join(REPO, "dist/index.js")], {
    PORT: String(GW_PORT), BASE_URL: GW, SUPABASE_URL: `http://127.0.0.1:${SB_PORT}`, SUPABASE_SERVICE_KEY: "proof",
    SUPABASE_SERVICE_ROLE_KEY: "proof", SUPABASE_ANON_KEY: "proof", X402_FACILITATOR_URL: `http://127.0.0.1:${FAC_PORT}`,
    PAY_TO_ADDRESS: "0x9999999999999999999999999999999999999999", SOLANA_RECEIVE_ADDRESS: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
    SOLANA_PAYMENTS_ENABLED: "false", RESEND_API_KEY: "re_x", STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_x",
    TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000", TWILIO_AUTH_TOKEN: "x", NODE_ENV: "development", BASE_RPC_URL: RPC,
  });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { up = (await fetch(GW + "/health")).ok; } catch {} if (!up) await sleep(1000); }
  if (!up) fail("gateway did not start\n" + gw.log.slice(-3000));

  const body = { sender: DUST, recipients, amounts: recipients.map(() => AMOUNT.toString()), inputToken: "ETH" };

  // Negative test
  const neg = await paidPost("/api/v1/swap-and-pay/execute", { ...body, inputToken: "DAI" });
  console.log(`▸ negative (inputToken DAI): ${neg.status} ${JSON.stringify(neg.body)}`);
  if (neg.status !== 400 || !String(neg.body.error).includes("Unsupported inputToken")) fail("negative test did not 400");
  report.negative = neg;

  // Estimate + execute through the new endpoints
  const est = await paidPost("/api/v1/swap-and-pay/estimate", body);
  if (est.status !== 200) fail(`estimate ${est.status} ${JSON.stringify(est.body)}`);
  console.log(`▸ estimate: ethIn=${est.body.quote.ethIn} maxEthIn=${est.body.quote.maxEthIn} usdc/eth=${est.body.pool.usdcPerEth} gas=${est.body.suggestedGasLimit} (${est.body.gasLimitSource})`);
  const ex = await paidPost("/api/v1/swap-and-pay/execute", { ...body, idempotency_key: "dust-" + Date.now() });
  if (ex.status !== 200) fail(`execute ${ex.status} ${JSON.stringify(ex.body)}`);
  const tx = ex.body.transaction;
  console.log(`▸ execute: to=${tx.to} value=${tx.value} gasLimit=${tx.gasLimit} (${ex.body.gasLimitSource}) chainId=${tx.chainId}`);
  report.estimate = est.body; report.execute = ex.body;

  // Pre-flight
  if (tx.to !== ROUTER || tx.chainId !== 8453 || tx.from !== DUST || !tx.data.startsWith("0x04846b1d")) fail("unexpected transaction target/shape");
  if (ex.body.gasLimitSource !== "estimate") fail("gas limit fell back to floor — estimation failed, not broadcasting");
  const before = await Promise.all(recipients.map((r) => usdc.balanceOf(r)));
  if (before.some((b) => b !== 0n)) fail(`recipients not empty: ${before}`);

  const fee = await provider.getFeeData();
  const maxFee = fee.maxFeePerGas ?? fail("no maxFeePerGas");
  const prio = fee.maxPriorityFeePerGas ?? 1_000_000n;
  const gasLimit = BigInt(tx.gasLimit);
  const unsigned = ethers.Transaction.from({ type: 2, chainId: 8453, to: tx.to, data: tx.data, value: BigInt(tx.value), gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio, nonce: await provider.getTransactionCount(DUST) });
  const oracle = new ethers.Contract(GAS_ORACLE, ["function getL1Fee(bytes) view returns (uint256)"], provider);
  const l1Fee = (await oracle.getL1Fee(unsigned.unsignedSerialized)) * 2n; // 2× cushion
  const worstWei = BigInt(tx.value) + gasLimit * maxFee + l1Fee;
  const usdPerEth = Number(est.body.pool.usdcPerEth);
  const worstUsd = Number(ethers.formatEther(worstWei)) * usdPerEth;
  const balBefore = await provider.getBalance(DUST);
  console.log(`▸ worst-case spend ${ethers.formatEther(worstWei)} ETH ≈ $${worstUsd.toFixed(4)} (cap $${CAP_USD}); dust balance ${ethers.formatEther(balBefore)} ETH`);
  report.preflight = { worstWei: worstWei.toString(), worstUsd, usdPerEth, balBefore: balBefore.toString(), maxFeePerGas: maxFee.toString(), l1FeeCushioned: l1Fee.toString() };
  if (worstUsd >= CAP_USD) fail("worst case exceeds the $1 cap — aborting");
  if (balBefore < worstWei) fail("dust wallet balance below worst case");

  if (!BROADCAST) {
    console.log("\nDRY RUN complete — nothing signed or sent. Re-run with --broadcast to send.");
    return;
  }

  // Broadcast
  const sent = await wallet.sendTransaction({ type: 2, chainId: 8453, to: tx.to, data: tx.data, value: BigInt(tx.value), gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: prio });
  console.log(`▸ sent ${sent.hash}`);
  report.txHash = sent.hash;
  const rcpt = await sent.wait(1, 180_000);
  report.receipt = { status: rcpt.status, block: rcpt.blockNumber, gasUsed: rcpt.gasUsed.toString(), effectiveGasPrice: (rcpt.gasPrice ?? 0n).toString(), l1Fee: rcpt.l1Fee?.toString?.() };
  console.log(`▸ mined block ${rcpt.blockNumber} status ${rcpt.status} gasUsed ${rcpt.gasUsed}`);
  if (rcpt.status !== 1) fail("transaction reverted");

  // Verify from logs and balances
  const transfers = rcpt.logs.filter((l) => l.address.toLowerCase() === USDC.toLowerCase()).map((l) => usdc.interface.parseLog(l)).filter(Boolean)
    .map((p) => ({ from: p.args.from, to: p.args.to, value: p.args.value }));
  const settled = rcpt.logs.filter((l) => l.address === ROUTER).map((l) => { try { return routerEvents.parseLog(l); } catch { return null; } }).find(Boolean);
  const swap = rcpt.logs.filter((l) => l.address === POOL_MANAGER).map((l) => { try { return pmEvents.parseLog(l); } catch { return null; } }).find(Boolean);
  const after = await Promise.all(recipients.map((r) => usdc.balanceOf(r)));
  const routerUsdc = await usdc.balanceOf(ROUTER), routerEth = await provider.getBalance(ROUTER);
  const balAfter = await provider.getBalance(DUST, rcpt.blockNumber);
  const totalSpendWei = balBefore - balAfter;
  // Fee leg: the one USDC transfer that is not the pool → router take, not to a
  // recipient, and not a refund to the payer.
  const notFee = new Set([...recipients, DUST, ROUTER, SPRAY, POOL_MANAGER]);
  const feeTransfer = transfers.find((t) => t.from !== POOL_MANAGER && !notFee.has(t.to));
  const expectedFee = (AMOUNT * BigInt(N) * 30n) / 10_000n;

  const checks = {
    routerCalled: rcpt.to === ROUTER,
    v4SwapOnPool: !!swap && swap.args.id === ex.body.pool.poolId,
    recipientsPaidExactly: after.every((b, i) => b - before[i] === AMOUNT) && recipients.every((r) => transfers.some((t) => t.to === r && t.value === AMOUNT)),
    sprayFeeCollected: !!feeTransfer && feeTransfer.value === expectedFee,
    settledNoFailures: !!settled && settled.args.failedCount === 0n && settled.args.refund === 0n,
    routerHoldsNothing: routerUsdc === 0n && routerEth === 0n,
    underCap: Number(ethers.formatEther(totalSpendWei)) * usdPerEth < CAP_USD,
  };
  report.verify = {
    swap: swap && { amount0: swap.args.amount0.toString(), amount1: swap.args.amount1.toString() },
    settled: settled && Object.fromEntries(["output", "total", "fee", "recipientCount", "failedCount", "refund"].map((k) => [k, settled.args[k].toString()])),
    transfers: transfers.map((t) => ({ ...t, value: t.value.toString() })),
    feeRecipient: feeTransfer?.to, feeAmount: feeTransfer?.value.toString(), expectedFee: expectedFee.toString(),
    recipientDeltas: after.map((b, i) => (b - before[i]).toString()),
    balAfter: balAfter.toString(), totalSpendWei: totalSpendWei.toString(),
    totalSpendUsd: Number(ethers.formatEther(totalSpendWei)) * usdPerEth,
    checks,
  };
  console.log(JSON.stringify(report.verify, null, 1));
  if (!Object.values(checks).every(Boolean)) fail("one or more verification checks failed");
  console.log(`\nDUST PROOF PASSED — https://basescan.org/tx/${sent.hash}`);
}

main()
  .catch((e) => { console.error("\nABORT:", e.message); report.error = e.message; process.exitCode = 1; })
  .finally(() => {
    kids.forEach((k) => k.kill());
    const out = process.env.PROOF_REPORT || join(REPO, "docs/proofs", `swap-and-pay-dust-proof-${report.mode}.json`);
    writeFileSync(out, JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
    console.log("report:", out);
  });
