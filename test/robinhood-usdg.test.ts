/**
 * Regression tests for the Robinhood Chain (4663) USDG rail
 * (src/rails/robinhoodUsdg.ts + src/rails/robinhoodUsdgMpp.ts).
 *
 * Fully offline: the chain is a stub, signatures are real EIP-712 signatures
 * from a throwaway wallet. No network, no funds, no keys from .env.
 *
 *   npm run test:usdg
 *   (npx ts-node --transpile-only test/robinhood-usdg.test.ts)
 */

import assert from "node:assert";
import { ethers } from "ethers";
import {
  RobinhoodUsdgRail,
  ROBINHOOD_NETWORK,
  USDG,
  SETTLE_GAS_FLOOR,
  RAIL_NOT_ENABLED_REASON,
  robinhoodUsdgMoneyParser,
  usdToUsdgUnits,
  usdgEip712Domain,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  type RobinhoodChain,
  type SettleTx,
} from "../src/rails/robinhoodUsdg";
import { mppChallengeNonce, mppPrecheck, mppToX402 } from "../src/rails/robinhoodUsdgMpp";

// ── fixtures ──────────────────────────────────────────────────────────────
const PAY_TO = "0xdAA0fb4fb470AA8fb53A0c301EF9AADC89949F33";
const FACILITATOR_KEY = ethers.Wallet.createRandom().privateKey; // throwaway, never funded
const payer = ethers.Wallet.createRandom();
let NOW = 1_800_000_000;
const now = () => NOW;
const quiet = { log() {}, warn() {}, error() {} };

interface StubState {
  balance: bigint;
  used: Set<string>;
  estimate: bigint;
  receiptStatus: number;
  sends: Array<SettleTx & { gasLimit: bigint }>;
  calls: string[];
  waitDelayMs: number;
}
function stubChain(over: Partial<StubState> = {}): { chain: RobinhoodChain; st: StubState } {
  const st: StubState = {
    balance: 10_000_000n, used: new Set(), estimate: 105_467n, receiptStatus: 1,
    sends: [], calls: [], waitDelayMs: 0, ...over,
  };
  let n = 0;
  const chain: RobinhoodChain = {
    async balanceOf() { st.calls.push("balanceOf"); return st.balance; },
    async authorizationState(from, nonce) { st.calls.push("authorizationState"); return st.used.has(`${from}:${nonce}`.toLowerCase()); },
    async estimateGas() { st.calls.push("estimateGas"); return st.estimate; },
    async send(tx) { st.calls.push("send"); st.sends.push(tx); return `0x${(++n).toString(16).padStart(64, "0")}`; },
    async wait(hash) {
      st.calls.push("wait");
      if (st.waitDelayMs) await new Promise(r => setTimeout(r, st.waitDelayMs));
      return { status: st.receiptStatus, hash, gasUsed: 100_000n, effectiveGasPrice: 227_000_000n, blockNumber: 1 };
    },
  };
  return { chain, st };
}

function requirements(amount = "1000") {
  return {
    scheme: "exact", network: ROBINHOOD_NETWORK, asset: USDG.address, amount, payTo: PAY_TO,
    maxTimeoutSeconds: 300, extra: { name: USDG.name, version: USDG.version },
  };
}
async function signedPayload(over: Partial<Record<string, any>> = {}, domainOver: Partial<ethers.TypedDataDomain> = {}) {
  const auth = {
    from: payer.address, to: PAY_TO, value: "1000", validAfter: "0",
    validBefore: String(NOW + 600), nonce: ethers.hexlify(ethers.randomBytes(32)), ...over,
  };
  const signature = await payer.signTypedData(
    { ...usdgEip712Domain(), ...domainOver },
    TRANSFER_WITH_AUTHORIZATION_TYPES as any,
    { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) },
  );
  const req = requirements();
  return {
    x402Version: 2,
    resource: { url: "http://gw/api/v1/models", description: "", mimeType: "application/json" },
    accepted: req,
    payload: { signature, authorization: auth },
  } as any;
}

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (err: any) { console.log(`  FAIL  ${name}\n        ${err?.message || err}`); process.exitCode = 1; }
}

(async () => {
  console.log("robinhood-usdg rail tests");

  await test("disabled rail: verify + settle answer rail_not_enabled, chain never touched", async () => {
    const { chain, st } = stubChain();
    const rail = new RobinhoodUsdgRail({ privateKey: "", payTo: PAY_TO, chain, now, logger: quiet });
    assert.strictEqual(rail.enabled, false);
    assert.strictEqual(rail.facilitatorAddress, null);
    const p = await signedPayload();
    const v = await rail.verify(p, requirements());
    assert.strictEqual(v.isValid, false);
    assert.strictEqual(v.invalidReason, RAIL_NOT_ENABLED_REASON);
    assert.match(v.invalidMessage || "", /FACILITATOR_PRIVATE_KEY_ROBINHOOD/);
    const s = await rail.settle(p, requirements());
    assert.strictEqual(s.success, false);
    assert.strictEqual(s.errorReason, RAIL_NOT_ENABLED_REASON);
    assert.deepStrictEqual(st.calls, []);
    // still advertised, so discovery shape is stable
    const sup = await rail.getSupported();
    assert.deepStrictEqual(sup.kinds, [{ x402Version: 2, scheme: "exact", network: ROBINHOOD_NETWORK }]);
    assert.deepStrictEqual(sup.signers[ROBINHOOD_NETWORK], []);
  });

  await test("malformed key: treated as absent, never thrown", async () => {
    const rail = new RobinhoodUsdgRail({ privateKey: "0xnotakey", payTo: PAY_TO, chain: stubChain().chain, now, logger: quiet });
    assert.strictEqual(rail.enabled, false);
  });

  await test("enabled rail: valid EIP-3009 payload verifies, payer reported, signer advertised", async () => {
    const { chain } = stubChain();
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    assert.strictEqual(rail.enabled, true);
    assert.strictEqual(rail.facilitatorAddress, new ethers.Wallet(FACILITATOR_KEY).address);
    const v = await rail.verify(await signedPayload(), requirements());
    assert.strictEqual(v.isValid, true, JSON.stringify(v));
    assert.strictEqual(v.payer, payer.address);
    const sup = await rail.getSupported();
    assert.deepStrictEqual(sup.signers[ROBINHOOD_NETWORK], [rail.facilitatorAddress]);
  });

  await test("rejections: wrong network, wrong asset, permit2 payload, bad domain signature, wrong recipient, expired, not-yet-valid, value < amount, insufficient funds", async () => {
    const { chain, st } = stubChain();
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const reason = async (p: any, r: any = requirements()) => (await rail.verify(p, r)).invalidReason;

    assert.strictEqual(await reason(await signedPayload(), { ...requirements(), network: "eip155:8453" }), "network_mismatch");
    assert.strictEqual(await reason(await signedPayload(), { ...requirements(), asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }), "invalid_asset");
    const p2 = await signedPayload();
    p2.payload = { signature: p2.payload.signature, permit2Authorization: {} };
    assert.strictEqual(await reason(p2), "unsupported_asset_transfer_method");
    assert.strictEqual(await reason(await signedPayload({}, { version: "2" })), "invalid_exact_evm_payload_signature");
    assert.strictEqual(await reason(await signedPayload({ to: payer.address })), "invalid_exact_evm_payload_recipient_mismatch");
    assert.strictEqual(await reason(await signedPayload({ validBefore: String(NOW + 3) })), "invalid_exact_evm_payload_authorization_valid_before");
    assert.strictEqual(await reason(await signedPayload({ validAfter: String(NOW + 60) })), "invalid_exact_evm_payload_authorization_valid_after");
    assert.strictEqual(await reason(await signedPayload({ value: "999" })), "invalid_exact_evm_payload_authorization_value");
    st.balance = 500n;
    const v = await rail.verify(await signedPayload(), requirements());
    assert.strictEqual(v.invalidReason, "insufficient_funds");
    assert.match(v.invalidMessage || "", /Required: 1000/);
  });

  await test("verify: signature over a different value does not recover to payer", async () => {
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain: stubChain().chain, now, logger: quiet });
    const p = await signedPayload();
    p.payload.authorization.value = "2000"; // tamper after signing
    assert.strictEqual((await rail.verify(p, requirements())).invalidReason, "invalid_exact_evm_payload_signature");
  });

  await test("settle: gas = max(estimate × 1.5, floor); success records nonce; replay rejected by ledger", async () => {
    const { chain, st } = stubChain({ estimate: 105_467n });
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const p = await signedPayload();
    const s = await rail.settle(p, requirements());
    assert.strictEqual(s.success, true, JSON.stringify(s));
    assert.match(s.transaction, /^0x[0-9a-f]{64}$/);
    assert.strictEqual(s.network, ROBINHOOD_NETWORK);
    assert.strictEqual(st.sends.length, 1);
    assert.strictEqual(st.sends[0].gasLimit, (105_467n * 3n) / 2n);
    assert.strictEqual(st.sends[0].to, USDG.address);
    assert.strictEqual(st.sends[0].from, rail.facilitatorAddress);
    // calldata is transferWithAuthorization(v,r,s)
    assert.strictEqual(st.sends[0].data.slice(0, 10), new ethers.Interface([
      "function transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
    ]).getFunction("transferWithAuthorization")!.selector);
    // replay: same header again → verify rejects, settle rejects, nothing sent
    const v = await rail.verify(p, requirements());
    assert.strictEqual(v.invalidReason, "authorization_nonce_reused");
    const s2 = await rail.settle(p, requirements());
    assert.strictEqual(s2.success, false);
    assert.strictEqual(s2.errorReason, "authorization_nonce_reused");
    assert.strictEqual(st.sends.length, 1);
    assert.strictEqual(rail.describe().stats.settled, 1);
  });

  await test("settle: floor applies when the live estimate is small", async () => {
    const { chain, st } = stubChain({ estimate: 50_000n });
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const s = await rail.settle(await signedPayload(), requirements());
    assert.strictEqual(s.success, true);
    assert.strictEqual(st.sends[0].gasLimit, SETTLE_GAS_FLOOR);
  });

  await test("verify: nonce already consumed on chain is rejected before any send", async () => {
    const { chain, st } = stubChain();
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const p = await signedPayload();
    st.used.add(`${p.payload.authorization.from}:${p.payload.authorization.nonce}`.toLowerCase());
    assert.strictEqual((await rail.verify(p, requirements())).invalidReason, "authorization_already_used");
    const s = await rail.settle(p, requirements());
    assert.strictEqual(s.success, false);
    assert.strictEqual(st.sends.length, 0);
  });

  await test("settle: reverted receipt → invalid_transaction_state, nonce released (retry allowed)", async () => {
    const { chain, st } = stubChain({ receiptStatus: 0 });
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const p = await signedPayload();
    const s = await rail.settle(p, requirements());
    assert.strictEqual(s.success, false);
    assert.strictEqual(s.errorReason, "invalid_transaction_state");
    assert.match(s.transaction, /^0x/);
    assert.strictEqual((await rail.verify(p, requirements())).isValid, true);
    assert.strictEqual(rail.ledger.size, 0);
  });

  await test("settle: RPC error → transaction_failed with message, nonce released", async () => {
    const { chain, st } = stubChain();
    chain.send = async () => { st.calls.push("send"); throw new Error("insufficient funds for gas"); };
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const s = await rail.settle(await signedPayload(), requirements());
    assert.strictEqual(s.success, false);
    assert.strictEqual(s.errorReason, "transaction_failed");
    assert.match(s.errorMessage || "", /insufficient funds/);
    assert.strictEqual(rail.ledger.size, 0);
  });

  await test("settle: concurrent payments are sent one at a time (facilitator nonce safety)", async () => {
    const { chain, st } = stubChain({ waitDelayMs: 30 });
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const [a, b] = await Promise.all([signedPayload(), signedPayload()]);
    const [sa, sb] = await Promise.all([rail.settle(a, requirements()), rail.settle(b, requirements())]);
    assert.strictEqual(sa.success && sb.success, true);
    const seq = st.calls.filter(c => c === "send" || c === "wait");
    assert.deepStrictEqual(seq, ["send", "wait", "send", "wait"]);
  });

  await test("settle: verify-fail at settle time never sends (handler-failure/expiry safety)", async () => {
    const { chain, st } = stubChain();
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain, now, logger: quiet });
    const p = await signedPayload({ validBefore: String(NOW + 10) });
    assert.strictEqual((await rail.verify(p, requirements())).isValid, true);
    NOW += 30; // authorization expired between verify and settle
    const s = await rail.settle(p, requirements());
    NOW -= 30;
    assert.strictEqual(s.success, false);
    assert.strictEqual(s.errorReason, "invalid_exact_evm_payload_authorization_valid_before");
    assert.strictEqual(st.sends.length, 0);
  });

  await test("money parser: $0.001 → 1000 raw USDG with the verified EIP-712 domain; other networks → null", async () => {
    const r = await robinhoodUsdgMoneyParser(0.001, ROBINHOOD_NETWORK);
    assert.deepStrictEqual(r, { amount: "1000", asset: USDG.address, extra: { name: "Global Dollar", version: "1" } });
    assert.strictEqual((await robinhoodUsdgMoneyParser(0.5, ROBINHOOD_NETWORK))!.amount, "500000");
    assert.strictEqual(usdToUsdgUnits(0.10), "100000");
    assert.strictEqual(usdToUsdgUnits(0.02), "20000");
    assert.strictEqual(await robinhoodUsdgMoneyParser(0.001, "eip155:8453" as any), null);
  });

  await test("MPP adapter: challenge nonce, precheck, and x402 mapping", async () => {
    const rail = new RobinhoodUsdgRail({ privateKey: FACILITATOR_KEY, payTo: PAY_TO, chain: stubChain().chain, now, logger: quiet });
    const id = "aB3cDeF4gHiJkLmN", realm = "gateway.spraay.app";
    const nonce = mppChallengeNonce(id, realm);
    assert.strictEqual(nonce, ethers.keccak256(ethers.toUtf8Bytes(id + realm)));
    const request = { amount: "1000", currency: USDG.address, recipient: PAY_TO, chainId: 4663 };
    const cred = { type: "authorization" as const, from: payer.address, to: PAY_TO, value: "1000", validAfter: "0", validBefore: String(NOW + 600), nonce, signature: "0x" };
    assert.strictEqual(mppPrecheck(request, cred, id, realm), null);
    assert.match(mppPrecheck(request, { ...cred, nonce: ethers.ZeroHash }, id, realm) || "", /nonce/);
    assert.match(mppPrecheck({ ...request, chainId: 8453 }, cred, id, realm) || "", /chainId/);
    assert.match(mppPrecheck(request, { ...cred, value: "999" }, id, realm) || "", /must equal/);
    assert.match(mppPrecheck(request, { ...cred, type: "hash" as any }, id, realm) || "", /credential type/);
    const { payload, requirements: req } = mppToX402(rail, request, cred, "http://gw/x");
    assert.strictEqual(req.network, ROBINHOOD_NETWORK);
    assert.strictEqual(req.amount, "1000");
    assert.deepStrictEqual((payload.payload as any).authorization.nonce, nonce);
    // and the engine settles an MPP-derived payload exactly like an x402 one
    const signed = await payer.signTypedData(usdgEip712Domain(), TRANSFER_WITH_AUTHORIZATION_TYPES as any,
      { from: payer.address, to: PAY_TO, value: 1000n, validAfter: 0n, validBefore: BigInt(NOW + 600), nonce });
    const mapped = mppToX402(rail, request, { ...cred, signature: signed }, "http://gw/x");
    const s = await rail.settle(mapped.payload, mapped.requirements);
    assert.strictEqual(s.success, true, JSON.stringify(s));
  });

  console.log(`\n${passed} passed${process.exitCode ? " (with failures)" : ""}`);
})();
