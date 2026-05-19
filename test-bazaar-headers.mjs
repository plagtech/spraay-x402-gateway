import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.PING_WALLET_KEY);
const client = new x402Client();
registerExactEvmScheme(client, { signer });
const f = wrapFetchWithPayment(fetch, client);

console.log("Making paid request to /api/v1/prices...\n");
const res = await f("https://gateway.spraay.app/api/v1/prices");

console.log("Status:", res.status);
console.log("\nAll headers:");
for (const [k, v] of res.headers.entries()) {
  console.log(`  ${k}: ${v}`);
}