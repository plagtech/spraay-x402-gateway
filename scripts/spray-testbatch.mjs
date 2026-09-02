// scripts/spray-testbatch.mjs — send a tiny sprayETH batch through a freshly
// deployed SprayContract and assert recipients + fee landed. Testnet only.
//   node scripts/spray-testbatch.mjs --network testnet
import { readFileSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import { createRequire } from "node:module";
createRequire(import.meta.url)("dotenv").config();

const args = process.argv.slice(2);
const networkName = args[args.indexOf("--network") + 1];
if (networkName !== "testnet") { console.error("testnet only"); process.exit(1); }
const rec = JSON.parse(readFileSync(`scripts/spray-deploy-testnet-46630.json`, "utf8"));
const rpc = process.env.ROBINHOOD_TESTNET_RPC_URL || "https://rpc.testnet.chain.robinhood.com";
const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
if (wallet.address.toLowerCase() !== rec.deployer.toLowerCase()) { console.error("wrong deployer"); process.exit(1); }

const abi = [
  "function sprayETH((address recipient,uint256 amount)[] recipients) payable",
  "function calculateTotalCost(uint256) view returns (uint256)",
  "function calculateFee(uint256) view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function feeBps() view returns (uint256)",
  "event SprayETHExecuted(address indexed sender, uint256 totalAmount, uint256 recipientCount, uint256 feeAmount, uint256 timestamp)",
];
const c = new ethers.Contract(rec.address, abi, wallet);

// two deterministic throwaway recipients (no keys kept)
const r1 = ethers.Wallet.createRandom().address, r2 = ethers.Wallet.createRandom().address;
const a1 = ethers.parseEther("0.0001"), a2 = ethers.parseEther("0.0002");
const total = a1 + a2;
const fee = await c.calculateFee(total);
const cost = await c.calculateTotalCost(total);
console.log(`contract ${rec.address}  feeBps ${await c.feeBps()}  feeRecipient ${await c.feeRecipient()}`);
console.log(`total ${ethers.formatEther(total)}  fee ${ethers.formatEther(fee)}  cost ${ethers.formatEther(cost)}`);
if (fee !== total * 30n / 10000n) throw new Error("fee != 0.30%");

const feeRecipient = await c.feeRecipient();
const before = await provider.getBalance(wallet.address);
// overpay slightly to exercise the refund path
const tx = await c.sprayETH([{ recipient: r1, amount: a1 }, { recipient: r2, amount: a2 }], { value: cost + ethers.parseEther("0.00001") });
console.log("tx", tx.hash);
const rcpt = await tx.wait();
console.log(`status ${rcpt.status} gasUsed ${rcpt.gasUsed} block ${rcpt.blockNumber}`);

const [b1, b2, after] = await Promise.all([provider.getBalance(r1), provider.getBalance(r2), provider.getBalance(wallet.address)]);
const ev = rcpt.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "SprayETHExecuted");
console.log("event", ev ? { totalAmount: ev.args.totalAmount.toString(), fee: ev.args.feeAmount.toString(), n: ev.args.recipientCount.toString() } : "MISSING");
const gasCost = rcpt.gasUsed * rcpt.gasPrice;
// sender == feeRecipient, so net spend = total + gas (fee returns to self, excess refunded)
const spent = before - after;
const ok = b1 === a1 && b2 === a2 && ev && ev.args.feeAmount === fee && spent === total + gasCost;
console.log({ r1: ethers.formatEther(b1), r2: ethers.formatEther(b2), spent: ethers.formatEther(spent), expected: ethers.formatEther(total + gasCost), feeRecipientIsSender: feeRecipient === wallet.address });
console.log(ok ? "\n✅ TEST BATCH PASSED" : "\n✗ TEST BATCH FAILED");
writeFileSync("scripts/spray-testbatch-testnet-46630.json", JSON.stringify({ contract: rec.address, tx: tx.hash, block: rcpt.blockNumber, recipients: [{ r1, amount: a1.toString() }, { r2, amount: a2.toString() }], fee: fee.toString(), passed: ok, at: new Date().toISOString() }, null, 2));
process.exit(ok ? 0 : 1);
