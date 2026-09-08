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
console.log(selOk ? "ABI PREFLIGHT: PASSED" : "ABI PREFLIGHT: FAILED");
process.exit(selOk ? 0 : 1);
