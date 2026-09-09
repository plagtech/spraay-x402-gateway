// spray-abi-preflight — the permanent selector-vs-bytecode + gas gate.
// (Successor to the lost spray_abi_preflight.py; referenced by task prompts.)
// Run before any change to batch/payroll/sctp calldata encoding:
//   node scripts/spray-abi-preflight.mjs
// Checks: (A) every encoded selector exists in the deployed Base bytecode
//             (exit 1 if any is missing),
//         (B) gas formulas vs live eth_estimateGas at n = 1, 2, 10,
//         (C) deployer funding/allowance state (needs DEPLOYER_PRIVATE_KEY in .env).
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const SPRAAY = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const env = Object.fromEntries(
  readFileSync(".env", "utf8").split(/\r?\n/).filter(l => l.includes("=") && !l.startsWith("#"))
    .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const ABI = [
  "function sprayETH((address recipient, uint256 amount)[] recipients) payable",
  "function sprayToken(address token, (address recipient, uint256 amount)[] recipients)",
  "function sprayEqual(address token, address[] recipients, uint256 amountPerRecipient) payable",
];
const iface = new ethers.Interface(ABI);
const provider = new ethers.JsonRpcProvider(RPC);

const code = await provider.getCode(SPRAAY);
console.log(`bytecode: ${code.length / 2 - 1} bytes at ${SPRAAY}`);
let selOk = true;
for (const f of ["sprayETH", "sprayToken", "sprayEqual"]) {
  const sel = iface.getFunction(f).selector;
  const found = code.toLowerCase().includes(sel.slice(2).toLowerCase());
  if (!found) selOk = false;
  console.log(`selector ${sel} (${f}): ${found ? "FOUND in bytecode" : "*** MISSING ***"}`);
}

const wallet = new ethers.Wallet(env.DEPLOYER_PRIVATE_KEY, provider);
const erc20 = new ethers.Contract(USDC, [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
], provider);
const [ethBal, usdcBal, allowance] = await Promise.all([
  provider.getBalance(wallet.address),
  erc20.balanceOf(wallet.address),
  erc20.allowance(wallet.address, SPRAAY),
]);
console.log(`deployer ${wallet.address}: ${ethers.formatEther(ethBal)} ETH, ${ethers.formatUnits(usdcBal, 6)} USDC, allowance->Spraay ${ethers.formatUnits(allowance, 6)} USDC`);

// Live estimates: sprayToken(USDC) to fresh cold recipients, n = 1, 2, 10 (amount 1000 raw each = 0.001 USDC)
for (const n of [1, 2, 10]) {
  const recips = Array.from({ length: n }, () => ({ recipient: ethers.Wallet.createRandom().address, amount: 1000n }));
  const data = iface.encodeFunctionData("sprayToken", [USDC, recips]);
  const oldFormula = 50000 + 65000 * n;
  const floor = 180000 + 50000 * (n - 1);
  try {
    const est = await provider.estimateGas({ from: wallet.address, to: SPRAAY, data });
    const chosen = Math.max(Math.ceil(Number(est) * 1.5), floor);
    console.log(`sprayToken n=${n}: live=${est} | old formula=${oldFormula} (${Number(est) > oldFormula ? "UNDERFUNDED" : "ok"}) | floor=${floor} | est*1.5 clamped=${chosen}`);
  } catch (e) {
    console.log(`sprayToken n=${n}: estimateGas FAILED (${e.shortMessage || e.message}) | old=${oldFormula} | floor=${floor}`);
  }
}
// sprayETH estimates
for (const n of [1, 2, 10]) {
  const recips = Array.from({ length: n }, () => ({ recipient: ethers.Wallet.createRandom().address, amount: 1000000000000n }));
  const total = 1000000000000n * BigInt(n);
  const fee = (total * 30n) / 10000n;
  const data = iface.encodeFunctionData("sprayETH", [recips]);
  const oldFormula = 50000 + 30000 * n;
  try {
    const est = await provider.estimateGas({ from: wallet.address, to: SPRAAY, data, value: total + fee });
    console.log(`sprayETH  n=${n}: live=${est} | old formula=${oldFormula} (${Number(est) > oldFormula ? "UNDERFUNDED" : "ok"})`);
  } catch (e) {
    console.log(`sprayETH  n=${n}: estimateGas FAILED (${e.shortMessage || e.message})`);
  }
}
// ── (D) Robinhood Chain (4663) USDG rail preflight ─────────────────────────
// The rail (src/rails/robinhoodUsdg.ts) settles USDG via EIP-3009. Assert the
// addresses it depends on still resolve to deployed code and that the token's
// EIP-712 domain still matches the constants the verifier signs against.
// Permit2 is NOT used by the rail but is verified here too (task guard 3).
const RH_RPC = env.ROBINHOOD_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const RH_USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const RH_PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
let rhOk = true;
try {
  const rh = new ethers.JsonRpcProvider(RH_RPC, 4663, { staticNetwork: true });
  const usdgCode = await rh.getCode(RH_USDG);
  const permit2Code = await rh.getCode(RH_PERMIT2);
  console.log(`robinhood USDG    ${RH_USDG}: ${usdgCode === "0x" ? "*** NO CODE ***" : `code ${usdgCode.length / 2 - 1} bytes`}`);
  console.log(`robinhood Permit2 ${RH_PERMIT2}: ${permit2Code === "0x" ? "*** NO CODE ***" : `code ${permit2Code.length / 2 - 1} bytes`}`);
  if (usdgCode === "0x" || permit2Code === "0x") rhOk = false;

  const usdg = new ethers.Contract(RH_USDG, [
    "function name() view returns (string)", "function symbol() view returns (string)",
    "function decimals() view returns (uint8)", "function DOMAIN_SEPARATOR() view returns (bytes32)",
    "function balanceOf(address) view returns (uint256)",
  ], rh);
  const [name, symbol, decimals, ds] = await Promise.all([usdg.name(), usdg.symbol(), usdg.decimals(), usdg.DOMAIN_SEPARATOR()]);
  const expectedDs = ethers.TypedDataEncoder.hashDomain({ name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: RH_USDG });
  const domainOk = ds.toLowerCase() === expectedDs.toLowerCase();
  console.log(`robinhood USDG identity: ${name} (${symbol}) decimals=${decimals} | EIP-712 domain {Global Dollar, 1, 4663} ${domainOk ? "MATCHES" : "*** MISMATCH ***"}`);
  if (symbol !== "USDG" || Number(decimals) !== 6 || !domainOk) rhOk = false;

  // Selectors the rail encodes must exist in the token implementation. USDG is an
  // EIP-1967 proxy; probe the live dispatch with eth_call instead of a bytecode grep.
  const iface = new ethers.Interface([
    "function authorizationState(address,bytes32) view returns (bool)",
  ]);
  try {
    await rh.call({ to: RH_USDG, data: iface.encodeFunctionData("authorizationState", [ethers.ZeroAddress, ethers.ZeroHash]) });
    console.log("robinhood USDG authorizationState(): dispatches (EIP-3009 surface present)");
  } catch (e) {
    console.log(`robinhood USDG authorizationState(): *** FAILED *** (${e.shortMessage || e.message})`);
    rhOk = false;
  }

  if (env.FACILITATOR_PRIVATE_KEY_ROBINHOOD) {
    const fac = new ethers.Wallet(env.FACILITATOR_PRIVATE_KEY_ROBINHOOD);
    const [ethBal, fee] = await Promise.all([rh.getBalance(fac.address), rh.getFeeData()]);
    const perSettle = 150000n * (fee.gasPrice ?? 0n);
    console.log(`robinhood facilitator ${fac.address}: ${ethers.formatEther(ethBal)} ETH (~${perSettle > 0n ? ethBal / perSettle : "?"} settlements at 150k gas × ${fee.gasPrice} wei)`);
  } else {
    console.log("robinhood facilitator: FACILITATOR_PRIVATE_KEY_ROBINHOOD not set (rail advertised but disabled)");
  }
} catch (e) {
  console.log(`robinhood preflight FAILED: ${e.shortMessage || e.message}`);
  rhOk = false;
}

const allOk = selOk && rhOk;
console.log(allOk ? "ABI PREFLIGHT: PASSED" : `ABI PREFLIGHT: FAILED${selOk ? "" : " (Base selectors)"}${rhOk ? "" : " (Robinhood USDG)"}`);
process.exit(allOk ? 0 : 1);
