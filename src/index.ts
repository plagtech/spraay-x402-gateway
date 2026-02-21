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
import { pricesHandler } from "./routes/prices.js";
import { balancesHandler } from "./routes/balances.js";
import { resolveHandler } from "./routes/resolve.js";
import { healthHandler, statsHandler } from "./routes/health.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// CONFIGURATION
// ============================================
const PAY_TO = process.env.PAY_TO_ADDRESS!;
const NETWORK = process.env.X402_NETWORK || "eip155:84532";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "";
const PORT = process.env.PORT || 3402;
const IS_MAINNET = NETWORK === "eip155:8453";
const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";

const CAIP2_NETWORK = NETWORK as `${string}:${string}`;

// ============================================
// x402 FACILITATOR SETUP
// ============================================
const facilitatorClient = IS_MAINNET
  ? new HTTPFacilitatorClient(coinbaseFacilitator)
  : new HTTPFacilitatorClient({ url: (FACILITATOR_URL || "https://x402.org/facilitator") as `${string}://${string}` });

const server = new x402ResourceServer(facilitatorClient).register(
  CAIP2_NETWORK,
  new ExactEvmScheme()
);

server.registerExtension(bazaarResourceServerExtension);

// ============================================
// x402 PAYMENT MIDDLEWARE - ALL PAID ROUTES
// ============================================
app.use(
  paymentMiddleware(
    {
      // ---- AI MODEL PROXY ----
      "POST /api/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI chat completions via 200+ models (GPT-4, Claude, Llama, Gemini, etc). OpenAI-compatible API.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] },
            inputSchema: {
              properties: {
                model: { type: "string", description: "Model ID from OpenRouter (e.g. openai/gpt-4o-mini, anthropic/claude-3.5-sonnet). Use GET /api/v1/models to list all." },
                messages: { type: "array", description: "Array of message objects with role and content. OpenAI-compatible.", items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } } },
                max_tokens: { type: "number", description: "Max tokens to generate (optional)" },
                temperature: { type: "number", description: "Sampling temperature 0-2 (optional)" },
              },
              required: ["model", "messages"],
            },
            bodyType: "json",
            output: {
              example: { id: "chatcmpl-abc123", object: "chat.completion", model: "openai/gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "Hello! How can I help?" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 } },
              schema: { properties: { id: { type: "string" }, object: { type: "string" }, model: { type: "string" }, choices: { type: "array" }, usage: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List all available AI models with pricing.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: { models: [{ id: "openai/gpt-4o-mini", name: "GPT-4o Mini", pricing: { prompt: "0.00015", completion: "0.0006" } }], count: 200 },
              schema: { properties: { models: { type: "array" }, count: { type: "number" } } },
            },
          }),
        },
      },

      // ---- BATCH PAYMENTS ----
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute batch USDC payments to multiple recipients in one tx on Base via Spraay protocol.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipients: ["0x1234..."], amounts: ["1000000"], sender: "0xYour..." },
            inputSchema: {
              properties: {
                token: { type: "string", description: "ERC-20 token address on Base (e.g. USDC)" },
                recipients: { type: "array", description: "Recipient addresses", items: { type: "string" } },
                amounts: { type: "array", description: "Amounts in atomic units", items: { type: "string" } },
                sender: { type: "string", description: "Sender address for approval encoding" },
              },
              required: ["token", "recipients", "amounts", "sender"],
            },
            bodyType: "json",
            output: {
              example: { transactions: [{ type: "approval", to: "0x833589...", data: "0x..." }, { type: "spray", to: "0x1646452F...", data: "0x..." }], summary: { totalAmount: "3000000", recipientCount: 2 } },
              schema: { properties: { transactions: { type: "array" }, summary: { type: "object" } } },
            },
          }),
        },
      },

      "POST /api/v1/batch/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate gas costs for a batch payment on Base.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { recipientCount: 5 },
            inputSchema: {
              properties: {
                recipientCount: { type: "number", description: "Number of recipients" },
                token: { type: "string", description: "Token address (optional, defaults to USDC)" },
              },
              required: ["recipientCount"],
            },
            bodyType: "json",
            output: {
              example: { estimatedGas: "185000", gasPrice: "0.005 gwei", estimatedCostETH: "0.000000925", estimatedCostUSD: "$0.0024" },
              schema: { properties: { estimatedGas: { type: "string" }, estimatedCostETH: { type: "string" }, estimatedCostUSD: { type: "string" } } },
            },
          }),
        },
      },

      // ---- SWAP DATA ----
      "GET /api/v1/swap/quote": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get optimal swap quotes via Uniswap V3 on Base. Tries all fee tiers + multi-hop through WETH.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x4200000000000000000000000000000000000006", amountIn: "1000000" },
            inputSchema: {
              properties: {
                tokenIn: { type: "string", description: "Input token address on Base" },
                tokenOut: { type: "string", description: "Output token address on Base" },
                amountIn: { type: "string", description: "Input amount in atomic units" },
              },
              required: ["tokenIn", "tokenOut", "amountIn"],
            },
            output: {
              example: { amountOut: "384215000000000", path: ["USDC", "WETH"], feeTier: 500, route: "direct" },
              schema: { properties: { amountOut: { type: "string" }, path: { type: "array" }, feeTier: { type: "number" }, route: { type: "string" } } },
            },
          }),
        },
      },

      "GET /api/v1/swap/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List supported tokens on Base with addresses and decimals.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: { tokens: [{ symbol: "USDC", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 }], count: 10 },
              schema: { properties: { tokens: { type: "array" }, count: { type: "number" } } },
            },
          }),
        },
      },

      // ---- NEW: PRICE FEED ----
      "GET /api/v1/prices": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Live onchain token prices in USD via Uniswap V3 on Base. 8+ tokens. Optional ?token=WETH for single token.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { token: "WETH" },
            inputSchema: {
              properties: {
                token: { type: "string", description: "Optional: token symbol (WETH, cbBTC, AERO, etc). Omit for all." },
              },
            },
            output: {
              example: {
                prices: { WETH: { symbol: "WETH", address: "0x4200000000000000000000000000000000000006", priceUSD: 2650.42 }, cbBTC: { symbol: "cbBTC", priceUSD: 97500.15 } },
                network: "base", source: "uniswap-v3-onchain", tokenCount: 8,
              },
              schema: { properties: { prices: { type: "object" }, network: { type: "string" }, tokenCount: { type: "number" } } },
            },
          }),
        },
      },

      // ---- NEW: TOKEN BALANCES ----
      "GET /api/v1/balances": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get ETH + ERC-20 balances for any address on Base. 8+ popular tokens or custom list.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
            inputSchema: {
              properties: {
                address: { type: "string", description: "Wallet address to check" },
                tokens: { type: "string", description: "Optional: comma-separated token addresses" },
                showAll: { type: "string", description: "Optional: 'true' to include zero balances" },
              },
              required: ["address"],
            },
            output: {
              example: {
                address: "0xd8dA...", balances: [{ symbol: "ETH", balance: "1.5" }, { symbol: "USDC", balance: "500.0" }], tokenCount: 2,
              },
              schema: { properties: { address: { type: "string" }, balances: { type: "array" }, tokenCount: { type: "number" } } },
            },
          }),
        },
      },

      // ---- NEW: NAME RESOLUTION ----
      "GET /api/v1/resolve": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Resolve ENS (.eth) and Basenames (.base.eth) to addresses. Reverse lookup supported.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { name: "vitalik.eth" },
            inputSchema: {
              properties: {
                name: { type: "string", description: "ENS name, Basename, or address for reverse lookup" },
              },
              required: ["name"],
            },
            output: {
              example: { input: "vitalik.eth", address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", source: "ens" },
              schema: { properties: { input: { type: "string" }, address: { type: "string" }, source: { type: "string" } } },
            },
          }),
        },
      },
    },
    server
  )
);

// ============================================
// FREE ROUTES
// ============================================

// .well-known/x402.json — auto-discovery for crawlers and agents
app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 2,
    name: "Spraay x402 Gateway",
    description: "AI models, batch payments, DeFi data, and onchain intelligence on Base. Pay USDC per request.",
    homepage: BASE_URL,
    repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.005", description: "AI chat (200+ models, OpenAI-compatible)", category: "ai" },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", description: "List AI models", category: "ai" },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.01", description: "Batch USDC payments via Spraay", category: "payments" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", description: "Estimate batch payment gas", category: "payments" },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.002", description: "Uniswap V3 swap quotes", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", description: "Supported tokens on Base", category: "defi" },
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", description: "Live onchain token prices", category: "defi" },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.002", description: "Token balances for any address", category: "data" },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.001", description: "ENS/Basename resolution", category: "identity" },
    ],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway",
    version: "2.0.0",
    description: "Pay-per-use AI, payments, DeFi data & onchain intelligence on Base. Powered by x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    discovery: `${BASE_URL}/.well-known/x402.json`,
    endpoints: {
      free: {
        "GET /": "This info page",
        "GET /health": "Service health check",
        "GET /stats": "Usage statistics",
        "GET /.well-known/x402.json": "Machine-readable service discovery",
      },
      paid: {
        "POST /api/v1/chat/completions": "$0.005 - AI chat (200+ models)",
        "GET /api/v1/models": "$0.001 - List AI models",
        "POST /api/v1/batch/execute": "$0.01 - Batch payment via Spraay",
        "POST /api/v1/batch/estimate": "$0.001 - Estimate batch cost",
        "GET /api/v1/swap/quote": "$0.002 - Swap quote (Uniswap V3)",
        "GET /api/v1/swap/tokens": "$0.001 - Supported tokens",
        "GET /api/v1/prices": "$0.002 - Live token prices",
        "GET /api/v1/balances": "$0.002 - Token balances",
        "GET /api/v1/resolve": "$0.001 - ENS/Basename resolution",
      },
    },
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    protocol: "x402",
    mainnet: IS_MAINNET,
    bazaar: "discoverable",
    totalEndpoints: 9,
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
app.get("/api/v1/prices", pricesHandler);
app.get("/api/v1/balances", balancesHandler);
app.get("/api/v1/resolve", resolveHandler);

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v2.0 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🔗 Facilitator: ${IS_MAINNET ? "Coinbase CDP (mainnet)" : FACILITATOR_URL || "x402.org"}`);
  console.log(`🏪 Bazaar: Discovery extensions on all 9 paid routes`);
  console.log(`📄 Discovery: ${BASE_URL}/.well-known/x402.json`);
  console.log(`\n🌐 9 paid endpoints ready for agent discovery\n`);
});

export default app;
