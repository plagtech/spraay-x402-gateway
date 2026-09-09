#!/usr/bin/env node
// ============================================================
// robinhood-usdg-e2e.mjs — agent-style x402 client for the USDG rail
// ============================================================
//
// Pays a Spraay paid endpoint in USDG on Robinhood Chain (eip155:4663) the
// way any x402 v2 client does: read the 402, pick the eip155:4663 accepts[]
// entry, sign an EIP-3009 TransferWithAuthorization, resend with
// PAYMENT-SIGNATURE. The gateway's in-process facilitator relays the
// transfer (payer → Spraay revenue wallet) AFTER the handler succeeds.
//
//   node scripts/robinhood-usdg-e2e.mjs [--gateway URL] [--endpoint PATH]
//        [--method GET|POST] [--body JSON] [--dry-run] [--bad-sig] [--value N]
//
//   --dry-run   fetch the 402, sign, print the payload — do NOT send the paid request
//   --bad-sig   corrupt the signature (expects a 402 rejection, nothing settles)
//   --value N   override authorization.value (raw units) e.g. to prove under-payment is rejected
//
// Keys: TEST_PAYER_PRIVATE_KEY from .env (the payer — NOT the facilitator,
// NOT the deployer). Never printed. Every real run moves USDG on mainnet:
// run it only with LP's per-transaction approval.
// ============================================================
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const GATEWAY = opt("--gateway", process.env.GATEWAY_URL || "http://127.0.0.1:3402");
const ENDPOINT = opt("--endpoint", "/api/v1/models");
const METHOD = opt("--method", "GET").toUpperCase();
const BODY = opt("--body", null);
const NETWORK = "eip155:4663";
const RPC = process.env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split(/\r?\n/).filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
if (!env.TEST_PAYER_PRIVATE_KEY) { console.error("TEST_PAYER_PRIVATE_KEY missing in .env"); process.exit(2); }
const payer = new ethers.Wallet(env.TEST_PAYER_PRIVATE_KEY);
const provider = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const erc20 = new ethers.Contract("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", ["function balanceOf(address) view returns (uint256)"], provider);

const hdrs = { "Content-Type": "application/json", Accept: "application/json" };
const send = (extra = {}) => fetch(GATEWAY + ENDPOINT, { method: METHOD, headers: { ...hdrs, ...extra }, body: BODY ?? undefined });

console.log(`payer ${payer.address} → ${METHOD} ${GATEWAY}${ENDPOINT}`);

// 1) unpaid → 402 challenge
const r1 = await send();
const challenge = await r1.json().catch(() => ({}));
console.log(`\n[1] unpaid: HTTP ${r1.status}, x402Version=${challenge.x402Version}, accepts=${(challenge.accepts || []).length}`);
if (r1.status !== 402) { console.log(JSON.stringify(challenge).slice(0, 400)); process.exit(1); }
const accepted = (challenge.accepts || []).find(a => a.network === NETWORK);
if (!accepted) { console.error(`no ${NETWORK} entry in accepts[]:`, (challenge.accepts || []).map(a => a.network)); process.exit(1); }
console.log(`    ${NETWORK} entry: amount=${accepted.amount} asset=${accepted.asset} payTo=${accepted.payTo} extra=${JSON.stringify(accepted.extra)}`);

// 2) sign EIP-3009 TransferWithAuthorization against the token's EIP-712 domain
const value = opt("--value", accepted.amount);
const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: payer.address, to: accepted.payTo, value: String(value), validAfter: "0",
  validBefore: String(now + Math.min(accepted.maxTimeoutSeconds || 300, 600)),
  nonce: ethers.hexlify(ethers.randomBytes(32)),
};
const domain = { name: accepted.extra.name, version: accepted.extra.version, chainId: 4663, verifyingContract: accepted.asset };
const types = { TransferWithAuthorization: [
  { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" } ] };
let signature = await payer.signTypedData(domain, types, { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) });
if (flag("--bad-sig")) signature = signature.slice(0, -4) + (signature.endsWith("00") ? "11" : "00") + signature.slice(-2);

// The v2 header: echo the chosen accepts[] entry (schema fields only) + payload.
const { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra } = accepted;
const paymentPayload = {
  x402Version: 2,
  resource: challenge.resource,
  accepted: { scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra },
  payload: { signature, authorization },
};
const header = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
console.log(`\n[2] signed: nonce=${authorization.nonce} value=${authorization.value} validBefore=${authorization.validBefore}${flag("--bad-sig") ? " (SIGNATURE CORRUPTED)" : ""}`);

const [ethBefore, usdgBefore, payToBefore] = await Promise.all([provider.getBalance(payer.address), erc20.balanceOf(payer.address), erc20.balanceOf(accepted.payTo)]);
console.log(`    payer: ${ethers.formatEther(ethBefore)} ETH, ${ethers.formatUnits(usdgBefore, 6)} USDG | payTo ${accepted.payTo}: ${ethers.formatUnits(payToBefore, 6)} USDG`);

if (flag("--dry-run")) { console.log("\n[dry-run] not sending the paid request. PAYMENT-SIGNATURE would be:\n" + header.slice(0, 120) + "…"); process.exit(0); }

// 3) paid request
const t0 = Date.now();
const r2 = await send({ "PAYMENT-SIGNATURE": header });
const text = await r2.text();
let body; try { body = JSON.parse(text); } catch { body = text; }
console.log(`\n[3] paid: HTTP ${r2.status} in ${Date.now() - t0} ms`);
const pr = r2.headers.get("payment-response");
if (pr) {
  const settle = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
  console.log(`    PAYMENT-RESPONSE: ${JSON.stringify(settle)}`);
  if (settle.transaction) {
    const rcpt = await provider.getTransactionReceipt(settle.transaction);
    console.log(`    receipt: status=${rcpt?.status} block=${rcpt?.blockNumber} gasUsed=${rcpt?.gasUsed} gasPrice=${rcpt?.gasPrice} from=${rcpt?.from}`);
    if (rcpt) console.log(`    facilitator gas spend: ${ethers.formatEther(rcpt.gasUsed * rcpt.gasPrice)} ETH`);
    console.log(`    explorer: https://robinhoodchain.blockscout.com/tx/${settle.transaction}`);
  }
} else {
  console.log(`    (no PAYMENT-RESPONSE header) error=${JSON.stringify(body?.error ?? body?._spraay?.payment_error ?? null)}`);
}
console.log(`    body: ${typeof body === "string" ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
const [usdgAfter, payToAfter] = await Promise.all([erc20.balanceOf(payer.address), erc20.balanceOf(accepted.payTo)]);
console.log(`    payer USDG ${ethers.formatUnits(usdgBefore, 6)} → ${ethers.formatUnits(usdgAfter, 6)} | payTo USDG ${ethers.formatUnits(payToBefore, 6)} → ${ethers.formatUnits(payToAfter, 6)}`);
process.exit(r2.status < 300 ? 0 : 1);
