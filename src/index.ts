import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";

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

// ============================================
// x402 PAYMENT MIDDLEWARE - PROTECTED ROUTES
// ============================================
// This is where the magic happens. Each route has its own price.
// Agents discover these via the Bazaar, pay USDC, get the service.
app.use(
  paymentMiddleware(
    {
      // ---- AI MODEL PROXY (your bread and butter) ----
      "POST /api/v1/chat/completions": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.005", // $0.005 per request - you pocket the margin over OpenRouter cost
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "AI chat completions via 200+ models (GPT-4, Claude, Llama, Gemini, etc). OpenAI-compatible API.",
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
        description: "List all available AI models with pricing information.",
        mimeType: "application/json",
      },

      // ---- BATCH PAYMENTS (Spraay's core value prop) ----
      "POST /api/v1/batch/execute": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01", // Higher price - this is a premium service
            network: CAIP2_NETWORK,
            payTo: PAY_TO,
          },
        ],
        description:
          "Execute batch USDC payments to multiple recipients in a single transaction on Base. Powered by Spraay protocol.",
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
          "Estimate gas costs for a batch payment before execution. Returns cost breakdown per recipient.",
        mimeType: "application/json",
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
          "Get optimal swap quotes routed through Uniswap V3 and Aerodrome on Base. Returns best price, path, and estimated output.",
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
          "List supported tokens on Base with current prices, liquidity depth, and pool addresses.",
        mimeType: "application/json",
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
  console.log(`\n🌐 Endpoints ready for agent discovery via x402 Bazaar\n`);
});

export default app;