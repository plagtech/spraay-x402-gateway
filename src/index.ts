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
import { payrollExecuteHandler, payrollEstimateHandler, payrollTokensHandler } from "./routes/payroll.js"; // ← NEW
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
                model: { type: "string", description: "Model ID from OpenRouter" },
                messages: { type: "array", description: "OpenAI-compatible messages", items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } } } },
                max_tokens: { type: "number", description: "Max tokens (optional)" },
                temperature: { type: "number", description: "Temperature 0-2 (optional)" },
              },
              required: ["model", "messages"],
            },
            bodyType: "json",
            output: {
              example: { id: "chatcmpl-abc123", choices: [{ message: { role: "assistant", content: "Hello!" } }] },
              schema: { properties: { id: { type: "string" }, choices: { type: "array" }, usage: { type: "object" } } },
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
              example: { models: [{ id: "openai/gpt-4o-mini", name: "GPT-4o Mini" }], count: 200 },
              schema: { properties: { models: { type: "array" }, count: { type: "number" } } },
            },
          }),
        },
      },

      // ---- BATCH PAYMENTS ----
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute batch payments to multiple recipients in one tx on Base via Spraay. Any ERC-20 + ETH.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", recipients: ["0x1234..."], amounts: ["1000000"], sender: "0xYour..." },
            inputSchema: {
              properties: {
                token: { type: "string", description: "ERC-20 token address or address(0) for ETH" },
                recipients: { type: "array", items: { type: "string" } },
                amounts: { type: "array", items: { type: "string" } },
                sender: { type: "string" },
              },
              required: ["token", "recipients", "amounts", "sender"],
            },
            bodyType: "json",
            output: {
              example: { transactions: [{ type: "approval" }, { type: "spray" }], summary: { recipientCount: 2 } },
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
              properties: { recipientCount: { type: "number" }, token: { type: "string" } },
              required: ["recipientCount"],
            },
            bodyType: "json",
            output: {
              example: { estimatedGas: "185000", estimatedCostUSD: "$0.0024" },
              schema: { properties: { estimatedGas: { type: "string" }, estimatedCostUSD: { type: "string" } } },
            },
          }),
        },
      },

      // ---- SWAP ----
      "GET /api/v1/swap/quote": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get optimal swap quotes via Uniswap V3 on Base.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x4200000000000000000000000000000000000006", amountIn: "1000000" },
            inputSchema: {
              properties: {
                tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" },
              },
              required: ["tokenIn", "tokenOut", "amountIn"],
            },
            output: {
              example: { amountOut: "384215000000000", feeTier: 500, route: "direct" },
              schema: { properties: { amountOut: { type: "string" }, feeTier: { type: "number" } } },
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
              example: { tokens: [{ symbol: "USDC", address: "0x833589...", decimals: 6 }], count: 10 },
              schema: { properties: { tokens: { type: "array" }, count: { type: "number" } } },
            },
          }),
        },
      },

      "POST /api/v1/swap/execute": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute a token swap on Base via Uniswap V3. Returns unsigned tx data.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "100", recipient: "0xYour", slippageBps: 50 },
            inputSchema: {
              properties: {
                tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" },
                recipient: { type: "string" }, slippageBps: { type: "number" },
              },
              required: ["tokenIn", "tokenOut", "amountIn", "recipient"],
            },
            bodyType: "json",
            output: {
              example: { status: "ready", transactions: { approval: {}, swap: {} } },
              schema: { properties: { status: { type: "string" }, quote: { type: "object" }, transactions: { type: "object" } } },
            },
          }),
        },
      },

      // ---- ORACLE ----
      "GET /api/v1/oracle/prices": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-token price feed with confidence scores via Uniswap V3.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { tokens: "ETH,cbBTC" },
            inputSchema: { properties: { tokens: { type: "string" }, category: { type: "string" } } },
            output: {
              example: { prices: { ETH: { priceUSD: 2650.42, confidence: "high" } }, meta: { tokenCount: 1 } },
              schema: { properties: { prices: { type: "object" }, meta: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/oracle/gas": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Real-time gas prices on Base with cost estimates.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: { gas: { gasPrice: { gwei: "0.005" } }, estimates: { ethTransfer: { costUSD: "$0.0003" } } },
              schema: { properties: { gas: { type: "object" }, estimates: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/oracle/fx": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Stablecoin FX rates with depeg detection.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { base: "USDC" },
            inputSchema: { properties: { base: { type: "string" } } },
            output: {
              example: { base: "USDC", rates: { USDT: { rate: 0.9998, status: "stable" } } },
              schema: { properties: { base: { type: "string" }, rates: { type: "object" } } },
            },
          }),
        },
      },

      // ---- BRIDGE ----
      "GET /api/v1/bridge/quote": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cross-chain bridge quote via LI.FI. 8 chains supported.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { fromChain: "base", toChain: "ethereum", token: "USDC", amount: "1000000000", fromAddress: "0xYour" },
            inputSchema: {
              properties: {
                fromChain: { type: "string" }, toChain: { type: "string" }, token: { type: "string" },
                amount: { type: "string" }, fromAddress: { type: "string" },
              },
              required: ["fromChain", "toChain", "token", "amount", "fromAddress"],
            },
            output: {
              example: { status: "ready", route: { bridge: "stargate" }, fees: { totalFeeUSD: "0.75" }, timing: { estimatedMinutes: 5 } },
              schema: { properties: { status: { type: "string" }, route: { type: "object" }, fees: { type: "object" }, transaction: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/bridge/chains": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List supported bridge chains with Spraay contracts.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: { chains: [{ name: "Base", chainId: 8453, hasSpraay: true }], chainCount: 8 },
              schema: { properties: { chains: { type: "array" }, chainCount: { type: "number" } } },
            },
          }),
        },
      },

      // ---- PAYROLL ---- ← NEW
      "POST /api/v1/payroll/execute": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute a payroll run via Spraay V2 batch payments. Submit employee list with amounts, get unsigned transactions. Supports USDC, USDT, DAI, EURC. Up to 200 employees per batch. Includes balance check and fee breakdown.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {
              token: "USDC",
              sender: "0xEmployer",
              employees: [
                { address: "0xAlice", amount: "3000.00", label: "March salary" },
                { address: "0xBob", amount: "2500.00", label: "March salary" },
              ],
              memo: "March 2026 payroll",
            },
            inputSchema: {
              properties: {
                token: { type: "string", description: "Stablecoin: USDC, USDT, DAI, EURC (or address)" },
                sender: { type: "string", description: "Employer wallet address" },
                employees: {
                  type: "array",
                  description: "Array of { address, amount, label? }",
                  items: {
                    type: "object",
                    properties: {
                      address: { type: "string", description: "Employee wallet" },
                      amount: { type: "string", description: "Payment amount (human-readable, e.g. '3000.00')" },
                      label: { type: "string", description: "Optional label (e.g. 'March salary')" },
                    },
                  },
                },
                memo: { type: "string", description: "Optional payroll reference" },
              },
              required: ["token", "sender", "employees"],
            },
            bodyType: "json",
            output: {
              example: {
                status: "ready",
                payroll: { employeeCount: 2, totalAmount: "5500.00", protocolFee: "16.50", totalWithFee: "5516.50" },
                transactions: { approval: { to: "0x833589..." }, payroll: { to: "0x164645..." } },
                balanceCheck: { sufficient: true },
              },
              schema: { properties: { status: { type: "string" }, payroll: { type: "object" }, transactions: { type: "object" }, balanceCheck: { type: "object" } } },
            },
          }),
        },
      },

      "POST /api/v1/payroll/estimate": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate gas and protocol fees for a payroll run.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { employeeCount: 10, token: "USDC", totalAmount: "25000" },
            inputSchema: {
              properties: {
                employeeCount: { type: "number", description: "Number of employees" },
                token: { type: "string", description: "Optional: token symbol for fee calc" },
                totalAmount: { type: "string", description: "Optional: total for fee calc" },
              },
              required: ["employeeCount"],
            },
            bodyType: "json",
            output: {
              example: { estimate: { employeeCount: 10, estimatedGas: 350000 }, feeBreakdown: { protocolFee: "75.00" } },
              schema: { properties: { estimate: { type: "object" }, feeBreakdown: { type: "object" } } },
            },
          }),
        },
      },

      "GET /api/v1/payroll/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List supported stablecoins for payroll.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: { tokens: [{ symbol: "USDC", recommended: true }], tokenCount: 5 },
              schema: { properties: { tokens: { type: "array" }, tokenCount: { type: "number" } } },
            },
          }),
        },
      },

      // ---- PRICE FEED ----
      "GET /api/v1/prices": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Live onchain token prices in USD via Uniswap V3 on Base.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { token: "WETH" },
            inputSchema: { properties: { token: { type: "string" } } },
            output: {
              example: { prices: { WETH: { priceUSD: 2650.42 } }, tokenCount: 8 },
              schema: { properties: { prices: { type: "object" }, tokenCount: { type: "number" } } },
            },
          }),
        },
      },

      // ---- BALANCES ----
      "GET /api/v1/balances": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get ETH + ERC-20 balances for any address on Base.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
            inputSchema: {
              properties: { address: { type: "string" }, tokens: { type: "string" }, showAll: { type: "string" } },
              required: ["address"],
            },
            output: {
              example: { address: "0xd8dA...", balances: [{ symbol: "ETH", balance: "1.5" }], tokenCount: 1 },
              schema: { properties: { address: { type: "string" }, balances: { type: "array" } } },
            },
          }),
        },
      },

      // ---- NAME RESOLUTION ----
      "GET /api/v1/resolve": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Resolve ENS (.eth) and Basenames (.base.eth) to addresses.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { name: "vitalik.eth" },
            inputSchema: { properties: { name: { type: "string" } }, required: ["name"] },
            output: {
              example: { input: "vitalik.eth", address: "0xd8dA...", source: "ens" },
              schema: { properties: { input: { type: "string" }, address: { type: "string" } } },
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

app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 2,
    name: "Spraay x402 Gateway",
    description: "AI models, batch payments, DeFi swaps, oracle, bridge, payroll & onchain intelligence. Pay USDC per request.",
    homepage: BASE_URL,
    repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.005", description: "AI chat (200+ models)", category: "ai" },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", description: "List AI models", category: "ai" },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.01", description: "Batch payments via Spraay", category: "payments" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", description: "Estimate batch gas", category: "payments" },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.002", description: "Swap quotes (Uniswap V3)", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", description: "Supported tokens", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/execute`, method: "POST", price: "$0.01", description: "Execute swap (unsigned tx)", category: "defi" },
      { resource: `${BASE_URL}/api/v1/oracle/prices`, method: "GET", price: "$0.003", description: "Price feed with confidence", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/gas`, method: "GET", price: "$0.001", description: "Gas prices & estimates", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/fx`, method: "GET", price: "$0.002", description: "Stablecoin FX rates", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/bridge/quote`, method: "GET", price: "$0.005", description: "Cross-chain bridge quote", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/bridge/chains`, method: "GET", price: "$0.001", description: "Supported bridge chains", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/payroll/execute`, method: "POST", price: "$0.02", description: "Execute payroll via Spraay", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/estimate`, method: "POST", price: "$0.002", description: "Estimate payroll costs", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/tokens`, method: "GET", price: "$0.001", description: "Payroll stablecoins", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", description: "Live token prices", category: "defi" },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.002", description: "Token balances", category: "data" },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.001", description: "ENS/Basename resolution", category: "identity" },
      { resource: `${BASE_URL}/api/v1/tokens`, method: "GET", price: "free", description: "Supported tokens and chains", category: "discovery" },
    ],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway",
    version: "2.5.0",
    description: "Pay-per-use AI, batch payments, DeFi swaps, oracle, cross-chain bridge, payroll & onchain intelligence. Powered by x402 + USDC.",
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
        "POST /api/v1/batch/execute": "$0.01 - Batch payment",
        "POST /api/v1/batch/estimate": "$0.001 - Estimate batch cost",
        "GET /api/v1/swap/quote": "$0.002 - Swap quote",
        "GET /api/v1/swap/tokens": "$0.001 - Supported tokens",
        "POST /api/v1/swap/execute": "$0.01 - Execute swap",
        "GET /api/v1/oracle/prices": "$0.003 - Price feed",
        "GET /api/v1/oracle/gas": "$0.001 - Gas prices",
        "GET /api/v1/oracle/fx": "$0.002 - Stablecoin FX",
        "GET /api/v1/bridge/quote": "$0.005 - Bridge quote",
        "GET /api/v1/bridge/chains": "$0.001 - Bridge chains",
        "POST /api/v1/payroll/execute": "$0.02 - Execute payroll",
        "POST /api/v1/payroll/estimate": "$0.002 - Estimate payroll",
        "GET /api/v1/payroll/tokens": "$0.001 - Payroll stablecoins",
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
    totalEndpoints: 18,
  });
});

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
    note: "Any ERC-20 token on Base works",
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
app.get("/api/v1/bridge/quote", bridgeQuoteHandler);
app.get("/api/v1/bridge/chains", bridgeChainsHandler);
app.post("/api/v1/payroll/execute", payrollExecuteHandler);   // ← NEW
app.post("/api/v1/payroll/estimate", payrollEstimateHandler); // ← NEW
app.get("/api/v1/payroll/tokens", payrollTokensHandler);      // ← NEW
app.get("/api/v1/prices", pricesHandler);
app.get("/api/v1/balances", balancesHandler);
app.get("/api/v1/resolve", resolveHandler);

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v2.5 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🔗 Facilitator: ${IS_MAINNET ? "Coinbase CDP (mainnet)" : FACILITATOR_URL || "x402.org"}`);
  console.log(`🏪 Bazaar: Discovery extensions on all paid routes`);
  console.log(`📄 Discovery: ${BASE_URL}/.well-known/x402.json`);
  console.log(`📋 Contract: 0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC (V2)`);
  console.log(`🪙 Supports: Any ERC-20 token + native ETH`);
  console.log(`🌉 Bridge: 8 chains via LI.FI`);
  console.log(`💼 Payroll: StablePay via Spraay V2`);
  console.log(`\n🌐 18 paid + 5 free endpoints ready\n`);
});

export default app;
