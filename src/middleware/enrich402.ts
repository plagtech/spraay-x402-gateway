// ============================================
// 402 RESPONSE ENRICHMENT MIDDLEWARE
// src/middleware/enrich402.ts
// ============================================
//
// Wraps res.json to intercept 402 responses from @x402/express's
// paymentMiddleware and inject additional fields that turn the 402
// into a mini landing page: description, example_request, example_response,
// docs_url, related_endpoints.
//
// DESIGN PRINCIPLES:
// - Only enriches 402 responses; all other status codes pass through untouched
// - Only adds fields for endpoints in ENDPOINT_ENRICHMENT; unknown endpoints pass through
// - All data is static (no network calls in the hot path)
// - Preserves the x402 protocol shape — accepts[], x402Version, etc. untouched
// - New fields are additive; existing clients that parse the 402 body still work
//
// WIRING:
//   1. Import enrich402Middleware
//   2. Register it BEFORE app.use(paymentMiddleware(...))  — so the wrapped
//      res.json is in place when paymentMiddleware writes its 402 body
//
// ============================================

import { Request, Response, NextFunction } from "express";

// ============================================
// ENRICHMENT MAP
// Single source of truth for per-endpoint enrichment data.
// Add new endpoints here when they're added to paymentMiddleware.
// ============================================

interface EndpointEnrichment {
  description: string;
  example_request?: any;          // For POST — request body example. For GET — query string hint.
  example_response?: any;         // What a successful 200 looks like
  related_endpoints: RelatedEndpoint[];
}

interface RelatedEndpoint {
  method: string;
  path: string;
  price: string;
  why: string;
}

const DOCS_URL = "https://docs.spraay.app";

// Key format: "METHOD /path" exactly matching paymentMiddleware route keys
const ENDPOINT_ENRICHMENT: Record<string, EndpointEnrichment> = {
  // ============================================
  // AI INFERENCE
  // ============================================
  "POST /api/v1/chat/completions": {
    description: "OpenAI-compatible chat completions via 200+ models (GPT-4o, Claude 3.5, Llama, Mistral, and more). Drop-in replacement for OpenAI's API.",
    example_request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Hello" }],
    },
    example_response: {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "Hello! How can I help?" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 9, total_tokens: 17 },
    },
    related_endpoints: [
      { method: "POST", path: "/api/v1/search/qna", price: "$0.03", why: "Augment chat with real-time structured search results" },
      { method: "GET", path: "/api/v1/oracle/prices", price: "$0.008", why: "Ground financial questions in real price data" },
    ],
  },
  "GET /api/v1/models": {
    description: "List all available AI models across providers (OpenRouter + BlockRun). Returns model IDs, context windows, and capabilities.",
    example_response: { models: [{ id: "openai/gpt-4o-mini", context_length: 128000 }], count: 200 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Run inference on any listed model" },
      { method: "POST", path: "/bittensor/v1/chat/completions", price: "$0.03", why: "Decentralized inference via Bittensor SN64" },
    ],
  },

  // ============================================
  // BITTENSOR DROP-IN API
  // ============================================
  "POST /bittensor/v1/chat/completions": {
    description: "Decentralized AI inference via Bittensor SN64 (Chutes AI). OpenAI-compatible drop-in. No API key management — pay per call with USDC.",
    example_request: {
      model: "chutesai/Llama-3.1-Nemotron-70B-Instruct",
      messages: [{ role: "user", content: "What is Bittensor?" }],
    },
    example_response: {
      id: "chatcmpl-bt-xyz",
      choices: [{ message: { role: "assistant", content: "Bittensor is a decentralized AI network..." } }],
    },
    related_endpoints: [
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Fallback to centralized models (OpenRouter/BlockRun)" },
      { method: "POST", path: "/api/v1/search/qna", price: "$0.03", why: "Augment Bittensor inference with web search" },
    ],
  },
  "GET /bittensor/v1/models": {
    description: "List available Bittensor models (Chutes AI SN64). OpenAI-compatible response format.",
    example_response: { object: "list", data: [{ id: "chutesai/Llama-3.1-Nemotron-70B-Instruct", object: "model" }] },
    related_endpoints: [
      { method: "POST", path: "/bittensor/v1/chat/completions", price: "$0.03", why: "Run inference on any listed Bittensor model" },
      { method: "GET", path: "/api/v1/models", price: "$0.001", why: "See centralized models for fallback" },
    ],
  },
  "POST /bittensor/v1/images/generations": {
    description: "Decentralized image generation via Bittensor SN19. OpenAI-compatible drop-in.",
    example_request: { model: "sn19/flux", prompt: "A serene mountain lake at sunrise" },
    example_response: { data: [{ url: "https://..." }] },
    related_endpoints: [
      { method: "POST", path: "/bittensor/v1/chat/completions", price: "$0.03", why: "Pair image gen with chat for creative workflows" },
      { method: "POST", path: "/api/v1/storage/pin", price: "$0.01", why: "Pin generated images to IPFS for permanence" },
    ],
  },
  "POST /bittensor/v1/embeddings": {
    description: "Decentralized text embeddings via Bittensor. OpenAI-compatible drop-in for vector search and RAG.",
    example_request: { model: "sn58/text-embedding", input: "The quick brown fox" },
    example_response: { data: [{ embedding: [0.123, -0.456] }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/search/qna", price: "$0.03", why: "Pair embeddings with structured Q&A search" },
      { method: "POST", path: "/api/v1/storage/pin", price: "$0.01", why: "Store embedding vectors on IPFS" },
    ],
  },

  // ============================================
  // PAYMENTS / BATCH
  // ============================================
  "POST /api/v1/batch/execute": {
    description: "Execute batch USDC or ERC-20 payments via Spraay Protocol on Base. Up to 200 recipients in a single transaction. 0.3% protocol fee.",
    example_request: {
      token: "USDC",
      recipients: ["0xabc...", "0xdef..."],
      amounts: ["1000000", "2000000"],
      sender: "0xYourWallet",
    },
    example_response: {
      transactions: [{ hash: "0xabc...", status: "submitted", gasUsed: "185000" }],
      totalSent: "3000000",
    },
    related_endpoints: [
      { method: "POST", path: "/api/v1/batch/estimate", price: "$0.001", why: "Always estimate gas before executing" },
      { method: "GET", path: "/api/v1/resolve", price: "$0.002", why: "Resolve ENS names to addresses before batching" },
    ],
  },
  "POST /api/v1/batch/estimate": {
    description: "Estimate gas cost for a batch payment before execution. Returns estimated gas, USDC equivalent, and protocol fee.",
    example_request: { recipientCount: 5 },
    example_response: { estimatedGas: "185000", feeBps: 30, totalCostUsd: "0.42" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/batch/execute", price: "$0.02", why: "Execute the batch after estimation" },
      { method: "GET", path: "/api/v1/oracle/gas", price: "$0.005", why: "Get current gas prices to time execution" },
    ],
  },
  "POST /api/v1/stellar/batch": {
    description: "Batch XLM or Stellar-asset payments on Stellar mainnet. Native multi-op transactions.",
    example_response: { txHash: "...", operations: 5 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/stellar/estimate", price: "$0.001", why: "Estimate Stellar batch cost first" },
      { method: "GET", path: "/api/v1/oracle/fx", price: "$0.008", why: "FX rates for multi-currency conversion" },
    ],
  },
  "POST /api/v1/stellar/estimate": {
    description: "Estimate fee for a Stellar batch payment. Returns per-op fee and total.",
    example_response: { estimatedFee: "0.00005", operations: 5 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/stellar/batch", price: "$0.02", why: "Execute the Stellar batch" },
      { method: "GET", path: "/api/v1/oracle/fx", price: "$0.008", why: "Cross-reference Stellar asset pricing" },
    ],
  },
  "POST /api/v1/xrp/batch": {
    description: "Batch XRP payments on XRP Ledger. Sequential Payment transactions (native Batch amendment pending mainnet).",
    example_response: { transactions: [{ hash: "...", sequence: 1 }], total: 5 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/xrp/estimate", price: "$0.001", why: "Estimate XRP batch cost first" },
      { method: "GET", path: "/api/v1/xrp/info", price: "free", why: "Get XRP ledger info and sequence numbers" },
    ],
  },
  "POST /api/v1/xrp/estimate": {
    description: "Estimate fee and sequence range for an XRP batch payment.",
    example_response: { estimatedFee: "0.00010", sequenceStart: 12345 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/xrp/batch", price: "$0.02", why: "Execute the XRP batch" },
      { method: "GET", path: "/api/v1/xrp/info", price: "free", why: "Verify ledger state before execution" },
    ],
  },

  // ============================================
  // DEFI / SWAP
  // ============================================
  "GET /api/v1/swap/quote": {
    description: "Swap quote via Uniswap V3 / Aerodrome on Base. Returns amount out, price impact, and route.",
    example_request: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" },
    example_response: { amountOut: "384215000000000", priceImpact: "0.12", route: ["USDC", "WETH"] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/swap/execute", price: "$0.015", why: "Execute the swap after quoting" },
      { method: "GET", path: "/api/v1/oracle/prices", price: "$0.008", why: "Cross-check quote against oracle prices" },
    ],
  },
  "GET /api/v1/swap/tokens": {
    description: "List tokens supported on Spraay's Base DEX aggregator.",
    example_response: { tokens: [{ symbol: "USDC", address: "0x833589..." }] },
    related_endpoints: [
      { method: "GET", path: "/api/v1/swap/quote", price: "$0.008", why: "Quote a swap between any listed tokens" },
      { method: "GET", path: "/api/v1/prices", price: "$0.002", why: "Get current prices for listed tokens" },
    ],
  },
  "POST /api/v1/swap/execute": {
    description: "Execute a swap on Uniswap V3 / Aerodrome via MangoSwap router. Gas-optimized routing.",
    example_request: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000", slippageBps: 50 },
    example_response: { txHash: "0x...", amountOut: "384215000000000" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/swap/quote", price: "$0.008", why: "Always quote before executing" },
      { method: "GET", path: "/api/v1/balances", price: "$0.005", why: "Verify balances after swap" },
    ],
  },

  // ============================================
  // ORACLE / DATA
  // ============================================
  "GET /api/v1/oracle/prices": {
    description: "Multi-source oracle price feed. Aggregates Chainlink, Pyth, and DEX TWAPs for cross-validated prices.",
    example_request: { symbol: "ETH" },
    example_response: { symbol: "ETH", priceUsd: "3842.15", sources: ["chainlink", "pyth"], confidence: 0.99 },
    related_endpoints: [
      { method: "GET", path: "/api/v1/swap/quote", price: "$0.008", why: "Use oracle prices to validate swap quotes" },
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Feed prices into AI for financial analysis" },
    ],
  },
  "GET /api/v1/oracle/gas": {
    description: "Current gas prices across supported EVM chains. Returns slow/standard/fast tiers in gwei.",
    example_response: { chain: "base", slow: "0.001", standard: "0.005", fast: "0.01" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/batch/execute", price: "$0.02", why: "Time batch execution with gas conditions" },
      { method: "POST", path: "/api/v1/batch/estimate", price: "$0.001", why: "Factor current gas into cost estimates" },
    ],
  },
  "GET /api/v1/oracle/fx": {
    description: "Stablecoin and fiat FX rates (USDC/USDT/DAI/EURC cross-rates plus USD/EUR/GBP/JPY).",
    example_response: { pair: "USDC/EURC", rate: "0.9214" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/payroll/execute", price: "$0.10", why: "FX for multi-currency payroll" },
      { method: "POST", path: "/api/v1/stellar/batch", price: "$0.02", why: "Cross-currency Stellar payments" },
    ],
  },
  "GET /api/v1/prices": {
    description: "Token prices across supported chains. Simple price lookup — use /oracle/prices for multi-source confidence scores.",
    example_request: { symbol: "USDC" },
    example_response: { symbol: "USDC", priceUsd: "1.00" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/swap/quote", price: "$0.008", why: "Price-aware swap decisions" },
      { method: "GET", path: "/api/v1/balances", price: "$0.005", why: "Convert balances to USD" },
    ],
  },
  "GET /api/v1/balances": {
    description: "Token balances for any wallet across supported chains. Returns native + ERC-20 balances.",
    example_request: { address: "0x..." },
    example_response: { address: "0x...", balances: [{ token: "USDC", amount: "1000000", decimals: 6 }] },
    related_endpoints: [
      { method: "GET", path: "/api/v1/resolve", price: "$0.002", why: "Resolve ENS names to balance-lookup addresses" },
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Full wallet analytics including history" },
    ],
  },

  // ============================================
  // BRIDGE
  // ============================================
  "GET /api/v1/bridge/quote": {
    description: "Cross-chain bridge quote across 10+ chains. Routes via LI.FI / Across / Stargate for best execution.",
    example_request: { fromChain: "base", toChain: "arbitrum", token: "USDC", amount: "1000000" },
    example_response: { route: "across", estimatedTime: 45, feeUsd: "0.12" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/bridge/chains", price: "$0.002", why: "See all supported bridge chains" },
      { method: "GET", path: "/api/v1/oracle/fx", price: "$0.008", why: "Cross-rate different chain's stablecoin pricing" },
    ],
  },
  "GET /api/v1/bridge/chains": {
    description: "List all chains supported by the bridge aggregator with route availability.",
    example_response: { chains: [{ id: 8453, name: "Base" }, { id: 42161, name: "Arbitrum" }] },
    related_endpoints: [
      { method: "GET", path: "/api/v1/bridge/quote", price: "$0.05", why: "Quote a bridge between any supported chains" },
      { method: "POST", path: "/api/v1/rpc/call", price: "$0.001", why: "Verify balances on destination chain" },
    ],
  },

  // ============================================
  // PAYROLL
  // ============================================
  "POST /api/v1/payroll/execute": {
    description: "Execute crypto payroll run via StablePay + Spraay. Pays employees/contractors in USDC, USDT, or any ERC-20 on Base.",
    example_request: { token: "USDC", payees: [{ address: "0x...", amount: "5000000000" }] },
    example_response: { txHash: "0x...", totalPaid: "5000000000", payeeCount: 1 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/payroll/estimate", price: "$0.003", why: "Always estimate payroll cost first" },
      { method: "GET", path: "/api/v1/payroll/tokens", price: "$0.002", why: "See supported payroll tokens" },
    ],
  },
  "POST /api/v1/payroll/estimate": {
    description: "Estimate gas + protocol fees for a payroll run before execution.",
    example_response: { estimatedGas: "420000", feeUsd: "0.18" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/payroll/execute", price: "$0.10", why: "Execute the payroll after estimating" },
      { method: "GET", path: "/api/v1/resolve", price: "$0.002", why: "Resolve ENS names in payee list" },
    ],
  },
  "GET /api/v1/payroll/tokens": {
    description: "List tokens supported for payroll runs (USDC, USDT, DAI, EURC, plus native ETH).",
    example_response: { tokens: ["USDC", "USDT", "DAI", "EURC", "ETH"] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/payroll/execute", price: "$0.10", why: "Run payroll with a selected token" },
      { method: "GET", path: "/api/v1/oracle/fx", price: "$0.008", why: "Convert payroll amounts across currencies" },
    ],
  },

  // ============================================
  // INVOICE
  // ============================================
  "POST /api/v1/invoice/create": {
    description: "Generate an x402-payable invoice with lifecycle hooks. Invoice becomes a paid endpoint that collects USDC on fulfillment.",
    example_request: { recipient: "0x...", amount: "100000000", description: "Invoice for services" },
    example_response: { invoiceId: "inv_abc123", payUrl: "https://gateway.spraay.app/pay/inv_abc123" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/invoice/list", price: "$0.01", why: "View all your invoices" },
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Get notified when invoice is paid" },
    ],
  },
  "GET /api/v1/invoice/list": {
    description: "List all invoices created by a wallet address. Filter by status (open/paid/expired).",
    example_response: { invoices: [{ id: "inv_abc", status: "open", amount: "100000000" }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/invoice/create", price: "$0.05", why: "Create a new invoice" },
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Full wallet profile including invoice activity" },
    ],
  },
  "GET /api/v1/invoice/:id": {
    description: "Retrieve a single invoice by ID. Returns full metadata, payment status, and payUrl.",
    example_response: { id: "inv_abc", status: "paid", paidAt: "2026-04-17T..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/invoice/list", price: "$0.01", why: "List all your invoices" },
      { method: "POST", path: "/api/v1/invoice/create", price: "$0.05", why: "Create another invoice" },
    ],
  },

  // ============================================
  // ANALYTICS
  // ============================================
  "GET /api/v1/analytics/wallet": {
    description: "Wallet profile and activity analysis. Returns tx count, top tokens, contract interactions, risk flags.",
    example_request: { address: "0x..." },
    example_response: { address: "0x...", txCount: 1234, topTokens: ["USDC"], riskScore: 0.12 },
    related_endpoints: [
      { method: "GET", path: "/api/v1/analytics/txhistory", price: "$0.008", why: "Detailed transaction history with classification" },
      { method: "POST", path: "/api/v1/inference/classify-address", price: "$0.03", why: "AI classification of wallet type" },
    ],
  },
  "GET /api/v1/analytics/txhistory": {
    description: "Transaction history for a wallet with classification (transfer, swap, bridge, mint, etc.).",
    example_response: { transactions: [{ hash: "0x...", type: "swap", valueUsd: "142.50" }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/inference/classify-tx", price: "$0.03", why: "AI-enriched transaction classification" },
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Wallet-level summary" },
    ],
  },

  // ============================================
  // ESCROW
  // ============================================
  "POST /api/v1/escrow/create": {
    description: "Create an on-chain escrow contract with release conditions. Supports time-lock, multisig release, and dispute resolution.",
    example_request: { payer: "0x...", payee: "0x...", amount: "1000000000", releaseCondition: "timelock", releaseAt: "2026-05-01" },
    example_response: { escrowId: "esc_xyz", address: "0x...", status: "created" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/escrow/fund", price: "$0.02", why: "Fund the escrow after creation" },
      { method: "POST", path: "/api/v1/escrow/release", price: "$0.08", why: "Release funds when conditions met" },
    ],
  },
  "POST /api/v1/escrow/fund": {
    description: "Fund a previously-created escrow with the agreed amount. Transfers tokens into the escrow contract.",
    example_request: { escrowId: "esc_xyz", amount: "1000000000" },
    example_response: { escrowId: "esc_xyz", status: "funded", txHash: "0x..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/escrow/release", price: "$0.08", why: "Release funds when conditions met" },
      { method: "GET", path: "/api/v1/escrow/list", price: "$0.02", why: "View all your escrows" },
    ],
  },
  "POST /api/v1/escrow/release": {
    description: "Release funds from an escrow to the payee once conditions are met. Requires appropriate authorization.",
    example_request: { escrowId: "esc_xyz" },
    example_response: { escrowId: "esc_xyz", status: "released", txHash: "0x...", paidAmount: "1000000000" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/escrow/create", price: "$0.10", why: "Create a new escrow for the next deal" },
      { method: "POST", path: "/api/v1/invoice/create", price: "$0.05", why: "Generate an invoice for the completed work" },
    ],
  },
  "GET /api/v1/escrow/list": {
    description: "List all escrows created by or assigned to a wallet. Filter by status.",
    example_response: { escrows: [{ id: "esc_xyz", status: "funded", amount: "1000000000" }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/escrow/create", price: "$0.10", why: "Create a new escrow" },
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Wallet profile including escrow activity" },
    ],
  },
  "GET /api/v1/escrow/:id": {
    description: "Retrieve a single escrow by ID with full state, conditions, and transaction history.",
    example_response: { id: "esc_xyz", status: "funded", condition: "timelock" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/escrow/release", price: "$0.08", why: "Release funds when conditions met" },
      { method: "POST", path: "/api/v1/escrow/cancel", price: "$0.02", why: "Cancel and refund payer" },
    ],
  },
  "POST /api/v1/escrow/cancel": {
    description: "Cancel an escrow and refund the payer. Only valid before conditions are met or if both parties agree.",
    example_request: { escrowId: "esc_xyz" },
    example_response: { escrowId: "esc_xyz", status: "cancelled", refundTxHash: "0x..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/escrow/create", price: "$0.10", why: "Create a new escrow" },
      { method: "GET", path: "/api/v1/escrow/list", price: "$0.02", why: "View all your escrows" },
    ],
  },

  // ============================================
  // INFERENCE (AI analysis)
  // ============================================
  "POST /api/v1/inference/classify-address": {
    description: "AI-powered wallet classification. Returns wallet type (EOA/contract/exchange/bridge/DeFi user), risk score, and labels.",
    example_request: { address: "0x..." },
    example_response: { type: "DeFi user", labels: ["uniswap", "aave"], riskScore: 0.08 },
    related_endpoints: [
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Full wallet profile to pair with classification" },
      { method: "POST", path: "/api/v1/inference/classify-tx", price: "$0.03", why: "Classify individual transactions" },
    ],
  },
  "POST /api/v1/inference/classify-tx": {
    description: "AI classification of a single transaction. Returns type (transfer/swap/liquidation/etc.), intent, and risk flags.",
    example_request: { txHash: "0x..." },
    example_response: { type: "swap", intent: "arbitrage", riskFlags: [] },
    related_endpoints: [
      { method: "GET", path: "/api/v1/analytics/txhistory", price: "$0.008", why: "Feed classified txs into history analysis" },
      { method: "POST", path: "/api/v1/inference/summarize", price: "$0.03", why: "Natural-language summary of tx activity" },
    ],
  },
  "POST /api/v1/inference/explain-contract": {
    description: "AI explains a smart contract's purpose and key functions. Verifies source when available, decompiles when not.",
    example_request: { address: "0x...", chain: "base" },
    example_response: { purpose: "Uniswap V3 Router", keyFunctions: ["swap", "addLiquidity"], auditStatus: "verified" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/inference/summarize", price: "$0.03", why: "Natural-language summary for reports" },
      { method: "POST", path: "/api/v1/rpc/call", price: "$0.001", why: "Call contract functions directly after understanding" },
    ],
  },
  "POST /api/v1/inference/summarize": {
    description: "AI summarizes arbitrary on-chain data (tx list, wallet activity, contract interactions) into natural language.",
    example_request: { data: { txs: [] }, style: "concise" },
    example_response: { summary: "This wallet is an active DeFi trader focused on stablecoin arbitrage..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Extend summaries with custom prompts" },
      { method: "POST", path: "/api/v1/search/qna", price: "$0.03", why: "Answer questions about the summarized data" },
    ],
  },

  // ============================================
  // COMMUNICATION
  // ============================================
  "POST /api/v1/notify/email": {
    description: "Send transactional email via AgentMail. Reliable delivery, DKIM signed.",
    example_request: { to: "user@example.com", subject: "Invoice paid", body: "Your invoice has been paid." },
    example_response: { messageId: "msg_abc123", status: "sent" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/notify/sms", price: "$0.02", why: "Send SMS for higher-urgency notifications" },
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Get delivery status via webhook" },
    ],
  },
  "POST /api/v1/notify/sms": {
    description: "Send SMS notifications. Global delivery with per-message pricing.",
    example_request: { to: "+15551234567", body: "Payment confirmed" },
    example_response: { messageId: "sms_abc", status: "queued" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/notify/email", price: "$0.01", why: "Email for detailed notifications" },
      { method: "POST", path: "/api/v1/xmtp/send", price: "$0.01", why: "On-chain messaging via XMTP" },
    ],
  },
  "GET /api/v1/notify/status": {
    description: "Check delivery status of a previously-sent email or SMS by message ID.",
    example_request: { messageId: "msg_abc123" },
    example_response: { messageId: "msg_abc123", status: "delivered", deliveredAt: "2026-04-17T..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Get status changes pushed via webhook" },
      { method: "POST", path: "/api/v1/notify/email", price: "$0.01", why: "Send another email" },
    ],
  },
  "POST /api/v1/webhook/register": {
    description: "Register a webhook URL for gateway events (payment, delivery, contract fills).",
    example_request: { url: "https://yourapp.com/hook", events: ["payment.received"] },
    example_response: { webhookId: "wh_abc", status: "active" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/webhook/test", price: "$0.005", why: "Test your webhook handler" },
      { method: "POST", path: "/api/v1/notify/email", price: "$0.01", why: "Fallback email notifications" },
    ],
  },
  "POST /api/v1/webhook/test": {
    description: "Send a test payload to a registered webhook to verify handler.",
    example_request: { webhookId: "wh_abc" },
    example_response: { webhookId: "wh_abc", testResult: "200", responseTimeMs: 142 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Register another webhook" },
      { method: "GET", path: "/api/v1/logs/query", price: "$0.005", why: "Query webhook delivery logs" },
    ],
  },
  "GET /api/v1/webhook/list": {
    description: "List all registered webhooks for a wallet.",
    example_response: { webhooks: [{ id: "wh_abc", url: "https://...", events: ["payment.received"] }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Register a new webhook" },
      { method: "POST", path: "/api/v1/webhook/delete", price: "$0.002", why: "Remove a webhook" },
    ],
  },
  "POST /api/v1/webhook/delete": {
    description: "Delete a registered webhook by ID.",
    example_request: { webhookId: "wh_abc" },
    example_response: { deleted: true },
    related_endpoints: [
      { method: "GET", path: "/api/v1/webhook/list", price: "$0.002", why: "View remaining webhooks" },
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Register a replacement webhook" },
    ],
  },
  "POST /api/v1/xmtp/send": {
    description: "Send an on-chain message via XMTP. Delivered to wallet address — recipient sees it in any XMTP-compatible client.",
    example_request: { to: "0x...", content: "Hello from Spraay" },
    example_response: { messageId: "xmtp_abc", status: "delivered" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/xmtp/inbox", price: "$0.01", why: "Read XMTP messages for your wallet" },
      { method: "POST", path: "/api/v1/notify/email", price: "$0.01", why: "Traditional email alternative" },
    ],
  },
  "GET /api/v1/xmtp/inbox": {
    description: "Read XMTP messages for a wallet address. Paginated inbox with read/unread status.",
    example_request: { address: "0x..." },
    example_response: { messages: [{ from: "0x...", content: "Hi", sentAt: "..." }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/xmtp/send", price: "$0.01", why: "Reply to XMTP messages" },
      { method: "GET", path: "/api/v1/notify/status", price: "$0.002", why: "Check delivery status of sent messages" },
    ],
  },

  // ============================================
  // INFRASTRUCTURE
  // ============================================
  "POST /api/v1/rpc/call": {
    description: "JSON-RPC call to any supported chain. Base, Ethereum, Arbitrum, Optimism, Polygon, BNB, Avalanche, and more.",
    example_request: { chain: "base", method: "eth_blockNumber", params: [] },
    example_response: { result: "0x1a2b3c" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/rpc/chains", price: "$0.001", why: "List all supported RPC chains" },
      { method: "GET", path: "/api/v1/balances", price: "$0.005", why: "Higher-level balance lookup instead of raw RPC" },
    ],
  },
  "GET /api/v1/rpc/chains": {
    description: "List all chains with RPC support, their chain IDs, and current block heights.",
    example_response: { chains: [{ id: 8453, name: "Base", blockHeight: 17234567 }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/rpc/call", price: "$0.001", why: "Make an RPC call to any listed chain" },
      { method: "GET", path: "/api/v1/bridge/chains", price: "$0.002", why: "See which chains are bridgeable" },
    ],
  },
  "POST /api/v1/storage/pin": {
    description: "Pin content to IPFS via Pinata. Returns CID and permanent gateway URL.",
    example_request: { content: "base64_or_url", name: "my-file.json" },
    example_response: { cid: "QmAbc...", gatewayUrl: "https://gateway.pinata.cloud/ipfs/QmAbc..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/storage/get", price: "$0.005", why: "Retrieve pinned content by CID" },
      { method: "GET", path: "/api/v1/storage/status", price: "$0.002", why: "Verify pin status" },
    ],
  },
  "GET /api/v1/storage/get": {
    description: "Retrieve IPFS content by CID. Uses fastest available gateway with fallbacks.",
    example_request: { cid: "QmAbc..." },
    example_response: { cid: "QmAbc...", content: "..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/storage/status", price: "$0.002", why: "Check pin status before retrieval" },
      { method: "POST", path: "/api/v1/storage/pin", price: "$0.01", why: "Pin new content to IPFS" },
    ],
  },
  "GET /api/v1/storage/status": {
    description: "Check pin status for a CID across Pinata and public IPFS nodes.",
    example_request: { cid: "QmAbc..." },
    example_response: { cid: "QmAbc...", pinned: true, replicas: 3 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/storage/pin", price: "$0.01", why: "Pin new content" },
      { method: "GET", path: "/api/v1/storage/get", price: "$0.005", why: "Retrieve the pinned content" },
    ],
  },
  "POST /api/v1/cron/create": {
    description: "Schedule a recurring gateway call. Runs on your schedule and delivers results via webhook.",
    example_request: { schedule: "0 9 * * *", endpoint: "/api/v1/oracle/prices", params: { symbol: "ETH" } },
    example_response: { cronId: "cron_abc", nextRun: "2026-04-18T09:00:00Z" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/cron/list", price: "$0.002", why: "View your scheduled jobs" },
      { method: "POST", path: "/api/v1/webhook/register", price: "$0.01", why: "Register webhook to receive cron results" },
    ],
  },
  "GET /api/v1/cron/list": {
    description: "List scheduled cron jobs for a wallet.",
    example_response: { crons: [{ id: "cron_abc", schedule: "0 9 * * *", nextRun: "..." }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/cron/create", price: "$0.01", why: "Schedule a new job" },
      { method: "POST", path: "/api/v1/cron/cancel", price: "$0.002", why: "Cancel an existing job" },
    ],
  },
  "POST /api/v1/cron/cancel": {
    description: "Cancel a scheduled cron job by ID.",
    example_request: { cronId: "cron_abc" },
    example_response: { cronId: "cron_abc", status: "cancelled" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/cron/list", price: "$0.002", why: "View remaining scheduled jobs" },
      { method: "POST", path: "/api/v1/cron/create", price: "$0.01", why: "Schedule a replacement job" },
    ],
  },
  "POST /api/v1/logs/ingest": {
    description: "Ingest logs from your agent or application. Structured JSON, queryable later via /logs/query.",
    example_request: { service: "my-agent", level: "info", message: "Task complete" },
    example_response: { logId: "log_abc", ingested: true },
    related_endpoints: [
      { method: "GET", path: "/api/v1/logs/query", price: "$0.005", why: "Query logs you've ingested" },
      { method: "POST", path: "/api/v1/audit/log", price: "$0.001", why: "Audit-grade logging with on-chain attestation" },
    ],
  },
  "GET /api/v1/logs/query": {
    description: "Query ingested logs. Supports filters by service, level, time range, and full-text search.",
    example_request: { service: "my-agent", since: "1h" },
    example_response: { logs: [{ id: "log_abc", message: "Task complete", at: "..." }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/logs/ingest", price: "$0.002", why: "Ingest more logs to query later" },
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Combine logs with wallet analytics" },
    ],
  },

  // ============================================
  // IDENTITY / AUTH / KYC
  // ============================================
  "POST /api/v1/kyc/verify": {
    description: "Lightweight KYC verification via Spraay compliance layer. ID document + liveness check. Returns a verification session URL.",
    example_request: { walletAddress: "0x...", level: "basic" },
    example_response: { sessionId: "kyc_abc", verifyUrl: "https://..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/kyc/status", price: "$0.01", why: "Check verification status" },
      { method: "POST", path: "/api/v1/auth/session", price: "$0.01", why: "Create auth session after KYC" },
    ],
  },
  "GET /api/v1/kyc/status": {
    description: "Check KYC verification status by session ID or wallet address.",
    example_response: { status: "verified", level: "basic", verifiedAt: "..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/kyc/verify", price: "$0.08", why: "Start a new KYC session" },
      { method: "GET", path: "/api/v1/auth/verify", price: "$0.005", why: "Verify auth token includes KYC claims" },
    ],
  },
  "POST /api/v1/auth/session": {
    description: "Create an authenticated session for a wallet via SIWE (Sign-In With Ethereum).",
    example_request: { walletAddress: "0x...", signature: "0x..." },
    example_response: { sessionToken: "...", expiresAt: "..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/auth/verify", price: "$0.005", why: "Verify session tokens" },
      { method: "POST", path: "/api/v1/kyc/verify", price: "$0.08", why: "Upgrade session with KYC verification" },
    ],
  },
  "GET /api/v1/auth/verify": {
    description: "Verify a session token is valid, not expired, and returns its claims (wallet, KYC level, permissions).",
    example_response: { valid: true, walletAddress: "0x...", kycLevel: "basic" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/auth/session", price: "$0.01", why: "Create a new session if expired" },
      { method: "GET", path: "/api/v1/kyc/status", price: "$0.01", why: "Check KYC status on the wallet" },
    ],
  },

  // ============================================
  // COMPLIANCE / AUDIT / TAX
  // ============================================
  "POST /api/v1/audit/log": {
    description: "Write an audit-grade log entry with on-chain attestation via EAS. Tamper-evident records for compliance.",
    example_request: { event: "user.approved", actor: "0x...", details: {} },
    example_response: { attestationUid: "0x...", txHash: "0x..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/audit/query", price: "$0.03", why: "Query audit log history" },
      { method: "POST", path: "/api/v1/logs/ingest", price: "$0.002", why: "Non-audit logging for high-volume events" },
    ],
  },
  "GET /api/v1/audit/query": {
    description: "Query audit log entries by actor, event type, or time range. Returns on-chain attestation UIDs.",
    example_response: { entries: [{ event: "user.approved", actor: "0x...", at: "..." }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/audit/log", price: "$0.001", why: "Write new audit entries" },
      { method: "GET", path: "/api/v1/tax/report", price: "$0.05", why: "Generate tax reports from audit data" },
    ],
  },
  "POST /api/v1/tax/calculate": {
    description: "Calculate tax liability on crypto transactions. Supports FIFO/LIFO/HIFO methods across tax jurisdictions.",
    example_request: { wallet: "0x...", year: 2025, method: "FIFO" },
    example_response: { totalGains: "12450.00", totalLosses: "2100.00", netLiability: "2587.50" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/tax/report", price: "$0.05", why: "Generate full tax report PDF/CSV" },
      { method: "POST", path: "/api/v1/audit/log", price: "$0.001", why: "Log tax calculations for audit trail" },
    ],
  },
  "GET /api/v1/tax/report": {
    description: "Generate a formatted tax report (CSV/PDF) for a wallet and tax year. Includes all trades, income, and cost basis.",
    example_response: { reportUrl: "https://...", format: "csv", year: 2025 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/tax/calculate", price: "$0.08", why: "Calculate liability before generating reports" },
      { method: "GET", path: "/api/v1/analytics/txhistory", price: "$0.008", why: "Raw transaction history behind the tax report" },
    ],
  },

  // ============================================
  // GPU / COMPUTE
  // ============================================
  "POST /api/v1/gpu/run": {
    description: "Run GPU workloads via decentralized compute providers. Supports training, inference, image/video gen, and custom workflows.",
    example_request: { model: "stable-diffusion-xl", prompt: "a mountain landscape" },
    example_response: { jobId: "gpu_abc", status: "running", estimatedCompleteAt: "..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/gpu/status/:id", price: "$0.005", why: "Poll job completion status" },
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Describe or refine GPU outputs via chat" },
    ],
  },
  "GET /api/v1/gpu/status/:id": {
    description: "Check status of a GPU job. Returns progress, current logs, and result URLs when complete.",
    example_response: { jobId: "gpu_abc", status: "complete", resultUrl: "https://..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/gpu/run", price: "$0.06", why: "Start another GPU job" },
      { method: "POST", path: "/api/v1/storage/pin", price: "$0.01", why: "Pin GPU results to IPFS for permanence" },
    ],
  },

  // ============================================
  // SEARCH / RAG
  // ============================================
  "POST /api/v1/search/web": {
    description: "Paid web search with agent-optimized structured results. Titles, snippets, URLs, and freshness scores.",
    example_request: { query: "latest x402 protocol updates" },
    example_response: { results: [{ title: "...", url: "...", snippet: "..." }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/search/extract", price: "$0.02", why: "Extract clean content from result URLs" },
      { method: "POST", path: "/api/v1/search/qna", price: "$0.03", why: "Get direct answers instead of links" },
    ],
  },
  "POST /api/v1/search/extract": {
    description: "Extract clean main content from any web URL. Removes ads, nav, sidebars. Returns markdown + metadata.",
    example_request: { url: "https://example.com/article" },
    example_response: { title: "...", markdown: "...", wordCount: 1240 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/search/qna", price: "$0.03", why: "Ask questions about extracted content" },
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Summarize or analyze extracted content" },
    ],
  },
  "POST /api/v1/search/qna": {
    description: "Structured Q&A search — direct answers with citations. Agent-optimized: returns JSON, not prose.",
    example_request: { question: "What is x402 USDC facilitator?" },
    example_response: { answer: "...", citations: [{ url: "...", snippet: "..." }], confidence: 0.92 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/chat/completions", price: "$0.04", why: "Extend Q&A with conversational follow-up" },
      { method: "POST", path: "/api/v1/search/web", price: "$0.02", why: "Broader search if Q&A lacks depth" },
    ],
  },

  // ============================================
  // ROBOTICS / RTP
  // ============================================
  "POST /api/v1/robots/task": {
    description: "Dispatch a paid task to a physical robot via Robot Task Protocol (RTP). Robot accepts task, executes, reports complete.",
    example_request: { capability: "pick-and-place", params: {}, maxPrice: "5.00" },
    example_response: { taskId: "rtp_abc", assignedRobot: "0x...", estimatedCompleteAt: "..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/robots/status", price: "$0.002", why: "Poll task status until complete" },
      { method: "GET", path: "/api/v1/robots/list", price: "$0.005", why: "Discover available robots by capability" },
    ],
  },
  "GET /api/v1/robots/list": {
    description: "Discover available robots by capability, location, or price range. Returns online robots matching filters.",
    example_request: { capability: "pick-and-place" },
    example_response: { robots: [{ id: "0x...", capabilities: ["pick-and-place"], pricePerTask: "3.00" }] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/robots/task", price: "$0.05", why: "Dispatch a task to any discovered robot" },
      { method: "GET", path: "/api/v1/robots/profile", price: "$0.002", why: "Inspect a specific robot's full profile" },
    ],
  },
  "GET /api/v1/robots/status": {
    description: "Check status of a dispatched robot task. Returns progress, current state, and completion proof.",
    example_response: { taskId: "rtp_abc", status: "executing", progress: 0.65 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/robots/task", price: "$0.05", why: "Dispatch another task after completion" },
      { method: "POST", path: "/api/v1/robots/complete", price: "free", why: "Robot-side completion endpoint (for operators)" },
    ],
  },
  "GET /api/v1/robots/profile": {
    description: "Get a robot's full profile — capabilities, price list, location, uptime history, reviews.",
    example_response: { id: "0x...", capabilities: [], uptimePercent: 99.2, completedTasks: 1248 },
    related_endpoints: [
      { method: "GET", path: "/api/v1/robots/list", price: "$0.005", why: "Discover other robots with similar capabilities" },
      { method: "POST", path: "/api/v1/robots/task", price: "$0.05", why: "Dispatch a task to this robot" },
    ],
  },

  // ============================================
  // WALLET
  // ============================================
  "POST /api/v1/wallet/create": {
    description: "Create a new managed wallet. Returns address and wallet ID. Private keys managed by Spraay's custody layer.",
    example_request: { label: "my-agent-wallet" },
    example_response: { walletId: "w_abc", address: "0x..." },
    related_endpoints: [
      { method: "GET", path: "/api/v1/wallet/list", price: "$0.002", why: "View all your managed wallets" },
      { method: "POST", path: "/api/v1/wallet/sign-message", price: "$0.005", why: "Sign messages with the new wallet" },
    ],
  },
  "POST /api/v1/wallet/sign-message": {
    description: "Sign an arbitrary message with a managed wallet. EIP-191 personal_sign.",
    example_request: { walletId: "w_abc", message: "Hello" },
    example_response: { signature: "0x..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/wallet/send-transaction", price: "$0.02", why: "Send a transaction from this wallet" },
      { method: "GET", path: "/api/v1/auth/verify", price: "$0.005", why: "Verify signed SIWE messages" },
    ],
  },
  "POST /api/v1/wallet/send-transaction": {
    description: "Send a transaction from a managed wallet. Handles gas estimation, nonce management, and broadcast.",
    example_request: { walletId: "w_abc", to: "0x...", value: "1000000" },
    example_response: { txHash: "0x...", status: "submitted" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/batch/execute", price: "$0.02", why: "Batch multiple transactions for efficiency" },
      { method: "POST", path: "/api/v1/wallet/sign-message", price: "$0.005", why: "Sign messages without broadcasting" },
    ],
  },

  // ============================================
  // AGENT WALLET (Category 17)
  // ============================================
  "POST /api/v1/agent-wallet/provision": {
    description: "Provision an ERC-4337 agent smart wallet on Base. Counterfactual deployment — address is known before on-chain creation.",
    example_request: { ownerAddress: "0x..." },
    example_response: { walletAddress: "0x...", isDeployed: false },
    related_endpoints: [
      { method: "POST", path: "/api/v1/agent-wallet/session-key", price: "$0.02", why: "Add session keys for agent automation" },
      { method: "GET", path: "/api/v1/agent-wallet/info", price: "$0.005", why: "Check wallet deployment status" },
    ],
  },
  "POST /api/v1/agent-wallet/session-key": {
    description: "Add a scoped session key to an agent wallet. Session keys let agents execute specific actions without full owner access.",
    example_request: { walletAddress: "0x...", sessionKeyAddress: "0x...", scope: { allowedTargets: [] } },
    example_response: { sessionKeyId: "sk_abc", status: "active" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/agent-wallet/revoke-key", price: "$0.02", why: "Revoke session keys when no longer needed" },
      { method: "GET", path: "/api/v1/agent-wallet/info", price: "$0.005", why: "View all active session keys" },
    ],
  },
  "GET /api/v1/agent-wallet/info": {
    description: "Get full info for an agent wallet — deployment status, session keys, owner, balances.",
    example_response: { address: "0x...", isDeployed: true, sessionKeys: [] },
    related_endpoints: [
      { method: "POST", path: "/api/v1/agent-wallet/session-key", price: "$0.02", why: "Add a session key" },
      { method: "GET", path: "/api/v1/agent-wallet/predict", price: "$0.001", why: "Predict address for new wallets" },
    ],
  },
  "POST /api/v1/agent-wallet/revoke-key": {
    description: "Revoke a session key. Takes effect immediately on next transaction.",
    example_request: { walletAddress: "0x...", sessionKeyId: "sk_abc" },
    example_response: { sessionKeyId: "sk_abc", status: "revoked" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/agent-wallet/session-key", price: "$0.02", why: "Add a replacement session key" },
      { method: "GET", path: "/api/v1/agent-wallet/info", price: "$0.005", why: "View remaining active keys" },
    ],
  },
  "GET /api/v1/agent-wallet/predict": {
    description: "Predict the counterfactual address for an agent wallet given an owner. Useful for pre-funding before deployment.",
    example_request: { ownerAddress: "0x...", salt: "0" },
    example_response: { predictedAddress: "0x..." },
    related_endpoints: [
      { method: "POST", path: "/api/v1/agent-wallet/provision", price: "$0.05", why: "Actually provision the wallet" },
      { method: "GET", path: "/api/v1/agent-wallet/info", price: "$0.005", why: "Check wallet info after provisioning" },
    ],
  },

  // ============================================
  // RESOLVE
  // ============================================
  "GET /api/v1/resolve": {
    description: "Resolve ENS names, Basenames, or Farcaster IDs to Ethereum addresses. Bi-directional — address to name also supported.",
    example_request: { name: "vitalik.eth" },
    example_response: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", name: "vitalik.eth" },
    related_endpoints: [
      { method: "GET", path: "/api/v1/balances", price: "$0.005", why: "Get balances for resolved addresses" },
      { method: "GET", path: "/api/v1/analytics/wallet", price: "$0.01", why: "Full wallet profile for resolved addresses" },
    ],
  },

  // ============================================
  // SCTP (Supply Chain Task Protocol)
  // ============================================
  "POST /api/v1/sctp/supplier": {
    description: "Register a supplier in the Supply Chain Task Protocol. Suppliers can receive POs and submit invoices.",
    example_request: { name: "Acme Corp", walletAddress: "0x...", capabilities: ["manufacturing"] },
    example_response: { supplierId: "sup_abc", status: "active" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/sctp/po", price: "$0.02", why: "Create a purchase order for this supplier" },
      { method: "POST", path: "/api/v1/sctp/invoice", price: "$0.02", why: "Submit an invoice against a PO" },
    ],
  },
  "POST /api/v1/sctp/po": {
    description: "Create a purchase order in SCTP. POs lock terms and open the supplier's invoice submission window.",
    example_request: { supplierId: "sup_abc", items: [], total: "10000.00" },
    example_response: { poId: "po_xyz", status: "open" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/sctp/invoice", price: "$0.02", why: "Submit invoice against this PO" },
      { method: "POST", path: "/api/v1/sctp/pay", price: "$0.10", why: "Execute payment once invoice approved" },
    ],
  },
  "POST /api/v1/sctp/invoice": {
    description: "Submit an invoice against an SCTP purchase order. Supports AI-powered verification via /sctp/invoice/verify.",
    example_request: { poId: "po_xyz", amount: "10000.00", items: [] },
    example_response: { invoiceId: "inv_abc", status: "submitted" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/sctp/invoice/verify", price: "$0.03", why: "AI-verify invoice matches PO before payment" },
      { method: "POST", path: "/api/v1/sctp/pay", price: "$0.10", why: "Pay the invoice after verification" },
    ],
  },
  "POST /api/v1/sctp/invoice/verify": {
    description: "AI-powered verification that an invoice matches its purchase order. Checks line items, amounts, and anomalies.",
    example_request: { invoiceId: "inv_abc" },
    example_response: { verified: true, anomalies: [], confidence: 0.96 },
    related_endpoints: [
      { method: "POST", path: "/api/v1/sctp/pay", price: "$0.10", why: "Pay the invoice after verification passes" },
      { method: "POST", path: "/api/v1/inference/explain-contract", price: "$0.03", why: "AI-explain related smart contracts" },
    ],
  },
  "POST /api/v1/sctp/pay": {
    description: "Execute supplier payment via Spraay batch contracts. Supports single invoice or batched payment across multiple suppliers.",
    example_request: { invoiceIds: ["inv_abc"] },
    example_response: { txHash: "0x...", totalPaid: "10000.00" },
    related_endpoints: [
      { method: "POST", path: "/api/v1/batch/execute", price: "$0.02", why: "Raw batch payment without SCTP context" },
      { method: "POST", path: "/api/v1/sctp/invoice", price: "$0.02", why: "Submit another invoice for payment" },
    ],
  },
};

// ============================================
// GATEWAY METADATA HEADER
// Added to every 402 response for agent frameworks that parse headers
// ============================================
const GATEWAY_META = {
  provider: "spraay-x402",
  version: "3.7.0",
  support: "hello@spraay.app",
  status: `${process.env.BASE_URL || "https://gateway.spraay.app"}/health`,
};

// ============================================
// MIDDLEWARE
// ============================================
export function enrich402Middleware(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);

  res.json = function (body: any): Response {
    // Only enrich if this is a 402 response
    if (res.statusCode !== 402) {
      return originalJson(body);
    }

    // Compute the route key as paymentMiddleware uses it
    // paymentMiddleware keys look like "POST /api/v1/chat/completions"
    const routeKey = `${req.method} ${req.baseUrl || ""}${req.path}`.replace(/\/+$/, "");
    const enrichment = ENDPOINT_ENRICHMENT[routeKey];

    // If no enrichment data for this endpoint, pass through untouched
    // (we never want to inject partial/wrong data)
    if (!enrichment) {
      res.set("x-spraay-meta", JSON.stringify(GATEWAY_META));
      return originalJson(body);
    }

    // Enrich the 402 body. Preserve all existing x402 fields (accepts, x402Version, etc).
    // Our additions live under a _spraay namespace PLUS top-level description for maximum
    // visibility (agent frameworks that only surface top-level string fields will see it).
    const enrichedBody = {
      ...body,
      description: enrichment.description,
      _spraay: {
        description: enrichment.description,
        docs_url: DOCS_URL,
        example_request: enrichment.example_request,
        example_response: enrichment.example_response,
        related_endpoints: enrichment.related_endpoints,
        gateway: GATEWAY_META,
      },
    };

    res.set("x-spraay-meta", JSON.stringify(GATEWAY_META));
    return originalJson(enrichedBody);
  };

  next();
}
