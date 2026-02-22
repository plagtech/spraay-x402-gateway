import express from "express";
import { wrapExpress } from "@anthropic-ai/x402-express";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";

// Route handlers — V2 (existing)
import { aiChatHandler, aiModelsHandler } from "./routes/ai-gateway.js";
import {
  batchPaymentHandler,
  batchEstimateHandler,
  batchPaymentV3Handler,
  batchEstimateV3Handler,
  tokensHandler,
  chainsHandler,
} from "./routes/batch-payments.js";
import { swapQuoteHandler, swapTokensHandler } from "./routes/swap-data.js";
import { healthHandler, statsHandler } from "./routes/health.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3402;
const PAY_TO =
  process.env.PAY_TO_ADDRESS ||
  "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8";
const NETWORK = process.env.X402_NETWORK || "eip155:84532";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL;

const IS_MAINNET = NETWORK === "eip155:8453";
const CAIP2_NETWORK = NETWORK;

// Select facilitator
const facilitatorConfig = IS_MAINNET
  ? coinbaseFacilitator
  : FACILITATOR_URL || "https://www.x402.org/facilitator";

// ============================================
// x402 PAYMENT MIDDLEWARE
// ============================================
const server = wrapExpress(
  app,
  Object.assign(
    {},
    // ---- V2 ENDPOINTS (existing, unchanged) ----
    {
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
          "AI chat completions via OpenRouter (200+ models). OpenAI-compatible format.",
        mimeType: "application/json",
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
        description: "List available AI models with pricing and capabilities.",
        mimeType: "application/json",
      },

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
          "Execute a batch USDC payment via Spraay V2 on Base. Returns encoded calldata.",
        mimeType: "application/json",
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
          "Estimate batch payment cost including Spraay 0.3% fee (V2, USDC only).",
        mimeType: "application/json",
      },

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
          "Get optimal swap quotes routed through Uniswap V3 and Aerodrome on Base.",
        mimeType: "application/json",
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
          "List supported tokens on Base with current prices and pool addresses.",
        mimeType: "application/json",
      },
    },

    // ---- V3 ENDPOINTS (new — multi-stablecoin) ----
    {
      "POST /api/v3/batch/execute": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Multi-stablecoin batch payment via Spraay V3 on Base. Supports USDC, USDT, EURC, DAI. Optional memo and ERC-8004 agentId.",
        mimeType: "application/json",
      },

      "POST /api/v3/batch/estimate": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.001",
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Estimate multi-stablecoin batch cost with per-token fee tiers (EURC 0.25%, others 0.3%).",
        mimeType: "application/json",
      },
    }
  ),
  facilitatorConfig
);

// ============================================
// FREE ROUTES (no payment required)
// ============================================
app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway",
    version: "2.0.0",
    description:
      "Pay-per-use AI models, multi-stablecoin batch payments, and DeFi data on Base. Powered by x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    endpoints: {
      free: {
        "GET /": "This info page",
        "GET /health": "Service health check",
        "GET /stats": "Usage statistics",
        "GET /api/v3/tokens": "Supported stablecoins and fee tiers",
        "GET /api/v3/chains": "Supported chains and contracts",
      },
      paid_v1: {
        "POST /api/v1/chat/completions": "$0.005 - AI chat (OpenAI-compatible)",
        "GET /api/v1/models": "$0.001 - List AI models",
        "POST /api/v1/batch/execute":
          "$0.01 - Batch payment via Spraay V2 (USDC only)",
        "POST /api/v1/batch/estimate":
          "$0.001 - Estimate batch cost (V2, USDC)",
        "GET /api/v1/swap/quote":
          "$0.002 - Swap quote via MangoSwap routing",
        "GET /api/v1/swap/tokens": "$0.001 - List supported swap tokens",
      },
      paid_v3: {
        "POST /api/v3/batch/execute":
          "$0.01 - Multi-stablecoin batch (USDC, USDT, EURC, DAI)",
        "POST /api/v3/batch/estimate":
          "$0.001 - Multi-stablecoin fee estimation",
      },
    },
    contracts: {
      v2: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
      v3: "0x3eFf027045230A277293aC27bd571FBC729e0dcE",
    },
    supportedTokens: ["USDC", "USDT", "EURC", "DAI"],
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    protocol: "x402",
    mainnet: IS_MAINNET,
  });
});

// Free discovery endpoints
app.get("/api/v3/tokens", tokensHandler);
app.get("/api/v3/chains", chainsHandler);

app.get("/health", healthHandler);
app.get("/stats", statsHandler);

// ============================================
// PAID ROUTE HANDLERS
// ============================================

// AI Gateway (V1)
app.post("/api/v1/chat/completions", aiChatHandler);
app.get("/api/v1/models", aiModelsHandler);

// Batch Payments — V1 (legacy USDC-only)
app.post("/api/v1/batch/execute", batchPaymentHandler);
app.post("/api/v1/batch/estimate", batchEstimateHandler);

// Batch Payments — V3 (multi-stablecoin)
app.post("/api/v3/batch/execute", batchPaymentV3Handler);
app.post("/api/v3/batch/estimate", batchEstimateV3Handler);

// Swap Data (MangoSwap)
app.get("/api/v1/swap/quote", swapQuoteHandler);
app.get("/api/v1/swap/tokens", swapTokensHandler);

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v2.0 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(
    `🔗 Facilitator: ${IS_MAINNET ? "Coinbase CDP (mainnet)" : FACILITATOR_URL || "x402.org"}`
  );
  console.log(`\n🪙 Supported tokens: USDC, USDT, EURC, DAI`);
  console.log(`📋 V2 contract: 0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC`);
  console.log(`📋 V3 contract: 0x3eFf027045230A277293aC27bd571FBC729e0dcE`);
  console.log(
    `\n🌐 ${IS_MAINNET ? "11" : "11"} endpoints ready (6 V1 + 2 V3 paid, 5 free)\n`
  );
});

export default app;
