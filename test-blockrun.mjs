/**
 * test-blockrun.mjs
 * 
 * Tests the Spraay gateway's BlockRun integration with a real x402 payment.
 * 
 * Setup:
 *   npm install @x402/fetch
 * 
 * Usage:
 *   $env:TEST_WALLET_KEY="0xYourPrivateKey"
 *   node test-blockrun.mjs
 */

import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const GATEWAY_URL = "https://gateway.spraay.app";
const PRIVATE_KEY = process.env.TEST_WALLET_KEY;

if (!PRIVATE_KEY) {
  console.error("❌ Set TEST_WALLET_KEY env var first:");
  console.error('   $env:TEST_WALLET_KEY="0xYourPrivateKey"');
  process.exit(1);
}

console.log("🔧 Setting up x402 v2 payment client...\n");

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`   Wallet: ${account.address}`);

const fetchWithPay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "eip155:8453",   // Base mainnet
      client: new ExactEvmScheme(account),
    },
  ],
});

console.log("   Using: @x402/fetch v2 + @x402/evm v2");
console.log("   Network: Base (eip155:8453)\n");

// ── Test 1: BlockRun Smart Routing ─────────────────────────────────
console.log("━".repeat(60));
console.log("TEST 1: BlockRun Smart Routing (blockrun/auto)");
console.log("━".repeat(60));

try {
  const res = await fetchWithPay(`${GATEWAY_URL}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "blockrun/auto",
      messages: [{ role: "user", content: "What is x402 in one sentence?" }],
      provider: "blockrun",
    }),
  });

  const data = await res.json();
  console.log(`\n   Status: ${res.status}`);
  if (res.status !== 200) {
    console.log(`   Body: ${JSON.stringify(data)}`);
    console.log("\n   ❌ BlockRun smart routing returned non-200\n");
  } else {
    console.log(`   Provider: ${data._gateway?.powered_by}`);
    console.log(`   Payment: ${data._gateway?.payment}`);
    if (data._gateway?.routing) {
      console.log(`   Routed to: ${data._gateway.routing.routed_model}`);
      console.log(`   Tier: ${data._gateway.routing.tier}`);
      console.log(`   Savings: ${data._gateway.routing.savings}`);
    }
    const content = data.choices?.[0]?.message?.content;
    console.log(`\n   Response: ${content ? content.slice(0, 200) : "No content"}`);
    console.log("\n   ✅ BlockRun smart routing PASSED\n");
  }
} catch (err) {
  console.error(`\n   ❌ FAILED: ${err.message}\n`);
}

// ── Test 2: BlockRun Direct Model ──────────────────────────────────
console.log("━".repeat(60));
console.log("TEST 2: BlockRun Direct Model (deepseek/deepseek-chat)");
console.log("━".repeat(60));

try {
  const res = await fetchWithPay(`${GATEWAY_URL}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-chat",
      messages: [{ role: "user", content: "Say hello in 5 words" }],
      provider: "blockrun",
    }),
  });

  const data = await res.json();
  console.log(`\n   Status: ${res.status}`);
  if (res.status !== 200) {
    console.log(`   Body: ${JSON.stringify(data)}`);
    console.log("\n   ❌ BlockRun direct model returned non-200\n");
  } else {
    console.log(`   Provider: ${data._gateway?.powered_by}`);
    const content = data.choices?.[0]?.message?.content;
    console.log(`   Response: ${content || "No content"}`);
    console.log("\n   ✅ BlockRun direct model PASSED\n");
  }
} catch (err) {
  console.error(`\n   ❌ FAILED: ${err.message}\n`);
}

// ── Test 3: OpenRouter Default ─────────────────────────────────────
console.log("━".repeat(60));
console.log("TEST 3: OpenRouter Default (no provider field)");
console.log("━".repeat(60));

try {
  const res = await fetchWithPay(`${GATEWAY_URL}/api/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Say hello in 5 words" }],
    }),
  });

  const data = await res.json();
  console.log(`\n   Status: ${res.status}`);
  if (res.status !== 200) {
    console.log(`   Body: ${JSON.stringify(data)}`);
    console.log("\n   ❌ OpenRouter returned non-200\n");
  } else {
    console.log(`   Provider: ${data._gateway?.powered_by}`);
    const content = data.choices?.[0]?.message?.content;
    console.log(`   Response: ${content || "No content"}`);
    console.log("\n   ✅ OpenRouter default PASSED\n");
  }
} catch (err) {
  console.error(`\n   ❌ FAILED: ${err.message}\n`);
}

// ── Test 4: Models Endpoint ────────────────────────────────────────
console.log("━".repeat(60));
console.log("TEST 4: Models endpoint (both providers)");
console.log("━".repeat(60));

try {
  const res = await fetchWithPay(`${GATEWAY_URL}/api/v1/models`, {
    method: "GET",
  });

  const data = await res.json();
  console.log(`\n   Status: ${res.status}`);
  if (res.status !== 200) {
    console.log(`   Body: ${JSON.stringify(data)}`);
    console.log("\n   ❌ Models endpoint returned non-200\n");
  } else {
    const blockrunCount = data.models?.filter((m) => m.provider === "blockrun").length || 0;
    const openrouterCount = data.models?.filter((m) => m.provider === "openrouter").length || 0;

    console.log(`   Total models: ${data.total}`);
    console.log(`   BlockRun models: ${blockrunCount}`);
    console.log(`   OpenRouter models: ${openrouterCount}`);
    console.log(`   BlockRun status: ${data.providers?.blockrun?.status}`);
    console.log(`   OpenRouter status: ${data.providers?.openrouter?.status}`);
    console.log("\n   ✅ Models endpoint PASSED\n");
  }
} catch (err) {
  console.error(`\n   ❌ FAILED: ${err.message}\n`);
}

console.log("━".repeat(60));
console.log("🏁 All tests complete!");
console.log("━".repeat(60));
