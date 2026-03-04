import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

import { aiChatHandler, aiModelsHandler } from "./routes/ai-gateway.js";
import { batchPaymentHandler, batchEstimateHandler } from "./routes/batch-payments.js";
import { swapQuoteHandler, swapTokensHandler } from "./routes/swap-data.js";
import { swapExecuteHandler } from "./routes/swap-execute.js";
import { oraclePricesHandler, oracleGasHandler, oracleFxHandler } from "./routes/oracle.js";
import { bridgeQuoteHandler, bridgeChainsHandler } from "./routes/bridge.js";
import { payrollExecuteHandler, payrollEstimateHandler, payrollTokensHandler } from "./routes/payroll.js";
import { invoiceCreateHandler, invoiceGetHandler, invoiceListHandler } from "./routes/invoice.js";
import { analyticsWalletHandler, analyticsTxHistoryHandler } from "./routes/analytics.js";
import { escrowCreateHandler, escrowGetHandler, escrowFundHandler, escrowReleaseHandler, escrowCancelHandler, escrowListHandler } from "./routes/escrow.js";
import { classifyAddressHandler, classifyTxHandler, explainContractHandler, summarizeHandler } from "./routes/inference.js";
import { pricesHandler } from "./routes/prices.js";
import { balancesHandler } from "./routes/balances.js";
import { resolveHandler } from "./routes/resolve.js";
import { healthHandler, statsHandler } from "./routes/health.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PAY_TO = process.env.PAY_TO_ADDRESS!;
const NETWORK = process.env.X402_NETWORK || "eip155:84532";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "";
const PORT = process.env.PORT || 3402;
const IS_MAINNET = NETWORK === "eip155:8453";
const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";
const CAIP2_NETWORK = NETWORK as `${string}:${string}`;

const facilitatorClient = IS_MAINNET
  ? new HTTPFacilitatorClient(coinbaseFacilitator)
  : new HTTPFacilitatorClient({ url: (FACILITATOR_URL || "https://x402.org/facilitator") as `${string}://${string}` });

const server = new x402ResourceServer(facilitatorClient).register(CAIP2_NETWORK, new ExactEvmScheme());
server.registerExtension(bazaarResourceServerExtension);

app.use(
  paymentMiddleware(
    {
      "POST /api/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI chat completions via 200+ models.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }, inputSchema: { properties: { model: { type: "string" }, messages: { type: "array" } }, required: ["model", "messages"] }, bodyType: "json", output: { example: { choices: [{ message: { content: "Hello!" } }] }, schema: { properties: { choices: { type: "array" } } } } }) },
      },
      "GET /api/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List AI models.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { models: [], count: 200 }, schema: { properties: { models: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Batch payments via Spraay.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", recipients: ["0x..."], amounts: ["1000000"], sender: "0x..." }, inputSchema: { properties: { token: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" }, sender: { type: "string" } }, required: ["token", "recipients", "amounts", "sender"] }, bodyType: "json", output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate batch gas.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { recipientCount: 5 }, inputSchema: { properties: { recipientCount: { type: "number" } }, required: ["recipientCount"] }, bodyType: "json", output: { example: { estimatedGas: "185000" }, schema: { properties: { estimatedGas: { type: "string" } } } } }) },
      },
      "GET /api/v1/swap/quote": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Swap quotes via Uniswap V3.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn"] }, output: { example: { amountOut: "384215000000000" }, schema: { properties: { amountOut: { type: "string" } } } } }) },
      },
      "GET /api/v1/swap/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported swap tokens.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [] }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/swap/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute swap via Uniswap V3.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "100", recipient: "0x..." }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn", "recipient"] }, bodyType: "json", output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/oracle/prices": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-token price feed.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokens: "ETH,cbBTC" }, inputSchema: { properties: { tokens: { type: "string" } } }, output: { example: { prices: {} }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/gas": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Gas prices on Base.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { gas: {} }, schema: { properties: { gas: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/fx": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Stablecoin FX rates.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { base: "USDC" }, inputSchema: { properties: { base: { type: "string" } } }, output: { example: { rates: {} }, schema: { properties: { rates: { type: "object" } } } } }) },
      },
      "GET /api/v1/bridge/quote": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cross-chain bridge quote.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { fromChain: "base", toChain: "ethereum", token: "USDC", amount: "1000000000", fromAddress: "0x..." }, inputSchema: { properties: { fromChain: { type: "string" }, toChain: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, fromAddress: { type: "string" } }, required: ["fromChain", "toChain", "token", "amount", "fromAddress"] }, output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/bridge/chains": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported bridge chains.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { chains: [] }, schema: { properties: { chains: { type: "array" } } } } }) },
      },
      "POST /api/v1/payroll/execute": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute payroll via Spraay V2.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", sender: "0x...", employees: [{ address: "0x...", amount: "3000" }] }, inputSchema: { properties: { token: { type: "string" }, sender: { type: "string" }, employees: { type: "array" } }, required: ["token", "sender", "employees"] }, bodyType: "json", output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/payroll/estimate": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate payroll costs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { employeeCount: 10 }, inputSchema: { properties: { employeeCount: { type: "number" } }, required: ["employeeCount"] }, bodyType: "json", output: { example: { estimate: {} }, schema: { properties: { estimate: { type: "object" } } } } }) },
      },
      "GET /api/v1/payroll/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Payroll stablecoins.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [] }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/invoice/create": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create invoice with payment tx.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { creator: "0x...", token: "USDC", amount: "1500" }, inputSchema: { properties: { creator: { type: "string" }, token: { type: "string" }, amount: { type: "string" } }, required: ["creator", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", invoice: { id: "INV-A1B2" } }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/invoice/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List invoices by address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { invoices: [], count: 0 }, schema: { properties: { invoices: { type: "array" } } } } }) },
      },
      "GET /api/v1/invoice/:id": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Invoice lookup.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "INV-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { invoice: { status: "pending" } }, schema: { properties: { invoice: { type: "object" } } } } }) },
      },
      "GET /api/v1/analytics/wallet": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Wallet profile.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { classification: { walletType: "active" } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "GET /api/v1/analytics/txhistory": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Transaction history.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", limit: "10" }, inputSchema: { properties: { address: { type: "string" }, limit: { type: "string" } }, required: ["address"] }, output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },

      // ---- ESCROW (flat routes) ----
      "POST /api/v1/escrow/create": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create conditional escrow with milestones and expiry.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { depositor: "0xClient", beneficiary: "0xFreelancer", token: "USDC", amount: "5000" }, inputSchema: { properties: { depositor: { type: "string" }, beneficiary: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, arbiter: { type: "string" }, conditions: { type: "array" }, expiresIn: { type: "number" } }, required: ["depositor", "beneficiary", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", escrow: { id: "ESC-A1B2" } }, schema: { properties: { status: { type: "string" }, escrow: { type: "object" } } } } }) },
      },
      "GET /api/v1/escrow/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List escrows by address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" }, status: { type: "string" } }, required: ["address"] }, output: { example: { escrows: [], count: 0 }, schema: { properties: { escrows: { type: "array" } } } } }) },
      },
      "GET /api/v1/escrow/:id": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Escrow status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "ESC-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { escrow: { status: "funded" } }, schema: { properties: { escrow: { type: "object" } } } } }) },
      },
      "POST /api/v1/escrow/fund": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Mark escrow as funded. Pass escrowId in body.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2" }, inputSchema: { properties: { escrowId: { type: "string" } }, required: ["escrowId"] }, bodyType: "json", output: { example: { status: "funded" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/escrow/release": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Release escrow funds. Returns unsigned transfer tx. Depositor or arbiter only.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2", caller: "0xDepositor" }, inputSchema: { properties: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"] }, bodyType: "json", output: { example: { status: "released", transaction: {} }, schema: { properties: { status: { type: "string" }, transaction: { type: "object" } } } } }) },
      },
      "POST /api/v1/escrow/cancel": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cancel escrow.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2", caller: "0xDepositor" }, inputSchema: { properties: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"] }, bodyType: "json", output: { example: { status: "cancelled" }, schema: { properties: { status: { type: "string" } } } } }) },
      },

      // ---- INFERENCE ----
      "POST /api/v1/inference/classify-address": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-powered wallet classification with risk scoring. Analyzes on-chain data to classify addresses as whale, retail, MEV bot, etc.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { classification: { classification: "whale", riskLevel: "low", riskScore: 15 } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/classify-tx": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-powered transaction classification with risk scoring. Decodes and analyzes any Base transaction.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { hash: "0xabc123..." }, inputSchema: { properties: { hash: { type: "string" } }, required: ["hash"] }, bodyType: "json", output: { example: { classification: { type: "swap", riskLevel: "low" } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/explain-contract": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-powered smart contract analysis. Explains what a verified contract does, its functions, and security properties.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { analysis: { type: "erc20-token", riskLevel: "low" } }, schema: { properties: { analysis: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/summarize": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI intelligence briefing for any address or transaction. Returns structured risk assessment and actionable insights.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { target: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", context: "defi" }, inputSchema: { properties: { target: { type: "string" }, context: { type: "string" } }, required: ["target"] }, bodyType: "json", output: { example: { briefing: { headline: "Active DeFi whale", riskAssessment: { level: "low" } } }, schema: { properties: { briefing: { type: "object" } } } } }) },
      },

      // ---- EXISTING ----
      "GET /api/v1/prices": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Live token prices.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "WETH" }, inputSchema: { properties: { token: { type: "string" } } }, output: { example: { prices: {} }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/balances": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Token balances.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { balances: [] }, schema: { properties: { balances: { type: "array" } } } } }) },
      },
      "GET /api/v1/resolve": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "ENS/Basename resolution.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { name: "vitalik.eth" }, inputSchema: { properties: { name: { type: "string" } }, required: ["name"] }, output: { example: { address: "0xd8dA..." }, schema: { properties: { address: { type: "string" } } } } }) },
      },
    },
    server
  )
);

// FREE ROUTES
app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 2, name: "Spraay x402 Gateway",
    description: "AI, payments, swaps, oracle, bridge, payroll, invoicing, escrow, inference, analytics & onchain intelligence.",
    homepage: BASE_URL, repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK, payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.005", category: "ai" },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", category: "ai" },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.01", category: "payments" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", category: "payments" },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.002", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/execute`, method: "POST", price: "$0.01", category: "defi" },
      { resource: `${BASE_URL}/api/v1/oracle/prices`, method: "GET", price: "$0.003", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/gas`, method: "GET", price: "$0.001", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/fx`, method: "GET", price: "$0.002", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/bridge/quote`, method: "GET", price: "$0.005", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/bridge/chains`, method: "GET", price: "$0.001", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/payroll/execute`, method: "POST", price: "$0.02", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/estimate`, method: "POST", price: "$0.002", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/tokens`, method: "GET", price: "$0.001", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/invoice/create`, method: "POST", price: "$0.005", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/invoice/list`, method: "GET", price: "$0.002", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/invoice/:id`, method: "GET", price: "$0.001", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/analytics/wallet`, method: "GET", price: "$0.005", category: "analytics" },
      { resource: `${BASE_URL}/api/v1/analytics/txhistory`, method: "GET", price: "$0.003", category: "analytics" },
      { resource: `${BASE_URL}/api/v1/escrow/create`, method: "POST", price: "$0.008", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/list`, method: "GET", price: "$0.002", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/:id`, method: "GET", price: "$0.001", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/fund`, method: "POST", price: "$0.002", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/release`, method: "POST", price: "$0.005", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/cancel`, method: "POST", price: "$0.002", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/inference/classify-address`, method: "POST", price: "$0.008", category: "inference" },
      { resource: `${BASE_URL}/api/v1/inference/classify-tx`, method: "POST", price: "$0.008", category: "inference" },
      { resource: `${BASE_URL}/api/v1/inference/explain-contract`, method: "POST", price: "$0.01", category: "inference" },
      { resource: `${BASE_URL}/api/v1/inference/summarize`, method: "POST", price: "$0.008", category: "inference" },
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", category: "defi" },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.002", category: "data" },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.001", category: "identity" },
      { resource: `${BASE_URL}/api/v1/tokens`, method: "GET", price: "free", category: "discovery" },
    ],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway", version: "2.9.0",
    description: "Pay-per-use AI, payments, swaps, oracle, bridge, payroll, invoicing, escrow, AI inference, analytics & onchain intelligence. x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    discovery: `${BASE_URL}/.well-known/x402.json`,
    endpoints: {
      free: { "GET /": "Info", "GET /health": "Health", "GET /stats": "Stats", "GET /.well-known/x402.json": "Discovery", "GET /api/v1/tokens": "Tokens" },
      paid: {
        "POST /api/v1/chat/completions": "$0.005 - AI chat",
        "GET /api/v1/models": "$0.001 - AI models",
        "POST /api/v1/batch/execute": "$0.01 - Batch payment",
        "POST /api/v1/batch/estimate": "$0.001 - Batch estimate",
        "GET /api/v1/swap/quote": "$0.002 - Swap quote",
        "GET /api/v1/swap/tokens": "$0.001 - Swap tokens",
        "POST /api/v1/swap/execute": "$0.01 - Execute swap",
        "GET /api/v1/oracle/prices": "$0.003 - Price feed",
        "GET /api/v1/oracle/gas": "$0.001 - Gas prices",
        "GET /api/v1/oracle/fx": "$0.002 - Stablecoin FX",
        "GET /api/v1/bridge/quote": "$0.005 - Bridge quote",
        "GET /api/v1/bridge/chains": "$0.001 - Bridge chains",
        "POST /api/v1/payroll/execute": "$0.02 - Payroll",
        "POST /api/v1/payroll/estimate": "$0.002 - Payroll estimate",
        "GET /api/v1/payroll/tokens": "$0.001 - Payroll tokens",
        "POST /api/v1/invoice/create": "$0.005 - Create invoice",
        "GET /api/v1/invoice/list": "$0.002 - List invoices",
        "GET /api/v1/invoice/:id": "$0.001 - Invoice lookup",
        "GET /api/v1/analytics/wallet": "$0.005 - Wallet profile",
        "GET /api/v1/analytics/txhistory": "$0.003 - Tx history",
        "POST /api/v1/escrow/create": "$0.008 - Create escrow",
        "GET /api/v1/escrow/list": "$0.002 - List escrows",
        "GET /api/v1/escrow/:id": "$0.001 - Escrow status",
        "POST /api/v1/escrow/fund": "$0.002 - Fund escrow",
        "POST /api/v1/escrow/release": "$0.005 - Release escrow",
        "POST /api/v1/escrow/cancel": "$0.002 - Cancel escrow",
        "POST /api/v1/inference/classify-address": "$0.008 - Classify wallet",
        "POST /api/v1/inference/classify-tx": "$0.008 - Classify transaction",
        "POST /api/v1/inference/explain-contract": "$0.01 - Explain contract",
        "POST /api/v1/inference/summarize": "$0.008 - Intelligence briefing",
        "GET /api/v1/prices": "$0.002 - Token prices",
        "GET /api/v1/balances": "$0.002 - Balances",
        "GET /api/v1/resolve": "$0.001 - ENS resolution",
      },
    },
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    network: CAIP2_NETWORK, payTo: PAY_TO, protocol: "x402", mainnet: IS_MAINNET, bazaar: "discoverable",
    totalEndpoints: 33,
  });
});

app.get("/api/v1/tokens", (_req, res) => {
  res.json({
    description: "Spraay supports any ERC-20 token and native ETH on Base",
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC", fee: "0.3%", feeBps: 30, maxRecipients: 200,
    popularTokens: {
      ETH: { native: true, decimals: 18 }, USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 }, DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
      EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 }, WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    },
    chains: { base: { chainId: 8453, contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC", status: "live" }, unichain: { chainId: 130, contract: "0x08fA5D1c16CD6E2a16FC0E4839f262429959E073", status: "live" } },
  });
});

app.get("/health", healthHandler);
app.get("/stats", statsHandler);

// PAID ROUTE HANDLERS
app.post("/api/v1/chat/completions", aiChatHandler);
app.get("/api/v1/models", aiModelsHandler);
app.post("/api/v1/batch/execute", batchPaymentHandler);
app.post("/api/v1/batch/estimate", batchEstimateHandler);
app.get("/api/v1/swap/quote", swapQuoteHandler);
app.get("/api/v1/swap/tokens", swapTokensHandler);
app.post("/api/v1/swap/execute", swapExecuteHandler);
app.get("/api/v1/oracle/prices", oraclePricesHandler);
app.get("/api/v1/oracle/gas", oracleGasHandler);
app.get("/api/v1/oracle/fx", oracleFxHandler);
app.get("/api/v1/bridge/quote", bridgeQuoteHandler);
app.get("/api/v1/bridge/chains", bridgeChainsHandler);
app.post("/api/v1/payroll/execute", payrollExecuteHandler);
app.post("/api/v1/payroll/estimate", payrollEstimateHandler);
app.get("/api/v1/payroll/tokens", payrollTokensHandler);
app.post("/api/v1/invoice/create", invoiceCreateHandler);
app.get("/api/v1/invoice/list", invoiceListHandler);
app.get("/api/v1/invoice/:id", invoiceGetHandler);
app.get("/api/v1/analytics/wallet", analyticsWalletHandler);
app.get("/api/v1/analytics/txhistory", analyticsTxHistoryHandler);
app.post("/api/v1/escrow/create", escrowCreateHandler);
app.get("/api/v1/escrow/list", escrowListHandler);
app.post("/api/v1/escrow/fund", escrowFundHandler);
app.post("/api/v1/escrow/release", escrowReleaseHandler);
app.post("/api/v1/escrow/cancel", escrowCancelHandler);
app.get("/api/v1/escrow/:id", escrowGetHandler);
app.post("/api/v1/inference/classify-address", classifyAddressHandler);
app.post("/api/v1/inference/classify-tx", classifyTxHandler);
app.post("/api/v1/inference/explain-contract", explainContractHandler);
app.post("/api/v1/inference/summarize", summarizeHandler);
app.get("/api/v1/prices", pricesHandler);
app.get("/api/v1/balances", balancesHandler);
app.get("/api/v1/resolve", resolveHandler);

app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v2.9.0 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`\n🌐 33 paid + 5 free endpoints ready\n`);
});

export default app;
