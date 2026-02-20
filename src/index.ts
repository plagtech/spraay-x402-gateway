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

// Type assertion for CAIP-2 network identifier
const CAIP2_NETWORK = NETWORK as `${string}:${string}`;

// ============================================
// x402 FACILITATOR SETUP
// ============================================
// Use Coinbase's pre-configured facilitator for mainnet,
// or custom URL for testnet
const facilitatorClient = IS_MAINNET
  ? new HTTPFacilitatorClient(coinbaseFacilitator)
  : new HTTPFacilitatorClient({ url: (FACILITATOR_URL || "https://x402.org/facilitator") as `${string}://${string}` });

const server = new x402ResourceServer(facilitatorClient).register(
  CAIP2_NETWORK,
  new ExactEvmScheme()
);

// Register Bazaar discovery extension
server.registerExtension(bazaarResourceServerExtension);

// ============================================
// x402 PAYMENT MIDDLEWARE - PROTECTED ROUTES
// ============================================
// Each route has its own price and Bazaar discovery metadata.
// Agents discover these via the Bazaar, pay USDC, get the service.
app.use(
  paymentMiddleware(
    {
      // ---- AI MODEL PROXY ----
      "POST /api/v1/chat/completions": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.005",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "AI chat completions via 200+ models (GPT-4, Claude, Llama, Gemini, etc). OpenAI-compatible API.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {
              model: "openai/gpt-4o-mini",
              messages: [{ role: "user", content: "Hello" }],
            },
            inputSchema: {
              properties: {
                model: {
                  type: "string",
                  description:
                    "Model ID from OpenRouter (e.g. openai/gpt-4o-mini, anthropic/claude-3.5-sonnet, meta-llama/llama-3-70b-instruct). Use GET /api/v1/models to list all.",
                },
                messages: {
                  type: "array",
                  description:
                    "Array of message objects with role (system/user/assistant) and content fields. OpenAI-compatible format.",
                  items: {
                    type: "object",
                    properties: {
                      role: { type: "string" },
                      content: { type: "string" },
                    },
                  },
                },
                max_tokens: {
                  type: "number",
                  description: "Maximum tokens to generate (optional, default varies by model)",
                },
                temperature: {
                  type: "number",
                  description: "Sampling temperature 0-2 (optional, default 1)",
                },
              },
              required: ["model", "messages"],
            },
            bodyType: "json",
            output: {
              example: {
                id: "chatcmpl-abc123",
                object: "chat.completion",
                model: "openai/gpt-4o-mini",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Hello! How can I help you today?" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
              },
              schema: {
                properties: {
                  id: { type: "string" },
                  object: { type: "string" },
                  model: { type: "string" },
                  choices: { type: "array" },
                  usage: { type: "object" },
                },
              },
            },
          }),
        },
      },

      "GET /api/v1/models": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description: "List all available AI models with pricing information.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                models: [
                  {
                    id: "openai/gpt-4o-mini",
                    name: "GPT-4o Mini",
                    pricing: { prompt: "0.00015", completion: "0.0006" },
                  },
                  {
                    id: "anthropic/claude-3.5-sonnet",
                    name: "Claude 3.5 Sonnet",
                    pricing: { prompt: "0.003", completion: "0.015" },
                  },
                ],
                count: 200,
              },
              schema: {
                properties: {
                  models: { type: "array" },
                  count: { type: "number" },
                },
              },
            },
          }),
        },
      },

      // ---- BATCH PAYMENTS (Spraay's core value prop) ----
      "POST /api/v1/batch/execute": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Execute batch USDC payments to multiple recipients in a single transaction on Base. Powered by Spraay protocol. Returns encoded calldata for approval + sprayToken transactions.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {
              token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              recipients: [
                "0x1234567890abcdef1234567890abcdef12345678",
                "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
              ],
              amounts: ["1000000", "2000000"],
              sender: "0xYourWalletAddress",
            },
            inputSchema: {
              properties: {
                token: {
                  type: "string",
                  description:
                    "ERC-20 token contract address on Base (e.g. USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)",
                },
                recipients: {
                  type: "array",
                  description: "Array of recipient wallet addresses",
                  items: { type: "string" },
                },
                amounts: {
                  type: "array",
                  description:
                    "Array of amounts in token atomic units (e.g. '1000000' = 1 USDC). Must match recipients array length.",
                  items: { type: "string" },
                },
                sender: {
                  type: "string",
                  description: "Sender wallet address (used for approval tx encoding)",
                },
              },
              required: ["token", "recipients", "amounts", "sender"],
            },
            bodyType: "json",
            output: {
              example: {
                transactions: [
                  {
                    type: "approval",
                    to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                    data: "0x095ea7b3...",
                    description: "Approve Spraay contract to spend 3.0 USDC",
                  },
                  {
                    type: "spray",
                    to: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
                    data: "0x...",
                    description: "Batch transfer to 2 recipients",
                  },
                ],
                summary: {
                  totalAmount: "3000000",
                  recipientCount: 2,
                  protocolFee: "0.3%",
                  estimatedGas: "185000",
                },
              },
              schema: {
                properties: {
                  transactions: { type: "array" },
                  summary: { type: "object" },
                },
              },
            },
          }),
        },
      },

      "POST /api/v1/batch/estimate": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Estimate gas costs for a batch payment before execution. Returns cost breakdown with live Base gas prices.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {
              recipientCount: 5,
              token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            },
            inputSchema: {
              properties: {
                recipientCount: {
                  type: "number",
                  description: "Number of recipients in the batch payment",
                },
                token: {
                  type: "string",
                  description: "ERC-20 token contract address (optional, defaults to USDC)",
                },
              },
              required: ["recipientCount"],
            },
            bodyType: "json",
            output: {
              example: {
                estimatedGas: "185000",
                gasPrice: "0.005 gwei",
                estimatedCostETH: "0.000000925",
                estimatedCostUSD: "$0.0024",
                baseFee: "0.004 gwei",
                priorityFee: "0.001 gwei",
              },
              schema: {
                properties: {
                  estimatedGas: { type: "string" },
                  gasPrice: { type: "string" },
                  estimatedCostETH: { type: "string" },
                  estimatedCostUSD: { type: "string" },
                },
              },
            },
          }),
        },
      },

      // ---- SWAP DATA (MangoSwap intelligence) ----
      "GET /api/v1/swap/quote": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.002",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Get optimal swap quotes routed through Uniswap V3 on Base. Tries all fee tiers (0.05%, 0.3%, 1%) and multi-hop routing through WETH.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: {
              tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              tokenOut: "0x4200000000000000000000000000000000000006",
              amountIn: "1000000",
            },
            inputSchema: {
              properties: {
                tokenIn: {
                  type: "string",
                  description: "Input token contract address on Base",
                },
                tokenOut: {
                  type: "string",
                  description: "Output token contract address on Base",
                },
                amountIn: {
                  type: "string",
                  description: "Amount of input token in atomic units (e.g. '1000000' = 1 USDC)",
                },
              },
              required: ["tokenIn", "tokenOut", "amountIn"],
            },
            output: {
              example: {
                amountOut: "384215000000000",
                path: ["0x833589...USDC", "0x4200...WETH"],
                feeTier: 500,
                priceImpact: "0.02%",
                route: "direct",
              },
              schema: {
                properties: {
                  amountOut: { type: "string" },
                  path: { type: "array" },
                  feeTier: { type: "number" },
                  priceImpact: { type: "string" },
                  route: { type: "string" },
                },
              },
            },
          }),
        },
      },

      "GET /api/v1/swap/tokens": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "List supported tokens on Base with contract addresses, decimals, and symbols.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            output: {
              example: {
                tokens: [
                  {
                    symbol: "USDC",
                    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                    decimals: 6,
                  },
                  {
                    symbol: "WETH",
                    address: "0x4200000000000000000000000000000000000006",
                    decimals: 18,
                  },
                  {
                    symbol: "cbBTC",
                    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
                    decimals: 8,
                  },
                ],
                network: "base",
                count: 10,
              },
              schema: {
                properties: {
                  tokens: { type: "array" },
                  network: { type: "string" },
                  count: { type: "number" },
                },
              },
            },
          }),
        },
      },
    },
    server
  )
);

// ============================================
// FREE ROUTES (no payment required)
// ============================================
app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway",
    version: "1.0.0",
    description:
      "Pay-per-use AI models, batch payments, and DeFi data on Base. Powered by x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    endpoints: {
      free: {
        "GET /": "This info page",
        "GET /health": "Service health check",
        "GET /stats": "Usage statistics",
      },
      paid: {
        "POST /api/v1/chat/completions": "$0.005 - AI chat (OpenAI-compatible)",
        "GET /api/v1/models": "$0.001 - List AI models",
        "POST /api/v1/batch/execute": "$0.01 - Execute batch payment via Spraay",
        "POST /api/v1/batch/estimate": "$0.001 - Estimate batch payment cost",
        "GET /api/v1/swap/quote": "$0.002 - Get swap quote via MangoSwap routing",
        "GET /api/v1/swap/tokens": "$0.001 - List supported tokens",
      },
    },
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    protocol: "x402",
    mainnet: IS_MAINNET,
    bazaar: "discoverable",
  });
});

app.get("/health", healthHandler);
app.get("/stats", statsHandler);

// ============================================
// PAID ROUTE HANDLERS
// ============================================
// These only execute AFTER x402 payment is verified

// AI Gateway
app.post("/api/v1/chat/completions", aiChatHandler);
app.get("/api/v1/models", aiModelsHandler);

// Batch Payments (Spraay)
app.post("/api/v1/batch/execute", batchPaymentHandler);
app.post("/api/v1/batch/estimate", batchEstimateHandler);

// Swap Data (MangoSwap)
app.get("/api/v1/swap/quote", swapQuoteHandler);
app.get("/api/v1/swap/tokens", swapTokensHandler);

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🔗 Facilitator: ${IS_MAINNET ? "Coinbase CDP (mainnet)" : FACILITATOR_URL || "x402.org"}`);
  console.log(`🏪 Bazaar: Discovery extensions enabled for all paid routes`);
  console.log(`\n🌐 Endpoints ready for agent discovery via x402 Bazaar\n`);
});

export default app;
