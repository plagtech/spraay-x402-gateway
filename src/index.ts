import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { facilitator as coinbaseFacilitator } from "@coinbase/x402";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { xrpBatchHandler, xrpEstimateHandler, xrpInfoHandler } from "./routes/xrp-batch.js";
import { aiChatHandler, aiModelsHandler } from "./routes/ai-gateway.js";
import { batchPaymentHandler, batchEstimateHandler } from "./routes/batch-payments.js";
import { stellarBatchHandler, stellarEstimateHandler } from "./routes/stellar-batch.js";

import { swapQuoteHandler, swapTokensHandler } from "./routes/swap-data.js";
import { swapExecuteHandler } from "./routes/swap-execute.js";
import { oraclePricesHandler, oracleGasHandler, oracleFxHandler } from "./routes/oracle.js";
import { bridgeQuoteHandler, bridgeChainsHandler } from "./routes/bridge.js";
import { payrollExecuteHandler, payrollEstimateHandler, payrollTokensHandler } from "./routes/payroll.js";
import { invoiceCreateHandler, invoiceGetHandler, invoiceListHandler } from "./routes/invoice.js";
import { analyticsWalletHandler, analyticsTxHistoryHandler } from "./routes/analytics.js";
import { escrowCreateHandler, escrowGetHandler, escrowFundHandler, escrowReleaseHandler, escrowCancelHandler, escrowListHandler } from "./routes/escrow.js";
import { classifyAddressHandler, classifyTxHandler, explainContractHandler, summarizeHandler } from "./routes/inference.js";
// NEW: Communication
import { notifyEmailHandler, notifySmsHandler, notifyStatusHandler } from "./routes/email-sms.js";
import { webhookRegisterHandler, webhookTestHandler, webhookListHandler, webhookDeleteHandler } from "./routes/webhook.js";
import { xmtpSendHandler, xmtpInboxHandler } from "./routes/xmtp-relay.js";
// NEW: Infrastructure
import { rpcCallHandler, rpcChainsHandler } from "./routes/rpc.js";
import { storagePinHandler, storageGetHandler, storageStatusHandler } from "./routes/ipfs.js";
import { cronCreateHandler, cronListHandler, cronCancelHandler } from "./routes/cron.js";
import { logsIngestHandler, logsQueryHandler } from "./routes/logging.js";
// NEW: Identity & Access
import { kycVerifyHandler, kycStatusHandler } from "./routes/kyc.js";
import { authSessionHandler, authVerifyHandler } from "./routes/auth.js";
// NEW: Compliance
import { auditLogHandler, auditQueryHandler } from "./routes/audit.js";
import { taxCalculateHandler, taxReportHandler } from "./routes/tax.js";
// NEW: GPU/Compute
import { gpuRunHandler, gpuStatusHandler, gpuModelsHandler } from "./routes/gpu.js";
// NEW: Wallet Provisioning (Category 14)
import { walletCreateHandler, walletGetHandler, walletListHandler, walletSignMessageHandler, walletSendTxHandler, walletAddressesHandler } from "./routes/wallet.js";
// NEW: Agent Wallet (Category 17)
import { agentWalletProvisionHandler, agentWalletSessionKeyHandler, agentWalletInfoHandler, agentWalletRevokeKeyHandler, agentWalletPredictHandler } from "./routes/agent-wallet.js";
// NEW: Search/RAG
import { searchWebHandler, searchExtractHandler, searchQnaHandler } from "./routes/search.js";
// NEW: Robotics / RTP (Category 15)
import { robotRegisterHandler, robotTaskHandler, robotCompleteHandler, robotListHandler, robotTaskStatusHandler, robotProfileHandler, robotUpdateHandler, robotDeregisterHandler } from "./routes/robots.js";
// Existing
import { pricesHandler } from "./routes/prices.js";
import { balancesHandler } from "./routes/balances.js";
// NEW: Portfolio (Category 20)
import { portfolioTokensHandler, portfolioNftsHandler } from "./routes/portfolio.js";
// NEW: Contract (Category 21)
import { contractReadHandler, contractWriteHandler } from "./routes/contract.js";
// NEW: DeFi Positions (extends DeFi category)
import { defiPositionsHandler } from "./routes/defi.js";
// NEW: Solana Jupiter (Category 22)
import { jupiterQuoteHandler, jupiterSwapTxHandler } from "./routes/jupiter.js";
// NEW: Solana Helius DAS
import { heliusAssetsByOwnerHandler, heliusAssetHandler } from "./routes/helius.js";
// NEW: Solana Pyth price feeds
import { pythPriceHandler, pythPricesHandler } from "./routes/pyth.js";
import { resolveHandler } from "./routes/resolve.js";
import { healthHandler, statsHandler } from "./routes/health.js";
// NEW: Supply Chain Task Protocol (Category 18)
import { sctpSupplierCreateHandler, sctpSupplierGetHandler, sctpPoCreateHandler, sctpPoGetHandler, sctpInvoiceSubmitHandler, sctpInvoiceGetHandler, sctpInvoiceVerifyHandler, sctpPayExecuteHandler } from "./routes/sctp.js";
// NEW: Bittensor Drop-in API (Category 19)
import { dropinModelsHandler, dropinChatHandler, dropinImageHandler, dropinEmbeddingsHandler, dropinHealthHandler } from "./routes/bittensor-dropin.js";
// NEW: Compute Services
import {
  textInferenceHandler, imageGenerationHandler, videoGenerationHandler,
  textToSpeechHandler, speechToTextHandler, embeddingsHandler,
  computeBatchHandler, computeStatusHandler, computeModelsHandler, computeEstimateHandler,
} from "./routes/compute.js";
// NEW: Compute Futures (Category 22)
import { computeFuturesDepositHandler, computeFuturesBalanceHandler, computeFuturesExecuteHandler, computeFuturesHistoryHandler, computeFuturesRefundHandler, computeFuturesPricingHandler } from "./routes/compute-futures.js";
import pluginRouter from "./routes/plugin-router.js";
import { apiKeyAuthMiddleware } from "./middleware/apiKeyAuth.js";
import { registerHandler, successHandler, cancelHandler, usageHandler, rotateHandler, portalHandler, stripeWebhookHandler } from "./routes/stripe-auth.js";
import { enrich402Middleware } from "./middleware/enrich402.js";
import { bazaarIdentityMiddleware } from "./middleware/bazaarIdentityMiddleware.js";
import { gatewayEventsMiddleware } from "./middleware/gateway-events.js";
import { protocolDetectorMiddleware } from "./middleware/protocolDetector.js";
import { mppMiddleware, initMpp } from "./middleware/mppMiddleware.js";
// Solana payment rail
import { solanaPaymentMiddleware } from "./middleware/solanaPaymentMiddleware.js";
import { solanaEnrich402Middleware } from "./middleware/solanaEnrich402.js";
import { wrapWithSolanaBypass } from "./middleware/solanaBypass.js";
import { solanaDiscoveryHandler } from "./routes/solana-discovery.js";
// NEW: Research & Reference
import {
  researchDictDefineHandler, researchDictSynonymsHandler, researchDictPhoneticsHandler,
  researchPapersSearchHandler, researchPapersByDoiHandler, researchPapersByAuthorHandler,
  researchPapersCitationsHandler, researchPapersTrendingHandler,
  researchPreprintsSearchHandler, researchPreprintsByIdHandler, researchPreprintsRecentHandler,
  researchScholarlyByDoiHandler, researchScholarlySearchHandler, researchScholarlyCitationsHandler, researchScholarlyJournalHandler,
  researchChemCompoundHandler, researchChemSimilarityHandler, researchChemBioactivityHandler,
  researchBiomedSearchHandler, researchBiomedByPmidHandler, researchBiomedRelatedHandler,
  researchCensusHandler, researchDatasetsHandler,
} from "./routes/research.js";
import { freeLimit, fetchLimit } from "./middleware/freeRateLimit.js";
import {
  freeCatalogHandler, freeGasHandler, freePricesHandler, freeChainStatusHandler,
  freeNonceHandler, freeValidateAddressHandler, freeValidateBatchHandler,
  freeEstimateBatchHandler, freeResolveHandler, freeAgentCardHandler,
  freeX402CheckHandler, freeConvertHandler, freeTimestampHandler, freeUuidHandler,
} from "./routes/free-tier.js";
import { tokenSafetyHandler } from "./routes/tokenSafety.js";
import { addressSafetyHandler } from "./routes/addressSafety.js";
import { trustScoreHandler } from "./routes/trustScore.js";
import { txDecodeHandler } from "./routes/txDecode.js";
import discoveryRoutes from "./routes/discovery.routes.js";

dotenv.config();
const app = express();
app.set('trust proxy', true);
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-PAYMENT', 'X-MPP-PAYMENT'],
  exposedHeaders: ['X-PAYMENT-RESPONSE', 'X-MPP-PAYMENT-RESPONSE'],
}));
app.post("/v1/webhooks/stripe", express.raw({ type: "application/json" }), stripeWebhookHandler);
app.use(express.json());
app.use(discoveryRoutes);

// Catch malformed JSON bodies → return structured JSON, not HTML.
// Without this, body-parser throws and agents get an unparseable HTML 400.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({
      error: "invalid_json",
      message: "Request body is not valid JSON. Send a well-formed JSON object with Content-Type: application/json.",
      detail: err.message,
    });
  }
  return next(err);
});
app.use(gatewayEventsMiddleware);

const PAY_TO = process.env.PAY_TO_ADDRESS!;
const NETWORK = process.env.X402_NETWORK || "eip155:84532";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "";
const PORT = process.env.PORT || 3402;
const IS_MAINNET = NETWORK === "eip155:8453";
const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";
const CAIP2_NETWORK = NETWORK as `${string}:${string}`;
const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as `${string}:${string}`;
const SOLANA_PAY_TO = process.env.SOLANA_RECEIVE_ADDRESS || "";

const facilitatorClient = IS_MAINNET
  ? new HTTPFacilitatorClient(coinbaseFacilitator)
  : new HTTPFacilitatorClient({ url: (FACILITATOR_URL || "https://x402.org/facilitator") as `${string}://${string}` });

const server = new x402ResourceServer(facilitatorClient).register(CAIP2_NETWORK, new ExactEvmScheme());
server.register(SOLANA_NETWORK, new ExactSvmScheme());
server.registerExtension(bazaarResourceServerExtension);
app.use(enrich402Middleware);
app.use(solanaEnrich402Middleware);
app.use(bazaarIdentityMiddleware);    
app.use(protocolDetectorMiddleware);
app.use(solanaPaymentMiddleware);     
app.use(mppMiddleware);
app.use(apiKeyAuthMiddleware);
// ════════════════════════════════════════════════════════════
// PAID ROUTES — single source of truth.
// PAID_COUNT is computed from this object and used in every
// discovery doc, so counts can never drift again.
// ════════════════════════════════════════════════════════════
const paidRoutes = {
      "POST /api/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.04", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.04", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI chat completions via 200+ models.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }, inputSchema: { properties: { model: { type: "string" }, messages: { type: "array" } }, required: ["model", "messages"] }, bodyType: "json", output: { example: { choices: [{ message: { content: "Hello!" } }] }, schema: { properties: { choices: { type: "array" } } } } }) },
      },
      "GET /api/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List AI models.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { models: [], count: 200 }, schema: { properties: { models: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Batch payments via Spraay. Implements Batch Payments for Agents (BPA) 1.0 - atomic, non-custodial, up to 200 recipients. Spec: https://docs.spraay.app/bpa/1.0/", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", recipients: ["0x..."], amounts: ["1000000"], sender: "0x..." }, inputSchema: { properties: { token: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" }, sender: { type: "string" } }, required: ["token", "recipients", "amounts", "sender"] }, bodyType: "json", output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Estimate batch gas.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { recipientCount: 5 }, inputSchema: { properties: { recipientCount: { type: "number" } }, required: ["recipientCount"] }, bodyType: "json", output: { example: { estimatedGas: "185000" }, schema: { properties: { estimatedGas: { type: "string" } } } } }) },
      },
      "POST /api/v1/stellar/batch": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Batch XLM payments on Stellar.", mimeType: "application/json",
      },
      "POST /api/v1/stellar/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Estimate Stellar batch cost.", mimeType: "application/json",
      },
      "POST /api/v1/xrp/batch": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Batch XRP payments on XRP Ledger.", mimeType: "application/json",
      },
      "POST /api/v1/xrp/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Estimate XRP batch cost.", mimeType: "application/json",
      },
      "GET /api/v1/xrp/info": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "XRP Ledger fee and reserve info.", mimeType: "application/json",
      },
      "GET /api/v1/swap/quote": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.008", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Swap quotes via Uniswap V3.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn"] }, output: { example: { amountOut: "384215000000000" }, schema: { properties: { amountOut: { type: "string" } } } } }) },
      },
      "GET /api/v1/swap/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Supported swap tokens.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [] }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/swap/execute": {
        accepts: [{ scheme: "exact", price: "$0.015", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.015", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Execute swap via Uniswap V3.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "100", recipient: "0x..." }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn", "recipient"] }, bodyType: "json", output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/solana/jupiter/quote": {
        accepts: [
          { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
          { scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO },
        ],
        description: "Jupiter v6 swap quote on Solana — price, route, slippage. Solana-native.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { inputMint: "USDC", outputMint: "SOL", amount: "1000000", slippageBps: 50 },
            inputSchema: {
              properties: {
                inputMint: { type: "string" },
                outputMint: { type: "string" },
                amount: { type: "string" },
                slippageBps: { type: "number" },
              },
              required: ["inputMint", "outputMint", "amount"],
            },
            output: {
              schema: {
                properties: {
                  inputMint: { type: "string" },
                  outputMint: { type: "string" },
                  inAmount: { type: "string" },
                  outAmount: { type: "string" },
                  priceImpactPct: { type: "string" },
                  slippageBps: { type: "number" },
                  routeHops: { type: "number" },
                },
              },
            },
          }),
        },
      },
      "POST /api/v1/solana/jupiter/swap-tx": {
        accepts: [
          { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
          { scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO },
        ],
        description: "Build unsigned Jupiter swap transaction on Solana. Client signs and submits.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            inputSchema: {
              properties: {
                quoteResponse: { type: "object" },
                userPublicKey: { type: "string" },
                wrapAndUnwrapSol: { type: "boolean" },
                prioritizationFeeLamports: {},
              },
              required: ["quoteResponse", "userPublicKey"],
            },
            bodyType: "json",
            output: {
              schema: {
                properties: {
                  swapTransaction: { type: "string" },
                  lastValidBlockHeight: { type: "number" },
                  prioritizationFeeLamports: { type: "number" },
                },
              },
            },
          }),
        },
      },
      "GET /api/v1/solana/helius/assets-by-owner": {
  accepts: [
    { scheme: "exact", price: "$0.003", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
    { scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO },
  ],
  description: "Helius DAS: list all assets (SPL tokens + NFTs) owned by a Solana wallet.",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      input: { owner: "DemoWalletAddressHere11111111111111111111111", page: 1, limit: 100 },
      inputSchema: {
        properties: {
          owner: { type: "string" },
          page: { type: "number" },
          limit: { type: "number" },
          showFungible: { type: "boolean" },
        },
        required: ["owner"],
      },
      output: {
        schema: {
          properties: {
            owner: { type: "string" },
            total: { type: "number" },
            page: { type: "number" },
            items: { type: "array" },
            nativeBalance: { type: "object" },
          },
        },
      },
    }),
  },
},
"GET /api/v1/solana/helius/asset": {
  accepts: [
    { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
    { scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO },
  ],
  description: "Helius DAS: full metadata for a single Solana asset (SPL token or compressed NFT).",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      inputSchema: {
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      output: {
        schema: {
          properties: {
            id: { type: "string" },
            asset: { type: "object" },
          },
        },
      },
    }),
  },
},
"GET /api/v1/solana/pyth/price": {
  accepts: [
    { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
    { scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO },
  ],
  description: "Pyth latest price for one feed (symbol alias or 64-char hex feed ID).",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      input: { feedId: "SOL" },
      inputSchema: {
        properties: { feedId: { type: "string" } },
        required: ["feedId"],
      },
      output: {
        schema: {
          properties: {
            symbol: { type: "string" },
            price: { type: "number" },
            confidence: { type: "number" },
            publishTime: { type: "number" },
            emaPrice: { type: "number" },
          },
        },
      },
    }),
  },
},
"GET /api/v1/solana/pyth/prices": {
  accepts: [
    { scheme: "exact", price: "$0.008", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
    { scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO },
  ],
  description: "Pyth batch latest prices (up to 50 feeds, comma-separated symbols or hex IDs).",
  mimeType: "application/json",
  extensions: {
    ...declareDiscoveryExtension({
      input: { feedIds: "SOL,BTC,ETH,USDC" },
      inputSchema: {
        properties: { feedIds: { type: "string" } },
        required: ["feedIds"],
      },
      output: {
        schema: {
          properties: {
            count: { type: "number" },
            prices: { type: "object" },
          },
        },
      },
    }),
  },
},
      "GET /api/v1/oracle/prices": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.008", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Multi-token price feed.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokens: "ETH,cbBTC" }, inputSchema: { properties: { tokens: { type: "string" } } }, output: { example: { prices: {} }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/gas": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Gas prices on Base.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { gas: {} }, schema: { properties: { gas: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/fx": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.008", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Stablecoin FX rates.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { base: "USDC" }, inputSchema: { properties: { base: { type: "string" } } }, output: { example: { rates: {} }, schema: { properties: { rates: { type: "object" } } } } }) },
      },
      "GET /api/v1/bridge/quote": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Cross-chain bridge quote.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { fromChain: "base", toChain: "ethereum", token: "USDC", amount: "1000000000", fromAddress: "0x..." }, inputSchema: { properties: { fromChain: { type: "string" }, toChain: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, fromAddress: { type: "string" } }, required: ["fromChain", "toChain", "token", "amount", "fromAddress"] }, output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/bridge/chains": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Supported bridge chains.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { chains: [] }, schema: { properties: { chains: { type: "array" } } } } }) },
      },
      "POST /api/v1/payroll/execute": {
        accepts: [{ scheme: "exact", price: "$0.10", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.10", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Execute payroll via Spraay V2.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", sender: "0x...", employees: [{ address: "0x...", amount: "3000" }] }, inputSchema: { properties: { token: { type: "string" }, sender: { type: "string" }, employees: { type: "array" } }, required: ["token", "sender", "employees"] }, bodyType: "json", output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/payroll/estimate": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.003", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Estimate payroll costs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { employeeCount: 10 }, inputSchema: { properties: { employeeCount: { type: "number" } }, required: ["employeeCount"] }, bodyType: "json", output: { example: { estimate: {} }, schema: { properties: { estimate: { type: "object" } } } } }) },
      },
      "GET /api/v1/payroll/tokens": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Payroll stablecoins.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [] }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/invoice/create": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Create invoice with payment tx.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { creator: "0x...", token: "USDC", amount: "1500" }, inputSchema: { properties: { creator: { type: "string" }, token: { type: "string" }, amount: { type: "string" } }, required: ["creator", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", invoice: { id: "INV-A1B2" } }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/invoice/list": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List invoices by address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { invoices: [], count: 0 }, schema: { properties: { invoices: { type: "array" } } } } }) },
      },
      "GET /api/v1/invoice/:id": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Invoice lookup.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "INV-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { invoice: { status: "pending" } }, schema: { properties: { invoice: { type: "object" } } } } }) },
      },
      "GET /api/v1/analytics/wallet": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Wallet profile.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { classification: { walletType: "active" } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "GET /api/v1/analytics/txhistory": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.008", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Transaction history.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", limit: "10" }, inputSchema: { properties: { address: { type: "string" }, limit: { type: "string" } }, required: ["address"] }, output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },

      // ---- ESCROW (flat routes) ----
      "POST /api/v1/escrow/create": {
        accepts: [{ scheme: "exact", price: "$0.10", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.10", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Create conditional escrow with milestones and expiry.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { depositor: "0xClient", beneficiary: "0xFreelancer", token: "USDC", amount: "5000" }, inputSchema: { properties: { depositor: { type: "string" }, beneficiary: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, arbiter: { type: "string" }, conditions: { type: "array" }, expiresIn: { type: "number" } }, required: ["depositor", "beneficiary", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", escrow: { id: "ESC-A1B2" } }, schema: { properties: { status: { type: "string" }, escrow: { type: "object" } } } } }) },
      },
      "GET /api/v1/escrow/list": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List escrows by address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" }, status: { type: "string" } }, required: ["address"] }, output: { example: { escrows: [], count: 0 }, schema: { properties: { escrows: { type: "array" } } } } }) },
      },
      "GET /api/v1/escrow/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Escrow status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "ESC-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { escrow: { status: "funded" } }, schema: { properties: { escrow: { type: "object" } } } } }) },
      },
      "POST /api/v1/escrow/fund": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Mark escrow as funded. Pass escrowId in body.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2" }, inputSchema: { properties: { escrowId: { type: "string" } }, required: ["escrowId"] }, bodyType: "json", output: { example: { status: "funded" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/escrow/release": {
        accepts: [{ scheme: "exact", price: "$0.08", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.08", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Release escrow funds. Returns unsigned transfer tx. Depositor or arbiter only.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2", caller: "0xDepositor" }, inputSchema: { properties: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"] }, bodyType: "json", output: { example: { status: "released", transaction: {} }, schema: { properties: { status: { type: "string" }, transaction: { type: "object" } } } } }) },
      },
      "POST /api/v1/escrow/cancel": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Cancel escrow.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2", caller: "0xDepositor" }, inputSchema: { properties: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"] }, bodyType: "json", output: { example: { status: "cancelled" }, schema: { properties: { status: { type: "string" } } } } }) },
      },

      // ---- INFERENCE ----
      "POST /api/v1/inference/classify-address": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI-powered wallet classification with risk scoring.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { classification: { classification: "whale", riskLevel: "low", riskScore: 15 } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/classify-tx": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI-powered transaction classification with risk scoring.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { hash: "0xabc123..." }, inputSchema: { properties: { hash: { type: "string" } }, required: ["hash"] }, bodyType: "json", output: { example: { classification: { type: "swap", riskLevel: "low" } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/explain-contract": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI-powered smart contract analysis.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { analysis: { type: "erc20-token", riskLevel: "low" } }, schema: { properties: { analysis: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/summarize": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI intelligence briefing for any address or transaction.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { target: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", context: "defi" }, inputSchema: { properties: { target: { type: "string" }, context: { type: "string" } }, required: ["target"] }, bodyType: "json", output: { example: { briefing: { headline: "Active DeFi whale", riskAssessment: { level: "low" } } }, schema: { properties: { briefing: { type: "object" } } } } }) },
      },

      // ---- COMMUNICATION ----
      "POST /api/v1/notify/email": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Send email notification for payment confirmations, alerts, receipts.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { to: "user@example.com", subject: "Payment Received", body: "Your batch payment of 500 USDC has been confirmed." }, inputSchema: { properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, replyTo: { type: "string" } }, required: ["to", "body"] }, bodyType: "json", output: { example: { id: "ntf_123", status: "queued" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "POST /api/v1/notify/sms": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Send SMS notification for payment alerts.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { to: "+14155551234", body: "Spraay: 500 USDC payment confirmed. Tx: 0xabc..." }, inputSchema: { properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] }, bodyType: "json", output: { example: { id: "ntf_123", status: "queued", segments: 1 }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/notify/status": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Check notification delivery status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "ntf_123" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { id: "ntf_123", status: "delivered" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "POST /api/v1/webhook/register": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Register webhook for payment/escrow/swap events.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { url: "https://myapp.com/hooks/spraay", events: ["payment.sent", "escrow.funded"] }, inputSchema: { properties: { url: { type: "string" }, events: { type: "array" } }, required: ["url", "events"] }, bodyType: "json", output: { example: { id: "whk_123", secret: "whsec_abc", status: "active" }, schema: { properties: { id: { type: "string" }, secret: { type: "string" } } } } }) },
      },
      "POST /api/v1/webhook/test": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Send test event to a registered webhook.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { webhookId: "whk_123" }, inputSchema: { properties: { webhookId: { type: "string" } }, required: ["webhookId"] }, bodyType: "json", output: { example: { delivered: true }, schema: { properties: { delivered: { type: "boolean" } } } } }) },
      },
      "GET /api/v1/webhook/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List registered webhooks.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { webhooks: [], total: 0 }, schema: { properties: { webhooks: { type: "array" } } } } }) },
      },
      "POST /api/v1/webhook/delete": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Delete a webhook.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { webhookId: "whk_123" }, inputSchema: { properties: { webhookId: { type: "string" } }, required: ["webhookId"] }, bodyType: "json", output: { example: { deleted: true }, schema: { properties: { deleted: { type: "boolean" } } } } }) },
      },
      "POST /api/v1/xmtp/send": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Send encrypted XMTP message to any Ethereum address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", content: "Your payment of 500 USDC has been sent." }, inputSchema: { properties: { to: { type: "string" }, content: { type: "string" }, contentType: { type: "string" } }, required: ["to", "content"] }, bodyType: "json", output: { example: { id: "xmtp_123", status: "sent" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/xmtp/inbox": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Read XMTP inbox for an Ethereum address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" }, limit: { type: "string" } }, required: ["address"] }, output: { example: { messages: [], total: 0 }, schema: { properties: { messages: { type: "array" } } } } }) },
      },

      // ---- INFRASTRUCTURE ----
      "POST /api/v1/rpc/call": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Premium multi-chain RPC call via Alchemy/Helius.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { chain: "base", method: "eth_getBalance", params: ["0xd8dA...", "latest"] }, inputSchema: { properties: { chain: { type: "string" }, method: { type: "string" }, params: { type: "array" } }, required: ["chain", "method"] }, bodyType: "json", output: { example: { jsonrpc: "2.0", result: "0x1234" }, schema: { properties: { result: { type: "string" } } } } }) },
      },
      "GET /api/v1/rpc/chains": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List supported RPC chains and methods.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { chains: [], allowedMethods: [] }, schema: { properties: { chains: { type: "array" } } } } }) },
      },
      "POST /api/v1/storage/pin": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Pin content to IPFS or Arweave for permanent storage.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { data: "{\"receipt\":\"batch_123\"}", contentType: "application/json", provider: "ipfs" }, inputSchema: { properties: { data: { type: "string" }, contentType: { type: "string" }, provider: { type: "string" } }, required: ["data"] }, bodyType: "json", output: { example: { cid: "bafy...", status: "pinning" }, schema: { properties: { cid: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/storage/get": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Retrieve pinned content by CID.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { cid: "bafy..." }, inputSchema: { properties: { cid: { type: "string" } }, required: ["cid"] }, output: { example: { cid: "bafy...", status: "pinned" }, schema: { properties: { cid: { type: "string" } } } } }) },
      },
      "GET /api/v1/storage/status": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Check pin status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "pin_123" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { status: "pinned" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/cron/create": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Create scheduled job for recurring payments, DCA, reminders.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { action: "batch.execute", schedule: "0 9 * * 1", payload: { token: "USDC", recipients: ["0x..."] } }, inputSchema: { properties: { action: { type: "string" }, schedule: { type: "string" }, payload: { type: "object" }, maxRuns: { type: "number" } }, required: ["action", "schedule", "payload"] }, bodyType: "json", output: { example: { id: "cron_123", status: "active" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/cron/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List scheduled jobs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { jobs: [], total: 0 }, schema: { properties: { jobs: { type: "array" } } } } }) },
      },
      "POST /api/v1/cron/cancel": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Cancel a scheduled job.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { jobId: "cron_123" }, inputSchema: { properties: { jobId: { type: "string" } }, required: ["jobId"] }, bodyType: "json", output: { example: { status: "cancelled" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/logs/ingest": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Ingest structured logs for debugging agent workflows.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { entries: [{ level: "info", service: "batch-agent", message: "Payment sent" }] }, inputSchema: { properties: { entries: { type: "array" } }, required: ["entries"] }, bodyType: "json", output: { example: { ingested: 1, ids: ["log_123"] }, schema: { properties: { ingested: { type: "number" } } } } }) },
      },
      "GET /api/v1/logs/query": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Query structured logs by service, level, time.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { service: "batch-agent", level: "error" }, inputSchema: { properties: { service: { type: "string" }, level: { type: "string" }, since: { type: "string" }, limit: { type: "string" } } }, output: { example: { logs: [], total: 0 }, schema: { properties: { logs: { type: "array" } } } } }) },
      },

      // ---- IDENTITY & ACCESS ----
      "POST /api/v1/kyc/verify": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "OFAC SDN sanctions screening via on-chain Chainalysis oracle.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", type: "individual", chain: "base" }, inputSchema: { properties: { address: { type: "string" }, type: { type: "string" }, chain: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { id: "kyc_123", status: "approved", result: { isSanctioned: false, listSource: "OFAC SDN (US Treasury)" } }, schema: { properties: { id: { type: "string" }, status: { type: "string" }, result: { type: "object" } } } } }) },
      },
      "GET /api/v1/kyc/status": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Check KYC verification status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "kyc_123" }, inputSchema: { properties: { id: { type: "string" }, address: { type: "string" } } }, output: { example: { status: "approved", checks: { identity: true, sanctions: true } }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/auth/session": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Create authenticated session with scoped permissions.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", permissions: ["batch:execute", "swap:execute"], ttlSeconds: 3600 }, inputSchema: { properties: { address: { type: "string" }, permissions: { type: "array" }, ttlSeconds: { type: "number" } }, required: ["address"] }, bodyType: "json", output: { example: { token: "spr_abc...", expiresAt: "2026-03-05T00:00:00Z" }, schema: { properties: { token: { type: "string" } } } } }) },
      },
      "GET /api/v1/auth/verify": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Verify session token and check permissions.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "spr_abc..." }, inputSchema: { properties: { token: { type: "string" } }, required: ["token"] }, output: { example: { valid: true, permissions: [] }, schema: { properties: { valid: { type: "boolean" } } } } }) },
      },

      // ---- COMPLIANCE ----
      "POST /api/v1/audit/log": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Record immutable audit trail entry for payments, escrows, compliance.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { action: "payment.sent", actor: "0xd8dA...", resource: "batch_123", details: { amount: "500 USDC" } }, inputSchema: { properties: { action: { type: "string" }, actor: { type: "string" }, resource: { type: "string" }, details: { type: "object" }, txHash: { type: "string" } }, required: ["action", "actor", "resource"] }, bodyType: "json", output: { example: { id: "aud_123", recorded: true }, schema: { properties: { id: { type: "string" } } } } }) },
      },
      "GET /api/v1/audit/query": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Query audit trail by actor, action, resource, time range.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { actor: "0xd8dA...", action: "payment.sent" }, inputSchema: { properties: { actor: { type: "string" }, action: { type: "string" }, resource: { type: "string" }, since: { type: "string" }, until: { type: "string" } } }, output: { example: { entries: [], total: 0 }, schema: { properties: { entries: { type: "array" } } } } }) },
      },
      "POST /api/v1/tax/calculate": {
        accepts: [{ scheme: "exact", price: "$0.08", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.08", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Calculate crypto tax gain/loss using FIFO method.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { transactions: [{ type: "swap", asset: "ETH", amount: 1.5, costBasisUsd: 3000, proceedsUsd: 4500, holdingDays: 400 }] }, inputSchema: { properties: { transactions: { type: "array" } }, required: ["transactions"] }, bodyType: "json", output: { example: { summary: { totalGainLossUsd: 1500 } }, schema: { properties: { summary: { type: "object" } } } } }) },
      },
      "GET /api/v1/tax/report": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Retrieve tax report with IRS 8949-compatible data.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { reportId: "tax_123" }, inputSchema: { properties: { reportId: { type: "string" } } }, output: { example: { events: [], total: 0 }, schema: { properties: { events: { type: "array" } } } } }) },
      },

      // ---- GPU/COMPUTE ----
      "POST /api/v1/gpu/run": {
        accepts: [{ scheme: "exact", price: "$0.06", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.06", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "GPU/Compute — run AI model inference via Replicate (image, video, LLM, audio, utility).", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "flux-pro", input: { prompt: "a serene mountain lake at sunset" } }, inputSchema: { properties: { model: { type: "string" }, input: { type: "object" }, version: { type: "string" }, webhook: { type: "string" } }, required: ["model", "input"] }, bodyType: "json", output: { example: { id: "abc123", status: "succeeded", model: "black-forest-labs/flux-1.1-pro", output: ["https://replicate.delivery/..."] }, schema: { properties: { id: { type: "string" }, status: { type: "string" }, output: { type: "array" } } } } }) },
      },
      "GET /api/v1/gpu/status/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "GPU/Compute — check prediction status for async jobs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "abc123" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { id: "abc123", status: "succeeded", output: [] }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },

      // ---- SEARCH/RAG ----
      "POST /api/v1/search/web": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Web search with clean, LLM-ready results via Tavily. Basic or advanced depth.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { query: "latest Base ecosystem news", search_depth: "basic", max_results: 5 }, inputSchema: { properties: { query: { type: "string" }, search_depth: { type: "string" }, max_results: { type: "number" }, topic: { type: "string" }, include_domains: { type: "array" }, exclude_domains: { type: "array" } }, required: ["query"] }, bodyType: "json", output: { example: { query: "...", answer: "...", results: [{ title: "...", url: "...", content: "..." }] }, schema: { properties: { query: { type: "string" }, answer: { type: "string" }, results: { type: "array" } } } } }) },
      },
      "POST /api/v1/search/extract": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Extract clean content from URLs for RAG pipelines. Up to 5 URLs per request.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { urls: ["https://docs.base.org/overview"] }, inputSchema: { properties: { urls: { type: "array" } }, required: ["urls"] }, bodyType: "json", output: { example: { results: [{ url: "...", content: "..." }], failed: [] }, schema: { properties: { results: { type: "array" } } } } }) },
      },
      "POST /api/v1/search/qna": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Direct question answering — searches web and synthesizes an answer with sources.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { query: "What is x402 protocol?", topic: "general" }, inputSchema: { properties: { query: { type: "string" }, topic: { type: "string" } }, required: ["query"] }, bodyType: "json", output: { example: { query: "...", answer: "...", sources: [{ title: "...", url: "..." }] }, schema: { properties: { query: { type: "string" }, answer: { type: "string" }, sources: { type: "array" } } } } }) },
      },

      // ---- EXISTING ----
      "GET /api/v1/prices": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Live token prices.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "WETH" }, inputSchema: { properties: { token: { type: "string" } } }, output: { example: { prices: {} }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/balances": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Token balances.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { balances: [] }, schema: { properties: { balances: { type: "array" } } } } }) },
      },
      "GET /api/v1/resolve": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "ENS/Basename resolution.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { name: "vitalik.eth" }, inputSchema: { properties: { name: { type: "string" } }, required: ["name"] }, output: { example: { address: "0xd8dA..." }, schema: { properties: { address: { type: "string" } } } } }) },
      },
      "GET /api/v1/wallet/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List agent wallets with pagination.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { wallets: [], pagination: {} }, schema: { properties: { wallets: { type: "array" } } } } }) },
      },
      "GET /api/v1/wallet/:walletId": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get agent wallet details.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { walletId: "", addresses: {} }, schema: { properties: { walletId: { type: "string" } } } } }) },
      },
      "GET /api/v1/wallet/:walletId/addresses": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get chain-specific addresses for a wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { addresses: {} }, schema: { properties: { addresses: { type: "object" } } } } }) },
      },
      "POST /api/v1/wallet/sign-message": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Sign a message with an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletId: "...", message: "Hello" }, inputSchema: { properties: { walletId: { type: "string" }, message: { type: "string" } }, required: ["walletId", "message"] }, bodyType: "json", output: { example: { signature: "..." }, schema: { properties: { signature: { type: "string" } } } } }) },
      },
      "POST /api/v1/wallet/send-transaction": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Sign and broadcast a transaction from an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletId: "...", transaction: {}, networkId: "base-mainnet" }, inputSchema: { properties: { walletId: { type: "string" }, transaction: { type: "object" }, networkId: { type: "string" } }, required: ["walletId", "transaction", "networkId"] }, bodyType: "json", output: { example: { signature: "..." }, schema: { properties: { signature: { type: "string" } } } } }) },
      },
      // Robotics / RTP (Category 15)
      "POST /api/v1/robots/task": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Dispatch a paid task to an RTP-registered robot. x402 payment held in escrow until completion.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { robot_id: "robo_abc123", task: "pick", parameters: { item: "SKU-00421", from_location: "bin_A3" } }, inputSchema: { properties: { robot_id: { type: "string" }, task: { type: "string" }, parameters: { type: "object" }, callback_url: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["robot_id", "task"] }, bodyType: "json", output: { example: { status: "DISPATCHED", task_id: "task_xyz789", escrow_id: "escrow_001" }, schema: { properties: { status: { type: "string" }, task_id: { type: "string" } } } } }) },
      },
      "GET /api/v1/robots/list": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Discover RTP robots. Filter by capability, chain, price, status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { capability: "pick", max_price: "0.10" }, inputSchema: { properties: { capability: { type: "string" }, chain: { type: "string" }, max_price: { type: "string" }, status: { type: "string" } } }, output: { example: { robots: [], total: 0 }, schema: { properties: { robots: { type: "array" }, total: { type: "number" } } } } }) },
      },
      "GET /api/v1/robots/status": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Poll RTP task status: PENDING, DISPATCHED, IN_PROGRESS, COMPLETED, FAILED, TIMEOUT.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { task_id: "task_xyz789" }, inputSchema: { properties: { task_id: { type: "string" } }, required: ["task_id"] }, output: { example: { task_id: "task_xyz789", status: "COMPLETED", result: {} }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/robots/profile": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Full RTP robot profile: capabilities, pricing, connection type.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { robot_id: "robo_abc123" }, inputSchema: { properties: { robot_id: { type: "string" } }, required: ["robot_id"] }, output: { example: { robot_id: "robo_abc123", capabilities: ["pick", "place"] }, schema: { properties: { robot_id: { type: "string" }, capabilities: { type: "array" } } } } }) },
      },
      // ---- AGENT WALLET (Category 17) ----
      "POST /api/v1/agent-wallet/provision": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Create a smart contract wallet for an AI agent on Base. Returns wallet address and optional encrypted key.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { agentId: "trading-bot-007", agentType: "langchain", mode: "managed" }, inputSchema: { properties: { agentId: { type: "string" }, agentType: { type: "string" }, mode: { type: "string" }, ownerAddress: { type: "string" } }, required: ["agentId"] }, bodyType: "json", output: { example: { status: "created", wallet: { walletAddress: "0x...", chainId: 8453 } }, schema: { properties: { status: { type: "string" }, wallet: { type: "object" } } } } }) },
      },
      "POST /api/v1/agent-wallet/session-key": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Add a session key with spending limits and time bounds to an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletAddress: "0x...", sessionKeyAddress: "0x...", spendLimitEth: "0.5", durationHours: 24 }, inputSchema: { properties: { walletAddress: { type: "string" }, sessionKeyAddress: { type: "string" }, spendLimitEth: { type: "string" }, durationHours: { type: "number" }, allowedTargets: { type: "array" } }, required: ["walletAddress", "sessionKeyAddress", "spendLimitEth", "durationHours"] }, bodyType: "json", output: { example: { status: "created", session: { expiresAt: "2025-01-01T00:00:00Z" } }, schema: { properties: { status: { type: "string" }, session: { type: "object" } } } } }) },
      },
      "GET /api/v1/agent-wallet/info": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get agent wallet info including balance, metadata, and session keys.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { wallet: { balanceEth: "0.5", agentId: "bot-001" } }, schema: { properties: { wallet: { type: "object" } } } } }) },
      },
      "POST /api/v1/agent-wallet/revoke-key": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Revoke a session key immediately.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletAddress: "0x...", sessionKeyAddress: "0x..." }, inputSchema: { properties: { walletAddress: { type: "string" }, sessionKeyAddress: { type: "string" } }, required: ["walletAddress", "sessionKeyAddress"] }, bodyType: "json", output: { example: { status: "revoked", txHash: "0x..." }, schema: { properties: { status: { type: "string" }, txHash: { type: "string" } } } } }) },
      },
      "GET /api/v1/agent-wallet/predict": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Predict agent wallet address before deployment.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { ownerAddress: "0x...", agentId: "bot-001" }, inputSchema: { properties: { ownerAddress: { type: "string" }, agentId: { type: "string" } }, required: ["ownerAddress", "agentId"] }, output: { example: { predictedAddress: "0x..." }, schema: { properties: { predictedAddress: { type: "string" } } } } }) },
      },
      
      // ---- RESEARCH & REFERENCE ----
      "GET /api/v1/research/dictionary/define": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Dictionary definition with phonetics, parts of speech, and examples.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/dictionary/synonyms": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Synonyms and antonyms for a word.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/dictionary/phonetics": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Phonetic transcription and audio pronunciation URL.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/papers/search": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Search 250M+ academic papers via OpenAlex (CC0). Filter by field, year, author.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/papers/by-doi": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get paper metadata by DOI via OpenAlex.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/papers/by-author": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List papers by author name or ORCID via OpenAlex.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/papers/citations": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Citation graph for a paper — cited-by count and referenced works.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/papers/trending": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Trending papers by topic in last 7/30/90 days via OpenAlex.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/preprints/search": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Search arXiv preprints by keyword and category (CC0 metadata).",
        mimeType: "application/json",
      },
      "GET /api/v1/research/preprints/by-id": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get arXiv preprint metadata by ID.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/preprints/recent": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Latest arXiv preprints by category (cs.AI, math, physics, etc.).",
        mimeType: "application/json",
      },
      "GET /api/v1/research/scholarly/by-doi": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Full Crossref metadata for any DOI (journal, book, conference).",
        mimeType: "application/json",
      },
      "GET /api/v1/research/scholarly/search": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Search 150M+ works by keyword via Crossref (CC0 metadata).",
        mimeType: "application/json",
      },
      "GET /api/v1/research/scholarly/citations-count": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Citation count and reference list for a DOI via Crossref.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/scholarly/journal-info": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Journal metadata by ISSN: publisher, subject, open-access status.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/chemistry/compound": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "PubChem compound lookup by name, formula, or CID. Properties, structure, safety data.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/chemistry/similarity": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Find structurally similar compounds in PubChem by CID.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/chemistry/bioactivity": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Biological assay results for a PubChem compound.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/biomedical/search": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Search 36M+ biomedical papers in PubMed by keyword or MeSH term.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/biomedical/by-pmid": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Paper metadata by PubMed ID.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/biomedical/related": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Related articles for a given PubMed ID.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/demographics/census": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "US Census data by state, county, zip — population, income, housing.",
        mimeType: "application/json",
      },
      "GET /api/v1/research/demographics/datasets": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Search Data.gov datasets by keyword and category.",
        mimeType: "application/json",
      },

      // ---- CATEGORY 19: BITTENSOR DROP-IN API (OpenAI-compatible) ----
      "GET /bittensor/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "List all AI models on Bittensor. OpenAI /v1/models compatible. Drop-in: just change base_url to gateway.spraay.app/bittensor/v1", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { object: "list", data: [{ id: "deepseek-ai/DeepSeek-R1-0528", object: "model" }] }, schema: { properties: { object: { type: "string" }, data: { type: "array" } } } } }) },
      },
      "POST /bittensor/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Chat completions via Bittensor decentralized AI. Fully OpenAI-compatible. 43+ models (DeepSeek, Qwen, Llama, Mistral). Streaming, function calling, TEE-verified. Drop-in: just change base_url.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "deepseek-ai/DeepSeek-V3-0324", messages: [{ role: "user", content: "What is decentralized AI?" }], max_tokens: 256 }, inputSchema: { properties: { model: { type: "string" }, messages: { type: "array" }, max_tokens: { type: "number" }, temperature: { type: "number" }, stream: { type: "boolean" }, tools: { type: "array" } }, required: ["model", "messages"] }, bodyType: "json", output: { example: { id: "chatcmpl-abc", choices: [{ message: { role: "assistant", content: "..." } }], usage: { total_tokens: 57 } }, schema: { properties: { choices: { type: "array" }, usage: { type: "object" } } } } }) },
      },
      "POST /bittensor/v1/images/generations": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Image generation via Bittensor Subnet 19 (Nineteen AI). OpenAI /v1/images/generations compatible.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { prompt: "A cyberpunk city powered by decentralized AI" }, inputSchema: { properties: { prompt: { type: "string" }, model: { type: "string" }, n: { type: "number" }, size: { type: "string" } }, required: ["prompt"] }, bodyType: "json", output: { example: { data: [{ url: "https://..." }] }, schema: { properties: { data: { type: "array" } } } } }) },
      },
      "POST /bittensor/v1/embeddings": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Text embeddings via Bittensor. OpenAI /v1/embeddings compatible. Use for RAG, semantic search, similarity.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "BAAI/bge-large-en-v1.5", input: "Decentralized AI" }, inputSchema: { properties: { model: { type: "string" }, input: { type: "string" } }, required: ["model", "input"] }, bodyType: "json", output: { example: { object: "list", data: [{ embedding: [0.0023] }] }, schema: { properties: { data: { type: "array" } } } } }) },
      },
      // ---- COMPUTE SERVICES ----
      "POST /api/v1/compute/text-inference": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "LLM chat completion and text generation. 11 models from 3B to 405B parameters. Providers: Chutes AI (Bittensor SN64), OpenRouter. Pay per request, pick your model or use auto.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { messages: [{ role: "user", content: "Classify this wallet address" }], model: "auto" }, inputSchema: { properties: { messages: { type: "array" }, model: { type: "string" }, max_tokens: { type: "number" }, temperature: { type: "number" } }, required: ["messages"] }, bodyType: "json", output: { example: { provider: "chutes", model: "meta-llama/Llama-3.3-70B-Instruct", choices: [{ message: { content: "..." } }], usage: { total_tokens: 150 }, price_usdc: "0.030" }, schema: { properties: { provider: { type: "string" }, model: { type: "string" }, choices: { type: "array" }, usage: { type: "object" } } } } }) },
      },
      "POST /api/v1/compute/image-generation": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI image generation from text prompts. FLUX Schnell, FLUX Dev, FLUX Pro, Stable Diffusion XL via Replicate. Text to image.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { prompt: "A futuristic city powered by decentralized compute", model: "auto", width: 1024, height: 1024 }, inputSchema: { properties: { prompt: { type: "string" }, model: { type: "string" }, width: { type: "number" }, height: { type: "number" }, num_outputs: { type: "number" } }, required: ["prompt"] }, bodyType: "json", output: { example: { provider: "replicate", model: "black-forest-labs/flux-schnell", images: [{ url: "https://...", width: 1024, height: 1024 }], price_usdc: "0.030" }, schema: { properties: { images: { type: "array" }, status: { type: "string" } } } } }) },
      },
      "POST /api/v1/compute/video-generation": {
        accepts: [{ scheme: "exact", price: "$0.50", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.50", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI video generation from text prompts. MiniMax Video 01, Wan 2.1 via Replicate. Text to video. Async — poll /compute/status for results.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { prompt: "A drone flyover of a mountain range at golden hour", model: "auto", duration_seconds: 4 }, inputSchema: { properties: { prompt: { type: "string" }, model: { type: "string" }, duration_seconds: { type: "number" } }, required: ["prompt"] }, bodyType: "json", output: { example: { status: "processing", prediction_id: "abc123", poll_url: "/api/v1/compute/status/abc123", price_usdc: "0.500" }, schema: { properties: { status: { type: "string" }, video_url: { type: "string" }, prediction_id: { type: "string" } } } } }) },
      },
      "POST /api/v1/compute/text-to-speech": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Text to speech (TTS) and AI music generation. XTTS V2 for natural voice synthesis with cloning, MusicGen for music from text. Voice generation.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { text: "Welcome to Spraay compute services.", model: "auto", language: "en" }, inputSchema: { properties: { text: { type: "string" }, model: { type: "string" }, language: { type: "string" } }, required: ["text"] }, bodyType: "json", output: { example: { status: "completed", audio_url: "https://...", price_usdc: "0.030" }, schema: { properties: { status: { type: "string" }, audio_url: { type: "string" } } } } }) },
      },
      "POST /api/v1/compute/speech-to-text": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Speech to text (STT) transcription. Whisper Large V3 via Replicate. Audio transcription, speech recognition. 100+ languages.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { audio_url: "https://example.com/audio.mp3", model: "auto" }, inputSchema: { properties: { audio_url: { type: "string" }, model: { type: "string" } }, required: ["audio_url"] }, bodyType: "json", output: { example: { status: "completed", transcription: "Hello world...", price_usdc: "0.020" }, schema: { properties: { status: { type: "string" }, transcription: { type: "string" } } } } }) },
      },
      "POST /api/v1/compute/embeddings": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Text embeddings for RAG, semantic search, and similarity. Vector embeddings via Chutes AI (Bittensor). BGE Large v1.5.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { input: "Decentralized AI compute marketplace", model: "auto" }, inputSchema: { properties: { input: { type: "string" }, model: { type: "string" } }, required: ["input"] }, bodyType: "json", output: { example: { data: [{ embedding: [0.0023], index: 0 }], usage: { total_tokens: 5 }, price_usdc: "0.005" }, schema: { properties: { data: { type: "array" }, usage: { type: "object" } } } } }) },
      },
      "POST /api/v1/compute/batch": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.05", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Batch compute — submit up to 50 jobs in a single x402 payment. 10% batch discount. Mix any compute types: text inference, image generation, TTS, STT, embeddings, video.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { jobs: [{ type: "text-inference", messages: [{ role: "user", content: "Classify 0x..." }] }, { type: "image-generation", prompt: "Company logo" }] }, inputSchema: { properties: { jobs: { type: "array" } }, required: ["jobs"] }, bodyType: "json", output: { example: { batch_id: "batch_abc123", jobs_submitted: 2, total_cost_usdc: "0.054", results: [] }, schema: { properties: { batch_id: { type: "string" }, total_cost_usdc: { type: "string" }, results: { type: "array" } } } } }) },
      },
      "GET /api/v1/compute/status/:jobId": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Poll async compute job status. For video generation and batch items that are still processing.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { jobId: "abc123" }, inputSchema: { properties: { jobId: { type: "string" } }, required: ["jobId"] }, output: { example: { prediction_id: "abc123", status: "succeeded", output: [] }, schema: { properties: { prediction_id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      // ---- CATEGORY: COMPUTE FUTURES (Prepaid Compute Credits) ----
      "POST /api/v1/compute-futures/deposit": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Deposit USDC to create a prepaid compute credit account. Tier discounts: $10+ (5%), $50+ (10%), $200+ (15%). Draw down per inference, refund unused balance anytime.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { depositor: "0xYourAddress", amount: "50" }, inputSchema: { properties: { depositor: { type: "string" }, amount: { type: "string" }, expiresInDays: { type: "number" } }, required: ["depositor", "amount"] }, bodyType: "json", output: { example: { status: "active", computeFuture: { id: "CFE-ABC12345", tier: "scale", discount: "10% discount", balanceRemaining: "50 USDC" } }, schema: { properties: { status: { type: "string" }, computeFuture: { type: "object" } } } } }) },
      },
      "GET /api/v1/compute-futures/balance": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Check remaining compute credit balance, tier, discount, and usage stats.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "CFE-ABC12345" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { id: "CFE-ABC12345", balanceRemaining: "42.50 USDC", tier: "scale", jobCount: 15 }, schema: { properties: { id: { type: "string" }, balanceRemaining: { type: "string" } } } } }) },
      },
      "POST /api/v1/compute-futures/execute": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Execute a compute job (text-inference, image-gen, video-gen, TTS, STT, embeddings) and deduct cost from prepaid balance. No per-call x402 payment — uses credit balance. Tier discount applied automatically.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { futuresId: "CFE-ABC12345", type: "text-inference", messages: [{ role: "user", content: "Hello" }] }, inputSchema: { properties: { futuresId: { type: "string" }, type: { type: "string" }, model: { type: "string" }, messages: { type: "array" }, prompt: { type: "string" } }, required: ["futuresId", "type"] }, bodyType: "json", output: { example: { status: "completed", billing: { charged: "$0.027", balanceRemaining: "$42.473 USDC" }, compute: { type: "text-inference", model: "Llama 3.3 70B" } }, schema: { properties: { status: { type: "string" }, billing: { type: "object" }, compute: { type: "object" } } } } }) },
      },
      "GET /api/v1/compute-futures/history": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Full usage ledger for a compute futures account — every job, model, price, and balance change.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "CFE-ABC12345" }, inputSchema: { properties: { id: { type: "string" }, limit: { type: "number" } }, required: ["id"] }, output: { example: { id: "CFE-ABC12345", usage: [], jobCount: 15 }, schema: { properties: { id: { type: "string" }, usage: { type: "array" } } } } }) },
      },
      "POST /api/v1/compute-futures/refund": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Refund unused compute credit balance back to the depositor. Only the depositor can request a refund.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { futuresId: "CFE-ABC12345", caller: "0xYourAddress" }, inputSchema: { properties: { futuresId: { type: "string" }, caller: { type: "string" } }, required: ["futuresId", "caller"] }, bodyType: "json", output: { example: { status: "refunded", refund: { refundAmount: "42.50 USDC", jobsExecuted: 15 } }, schema: { properties: { status: { type: "string" }, refund: { type: "object" } } } } }) },
      },
      "GET /api/v1/compute-futures/pricing": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.001", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Compute futures pricing — tier discounts, per-model costs, and bulk discount info.",
        mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tiers: [], pricing: {} }, schema: { properties: { tiers: { type: "array" }, pricing: { type: "object" } } } } }) },
      },
      // ---- CATEGORY 18: SCTP (Supply Chain Task Protocol) ----
      "POST /api/v1/sctp/supplier": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Register a supplier in the SCTP directory.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { name: "Acme Corp", wallet: "0x...", paymentPrefs: { token: "USDC" } }, inputSchema: { properties: { name: { type: "string" }, wallet: { type: "string" }, paymentPrefs: { type: "object" } }, required: ["name", "wallet"] }, bodyType: "json", output: { example: { status: "created", supplier: { id: "SUP-A1B2" } }, schema: { properties: { status: { type: "string" }, supplier: { type: "object" } } } } }) },
      },
      "GET /api/v1/sctp/supplier/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get supplier details by ID.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "SUP-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { supplier: { id: "SUP-A1B2", name: "Acme Corp" } }, schema: { properties: { supplier: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/po": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Create a purchase order with line items and supplier.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { supplierId: "SUP-A1B2", lineItems: [{ sku: "ABC", qty: 10, price: "100" }], currency: "USDC" }, inputSchema: { properties: { supplierId: { type: "string" }, lineItems: { type: "array" }, currency: { type: "string" } }, required: ["supplierId", "lineItems"] }, bodyType: "json", output: { example: { status: "created", po: { id: "PO-A1B2" } }, schema: { properties: { status: { type: "string" }, po: { type: "object" } } } } }) },
      },
      "GET /api/v1/sctp/po/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get purchase order details.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "PO-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { po: { id: "PO-A1B2", status: "open" } }, schema: { properties: { po: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/invoice": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Submit an invoice linked to a purchase order.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { poId: "PO-A1B2", supplierId: "SUP-A1B2", amount: "1000", currency: "USDC" }, inputSchema: { properties: { poId: { type: "string" }, supplierId: { type: "string" }, amount: { type: "string" }, currency: { type: "string" } }, required: ["poId", "supplierId", "amount"] }, bodyType: "json", output: { example: { status: "submitted", invoice: { id: "INV-A1B2" } }, schema: { properties: { status: { type: "string" }, invoice: { type: "object" } } } } }) },
      },
      "GET /api/v1/sctp/invoice/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.005", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Get invoice details.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "INV-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { invoice: { id: "INV-A1B2", status: "submitted" } }, schema: { properties: { invoice: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/invoice/verify": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "AI-verify an invoice against its purchase order. Returns match score and flags.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { invoiceId: "INV-A1B2" }, inputSchema: { properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] }, bodyType: "json", output: { example: { verification: { matchScore: 0.98, flags: [], status: "verified" } }, schema: { properties: { verification: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/pay": {
        accepts: [{ scheme: "exact", price: "$0.10", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.10", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Execute supplier payment for a verified invoice via batch settlement.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { invoiceId: "INV-A1B2", batch: false }, inputSchema: { properties: { invoiceId: { type: "string" }, batch: { type: "boolean" } }, required: ["invoiceId"] }, bodyType: "json", output: { example: { status: "paid", txHash: "0x...", amount: "1000" }, schema: { properties: { status: { type: "string" }, txHash: { type: "string" } } } } }) },
      },
      "GET /api/v1/portfolio/tokens": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.008", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Multi-chain token portfolio (native + ERC-20) with USD values.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", networks: "base-mainnet,eth-mainnet" }, inputSchema: { properties: { address: { type: "string" }, networks: { type: "string" }, includeNative: { type: "boolean" }, includeErc20: { type: "boolean" }, includePrices: { type: "boolean" } }, required: ["address"] }, output: { example: { address: "0xd8dA...", token_count: 42, total_usd_value: 12345.67, tokens: [] }, schema: { properties: { address: { type: "string" }, token_count: { type: "number" }, total_usd_value: { type: "number" }, tokens: { type: "array" } } } } }) },
      },
      "GET /api/v1/portfolio/nfts": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.01", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Multi-chain NFT holdings with metadata.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", networks: "base-mainnet" }, inputSchema: { properties: { address: { type: "string" }, networks: { type: "string" }, withMetadata: { type: "boolean" }, pageSize: { type: "number" }, pageKey: { type: "string" } }, required: ["address"] }, output: { example: { address: "0xd8dA...", total_count: 12, returned_count: 12, nfts: [] }, schema: { properties: { address: { type: "string" }, total_count: { type: "number" }, nfts: { type: "array" } } } } }) },
      },
      "POST /api/v1/contract/read": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.002", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Call any view/pure function on any EVM contract.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", method: "balanceOf(address)", args: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] }, inputSchema: { properties: { chain: { type: "string" }, address: { type: "string" }, method: { type: "string" }, args: { type: "array" }, abi: { type: "array" } }, required: ["address", "method"] }, bodyType: "json", output: { example: { chain: "base-mainnet", address: "0x833...", method: "balanceOf(address)", result: "1000000" }, schema: { properties: { chain: { type: "string" }, result: {} } } } }) },
      },
      "POST /api/v1/contract/write": {
        accepts: [{ scheme: "exact", price: "$0.015", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.015", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "Encode and broadcast a transaction via an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", method: "transfer(address,uint256)", args: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "1000000"], walletId: "wallet_abc" }, inputSchema: { properties: { chain: { type: "string" }, address: { type: "string" }, method: { type: "string" }, args: { type: "array" }, abi: { type: "array" }, value: { type: "string" }, walletId: { type: "string" }, privateKey: { type: "string" } }, required: ["address", "method"] }, bodyType: "json", output: { example: { tx_hash: "0xabc...", from: "0x...", explorer: "https://basescan.org/tx/0xabc..." }, schema: { properties: { tx_hash: { type: "string" }, from: { type: "string" }, explorer: { type: "string" } } } } }) },
      },
      "GET /api/v1/defi/positions": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }, { scheme: "exact", price: "$0.02", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO }],
        description: "On-chain DeFi positions across Aave V3, Compound V3, Aerodrome on Base.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "base-mainnet" }, inputSchema: { properties: { address: { type: "string" }, chain: { type: "string" } }, required: ["address"] }, output: { example: { address: "0xd8dA...", chain: "base-mainnet", total_positions: 3, protocols_with_exposure: ["aave-v3", "aerodrome"], positions: [] }, schema: { properties: { address: { type: "string" }, total_positions: { type: "number" }, positions: { type: "array" } } } } }) },
      },
      "GET /api/v1/trust/score": {
        accepts: [
          { scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO },
          { scheme: "exact", price: "$0.03", network: SOLANA_NETWORK, payTo: SOLANA_PAY_TO },
        ],
        description: "Multi-dimensional wallet/agent trust score via ProofLayer. Financial, reliability, trust, social axes + XMTP reputation + on-chain signals.",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            input: { address: "0x..." },
            inputSchema: {
              properties: { address: { type: "string" } },
              required: ["address"],
            },
            output: {
              example: { overall: 72, verdict: "Trusted", tier: "Silver", breakdown: { financial: 70, reliability: 70, trust: 80, social: 66 } },
              schema: {
                properties: {
                  overall: { type: "number" },
                  verdict: { type: "string" },
                  tier: { type: "string" },
                  breakdown: { type: "object" },
                },
              },
            },
          }),
        },
      },
};

const PAID_COUNT = Object.keys(paidRoutes).length;

const FREE_ENDPOINTS = {
  "GET /": "Info",
  "GET /health": "Health",
  "GET /stats": "Stats",
  "GET /.well-known/x402.json": "Discovery",
  "GET /api/v1/tokens": "Tokens",
  "GET /api/v1/gpu/models": "GPU Models",
  "POST /api/v1/robots/register": "Register Robot (RTP)",
  "POST /api/v1/robots/complete": "Report Task Complete (RTP)",
  "PATCH /api/v1/robots/update": "Update Robot (RTP)",
  "POST /api/v1/robots/deregister": "Remove Robot (RTP)",
  "GET /bittensor/v1/health": "Bittensor health",
  "GET /free": "Free tier catalog",
  "GET /free/gas": "Gas prices — 7 EVM chains via Alchemy (cached 15s)",
  "GET /free/prices": "USDC/ETH/SOL spot prices (cached 60s)",
  "GET /free/chain-status": "Block height & liveness — 7 EVM chains (cached 30s)",
  "GET /free/nonce": "EVM nonce / tx count for address",
  "GET /free/validate-address": "Multi-chain address checksum validation",
  "POST /free/validate-batch": "BPA 1.0 payload schema validation",
  "GET /free/estimate-batch": "Rough batch cost estimate (no live quote)",
  "GET /free/resolve": "ENS & Basename → address resolution",
  "GET /free/agent-card": "ERC-8004 agent registry lookup",
  "POST /free/x402-check": "Probe URL for x402 payment support",
  "GET /free/convert": "Fiat ↔ crypto conversion (unit math + spot)",
  "GET /free/timestamp": "Current Unix timestamp",
  "GET /free/uuid": "UUID v4 generator (up to 100)",
};
const FREE_COUNT = Object.keys(FREE_ENDPOINTS).length;
const TOTAL_COUNT = PAID_COUNT + FREE_COUNT;


app.use(wrapWithSolanaBypass(paymentMiddleware(paidRoutes, server)));

app.get("/api/v1/trust/score", trustScoreHandler);
// FREE ROUTES
app.get("/api/v1/token/safety", tokenSafetyHandler);
app.get("/api/v1/address/safety", addressSafetyHandler);
app.get("/api/v1/tx/decode", txDecodeHandler);
app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 2, name: "Spraay x402 Gateway",
    description: "Full-stack DeFi infrastructure: AI, payments, swaps, oracle, bridge, payroll, invoicing, escrow, inference, analytics, communication, identity, compliance, scheduling, GPU/Compute, Search/RAG & more.",
    homepage: BASE_URL, repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK, payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/free/gas`,            method: "GET",  price: "free", category: "free-tier", description: "Gas prices across 7 EVM chains (Base, Ethereum, Arbitrum, Polygon, Optimism, Avalanche, BSC). Cached 15s. No payment required.", searchTerms: ["gas price","free gas","network fee","gwei","base fee"] },
      { resource: `${BASE_URL}/free/prices`,         method: "GET",  price: "free", category: "free-tier", description: "USDC, ETH, SOL spot prices in USD. Cached 60s. No payment required.", searchTerms: ["token price","free price","ETH price","SOL price","spot price"] },
      { resource: `${BASE_URL}/free/chain-status`,   method: "GET",  price: "free", category: "free-tier", description: "Block height and liveness for 7 EVM chains. No payment required.", searchTerms: ["chain status","block height","chain health","network status"] },
      { resource: `${BASE_URL}/free/nonce`,          method: "GET",  price: "free", category: "free-tier", description: "Transaction count (nonce) for any EVM address. No payment required.", searchTerms: ["nonce","transaction count","tx count","pending nonce"] },
      { resource: `${BASE_URL}/free/validate-address`, method: "GET", price: "free", category: "free-tier", description: "Validate blockchain address format for EVM, Solana, XRP, Stellar. Pure checksum. No payment required.", searchTerms: ["validate address","address check","checksum","verify address"] },
      { resource: `${BASE_URL}/free/validate-batch`, method: "POST", price: "free", category: "free-tier", description: "Validate a BPA 1.0 batch payment payload (schema only, no cost data). No payment required.", searchTerms: ["validate batch","BPA validation","schema check","batch preflight"] },
      { resource: `${BASE_URL}/free/estimate-batch`, method: "GET",  price: "free", category: "free-tier", description: "Rough cost estimate for batch payments by recipient count and chain. No payment required.", searchTerms: ["batch estimate","rough estimate","cost preview","free estimate"] },
      { resource: `${BASE_URL}/free/resolve`,        method: "GET",  price: "free", category: "free-tier", description: "Resolve ENS name or Basename to an address. Cached 5min. No payment required.", searchTerms: ["ENS resolve","basename","name resolution","free resolve"] },
      { resource: `${BASE_URL}/free/agent-card`,     method: "GET",  price: "free", category: "free-tier", description: "Look up AI agent registration from ERC-8004 Identity Registry on Base. No payment required.", searchTerms: ["ERC-8004","agent card","agent registry","agent identity","agent lookup"] },
      { resource: `${BASE_URL}/free/x402-check`,     method: "POST", price: "free", category: "free-tier", description: "Probe any URL to check x402 payment support, pricing, and .well-known discovery. No payment required.", searchTerms: ["x402 check","x402 probe","payment check","402 detect","x402 scan"] },
      { resource: `${BASE_URL}/free/convert`,        method: "GET",  price: "free", category: "free-tier", description: "Convert between fiat and crypto or between native units (wei/gwei/lamports/drops). No payment required.", searchTerms: ["convert","unit conversion","fiat to crypto","wei to ETH","currency convert"] },
      { resource: `${BASE_URL}/free/timestamp`,      method: "GET",  price: "free", category: "free-tier", description: "Current Unix timestamp in seconds, milliseconds, and ISO 8601. No payment required.", searchTerms: ["timestamp","unix time","current time","epoch"] },
      { resource: `${BASE_URL}/free/uuid`,           method: "GET",  price: "free", category: "free-tier", description: "Generate UUID v4 identifiers (up to 100). No payment required.", searchTerms: ["uuid","unique id","generate id","uuid v4"] },
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.04", category: "ai", description: "OpenAI-compatible chat completions across 200+ models (BlockRun + OpenRouter). Streaming, function calling, vision.", searchTerms: ["chat completion","LLM","AI chat","text generation","GPT","language model","OpenAI compatible","inference"] },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", category: "ai", description: "List all available AI models with IDs, capabilities, and pricing. Call before chat/completions to pick the right model.", searchTerms: ["list models","available models","model catalog","which models","supported models","LLM list","model pricing"] },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.02", category: "payments", description: "Batch USDC/ERC-20 payments to up to 200 recipients in one atomic, non-custodial transaction. Implements Batch Payments for Agents (BPA) 1.0.", searchTerms: ["batch payment","bulk payout","mass payout","send to many wallets","airdrop","disbursement","multi-send","pay many recipients"], spec: "https://docs.spraay.app/bpa/1.0/" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", category: "payments", description: "Estimate gas and total USDC for a batch payment before sending. Returns per-recipient breakdown. Call before batch/execute.", searchTerms: ["batch estimate","payment estimate","gas estimate","fee preview","bulk payment cost","pre-flight check","dry run"] },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.008", category: "defi", description: "Get a token swap quote across Uniswap V3, Aerodrome and other DEXes on Base.", searchTerms: ["swap quote","best swap rate","token exchange rate","DEX aggregator","get swap price","price impact"] },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", category: "defi", description: "List tokens available for swapping on Base via Uniswap V3 / Aerodrome with addresses, symbols, and decimals. Call before swap/quote.", searchTerms: ["list tokens","token list","swappable tokens","Base tokens","tradeable tokens","token discovery","ERC-20 list"] },
      { resource: `${BASE_URL}/api/v1/swap/execute`, method: "POST", price: "$0.015", category: "defi", description: "Execute a token swap on Base via the MangoSwap router (Uniswap V3 / Aerodrome).", searchTerms: ["swap tokens","exchange tokens","trade tokens","DEX swap","convert tokens","buy token","sell token"] },
      { resource: `${BASE_URL}/api/v1/oracle/prices`, method: "GET", price: "$0.008", category: "oracle", description: "Aggregated oracle price feed across multiple sources.", searchTerms: ["crypto prices","token price","price feed","ETH price","BTC price","market data","oracle"] },
      { resource: `${BASE_URL}/api/v1/oracle/gas`, method: "GET", price: "$0.005", category: "oracle", description: "Current gas prices across Base, Ethereum and supported chains with fast/standard/slow tiers. Time transactions and avoid overpaying.", searchTerms: ["gas price","gas fee","transaction cost","gwei","base fee","priority fee","network fee"] },
      { resource: `${BASE_URL}/api/v1/oracle/fx`, method: "GET", price: "$0.008", category: "oracle", description: "Live stablecoin and fiat FX rates (USDC, USDT, DAI, major fiat). Use for multi-currency payroll and cross-border payment normalization.", searchTerms: ["FX rates","exchange rates","fiat conversion","stablecoin rates","currency conversion","forex","USD to EUR"] },
      { resource: `${BASE_URL}/api/v1/bridge/quote`, method: "GET", price: "$0.05", category: "bridge", description: "Cross-chain bridge quote across LiFi-aggregated routes.", searchTerms: ["bridge","cross-chain transfer","move tokens between chains","bridge quote","interchain","cross chain swap"] },
      { resource: `${BASE_URL}/api/v1/bridge/chains`, method: "GET", price: "$0.002", category: "bridge", description: "List networks supported by the cross-chain bridge (Base, Ethereum, Solana, XRP Ledger, Stellar and more) with chain IDs. Call before bridge/quote.", searchTerms: ["supported chains","bridge chains","cross-chain networks","which chains","multichain","chain list","interoperability"] },
      { resource: `${BASE_URL}/api/v1/payroll/execute`, method: "POST", price: "$0.10", category: "payroll", description: "Run payroll: batch USDC/stablecoin payments to a list of employees or contractors in one transaction.", searchTerms: ["payroll","pay employees","pay contractors","salary payments","stablecoin payroll","recurring payouts","crypto payroll"] },
      { resource: `${BASE_URL}/api/v1/payroll/estimate`, method: "POST", price: "$0.003", category: "payroll", description: "Estimate total cost and gas for a payroll run before execution. Returns per-recipient breakdown. Call before payroll/execute.", searchTerms: ["payroll estimate","salary estimate","payment cost","payroll preview","fee estimate","payroll dry run"] },
      { resource: `${BASE_URL}/api/v1/payroll/tokens`, method: "GET", price: "$0.002", category: "payroll", description: "List stablecoins supported for payroll (USDC, USDT, DAI) across Base, Ethereum and Solana. Call before payroll/execute to pick the payout token.", searchTerms: ["payroll tokens","supported stablecoins","pay in USDC","salary token","payment currency","payroll assets"] },
      { resource: `${BASE_URL}/api/v1/invoice/create`, method: "POST", price: "$0.05", category: "invoice", description: "Create a crypto-native invoice with on-chain payment tracking in USDC on Base/Ethereum. For contractor billing, vendor payments, and AR workflows.", searchTerms: ["create invoice","crypto invoice","billing","accounts receivable","payment request","invoice generation","on-chain invoice"] },
      { resource: `${BASE_URL}/api/v1/invoice/list`, method: "GET", price: "$0.01", category: "invoice", description: "List invoices for a wallet or org with status, amounts, and payment history. For AR tracking, status monitoring, and financial reporting.", searchTerms: ["list invoices","invoice history","unpaid invoices","invoice status","outstanding payments","billing history"] },
      { resource: `${BASE_URL}/api/v1/invoice/:id`, method: "GET", price: "$0.001", category: "invoice", description: "Retrieve a single invoice by ID with payment status, recipient, amount, and on-chain settlement details. For payment verification and reconciliation.", searchTerms: ["get invoice","invoice lookup","invoice details","check payment","payment confirmation","invoice status"] },
      { resource: `${BASE_URL}/api/v1/analytics/wallet`, method: "GET", price: "$0.01", category: "analytics", description: "Wallet profile: balances, top tokens, activity tier, age, and risk signals for any address.", searchTerms: ["wallet analysis","address profile","wallet risk","wallet reputation","check wallet","due diligence","wallet score"] },
      { resource: `${BASE_URL}/api/v1/analytics/txhistory`, method: "GET", price: "$0.008", category: "analytics", description: "Full transaction history for any wallet across Base and Ethereum: decoded transfers, swaps, contract calls, and timestamps. For portfolio tracking and due diligence.", searchTerms: ["transaction history","tx history","wallet history","past transactions","on-chain activity","transfer history","defi history"] },
      { resource: `${BASE_URL}/api/v1/escrow/create`, method: "POST", price: "$0.10", category: "escrow", description: "Create an on-chain escrow holding funds until release conditions are met. Trustless conditional payment between two parties.", searchTerms: ["escrow","conditional payment","hold funds","milestone payment","trustless payment","release on completion","dispute protection"] },
      { resource: `${BASE_URL}/api/v1/escrow/list`, method: "GET", price: "$0.02", category: "escrow", description: "List active and historical escrow contracts for a wallet with status, locked amounts, counterparties, and release conditions. For contract oversight.", searchTerms: ["list escrows","active escrows","escrow status","pending payments","locked funds","contract list"] },
      { resource: `${BASE_URL}/api/v1/escrow/:id`, method: "GET", price: "$0.001", category: "escrow", description: "Retrieve a single escrow by ID with locked amount, parties, status, and release conditions. For real-time monitoring and release-trigger evaluation.", searchTerms: ["get escrow","escrow lookup","escrow details","check escrow","contract status","locked payment"] },
      { resource: `${BASE_URL}/api/v1/escrow/fund`, method: "POST", price: "$0.02", category: "escrow", description: "Deposit USDC into an existing escrow to lock funds pending conditions. Required after escrow/create and before escrow/release.", searchTerms: ["fund escrow","deposit escrow","lock funds","escrow deposit","add funds","fund contract"] },
      { resource: `${BASE_URL}/api/v1/escrow/release`, method: "POST", price: "$0.08", category: "escrow", description: "Release locked escrow funds to the recipient once conditions are met, finalizing a trustless payment. Pairs with escrow/create and escrow/fund.", searchTerms: ["release escrow","release funds","complete escrow","finalize payment","escrow payout","trustless release"] },
      { resource: `${BASE_URL}/api/v1/escrow/cancel`, method: "POST", price: "$0.02", category: "escrow", description: "Cancel an active escrow and return locked funds to the depositor. For dispute resolution, expired milestones, or abandoned-contract cleanup.", searchTerms: ["cancel escrow","refund escrow","void contract","return funds","escrow dispute","cancel payment"] },
      { resource: `${BASE_URL}/api/v1/inference/classify-address`, method: "POST", price: "$0.03", category: "inference", description: "AI classification of a wallet as EOA, contract, exchange, DeFi protocol, DAO, or bot, with risk signals. For counterparty screening and smart routing.", searchTerms: ["classify address","wallet type","address risk","is this a contract","address screening","counterparty check"] },
      { resource: `${BASE_URL}/api/v1/inference/classify-tx`, method: "POST", price: "$0.03", category: "inference", description: "AI classification of an on-chain transaction as swap, transfer, mint, bridge, liquidation, or contract call, with decoded intent and risk flags. For monitoring and accounting.", searchTerms: ["classify transaction","tx type","transaction intent","decode tx","transaction analysis","anomaly detection"] },
      { resource: `${BASE_URL}/api/v1/inference/explain-contract`, method: "POST", price: "$0.03", category: "inference", description: "Plain-language explanation of a smart contract: functions, risks, and ownership, plus security flags. For due diligence and safe-interaction checks.", searchTerms: ["explain contract","smart contract analysis","contract audit","contract risk","solidity explanation","contract review"] },
      { resource: `${BASE_URL}/api/v1/inference/summarize`, method: "POST", price: "$0.03", category: "inference", description: "AI intelligence briefing for a wallet, token, or protocol, synthesizing on-chain activity and holdings into a concise summary. For research and reporting.", searchTerms: ["summarize wallet","AI briefing","wallet summary","token summary","intelligence report","on-chain research"] },
      // Communication
      { resource: `${BASE_URL}/api/v1/notify/email`, method: "POST", price: "$0.01", category: "communication", description: "Send transactional or notification email via Resend with HTML templates and custom from address. For payment confirmations, invoice delivery, and alerts.", searchTerms: ["send email","email notification","transactional email","email alert","notify by email","email delivery"] },
      { resource: `${BASE_URL}/api/v1/notify/sms`, method: "POST", price: "$0.02", category: "communication", description: "Send SMS text messages via Twilio. For payment alerts, 2FA codes, on-chain event notifications, and urgent agent-to-human messaging.", searchTerms: ["send SMS","text message","SMS notification","text alert","notify by SMS","mobile notification"] },
      { resource: `${BASE_URL}/api/v1/notify/status`, method: "GET", price: "$0.002", category: "communication", description: "Check delivery status of a sent email or SMS (delivered, bounced, or pending). For delivery confirmation and retry logic.", searchTerms: ["notification status","email status","SMS status","delivery confirmation","message delivered","check notification"] },
      { resource: `${BASE_URL}/api/v1/webhook/register`, method: "POST", price: "$0.01", category: "communication", description: "Register a webhook to receive real-time event callbacks for payments, on-chain events, and job completions.", searchTerms: ["webhook", "event callback", "subscribe to events", "register webhook", "push notification", "event listener", "real-time events"] },
      { resource: `${BASE_URL}/api/v1/webhook/test`, method: "POST", price: "$0.005", category: "communication", description: "Send a test event to a registered webhook to verify delivery and payload format.", searchTerms: ["test webhook", "webhook test", "verify callback", "ping webhook", "debug webhook", "test event"] },
      { resource: `${BASE_URL}/api/v1/webhook/list`, method: "GET", price: "$0.002", category: "communication", description: "List all registered webhooks with their URLs, subscribed events, and status.", searchTerms: ["list webhooks", "my webhooks", "webhook list", "registered callbacks", "view webhooks"] },
      { resource: `${BASE_URL}/api/v1/webhook/delete`, method: "POST", price: "$0.002", category: "communication", description: "Delete a registered webhook to stop receiving its event callbacks.", searchTerms: ["delete webhook", "remove webhook", "unsubscribe", "cancel webhook", "stop callbacks"] },
      { resource: `${BASE_URL}/api/v1/xmtp/send`, method: "POST", price: "$0.01", category: "communication", description: "Send an end-to-end encrypted wallet-to-wallet message via XMTP. For agent-to-agent and agent-to-human messaging.", searchTerms: ["XMTP", "encrypted message", "wallet messaging", "web3 dm", "send message to wallet", "agent messaging", "decentralized chat"] },
      { resource: `${BASE_URL}/api/v1/xmtp/inbox`, method: "GET", price: "$0.01", category: "communication", description: "Read encrypted XMTP messages for a wallet address. For agent inboxes and wallet-to-wallet conversations.", searchTerms: ["XMTP inbox", "read messages", "wallet inbox", "web3 messages", "check dms", "encrypted inbox"] },
      // Infrastructure
      { resource: `${BASE_URL}/api/v1/rpc/call`, method: "POST", price: "$0.001", category: "infrastructure", description: "Make a raw JSON-RPC call to Base, Ethereum, and other supported chains. Premium multi-chain node access without running your own.", searchTerms: ["RPC", "JSON-RPC", "node access", "eth_call", "blockchain query", "read chain state", "Infura alternative", "Alchemy alternative"] },
      { resource: `${BASE_URL}/api/v1/rpc/chains`, method: "GET", price: "$0.001", category: "infrastructure", description: "List chains supported by the multi-chain RPC endpoint with their IDs and allowed methods. Call before rpc/call.", searchTerms: ["RPC chains", "supported networks", "chain list", "available chains", "node networks"] },
      { resource: `${BASE_URL}/api/v1/storage/pin`, method: "POST", price: "$0.01", category: "infrastructure", description: "Pin content to IPFS or Arweave for permanent decentralized storage. Returns a CID for retrieval.", searchTerms: ["IPFS", "Arweave", "pin file", "decentralized storage", "store data permanently", "upload to IPFS", "content addressing", "pin content"] },
      { resource: `${BASE_URL}/api/v1/storage/get`, method: "GET", price: "$0.005", category: "infrastructure", description: "Retrieve content from IPFS or Arweave by CID. Pairs with storage/pin.", searchTerms: ["IPFS get", "retrieve from IPFS", "fetch by CID", "read decentralized storage", "download pinned content"] },
      { resource: `${BASE_URL}/api/v1/storage/status`, method: "GET", price: "$0.002", category: "infrastructure", description: "Check the pin status of content on IPFS or Arweave (pinned, pending, or failed).", searchTerms: ["pin status", "IPFS status", "storage status", "check pin", "pinning state"] },
      { resource: `${BASE_URL}/api/v1/cron/create`, method: "POST", price: "$0.01", category: "infrastructure", description: "Schedule a recurring or one-time job (payments, API calls, on-chain actions) with cron syntax. For automation and recurring payouts.", searchTerms: ["cron", "schedule job", "recurring task", "automate", "scheduled payment", "timer", "recurring payout", "task scheduler"] },
      { resource: `${BASE_URL}/api/v1/cron/list`, method: "GET", price: "$0.002", category: "infrastructure", description: "List scheduled cron jobs with their schedules, actions, and next run times.", searchTerms: ["list cron jobs", "scheduled tasks", "my jobs", "view schedules", "recurring jobs"] },
      { resource: `${BASE_URL}/api/v1/cron/cancel`, method: "POST", price: "$0.002", category: "infrastructure", description: "Cancel a scheduled cron job so it no longer runs.", searchTerms: ["cancel cron", "stop scheduled job", "remove job", "delete schedule", "unschedule"] },
      { resource: `${BASE_URL}/api/v1/logs/ingest`, method: "POST", price: "$0.002", category: "infrastructure", description: "Ingest structured log entries for agent observability and audit trails. Batch up to many entries per call.", searchTerms: ["ingest logs", "log events", "structured logging", "observability", "send logs", "agent logging", "telemetry"] },
      { resource: `${BASE_URL}/api/v1/logs/query`, method: "GET", price: "$0.005", category: "infrastructure", description: "Query ingested structured logs by service, level, and time range. For debugging and monitoring agent activity.", searchTerms: ["query logs", "search logs", "log search", "read logs", "debug logs", "monitoring", "log analytics"] },
      // Identity & Access
      { resource: `${BASE_URL}/api/v1/kyc/verify`, method: "POST", price: "$0.02", category: "identity", description: "Screen a wallet or person against OFAC sanctions lists for compliance. Returns risk result and match details.", searchTerms: ["KYC", "sanctions screening", "OFAC", "compliance check", "AML", "know your customer", "watchlist screening", "wallet screening"] },
      { resource: `${BASE_URL}/api/v1/kyc/status`, method: "GET", price: "$0.01", category: "identity", description: "Check the status and result of a previously submitted KYC/sanctions verification.", searchTerms: ["KYC status", "verification status", "compliance status", "screening result", "check KYC"] },
      { resource: `${BASE_URL}/api/v1/auth/session`, method: "POST", price: "$0.01", category: "identity", description: "Create an authenticated session token with scoped permissions and TTL for an address. For agent auth and delegated access.", searchTerms: ["auth session", "create session", "login", "access token", "session token", "authentication", "delegated access", "API session"] },
      { resource: `${BASE_URL}/api/v1/auth/verify`, method: "GET", price: "$0.005", category: "identity", description: "Verify a session token and return its validity and granted permissions.", searchTerms: ["verify token", "validate session", "check auth", "token verification", "auth check"] },
      // Compliance
      { resource: `${BASE_URL}/api/v1/audit/log`, method: "POST", price: "$0.001", category: "compliance", description: "Record an immutable audit-trail entry (action, actor, resource) for compliance and accountability.", searchTerms: ["audit log", "audit trail", "compliance record", "activity log", "record action", "accountability", "immutable log"] },
      { resource: `${BASE_URL}/api/v1/audit/query`, method: "GET", price: "$0.03", category: "compliance", description: "Query the audit trail by actor, action, and time range for compliance reporting and investigations.", searchTerms: ["query audit", "audit search", "compliance report", "activity history", "investigate actions", "audit trail lookup"] },
      { resource: `${BASE_URL}/api/v1/tax/calculate`, method: "POST", price: "$0.08", category: "compliance", description: "Calculate crypto capital gains and losses using FIFO accounting across a set of transactions. For tax reporting.", searchTerms: ["crypto tax", "capital gains", "FIFO", "tax calculation", "gain loss", "cost basis", "tax accounting", "calculate taxes"] },
      { resource: `${BASE_URL}/api/v1/tax/report`, method: "GET", price: "$0.05", category: "compliance", description: "Generate an IRS Form 8949-compatible tax report from calculated gain/loss events.", searchTerms: ["tax report", "IRS 8949", "crypto tax report", "capital gains report", "tax form", "8949", "tax filing"] },
      // GPU/Compute
      { resource: `${BASE_URL}/api/v1/gpu/run`, method: "POST", price: "$0.06", category: "gpu", description: "Run GPU inference via Replicate: image, video, audio, and LLM workloads.", searchTerms: ["GPU inference","run AI model","image generation","video generation","model inference","Replicate","run model"] },
      { resource: `${BASE_URL}/api/v1/gpu/status/:id`, method: "GET", price: "$0.005", category: "gpu", description: "Poll the status of a GPU prediction job by ID and retrieve output when complete. Call after gpu/run.", searchTerms: ["GPU status", "prediction status", "job status", "check GPU job", "Replicate status", "inference status", "poll job"] },
      { resource: `${BASE_URL}/api/v1/gpu/models`, method: "GET", price: "free", category: "gpu", description: "Free discovery endpoint listing available GPU model shortcuts (image, video, LLM, audio) with pricing. Call before gpu/run.", searchTerms: ["GPU models", "available models", "model list", "Replicate models", "model catalog", "which GPU models"] },
      // Search/RAG
      { resource: `${BASE_URL}/api/v1/search/web`, method: "POST", price: "$0.02", category: "search", description: "Web search powered by Tavily. Returns ranked URLs with snippets.", searchTerms: ["web search","search the internet","google search","find URLs","web results","search engine"] },
      { resource: `${BASE_URL}/api/v1/search/extract`, method: "POST", price: "$0.02", category: "search", description: "Extract clean, LLM-ready text content from a list of URLs. For RAG pipelines and web scraping.", searchTerms: ["extract content", "scrape URL", "web scraping", "clean text", "RAG", "extract article", "url to text", "content extraction"] },
      { resource: `${BASE_URL}/api/v1/search/qna`, method: "POST", price: "$0.03", category: "search", description: "Question answering over fresh web results. Retrieval-augmented generation (RAG) out of the box.", searchTerms: ["question answering","RAG","ask the web","AI search","answer questions","retrieval augmented generation"] },
      // Robotics / RTP
      { resource: `${BASE_URL}/api/v1/robots/register`, method: "POST", price: "free", category: "rtp", description: "Register a robot on the Robot Task Protocol (RTP) network with its capabilities and pricing. Free to register.", searchTerms: ["register robot", "RTP", "robot network", "add robot", "robot onboarding", "physical robot", "robotics"], rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/task`, method: "POST", price: "$0.05", category: "rtp", rtp: { version: "1.0", description: "Dispatch paid task to robot" } },
      { resource: `${BASE_URL}/api/v1/robots/complete`, method: "POST", price: "free", category: "rtp", description: "Report completion of an RTP robot task and trigger escrow release. Called by the robot.", searchTerms: ["complete task", "robot task done", "RTP complete", "report completion", "finish robot task"], rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/list`, method: "GET", price: "$0.005", category: "rtp", rtp: { version: "1.0", description: "Discover robots by capability" } },
      { resource: `${BASE_URL}/api/v1/robots/status`, method: "GET", price: "$0.002", category: "rtp", description: "Poll the status of a dispatched RTP robot task (pending, in-progress, complete) and retrieve results.", searchTerms: ["robot task status", "RTP status", "task progress", "check robot task", "poll task"], rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/profile`, method: "GET", price: "$0.002", category: "rtp", description: "Get the full capability profile of an RTP robot — supported tasks, pricing, and location.", searchTerms: ["robot profile", "robot capabilities", "RTP profile", "robot details", "what can robot do"], rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/update`, method: "PATCH", price: "free", category: "rtp", description: "Update an RTP robot's capabilities, pricing, or availability. Free for registered operators.", searchTerms: ["update robot", "edit robot", "change robot pricing", "robot availability", "modify robot"], rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/deregister`, method: "POST", price: "free", category: "rtp", description: "Remove a robot from the RTP network so it no longer receives tasks. Free.", searchTerms: ["deregister robot", "remove robot", "offboard robot", "delete robot", "take robot offline"], rtp: { version: "1.0" } },
      // Agent Wallet (Category 17)
      { resource: `${BASE_URL}/api/v1/agent-wallet/provision`, method: "POST", price: "$0.05", category: "agent-wallet", description: "Provision a smart-contract wallet for an AI agent on Base, with programmable spending controls. Non-custodial.", searchTerms: ["agent wallet", "smart wallet", "provision wallet", "create agent wallet", "AI agent wallet", "smart account", "ERC-4337", "account abstraction"] },
      { resource: `${BASE_URL}/api/v1/agent-wallet/session-key`, method: "POST", price: "$0.02", category: "agent-wallet", description: "Add a session key to an agent wallet with spending limits and an expiry. For safe delegated, time-boxed spending.", searchTerms: ["session key", "spending limit", "delegated key", "scoped permissions", "agent spending control", "time-boxed key", "spend cap"] },
      { resource: `${BASE_URL}/api/v1/agent-wallet/info`, method: "GET", price: "$0.005", category: "agent-wallet", description: "Get an agent wallet's address, balance, and active session keys.", searchTerms: ["agent wallet info", "wallet balance", "wallet details", "check agent wallet", "wallet status"] },
      { resource: `${BASE_URL}/api/v1/agent-wallet/revoke-key`, method: "POST", price: "$0.02", category: "agent-wallet", description: "Revoke a session key on an agent wallet, immediately ending its spending authority.", searchTerms: ["revoke key", "revoke session", "kill key", "remove spending key", "disable session key", "emergency revoke"] },
      { resource: `${BASE_URL}/api/v1/agent-wallet/predict`, method: "GET", price: "$0.001", category: "agent-wallet", description: "Predict the counterfactual address of an agent wallet before it's deployed. For pre-funding and address reservation.", searchTerms: ["predict address", "counterfactual address", "wallet address before deploy", "precompute address", "reserve address"] },
      // Existing data
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", category: "defi", description: "Live token prices for one or many tokens, sourced from on-chain and market feeds.", searchTerms: ["token price", "crypto price", "live prices", "price lookup", "market price", "get price", "token value"] },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.005", category: "data", description: "Get all ERC-20 and native token balances for a wallet address on Base and Ethereum.", searchTerms: ["token balances", "wallet balance", "check balance", "ERC-20 balances", "holdings", "what tokens", "wallet holdings"] },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.002", category: "identity", description: "Resolve an ENS name or Base name to its wallet address (and reverse). For human-readable addresses.", searchTerms: ["ENS", "Basename", "resolve name", "name to address", "ENS lookup", ".eth", "reverse resolve", "human readable address"] },
      { resource: `${BASE_URL}/api/v1/tokens`, method: "GET", price: "free", category: "discovery", description: "Free discovery endpoint listing supported tokens with addresses, symbols, and decimals across chains.", searchTerms: ["token list", "supported tokens", "token directory", "ERC-20 list", "available tokens", "token addresses"] },
      // Supply Chain / SCTP (Category 18)
      { resource: `${BASE_URL}/api/v1/sctp/supplier`, method: "POST", price: "$0.02", category: "supply-chain", description: "Register a supplier in the Supply Chain Trade Protocol (SCTP) with wallet and payment preferences.", searchTerms: ["register supplier", "SCTP", "supply chain", "vendor onboarding", "add supplier", "trade protocol", "B2B payments"], sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/supplier/:id`, method: "GET", price: "$0.005", category: "supply-chain", description: "Get details for a registered SCTP supplier by ID.", searchTerms: ["supplier details", "get supplier", "SCTP supplier", "vendor info", "supplier lookup"], sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/po`, method: "POST", price: "$0.02", category: "supply-chain", description: "Create a purchase order in SCTP with line items and currency. For B2B procurement and trade.", searchTerms: ["purchase order", "create PO", "procurement", "SCTP PO", "B2B order", "trade order", "supply chain order"], sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/po/:id`, method: "GET", price: "$0.005", category: "supply-chain", description: "Get details for an SCTP purchase order by ID.", searchTerms: ["purchase order details", "get PO", "SCTP PO lookup", "order status", "view PO"], sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/invoice`, method: "POST", price: "$0.02", category: "supply-chain", description: "Submit an invoice against an SCTP purchase order for verification and payment.", searchTerms: ["submit invoice", "SCTP invoice", "supplier invoice", "B2B invoice", "trade invoice", "bill against PO"], sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/invoice/:id`, method: "GET", price: "$0.005", category: "supply-chain", description: "Get an SCTP invoice by ID with its verification result and payment status.", searchTerms: ["invoice details", "get invoice", "SCTP invoice lookup", "invoice status", "view invoice"], sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/invoice/verify`, method: "POST", price: "$0.03", category: "supply-chain", sctp: { version: "0.1", description: "AI-powered invoice verification" } },
      { resource: `${BASE_URL}/api/v1/sctp/pay`, method: "POST", price: "$0.10", category: "supply-chain", sctp: { version: "0.1", description: "Execute supplier payment via Spraay batch contracts" } },
      // Bittensor Drop-in API (Category 19)
      { resource: `${BASE_URL}/bittensor/v1/models`, method: "GET", price: "$0.001", category: "bittensor", description: "List decentralized AI models available via Bittensor (SN64). OpenAI-compatible model catalog. Call before bittensor/chat/completions to pick a model.", searchTerms: ["bittensor models","decentralized models","TAO models","SN64","permissionless LLM","list models","model catalog"], bittensor: { openaiCompat: true, description: "List decentralized AI models" } },
      { resource: `${BASE_URL}/bittensor/v1/chat/completions`, method: "POST", price: "$0.03", category: "bittensor", description: "OpenAI-compatible chat completions routed through the Bittensor SN64 decentralized inference network. Drop-in replacement for OpenAI /v1/chat/completions for censorship-resistant, permissionless LLM access.", searchTerms: ["bittensor chat","decentralized inference","permissionless LLM","SN64","TAO inference","censorship resistant AI","OpenAI compatible"], bittensor: { openaiCompat: true, description: "Chat completions via Bittensor SN64" } },
      { resource: `${BASE_URL}/bittensor/v1/images/generations`, method: "POST", price: "$0.05", category: "bittensor", description: "Decentralized text-to-image generation via the Bittensor SN19 network. OpenAI-compatible image generation endpoint for permissionless, pay-per-use AI art.", searchTerms: ["bittensor images","decentralized image generation","text to image","SN19","TAO image","permissionless AI art","OpenAI compatible"], bittensor: { openaiCompat: true, description: "Image generation via Bittensor SN19" } },
      { resource: `${BASE_URL}/bittensor/v1/embeddings`, method: "POST", price: "$0.005", category: "bittensor", description: "Decentralized text embeddings via Bittensor. OpenAI-compatible embeddings endpoint for RAG pipelines, semantic search, and vector indexing without centralized providers.", searchTerms: ["bittensor embeddings","decentralized embeddings","text embeddings","vector embeddings","RAG","semantic search","TAO embeddings"], bittensor: { openaiCompat: true, description: "Text embeddings via Bittensor" } },
      // Compute Services
      { resource: `${BASE_URL}/api/v1/compute/text-inference`, method: "POST", price: "$0.003-$0.10", category: "compute", description: "LLM text inference and chat completion via 11+ models across Chutes and OpenRouter (GPT-4o, Claude, Llama 3, Mistral). For agent reasoning, summarization, and code generation.", searchTerms: ["LLM","chat completion","text generation","language model","AI reasoning","code generation","inference"], compute: { type: "text-inference", searchTerms: ["LLM", "chat completion", "text generation"], models: 11, providers: ["chutes", "openrouter"] } },
      { resource: `${BASE_URL}/api/v1/compute/image-generation`, method: "POST", price: "$0.02-$0.08", category: "compute", description: "Text-to-image generation via 4 models on Replicate including FLUX and SDXL. For agent-generated art, marketing assets, and visual content.", searchTerms: ["text to image","AI image generation","FLUX","SDXL","image synthesis","generate image","AI art"], compute: { type: "image-generation", searchTerms: ["text to image", "AI image generation", "FLUX"], models: 4, providers: ["replicate"] } },
      { resource: `${BASE_URL}/api/v1/compute/video-generation`, method: "POST", price: "$0.40-$0.50", category: "compute", description: "Text-to-video generation via 2 models on Replicate. For agent-generated video clips, marketing content, and animated visuals.", searchTerms: ["text to video","AI video generation","video synthesis","generate video","AI video","video model"], compute: { type: "video-generation", searchTerms: ["text to video", "AI video generation"], models: 2, providers: ["replicate"] } },
      { resource: `${BASE_URL}/api/v1/compute/text-to-speech`, method: "POST", price: "$0.03-$0.05", category: "compute", compute: { type: "text-to-speech", searchTerms: ["TTS", "voice synthesis", "text to speech"], models: 2, providers: ["replicate"] } },
      { resource: `${BASE_URL}/api/v1/compute/speech-to-text`, method: "POST", price: "$0.02", category: "compute", compute: { type: "speech-to-text", searchTerms: ["STT", "transcription", "speech recognition", "whisper"], models: 1, providers: ["replicate"] } },
      { resource: `${BASE_URL}/api/v1/compute/embeddings`, method: "POST", price: "$0.005", category: "compute", compute: { type: "embeddings", searchTerms: ["text embeddings", "vector embeddings", "RAG", "semantic search"], models: 1, providers: ["chutes"] } },
      { resource: `${BASE_URL}/api/v1/compute/batch`, method: "POST", price: "varies", category: "compute", description: "Submit up to 50 compute jobs in one batch (text, image, audio, embeddings) at a 10% discount. For high-throughput agent workloads and bulk processing.", searchTerms: ["batch inference","bulk compute","batch jobs","mass inference","bulk processing","compute batch","high throughput"], compute: { type: "batch", searchTerms: ["batch inference", "bulk compute"], maxJobs: 50, discount: "10%" } },
      { resource: `${BASE_URL}/api/v1/compute/status/:jobId`, method: "GET", price: "$0.001", category: "compute", description: "Poll the status of a compute job by jobId (processing, succeeded, or failed) and retrieve output when complete. Call after any async compute request.", searchTerms: ["compute status","job status","inference status","check job","async result","poll job","model output"] },
      { resource: `${BASE_URL}/api/v1/compute/models`, method: "GET", price: "free", category: "compute", description: "Free discovery endpoint listing all compute models across text, image, video, speech, and embeddings with pricing. Call first to pick the right model and provider.", searchTerms: ["compute models","available models","model catalog","list models","model pricing","which models","model discovery"], compute: { description: "List all available compute models with pricing" } },
      { resource: `${BASE_URL}/api/v1/compute/estimate`, method: "POST", price: "free", category: "compute", description: "Free price estimation for a compute job before committing. Returns expected cost by model and input size. Call before any paid compute request to validate budget.", searchTerms: ["compute estimate","price estimate","cost preview","inference cost","estimate price","pre-flight check","budget check"], compute: { description: "Price estimation before committing" } },
      // Compute Futures (prepaid compute credits, escrow-backed)
      { resource: `${BASE_URL}/api/v1/compute-futures/deposit`, method: "POST", price: "$0.01", category: "compute-futures", description: "Deposit USDC to open a prepaid compute credit account with tier discounts ($10+ 5%, $50+ 10%, $200+ 15%). Draw down per inference and refund unused balance anytime. USDC on Base or Solana.", searchTerms: ["compute futures","prepay compute","compute credits","lock compute price","bulk compute discount","prepaid inference","hedge inference cost"] },
      { resource: `${BASE_URL}/api/v1/compute-futures/balance`, method: "GET", price: "$0.001", category: "compute-futures", description: "Check remaining compute credit balance, tier, discount, and usage stats for a futures account (CFE ID).", searchTerms: ["compute balance","prepaid balance","credit balance","remaining compute","futures balance","compute credit"] },
      { resource: `${BASE_URL}/api/v1/compute-futures/execute`, method: "POST", price: "$0.001", category: "compute-futures", description: "Run a compute job (text-inference, image-gen, video-gen, TTS, STT, embeddings) and deduct cost from the prepaid balance instead of paying per call. Tier discount applied automatically.", searchTerms: ["execute compute futures","use prepaid compute","draw down credit","run job from credit","redeem compute","prepaid inference run"] },
      { resource: `${BASE_URL}/api/v1/compute-futures/history`, method: "GET", price: "$0.002", category: "compute-futures", description: "Full usage ledger for a compute futures account: every job, model, price, and balance change. For accounting and reconciliation.", searchTerms: ["compute history","usage ledger","futures history","usage history","compute accounting","prepaid usage"] },
      { resource: `${BASE_URL}/api/v1/compute-futures/refund`, method: "POST", price: "$0.01", category: "compute-futures", description: "Refund the unused compute credit balance back to the original depositor. Only the depositor can request a refund.", searchTerms: ["refund compute","reclaim prepaid","return credit","withdraw unused","cancel compute futures","unwind credit"] },
      { resource: `${BASE_URL}/api/v1/compute-futures/pricing`, method: "GET", price: "$0.001", category: "compute-futures", description: "Compute futures pricing: tier discounts, per-model costs, and bulk discount info. Call before deposit to evaluate tiers.", searchTerms: ["compute futures pricing","tier discounts","per-model cost","bulk discount","compute rates","prepaid pricing"] },
      // XRP Ledger (Chain #15)
      { resource: `${BASE_URL}/api/v1/xrp/batch`, method: "POST", price: "$0.02", category: "payments", description: "Send batch XRP payments to many recipients in one transaction on the XRP Ledger.", searchTerms: ["XRP batch", "XRP Ledger", "batch XRP", "mass XRP payout", "ripple payments", "XRP disbursement", "send XRP to many"], chain: "xrp-ledger" },
      { resource: `${BASE_URL}/api/v1/xrp/estimate`, method: "POST", price: "$0.001", category: "payments", description: "Estimate fees for a batch XRP payment before sending on the XRP Ledger.", searchTerms: ["XRP estimate", "XRP fee", "ripple fee estimate", "XRP batch cost", "preview XRP payment"], chain: "xrp-ledger" },
      { resource: `${BASE_URL}/api/v1/xrp/info`, method: "GET", price: "$0.001", category: "payments", description: "Get current XRP Ledger network info — base fee and reserve requirements.", searchTerms: ["XRP info", "XRP Ledger fee", "ripple network", "XRP reserve", "base fee", "ledger info"], chain: "xrp-ledger" },
      // Stellar (Chain #14)
      { resource: `${BASE_URL}/api/v1/stellar/batch`, method: "POST", price: "$0.02", category: "payments", description: "Send batch payments to many recipients in one transaction on the Stellar network.", searchTerms: ["Stellar batch", "XLM payments", "batch Stellar", "mass Stellar payout", "Stellar disbursement", "send XLM to many", "lumens"], chain: "stellar" },
      { resource: `${BASE_URL}/api/v1/stellar/estimate`, method: "POST", price: "$0.001", category: "payments", description: "Estimate fees for a batch Stellar payment before sending.", searchTerms: ["Stellar estimate", "XLM fee", "Stellar batch cost", "preview Stellar payment", "lumens fee"], chain: "stellar" },
      // Research & Reference (Category 24)
      { resource: `${BASE_URL}/api/v1/research/dictionary/define`, method: "GET", price: "$0.001", category: "research", description: "Dictionary definition with phonetics and examples.", searchTerms: ["dictionary", "definition", "define word", "meaning"] },
      { resource: `${BASE_URL}/api/v1/research/dictionary/synonyms`, method: "GET", price: "$0.001", category: "research", description: "Synonyms and antonyms for a word.", searchTerms: ["synonyms", "antonyms", "thesaurus"] },
      { resource: `${BASE_URL}/api/v1/research/dictionary/phonetics`, method: "GET", price: "$0.001", category: "research", description: "Phonetic transcription and audio URL.", searchTerms: ["phonetics", "pronunciation", "IPA"] },
      { resource: `${BASE_URL}/api/v1/research/papers/search`, method: "GET", price: "$0.002", category: "research", description: "Search 250M+ academic papers (OpenAlex CC0).", searchTerms: ["academic papers", "research search", "OpenAlex", "scholarly"] },
      { resource: `${BASE_URL}/api/v1/research/papers/by-doi`, method: "GET", price: "$0.001", category: "research", description: "Paper metadata by DOI (OpenAlex).", searchTerms: ["paper by DOI", "DOI lookup", "citation metadata"] },
      { resource: `${BASE_URL}/api/v1/research/papers/by-author`, method: "GET", price: "$0.002", category: "research", description: "Papers by author name or ORCID (OpenAlex).", searchTerms: ["papers by author", "ORCID", "author search"] },
      { resource: `${BASE_URL}/api/v1/research/papers/citations`, method: "GET", price: "$0.002", category: "research", description: "Citation graph - cited-by count and references.", searchTerms: ["citations", "cited by", "citation graph"] },
      { resource: `${BASE_URL}/api/v1/research/papers/trending`, method: "GET", price: "$0.002", category: "research", description: "Trending papers by topic in the last N days.", searchTerms: ["trending papers", "hot papers", "popular research"] },
      { resource: `${BASE_URL}/api/v1/research/preprints/search`, method: "GET", price: "$0.002", category: "research", description: "Search arXiv preprints by keyword and category.", searchTerms: ["arXiv", "preprints", "preprint search"] },
      { resource: `${BASE_URL}/api/v1/research/preprints/by-id`, method: "GET", price: "$0.001", category: "research", description: "arXiv preprint metadata by ID.", searchTerms: ["arXiv id", "preprint lookup"] },
      { resource: `${BASE_URL}/api/v1/research/preprints/recent`, method: "GET", price: "$0.002", category: "research", description: "Latest arXiv preprints by category.", searchTerms: ["recent preprints", "new arXiv", "latest research"] },
      { resource: `${BASE_URL}/api/v1/research/scholarly/by-doi`, method: "GET", price: "$0.001", category: "research", description: "Full Crossref metadata for any DOI.", searchTerms: ["Crossref", "DOI metadata", "scholarly record"] },
      { resource: `${BASE_URL}/api/v1/research/scholarly/search`, method: "GET", price: "$0.002", category: "research", description: "Search 150M+ works via Crossref (CC0).", searchTerms: ["Crossref search", "scholarly works", "literature search"] },
      { resource: `${BASE_URL}/api/v1/research/scholarly/citations-count`, method: "GET", price: "$0.001", category: "research", description: "Citation count and references for a DOI.", searchTerms: ["citation count", "reference count", "impact"] },
      { resource: `${BASE_URL}/api/v1/research/scholarly/journal-info`, method: "GET", price: "$0.001", category: "research", description: "Journal metadata by ISSN.", searchTerms: ["journal", "ISSN", "journal metadata"] },
      { resource: `${BASE_URL}/api/v1/research/chemistry/compound`, method: "GET", price: "$0.002", category: "research", description: "PubChem compound by name, formula, or CID.", searchTerms: ["PubChem", "chemical compound", "molecule", "CID"] },
      { resource: `${BASE_URL}/api/v1/research/chemistry/similarity`, method: "GET", price: "$0.002", category: "research", description: "Find structurally similar compounds in PubChem.", searchTerms: ["compound similarity", "structure search", "cheminformatics"] },
      { resource: `${BASE_URL}/api/v1/research/chemistry/bioactivity`, method: "GET", price: "$0.002", category: "research", description: "Biological assay results for a PubChem compound.", searchTerms: ["bioactivity", "assay", "drug screening"] },
      { resource: `${BASE_URL}/api/v1/research/biomedical/search`, method: "GET", price: "$0.002", category: "research", description: "Search 36M+ biomedical papers in PubMed.", searchTerms: ["PubMed", "biomedical search", "medical literature"] },
      { resource: `${BASE_URL}/api/v1/research/biomedical/by-pmid`, method: "GET", price: "$0.001", category: "research", description: "Paper metadata by PubMed ID.", searchTerms: ["PMID", "PubMed lookup", "medical paper"] },
      { resource: `${BASE_URL}/api/v1/research/biomedical/related`, method: "GET", price: "$0.002", category: "research", description: "Related articles for a PubMed ID.", searchTerms: ["related articles", "similar papers", "PubMed related"] },
      { resource: `${BASE_URL}/api/v1/research/demographics/census`, method: "GET", price: "$0.001", category: "research", description: "US Census data by state, county, or zip.", searchTerms: ["census", "demographics", "population data"] },
      { resource: `${BASE_URL}/api/v1/research/demographics/datasets`, method: "GET", price: "$0.001", category: "research", description: "Search Data.gov datasets by keyword.", searchTerms: ["Data.gov", "open data", "government datasets"] },
      // Free — Token Safety
      { resource: `${BASE_URL}/api/v1/token/safety`, method: "GET", price: "free", category: "defi", description: "Free pre-trade token safety check — honeypot, sell tax, mint/blacklist, proxy risk. GoPlus-powered with Spraay severity scoring. Called before every trade.", searchTerms: ["token safety","honeypot","scam check","sell tax","rug pull","token security","is it safe","can I sell","buy tax","token risk"] },
      // Free — Address Safety
      { resource: `${BASE_URL}/api/v1/address/safety`, method: "GET", price: "free", category: "payments", description: "Free address safety screen — phishing, sanctions, exploits, mixer usage, malicious contracts. Screen recipients before sending funds.", searchTerms: ["address safety","malicious address","phishing","sanctions check","wallet check","is address safe","recipient check","AML","scam address","blacklist"] },
      // Paid — Trust Score
      { resource: `${BASE_URL}/api/v1/trust/score`, method: "GET", price: "$0.03", category: "trust", description: "Multi-dimensional wallet/agent trust score via ProofLayer. Financial, reliability, trust, social axes + XMTP reputation + on-chain signals. Counterparty due diligence for agent-to-agent payments.", searchTerms: ["trust score","wallet reputation","agent trust","counterparty check","ProofLayer","wallet score","agent reputation","due diligence","XMTP reputation","wallet risk"] },
      // Free — TX Decoder
      { resource: `${BASE_URL}/api/v1/tx/decode`, method: "GET", price: "free", category: "defi", description: "Free transaction decoder — plain-English summary + structured token transfers for any EVM tx. Covers swaps, transfers, approvals, wraps, NFTs, batch payments. Blockscout-powered.", searchTerms: ["decode transaction","tx decoder","explain transaction","transaction summary","what happened","parse tx","token transfers","swap decode","tx analysis"] },

    ],
    solanaPayment: {
      enabled: true,
      chain: "solana",
      cluster: "mainnet-beta",
      receiveAddress: process.env.SOLANA_RECEIVE_ADDRESS || "",
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      txHeader: "X-Solana-Tx",
      discovery: `${BASE_URL}/.well-known/solana.json`,
    },
    supportedChains: ["base", "solana"],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/.well-known/solana.json", solanaDiscoveryHandler);

app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    name: "Spraay",
    description: `Full-stack DeFi infrastructure for AI agents on Base. ${PAID_COUNT} tools for payments, swaps, bridge, payroll, invoicing, escrow, oracle, analytics, AI inference, GPU/Compute, Search/RAG, communication, scheduling, storage, KYC, auth, audit trail, tax, agent wallets & supply chain (SCTP). Agents pay per request via x402 (USDC) or MPP (pathUSD/fiat).`,
    version: "3.8.1",
    icon: "https://raw.githubusercontent.com/plagtech/spraay-x402-mcp/main/spraay-logo-1000x1000.png",
    homepage: "https://spraay.app",
    repository: "https://github.com/plagtech/spraay-x402-mcp",
    configSchema: {
      type: "object",
      required: ["EVM_PRIVATE_KEY"],
      properties: {
        EVM_PRIVATE_KEY: { type: "string", title: "EVM Private Key", description: "Private key of a wallet with USDC on Base mainnet." },
        SPRAAY_GATEWAY_URL: { type: "string", default: "https://gateway.spraay.app", description: "Gateway URL" },
      },
    },
    tools: [
      { name: "spraay_chat", description: "AI chat via 200+ models", price: "$0.04" },
      { name: "spraay_models", description: "List AI models", price: "$0.001" },
      { name: "spraay_batch_execute", description: "Batch pay up to 200 recipients", price: "$0.02" },
      { name: "spraay_batch_estimate", description: "Estimate batch gas", price: "$0.001" },
      { name: "spraay_swap_quote", description: "Uniswap V3 swap quote", price: "$0.008" },
      { name: "spraay_swap_tokens", description: "List swap tokens", price: "$0.001" },
      { name: "spraay_swap_execute", description: "Execute swap", price: "$0.015" },
      { name: "spraay_oracle_prices", description: "On-chain token prices", price: "$0.008" },
      { name: "spraay_oracle_gas", description: "Gas prices", price: "$0.005" },
      { name: "spraay_oracle_fx", description: "Stablecoin FX rates", price: "$0.008" },
      { name: "spraay_bridge_quote", description: "Cross-chain bridge quote", price: "$0.05" },
      { name: "spraay_bridge_chains", description: "Supported bridge chains", price: "$0.002" },
      { name: "spraay_payroll_execute", description: "Execute payroll", price: "$0.10" },
      { name: "spraay_payroll_estimate", description: "Estimate payroll", price: "$0.003" },
      { name: "spraay_payroll_tokens", description: "Payroll stablecoins", price: "$0.002" },
      { name: "spraay_invoice_create", description: "Create invoice", price: "$0.05" },
      { name: "spraay_invoice_list", description: "List invoices", price: "$0.01" },
      { name: "spraay_invoice_get", description: "Invoice lookup", price: "$0.01" },
      { name: "spraay_analytics_wallet", description: "Wallet profile", price: "$0.01" },
      { name: "spraay_analytics_txhistory", description: "Tx history", price: "$0.008" },
      { name: "spraay_escrow_create", description: "Create escrow", price: "$0.10" },
      { name: "spraay_escrow_list", description: "List escrows", price: "$0.02" },
      { name: "spraay_escrow_get", description: "Escrow status", price: "$0.005" },
      { name: "spraay_escrow_fund", description: "Fund escrow", price: "$0.02" },
      { name: "spraay_escrow_release", description: "Release escrow", price: "$0.08" },
      { name: "spraay_escrow_cancel", description: "Cancel escrow", price: "$0.02" },
      { name: "spraay_classify_address", description: "AI wallet classification", price: "$0.03" },
      { name: "spraay_classify_tx", description: "AI tx classification", price: "$0.03" },
      { name: "spraay_explain_contract", description: "AI contract analysis", price: "$0.03" },
      { name: "spraay_summarize", description: "AI intelligence briefing", price: "$0.03" },
      { name: "spraay_notify_email", description: "Send email", price: "$0.01" },
      { name: "spraay_notify_sms", description: "Send SMS", price: "$0.02" },
      { name: "spraay_notify_status", description: "Notification status", price: "$0.002" },
      { name: "spraay_webhook_register", description: "Register webhook", price: "$0.01" },
      { name: "spraay_webhook_test", description: "Test webhook", price: "$0.005" },
      { name: "spraay_webhook_list", description: "List webhooks", price: "$0.002" },
      { name: "spraay_webhook_delete", description: "Delete webhook", price: "$0.002" },
      { name: "spraay_xmtp_send", description: "Send XMTP message", price: "$0.01" },
      { name: "spraay_xmtp_inbox", description: "XMTP inbox", price: "$0.01" },
      { name: "spraay_rpc_call", description: "Multi-chain RPC call", price: "$0.001" },
      { name: "spraay_rpc_chains", description: "RPC chains list", price: "$0.001" },
      { name: "spraay_storage_pin", description: "Pin to IPFS/Arweave", price: "$0.01" },
      { name: "spraay_storage_get", description: "Get pinned content", price: "$0.005" },
      { name: "spraay_storage_status", description: "Pin status", price: "$0.002" },
      { name: "spraay_cron_create", description: "Create scheduled job", price: "$0.01" },
      { name: "spraay_cron_list", description: "List jobs", price: "$0.002" },
      { name: "spraay_cron_cancel", description: "Cancel job", price: "$0.002" },
      { name: "spraay_logs_ingest", description: "Ingest logs", price: "$0.002" },
      { name: "spraay_logs_query", description: "Query logs", price: "$0.005" },
      { name: "spraay_kyc_verify", description: "KYC verification", price: "$0.02" },
      { name: "spraay_kyc_status", description: "KYC status", price: "$0.01" },
      { name: "spraay_auth_session", description: "Create auth session", price: "$0.01" },
      { name: "spraay_auth_verify", description: "Verify token", price: "$0.005" },
      { name: "spraay_audit_log", description: "Record audit entry", price: "$0.005" },
      { name: "spraay_audit_query", description: "Query audit trail", price: "$0.03" },
      { name: "spraay_tax_calculate", description: "Tax gain/loss calc", price: "$0.08" },
      { name: "spraay_tax_report", description: "Tax report", price: "$0.05" },
      { name: "spraay_gpu_run", description: "Run GPU inference (image, video, LLM, audio)", price: "$0.06" },
      { name: "spraay_gpu_status", description: "Check GPU prediction status", price: "$0.005" },
      { name: "spraay_gpu_models", description: "List GPU model shortcuts", price: "free" },
      { name: "spraay_search_web", description: "Web search with LLM-ready results", price: "$0.02" },
      { name: "spraay_search_extract", description: "Extract content from URLs for RAG", price: "$0.02" },
      { name: "spraay_search_qna", description: "Question answering with sources", price: "$0.03" },
      // Robotics / RTP
      { name: "spraay_robot_register", description: "Register a robot on the RTP network", price: "free" },
      { name: "spraay_robot_task", description: "Dispatch paid task to a robot", price: "$0.05" },
      { name: "spraay_robot_complete", description: "Report robot task completion", price: "free" },
      { name: "spraay_robot_list", description: "Discover robots by capability/price", price: "$0.005" },
      { name: "spraay_robot_status", description: "Poll RTP task status", price: "$0.002" },
      { name: "spraay_robot_profile", description: "Get robot capability profile", price: "$0.002" },
      // Agent Wallet (Category 17)
      { name: "spraay_agent_wallet_provision", description: "Create smart contract wallet for AI agent", price: "$0.05" },
      { name: "spraay_agent_wallet_session_key", description: "Add session key with spend limits", price: "$0.02" },
      { name: "spraay_agent_wallet_info", description: "Get agent wallet info + balance", price: "$0.005" },
      { name: "spraay_agent_wallet_revoke_key", description: "Revoke session key", price: "$0.02" },
      { name: "spraay_agent_wallet_predict", description: "Predict wallet address before deploy", price: "$0.001" },
      { name: "spraay_prices", description: "Token prices", price: "$0.005" },
      { name: "spraay_balances", description: "Token balances", price: "$0.005" },
      { name: "spraay_resolve", description: "ENS resolution", price: "$0.002" },
      // Supply Chain Task Protocol (Category 18)
      { name: "spraay_sctp_supplier_create", description: "Register supplier with wallet + payment prefs", price: "$0.02" },
      { name: "spraay_sctp_supplier_get", description: "Get supplier details", price: "$0.005" },
      { name: "spraay_sctp_po_create", description: "Create purchase order", price: "$0.02" },
      { name: "spraay_sctp_po_get", description: "Get purchase order", price: "$0.005" },
      { name: "spraay_sctp_invoice_submit", description: "Submit invoice for verification", price: "$0.02" },
      { name: "spraay_sctp_invoice_get", description: "Get invoice + verification result", price: "$0.005" },
      { name: "spraay_sctp_invoice_verify", description: "AI-powered invoice verification against PO", price: "$0.03" },
      { name: "spraay_sctp_pay", description: "Execute supplier payment (single or batch)", price: "$0.10" },
      // Research & Reference
      { name: "spraay_research_dict_define", description: "Dictionary definition, phonetics, examples", price: "$0.001" },
      { name: "spraay_research_dict_synonyms", description: "Synonyms and antonyms", price: "$0.001" },
      { name: "spraay_research_dict_phonetics", description: "Phonetic transcription + audio", price: "$0.001" },
      { name: "spraay_research_papers_search", description: "Search 250M+ academic papers (OpenAlex)", price: "$0.002" },
      { name: "spraay_research_papers_by_doi", description: "Paper metadata by DOI", price: "$0.001" },
      { name: "spraay_research_papers_by_author", description: "Papers by author or ORCID", price: "$0.002" },
      { name: "spraay_research_papers_citations", description: "Citation graph for a paper", price: "$0.002" },
      { name: "spraay_research_papers_trending", description: "Trending papers by field", price: "$0.002" },
      { name: "spraay_research_preprints_search", description: "Search arXiv preprints", price: "$0.002" },
      { name: "spraay_research_preprints_by_id", description: "arXiv preprint by ID", price: "$0.001" },
      { name: "spraay_research_preprints_recent", description: "Latest arXiv by category", price: "$0.002" },
      { name: "spraay_research_scholarly_by_doi", description: "Crossref metadata by DOI", price: "$0.001" },
      { name: "spraay_research_scholarly_search", description: "Search 150M+ works (Crossref)", price: "$0.002" },
      { name: "spraay_research_scholarly_citations", description: "Citation count for DOI", price: "$0.001" },
      { name: "spraay_research_scholarly_journal", description: "Journal info by ISSN", price: "$0.001" },
      { name: "spraay_research_chem_compound", description: "PubChem compound lookup", price: "$0.002" },
      { name: "spraay_research_chem_similarity", description: "Similar compounds (PubChem)", price: "$0.002" },
      { name: "spraay_research_chem_bioactivity", description: "Bioassay results (PubChem)", price: "$0.002" },
      { name: "spraay_research_biomed_search", description: "Search PubMed (36M+ papers)", price: "$0.002" },
      { name: "spraay_research_biomed_by_pmid", description: "Paper by PubMed ID", price: "$0.001" },
      { name: "spraay_research_biomed_related", description: "Related PubMed articles", price: "$0.002" },
      { name: "spraay_research_census", description: "US Census demographics", price: "$0.001" },
      { name: "spraay_research_datasets", description: "Search Data.gov datasets", price: "$0.001" },
      // Compute Futures
      { name: "spraay_compute_futures_deposit", description: "Deposit USDC to open a prepaid compute credit account", price: "$0.01" },
      { name: "spraay_compute_futures_balance", description: "Check remaining compute credit balance, tier, and usage stats", price: "$0.001" },
      { name: "spraay_compute_futures_execute", description: "Run a compute job and deduct cost from the prepaid balance", price: "$0.001" },
      { name: "spraay_compute_futures_history", description: "Full usage ledger", price: "$0.002" },
      { name: "spraay_compute_futures_refund", description: "Refund unused compute credit balance to the original depositor", price: "$0.01" },
      { name: "spraay_compute_futures_pricing", description: "Compute futures pricing", price: "$0.001" },
    ],
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway", version: "3.8.1",
    description: "Full-stack DeFi infrastructure: AI, payments, swaps, oracle, bridge, payroll, invoicing, escrow, AI inference, analytics, communication, webhooks, XMTP, RPC, storage, scheduling, logging, KYC, auth, audit trail, tax, GPU/Compute, Search/RAG, Agent Wallets & Supply Chain (SCTP). x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    discovery: `${BASE_URL}/.well-known/x402.json`,
    endpoints: {
      free: FREE_ENDPOINTS,
      paid: {
        // AI
        "POST /api/v1/chat/completions": "$0.04 - AI chat",
        "GET /api/v1/models": "$0.001 - AI models",
        // Payments
        "POST /api/v1/batch/execute": "$0.02 - Batch payment",
        "POST /api/v1/batch/estimate": "$0.001 - Batch estimate",
        // DeFi
        "GET /api/v1/swap/quote": "$0.008 - Swap quote",
        "GET /api/v1/swap/tokens": "$0.001 - Swap tokens",
        "POST /api/v1/swap/execute": "$0.0155 - Execute swap",
        // Oracle
        "GET /api/v1/oracle/prices": "$0.008 - Price feed",
        "GET /api/v1/oracle/gas": "$0.005 - Gas prices",
        "GET /api/v1/oracle/fx": "$0.008 - Stablecoin FX",
        // Bridge
        "GET /api/v1/bridge/quote": "$0.05 - Bridge quote",
        "GET /api/v1/bridge/chains": "$0.002 - Bridge chains",
        // Payroll
        "POST /api/v1/payroll/execute": "$0.10 - Payroll",
        "POST /api/v1/payroll/estimate": "$0.003 - Payroll estimate",
        "GET /api/v1/payroll/tokens": "$0.002 - Payroll tokens",
        // Invoice
        "POST /api/v1/invoice/create": "$0.05 - Create invoice",
        "GET /api/v1/invoice/list": "$0.01 - List invoices",
        "GET /api/v1/invoice/:id": "$0.01 - Invoice lookup",
        // Analytics
        "GET /api/v1/analytics/wallet": "$0.01 - Wallet profile",
        "GET /api/v1/analytics/txhistory": "$0.008 - Tx history",
        // Escrow
        "POST /api/v1/escrow/create": "$0.10 - Create escrow",
        "GET /api/v1/escrow/list": "$0.02 - List escrows",
        "GET /api/v1/escrow/:id": "$0.005 - Escrow status",
        "POST /api/v1/escrow/fund": "$0.02 - Fund escrow",
        "POST /api/v1/escrow/release": "$0.08 - Release escrow",
        "POST /api/v1/escrow/cancel": "$0.02 - Cancel escrow",
        // Inference
        "POST /api/v1/inference/classify-address": "$0.03 - Classify wallet",
        "POST /api/v1/inference/classify-tx": "$0.03 - Classify transaction",
        "POST /api/v1/inference/explain-contract": "$0.03 - Explain contract",
        "POST /api/v1/inference/summarize": "$0.03 - Intelligence briefing",
        // Communication
        "POST /api/v1/notify/email": "$0.01 - Send email",
        "POST /api/v1/notify/sms": "$0.02 - Send SMS",
        "GET /api/v1/notify/status": "$0.002 - Notification status",
        "POST /api/v1/webhook/register": "$0.01 - Register webhook",
        "POST /api/v1/webhook/test": "$0.005 - Test webhook",
        "GET /api/v1/webhook/list": "$0.002 - List webhooks",
        "POST /api/v1/webhook/delete": "$0.002 - Delete webhook",
        "POST /api/v1/xmtp/send": "$0.01 - Send XMTP message",
        "GET /api/v1/xmtp/inbox": "$0.01 - XMTP inbox",
        // Infrastructure
        "POST /api/v1/rpc/call": "$0.001 - RPC call",
        "GET /api/v1/rpc/chains": "$0.001 - RPC chains",
        "POST /api/v1/storage/pin": "$0.01 - Pin to IPFS/Arweave",
        "GET /api/v1/storage/get": "$0.005 - Get pinned content",
        "GET /api/v1/storage/status": "$0.002 - Pin status",
        "POST /api/v1/cron/create": "$0.01 - Create scheduled job",
        "GET /api/v1/cron/list": "$0.002 - List jobs",
        "POST /api/v1/cron/cancel": "$0.002 - Cancel job",
        "POST /api/v1/logs/ingest": "$0.002 - Ingest logs",
        "GET /api/v1/logs/query": "$0.005 - Query logs",
        // Identity & Access
        "POST /api/v1/kyc/verify": "$0.02 - KYC verification",
        "GET /api/v1/kyc/status": "$0.01 - KYC status",
        "POST /api/v1/auth/session": "$0.01 - Create session",
        "GET /api/v1/auth/verify": "$0.005 - Verify token",
        // Compliance
        "POST /api/v1/audit/log": "$0.005 - Audit log entry",
        "GET /api/v1/audit/query": "$0.03 - Query audit trail",
        "POST /api/v1/tax/calculate": "$0.08 - Tax calculation",
        "GET /api/v1/tax/report": "$0.05 - Tax report",
        // GPU/Compute
        "POST /api/v1/gpu/run": "$0.06 - GPU inference via Replicate",
        "GET /api/v1/gpu/status/:id": "$0.005 - GPU prediction status",
        "GET /api/v1/gpu/models": "FREE - GPU model shortcuts",
        // Search/RAG
        "POST /api/v1/search/web": "$0.02 - Web search (Tavily)",
        "POST /api/v1/search/extract": "$0.02 - Extract content from URLs",
        "POST /api/v1/search/qna": "$0.03 - Question answering",
        // Robotics / RTP
        "POST /api/v1/robots/task": "$0.05 - Dispatch robot task (RTP)",
        "GET /api/v1/robots/list": "$0.005 - Discover robots",
        "GET /api/v1/robots/status": "$0.002 - Poll task status",
        "GET /api/v1/robots/profile": "$0.002 - Robot profile",
        // Agent Wallet (Category 17)
        "POST /api/v1/agent-wallet/provision": "$0.05 - Provision agent wallet",
        "POST /api/v1/agent-wallet/session-key": "$0.02 - Add session key",
        "GET /api/v1/agent-wallet/info": "$0.005 - Agent wallet info",
        "POST /api/v1/agent-wallet/revoke-key": "$0.02 - Revoke session key",
        "GET /api/v1/agent-wallet/predict": "$0.001 - Predict wallet address",
        // Data
        "GET /api/v1/prices": "$0.005 - Token prices",
        "GET /api/v1/balances": "$0.005 - Balances",
        "GET /api/v1/resolve": "$0.002 - ENS resolution",
        // Supply Chain / SCTP (Category 18)
        "POST /api/v1/sctp/supplier": "$0.02 - Register supplier",
        "GET /api/v1/sctp/supplier/:id": "$0.005 - Get supplier",
        "POST /api/v1/sctp/po": "$0.02 - Create purchase order",
        "GET /api/v1/sctp/po/:id": "$0.005 - Get purchase order",
        "POST /api/v1/sctp/invoice": "$0.02 - Submit invoice",
        "GET /api/v1/sctp/invoice/:id": "$0.005 - Get invoice",
        "POST /api/v1/sctp/invoice/verify": "$0.03 - Verify invoice (AI)",
        "POST /api/v1/sctp/pay": "$0.10 - Execute supplier payment",
        // Bittensor Drop-in API (Category 19)
        "GET /bittensor/v1/models": "$0.001 - Bittensor models",
        "POST /bittensor/v1/chat/completions": "$0.03 - Bittensor inference",
        "POST /bittensor/v1/images/generations": "$0.05 - Bittensor image gen",
        "POST /bittensor/v1/embeddings": "$0.005 - Bittensor embeddings",
        // Compute Services
      "POST /api/v1/compute/text-inference": "$0.003-$0.10 - LLM text inference (11 models)",
      "POST /api/v1/compute/image-generation": "$0.02-$0.08 - AI image generation (FLUX, SDXL)",
      "POST /api/v1/compute/video-generation": "$0.40-$0.50 - AI video generation",
      "POST /api/v1/compute/text-to-speech": "$0.03-$0.05 - Text to speech (TTS)",
      "POST /api/v1/compute/speech-to-text": "$0.02 - Speech to text (STT)",
      "POST /api/v1/compute/embeddings": "$0.005 - Text embeddings (RAG)",
      "POST /api/v1/compute/batch": "$0.05 - Batch compute (up to 50 jobs, 10% discount)",
      "GET /api/v1/compute/status/:jobId": "$0.001 - Poll job status",
      // Solana
      "GET /api/v1/solana/jupiter/quote": "$0.005 - Jupiter swap quote",
      "POST /api/v1/solana/jupiter/swap-tx": "$0.01 - Jupiter swap transaction",
      "GET /api/v1/solana/helius/assets-by-owner": "$0.003 - Helius DAS assets",
      "GET /api/v1/solana/helius/asset": "$0.002 - Helius DAS single asset",
      "GET /api/v1/solana/pyth/price": "$0.005 - Pyth price feed",
      "GET /api/v1/solana/pyth/prices": "$0.008 - Pyth batch prices",
      // Portfolio & Contract
      "GET /api/v1/portfolio/tokens": "$0.005 - Portfolio tokens",
      "GET /api/v1/portfolio/nfts": "$0.005 - Portfolio NFTs",
      "POST /api/v1/contract/read": "$0.002 - Read contract",
      "POST /api/v1/contract/write": "$0.01 - Write contract",
      "GET /api/v1/defi/positions": "$0.008 - DeFi positions",
      // XRP & Stellar
      "POST /api/v1/xrp/batch": "$0.02 - XRP batch payments",
      "POST /api/v1/xrp/estimate": "$0.001 - XRP batch estimate",
      "GET /api/v1/xrp/info": "$0.001 - XRP Ledger info",
      "POST /api/v1/stellar/batch": "$0.02 - Stellar batch payments",
      "POST /api/v1/stellar/estimate": "$0.001 - Stellar batch estimate",
        // Compute Futures
        "POST /api/v1/compute-futures/deposit": "$0.01 - Deposit USDC to open a prepaid compute credit account",
        "GET /api/v1/compute-futures/balance": "$0.001 - Check remaining compute credit balance, tier, discount, and usage stats.",
        "POST /api/v1/compute-futures/execute": "$0.001 - Run a compute job and deduct cost from the prepaid balance",
        "GET /api/v1/compute-futures/history": "$0.002 - Full usage ledger",
        "POST /api/v1/compute-futures/refund": "$0.01 - Refund unused compute credit balance to the original depositor",
        "GET /api/v1/compute-futures/pricing": "$0.001 - Compute futures pricing",
        // Research & Reference (Category 24)
        "GET /api/v1/research/dictionary/define": "$0.001 - Dictionary definition with phonetics and examples",
        "GET /api/v1/research/dictionary/synonyms": "$0.001 - Synonyms and antonyms for a word",
        "GET /api/v1/research/dictionary/phonetics": "$0.001 - Phonetic transcription and audio URL",
        "GET /api/v1/research/papers/search": "$0.002 - Search 250M+ academic papers (OpenAlex CC0)",
        "GET /api/v1/research/papers/by-doi": "$0.001 - Paper metadata by DOI (OpenAlex)",
        "GET /api/v1/research/papers/by-author": "$0.002 - Papers by author name or ORCID (OpenAlex)",
        "GET /api/v1/research/papers/citations": "$0.002 - Citation graph - cited-by count and references",
        "GET /api/v1/research/papers/trending": "$0.002 - Trending papers by topic in the last N days",
        "GET /api/v1/research/preprints/search": "$0.002 - Search arXiv preprints by keyword and category",
        "GET /api/v1/research/preprints/by-id": "$0.001 - arXiv preprint metadata by ID",
        "GET /api/v1/research/preprints/recent": "$0.002 - Latest arXiv preprints by category",
        "GET /api/v1/research/scholarly/by-doi": "$0.001 - Full Crossref metadata for any DOI",
        "GET /api/v1/research/scholarly/search": "$0.002 - Search 150M+ works via Crossref (CC0)",
        "GET /api/v1/research/scholarly/citations-count": "$0.001 - Citation count and references for a DOI",
        "GET /api/v1/research/scholarly/journal-info": "$0.001 - Journal metadata by ISSN",
        "GET /api/v1/research/chemistry/compound": "$0.002 - PubChem compound by name, formula, or CID",
        "GET /api/v1/research/chemistry/similarity": "$0.002 - Find structurally similar compounds in PubChem",
        "GET /api/v1/research/chemistry/bioactivity": "$0.002 - Biological assay results for a PubChem compound",
        "GET /api/v1/research/biomedical/search": "$0.002 - Search 36M+ biomedical papers in PubMed",
        "GET /api/v1/research/biomedical/by-pmid": "$0.001 - Paper metadata by PubMed ID",
        "GET /api/v1/research/biomedical/related": "$0.002 - Related articles for a PubMed ID",
        "GET /api/v1/research/demographics/census": "$0.001 - US Census data by state, county, or zip",
        "GET /api/v1/research/demographics/datasets": "$0.001 - Search Data.gov datasets by keyword",
      },
    },
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    network: CAIP2_NETWORK, payTo: PAY_TO, mainnet: IS_MAINNET, bazaar: "discoverable",
    totalEndpoints: TOTAL_COUNT,
    protocols: {
      x402: {
        status: "active",
        network: CAIP2_NETWORK,
        facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
        token: "USDC",
      },
      mpp: {
        status: process.env.MPP_ENABLED === "true" ? "active" : "disabled",
        methods: ["tempo", "stripe-spt"],
        currency: "pathUSD",
        network: "tempo",
        spec: "https://mpp.dev",
      },
    },
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

// Stripe subscription auth
app.post("/v1/auth/register", registerHandler);
app.get("/v1/auth/success", successHandler);
app.get("/v1/auth/cancel", cancelHandler);
app.get("/v1/auth/usage", usageHandler);
app.post("/v1/auth/rotate", rotateHandler);
app.post("/v1/auth/portal", portalHandler);
app.get("/health", healthHandler);
app.get("/stats", statsHandler);
// Free Tier
app.get("/free",                freeLimit, freeCatalogHandler);
app.get("/free/gas",            freeLimit, freeGasHandler);
app.get("/free/prices",         freeLimit, freePricesHandler);
app.get("/free/chain-status",   freeLimit, freeChainStatusHandler);
app.get("/free/nonce",          freeLimit, freeNonceHandler);
app.get("/free/validate-address", freeLimit, freeValidateAddressHandler);
app.post("/free/validate-batch",  freeLimit, freeValidateBatchHandler);
app.get("/free/estimate-batch",   freeLimit, freeEstimateBatchHandler);
app.get("/free/resolve",        freeLimit, freeResolveHandler);
app.get("/free/agent-card",     freeLimit, freeAgentCardHandler);
app.post("/free/x402-check",    fetchLimit, freeX402CheckHandler);  // tighter limit
app.get("/free/convert",        freeLimit, freeConvertHandler);
app.get("/free/timestamp",      freeLimit, freeTimestampHandler);
app.get("/free/uuid",           freeLimit, freeUuidHandler);

// ============================================
// DISCOVERY ROUTES — kill the 404 bleed
// ============================================
// Path aliases for discovery endpoints agents probe but that would otherwise 404.
// Redirect to the full .json versions above where possible; inline new formats.

// x402 manifest — redirect bare paths to the existing .json version
app.get("/.well-known/x402", (_req, res) => res.redirect(308, "/.well-known/x402.json"));
app.get("/.well-known/x402-resources", (_req, res) => res.redirect(308, "/.well-known/x402.json"));
app.get("/x402-resources", (_req, res) => res.redirect(308, "/.well-known/x402.json"));

// MPP discovery
app.get("/.well-known/mpp.json", (_req, res) => {
  res.json({
    mppVersion: "1.0",
    name: "Spraay Gateway",
    description: `Universal agent payment gateway — ${TOTAL_COUNT} endpoints for AI, DeFi, payments, compute, search, robotics & more. Accepts x402 and MPP.`,
    homepage: BASE_URL,
    status: process.env.MPP_ENABLED === "true" ? "active" : "disabled",
    paymentMethods: {
      tempo: {
        currency: "0x20c0000000000000000000000000000000000000",
        currencyName: "pathUSD",
        recipient: PAY_TO,
        network: "tempo",
      },
    },
    endpoints: {
      total: PAID_COUNT,
      docs: `${BASE_URL}/.well-known/x402.json`,
      openapi: `${BASE_URL}/openapi.json`,
      mcp: `${BASE_URL}/.well-known/mcp/server-card.json`,
    },
    protocols: ["x402", "mpp"],
    spec: "https://mpp.dev",
    sdk: "npm install mppx",
    example: `npx mppx ${BASE_URL}/api/v1/oracle/gas`,
  });
});
app.get("/.well-known/mpp", (_req, res) => res.redirect(308, "/.well-known/mpp.json"));

// MCP discovery — redirect bare paths to the existing server-card.json
app.get("/.well-known/mcp", (_req, res) => res.redirect(308, "/.well-known/mcp/server-card.json"));
app.get("/mcp", (_req, res) => res.redirect(308, "/.well-known/mcp/server-card.json"));
app.post("/mcp", (_req, res) => res.redirect(308, "/.well-known/mcp/server-card.json"));

// A2A protocol agent card — new format, three path aliases
const agentCardResponse = (_req: express.Request, res: express.Response) => {
  res.json({
    schemaVersion: "0.2.0",
    name: "Spraay Universal Agent Payment Gateway",
    description: `Multi-chain batch payment protocol + universal payment gateway (x402 + MPP) with ${PAID_COUNT} paid endpoints for autonomous agents. Powered by Spraay Protocol on Base.`,
    url: BASE_URL,
    provider: { organization: "Spraay Protocol", url: "https://spraay.app" },
    version: "3.8.1",
    documentationUrl: "https://docs.spraay.app",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: {
      schemes: ["x402", "mpp"],
      credentials: [
        { protocol: "x402", network: CAIP2_NETWORK, acceptedAssets: ["USDC"], payTo: PAY_TO },
        { protocol: "mpp", methods: ["tempo"], currency: "pathUSD", payTo: PAY_TO, spec: "https://mpp.dev" },
      ],
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      { id: "chat_completions", name: "POST /api/v1/chat/completions", description: "OpenAI-compatible chat via 200+ models", tags: ["ai"], examples: [`POST ${BASE_URL}/api/v1/chat/completions`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "bittensor_chat", name: "POST /bittensor/v1/chat/completions", description: "Bittensor SN64 inference (Chutes AI)", tags: ["ai"], examples: [`POST ${BASE_URL}/bittensor/v1/chat/completions`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "batch_execute", name: "POST /api/v1/batch/execute", description: "Batch USDC payments via Spraay on Base", tags: ["payments"], examples: [`POST ${BASE_URL}/api/v1/batch/execute`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "oracle_prices", name: "GET /api/v1/oracle/prices", description: "Multi-source oracle price feed", tags: ["oracle"], examples: [`GET ${BASE_URL}/api/v1/oracle/prices`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "swap_quote", name: "GET /api/v1/swap/quote", description: "Uniswap V3 / Aerodrome swap quote", tags: ["defi"], examples: [`GET ${BASE_URL}/api/v1/swap/quote`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "escrow_create", name: "POST /api/v1/escrow/create", description: "Create on-chain escrow contract", tags: ["escrow"], examples: [`POST ${BASE_URL}/api/v1/escrow/create`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "payroll_execute", name: "POST /api/v1/payroll/execute", description: "Crypto payroll run via StablePay + Spraay", tags: ["payroll"], examples: [`POST ${BASE_URL}/api/v1/payroll/execute`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "gpu_run", name: "POST /api/v1/gpu/run", description: "GPU workload execution", tags: ["compute"], examples: [`POST ${BASE_URL}/api/v1/gpu/run`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "search_qna", name: "POST /api/v1/search/qna", description: "Structured Q&A search for agents", tags: ["search"], examples: [`POST ${BASE_URL}/api/v1/search/qna`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "robots_task", name: "POST /api/v1/robots/task", description: "Dispatch physical robot task via RTP", tags: ["rtp"], examples: [`POST ${BASE_URL}/api/v1/robots/task`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "agent_wallet_provision", name: "POST /api/v1/agent-wallet/provision", description: "Provision agent smart wallet on Base", tags: ["agent-wallet"], examples: [`POST ${BASE_URL}/api/v1/agent-wallet/provision`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "sctp_pay", name: "POST /api/v1/sctp/pay", description: "Execute supplier payment via SCTP", tags: ["supply-chain"], examples: [`POST ${BASE_URL}/api/v1/sctp/pay`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "compute_futures_deposit", name: "POST /api/v1/compute-futures/deposit", description: "Open a prepaid compute credit account with tier discounts", tags: ["compute-futures"], examples: [`POST ${BASE_URL}/api/v1/compute-futures/deposit`], inputModes: ["application/json"], outputModes: ["application/json"] },
      { id: "research_papers_search", name: "GET /api/v1/research/papers/search", description: "Search 250M+ academic papers (OpenAlex)", tags: ["research"], examples: [`GET ${BASE_URL}/api/v1/research/papers/search`], inputModes: ["application/json"], outputModes: ["application/json"] },
    ],
    links: {
      fullManifest: `${BASE_URL}/.well-known/x402.json`,
      mppManifest: `${BASE_URL}/.well-known/mpp.json`,
      openapi: `${BASE_URL}/openapi.json`,
      mcp: `${BASE_URL}/.well-known/mcp/server-card.json`,
    },
    _gateway: { provider: "spraay-x402", version: "3.8.1" },
  });
};
app.get("/.well-known/agent.json", agentCardResponse);
app.get("/.well-known/agent-card.json", agentCardResponse);
app.get("/.well-known/spraay-agent-card.json", agentCardResponse);

// Agent registration metadata
app.get("/.well-known/agent-registration.json", (_req, res) => {
  res.json({
    schemaVersion: "1.0",
    agentId: "spraay-x402-gateway",
    displayName: "Spraay",
    description: `Universal payment gateway (x402 + MPP) for AI agents — pay-per-call access to ${PAID_COUNT} paid endpoints across AI, DeFi, payments, compute, search, and robotics.`,
    endpoints: {
      base: BASE_URL,
      agentCard: `${BASE_URL}/.well-known/agent.json`,
      x402Manifest: `${BASE_URL}/.well-known/x402.json`,
mppManifest: `${BASE_URL}/.well-known/mpp.json`,
      openapi: `${BASE_URL}/openapi.json`,
      mcp: "https://smithery.ai/server/@plagtech/spraay-x402-mcp",
      repository: "https://github.com/plagtech/spraay-x402-gateway",
    },
    categories: ["ai", "payments", "defi", "oracle", "bridge", "payroll", "invoicing", "escrow", "compute", "search", "rtp", "agent-wallet", "supply-chain", "bittensor"],
    network: CAIP2_NETWORK,
    paymentAddress: PAY_TO,
solanaPayment: {
  chain: "solana",
  cluster: "mainnet-beta",
  receiveAddress: process.env.SOLANA_RECEIVE_ADDRESS || "",
  usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  txHeader: "X-Solana-Tx",
  discovery: `${BASE_URL}/.well-known/solana.json`,
},
_gateway: { provider: "spraay", version: "3.8.1", protocols: ["x402", "mpp", "solana-usdc"] },
  });
});

// OpenAPI 3.1 spec — x402 + MPP discovery compatible (full schemas)
app.get("/openapi.json", (_req, res) => {
  const endpoints = [
    // ---- AI ----
    { method: "post", path: "/api/v1/chat/completions", price: "$0.04", priceNum: "0.040000", tag: "ai", desc: "OpenAI-compatible chat via 200+ models",
      inputProps: { model: { type: "string", description: "Model ID" }, messages: { type: "array", description: "Chat messages" }, max_tokens: { type: "number" }, temperature: { type: "number" } }, required: ["model", "messages"],
      outputProps: { choices: { type: "array" }, usage: { type: "object" } } },
    { method: "get", path: "/api/v1/models", price: "$0.001", priceNum: "0.001000", tag: "ai", desc: "List AI models",
      queryParams: [],
      outputProps: { models: { type: "array" }, count: { type: "number" } } },
    // ---- PAYMENTS ----
    { method: "post", path: "/api/v1/batch/execute", price: "$0.02", priceNum: "0.020000", tag: "payments", desc: "Batch USDC payments on Base",
      inputProps: { token: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" }, sender: { type: "string" } }, required: ["token", "recipients", "amounts", "sender"],
      outputProps: { transactions: { type: "array" } } },
    { method: "post", path: "/api/v1/batch/estimate", price: "$0.001", priceNum: "0.001000", tag: "payments", desc: "Estimate batch gas",
      inputProps: { recipientCount: { type: "number" } }, required: ["recipientCount"],
      outputProps: { estimatedGas: { type: "string" } } },
    { method: "post", path: "/api/v1/stellar/batch", price: "$0.02", priceNum: "0.020000", tag: "payments", desc: "Batch XLM payments on Stellar",
      inputProps: { sourceSecret: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" } }, required: ["sourceSecret", "recipients", "amounts"],
      outputProps: { hash: { type: "string" }, status: { type: "string" } } },
    { method: "post", path: "/api/v1/stellar/estimate", price: "$0.001", priceNum: "0.001000", tag: "payments", desc: "Estimate Stellar batch cost",
      inputProps: { recipientCount: { type: "number" } }, required: ["recipientCount"],
      outputProps: { estimatedFee: { type: "string" } } },
    { method: "post", path: "/api/v1/xrp/batch", price: "$0.02", priceNum: "0.020000", tag: "payments", desc: "Batch XRP payments on XRP Ledger",
      inputProps: { senderSecret: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" } }, required: ["senderSecret", "recipients", "amounts"],
      outputProps: { hash: { type: "string" }, status: { type: "string" } } },
    { method: "post", path: "/api/v1/xrp/estimate", price: "$0.001", priceNum: "0.001000", tag: "payments", desc: "Estimate XRP batch cost",
      inputProps: { recipientCount: { type: "number" } }, required: ["recipientCount"],
      outputProps: { estimatedFee: { type: "string" } } },
    { method: "get", path: "/api/v1/xrp/info", price: "$0.001", priceNum: "0.001000", tag: "payments", desc: "XRP Ledger fee and reserve info",
      queryParams: [],
      outputProps: { baseFee: { type: "string" }, reserveBase: { type: "string" } } },
    // ---- DEFI / SWAP ----
    { method: "get", path: "/api/v1/swap/quote", price: "$0.008", priceNum: "0.008000", tag: "defi", desc: "Uniswap V3 / Aerodrome quote",
      queryParams: [{ name: "tokenIn", type: "string", required: true }, { name: "tokenOut", type: "string", required: true }, { name: "amountIn", type: "string", required: true }],
      outputProps: { amountOut: { type: "string" }, route: { type: "string" } } },
    { method: "get", path: "/api/v1/swap/tokens", price: "$0.001", priceNum: "0.001000", tag: "defi", desc: "Supported swap tokens",
      queryParams: [],
      outputProps: { tokens: { type: "array" } } },
    { method: "post", path: "/api/v1/swap/execute", price: "$0.015", priceNum: "0.015000", tag: "defi", desc: "Execute swap via Uniswap V3",
      inputProps: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn", "recipient"],
      outputProps: { status: { type: "string" }, txHash: { type: "string" } } },
    { method: "get", path: "/api/v1/defi/positions", price: "$0.02", priceNum: "0.020000", tag: "defi", desc: "DeFi positions across Aave V3, Compound V3, Aerodrome",
      queryParams: [{ name: "address", type: "string", required: true }, { name: "chain", type: "string", required: false }],
      outputProps: { address: { type: "string" }, total_positions: { type: "number" }, positions: { type: "array" } } },
    // ---- SOLANA JUPITER ----
    { method: "get", path: "/api/v1/solana/jupiter/quote", price: "$0.005", priceNum: "0.005000", tag: "solana", desc: "Jupiter v6 swap quote on Solana",
      queryParams: [{ name: "inputMint", type: "string", required: true }, { name: "outputMint", type: "string", required: true }, { name: "amount", type: "string", required: true }, { name: "slippageBps", type: "string", required: false }],
      outputProps: { inAmount: { type: "string" }, outAmount: { type: "string" }, priceImpactPct: { type: "string" } } },
    { method: "post", path: "/api/v1/solana/jupiter/swap-tx", price: "$0.01", priceNum: "0.010000", tag: "solana", desc: "Build unsigned Jupiter swap transaction",
      inputProps: { quoteResponse: { type: "object" }, userPublicKey: { type: "string" } }, required: ["quoteResponse", "userPublicKey"],
      outputProps: { swapTransaction: { type: "string" }, lastValidBlockHeight: { type: "number" } } },
    // ---- SOLANA HELIUS DAS ----
    { method: "get", path: "/api/v1/solana/helius/assets-by-owner", price: "$0.003", priceNum: "0.003000", tag: "solana", desc: "Helius DAS: list assets by Solana wallet",
      queryParams: [{ name: "owner", type: "string", required: true }, { name: "page", type: "string", required: false }, { name: "limit", type: "string", required: false }],
      outputProps: { owner: { type: "string" }, total: { type: "number" }, items: { type: "array" } } },
    { method: "get", path: "/api/v1/solana/helius/asset", price: "$0.002", priceNum: "0.002000", tag: "solana", desc: "Helius DAS: full metadata for a Solana asset",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { id: { type: "string" }, asset: { type: "object" } } },
    // ---- SOLANA PYTH ----
    { method: "get", path: "/api/v1/solana/pyth/price", price: "$0.005", priceNum: "0.005000", tag: "solana", desc: "Pyth latest price for one feed",
      queryParams: [{ name: "feedId", type: "string", required: true }],
      outputProps: { symbol: { type: "string" }, price: { type: "number" }, confidence: { type: "number" } } },
    { method: "get", path: "/api/v1/solana/pyth/prices", price: "$0.008", priceNum: "0.008000", tag: "solana", desc: "Pyth batch prices (up to 50 feeds)",
      queryParams: [{ name: "feedIds", type: "string", required: true }],
      outputProps: { count: { type: "number" }, prices: { type: "object" } } },
    // ---- ORACLE ----
    { method: "get", path: "/api/v1/oracle/prices", price: "$0.008", priceNum: "0.008000", tag: "oracle", desc: "Multi-token price feed",
      queryParams: [{ name: "tokens", type: "string", required: false }],
      outputProps: { prices: { type: "object" } } },
    { method: "get", path: "/api/v1/oracle/gas", price: "$0.005", priceNum: "0.005000", tag: "oracle", desc: "Gas prices on Base",
      queryParams: [],
      outputProps: { gas: { type: "object" } } },
    { method: "get", path: "/api/v1/oracle/fx", price: "$0.008", priceNum: "0.008000", tag: "oracle", desc: "Stablecoin FX rates",
      queryParams: [{ name: "base", type: "string", required: false }],
      outputProps: { rates: { type: "object" } } },
    // ---- BRIDGE ----
    { method: "get", path: "/api/v1/bridge/quote", price: "$0.05", priceNum: "0.050000", tag: "bridge", desc: "Cross-chain bridge quote",
      queryParams: [{ name: "fromChain", type: "string", required: true }, { name: "toChain", type: "string", required: true }, { name: "token", type: "string", required: true }, { name: "amount", type: "string", required: true }, { name: "fromAddress", type: "string", required: true }],
      outputProps: { status: { type: "string" }, quote: { type: "object" } } },
    { method: "get", path: "/api/v1/bridge/chains", price: "$0.002", priceNum: "0.002000", tag: "bridge", desc: "Supported bridge chains",
      queryParams: [],
      outputProps: { chains: { type: "array" } } },
    // ---- PAYROLL ----
    { method: "post", path: "/api/v1/payroll/execute", price: "$0.10", priceNum: "0.100000", tag: "payroll", desc: "Crypto payroll run",
      inputProps: { token: { type: "string" }, sender: { type: "string" }, employees: { type: "array" } }, required: ["token", "sender", "employees"],
      outputProps: { status: { type: "string" }, txHash: { type: "string" } } },
    { method: "post", path: "/api/v1/payroll/estimate", price: "$0.003", priceNum: "0.003000", tag: "payroll", desc: "Estimate payroll costs",
      inputProps: { employeeCount: { type: "number" } }, required: ["employeeCount"],
      outputProps: { estimate: { type: "object" } } },
    { method: "get", path: "/api/v1/payroll/tokens", price: "$0.002", priceNum: "0.002000", tag: "payroll", desc: "Payroll stablecoins",
      queryParams: [],
      outputProps: { tokens: { type: "array" } } },
    // ---- INVOICING ----
    { method: "post", path: "/api/v1/invoice/create", price: "$0.05", priceNum: "0.050000", tag: "invoicing", desc: "Create invoice with payment tx",
      inputProps: { creator: { type: "string" }, token: { type: "string" }, amount: { type: "string" } }, required: ["creator", "token", "amount"],
      outputProps: { status: { type: "string" }, invoice: { type: "object" } } },
    { method: "get", path: "/api/v1/invoice/list", price: "$0.01", priceNum: "0.010000", tag: "invoicing", desc: "List invoices by address",
      queryParams: [{ name: "address", type: "string", required: true }],
      outputProps: { invoices: { type: "array" }, count: { type: "number" } } },
    { method: "get", path: "/api/v1/invoice/:id", price: "$0.01", priceNum: "0.010000", tag: "invoicing", desc: "Invoice lookup",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { invoice: { type: "object" } } },
    // ---- ANALYTICS ----
    { method: "get", path: "/api/v1/analytics/wallet", price: "$0.01", priceNum: "0.010000", tag: "analytics", desc: "Wallet profile",
      queryParams: [{ name: "address", type: "string", required: true }],
      outputProps: { classification: { type: "object" } } },
    { method: "get", path: "/api/v1/analytics/txhistory", price: "$0.008", priceNum: "0.008000", tag: "analytics", desc: "Transaction history",
      queryParams: [{ name: "address", type: "string", required: true }, { name: "limit", type: "string", required: false }],
      outputProps: { transactions: { type: "array" } } },
    // ---- ESCROW ----
    { method: "post", path: "/api/v1/escrow/create", price: "$0.10", priceNum: "0.100000", tag: "escrow", desc: "Create conditional escrow",
      inputProps: { depositor: { type: "string" }, beneficiary: { type: "string" }, token: { type: "string" }, amount: { type: "string" } }, required: ["depositor", "beneficiary", "token", "amount"],
      outputProps: { status: { type: "string" }, escrow: { type: "object" } } },
    { method: "get", path: "/api/v1/escrow/list", price: "$0.02", priceNum: "0.020000", tag: "escrow", desc: "List escrows by address",
      queryParams: [{ name: "address", type: "string", required: true }],
      outputProps: { escrows: { type: "array" }, count: { type: "number" } } },
    { method: "get", path: "/api/v1/escrow/:id", price: "$0.005", priceNum: "0.005000", tag: "escrow", desc: "Escrow status",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { escrow: { type: "object" } } },
    { method: "post", path: "/api/v1/escrow/fund", price: "$0.02", priceNum: "0.020000", tag: "escrow", desc: "Mark escrow as funded",
      inputProps: { escrowId: { type: "string" } }, required: ["escrowId"],
      outputProps: { status: { type: "string" } } },
    { method: "post", path: "/api/v1/escrow/release", price: "$0.08", priceNum: "0.080000", tag: "escrow", desc: "Release escrow funds",
      inputProps: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"],
      outputProps: { status: { type: "string" }, transaction: { type: "object" } } },
    { method: "post", path: "/api/v1/escrow/cancel", price: "$0.02", priceNum: "0.020000", tag: "escrow", desc: "Cancel escrow",
      inputProps: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"],
      outputProps: { status: { type: "string" } } },
    // ---- INFERENCE ----
    { method: "post", path: "/api/v1/inference/classify-address", price: "$0.03", priceNum: "0.030000", tag: "inference", desc: "AI wallet classification with risk scoring",
      inputProps: { address: { type: "string" } }, required: ["address"],
      outputProps: { classification: { type: "object" } } },
    { method: "post", path: "/api/v1/inference/classify-tx", price: "$0.03", priceNum: "0.030000", tag: "inference", desc: "AI transaction classification",
      inputProps: { hash: { type: "string" } }, required: ["hash"],
      outputProps: { classification: { type: "object" } } },
    { method: "post", path: "/api/v1/inference/explain-contract", price: "$0.03", priceNum: "0.030000", tag: "inference", desc: "AI smart contract analysis",
      inputProps: { address: { type: "string" } }, required: ["address"],
      outputProps: { analysis: { type: "object" } } },
    { method: "post", path: "/api/v1/inference/summarize", price: "$0.03", priceNum: "0.030000", tag: "inference", desc: "AI intelligence briefing for address or tx",
      inputProps: { target: { type: "string" }, context: { type: "string" } }, required: ["target"],
      outputProps: { briefing: { type: "object" } } },
    // ---- COMMUNICATION ----
    { method: "post", path: "/api/v1/notify/email", price: "$0.01", priceNum: "0.010000", tag: "communication", desc: "Send email notification",
      inputProps: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "body"],
      outputProps: { id: { type: "string" }, status: { type: "string" } } },
    { method: "post", path: "/api/v1/notify/sms", price: "$0.02", priceNum: "0.020000", tag: "communication", desc: "Send SMS notification",
      inputProps: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"],
      outputProps: { id: { type: "string" }, status: { type: "string" } } },
    { method: "get", path: "/api/v1/notify/status", price: "$0.002", priceNum: "0.002000", tag: "communication", desc: "Check notification delivery status",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { id: { type: "string" }, status: { type: "string" } } },
    { method: "post", path: "/api/v1/webhook/register", price: "$0.01", priceNum: "0.010000", tag: "communication", desc: "Register webhook for events",
      inputProps: { url: { type: "string" }, events: { type: "array" } }, required: ["url", "events"],
      outputProps: { id: { type: "string" }, secret: { type: "string" }, status: { type: "string" } } },
    { method: "post", path: "/api/v1/webhook/test", price: "$0.005", priceNum: "0.005000", tag: "communication", desc: "Send test event to webhook",
      inputProps: { webhookId: { type: "string" } }, required: ["webhookId"],
      outputProps: { delivered: { type: "boolean" } } },
    { method: "get", path: "/api/v1/webhook/list", price: "$0.002", priceNum: "0.002000", tag: "communication", desc: "List registered webhooks",
      queryParams: [],
      outputProps: { webhooks: { type: "array" }, total: { type: "number" } } },
    { method: "post", path: "/api/v1/webhook/delete", price: "$0.002", priceNum: "0.002000", tag: "communication", desc: "Delete a webhook",
      inputProps: { webhookId: { type: "string" } }, required: ["webhookId"],
      outputProps: { deleted: { type: "boolean" } } },
    { method: "post", path: "/api/v1/xmtp/send", price: "$0.01", priceNum: "0.010000", tag: "communication", desc: "Send encrypted XMTP message",
      inputProps: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"],
      outputProps: { id: { type: "string" }, status: { type: "string" } } },
    { method: "get", path: "/api/v1/xmtp/inbox", price: "$0.01", priceNum: "0.010000", tag: "communication", desc: "Read XMTP inbox",
      queryParams: [{ name: "address", type: "string", required: true }, { name: "limit", type: "string", required: false }],
      outputProps: { messages: { type: "array" }, total: { type: "number" } } },
    // ---- INFRASTRUCTURE ----
    { method: "post", path: "/api/v1/rpc/call", price: "$0.001", priceNum: "0.001000", tag: "infrastructure", desc: "Premium multi-chain RPC call",
      inputProps: { chain: { type: "string" }, method: { type: "string" }, params: { type: "array" } }, required: ["chain", "method"],
      outputProps: { jsonrpc: { type: "string" }, result: { type: "string" } } },
    { method: "get", path: "/api/v1/rpc/chains", price: "$0.001", priceNum: "0.001000", tag: "infrastructure", desc: "List supported RPC chains",
      queryParams: [],
      outputProps: { chains: { type: "array" }, allowedMethods: { type: "array" } } },
    { method: "post", path: "/api/v1/storage/pin", price: "$0.01", priceNum: "0.010000", tag: "infrastructure", desc: "Pin content to IPFS or Arweave",
      inputProps: { data: { type: "string" }, contentType: { type: "string" }, provider: { type: "string" } }, required: ["data"],
      outputProps: { cid: { type: "string" }, status: { type: "string" } } },
    { method: "get", path: "/api/v1/storage/get", price: "$0.005", priceNum: "0.005000", tag: "infrastructure", desc: "Retrieve pinned content by CID",
      queryParams: [{ name: "cid", type: "string", required: true }],
      outputProps: { cid: { type: "string" }, status: { type: "string" } } },
    { method: "get", path: "/api/v1/storage/status", price: "$0.002", priceNum: "0.002000", tag: "infrastructure", desc: "Check pin status",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { status: { type: "string" } } },
    { method: "post", path: "/api/v1/cron/create", price: "$0.01", priceNum: "0.010000", tag: "infrastructure", desc: "Create scheduled job",
      inputProps: { action: { type: "string" }, schedule: { type: "string" }, payload: { type: "object" } }, required: ["action", "schedule", "payload"],
      outputProps: { id: { type: "string" }, status: { type: "string" } } },
    { method: "get", path: "/api/v1/cron/list", price: "$0.002", priceNum: "0.002000", tag: "infrastructure", desc: "List scheduled jobs",
      queryParams: [],
      outputProps: { jobs: { type: "array" }, total: { type: "number" } } },
    { method: "post", path: "/api/v1/cron/cancel", price: "$0.002", priceNum: "0.002000", tag: "infrastructure", desc: "Cancel a scheduled job",
      inputProps: { jobId: { type: "string" } }, required: ["jobId"],
      outputProps: { status: { type: "string" } } },
    { method: "post", path: "/api/v1/logs/ingest", price: "$0.002", priceNum: "0.002000", tag: "infrastructure", desc: "Ingest structured logs",
      inputProps: { entries: { type: "array" } }, required: ["entries"],
      outputProps: { ingested: { type: "number" }, ids: { type: "array" } } },
    { method: "get", path: "/api/v1/logs/query", price: "$0.005", priceNum: "0.005000", tag: "infrastructure", desc: "Query structured logs",
      queryParams: [{ name: "service", type: "string", required: false }, { name: "level", type: "string", required: false }, { name: "since", type: "string", required: false }],
      outputProps: { logs: { type: "array" }, total: { type: "number" } } },
    // ---- IDENTITY & ACCESS ----
    { method: "post", path: "/api/v1/kyc/verify", price: "$0.02", priceNum: "0.020000", tag: "identity", desc: "OFAC sanctions screening",
      inputProps: { address: { type: "string" }, type: { type: "string" }, chain: { type: "string" } }, required: ["address"],
      outputProps: { id: { type: "string" }, status: { type: "string" }, result: { type: "object" } } },
    { method: "get", path: "/api/v1/kyc/status", price: "$0.01", priceNum: "0.010000", tag: "identity", desc: "Check KYC verification status",
      queryParams: [{ name: "id", type: "string", required: false }, { name: "address", type: "string", required: false }],
      outputProps: { status: { type: "string" }, checks: { type: "object" } } },
    { method: "post", path: "/api/v1/auth/session", price: "$0.01", priceNum: "0.010000", tag: "identity", desc: "Create authenticated session",
      inputProps: { address: { type: "string" }, permissions: { type: "array" }, ttlSeconds: { type: "number" } }, required: ["address"],
      outputProps: { token: { type: "string" }, expiresAt: { type: "string" } } },
    { method: "get", path: "/api/v1/auth/verify", price: "$0.005", priceNum: "0.005000", tag: "identity", desc: "Verify session token",
      queryParams: [{ name: "token", type: "string", required: true }],
      outputProps: { valid: { type: "boolean" }, permissions: { type: "array" } } },
    // ---- COMPLIANCE ----
    { method: "post", path: "/api/v1/audit/log", price: "$0.005", priceNum: "0.005000", tag: "compliance", desc: "Record audit trail entry",
      inputProps: { action: { type: "string" }, actor: { type: "string" }, resource: { type: "string" }, details: { type: "object" } }, required: ["action", "actor", "resource"],
      outputProps: { id: { type: "string" }, recorded: { type: "boolean" } } },
    { method: "get", path: "/api/v1/audit/query", price: "$0.03", priceNum: "0.030000", tag: "compliance", desc: "Query audit trail",
      queryParams: [{ name: "actor", type: "string", required: false }, { name: "action", type: "string", required: false }, { name: "since", type: "string", required: false }],
      outputProps: { entries: { type: "array" }, total: { type: "number" } } },
    { method: "post", path: "/api/v1/tax/calculate", price: "$0.08", priceNum: "0.080000", tag: "compliance", desc: "Calculate crypto tax gain/loss (FIFO)",
      inputProps: { transactions: { type: "array" } }, required: ["transactions"],
      outputProps: { summary: { type: "object" } } },
    { method: "get", path: "/api/v1/tax/report", price: "$0.05", priceNum: "0.050000", tag: "compliance", desc: "Tax report with IRS 8949-compatible data",
      queryParams: [{ name: "reportId", type: "string", required: true }],
      outputProps: { events: { type: "array" }, total: { type: "number" } } },
    // ---- GPU / COMPUTE ----
    { method: "post", path: "/api/v1/gpu/run", price: "$0.06", priceNum: "0.060000", tag: "compute", desc: "GPU workload execution via Replicate",
      inputProps: { model: { type: "string" }, input: { type: "object" } }, required: ["model", "input"],
      outputProps: { id: { type: "string" }, status: { type: "string" }, output: { type: "array" } } },
    { method: "get", path: "/api/v1/gpu/status/:id", price: "$0.005", priceNum: "0.005000", tag: "compute", desc: "Check GPU prediction status",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { id: { type: "string" }, status: { type: "string" }, output: { type: "array" } } },
    // ---- SEARCH / RAG ----
    { method: "post", path: "/api/v1/search/web", price: "$0.02", priceNum: "0.020000", tag: "search", desc: "Web search with LLM-ready results",
      inputProps: { query: { type: "string" }, search_depth: { type: "string" }, max_results: { type: "number" } }, required: ["query"],
      outputProps: { query: { type: "string" }, answer: { type: "string" }, results: { type: "array" } } },
    { method: "post", path: "/api/v1/search/extract", price: "$0.02", priceNum: "0.020000", tag: "search", desc: "Extract clean content from URLs for RAG",
      inputProps: { urls: { type: "array" } }, required: ["urls"],
      outputProps: { results: { type: "array" }, failed: { type: "array" } } },
    { method: "post", path: "/api/v1/search/qna", price: "$0.03", priceNum: "0.030000", tag: "search", desc: "Direct Q&A with web sources",
      inputProps: { query: { type: "string" }, topic: { type: "string" } }, required: ["query"],
      outputProps: { query: { type: "string" }, answer: { type: "string" }, sources: { type: "array" } } },
    // ---- DATA ----
    { method: "get", path: "/api/v1/prices", price: "$0.005", priceNum: "0.005000", tag: "data", desc: "Live token prices",
      queryParams: [{ name: "token", type: "string", required: false }],
      outputProps: { prices: { type: "object" } } },
    { method: "get", path: "/api/v1/balances", price: "$0.005", priceNum: "0.005000", tag: "data", desc: "Token balances",
      queryParams: [{ name: "address", type: "string", required: true }],
      outputProps: { balances: { type: "array" } } },
    { method: "get", path: "/api/v1/resolve", price: "$0.002", priceNum: "0.002000", tag: "data", desc: "ENS/Basename resolution",
      queryParams: [{ name: "name", type: "string", required: true }],
      outputProps: { address: { type: "string" } } },
    // ---- WALLET PROVISIONING ----
    { method: "get", path: "/api/v1/wallet/list", price: "$0.002", priceNum: "0.002000", tag: "wallet", desc: "List agent wallets",
      queryParams: [],
      outputProps: { wallets: { type: "array" }, pagination: { type: "object" } } },
    { method: "get", path: "/api/v1/wallet/:walletId", price: "$0.001", priceNum: "0.001000", tag: "wallet", desc: "Get agent wallet details",
      queryParams: [{ name: "walletId", type: "string", required: true }],
      outputProps: { walletId: { type: "string" }, addresses: { type: "object" } } },
    { method: "get", path: "/api/v1/wallet/:walletId/addresses", price: "$0.001", priceNum: "0.001000", tag: "wallet", desc: "Get chain-specific addresses",
      queryParams: [{ name: "walletId", type: "string", required: true }],
      outputProps: { addresses: { type: "object" } } },
    { method: "post", path: "/api/v1/wallet/sign-message", price: "$0.005", priceNum: "0.005000", tag: "wallet", desc: "Sign message with agent wallet",
      inputProps: { walletId: { type: "string" }, message: { type: "string" } }, required: ["walletId", "message"],
      outputProps: { signature: { type: "string" } } },
    { method: "post", path: "/api/v1/wallet/send-transaction", price: "$0.02", priceNum: "0.020000", tag: "wallet", desc: "Sign and broadcast transaction",
      inputProps: { walletId: { type: "string" }, transaction: { type: "object" }, networkId: { type: "string" } }, required: ["walletId", "transaction", "networkId"],
      outputProps: { signature: { type: "string" } } },
    // ---- ROBOTICS / RTP ----
    { method: "post", path: "/api/v1/robots/task", price: "$0.05", priceNum: "0.050000", tag: "rtp", desc: "Dispatch robot task via RTP",
      inputProps: { robot_id: { type: "string" }, task: { type: "string" }, parameters: { type: "object" } }, required: ["robot_id", "task"],
      outputProps: { status: { type: "string" }, task_id: { type: "string" }, escrow_id: { type: "string" } } },
    { method: "get", path: "/api/v1/robots/list", price: "$0.005", priceNum: "0.005000", tag: "rtp", desc: "Discover RTP robots",
      queryParams: [{ name: "capability", type: "string", required: false }, { name: "max_price", type: "string", required: false }],
      outputProps: { robots: { type: "array" }, total: { type: "number" } } },
    { method: "get", path: "/api/v1/robots/status", price: "$0.002", priceNum: "0.002000", tag: "rtp", desc: "Poll RTP task status",
      queryParams: [{ name: "task_id", type: "string", required: true }],
      outputProps: { task_id: { type: "string" }, status: { type: "string" }, result: { type: "object" } } },
    { method: "get", path: "/api/v1/robots/profile", price: "$0.002", priceNum: "0.002000", tag: "rtp", desc: "Full RTP robot profile",
      queryParams: [{ name: "robot_id", type: "string", required: true }],
      outputProps: { robot_id: { type: "string" }, capabilities: { type: "array" } } },
    // ---- AGENT WALLET ----
    { method: "post", path: "/api/v1/agent-wallet/provision", price: "$0.05", priceNum: "0.050000", tag: "agent-wallet", desc: "Provision agent wallet on Base",
      inputProps: { agentId: { type: "string" }, agentType: { type: "string" }, mode: { type: "string" } }, required: ["agentId"],
      outputProps: { status: { type: "string" }, wallet: { type: "object" } } },
    { method: "post", path: "/api/v1/agent-wallet/session-key", price: "$0.02", priceNum: "0.020000", tag: "agent-wallet", desc: "Add session key with spending limits",
      inputProps: { walletAddress: { type: "string" }, sessionKeyAddress: { type: "string" }, spendLimitEth: { type: "string" }, durationHours: { type: "number" } }, required: ["walletAddress", "sessionKeyAddress", "spendLimitEth", "durationHours"],
      outputProps: { status: { type: "string" }, session: { type: "object" } } },
    { method: "get", path: "/api/v1/agent-wallet/info", price: "$0.005", priceNum: "0.005000", tag: "agent-wallet", desc: "Get agent wallet info",
      queryParams: [{ name: "address", type: "string", required: true }],
      outputProps: { wallet: { type: "object" } } },
    { method: "post", path: "/api/v1/agent-wallet/revoke-key", price: "$0.02", priceNum: "0.020000", tag: "agent-wallet", desc: "Revoke a session key",
      inputProps: { walletAddress: { type: "string" }, sessionKeyAddress: { type: "string" } }, required: ["walletAddress", "sessionKeyAddress"],
      outputProps: { status: { type: "string" }, txHash: { type: "string" } } },
    { method: "get", path: "/api/v1/agent-wallet/predict", price: "$0.001", priceNum: "0.001000", tag: "agent-wallet", desc: "Predict agent wallet address",
      queryParams: [{ name: "ownerAddress", type: "string", required: true }, { name: "agentId", type: "string", required: true }],
      outputProps: { predictedAddress: { type: "string" } } },
    // ---- BITTENSOR DROP-IN ----
    { method: "get", path: "/bittensor/v1/models", price: "$0.001", priceNum: "0.001000", tag: "bittensor", desc: "List Bittensor AI models",
      queryParams: [],
      outputProps: { object: { type: "string" }, data: { type: "array" } } },
    { method: "post", path: "/bittensor/v1/chat/completions", price: "$0.03", priceNum: "0.030000", tag: "bittensor", desc: "Bittensor decentralized AI chat",
      inputProps: { model: { type: "string" }, messages: { type: "array" }, max_tokens: { type: "number" }, temperature: { type: "number" } }, required: ["model", "messages"],
      outputProps: { choices: { type: "array" }, usage: { type: "object" } } },
    { method: "post", path: "/bittensor/v1/images/generations", price: "$0.05", priceNum: "0.050000", tag: "bittensor", desc: "Bittensor image generation",
      inputProps: { prompt: { type: "string" }, model: { type: "string" }, n: { type: "number" }, size: { type: "string" } }, required: ["prompt"],
      outputProps: { data: { type: "array" } } },
    { method: "post", path: "/bittensor/v1/embeddings", price: "$0.005", priceNum: "0.005000", tag: "bittensor", desc: "Bittensor text embeddings",
      inputProps: { model: { type: "string" }, input: { type: "string" } }, required: ["model", "input"],
      outputProps: { object: { type: "string" }, data: { type: "array" } } },
    // ---- SCTP / SUPPLY CHAIN ----
    { method: "post", path: "/api/v1/sctp/supplier", price: "$0.02", priceNum: "0.020000", tag: "supply-chain", desc: "Register supplier in SCTP",
      inputProps: { name: { type: "string" }, wallet: { type: "string" }, paymentPrefs: { type: "object" } }, required: ["name", "wallet"],
      outputProps: { status: { type: "string" }, supplier: { type: "object" } } },
    { method: "get", path: "/api/v1/sctp/supplier/:id", price: "$0.005", priceNum: "0.005000", tag: "supply-chain", desc: "Get supplier details",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { supplier: { type: "object" } } },
    { method: "post", path: "/api/v1/sctp/po", price: "$0.02", priceNum: "0.020000", tag: "supply-chain", desc: "Create purchase order",
      inputProps: { supplierId: { type: "string" }, lineItems: { type: "array" }, currency: { type: "string" } }, required: ["supplierId", "lineItems"],
      outputProps: { status: { type: "string" }, po: { type: "object" } } },
    { method: "get", path: "/api/v1/sctp/po/:id", price: "$0.005", priceNum: "0.005000", tag: "supply-chain", desc: "Get purchase order details",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { po: { type: "object" } } },
    { method: "post", path: "/api/v1/sctp/invoice", price: "$0.02", priceNum: "0.020000", tag: "supply-chain", desc: "Submit invoice for purchase order",
      inputProps: { poId: { type: "string" }, supplierId: { type: "string" }, amount: { type: "string" }, currency: { type: "string" } }, required: ["poId", "supplierId", "amount"],
      outputProps: { status: { type: "string" }, invoice: { type: "object" } } },
    { method: "get", path: "/api/v1/sctp/invoice/:id", price: "$0.005", priceNum: "0.005000", tag: "supply-chain", desc: "Get invoice details",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { invoice: { type: "object" } } },
    { method: "post", path: "/api/v1/sctp/invoice/verify", price: "$0.03", priceNum: "0.030000", tag: "supply-chain", desc: "AI-verify invoice against purchase order",
      inputProps: { invoiceId: { type: "string" } }, required: ["invoiceId"],
      outputProps: { verification: { type: "object" } } },
    { method: "post", path: "/api/v1/sctp/pay", price: "$0.10", priceNum: "0.100000", tag: "supply-chain", desc: "Execute supplier payment",
      inputProps: { invoiceId: { type: "string" }, batch: { type: "boolean" } }, required: ["invoiceId"],
      outputProps: { status: { type: "string" }, txHash: { type: "string" }, amount: { type: "string" } } },
    // ---- PORTFOLIO ----
    { method: "get", path: "/api/v1/portfolio/tokens", price: "$0.008", priceNum: "0.008000", tag: "portfolio", desc: "Multi-chain token portfolio with USD values",
      queryParams: [{ name: "address", type: "string", required: true }, { name: "networks", type: "string", required: false }],
      outputProps: { address: { type: "string" }, token_count: { type: "number" }, total_usd_value: { type: "number" }, tokens: { type: "array" } } },
    { method: "get", path: "/api/v1/portfolio/nfts", price: "$0.01", priceNum: "0.010000", tag: "portfolio", desc: "Multi-chain NFT holdings with metadata",
      queryParams: [{ name: "address", type: "string", required: true }, { name: "networks", type: "string", required: false }],
      outputProps: { address: { type: "string" }, total_count: { type: "number" }, nfts: { type: "array" } } },
    // ---- RESEARCH & REFERENCE ----
    { method: "get", path: "/api/v1/research/dictionary/define", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Dictionary definition with phonetics and examples",
      queryParams: [{ name: "word", type: "string", required: true }, { name: "lang", type: "string", required: false }],
      outputProps: { results: { type: "array" }, source: { type: "string" } } },
    { method: "get", path: "/api/v1/research/dictionary/synonyms", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Synonyms and antonyms for a word",
      queryParams: [{ name: "word", type: "string", required: true }],
      outputProps: { synonyms: { type: "array" }, antonyms: { type: "array" } } },
    { method: "get", path: "/api/v1/research/dictionary/phonetics", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Phonetic transcription and audio URL",
      queryParams: [{ name: "word", type: "string", required: true }],
      outputProps: { phonetics: { type: "array" } } },
    { method: "get", path: "/api/v1/research/papers/search", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Search 250M+ academic papers (OpenAlex CC0)",
      queryParams: [{ name: "q", type: "string", required: true }, { name: "filter", type: "string", required: false }, { name: "page", type: "string", required: false }, { name: "per_page", type: "string", required: false }],
      outputProps: { results: { type: "array" }, total_results: { type: "number" } } },
    { method: "get", path: "/api/v1/research/papers/by-doi", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Paper metadata by DOI (OpenAlex)",
      queryParams: [{ name: "doi", type: "string", required: true }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/papers/by-author", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Papers by author name or ORCID (OpenAlex)",
      queryParams: [{ name: "author", type: "string", required: false }, { name: "orcid", type: "string", required: false }, { name: "page", type: "string", required: false }],
      outputProps: { results: { type: "array" }, total_results: { type: "number" } } },
    { method: "get", path: "/api/v1/research/papers/citations", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Citation graph — cited-by count and references",
      queryParams: [{ name: "doi", type: "string", required: false }, { name: "id", type: "string", required: false }],
      outputProps: { cited_by_count: { type: "number" }, referenced_works: { type: "array" } } },
    { method: "get", path: "/api/v1/research/papers/trending", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Trending papers by topic in last N days",
      queryParams: [{ name: "topic", type: "string", required: false }, { name: "days", type: "string", required: false }, { name: "per_page", type: "string", required: false }],
      outputProps: { results: { type: "array" }, total_results: { type: "number" } } },
    { method: "get", path: "/api/v1/research/preprints/search", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Search arXiv preprints by keyword and category",
      queryParams: [{ name: "q", type: "string", required: false }, { name: "category", type: "string", required: false }, { name: "max_results", type: "string", required: false }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/preprints/by-id", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "arXiv preprint metadata by ID",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/preprints/recent", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Latest arXiv preprints by category",
      queryParams: [{ name: "category", type: "string", required: false }, { name: "max_results", type: "string", required: false }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/scholarly/by-doi", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Full Crossref metadata for any DOI",
      queryParams: [{ name: "doi", type: "string", required: true }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/scholarly/search", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Search 150M+ works via Crossref (CC0)",
      queryParams: [{ name: "q", type: "string", required: true }, { name: "rows", type: "string", required: false }, { name: "offset", type: "string", required: false }],
      outputProps: { results: { type: "array" }, total_results: { type: "number" } } },
    { method: "get", path: "/api/v1/research/scholarly/citations-count", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Citation count and references for a DOI",
      queryParams: [{ name: "doi", type: "string", required: true }],
      outputProps: { citations_count: { type: "number" }, references: { type: "array" } } },
    { method: "get", path: "/api/v1/research/scholarly/journal-info", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Journal metadata by ISSN",
      queryParams: [{ name: "issn", type: "string", required: true }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/chemistry/compound", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "PubChem compound by name, formula, or CID",
      queryParams: [{ name: "name", type: "string", required: false }, { name: "formula", type: "string", required: false }, { name: "cid", type: "string", required: false }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/chemistry/similarity", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Find structurally similar compounds in PubChem",
      queryParams: [{ name: "cid", type: "string", required: true }, { name: "threshold", type: "string", required: false }, { name: "max_records", type: "string", required: false }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/chemistry/bioactivity", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Biological assay results for a PubChem compound",
      queryParams: [{ name: "cid", type: "string", required: true }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/biomedical/search", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Search 36M+ biomedical papers in PubMed",
      queryParams: [{ name: "q", type: "string", required: true }, { name: "max_results", type: "string", required: false }],
      outputProps: { results: { type: "array" }, total_results: { type: "number" } } },
    { method: "get", path: "/api/v1/research/biomedical/by-pmid", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Paper metadata by PubMed ID",
      queryParams: [{ name: "pmid", type: "string", required: true }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/biomedical/related", price: "$0.002", priceNum: "0.002000", tag: "research", desc: "Related articles for a PubMed ID",
      queryParams: [{ name: "pmid", type: "string", required: true }, { name: "max_results", type: "string", required: false }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/demographics/census", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "US Census data by state, county, zip",
      queryParams: [{ name: "dataset", type: "string", required: false }, { name: "year", type: "string", required: false }, { name: "variables", type: "string", required: false }, { name: "geo", type: "string", required: false }],
      outputProps: { results: { type: "array" } } },
    { method: "get", path: "/api/v1/research/demographics/datasets", price: "$0.001", priceNum: "0.001000", tag: "research", desc: "Search Data.gov datasets by keyword",
      queryParams: [{ name: "q", type: "string", required: true }, { name: "rows", type: "string", required: false }],
      outputProps: { results: { type: "array" }, total_results: { type: "number" } } },
    // ---- CONTRACT ----
    { method: "post", path: "/api/v1/contract/read", price: "$0.002", priceNum: "0.002000", tag: "contract", desc: "Call any view/pure function on any EVM contract",
      inputProps: { chain: { type: "string" }, address: { type: "string" }, method: { type: "string" }, args: { type: "array" } }, required: ["address", "method"],
      outputProps: { chain: { type: "string" }, result: { type: "string" } } },
    { method: "post", path: "/api/v1/contract/write", price: "$0.015", priceNum: "0.015000", tag: "contract", desc: "Encode and broadcast transaction via agent wallet",
      inputProps: { chain: { type: "string" }, address: { type: "string" }, method: { type: "string" }, args: { type: "array" }, walletId: { type: "string" } }, required: ["address", "method"],
      outputProps: { tx_hash: { type: "string" }, from: { type: "string" }, explorer: { type: "string" } } },
    // ---- COMPUTE FUTURES ----
    { method: "post", path: "/api/v1/compute-futures/deposit", price: "$0.01", priceNum: "0.010000", tag: "compute-futures", desc: "Deposit USDC to open a prepaid compute credit account. Tier discounts: $10+ (5%), $50+ (10%), $200+ (15%).",
      inputProps: { depositor: { type: "string" }, amount: { type: "string" }, expiresInDays: { type: "number" } }, required: ["depositor", "amount"],
      outputProps: { status: { type: "string" } } },
    { method: "get", path: "/api/v1/compute-futures/balance", price: "$0.001", priceNum: "0.001000", tag: "compute-futures", desc: "Check remaining compute credit balance, tier, discount, and usage stats.",
      queryParams: [{ name: "id", type: "string", required: true }],
      outputProps: { status: { type: "string" } } },
    { method: "post", path: "/api/v1/compute-futures/execute", price: "$0.001", priceNum: "0.001000", tag: "compute-futures", desc: "Run a compute job and deduct cost from the prepaid balance. No per-call x402 - uses credit balance.",
      inputProps: { futuresId: { type: "string" }, type: { type: "string" }, model: { type: "string" }, messages: { type: "array" }, prompt: { type: "string" } }, required: ["futuresId", "type"],
      outputProps: { status: { type: "string" } } },
    { method: "get", path: "/api/v1/compute-futures/history", price: "$0.002", priceNum: "0.002000", tag: "compute-futures", desc: "Full usage ledger - every job, model, price, and balance change.",
      queryParams: [{ name: "id", type: "string", required: true }, { name: "limit", type: "number", required: false }],
      outputProps: { status: { type: "string" } } },
    { method: "post", path: "/api/v1/compute-futures/refund", price: "$0.01", priceNum: "0.010000", tag: "compute-futures", desc: "Refund unused compute credit balance to the original depositor. Depositor only.",
      inputProps: { futuresId: { type: "string" }, caller: { type: "string" } }, required: ["futuresId", "caller"],
      outputProps: { status: { type: "string" } } },
    { method: "get", path: "/api/v1/compute-futures/pricing", price: "$0.001", priceNum: "0.001000", tag: "compute-futures", desc: "Compute futures pricing - tier discounts, per-model costs, bulk discount info.",
      queryParams: [],
      outputProps: { status: { type: "string" } } },
  ];

  const paths: Record<string, any> = {};
  for (const e of endpoints) {
    if (!paths[e.path]) paths[e.path] = {};
    const op: any = {
      operationId: e.path.replace(/^\/api\/v1\//, "").replace(/^\//, "").replace(/\//g, "-").replace(/:/g, ""),
      summary: `${e.desc} — ${e.price}`,
      tags: [e.tag],
      description: `Paid endpoint — ${e.price} per call via x402/MPP. See ${BASE_URL}/.well-known/x402.json for full payment details.`,
      "x-payment-info": {
        price: { mode: "fixed" as const, amount: e.priceNum, currency: "USD" },
        protocols: [{ mpp: {} }, { x402: {} }],
      },
      responses: {
        "200": {
          description: "Success",
          content: { "application/json": { schema: { type: "object", properties: (e as any).outputProps || {} } } },
        },
        "402": { description: "Payment Required" },
      },
    };
    // POST endpoints: requestBody with real properties
    if (e.method === "post" && (e as any).inputProps) {
      op.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: (e as any).inputProps,
              ...((e as any).required ? { required: (e as any).required } : {}),
            },
          },
        },
      };
    }
    // GET endpoints: query parameters
    if (e.method === "get" && (e as any).queryParams) {
      op.parameters = ((e as any).queryParams as any[]).map((p: any) => ({
        name: p.name,
        in: "query" as const,
        required: p.required || false,
        schema: { type: p.type || "string" },
      }));
    }
    paths[e.path][e.method] = op;
  }

  res.json({
    openapi: "3.1.0",
    info: {
      title: "Spraay x402 Gateway",
      version: "3.8.1",
      description: "Pay-per-use AI, DeFi, payment, compute, and RTP primitives for autonomous agents via x402 and MPP on Base.",
      contact: { name: "Spraay", url: "https://spraay.app", email: "hello@spraay.app" },
      license: { name: "MIT" },
      "x-guidance": `Spraay is a multi-chain payment and AI inference gateway with ${PAID_COUNT} paid endpoints. Use POST /api/v1/chat/completions for LLM chat (200+ models, OpenAI-compatible). POST /api/v1/batch/execute for batch USDC payments. GET /api/v1/oracle/prices for real-time price feeds. POST /api/v1/robots/task to dispatch robot tasks via RTP. POST /api/v1/search/qna for structured Q&A. Bittensor decentralized AI at /bittensor/v1/chat/completions. Supply chain at /api/v1/sctp/*. All endpoints accept micropayments via x402 and MPP (USDC on Base). No API keys needed — just pay per call.`,
    },
    servers: [{ url: BASE_URL, description: "Production (Base mainnet)" }],
    "x-discovery": {
      ownershipProofs: [],
    },
    paths,
    components: {
      securitySchemes: {
        x402: { type: "http", scheme: "x402", description: `Pay per-call with USDC on Base to ${PAY_TO}` },
      },
    },
    security: [{ x402: [] }],
    externalDocs: { description: "Full docs", url: "https://docs.spraay.app" },
  });
});
 
// robots.txt — explicit allow for AI crawlers
app.get("/robots.txt", (_req, res) => {
  const body = `# Spraay x402 Gateway — robots.txt
# AI crawlers and agent frameworks explicitly welcome.
 
User-agent: *
Allow: /
 
User-agent: GPTBot
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: cohere-ai
Allow: /

Sitemap: ${BASE_URL}/openapi.json
`;
  res.type("text/plain; charset=utf-8").send(body);
});
app.get("/favicon.ico", (_req, res) => res.redirect(301, "https://spraay.app/spraay-logo-200x200.jpg"));

// ============================================
// PHANTOM ENDPOINT FIXES
// ============================================
// Bare paths agents probe that map to real (or coming-soon) endpoints.

// /api/v1/ai/chat → redirect to /api/v1/chat/completions
app.post("/api/v1/ai/chat", (_req, res) => res.redirect(308, "/api/v1/chat/completions"));

// /api/v1/analytics (bare) → public overview pointing to paid /wallet and /txhistory
app.get("/api/v1/analytics", (_req, res) => {
  res.json({
    gateway: "spraay-x402",
    version: "3.8.1",
    network: CAIP2_NETWORK,
    status: "operational",
    paidEndpoints: {
      "GET /api/v1/analytics/wallet": "$0.01 - Wallet profile and activity",
      "GET /api/v1/analytics/txhistory": "$0.008 - Transaction history with classification",
    },
    links: {
      fullManifest: `${BASE_URL}/.well-known/x402.json`,
      openapi: `${BASE_URL}/openapi.json`,
    },
    note: "This is a public overview. For per-wallet analytics, use the paid endpoints above.",
    _gateway: { provider: "spraay-x402", version: "3.8.1" },
    timestamp: new Date().toISOString(),
  });
});

// /api/v1/notify/send → point agents at /notify/email (and /notify/sms)
app.post("/api/v1/notify/send", (_req, res) => {
  res.status(308)
    .location("/api/v1/notify/email")
    .json({
      error: "endpoint_moved",
      message: "Use /api/v1/notify/email for email or /api/v1/notify/sms for SMS.",
      alternatives: [
        { method: "POST", path: "/api/v1/notify/email", price: "$0.01", description: "Send transactional email" },
        { method: "POST", path: "/api/v1/notify/sms", price: "$0.02", description: "Send SMS" },
      ],
      _gateway: { provider: "spraay-x402", version: "3.8.1" },
    });
});

// /api/v1/rpc (bare) → point agents at /rpc/call
app.post("/api/v1/rpc", (_req, res) => {
  res.status(308)
    .location("/api/v1/rpc/call")
    .json({
      error: "endpoint_moved",
      message: "Use /api/v1/rpc/call for JSON-RPC calls, or /api/v1/rpc/chains to list supported chains.",
      alternatives: [
        { method: "POST", path: "/api/v1/rpc/call", price: "$0.001", description: "JSON-RPC call to any supported chain" },
        { method: "GET", path: "/api/v1/rpc/chains", price: "$0.001", description: "List supported RPC chains" },
      ],
      _gateway: { provider: "spraay-x402", version: "3.8.1" },
    });
});

// /api/v1/bridge/transfer → 503 coming-soon (execution not live, /bridge/quote is)
app.post("/api/v1/bridge/transfer", (_req, res) => {
  res.status(503).json({
    error: "endpoint_coming_soon",
    endpoint: "/api/v1/bridge/transfer",
    message: "Bridge transfer execution coming soon. Use /api/v1/bridge/quote for quotes.",
    alternatives: [
      { method: "GET", path: "/api/v1/bridge/quote", price: "$0.05", description: "Get bridge quote across 10+ chains" },
      { method: "GET", path: "/api/v1/bridge/chains", price: "$0.002", description: "List supported bridge chains" },
    ],
    manifest: `${BASE_URL}/.well-known/x402.json`,
    _gateway: { provider: "spraay-x402", version: "3.8.1" },
    timestamp: new Date().toISOString(),
  });
});

// PAID ROUTE HANDLERS
// AI
app.post("/api/v1/chat/completions", aiChatHandler);
app.get("/api/v1/models", aiModelsHandler);
// Payments
app.post("/api/v1/batch/execute", batchPaymentHandler);
app.post("/api/v1/batch/estimate", batchEstimateHandler);
// Stellar (Chain #14)
app.post("/api/v1/stellar/batch", stellarBatchHandler);
app.post("/api/v1/stellar/estimate", stellarEstimateHandler);
// XRP Ledger (Chain #15)
app.post("/api/v1/xrp/batch", xrpBatchHandler);
app.post("/api/v1/xrp/estimate", xrpEstimateHandler);
app.get("/api/v1/xrp/info", xrpInfoHandler);
// DeFi
app.get("/api/v1/swap/quote", swapQuoteHandler);
app.get("/api/v1/swap/tokens", swapTokensHandler);
app.post("/api/v1/swap/execute", swapExecuteHandler);
// Oracle
app.get("/api/v1/oracle/prices", oraclePricesHandler);
app.get("/api/v1/oracle/gas", oracleGasHandler);
app.get("/api/v1/oracle/fx", oracleFxHandler);
// Bridge
app.get("/api/v1/bridge/quote", bridgeQuoteHandler);
app.get("/api/v1/bridge/chains", bridgeChainsHandler);
// Payroll
app.post("/api/v1/payroll/execute", payrollExecuteHandler);
app.post("/api/v1/payroll/estimate", payrollEstimateHandler);
app.get("/api/v1/payroll/tokens", payrollTokensHandler);
// Invoice
app.post("/api/v1/invoice/create", invoiceCreateHandler);
app.get("/api/v1/invoice/list", invoiceListHandler);
app.get("/api/v1/invoice/:id", invoiceGetHandler);
// Analytics
app.get("/api/v1/analytics/wallet", analyticsWalletHandler);
app.get("/api/v1/analytics/txhistory", analyticsTxHistoryHandler);
// Escrow
app.post("/api/v1/escrow/create", escrowCreateHandler);
app.get("/api/v1/escrow/list", escrowListHandler);
app.post("/api/v1/escrow/fund", escrowFundHandler);
app.post("/api/v1/escrow/release", escrowReleaseHandler);
app.post("/api/v1/escrow/cancel", escrowCancelHandler);
app.get("/api/v1/escrow/:id", escrowGetHandler);
// Inference
app.post("/api/v1/inference/classify-address", classifyAddressHandler);
app.post("/api/v1/inference/classify-tx", classifyTxHandler);
app.post("/api/v1/inference/explain-contract", explainContractHandler);
app.post("/api/v1/inference/summarize", summarizeHandler);
// Communication
app.post("/api/v1/notify/email", notifyEmailHandler);
app.post("/api/v1/notify/sms", notifySmsHandler);
app.get("/api/v1/notify/status", notifyStatusHandler);
app.post("/api/v1/webhook/register", webhookRegisterHandler);
app.post("/api/v1/webhook/test", webhookTestHandler);
app.get("/api/v1/webhook/list", webhookListHandler);
app.post("/api/v1/webhook/delete", webhookDeleteHandler);
app.post("/api/v1/xmtp/send", xmtpSendHandler);
app.get("/api/v1/xmtp/inbox", xmtpInboxHandler);
// Infrastructure
app.post("/api/v1/rpc/call", rpcCallHandler);
app.get("/api/v1/rpc/chains", rpcChainsHandler);
app.post("/api/v1/storage/pin", storagePinHandler);
app.get("/api/v1/storage/get", storageGetHandler);
app.get("/api/v1/storage/status", storageStatusHandler);
app.post("/api/v1/cron/create", cronCreateHandler);
app.get("/api/v1/cron/list", cronListHandler);
app.post("/api/v1/cron/cancel", cronCancelHandler);
app.post("/api/v1/logs/ingest", logsIngestHandler);
app.get("/api/v1/logs/query", logsQueryHandler);
// Identity & Access
app.post("/api/v1/kyc/verify", kycVerifyHandler);
app.get("/api/v1/kyc/status", kycStatusHandler);
app.post("/api/v1/auth/session", authSessionHandler);
app.get("/api/v1/auth/verify", authVerifyHandler);
// Compliance
app.post("/api/v1/audit/log", auditLogHandler);
app.get("/api/v1/audit/query", auditQueryHandler);
app.post("/api/v1/tax/calculate", taxCalculateHandler);
app.get("/api/v1/tax/report", taxReportHandler);
// GPU/Compute
app.post("/api/v1/gpu/run", gpuRunHandler);
app.get("/api/v1/gpu/status/:id", gpuStatusHandler);
app.get("/api/v1/gpu/models", gpuModelsHandler);
// Search/RAG
app.post("/api/v1/search/web", searchWebHandler);
app.post("/api/v1/search/extract", searchExtractHandler);
app.post("/api/v1/search/qna", searchQnaHandler);
// Robotics / RTP (Category 15)
app.post("/api/v1/robots/register", robotRegisterHandler);
app.post("/api/v1/robots/task", robotTaskHandler);
app.post("/api/v1/robots/complete", robotCompleteHandler);
app.get("/api/v1/robots/list", robotListHandler);
app.get("/api/v1/robots/status", robotTaskStatusHandler);
app.get("/api/v1/robots/profile", robotProfileHandler);
app.patch("/api/v1/robots/update", robotUpdateHandler);
app.post("/api/v1/robots/deregister", robotDeregisterHandler);
// Wallet Provisioning (Category 14)
app.post("/api/v1/wallet/create", walletCreateHandler);
app.get("/api/v1/wallet/list", walletListHandler);
app.post("/api/v1/wallet/sign-message", walletSignMessageHandler);
app.post("/api/v1/wallet/send-transaction", walletSendTxHandler);
app.get("/api/v1/wallet/:walletId/addresses", walletAddressesHandler);
app.get("/api/v1/wallet/:walletId", walletGetHandler);
// Agent Wallet (Category 17)
app.post("/api/v1/agent-wallet/provision", agentWalletProvisionHandler);
app.post("/api/v1/agent-wallet/session-key", agentWalletSessionKeyHandler);
app.get("/api/v1/agent-wallet/info", agentWalletInfoHandler);
app.post("/api/v1/agent-wallet/revoke-key", agentWalletRevokeKeyHandler);
app.get("/api/v1/agent-wallet/predict", agentWalletPredictHandler);
// Data
app.get("/api/v1/prices", pricesHandler);
app.get("/api/v1/balances", balancesHandler);
app.get("/api/v1/resolve", resolveHandler);
// Supply Chain / SCTP (Category 18)
app.post("/api/v1/sctp/supplier", sctpSupplierCreateHandler);
app.get("/api/v1/sctp/supplier/:id", sctpSupplierGetHandler);
app.post("/api/v1/sctp/po", sctpPoCreateHandler);
app.get("/api/v1/sctp/po/:id", sctpPoGetHandler);
app.post("/api/v1/sctp/invoice", sctpInvoiceSubmitHandler);
app.get("/api/v1/sctp/invoice/:id", sctpInvoiceGetHandler);
app.post("/api/v1/sctp/invoice/verify", sctpInvoiceVerifyHandler);
app.post("/api/v1/sctp/pay", sctpPayExecuteHandler);
// Portfolio (Category 20)
app.get("/api/v1/portfolio/tokens", portfolioTokensHandler);
app.get("/api/v1/portfolio/nfts", portfolioNftsHandler);
// Contract (Category 21)
app.post("/api/v1/contract/read", contractReadHandler);
app.post("/api/v1/contract/write", contractWriteHandler);
// DeFi Positions (extends DeFi category)
app.get("/api/v1/defi/positions", defiPositionsHandler);
// Solana Jupiter (Category 22)
app.get("/api/v1/solana/jupiter/quote", jupiterQuoteHandler);
app.post("/api/v1/solana/jupiter/swap-tx", jupiterSwapTxHandler);
// Solana Helius DAS
app.get("/api/v1/solana/helius/assets-by-owner", heliusAssetsByOwnerHandler);
app.get("/api/v1/solana/helius/asset", heliusAssetHandler);
// Solana Pyth price feeds
app.get("/api/v1/solana/pyth/price", pythPriceHandler);
app.get("/api/v1/solana/pyth/prices", pythPricesHandler);
// Bittensor Drop-in API (Category 19) — OpenAI-compatible
app.get("/bittensor/v1/models", dropinModelsHandler);
app.post("/bittensor/v1/chat/completions", dropinChatHandler);
app.post("/bittensor/v1/images/generations", dropinImageHandler);
app.post("/bittensor/v1/embeddings", dropinEmbeddingsHandler);
app.get("/bittensor/v1/health", dropinHealthHandler);
// Compute Services
app.post("/api/v1/compute/text-inference", textInferenceHandler);
app.post("/api/v1/compute/image-generation", imageGenerationHandler);
app.post("/api/v1/compute/video-generation", videoGenerationHandler);
app.post("/api/v1/compute/text-to-speech", textToSpeechHandler);
app.post("/api/v1/compute/speech-to-text", speechToTextHandler);
app.post("/api/v1/compute/embeddings", embeddingsHandler);
app.post("/api/v1/compute/batch", computeBatchHandler);
app.get("/api/v1/compute/status/:jobId", computeStatusHandler);
app.get("/api/v1/compute/models", computeModelsHandler);
app.post("/api/v1/compute/estimate", computeEstimateHandler);

// Compute Futures
app.post("/api/v1/compute-futures/deposit", computeFuturesDepositHandler);
app.get("/api/v1/compute-futures/balance", computeFuturesBalanceHandler);
app.post("/api/v1/compute-futures/execute", computeFuturesExecuteHandler);
app.get("/api/v1/compute-futures/history", computeFuturesHistoryHandler);
app.post("/api/v1/compute-futures/refund", computeFuturesRefundHandler);
app.get("/api/v1/compute-futures/pricing", computeFuturesPricingHandler);
// Base MCP Plugin (free — not in paymentMiddleware config)
app.use("/api/v1/plugin", pluginRouter);
// Research & Reference
app.get("/api/v1/research/dictionary/define", researchDictDefineHandler);
app.get("/api/v1/research/dictionary/synonyms", researchDictSynonymsHandler);
app.get("/api/v1/research/dictionary/phonetics", researchDictPhoneticsHandler);
app.get("/api/v1/research/papers/search", researchPapersSearchHandler);
app.get("/api/v1/research/papers/by-doi", researchPapersByDoiHandler);
app.get("/api/v1/research/papers/by-author", researchPapersByAuthorHandler);
app.get("/api/v1/research/papers/citations", researchPapersCitationsHandler);
app.get("/api/v1/research/papers/trending", researchPapersTrendingHandler);
app.get("/api/v1/research/preprints/search", researchPreprintsSearchHandler);
app.get("/api/v1/research/preprints/by-id", researchPreprintsByIdHandler);
app.get("/api/v1/research/preprints/recent", researchPreprintsRecentHandler);
app.get("/api/v1/research/scholarly/by-doi", researchScholarlyByDoiHandler);
app.get("/api/v1/research/scholarly/search", researchScholarlySearchHandler);
app.get("/api/v1/research/scholarly/citations-count", researchScholarlyCitationsHandler);
app.get("/api/v1/research/scholarly/journal-info", researchScholarlyJournalHandler);
app.get("/api/v1/research/chemistry/compound", researchChemCompoundHandler);
app.get("/api/v1/research/chemistry/similarity", researchChemSimilarityHandler);
app.get("/api/v1/research/chemistry/bioactivity", researchChemBioactivityHandler);
app.get("/api/v1/research/biomedical/search", researchBiomedSearchHandler);
app.get("/api/v1/research/biomedical/by-pmid", researchBiomedByPmidHandler);
app.get("/api/v1/research/biomedical/related", researchBiomedRelatedHandler);
app.get("/api/v1/research/demographics/census", researchCensusHandler);
app.get("/api/v1/research/demographics/datasets", researchDatasetsHandler);


// Final error handler — any uncaught error returns JSON, never HTML.
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[error] ${req.method} ${req.path}:`, err?.message || err);
  if (res.headersSent) return next(err);
  res.status(err?.status || 500).json({
    error: "internal_error",
    message: err?.message || "An unexpected error occurred.",
  });
});

app.listen(PORT, async () => {
  await initMpp();
  console.log(`\n💧 Spraay x402 Gateway v3.8.1 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🤖 RTP Robot Task Protocol endpoints active`);
  console.log(`👛 Agent Wallet provisioning active (Category 17)`);
  console.log(`📦 SCTP Supply Chain endpoints active (Category 18)`);
  console.log(`τ  Bittensor Drop-in API active (Category 19) — SN64 Chutes AI`);
  console.log(`⚡ Compute Services active — text-inference, image-gen, video-gen, TTS, STT, embeddings, batch`);
  console.log(`🔮 Compute Futures active — prepaid credits, tier discounts, usage ledger`);
  console.log(`🔍 Discovery endpoints active — .well-known suite, OpenAPI, llms.txt, agent cards`);
  console.log(`💼 Portfolio + Contract + DeFi Positions endpoints active (Categories 20, 21)`);
  console.log(`💳 MPP: ${process.env.MPP_ENABLED === "true" ? "ACTIVE" : "disabled"}`);
  console.log(`☀️  Solana SVM: ${SOLANA_PAY_TO ? "ACTIVE (x402 + custom)" : "disabled"}`);
  console.log(`☀️  Solana Jupiter endpoints active — quote + swap-tx${process.env.JUPITER_API_KEY ? " (paid tier)" : " (public tier)"}`);
  console.log(`☀️  Solana Helius DAS endpoints active — assets-by-owner + asset${process.env.HELIUS_API_KEY ? "" : " (HELIUS_API_KEY missing — endpoints will 503)"}`);
  console.log(`☀️  Solana Pyth price feeds active — price + prices (Hermes public API)`);
  console.log(`📚 Research & Reference active — dictionary, papers, preprints, chemistry, biomedical, demographics (23 endpoints)`);
  console.log(`💧 Free Tier active — 14 endpoints at /free/* (gas, prices, chain-status, nonce, validate, resolve, agent-card, x402-check, convert)`);
  console.log(`\n🌐 ${PAID_COUNT} paid + ${FREE_COUNT} free endpoints live (${TOTAL_COUNT} total)\n`);
});

export default app;