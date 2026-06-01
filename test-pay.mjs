import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.TEST_PRIVATE_KEY);
const fetchWithPay = wrapFetchWithPayment(fetch, account);

const res = await fetchWithPay("https://gateway.spraay.app/api/v1/batch/estimate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ recipientCount: 5 }),
});

console.log("STATUS:", res.status);
console.log("BODY:", await res.text());
console.log("PAYMENT-RESPONSE:", res.headers.get("x-payment-response"));
