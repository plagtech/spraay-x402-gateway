import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const key = process.env.EVM_PRIVATE_KEY;
if (!key) { console.error("Set EVM_PRIVATE_KEY first"); process.exit(1); }

const account = privateKeyToAccount(key);
const client = new x402Client();
registerExactEvmScheme(client, { signer: account });

const fetchWith402 = wrapFetchWithPayment(fetch, client);
const res = await fetchWith402("https://gateway.spraay.app/api/v1/oracle/gas", {
  headers: { Accept: "application/json" },
});
console.log("Status:", res.status);
console.log("Body:", await res.json());
