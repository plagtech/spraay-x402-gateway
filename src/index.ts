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
import { bridgeQuoteHandler, bridgeChainsHandler } from "./routes/bridge.js"; // ← NEW
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

      // ---- BATCH PAYMENTS (any ERC-20 + ETH) ----
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute batch payments to multiple recipients in one tx on Base via Spraay. Supports any ERC-20 token + native ETH.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipients: ["0x1234..."], amounts: ["1000000"], sender: "0xYour..." },
            inputSchema: {
              properties: {
                token: { type: "string", description: "ERC-20 token address on Base (any token works) or address(0) for native ETH" },
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
        description: "Estimate gas costs for a batch payment on Base. Works with any ERC-20 token or ETH.",
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

      // ---- SWAP EXECUTE ----
      "POST /api/v1/swap/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute a token swap on Base via Uniswap V3. Returns unsigned transaction data (approval + swap) ready to sign and submit. Auto-selects best fee tier. Supports all major Base tokens.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {
              tokenIn: "USDC",
              tokenOut: "WETH",
              amountIn: "100",
              recipient: "0xYourAddress",
              slippageBps: 50,
            },
            inputSchema: {
              properties: {
                tokenIn: { type: "string", description: "Input token symbol or address (e.g. USDC, WETH, ETH, 0x833...)" },
                tokenOut: { type: "string", description: "Output token symbol or address" },
                amountIn: { type: "string", description: "Human-readable input amount (e.g. '100' for 100 USDC)" },
                recipient: { type: "string", description: "Address to receive output tokens (0x...)" },
                slippageBps: { type: "number", description: "Slippage tolerance in basis points. Default 50 (0.5%). Range: 1-5000." },
              },
              required: ["tokenIn", "tokenOut", "amountIn", "recipient"],
            },
            bodyType: "json",
            output: {
              example: {
                status: "ready",
                quote: {
                  tokenIn: { symbol: "USDC", amount: "100" },
                  tokenOut: { symbol: "WETH", estimatedAmount: "0.02941176", minimumAmount: "0.02926470" },
                  executionPrice: "0.00029412",
                  feeTier: 500,
                  slippageBps: 50,
                },
                transactions: {
                  approval: { to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", data: "0x095ea7b3...", note: "Approve SwapRouter02 to spend USDC" },
                  swap: { to: "0x2626664c2603336E57B271c5C0b26F421741e481", data: "0x414bf389...", chainId: 8453 },
                },
                instructions: ["1. Sign approval tx", "2. Sign swap tx"],
              },
              schema: {
                properties: {
                  status: { type: "string" },
                  quote: { type: "object" },
                  transactions: { type: "object" },
                  execution: { type: "object" },
                  instructions: { type: "array" },
                },
              },
            },
          }),
        },
      },

      // ---- ORACLE ----
      "GET /api/v1/oracle/prices": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-token price feed with category tagging, confidence scores, and on-chain sourcing via Uniswap V3. Supports filtering by token or category (major, stablecoin, memecoin, defi).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { tokens: "ETH,cbBTC,AERO" },
            inputSchema: {
              properties: {
                tokens: { type: "string", description: "Comma-separated token symbols or addresses. Omit for all tokens." },
                category: { type: "string", description: "Filter by category: major, stablecoin, memecoin, defi" },
              },
            },
            output: {
              example: {
                prices: {
                  ETH: { symbol: "ETH", priceUSD: 2650.42, category: "major", confidence: "high" },
                  cbBTC: { symbol: "cbBTC", priceUSD: 97500.15, category: "major", confidence: "high" },
                },
                meta: { tokenCount: 2, source: "uniswap-v3-onchain", chain: "Base" },
              },
              schema: { properties: { prices: { type: "object" }, meta: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/oracle/gas": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Real-time gas prices on Base with cost estimates for common operations (ETH transfer, ERC-20 transfer, swap, batch payment).",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                gas: { gasPrice: { gwei: "0.005" }, baseFee: { gwei: "0.004" } },
                estimates: {
                  ethTransfer: { gasUnits: 21000, costUSD: "$0.0003" },
                  uniswapSwap: { gasUnits: 185000, costUSD: "$0.0025" },
                  spraayBatch50: { gasUnits: 1500000, costUSD: "$0.020" },
                },
                ethPriceUSD: 2650.42,
              },
              schema: { properties: { gas: { type: "object" }, estimates: { type: "object" }, ethPriceUSD: { type: "number" } } },
            },
          }),
        },
      },

      "GET /api/v1/oracle/fx": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Stablecoin FX rates on Base — relative pricing between USDC, USDT, DAI, EURC, USDbC. Detects depegs and shows deviation from parity.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { base: "USDC" },
            inputSchema: {
              properties: {
                base: { type: "string", description: "Base stablecoin to quote against (default: USDC). Options: USDC, USDT, DAI, EURC, USDbC." },
              },
            },
            output: {
              example: {
                base: "USDC",
                rates: {
                  USDT: { rate: 0.9998, deviation: "0.020%", status: "stable" },
                  DAI: { rate: 1.0001, deviation: "0.010%", status: "stable" },
                  EURC: { rate: 0.9250, deviation: "7.500%", status: "depeg-warning", note: "EUR/USD rate" },
                },
                meta: { pairCount: 3, source: "uniswap-v3-onchain" },
              },
              schema: { properties: { base: { type: "string" }, rates: { type: "object" }, meta: { type: "object" } } },
            },
          }),
        },
      },

      // ---- BRIDGE ---- ← NEW
      "GET /api/v1/bridge/quote": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cross-chain bridge quote via LI.FI aggregator. Returns estimated output, fees, timing, and unsigned transaction data. Supports 8 chains including Base, Ethereum, Arbitrum, Polygon, BNB, Avalanche, Optimism, Unichain.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { fromChain: "base", toChain: "ethereum", token: "USDC", amount: "1000000000", fromAddress: "0xYourAddress" },
            inputSchema: {
              properties: {
                fromChain: { type: "string", description: "Source chain: base, ethereum, arbitrum, polygon, bnb, avalanche, optimism, unichain (or chainId)" },
                toChain: { type: "string", description: "Destination chain (same options)" },
                token: { type: "string", description: "Token address, or shortcuts: 'USDC' (auto-resolves), 'native' (ETH/MATIC/etc)" },
                amount: { type: "string", description: "Amount in atomic units (e.g. '1000000000' for 1000 USDC)" },
                fromAddress: { type: "string", description: "Sender address (0x...)" },
              },
              required: ["fromChain", "toChain", "token", "amount", "fromAddress"],
            },
            output: {
              example: {
                status: "ready",
                route: {
                  fromChain: { name: "Base", token: "USDC", amount: "1000000000" },
                  toChain: { name: "Ethereum", token: "USDC", estimatedAmount: "999500000" },
                  bridge: "stargate",
                },
                fees: { gasCostUSD: "0.50", bridgeFeeUSD: "0.25", totalFeeUSD: "0.75" },
                timing: { estimatedMinutes: 5 },
                transaction: { to: "0x...", data: "0x...", chainId: 8453 },
              },
              schema: { properties: { status: { type: "string" }, route: { type: "object" }, fees: { type: "object" }, timing: { type: "object" }, transaction: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/bridge/chains": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List supported bridge chains with Spraay contract addresses and USDC addresses.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                chains: [{ name: "Base", chainId: 8453, hasSpraay: true, usdc: "0x833589..." }],
                chainCount: 8,
              },
              schema: { properties: { chains: { type: "array" }, chainCount: { type: "number" } } },
            },
          }),
        },
      },

      // ---- PRICE FEED ----
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

      // ---- TOKEN BALANCES ----
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

      // ---- NAME RESOLUTION ----
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
    description: "AI models, batch payments, DeFi swaps, oracle data, cross-chain bridge, and onchain intelligence. Pay USDC per request.",
    homepage: BASE_URL,
    repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.005", description: "AI chat (200+ models, OpenAI-compatible)", category: "ai" },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", description: "List AI models", category: "ai" },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.01", description: "Batch payments (any ERC-20 + ETH) via Spraay", category: "payments" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", description: "Estimate batch payment gas", category: "payments" },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.002", description: "Uniswap V3 swap quotes", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", description: "Supported tokens on Base", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/execute`, method: "POST", price: "$0.01", description: "Execute swap (unsigned tx via Uniswap V3)", category: "defi" },
      { resource: `${BASE_URL}/api/v1/oracle/prices`, method: "GET", price: "$0.003", description: "Multi-token price feed with confidence scores", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/gas`, method: "GET", price: "$0.001", description: "Real-time gas prices and cost estimates", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/fx`, method: "GET", price: "$0.002", description: "Stablecoin FX rates and depeg detection", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/bridge/quote`, method: "GET", price: "$0.005", description: "Cross-chain bridge quote with unsigned tx", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/bridge/chains`, method: "GET", price: "$0.001", description: "Supported bridge chains", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", description: "Live onchain token prices", category: "defi" },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.002", description: "Token balances for any address", category: "data" },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.001", description: "ENS/Basename resolution", category: "identity" },
      { resource: `${BASE_URL}/api/v1/tokens`, method: "GET", price: "free", description: "Supported tokens and chains", category: "discovery" },
    ],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway",
    version: "2.4.0",
    description: "Pay-per-use AI, batch payments, DeFi swaps, oracle data, cross-chain bridge & onchain intelligence. Powered by x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    discovery: `${BASE_URL}/.well-known/x402.json`,
    endpoints: {
      free: {
        "GET /": "This info page",
        "GET /health": "Service health check",
        "GET /stats": "Usage statistics",
        "GET /.well-known/x402.json": "Machine-readable service discovery",
        "GET /api/v1/tokens": "Supported tokens and chains",
      },
      paid: {
        "POST /api/v1/chat/completions": "$0.005 - AI chat (200+ models)",
        "GET /api/v1/models": "$0.001 - List AI models",
        "POST /api/v1/batch/execute": "$0.01 - Batch payment (any ERC-20 + ETH)",
        "POST /api/v1/batch/estimate": "$0.001 - Estimate batch cost",
        "GET /api/v1/swap/quote": "$0.002 - Swap quote (Uniswap V3)",
        "GET /api/v1/swap/tokens": "$0.001 - Supported tokens",
        "POST /api/v1/swap/execute": "$0.01 - Execute swap (unsigned tx)",
        "GET /api/v1/oracle/prices": "$0.003 - Multi-token price feed",
        "GET /api/v1/oracle/gas": "$0.001 - Gas prices & cost estimates",
        "GET /api/v1/oracle/fx": "$0.002 - Stablecoin FX rates",
        "GET /api/v1/bridge/quote": "$0.005 - Cross-chain bridge quote",
        "GET /api/v1/bridge/chains": "$0.001 - Supported bridge chains",
        "GET /api/v1/prices": "$0.002 - Live token prices",
        "GET /api/v1/balances": "$0.002 - Token balances",
        "GET /api/v1/resolve": "$0.001 - ENS/Basename resolution",
      },
    },
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    supportedTokens: "Any ERC-20 token + native ETH",
    protocolFee: "0.3%",
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    protocol: "x402",
    mainnet: IS_MAINNET,
    bazaar: "discoverable",
    totalEndpoints: 15,
  });
});

// Free token/chain discovery
app.get("/api/v1/tokens", (_req, res) => {
  res.json({
    description: "Spraay supports any ERC-20 token and native ETH on Base",
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    fee: "0.3%",
    feeBps: 30,
    maxRecipients: 200,
    popularTokens: {
      ETH: { native: true, decimals: 18 },
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
      USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", decimals: 6 },
      DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18 },
      EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", decimals: 6 },
      WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
    },
    note: "Any ERC-20 token on Base works — the list above is for convenience",
    chains: {
      base: { chainId: 8453, contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC", status: "live" },
      unichain: { chainId: 130, contract: "0x08fA5D1c16CD6E2a16FC0E4839f262429959E073", status: "live" },
    },
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
app.get("/api/v1/bridge/quote", bridgeQuoteHandler);   // ← NEW
app.get("/api/v1/bridge/chains", bridgeChainsHandler);  // ← NEW
app.get("/api/v1/prices", pricesHandler);
app.get("/api/v1/balances", balancesHandler);
app.get("/api/v1/resolve", resolveHandler);

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v2.4 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🔗 Facilitator: ${IS_MAINNET ? "Coinbase CDP (mainnet)" : FACILITATOR_URL || "x402.org"}`);
  console.log(`🏪 Bazaar: Discovery extensions on all paid routes`);
  console.log(`📄 Discovery: ${BASE_URL}/.well-known/x402.json`);
  console.log(`📋 Contract: 0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC (V2)`);
  console.log(`🪙 Supports: Any ERC-20 token + native ETH`);
  console.log(`🌉 Bridge: 8 chains via LI.FI aggregator`);
  console.log(`\n🌐 15 paid + 5 free endpoints ready\n`);
});

export default app;
