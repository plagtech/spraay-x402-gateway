import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
} from "@x402/extensions/bazaar";

// Route handlers
import { aiChatHandler, aiModelsHandler } from "./routes/ai-gateway.js";
import { batchPaymentHandler, batchEstimateHandler } from "./routes/batch-payments.js";
import { swapQuoteHandler, swapTokensHandler } from "./routes/swap-data.js";
import { swapExecuteHandler } from "./routes/swap-execute.js";
import { oraclePricesHandler, oracleGasHandler, oracleFxHandler } from "./routes/oracle.js";
import { bridgeQuoteHandler, bridgeChainsHandler } from "./routes/bridge.js";
import { payrollExecuteHandler, payrollEstimateHandler, payrollTokensHandler } from "./routes/payroll.js";
import { invoiceCreateHandler, invoiceGetHandler, invoiceListHandler } from "./routes/invoice.js";
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

// ============================================
// x402 PAYMENT MIDDLEWARE
// ============================================
app.use(
  paymentMiddleware(
    {
      "POST /api/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI chat completions via 200+ models. OpenAI-compatible API.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }, inputSchema: { properties: { model: { type: "string" }, messages: { type: "array" } }, required: ["model", "messages"] }, bodyType: "json", output: { example: { id: "chatcmpl-abc", choices: [{ message: { content: "Hello!" } }] }, schema: { properties: { id: { type: "string" }, choices: { type: "array" } } } } }) },
      },
      "GET /api/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List all available AI models with pricing.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { models: [], count: 200 }, schema: { properties: { models: { type: "array" }, count: { type: "number" } } } } }) },
      },
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Batch payments to multiple recipients via Spraay. Any ERC-20 + ETH.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipients: ["0x..."], amounts: ["1000000"], sender: "0x..." }, inputSchema: { properties: { token: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" }, sender: { type: "string" } }, required: ["token", "recipients", "amounts", "sender"] }, bodyType: "json", output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate gas for batch payment.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { recipientCount: 5 }, inputSchema: { properties: { recipientCount: { type: "number" } }, required: ["recipientCount"] }, bodyType: "json", output: { example: { estimatedGas: "185000" }, schema: { properties: { estimatedGas: { type: "string" } } } } }) },
      },
      "GET /api/v1/swap/quote": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Swap quotes via Uniswap V3 on Base.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn"] }, output: { example: { amountOut: "384215000000000", feeTier: 500 }, schema: { properties: { amountOut: { type: "string" }, feeTier: { type: "number" } } } } }) },
      },
      "GET /api/v1/swap/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported tokens on Base.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [], count: 10 }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/swap/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute swap on Base via Uniswap V3. Returns unsigned tx.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "100", recipient: "0x...", slippageBps: 50 }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" }, slippageBps: { type: "number" } }, required: ["tokenIn", "tokenOut", "amountIn", "recipient"] }, bodyType: "json", output: { example: { status: "ready", transactions: {} }, schema: { properties: { status: { type: "string" }, transactions: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/prices": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-token price feed with confidence scores.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokens: "ETH,cbBTC" }, inputSchema: { properties: { tokens: { type: "string" }, category: { type: "string" } } }, output: { example: { prices: { ETH: { priceUSD: 2650 } } }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/gas": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Real-time gas prices on Base.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { gas: { gasPrice: { gwei: "0.005" } } }, schema: { properties: { gas: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/fx": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Stablecoin FX rates with depeg detection.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { base: "USDC" }, inputSchema: { properties: { base: { type: "string" } } }, output: { example: { base: "USDC", rates: {} }, schema: { properties: { base: { type: "string" }, rates: { type: "object" } } } } }) },
      },
      "GET /api/v1/bridge/quote": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cross-chain bridge quote via LI.FI. 8 chains.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { fromChain: "base", toChain: "ethereum", token: "USDC", amount: "1000000000", fromAddress: "0x..." }, inputSchema: { properties: { fromChain: { type: "string" }, toChain: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, fromAddress: { type: "string" } }, required: ["fromChain", "toChain", "token", "amount", "fromAddress"] }, output: { example: { status: "ready", route: { bridge: "stargate" } }, schema: { properties: { status: { type: "string" }, route: { type: "object" } } } } }) },
      },
      "GET /api/v1/bridge/chains": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported bridge chains with Spraay contracts.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { chains: [], chainCount: 8 }, schema: { properties: { chains: { type: "array" } } } } }) },
      },
      "POST /api/v1/payroll/execute": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute payroll via Spraay V2. Up to 200 employees per batch.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", sender: "0x...", employees: [{ address: "0x...", amount: "3000.00" }] }, inputSchema: { properties: { token: { type: "string" }, sender: { type: "string" }, employees: { type: "array" }, memo: { type: "string" } }, required: ["token", "sender", "employees"] }, bodyType: "json", output: { example: { status: "ready", payroll: { employeeCount: 1 } }, schema: { properties: { status: { type: "string" }, payroll: { type: "object" } } } } }) },
      },
      "POST /api/v1/payroll/estimate": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate payroll gas and fees.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { employeeCount: 10 }, inputSchema: { properties: { employeeCount: { type: "number" } }, required: ["employeeCount"] }, bodyType: "json", output: { example: { estimate: { estimatedGas: 350000 } }, schema: { properties: { estimate: { type: "object" } } } } }) },
      },
      "GET /api/v1/payroll/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported payroll stablecoins.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [], tokenCount: 5 }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },

      // ---- INVOICE ---- ← NEW
      "POST /api/v1/invoice/create": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create an invoice with payment instructions and pre-encoded tx. Supports USDC, USDT, DAI, EURC, WETH. Open or addressed invoices with optional due dates.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { creator: "0xPayee", token: "USDC", amount: "1500.00", memo: "Web dev", dueDate: "2026-04-15" }, inputSchema: { properties: { creator: { type: "string", description: "Payee address" }, recipient: { type: "string", description: "Payer address (optional)" }, token: { type: "string" }, amount: { type: "string" }, memo: { type: "string" }, reference: { type: "string" }, dueDate: { type: "string" } }, required: ["creator", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", invoice: { id: "INV-A1B2C3D4" }, payment: { transaction: {} } }, schema: { properties: { status: { type: "string" }, invoice: { type: "object" }, payment: { type: "object" } } } } }) },
      },
      "GET /api/v1/invoice/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List invoices by creator or recipient address.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xYour", status: "pending" }, inputSchema: { properties: { address: { type: "string" }, status: { type: "string" } }, required: ["address"] }, output: { example: { invoices: [], count: 0 }, schema: { properties: { invoices: { type: "array" }, count: { type: "number" } } } } }) },
      },
      "GET /api/v1/invoice/:id": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Look up invoice by ID with on-chain status check.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "INV-A1B2C3D4" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { invoice: { id: "INV-A1B2C3D4", status: "pending" } }, schema: { properties: { invoice: { type: "object" } } } } }) },
      },

      // ---- EXISTING ----
      "GET /api/v1/prices": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Live onchain token prices via Uniswap V3.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "WETH" }, inputSchema: { properties: { token: { type: "string" } } }, output: { example: { prices: {}, tokenCount: 8 }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/balances": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "ETH + ERC-20 balances for any address on Base.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { balances: [], tokenCount: 1 }, schema: { properties: { balances: { type: "array" } } } } }) },
      },
      "GET /api/v1/resolve": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "ENS and Basename resolution.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { name: "vitalik.eth" }, inputSchema: { properties: { name: { type: "string" } }, required: ["name"] }, output: { example: { address: "0xd8dA...", source: "ens" }, schema: { properties: { address: { type: "string" } } } } }) },
      },
    },
    server
  )
);

// ============================================
// FREE ROUTES
// ============================================
app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 2,
    name: "Spraay x402 Gateway",
    description: "AI, batch payments, swaps, oracle, bridge, payroll, invoicing & onchain intelligence. Pay USDC per request.",
    homepage: BASE_URL, repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK, payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.005", description: "AI chat", category: "ai" },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", description: "AI models", category: "ai" },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.01", description: "Batch payments", category: "payments" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", description: "Batch estimate", category: "payments" },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.002", description: "Swap quotes", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", description: "Swap tokens", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/execute`, method: "POST", price: "$0.01", description: "Execute swap", category: "defi" },
      { resource: `${BASE_URL}/api/v1/oracle/prices`, method: "GET", price: "$0.003", description: "Price feed", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/gas`, method: "GET", price: "$0.001", description: "Gas prices", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/fx`, method: "GET", price: "$0.002", description: "Stablecoin FX", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/bridge/quote`, method: "GET", price: "$0.005", description: "Bridge quote", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/bridge/chains`, method: "GET", price: "$0.001", description: "Bridge chains", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/payroll/execute`, method: "POST", price: "$0.02", description: "Execute payroll", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/estimate`, method: "POST", price: "$0.002", description: "Payroll estimate", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/tokens`, method: "GET", price: "$0.001", description: "Payroll tokens", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/invoice/create`, method: "POST", price: "$0.005", description: "Create invoice", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/invoice/list`, method: "GET", price: "$0.002", description: "List invoices", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/invoice/:id`, method: "GET", price: "$0.001", description: "Invoice lookup", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", description: "Token prices", category: "defi" },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.002", description: "Balances", category: "data" },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.001", description: "ENS resolution", category: "identity" },
      { resource: `${BASE_URL}/api/v1/tokens`, method: "GET", price: "free", description: "Token discovery", category: "discovery" },
    ],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway", version: "2.6.0",
    description: "Pay-per-use AI, batch payments, swaps, oracle, bridge, payroll, invoicing & onchain intelligence. Powered by x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    discovery: `${BASE_URL}/.well-known/x402.json`,
    endpoints: {
      free: { "GET /": "Info", "GET /health": "Health", "GET /stats": "Stats", "GET /.well-known/x402.json": "Discovery", "GET /api/v1/tokens": "Tokens & chains" },
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
        "GET /api/v1/prices": "$0.002 - Token prices",
        "GET /api/v1/balances": "$0.002 - Balances",
        "GET /api/v1/resolve": "$0.001 - ENS resolution",
      },
    },
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    supportedTokens: "Any ERC-20 + ETH", protocolFee: "0.3%",
    network: CAIP2_NETWORK, payTo: PAY_TO, protocol: "x402", mainnet: IS_MAINNET, bazaar: "discoverable",
    totalEndpoints: 21,
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
    network: "eip155:8453",
  });
});

app.get("/health", healthHandler);
app.get("/stats", statsHandler);

// ============================================
// PAID ROUTE HANDLERS
// ============================================
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
app.post("/api/v1/invoice/create", invoiceCreateHandler);   // ← NEW
app.get("/api/v1/invoice/list", invoiceListHandler);         // ← NEW (before :id!)
app.get("/api/v1/invoice/:id", invoiceGetHandler);           // ← NEW
app.get("/api/v1/prices", pricesHandler);
app.get("/api/v1/balances", balancesHandler);
app.get("/api/v1/resolve", resolveHandler);

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v2.6 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🔗 Facilitator: ${IS_MAINNET ? "Coinbase CDP (mainnet)" : FACILITATOR_URL || "x402.org"}`);
  console.log(`🏪 Bazaar: Discovery on all paid routes`);
  console.log(`📄 Discovery: ${BASE_URL}/.well-known/x402.json`);
  console.log(`📋 Contract: 0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC (V2)`);
  console.log(`\n🌐 21 paid + 5 free endpoints ready\n`);
});

export default app;
