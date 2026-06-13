#!/usr/bin/env node
/**
 * gen-discovery.mjs — Spraay llms.txt / llms-full.txt generator
 *
 * SOURCE OF TRUTH: /.well-known/x402.json (NOT the / root manifest).
 * x402.json carries clean `category` + rich `description` + `searchTerms`
 * for every resource, and it includes endpoints the root manifest is
 * currently missing (trust/score, token/safety, address/safety, tx/decode,
 * compute/models, compute/estimate). Generating from it keeps llms.txt in
 * lockstep with what agents actually pay for.
 *
 * Emits into ./public:
 *   - llms.txt        concise, llmstxt.org-spec index (your framing + live counts)
 *   - llms-full.txt   every endpoint, grouped by category, with price + searchTerms
 *
 * Does NOT generate openapi.json — the gateway already serves a richer one.
 *
 * Run:   node scripts/gen-discovery.mjs
 * Build: add to package.json -> "prebuild": "node scripts/gen-discovery.mjs"
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const GATEWAY_URL = process.env.SPRAAY_GATEWAY_URL || "https://gateway.spraay.app";
const OUT_DIR = process.env.DISCOVERY_OUT_DIR || "public";

// Pretty labels for x402.json category slugs.
const CAT_LABEL = {
  ai: "AI Chat & Models",
  payments: "Batch Payments",
  defi: "DeFi & Swaps",
  oracle: "Price & Gas Oracle",
  bridge: "Cross-Chain Bridge",
  payroll: "Payroll",
  invoice: "Invoicing",
  analytics: "On-Chain Analytics",
  escrow: "Escrow",
  inference: "AI Inference (Intelligence)",
  communication: "Communication (Email/SMS/XMTP)",
  infrastructure: "Infrastructure (RPC/Storage/Webhooks)",
  identity: "Identity & Auth",
  compliance: "KYC & Compliance",
  gpu: "GPU / Compute",
  search: "Search & RAG",
  compute: "Compute (Inference Jobs)",
  "compute-futures": "Compute Futures (Prepaid)",
  rtp: "Robot Task Protocol (RTP)",
  "agent-wallet": "Agent Wallets",
  "supply-chain": "Supply Chain (SCTP)",
  bittensor: "Bittensor (SN64)",
  research: "Research & Reference",
  trust: "Trust & Safety",
  data: "Data",
  "free-tier": "Free Tier (No Wallet)",
  discovery: "Discovery",
};

const label = (slug) =>
  CAT_LABEL[slug] ||
  String(slug).replace(/(^|-)([a-z])/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());

async function main() {
  const res = await fetch(`${GATEWAY_URL}/.well-known/x402.json`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`x402.json fetch failed: ${res.status} ${res.statusText}`);
  const disc = await res.json();

  const resources = disc.resources || [];
  const payTo = disc.payTo || process.env.PAY_TO_ADDRESS || "";
  const network = disc.network || "eip155:8453";
  const facilitator = disc.facilitator || "Coinbase CDP";

  const rows = resources.map((r) => {
    let path = r.resource;
    try {
      path = new URL(r.resource).pathname;
    } catch {}
    return {
      url: r.resource,
      path,
      method: (r.method || "GET").toUpperCase(),
      price: r.price || "free",
      free: !r.price || r.price === "free",
      category: r.category || "other",
      description: r.description || "",
      searchTerms: Array.isArray(r.searchTerms) ? r.searchTerms : [],
    };
  });

  const paidCount = rows.filter((r) => !r.free).length;
  const freeCount = rows.filter((r) => r.free).length;
  const total = rows.length;

  const byCat = {};
  for (const r of rows) (byCat[r.category] ||= []).push(r);
  const catSlugs = Object.keys(byCat).sort((a, b) => label(a).localeCompare(label(b)));

  mkdirSync(OUT_DIR, { recursive: true });

  // ---- llms.txt (concise; your framing, live counts/categories) ---------
  const llms = `# Spraay x402 Gateway
Pay-per-use infrastructure for autonomous AI agents. Powered by the x402 protocol on Base.

## What this is
Spraay provides ${paidCount} paid API endpoints (${total} total) that agents call with USDC micropayments via HTTP 402. No API keys, no signups — agents pay per-call with on-chain USDC.

## Payment details
- Protocol: x402 (https://x402.org)
- Network: Base mainnet (EVM, ${network})
- Asset: USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
- Pay to: ${payTo}
- Facilitator: ${String(facilitator).includes("coinbase") ? "Coinbase CDP" : facilitator}
- Solana rail: USDC payments also accepted on Solana — see ${GATEWAY_URL}/.well-known/solana.json

## Getting started
1. Fund an agent wallet with USDC on Base
2. Send a request to any endpoint
3. Receive 402 Payment Required with x402 payment terms
4. Retry with the x402 payment header
5. Receive 200 with your data

## Categories
${catSlugs.map((c) => `- ${label(c)} (${byCat[c].length})`).join("\n")}

## Full catalog
Every endpoint, price, and search terms: ${GATEWAY_URL}/llms-full.txt

## Resources
- Full x402 manifest: ${GATEWAY_URL}/.well-known/x402.json
- Solana discovery: ${GATEWAY_URL}/.well-known/solana.json
- Agent card (A2A): ${GATEWAY_URL}/.well-known/agent.json
- OpenAPI 3.1 spec: ${GATEWAY_URL}/openapi.json
- MCP server card: ${GATEWAY_URL}/.well-known/mcp/server-card.json
- Docs: https://docs.spraay.app
- GitHub: https://github.com/plagtech/spraay-x402-gateway
- MCP on Smithery: https://smithery.ai/servers/Plagtech/Spraay-x402-mcp

## Contact
Twitter: @Spraay_app
Email: hello@spraay.app
`;

  // ---- llms-full.txt (everything, grouped, with searchTerms) ------------
  let full = `# Spraay x402 Gateway — Full Endpoint Catalog
Pay-per-use infrastructure for autonomous AI agents. Powered by the x402 protocol on Base.

${total} endpoints (${paidCount} paid + ${freeCount} free) across ${catSlugs.length} categories.
Network: Base mainnet (${network}) · Asset: USDC · Pay to: ${payTo}
Source of truth: ${GATEWAY_URL}/.well-known/x402.json

`;
  for (const slug of catSlugs) {
    full += `## ${label(slug)}\n\n`;
    for (const r of byCat[slug].sort((a, b) => a.path.localeCompare(b.path))) {
      full += `- \`${r.method} ${r.path}\` — ${r.price} — ${r.description}\n`;
      if (r.searchTerms.length) full += `  search: ${r.searchTerms.join(", ")}\n`;
    }
    full += `\n`;
  }

  writeFileSync(join(OUT_DIR, "llms.txt"), llms);
  writeFileSync(join(OUT_DIR, "llms-full.txt"), full);

  console.log(`✅ public/llms.txt        (${llms.length} bytes)`);
  console.log(`✅ public/llms-full.txt   (${full.length} bytes)`);
  console.log(
    `   Source: x402.json · ${total} endpoints (${paidCount} paid + ${freeCount} free) · ${catSlugs.length} categories`
  );
}

main().catch((e) => {
  console.error("❌ gen-discovery failed:", e.message);
  process.exit(1);
});
