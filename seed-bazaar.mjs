/**
 * Spraay Bazaar Seeding Script
 * 
 * Makes one real paid x402 request per endpoint that has declareDiscoveryExtension().
 * Each successful settlement triggers CDP Bazaar indexing for that route.
 * 
 * Usage:
 *   $env:PING_WALLET_KEY="0xYourFundedPrivateKey"
 *   node seed-bazaar.mjs
 * 
 * Options:
 *   --dry-run        List endpoints without making requests
 *   --category=ai    Only seed a specific category
 *   --skip=N         Skip first N endpoints (resume after failure)
 *   --delay=MS       Delay between requests in ms (default: 2000)
 * 
 * Cost: ~$2.42 USDC on Base mainnet to seed all 111 endpoints
 */

import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "https://gateway.spraay.app";
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SKIP = parseInt(args.find(a => a.startsWith("--skip="))?.split("=")[1] || "0");
const DELAY = parseInt(args.find(a => a.startsWith("--delay="))?.split("=")[1] || "2000");
const CATEGORY = args.find(a => a.startsWith("--category="))?.split("=")[1] || null;

// ── Endpoint definitions ──────────────────────────────────────────
// Each entry: [method, path, price, category, body (null for GET)]

const endpoints = [
  // ── AI / Chat ──
  ["POST", "/api/v1/chat/completions", 0.04, "ai", { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }],
  ["GET", "/api/v1/models", 0.001, "ai", null],

  // ── Batch Payments ──
  ["POST", "/api/v1/batch/execute", 0.02, "batch", { token: "USDC", recipients: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"], amounts: ["1000000"], sender: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8" }],
  ["POST", "/api/v1/batch/estimate", 0.001, "batch", { recipientCount: 5 }],

  // ── XRP ──
  ["GET", "/api/v1/xrp/info", 0.001, "xrp", null],

  // ── Swap / DEX ──
  ["GET", "/api/v1/swap/quote?tokenIn=USDC&tokenOut=WETH&amountIn=1000000", 0.008, "swap", null],
  ["GET", "/api/v1/swap/tokens", 0.001, "swap", null],
  ["POST", "/api/v1/swap/execute", 0.015, "swap", { tokenIn: "USDC", tokenOut: "WETH", amountIn: "100", recipient: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8" }],

  // ── Solana Jupiter ──
  ["GET", "/api/v1/solana/jupiter/quote?inputMint=USDC&outputMint=SOL&amount=1000000&slippageBps=50", 0.005, "solana", null],
  ["POST", "/api/v1/solana/jupiter/swap-tx", 0.01, "solana", { inputMint: "USDC", outputMint: "SOL", amount: "1000000", userPublicKey: "8WhWE8YgY5QBWyLowEHuaZiWdwDM3SrgDk36xYBNvYNS" }],

  // ── Solana Helius ──
  ["GET", "/api/v1/solana/helius/assets-by-owner?ownerAddress=8WhWE8YgY5QBWyLowEHuaZiWdwDM3SrgDk36xYBNvYNS", 0.003, "solana", null],
  ["GET", "/api/v1/solana/helius/asset?id=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 0.002, "solana", null],

  // ── Solana Pyth ──
  ["GET", "/api/v1/solana/pyth/price?symbol=SOL", 0.005, "solana", null],
  ["GET", "/api/v1/solana/pyth/prices?symbols=SOL,ETH,BTC", 0.008, "solana", null],

  // ── Oracle ──
  ["GET", "/api/v1/oracle/prices?tokens=ETH,cbBTC", 0.008, "oracle", null],
  ["GET", "/api/v1/oracle/gas", 0.005, "oracle", null],
  ["GET", "/api/v1/oracle/fx?base=USDC", 0.008, "oracle", null],

  // ── Bridge ──
  ["GET", "/api/v1/bridge/quote?fromChain=base&toChain=ethereum&token=USDC&amount=1000000000&fromAddress=0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", 0.05, "bridge", null],
  ["GET", "/api/v1/bridge/chains", 0.002, "bridge", null],

  // ── Payroll ──
  ["POST", "/api/v1/payroll/execute", 0.1, "payroll", { token: "USDC", sender: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", employees: [{ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", amount: "3000" }] }],
  ["POST", "/api/v1/payroll/estimate", 0.003, "payroll", { employeeCount: 10 }],
  ["GET", "/api/v1/payroll/tokens", 0.002, "payroll", null],

  // ── Invoice ──
  ["POST", "/api/v1/invoice/create", 0.05, "invoice", { creator: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", token: "USDC", amount: "1500" }],
  ["GET", "/api/v1/invoice/list?address=0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", 0.01, "invoice", null],
  ["GET", "/api/v1/invoice/INV-SEED-001", 0.01, "invoice", null],

  // ── Analytics ──
  ["GET", "/api/v1/analytics/wallet?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.01, "analytics", null],
  ["GET", "/api/v1/analytics/txhistory?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.008, "analytics", null],

  // ── Escrow ──
  ["POST", "/api/v1/escrow/create", 0.1, "escrow", { depositor: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", beneficiary: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", token: "USDC", amount: "5000" }],
  ["GET", "/api/v1/escrow/list?address=0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", 0.02, "escrow", null],
  ["GET", "/api/v1/escrow/ESC-SEED-001", 0.005, "escrow", null],
  ["POST", "/api/v1/escrow/fund", 0.02, "escrow", { escrowId: "ESC-SEED-001" }],
  ["POST", "/api/v1/escrow/release", 0.08, "escrow", { escrowId: "ESC-SEED-001", caller: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8" }],
  ["POST", "/api/v1/escrow/cancel", 0.02, "escrow", { escrowId: "ESC-SEED-001", caller: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8" }],

  // ── AI Inference ──
  ["POST", "/api/v1/inference/classify-address", 0.03, "inference", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }],
  ["POST", "/api/v1/inference/classify-tx", 0.03, "inference", { hash: "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060" }],
  ["POST", "/api/v1/inference/explain-contract", 0.03, "inference", { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
  ["POST", "/api/v1/inference/summarize", 0.03, "inference", { target: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", context: "defi" }],

  // ── Notifications ──
  ["POST", "/api/v1/notify/email", 0.01, "notify", { to: "spraay-seed@example.com", subject: "Bazaar Seed", body: "Seeding bazaar indexing." }],
  ["POST", "/api/v1/notify/sms", 0.02, "notify", { to: "+10000000000", body: "Spraay bazaar seed" }],
  ["GET", "/api/v1/notify/status?id=ntf_seed", 0.002, "notify", null],

  // ── Webhooks ──
  ["POST", "/api/v1/webhook/register", 0.01, "webhook", { url: "https://example.com/hooks/spraay-seed", events: ["payment.sent"] }],
  ["POST", "/api/v1/webhook/test", 0.005, "webhook", { webhookId: "whk_seed" }],
  ["GET", "/api/v1/webhook/list", 0.002, "webhook", null],
  ["POST", "/api/v1/webhook/delete", 0.002, "webhook", { webhookId: "whk_seed" }],

  // ── XMTP ──
  ["POST", "/api/v1/xmtp/send", 0.01, "xmtp", { to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", content: "Bazaar seed message" }],
  ["GET", "/api/v1/xmtp/inbox", 0.01, "xmtp", null],

  // ── RPC ──
  ["POST", "/api/v1/rpc/call", 0.001, "rpc", { chain: "base", method: "eth_getBalance", params: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "latest"] }],
  ["GET", "/api/v1/rpc/chains", 0.001, "rpc", null],

  // ── Storage / IPFS ──
  ["POST", "/api/v1/storage/pin", 0.01, "storage", { data: JSON.stringify({ receipt: "bazaar_seed" }), filename: "seed.json" }],
  ["GET", "/api/v1/storage/get?cid=QmSEED", 0.005, "storage", null],
  ["GET", "/api/v1/storage/status", 0.002, "storage", null],

  // ── Cron ──
  ["POST", "/api/v1/cron/create", 0.01, "cron", { action: "batch.execute", schedule: "0 9 * * 1", payload: { token: "USDC", recipients: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] } }],
  ["GET", "/api/v1/cron/list", 0.002, "cron", null],
  ["POST", "/api/v1/cron/cancel", 0.002, "cron", { jobId: "cron_seed" }],

  // ── Logs ──
  ["POST", "/api/v1/logs/ingest", 0.002, "logs", { entries: [{ level: "info", service: "bazaar-seed", message: "Seeding Bazaar" }] }],
  ["GET", "/api/v1/logs/query?service=bazaar-seed", 0.005, "logs", null],

  // ── KYC ──
  ["POST", "/api/v1/kyc/verify", 0.02, "kyc", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", type: "individual", chain: "base" }],
  ["GET", "/api/v1/kyc/status?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.01, "kyc", null],

  // ── Auth ──
  ["POST", "/api/v1/auth/session", 0.01, "auth", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", permissions: ["batch:execute"], ttlSeconds: 3600 }],
  ["GET", "/api/v1/auth/verify?token=seed_token", 0.005, "auth", null],

  // ── Audit ──
  ["POST", "/api/v1/audit/log", 0.005, "audit", { action: "bazaar.seed", actor: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", resource: "seed_001", details: { purpose: "bazaar indexing" } }],
  ["GET", "/api/v1/audit/query?actor=0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", 0.03, "audit", null],

  // ── Tax ──
  ["POST", "/api/v1/tax/calculate", 0.08, "tax", { transactions: [{ type: "swap", asset: "ETH", amount: 1.5, costBasisUsd: 3000, proceedsUsd: 4500, holdingDays: 400 }] }],
  ["GET", "/api/v1/tax/report?address=0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8&year=2025", 0.05, "tax", null],

  // ── GPU ──
  ["POST", "/api/v1/gpu/run", 0.06, "gpu", { model: "flux-pro", input: { prompt: "a serene mountain lake at sunset" } }],
  ["GET", "/api/v1/gpu/status/pred_seed_001", 0.005, "gpu", null],

  // ── Search / RAG ──
  ["POST", "/api/v1/search/web", 0.02, "search", { query: "x402 protocol", search_depth: "basic", max_results: 3 }],
  ["POST", "/api/v1/search/extract", 0.02, "search", { urls: ["https://docs.base.org/overview"] }],
  ["POST", "/api/v1/search/qna", 0.03, "search", { query: "What is x402 protocol?", topic: "general" }],

  // ── Prices / Balances / Resolve ──
  ["GET", "/api/v1/prices?tokens=ETH", 0.005, "data", null],
  ["GET", "/api/v1/balances?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.005, "data", null],
  ["GET", "/api/v1/resolve?name=vitalik.eth", 0.002, "data", null],

  // ── Wallet Provisioning ──
  ["GET", "/api/v1/wallet/list", 0.002, "wallet", null],
  ["GET", "/api/v1/wallet/wallet_seed_001", 0.001, "wallet", null],
  ["GET", "/api/v1/wallet/wallet_seed_001/addresses", 0.001, "wallet", null],
  ["POST", "/api/v1/wallet/sign-message", 0.005, "wallet", { walletId: "wallet_seed_001", message: "Bazaar seed" }],
  ["POST", "/api/v1/wallet/send-transaction", 0.02, "wallet", { walletId: "wallet_seed_001", transaction: {} }],

  // ── Robots / RTP ──
  ["POST", "/api/v1/robots/task", 0.05, "rtp", { robot_id: "robo_seed", task: "pick", parameters: { item: "SKU-00421", from_location: "bin_A3" } }],
  ["GET", "/api/v1/robots/list", 0.005, "rtp", null],
  ["GET", "/api/v1/robots/status?taskId=task_seed", 0.002, "rtp", null],
  ["GET", "/api/v1/robots/profile?robotId=robo_seed", 0.002, "rtp", null],

  // ── Agent Wallet ──
  ["POST", "/api/v1/agent-wallet/provision", 0.05, "agent-wallet", { agentId: "bazaar-seeder", agentType: "script", mode: "managed" }],
  ["POST", "/api/v1/agent-wallet/session-key", 0.02, "agent-wallet", { walletAddress: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", sessionKeyAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", spendLimitEth: "0.5", durationHours: 24 }],
  ["GET", "/api/v1/agent-wallet/info?agentId=bazaar-seeder", 0.005, "agent-wallet", null],
  ["POST", "/api/v1/agent-wallet/revoke-key", 0.02, "agent-wallet", { walletAddress: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", sessionKeyAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }],
  ["GET", "/api/v1/agent-wallet/predict?agentId=bazaar-seeder", 0.001, "agent-wallet", null],

  // ── Bittensor Drop-in ──
  ["GET", "/bittensor/v1/models", 0.001, "bittensor", null],
  ["POST", "/bittensor/v1/chat/completions", 0.03, "bittensor", { model: "deepseek-ai/DeepSeek-V3-0324", messages: [{ role: "user", content: "What is decentralized AI?" }] }],
  ["POST", "/bittensor/v1/images/generations", 0.05, "bittensor", { prompt: "A cyberpunk city powered by decentralized AI" }],
  ["POST", "/bittensor/v1/embeddings", 0.005, "bittensor", { model: "BAAI/bge-large-en-v1.5", input: "Decentralized AI" }],

  // ── Compute Services ──
  ["POST", "/api/v1/compute/text-inference", 0.03, "compute", { messages: [{ role: "user", content: "Hello" }] }],
  ["POST", "/api/v1/compute/image-generation", 0.03, "compute", { prompt: "A futuristic city", model: "auto", width: 1024, height: 1024 }],
  ["POST", "/api/v1/compute/video-generation", 0.50, "compute", { prompt: "A drone flyover of a mountain range", model: "auto", duration_seconds: 4 }],
  ["POST", "/api/v1/compute/text-to-speech", 0.03, "compute", { text: "Welcome to Spraay.", model: "auto", language: "en" }],
  ["POST", "/api/v1/compute/speech-to-text", 0.02, "compute", { audio_url: "https://example.com/audio.mp3", model: "auto" }],
  ["POST", "/api/v1/compute/embeddings", 0.005, "compute", { input: "Decentralized compute", model: "auto" }],
  ["POST", "/api/v1/compute/batch", 0.05, "compute", { jobs: [{ type: "text-inference", messages: [{ role: "user", content: "Hello" }] }] }],
  ["GET", "/api/v1/compute/status/job_seed_001", 0.001, "compute", null],

  // ── SCTP (Supply Chain) ──
  ["POST", "/api/v1/sctp/supplier", 0.02, "sctp", { name: "Acme Corp", wallet: "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8", paymentPrefs: { token: "USDC" } }],
  ["GET", "/api/v1/sctp/supplier/SUP-SEED-001", 0.005, "sctp", null],
  ["POST", "/api/v1/sctp/po", 0.02, "sctp", { supplierId: "SUP-SEED-001", lineItems: [{ sku: "ABC", qty: 10, price: "100" }] }],
  ["GET", "/api/v1/sctp/po/PO-SEED-001", 0.005, "sctp", null],
  ["POST", "/api/v1/sctp/invoice", 0.02, "sctp", { poId: "PO-SEED-001", supplierId: "SUP-SEED-001", amount: "1000", currency: "USDC" }],
  ["GET", "/api/v1/sctp/invoice/INV-SEED-001", 0.005, "sctp", null],
  ["POST", "/api/v1/sctp/invoice/verify", 0.03, "sctp", { invoiceId: "INV-SEED-001" }],
  ["POST", "/api/v1/sctp/pay", 0.10, "sctp", { invoiceId: "INV-SEED-001", batch: false }],

  // ── Portfolio ──
  ["GET", "/api/v1/portfolio/tokens?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.008, "portfolio", null],
  ["GET", "/api/v1/portfolio/nfts?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.01, "portfolio", null],

  // ── Contract Read/Write ──
  ["POST", "/api/v1/contract/read", 0.002, "contract", { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", method: "balanceOf(address)", args: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] }],
  ["POST", "/api/v1/contract/write", 0.015, "contract", { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", method: "transfer(address,uint256)", args: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "1000000"], walletId: "wallet_seed" }],

  // ── DeFi Positions ──
  ["GET", "/api/v1/defi/positions?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", 0.02, "defi", null],
];

// ── Main ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const filtered = CATEGORY 
    ? endpoints.filter(([,,, cat]) => cat === CATEGORY) 
    : endpoints;
  
  const toRun = filtered.slice(SKIP);
  const totalCost = toRun.reduce((sum, [,, price]) => sum + price, 0);

  console.log(`\n💧 Spraay Bazaar Seeding Script`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Endpoints to seed: ${toRun.length} / ${endpoints.length}`);
  console.log(`  Estimated cost:    $${totalCost.toFixed(3)} USDC`);
  console.log(`  Delay between:     ${DELAY}ms`);
  if (CATEGORY) console.log(`  Category filter:   ${CATEGORY}`);
  if (SKIP) console.log(`  Skipping first:    ${SKIP}`);
  console.log(`  Mode:              ${DRY_RUN ? "DRY RUN" : "LIVE"}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (DRY_RUN) {
    for (const [i, [method, path, price, cat]] of toRun.entries()) {
      console.log(`  ${String(SKIP + i + 1).padStart(3)}. [${cat.padEnd(12)}] ${method.padEnd(4)} ${path}  ($${price})`);
    }
    console.log(`\n  Total: $${totalCost.toFixed(3)} USDC\n`);
    return;
  }

  // Setup x402 client
  if (!process.env.PING_WALLET_KEY) {
    console.error("ERROR: Set PING_WALLET_KEY env var to a funded private key");
    process.exit(1);
  }

  const signer = privateKeyToAccount(process.env.PING_WALLET_KEY);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const f = wrapFetchWithPayment(fetch, client);

  console.log(`  Wallet: ${signer.address}\n`);

  let succeeded = 0;
  let failed = 0;
  let spent = 0;
  const failures = [];

  for (const [i, [method, path, price, cat, body]] of toRun.entries()) {
    const idx = SKIP + i + 1;
    const url = `${BASE}${path}`;
    const label = `${method} ${path}`;

    try {
      process.stdout.write(`  ${String(idx).padStart(3)}/${endpoints.length} ${label} ... `);

      const opts = { method };
      if (body) {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
      }

      const res = await f(url, opts);
      const status = res.status;

      if (status === 200 || status === 201) {
        console.log(`✅ ${status}  ($${price})`);
        succeeded++;
        spent += price;
      } else {
        const text = await res.text().catch(() => "");
        const snippet = text.slice(0, 120);
        console.log(`⚠️  ${status}  ${snippet}`);
        // Still counts as settlement if x402 payment was accepted (status != 402)
        if (status !== 402) {
          succeeded++;
          spent += price;
        } else {
          failed++;
          failures.push({ idx, label, status, snippet });
        }
      }
    } catch (err) {
      console.log(`❌ ${err.message?.slice(0, 100)}`);
      failed++;
      failures.push({ idx, label, status: "error", snippet: err.message?.slice(0, 100) });
    }

    if (i < toRun.length - 1) await sleep(DELAY);
  }

  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ✅ Succeeded: ${succeeded}`);
  console.log(`  ❌ Failed:    ${failed}`);
  console.log(`  💰 Spent:     ~$${spent.toFixed(3)} USDC`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  if (failures.length > 0) {
    console.log(`  Failed endpoints:`);
    for (const f of failures) {
      console.log(`    #${f.idx} ${f.label} → ${f.status} ${f.snippet}`);
    }
    console.log();
  }

  console.log(`  Next step: wait 5-10 minutes for async indexing, then verify:`);
  console.log(`  node -e "fetch('https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=spraay').then(r=>r.json()).then(d=>console.log(d.resources.length+' endpoints indexed'))"`);
  console.log();
}

main().catch(err => { console.error(err); process.exit(1); });
