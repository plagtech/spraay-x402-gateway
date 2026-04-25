import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
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
import { resolveHandler } from "./routes/resolve.js";
import { healthHandler, statsHandler } from "./routes/health.js";
// NEW: Supply Chain Task Protocol (Category 18)
import { sctpSupplierCreateHandler, sctpSupplierGetHandler, sctpPoCreateHandler, sctpPoGetHandler, sctpInvoiceSubmitHandler, sctpInvoiceGetHandler, sctpInvoiceVerifyHandler, sctpPayExecuteHandler } from "./routes/sctp.js";
// NEW: Bittensor Drop-in API (Category 19)
import { dropinModelsHandler, dropinChatHandler, dropinImageHandler, dropinEmbeddingsHandler, dropinHealthHandler } from "./routes/bittensor-dropin.js";
import { enrich402Middleware } from "./middleware/enrich402.js";
import { gatewayEventsMiddleware } from "./middleware/gateway-events.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(gatewayEventsMiddleware);

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
app.use(enrich402Middleware);
app.use(
  paymentMiddleware(
    {
      "POST /api/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.04", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI chat completions via 200+ models.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] }, inputSchema: { properties: { model: { type: "string" }, messages: { type: "array" } }, required: ["model", "messages"] }, bodyType: "json", output: { example: { choices: [{ message: { content: "Hello!" } }] }, schema: { properties: { choices: { type: "array" } } } } }) },
      },
      "GET /api/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List AI models.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { models: [], count: 200 }, schema: { properties: { models: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/execute": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Batch payments via Spraay.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", recipients: ["0x..."], amounts: ["1000000"], sender: "0x..." }, inputSchema: { properties: { token: { type: "string" }, recipients: { type: "array" }, amounts: { type: "array" }, sender: { type: "string" } }, required: ["token", "recipients", "amounts", "sender"] }, bodyType: "json", output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },
      "POST /api/v1/batch/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate batch gas.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { recipientCount: 5 }, inputSchema: { properties: { recipientCount: { type: "number" } }, required: ["recipientCount"] }, bodyType: "json", output: { example: { estimatedGas: "185000" }, schema: { properties: { estimatedGas: { type: "string" } } } } }) },
      },
      "POST /api/v1/stellar/batch": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Batch XLM payments on Stellar.", mimeType: "application/json",
      },
      "POST /api/v1/stellar/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate Stellar batch cost.", mimeType: "application/json",
      },
      "POST /api/v1/xrp/batch": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Batch XRP payments on XRP Ledger.", mimeType: "application/json",
      },
      "POST /api/v1/xrp/estimate": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate XRP batch cost.", mimeType: "application/json",
      },
      "GET /api/v1/swap/quote": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Swap quotes via Uniswap V3.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "1000000" }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn"] }, output: { example: { amountOut: "384215000000000" }, schema: { properties: { amountOut: { type: "string" } } } } }) },
      },
      "GET /api/v1/swap/tokens": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported swap tokens.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [] }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/swap/execute": {
        accepts: [{ scheme: "exact", price: "$0.015", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute swap via Uniswap V3.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokenIn: "USDC", tokenOut: "WETH", amountIn: "100", recipient: "0x..." }, inputSchema: { properties: { tokenIn: { type: "string" }, tokenOut: { type: "string" }, amountIn: { type: "string" }, recipient: { type: "string" } }, required: ["tokenIn", "tokenOut", "amountIn", "recipient"] }, bodyType: "json", output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/oracle/prices": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-token price feed.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { tokens: "ETH,cbBTC" }, inputSchema: { properties: { tokens: { type: "string" } } }, output: { example: { prices: {} }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/gas": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Gas prices on Base.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { gas: {} }, schema: { properties: { gas: { type: "object" } } } } }) },
      },
      "GET /api/v1/oracle/fx": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Stablecoin FX rates.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { base: "USDC" }, inputSchema: { properties: { base: { type: "string" } } }, output: { example: { rates: {} }, schema: { properties: { rates: { type: "object" } } } } }) },
      },
      "GET /api/v1/bridge/quote": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cross-chain bridge quote.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { fromChain: "base", toChain: "ethereum", token: "USDC", amount: "1000000000", fromAddress: "0x..." }, inputSchema: { properties: { fromChain: { type: "string" }, toChain: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, fromAddress: { type: "string" } }, required: ["fromChain", "toChain", "token", "amount", "fromAddress"] }, output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/bridge/chains": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Supported bridge chains.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { chains: [] }, schema: { properties: { chains: { type: "array" } } } } }) },
      },
      "POST /api/v1/payroll/execute": {
        accepts: [{ scheme: "exact", price: "$0.10", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute payroll via Spraay V2.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "USDC", sender: "0x...", employees: [{ address: "0x...", amount: "3000" }] }, inputSchema: { properties: { token: { type: "string" }, sender: { type: "string" }, employees: { type: "array" } }, required: ["token", "sender", "employees"] }, bodyType: "json", output: { example: { status: "ready" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/payroll/estimate": {
        accepts: [{ scheme: "exact", price: "$0.003", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Estimate payroll costs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { employeeCount: 10 }, inputSchema: { properties: { employeeCount: { type: "number" } }, required: ["employeeCount"] }, bodyType: "json", output: { example: { estimate: {} }, schema: { properties: { estimate: { type: "object" } } } } }) },
      },
      "GET /api/v1/payroll/tokens": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Payroll stablecoins.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { tokens: [] }, schema: { properties: { tokens: { type: "array" } } } } }) },
      },
      "POST /api/v1/invoice/create": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create invoice with payment tx.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { creator: "0x...", token: "USDC", amount: "1500" }, inputSchema: { properties: { creator: { type: "string" }, token: { type: "string" }, amount: { type: "string" } }, required: ["creator", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", invoice: { id: "INV-A1B2" } }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/invoice/list": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List invoices by address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { invoices: [], count: 0 }, schema: { properties: { invoices: { type: "array" } } } } }) },
      },
      "GET /api/v1/invoice/:id": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Invoice lookup.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "INV-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { invoice: { status: "pending" } }, schema: { properties: { invoice: { type: "object" } } } } }) },
      },
      "GET /api/v1/analytics/wallet": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Wallet profile.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { classification: { walletType: "active" } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "GET /api/v1/analytics/txhistory": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Transaction history.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", limit: "10" }, inputSchema: { properties: { address: { type: "string" }, limit: { type: "string" } }, required: ["address"] }, output: { example: { transactions: [] }, schema: { properties: { transactions: { type: "array" } } } } }) },
      },

      // ---- ESCROW (flat routes) ----
      "POST /api/v1/escrow/create": {
        accepts: [{ scheme: "exact", price: "$0.10", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create conditional escrow with milestones and expiry.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { depositor: "0xClient", beneficiary: "0xFreelancer", token: "USDC", amount: "5000" }, inputSchema: { properties: { depositor: { type: "string" }, beneficiary: { type: "string" }, token: { type: "string" }, amount: { type: "string" }, arbiter: { type: "string" }, conditions: { type: "array" }, expiresIn: { type: "number" } }, required: ["depositor", "beneficiary", "token", "amount"] }, bodyType: "json", output: { example: { status: "created", escrow: { id: "ESC-A1B2" } }, schema: { properties: { status: { type: "string" }, escrow: { type: "object" } } } } }) },
      },
      "GET /api/v1/escrow/list": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List escrows by address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" }, status: { type: "string" } }, required: ["address"] }, output: { example: { escrows: [], count: 0 }, schema: { properties: { escrows: { type: "array" } } } } }) },
      },
      "GET /api/v1/escrow/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Escrow status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "ESC-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { escrow: { status: "funded" } }, schema: { properties: { escrow: { type: "object" } } } } }) },
      },
      "POST /api/v1/escrow/fund": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Mark escrow as funded. Pass escrowId in body.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2" }, inputSchema: { properties: { escrowId: { type: "string" } }, required: ["escrowId"] }, bodyType: "json", output: { example: { status: "funded" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/escrow/release": {
        accepts: [{ scheme: "exact", price: "$0.08", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Release escrow funds. Returns unsigned transfer tx. Depositor or arbiter only.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2", caller: "0xDepositor" }, inputSchema: { properties: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"] }, bodyType: "json", output: { example: { status: "released", transaction: {} }, schema: { properties: { status: { type: "string" }, transaction: { type: "object" } } } } }) },
      },
      "POST /api/v1/escrow/cancel": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cancel escrow.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { escrowId: "ESC-A1B2", caller: "0xDepositor" }, inputSchema: { properties: { escrowId: { type: "string" }, caller: { type: "string" } }, required: ["escrowId", "caller"] }, bodyType: "json", output: { example: { status: "cancelled" }, schema: { properties: { status: { type: "string" } } } } }) },
      },

      // ---- INFERENCE ----
      "POST /api/v1/inference/classify-address": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-powered wallet classification with risk scoring.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { classification: { classification: "whale", riskLevel: "low", riskScore: 15 } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/classify-tx": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-powered transaction classification with risk scoring.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { hash: "0xabc123..." }, inputSchema: { properties: { hash: { type: "string" } }, required: ["hash"] }, bodyType: "json", output: { example: { classification: { type: "swap", riskLevel: "low" } }, schema: { properties: { classification: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/explain-contract": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-powered smart contract analysis.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { analysis: { type: "erc20-token", riskLevel: "low" } }, schema: { properties: { analysis: { type: "object" } } } } }) },
      },
      "POST /api/v1/inference/summarize": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI intelligence briefing for any address or transaction.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { target: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", context: "defi" }, inputSchema: { properties: { target: { type: "string" }, context: { type: "string" } }, required: ["target"] }, bodyType: "json", output: { example: { briefing: { headline: "Active DeFi whale", riskAssessment: { level: "low" } } }, schema: { properties: { briefing: { type: "object" } } } } }) },
      },

      // ---- COMMUNICATION ----
      "POST /api/v1/notify/email": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Send email notification for payment confirmations, alerts, receipts.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { to: "user@example.com", subject: "Payment Received", body: "Your batch payment of 500 USDC has been confirmed." }, inputSchema: { properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, replyTo: { type: "string" } }, required: ["to", "body"] }, bodyType: "json", output: { example: { id: "ntf_123", status: "queued" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "POST /api/v1/notify/sms": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Send SMS notification for payment alerts.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { to: "+14155551234", body: "Spraay: 500 USDC payment confirmed. Tx: 0xabc..." }, inputSchema: { properties: { to: { type: "string" }, body: { type: "string" } }, required: ["to", "body"] }, bodyType: "json", output: { example: { id: "ntf_123", status: "queued", segments: 1 }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/notify/status": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Check notification delivery status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "ntf_123" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { id: "ntf_123", status: "delivered" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "POST /api/v1/webhook/register": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Register webhook for payment/escrow/swap events.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { url: "https://myapp.com/hooks/spraay", events: ["payment.sent", "escrow.funded"] }, inputSchema: { properties: { url: { type: "string" }, events: { type: "array" } }, required: ["url", "events"] }, bodyType: "json", output: { example: { id: "whk_123", secret: "whsec_abc", status: "active" }, schema: { properties: { id: { type: "string" }, secret: { type: "string" } } } } }) },
      },
      "POST /api/v1/webhook/test": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Send test event to a registered webhook.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { webhookId: "whk_123" }, inputSchema: { properties: { webhookId: { type: "string" } }, required: ["webhookId"] }, bodyType: "json", output: { example: { delivered: true }, schema: { properties: { delivered: { type: "boolean" } } } } }) },
      },
      "GET /api/v1/webhook/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List registered webhooks.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { webhooks: [], total: 0 }, schema: { properties: { webhooks: { type: "array" } } } } }) },
      },
      "POST /api/v1/webhook/delete": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Delete a webhook.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { webhookId: "whk_123" }, inputSchema: { properties: { webhookId: { type: "string" } }, required: ["webhookId"] }, bodyType: "json", output: { example: { deleted: true }, schema: { properties: { deleted: { type: "boolean" } } } } }) },
      },
      "POST /api/v1/xmtp/send": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Send encrypted XMTP message to any Ethereum address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", content: "Your payment of 500 USDC has been sent." }, inputSchema: { properties: { to: { type: "string" }, content: { type: "string" }, contentType: { type: "string" } }, required: ["to", "content"] }, bodyType: "json", output: { example: { id: "xmtp_123", status: "sent" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/xmtp/inbox": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Read XMTP inbox for an Ethereum address.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" }, limit: { type: "string" } }, required: ["address"] }, output: { example: { messages: [], total: 0 }, schema: { properties: { messages: { type: "array" } } } } }) },
      },

      // ---- INFRASTRUCTURE ----
      "POST /api/v1/rpc/call": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Premium multi-chain RPC call via Alchemy/Helius.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { chain: "base", method: "eth_getBalance", params: ["0xd8dA...", "latest"] }, inputSchema: { properties: { chain: { type: "string" }, method: { type: "string" }, params: { type: "array" } }, required: ["chain", "method"] }, bodyType: "json", output: { example: { jsonrpc: "2.0", result: "0x1234" }, schema: { properties: { result: { type: "string" } } } } }) },
      },
      "GET /api/v1/rpc/chains": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List supported RPC chains and methods.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { chains: [], allowedMethods: [] }, schema: { properties: { chains: { type: "array" } } } } }) },
      },
      "POST /api/v1/storage/pin": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Pin content to IPFS or Arweave for permanent storage.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { data: "{\"receipt\":\"batch_123\"}", contentType: "application/json", provider: "ipfs" }, inputSchema: { properties: { data: { type: "string" }, contentType: { type: "string" }, provider: { type: "string" } }, required: ["data"] }, bodyType: "json", output: { example: { cid: "bafy...", status: "pinning" }, schema: { properties: { cid: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/storage/get": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Retrieve pinned content by CID.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { cid: "bafy..." }, inputSchema: { properties: { cid: { type: "string" } }, required: ["cid"] }, output: { example: { cid: "bafy...", status: "pinned" }, schema: { properties: { cid: { type: "string" } } } } }) },
      },
      "GET /api/v1/storage/status": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Check pin status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "pin_123" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { status: "pinned" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/cron/create": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create scheduled job for recurring payments, DCA, reminders.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { action: "batch.execute", schedule: "0 9 * * 1", payload: { token: "USDC", recipients: ["0x..."] } }, inputSchema: { properties: { action: { type: "string" }, schedule: { type: "string" }, payload: { type: "object" }, maxRuns: { type: "number" } }, required: ["action", "schedule", "payload"] }, bodyType: "json", output: { example: { id: "cron_123", status: "active" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/cron/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List scheduled jobs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { jobs: [], total: 0 }, schema: { properties: { jobs: { type: "array" } } } } }) },
      },
      "POST /api/v1/cron/cancel": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Cancel a scheduled job.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { jobId: "cron_123" }, inputSchema: { properties: { jobId: { type: "string" } }, required: ["jobId"] }, bodyType: "json", output: { example: { status: "cancelled" }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/logs/ingest": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Ingest structured logs for debugging agent workflows.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { entries: [{ level: "info", service: "batch-agent", message: "Payment sent" }] }, inputSchema: { properties: { entries: { type: "array" } }, required: ["entries"] }, bodyType: "json", output: { example: { ingested: 1, ids: ["log_123"] }, schema: { properties: { ingested: { type: "number" } } } } }) },
      },
      "GET /api/v1/logs/query": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Query structured logs by service, level, time.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { service: "batch-agent", level: "error" }, inputSchema: { properties: { service: { type: "string" }, level: { type: "string" }, since: { type: "string" }, limit: { type: "string" } } }, output: { example: { logs: [], total: 0 }, schema: { properties: { logs: { type: "array" } } } } }) },
      },

      // ---- IDENTITY & ACCESS ----
      "POST /api/v1/kyc/verify": {
        accepts: [{ scheme: "exact", price: "$0.08", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Initiate KYC/KYB verification for compliance-gated payments.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", type: "individual", level: "basic" }, inputSchema: { properties: { address: { type: "string" }, type: { type: "string" }, level: { type: "string" } }, required: ["address"] }, bodyType: "json", output: { example: { id: "kyc_123", status: "pending" }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },
      "GET /api/v1/kyc/status": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Check KYC verification status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "kyc_123" }, inputSchema: { properties: { id: { type: "string" }, address: { type: "string" } } }, output: { example: { status: "approved", checks: { identity: true, sanctions: true } }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "POST /api/v1/auth/session": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create authenticated session with scoped permissions.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA...", permissions: ["batch:execute", "swap:execute"], ttlSeconds: 3600 }, inputSchema: { properties: { address: { type: "string" }, permissions: { type: "array" }, ttlSeconds: { type: "number" } }, required: ["address"] }, bodyType: "json", output: { example: { token: "spr_abc...", expiresAt: "2026-03-05T00:00:00Z" }, schema: { properties: { token: { type: "string" } } } } }) },
      },
      "GET /api/v1/auth/verify": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Verify session token and check permissions.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "spr_abc..." }, inputSchema: { properties: { token: { type: "string" } }, required: ["token"] }, output: { example: { valid: true, permissions: [] }, schema: { properties: { valid: { type: "boolean" } } } } }) },
      },

      // ---- COMPLIANCE ----
      "POST /api/v1/audit/log": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Record immutable audit trail entry for payments, escrows, compliance.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { action: "payment.sent", actor: "0xd8dA...", resource: "batch_123", details: { amount: "500 USDC" } }, inputSchema: { properties: { action: { type: "string" }, actor: { type: "string" }, resource: { type: "string" }, details: { type: "object" }, txHash: { type: "string" } }, required: ["action", "actor", "resource"] }, bodyType: "json", output: { example: { id: "aud_123", recorded: true }, schema: { properties: { id: { type: "string" } } } } }) },
      },
      "GET /api/v1/audit/query": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Query audit trail by actor, action, resource, time range.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { actor: "0xd8dA...", action: "payment.sent" }, inputSchema: { properties: { actor: { type: "string" }, action: { type: "string" }, resource: { type: "string" }, since: { type: "string" }, until: { type: "string" } } }, output: { example: { entries: [], total: 0 }, schema: { properties: { entries: { type: "array" } } } } }) },
      },
      "POST /api/v1/tax/calculate": {
        accepts: [{ scheme: "exact", price: "$0.08", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Calculate crypto tax gain/loss using FIFO method.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { transactions: [{ type: "swap", asset: "ETH", amount: 1.5, costBasisUsd: 3000, proceedsUsd: 4500, holdingDays: 400 }] }, inputSchema: { properties: { transactions: { type: "array" } }, required: ["transactions"] }, bodyType: "json", output: { example: { summary: { totalGainLossUsd: 1500 } }, schema: { properties: { summary: { type: "object" } } } } }) },
      },
      "GET /api/v1/tax/report": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Retrieve tax report with IRS 8949-compatible data.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { reportId: "tax_123" }, inputSchema: { properties: { reportId: { type: "string" } } }, output: { example: { events: [], total: 0 }, schema: { properties: { events: { type: "array" } } } } }) },
      },

      // ---- GPU/COMPUTE ----
      "POST /api/v1/gpu/run": {
        accepts: [{ scheme: "exact", price: "$0.06", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "GPU/Compute — run AI model inference via Replicate (image, video, LLM, audio, utility).", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "flux-pro", input: { prompt: "a serene mountain lake at sunset" } }, inputSchema: { properties: { model: { type: "string" }, input: { type: "object" }, version: { type: "string" }, webhook: { type: "string" } }, required: ["model", "input"] }, bodyType: "json", output: { example: { id: "abc123", status: "succeeded", model: "black-forest-labs/flux-1.1-pro", output: ["https://replicate.delivery/..."] }, schema: { properties: { id: { type: "string" }, status: { type: "string" }, output: { type: "array" } } } } }) },
      },
      "GET /api/v1/gpu/status/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "GPU/Compute — check prediction status for async jobs.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "abc123" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { id: "abc123", status: "succeeded", output: [] }, schema: { properties: { id: { type: "string" }, status: { type: "string" } } } } }) },
      },

      // ---- SEARCH/RAG ----
      "POST /api/v1/search/web": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Web search with clean, LLM-ready results via Tavily. Basic or advanced depth.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { query: "latest Base ecosystem news", search_depth: "basic", max_results: 5 }, inputSchema: { properties: { query: { type: "string" }, search_depth: { type: "string" }, max_results: { type: "number" }, topic: { type: "string" }, include_domains: { type: "array" }, exclude_domains: { type: "array" } }, required: ["query"] }, bodyType: "json", output: { example: { query: "...", answer: "...", results: [{ title: "...", url: "...", content: "..." }] }, schema: { properties: { query: { type: "string" }, answer: { type: "string" }, results: { type: "array" } } } } }) },
      },
      "POST /api/v1/search/extract": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Extract clean content from URLs for RAG pipelines. Up to 5 URLs per request.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { urls: ["https://docs.base.org/overview"] }, inputSchema: { properties: { urls: { type: "array" } }, required: ["urls"] }, bodyType: "json", output: { example: { results: [{ url: "...", content: "..." }], failed: [] }, schema: { properties: { results: { type: "array" } } } } }) },
      },
      "POST /api/v1/search/qna": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Direct question answering — searches web and synthesizes an answer with sources.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { query: "What is x402 protocol?", topic: "general" }, inputSchema: { properties: { query: { type: "string" }, topic: { type: "string" } }, required: ["query"] }, bodyType: "json", output: { example: { query: "...", answer: "...", sources: [{ title: "...", url: "..." }] }, schema: { properties: { query: { type: "string" }, answer: { type: "string" }, sources: { type: "array" } } } } }) },
      },

      // ---- EXISTING ----
      "GET /api/v1/prices": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Live token prices.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { token: "WETH" }, inputSchema: { properties: { token: { type: "string" } } }, output: { example: { prices: {} }, schema: { properties: { prices: { type: "object" } } } } }) },
      },
      "GET /api/v1/balances": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Token balances.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { balances: [] }, schema: { properties: { balances: { type: "array" } } } } }) },
      },
      "GET /api/v1/resolve": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "ENS/Basename resolution.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { name: "vitalik.eth" }, inputSchema: { properties: { name: { type: "string" } }, required: ["name"] }, output: { example: { address: "0xd8dA..." }, schema: { properties: { address: { type: "string" } } } } }) },
      },
      "GET /api/v1/wallet/list": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List agent wallets with pagination.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { wallets: [], pagination: {} }, schema: { properties: { wallets: { type: "array" } } } } }) },
      },
      "GET /api/v1/wallet/:walletId": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get agent wallet details.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { walletId: "", addresses: {} }, schema: { properties: { walletId: { type: "string" } } } } }) },
      },
      "GET /api/v1/wallet/:walletId/addresses": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get chain-specific addresses for a wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { addresses: {} }, schema: { properties: { addresses: { type: "object" } } } } }) },
      },
      "POST /api/v1/wallet/sign-message": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Sign a message with an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletId: "...", message: "Hello" }, inputSchema: { properties: { walletId: { type: "string" }, message: { type: "string" } }, required: ["walletId", "message"] }, bodyType: "json", output: { example: { signature: "..." }, schema: { properties: { signature: { type: "string" } } } } }) },
      },
      "POST /api/v1/wallet/send-transaction": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Sign and broadcast a transaction from an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletId: "...", transaction: {}, networkId: "base-mainnet" }, inputSchema: { properties: { walletId: { type: "string" }, transaction: { type: "object" }, networkId: { type: "string" } }, required: ["walletId", "transaction", "networkId"] }, bodyType: "json", output: { example: { signature: "..." }, schema: { properties: { signature: { type: "string" } } } } }) },
      },
      // Robotics / RTP (Category 15)
      "POST /api/v1/robots/task": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Dispatch a paid task to an RTP-registered robot. x402 payment held in escrow until completion.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { robot_id: "robo_abc123", task: "pick", parameters: { item: "SKU-00421", from_location: "bin_A3" } }, inputSchema: { properties: { robot_id: { type: "string" }, task: { type: "string" }, parameters: { type: "object" }, callback_url: { type: "string" }, timeout_seconds: { type: "number" } }, required: ["robot_id", "task"] }, bodyType: "json", output: { example: { status: "DISPATCHED", task_id: "task_xyz789", escrow_id: "escrow_001" }, schema: { properties: { status: { type: "string" }, task_id: { type: "string" } } } } }) },
      },
      "GET /api/v1/robots/list": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Discover RTP robots. Filter by capability, chain, price, status.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { capability: "pick", max_price: "0.10" }, inputSchema: { properties: { capability: { type: "string" }, chain: { type: "string" }, max_price: { type: "string" }, status: { type: "string" } } }, output: { example: { robots: [], total: 0 }, schema: { properties: { robots: { type: "array" }, total: { type: "number" } } } } }) },
      },
      "GET /api/v1/robots/status": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Poll RTP task status: PENDING, DISPATCHED, IN_PROGRESS, COMPLETED, FAILED, TIMEOUT.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { task_id: "task_xyz789" }, inputSchema: { properties: { task_id: { type: "string" } }, required: ["task_id"] }, output: { example: { task_id: "task_xyz789", status: "COMPLETED", result: {} }, schema: { properties: { status: { type: "string" } } } } }) },
      },
      "GET /api/v1/robots/profile": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Full RTP robot profile: capabilities, pricing, connection type.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { robot_id: "robo_abc123" }, inputSchema: { properties: { robot_id: { type: "string" } }, required: ["robot_id"] }, output: { example: { robot_id: "robo_abc123", capabilities: ["pick", "place"] }, schema: { properties: { robot_id: { type: "string" }, capabilities: { type: "array" } } } } }) },
      },
      // ---- AGENT WALLET (Category 17) ----
      "POST /api/v1/agent-wallet/provision": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create a smart contract wallet for an AI agent on Base. Returns wallet address and optional encrypted key.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { agentId: "trading-bot-007", agentType: "langchain", mode: "managed" }, inputSchema: { properties: { agentId: { type: "string" }, agentType: { type: "string" }, mode: { type: "string" }, ownerAddress: { type: "string" } }, required: ["agentId"] }, bodyType: "json", output: { example: { status: "created", wallet: { walletAddress: "0x...", chainId: 8453 } }, schema: { properties: { status: { type: "string" }, wallet: { type: "object" } } } } }) },
      },
      "POST /api/v1/agent-wallet/session-key": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Add a session key with spending limits and time bounds to an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletAddress: "0x...", sessionKeyAddress: "0x...", spendLimitEth: "0.5", durationHours: 24 }, inputSchema: { properties: { walletAddress: { type: "string" }, sessionKeyAddress: { type: "string" }, spendLimitEth: { type: "string" }, durationHours: { type: "number" }, allowedTargets: { type: "array" } }, required: ["walletAddress", "sessionKeyAddress", "spendLimitEth", "durationHours"] }, bodyType: "json", output: { example: { status: "created", session: { expiresAt: "2025-01-01T00:00:00Z" } }, schema: { properties: { status: { type: "string" }, session: { type: "object" } } } } }) },
      },
      "GET /api/v1/agent-wallet/info": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get agent wallet info including balance, metadata, and session keys.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0x..." }, inputSchema: { properties: { address: { type: "string" } }, required: ["address"] }, output: { example: { wallet: { balanceEth: "0.5", agentId: "bot-001" } }, schema: { properties: { wallet: { type: "object" } } } } }) },
      },
      "POST /api/v1/agent-wallet/revoke-key": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Revoke a session key immediately.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { walletAddress: "0x...", sessionKeyAddress: "0x..." }, inputSchema: { properties: { walletAddress: { type: "string" }, sessionKeyAddress: { type: "string" } }, required: ["walletAddress", "sessionKeyAddress"] }, bodyType: "json", output: { example: { status: "revoked", txHash: "0x..." }, schema: { properties: { status: { type: "string" }, txHash: { type: "string" } } } } }) },
      },
      "GET /api/v1/agent-wallet/predict": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Predict agent wallet address before deployment.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { ownerAddress: "0x...", agentId: "bot-001" }, inputSchema: { properties: { ownerAddress: { type: "string" }, agentId: { type: "string" } }, required: ["ownerAddress", "agentId"] }, output: { example: { predictedAddress: "0x..." }, schema: { properties: { predictedAddress: { type: "string" } } } } }) },
      },

      // ---- CATEGORY 19: BITTENSOR DROP-IN API (OpenAI-compatible) ----
      "GET /bittensor/v1/models": {
        accepts: [{ scheme: "exact", price: "$0.001", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "List all AI models on Bittensor. OpenAI /v1/models compatible. Drop-in: just change base_url to gateway.spraay.app/bittensor/v1", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ output: { example: { object: "list", data: [{ id: "deepseek-ai/DeepSeek-R1-0528", object: "model" }] }, schema: { properties: { object: { type: "string" }, data: { type: "array" } } } } }) },
      },
      "POST /bittensor/v1/chat/completions": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Chat completions via Bittensor decentralized AI. Fully OpenAI-compatible. 43+ models (DeepSeek, Qwen, Llama, Mistral). Streaming, function calling, TEE-verified. Drop-in: just change base_url.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "deepseek-ai/DeepSeek-V3-0324", messages: [{ role: "user", content: "What is decentralized AI?" }], max_tokens: 256 }, inputSchema: { properties: { model: { type: "string" }, messages: { type: "array" }, max_tokens: { type: "number" }, temperature: { type: "number" }, stream: { type: "boolean" }, tools: { type: "array" } }, required: ["model", "messages"] }, bodyType: "json", output: { example: { id: "chatcmpl-abc", choices: [{ message: { role: "assistant", content: "..." } }], usage: { total_tokens: 57 } }, schema: { properties: { choices: { type: "array" }, usage: { type: "object" } } } } }) },
      },
      "POST /bittensor/v1/images/generations": {
        accepts: [{ scheme: "exact", price: "$0.05", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Image generation via Bittensor Subnet 19 (Nineteen AI). OpenAI /v1/images/generations compatible.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { prompt: "A cyberpunk city powered by decentralized AI" }, inputSchema: { properties: { prompt: { type: "string" }, model: { type: "string" }, n: { type: "number" }, size: { type: "string" } }, required: ["prompt"] }, bodyType: "json", output: { example: { data: [{ url: "https://..." }] }, schema: { properties: { data: { type: "array" } } } } }) },
      },
      "POST /bittensor/v1/embeddings": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Text embeddings via Bittensor. OpenAI /v1/embeddings compatible. Use for RAG, semantic search, similarity.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { model: "BAAI/bge-large-en-v1.5", input: "Decentralized AI" }, inputSchema: { properties: { model: { type: "string" }, input: { type: "string" } }, required: ["model", "input"] }, bodyType: "json", output: { example: { object: "list", data: [{ embedding: [0.0023] }] }, schema: { properties: { data: { type: "array" } } } } }) },
      },
      // ---- CATEGORY 18: SCTP (Supply Chain Task Protocol) ----
      "POST /api/v1/sctp/supplier": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Register a supplier in the SCTP directory.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { name: "Acme Corp", wallet: "0x...", paymentPrefs: { token: "USDC" } }, inputSchema: { properties: { name: { type: "string" }, wallet: { type: "string" }, paymentPrefs: { type: "object" } }, required: ["name", "wallet"] }, bodyType: "json", output: { example: { status: "created", supplier: { id: "SUP-A1B2" } }, schema: { properties: { status: { type: "string" }, supplier: { type: "object" } } } } }) },
      },
      "GET /api/v1/sctp/supplier/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get supplier details by ID.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "SUP-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { supplier: { id: "SUP-A1B2", name: "Acme Corp" } }, schema: { properties: { supplier: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/po": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Create a purchase order with line items and supplier.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { supplierId: "SUP-A1B2", lineItems: [{ sku: "ABC", qty: 10, price: "100" }], currency: "USDC" }, inputSchema: { properties: { supplierId: { type: "string" }, lineItems: { type: "array" }, currency: { type: "string" } }, required: ["supplierId", "lineItems"] }, bodyType: "json", output: { example: { status: "created", po: { id: "PO-A1B2" } }, schema: { properties: { status: { type: "string" }, po: { type: "object" } } } } }) },
      },
      "GET /api/v1/sctp/po/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get purchase order details.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "PO-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { po: { id: "PO-A1B2", status: "open" } }, schema: { properties: { po: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/invoice": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Submit an invoice linked to a purchase order.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { poId: "PO-A1B2", supplierId: "SUP-A1B2", amount: "1000", currency: "USDC" }, inputSchema: { properties: { poId: { type: "string" }, supplierId: { type: "string" }, amount: { type: "string" }, currency: { type: "string" } }, required: ["poId", "supplierId", "amount"] }, bodyType: "json", output: { example: { status: "submitted", invoice: { id: "INV-A1B2" } }, schema: { properties: { status: { type: "string" }, invoice: { type: "object" } } } } }) },
      },
      "GET /api/v1/sctp/invoice/:id": {
        accepts: [{ scheme: "exact", price: "$0.005", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Get invoice details.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { id: "INV-A1B2" }, inputSchema: { properties: { id: { type: "string" } }, required: ["id"] }, output: { example: { invoice: { id: "INV-A1B2", status: "submitted" } }, schema: { properties: { invoice: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/invoice/verify": {
        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "AI-verify an invoice against its purchase order. Returns match score and flags.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { invoiceId: "INV-A1B2" }, inputSchema: { properties: { invoiceId: { type: "string" } }, required: ["invoiceId"] }, bodyType: "json", output: { example: { verification: { matchScore: 0.98, flags: [], status: "verified" } }, schema: { properties: { verification: { type: "object" } } } } }) },
      },
      "POST /api/v1/sctp/pay": {
        accepts: [{ scheme: "exact", price: "$0.10", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Execute supplier payment for a verified invoice via batch settlement.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { invoiceId: "INV-A1B2", batch: false }, inputSchema: { properties: { invoiceId: { type: "string" }, batch: { type: "boolean" } }, required: ["invoiceId"] }, bodyType: "json", output: { example: { status: "paid", txHash: "0x...", amount: "1000" }, schema: { properties: { status: { type: "string" }, txHash: { type: "string" } } } } }) },
      },
      "GET /api/v1/portfolio/tokens": {
        accepts: [{ scheme: "exact", price: "$0.008", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-chain token portfolio (native + ERC-20) with USD values.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", networks: "base-mainnet,eth-mainnet" }, inputSchema: { properties: { address: { type: "string" }, networks: { type: "string" }, includeNative: { type: "boolean" }, includeErc20: { type: "boolean" }, includePrices: { type: "boolean" } }, required: ["address"] }, output: { example: { address: "0xd8dA...", token_count: 42, total_usd_value: 12345.67, tokens: [] }, schema: { properties: { address: { type: "string" }, token_count: { type: "number" }, total_usd_value: { type: "number" }, tokens: { type: "array" } } } } }) },
      },
      "GET /api/v1/portfolio/nfts": {
        accepts: [{ scheme: "exact", price: "$0.01", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Multi-chain NFT holdings with metadata.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", networks: "base-mainnet" }, inputSchema: { properties: { address: { type: "string" }, networks: { type: "string" }, withMetadata: { type: "boolean" }, pageSize: { type: "number" }, pageKey: { type: "string" } }, required: ["address"] }, output: { example: { address: "0xd8dA...", total_count: 12, returned_count: 12, nfts: [] }, schema: { properties: { address: { type: "string" }, total_count: { type: "number" }, nfts: { type: "array" } } } } }) },
      },
      "POST /api/v1/contract/read": {
        accepts: [{ scheme: "exact", price: "$0.002", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Call any view/pure function on any EVM contract.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", method: "balanceOf(address)", args: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"] }, inputSchema: { properties: { chain: { type: "string" }, address: { type: "string" }, method: { type: "string" }, args: { type: "array" }, abi: { type: "array" } }, required: ["address", "method"] }, bodyType: "json", output: { example: { chain: "base-mainnet", address: "0x833...", method: "balanceOf(address)", result: "1000000" }, schema: { properties: { chain: { type: "string" }, result: {} } } } }) },
      },
      "POST /api/v1/contract/write": {
        accepts: [{ scheme: "exact", price: "$0.015", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "Encode and broadcast a transaction via an agent wallet.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", method: "transfer(address,uint256)", args: ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "1000000"], walletId: "wallet_abc" }, inputSchema: { properties: { chain: { type: "string" }, address: { type: "string" }, method: { type: "string" }, args: { type: "array" }, abi: { type: "array" }, value: { type: "string" }, walletId: { type: "string" }, privateKey: { type: "string" } }, required: ["address", "method"] }, bodyType: "json", output: { example: { tx_hash: "0xabc...", from: "0x...", explorer: "https://basescan.org/tx/0xabc..." }, schema: { properties: { tx_hash: { type: "string" }, from: { type: "string" }, explorer: { type: "string" } } } } }) },
      },
      "GET /api/v1/defi/positions": {
        accepts: [{ scheme: "exact", price: "$0.02", network: CAIP2_NETWORK, payTo: PAY_TO }],
        description: "On-chain DeFi positions across Aave V3, Compound V3, Aerodrome on Base.", mimeType: "application/json",
        extensions: { ...declareDiscoveryExtension({ input: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", chain: "base-mainnet" }, inputSchema: { properties: { address: { type: "string" }, chain: { type: "string" } }, required: ["address"] }, output: { example: { address: "0xd8dA...", chain: "base-mainnet", total_positions: 3, protocols_with_exposure: ["aave-v3", "aerodrome"], positions: [] }, schema: { properties: { address: { type: "string" }, total_positions: { type: "number" }, positions: { type: "array" } } } } }) },
      },
    },
    server
  )
);

// FREE ROUTES
app.get("/.well-known/x402.json", (_req, res) => {
  res.json({
    x402Version: 2, name: "Spraay x402 Gateway",
    description: "Full-stack DeFi infrastructure: AI, payments, swaps, oracle, bridge, payroll, invoicing, escrow, inference, analytics, communication, identity, compliance, scheduling, GPU/Compute, Search/RAG & more.",
    homepage: BASE_URL, repository: "https://github.com/plagtech/spraay-x402-gateway",
    network: CAIP2_NETWORK, payTo: PAY_TO,
    facilitator: IS_MAINNET ? "https://api.cdp.coinbase.com/platform/v2/x402" : FACILITATOR_URL,
    resources: [
      { resource: `${BASE_URL}/api/v1/chat/completions`, method: "POST", price: "$0.04", category: "ai" },
      { resource: `${BASE_URL}/api/v1/models`, method: "GET", price: "$0.001", category: "ai" },
      { resource: `${BASE_URL}/api/v1/batch/execute`, method: "POST", price: "$0.02", category: "payments" },
      { resource: `${BASE_URL}/api/v1/batch/estimate`, method: "POST", price: "$0.001", category: "payments" },
      { resource: `${BASE_URL}/api/v1/swap/quote`, method: "GET", price: "$0.008", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/tokens`, method: "GET", price: "$0.001", category: "defi" },
      { resource: `${BASE_URL}/api/v1/swap/execute`, method: "POST", price: "$0.015", category: "defi" },
      { resource: `${BASE_URL}/api/v1/oracle/prices`, method: "GET", price: "$0.008", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/gas`, method: "GET", price: "$0.005", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/oracle/fx`, method: "GET", price: "$0.008", category: "oracle" },
      { resource: `${BASE_URL}/api/v1/bridge/quote`, method: "GET", price: "$0.05", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/bridge/chains`, method: "GET", price: "$0.002", category: "bridge" },
      { resource: `${BASE_URL}/api/v1/payroll/execute`, method: "POST", price: "$0.10", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/estimate`, method: "POST", price: "$0.003", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/payroll/tokens`, method: "GET", price: "$0.002", category: "payroll" },
      { resource: `${BASE_URL}/api/v1/invoice/create`, method: "POST", price: "$0.05", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/invoice/list`, method: "GET", price: "$0.01", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/invoice/:id`, method: "GET", price: "$0.001", category: "invoice" },
      { resource: `${BASE_URL}/api/v1/analytics/wallet`, method: "GET", price: "$0.01", category: "analytics" },
      { resource: `${BASE_URL}/api/v1/analytics/txhistory`, method: "GET", price: "$0.008", category: "analytics" },
      { resource: `${BASE_URL}/api/v1/escrow/create`, method: "POST", price: "$0.10", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/list`, method: "GET", price: "$0.02", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/:id`, method: "GET", price: "$0.001", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/fund`, method: "POST", price: "$0.02", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/release`, method: "POST", price: "$0.08", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/escrow/cancel`, method: "POST", price: "$0.02", category: "escrow" },
      { resource: `${BASE_URL}/api/v1/inference/classify-address`, method: "POST", price: "$0.03", category: "inference" },
      { resource: `${BASE_URL}/api/v1/inference/classify-tx`, method: "POST", price: "$0.03", category: "inference" },
      { resource: `${BASE_URL}/api/v1/inference/explain-contract`, method: "POST", price: "$0.03", category: "inference" },
      { resource: `${BASE_URL}/api/v1/inference/summarize`, method: "POST", price: "$0.03", category: "inference" },
      // Communication
      { resource: `${BASE_URL}/api/v1/notify/email`, method: "POST", price: "$0.01", category: "communication" },
      { resource: `${BASE_URL}/api/v1/notify/sms`, method: "POST", price: "$0.02", category: "communication" },
      { resource: `${BASE_URL}/api/v1/notify/status`, method: "GET", price: "$0.002", category: "communication" },
      { resource: `${BASE_URL}/api/v1/webhook/register`, method: "POST", price: "$0.01", category: "communication" },
      { resource: `${BASE_URL}/api/v1/webhook/test`, method: "POST", price: "$0.005", category: "communication" },
      { resource: `${BASE_URL}/api/v1/webhook/list`, method: "GET", price: "$0.002", category: "communication" },
      { resource: `${BASE_URL}/api/v1/webhook/delete`, method: "POST", price: "$0.002", category: "communication" },
      { resource: `${BASE_URL}/api/v1/xmtp/send`, method: "POST", price: "$0.01", category: "communication" },
      { resource: `${BASE_URL}/api/v1/xmtp/inbox`, method: "GET", price: "$0.01", category: "communication" },
      // Infrastructure
      { resource: `${BASE_URL}/api/v1/rpc/call`, method: "POST", price: "$0.001", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/rpc/chains`, method: "GET", price: "$0.001", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/storage/pin`, method: "POST", price: "$0.01", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/storage/get`, method: "GET", price: "$0.005", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/storage/status`, method: "GET", price: "$0.002", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/cron/create`, method: "POST", price: "$0.01", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/cron/list`, method: "GET", price: "$0.002", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/cron/cancel`, method: "POST", price: "$0.002", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/logs/ingest`, method: "POST", price: "$0.002", category: "infrastructure" },
      { resource: `${BASE_URL}/api/v1/logs/query`, method: "GET", price: "$0.005", category: "infrastructure" },
      // Identity & Access
      { resource: `${BASE_URL}/api/v1/kyc/verify`, method: "POST", price: "$0.08", category: "identity" },
      { resource: `${BASE_URL}/api/v1/kyc/status`, method: "GET", price: "$0.01", category: "identity" },
      { resource: `${BASE_URL}/api/v1/auth/session`, method: "POST", price: "$0.01", category: "identity" },
      { resource: `${BASE_URL}/api/v1/auth/verify`, method: "GET", price: "$0.005", category: "identity" },
      // Compliance
      { resource: `${BASE_URL}/api/v1/audit/log`, method: "POST", price: "$0.001", category: "compliance" },
      { resource: `${BASE_URL}/api/v1/audit/query`, method: "GET", price: "$0.03", category: "compliance" },
      { resource: `${BASE_URL}/api/v1/tax/calculate`, method: "POST", price: "$0.08", category: "compliance" },
      { resource: `${BASE_URL}/api/v1/tax/report`, method: "GET", price: "$0.05", category: "compliance" },
      // GPU/Compute
      { resource: `${BASE_URL}/api/v1/gpu/run`, method: "POST", price: "$0.06", category: "gpu" },
      { resource: `${BASE_URL}/api/v1/gpu/status/:id`, method: "GET", price: "$0.005", category: "gpu" },
      { resource: `${BASE_URL}/api/v1/gpu/models`, method: "GET", price: "free", category: "gpu" },
      // Search/RAG
      { resource: `${BASE_URL}/api/v1/search/web`, method: "POST", price: "$0.02", category: "search" },
      { resource: `${BASE_URL}/api/v1/search/extract`, method: "POST", price: "$0.02", category: "search" },
      { resource: `${BASE_URL}/api/v1/search/qna`, method: "POST", price: "$0.03", category: "search" },
      // Robotics / RTP
      { resource: `${BASE_URL}/api/v1/robots/register`, method: "POST", price: "free", category: "rtp", rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/task`, method: "POST", price: "$0.05", category: "rtp", rtp: { version: "1.0", description: "Dispatch paid task to robot" } },
      { resource: `${BASE_URL}/api/v1/robots/complete`, method: "POST", price: "free", category: "rtp", rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/list`, method: "GET", price: "$0.005", category: "rtp", rtp: { version: "1.0", description: "Discover robots by capability" } },
      { resource: `${BASE_URL}/api/v1/robots/status`, method: "GET", price: "$0.002", category: "rtp", rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/profile`, method: "GET", price: "$0.002", category: "rtp", rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/update`, method: "PATCH", price: "free", category: "rtp", rtp: { version: "1.0" } },
      { resource: `${BASE_URL}/api/v1/robots/deregister`, method: "POST", price: "free", category: "rtp", rtp: { version: "1.0" } },
      // Agent Wallet (Category 17)
      { resource: `${BASE_URL}/api/v1/agent-wallet/provision`, method: "POST", price: "$0.05", category: "agent-wallet" },
      { resource: `${BASE_URL}/api/v1/agent-wallet/session-key`, method: "POST", price: "$0.02", category: "agent-wallet" },
      { resource: `${BASE_URL}/api/v1/agent-wallet/info`, method: "GET", price: "$0.005", category: "agent-wallet" },
      { resource: `${BASE_URL}/api/v1/agent-wallet/revoke-key`, method: "POST", price: "$0.02", category: "agent-wallet" },
      { resource: `${BASE_URL}/api/v1/agent-wallet/predict`, method: "GET", price: "$0.001", category: "agent-wallet" },
      // Existing data
      { resource: `${BASE_URL}/api/v1/prices`, method: "GET", price: "$0.002", category: "defi" },
      { resource: `${BASE_URL}/api/v1/balances`, method: "GET", price: "$0.005", category: "data" },
      { resource: `${BASE_URL}/api/v1/resolve`, method: "GET", price: "$0.002", category: "identity" },
      { resource: `${BASE_URL}/api/v1/tokens`, method: "GET", price: "free", category: "discovery" },
      // Supply Chain / SCTP (Category 18)
      { resource: `${BASE_URL}/api/v1/sctp/supplier`, method: "POST", price: "$0.02", category: "supply-chain", sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/supplier/:id`, method: "GET", price: "$0.005", category: "supply-chain", sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/po`, method: "POST", price: "$0.02", category: "supply-chain", sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/po/:id`, method: "GET", price: "$0.005", category: "supply-chain", sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/invoice`, method: "POST", price: "$0.02", category: "supply-chain", sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/invoice/:id`, method: "GET", price: "$0.005", category: "supply-chain", sctp: { version: "0.1" } },
      { resource: `${BASE_URL}/api/v1/sctp/invoice/verify`, method: "POST", price: "$0.03", category: "supply-chain", sctp: { version: "0.1", description: "AI-powered invoice verification" } },
      { resource: `${BASE_URL}/api/v1/sctp/pay`, method: "POST", price: "$0.10", category: "supply-chain", sctp: { version: "0.1", description: "Execute supplier payment via Spraay batch contracts" } },
      // Bittensor Drop-in API (Category 19)
      { resource: `${BASE_URL}/bittensor/v1/models`, method: "GET", price: "$0.001", category: "bittensor", bittensor: { openaiCompat: true, description: "List decentralized AI models" } },
      { resource: `${BASE_URL}/bittensor/v1/chat/completions`, method: "POST", price: "$0.03", category: "bittensor", bittensor: { openaiCompat: true, description: "Chat completions via Bittensor SN64" } },
      { resource: `${BASE_URL}/bittensor/v1/images/generations`, method: "POST", price: "$0.05", category: "bittensor", bittensor: { openaiCompat: true, description: "Image generation via Bittensor SN19" } },
      { resource: `${BASE_URL}/bittensor/v1/embeddings`, method: "POST", price: "$0.005", category: "bittensor", bittensor: { openaiCompat: true, description: "Text embeddings via Bittensor" } },
    ],
    updatedAt: new Date().toISOString(),
  });
});

app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    name: "Spraay",
    description: "Full-stack DeFi infrastructure for AI agents on Base. 76 tools for payments, swaps, bridge, payroll, invoicing, escrow, oracle, analytics, AI inference, GPU/Compute, Search/RAG, communication, scheduling, storage, KYC, auth, audit trail, tax, agent wallets & supply chain (SCTP). Agents pay USDC per request via x402.",
    version: "3.7.0",
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
      { name: "spraay_kyc_verify", description: "KYC verification", price: "$0.08" },
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
    ],
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "Spraay x402 Gateway", version: "3.7.0",
    description: "Full-stack DeFi infrastructure: AI, payments, swaps, oracle, bridge, payroll, invoicing, escrow, AI inference, analytics, communication, webhooks, XMTP, RPC, storage, scheduling, logging, KYC, auth, audit trail, tax, GPU/Compute, Search/RAG, Agent Wallets & Supply Chain (SCTP). x402 + USDC.",
    docs: "https://github.com/plagtech/spraay-x402-gateway",
    discovery: `${BASE_URL}/.well-known/x402.json`,
    endpoints: {
      free: { "GET /": "Info", "GET /health": "Health", "GET /stats": "Stats", "GET /.well-known/x402.json": "Discovery", "GET /api/v1/tokens": "Tokens", "GET /api/v1/gpu/models": "GPU Models", "POST /api/v1/robots/register": "Register Robot (RTP)", "POST /api/v1/robots/complete": "Report Task Complete (RTP)", "PATCH /api/v1/robots/update": "Update Robot (RTP)", "POST /api/v1/robots/deregister": "Remove Robot (RTP)", "GET /bittensor/v1/health": "Bittensor health" },
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
        "POST /api/v1/kyc/verify": "$0.08 - KYC verification",
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
      },
    },
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    network: CAIP2_NETWORK, payTo: PAY_TO, protocol: "x402", mainnet: IS_MAINNET, bazaar: "discoverable",
    totalEndpoints: 88,
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

// ============================================
// DISCOVERY ROUTES — kill the 404 bleed
// ============================================
// Path aliases for discovery endpoints agents probe but that would otherwise 404.
// Redirect to the full .json versions above where possible; inline new formats.

// x402 manifest — redirect bare paths to the existing .json version
app.get("/.well-known/x402", (_req, res) => res.redirect(308, "/.well-known/x402.json"));
app.get("/.well-known/x402-resources", (_req, res) => res.redirect(308, "/.well-known/x402.json"));
app.get("/x402-resources", (_req, res) => res.redirect(308, "/.well-known/x402.json"));

// MCP discovery — redirect bare paths to the existing server-card.json
app.get("/.well-known/mcp", (_req, res) => res.redirect(308, "/.well-known/mcp/server-card.json"));
app.get("/mcp", (_req, res) => res.redirect(308, "/.well-known/mcp/server-card.json"));
app.post("/mcp", (_req, res) => res.redirect(308, "/.well-known/mcp/server-card.json"));

// A2A protocol agent card — new format, three path aliases
const agentCardResponse = (_req: express.Request, res: express.Response) => {
  res.json({
    schemaVersion: "0.2.0",
    name: "Spraay x402 Gateway",
    description: "Multi-chain batch payment protocol + x402 gateway with 88+ paid endpoints for autonomous agents. Powered by Spraay Protocol on Base.",
    url: BASE_URL,
    provider: { organization: "Spraay Protocol", url: "https://spraay.app" },
    version: "3.7.0",
    documentationUrl: "https://docs.spraay.app",
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    authentication: {
      schemes: ["x402"],
      credentials: { protocol: "x402", network: CAIP2_NETWORK, acceptedAssets: ["USDC"], payTo: PAY_TO },
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
    ],
    links: {
      fullManifest: `${BASE_URL}/.well-known/x402.json`,
      openapi: `${BASE_URL}/openapi.json`,
      mcp: `${BASE_URL}/.well-known/mcp/server-card.json`,
    },
    _gateway: { provider: "spraay-x402", version: "3.7.0" },
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
    description: "x402 payment gateway for AI agents — pay-per-call access to 88+ endpoints across AI, DeFi, payments, compute, search, and robotics.",
    endpoints: {
      base: BASE_URL,
      agentCard: `${BASE_URL}/.well-known/agent.json`,
      x402Manifest: `${BASE_URL}/.well-known/x402.json`,
      openapi: `${BASE_URL}/openapi.json`,
      mcp: "https://smithery.ai/server/@plagtech/spraay-x402-mcp",
      repository: "https://github.com/plagtech/spraay-x402-gateway",
    },
    categories: ["ai", "payments", "defi", "oracle", "bridge", "payroll", "invoicing", "escrow", "compute", "search", "rtp", "agent-wallet", "supply-chain", "bittensor"],
    network: CAIP2_NETWORK,
    paymentAddress: PAY_TO,
    _gateway: { provider: "spraay-x402", version: "3.7.0" },
  });
});

// LLM crawler standard — plain text summary
app.get("/llms.txt", (_req, res) => {
  const body = `# Spraay x402 Gateway

Pay-per-use infrastructure for autonomous AI agents. Powered by the x402 protocol on Base.

## What this is
Spraay provides 88+ paid API endpoints that agents call with USDC micropayments via HTTP 402. No API keys, no signups — agents pay per-call with on-chain USDC.

## Payment details
- Protocol: x402 (https://x402.org)
- Network: Base mainnet (EVM, chainId 8453)
- Asset: USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
- Pay to: ${PAY_TO}
- Facilitator: Coinbase CDP

## Categories
ai, payments, defi, oracle, bridge, payroll, invoicing, escrow, compute, search, rtp, agent-wallet, supply-chain, bittensor

## Getting started
1. Fund an agent wallet with USDC on Base
2. Send a request to any endpoint below
3. Receive 402 Payment Required with x402 payment terms
4. Retry with the x402 payment header
5. Receive 200 with your data

## Example endpoints
POST ${BASE_URL}/api/v1/chat/completions — $0.04 — OpenAI-compatible chat via 200+ models
POST ${BASE_URL}/bittensor/v1/chat/completions — $0.03 — Bittensor SN64 inference
POST ${BASE_URL}/api/v1/batch/execute — $0.02 — Batch USDC payments on Base
GET ${BASE_URL}/api/v1/oracle/prices — $0.008 — Multi-source price feed
GET ${BASE_URL}/api/v1/swap/quote — $0.008 — Uniswap V3 / Aerodrome quote
POST ${BASE_URL}/api/v1/escrow/create — $0.10 — On-chain escrow
POST ${BASE_URL}/api/v1/payroll/execute — $0.10 — Crypto payroll run
POST ${BASE_URL}/api/v1/gpu/run — $0.06 — GPU workload execution
POST ${BASE_URL}/api/v1/search/qna — $0.03 — Structured Q&A search
POST ${BASE_URL}/api/v1/robots/task — $0.05 — Dispatch robot task (RTP)

## Resources
- Full x402 manifest: ${BASE_URL}/.well-known/x402.json
- Agent card (A2A): ${BASE_URL}/.well-known/agent.json
- OpenAPI 3.1 spec: ${BASE_URL}/openapi.json
- MCP server card: ${BASE_URL}/.well-known/mcp/server-card.json
- Docs: https://docs.spraay.app
- GitHub: https://github.com/plagtech/spraay-x402-gateway
- MCP on Smithery: https://smithery.ai/server/@plagtech/spraay-x402-mcp

## Contact
Twitter: @Spraay_app
Email: hello@spraay.app
`;
  res.type("text/plain; charset=utf-8").send(body);
});

// OpenAPI 3.1 spec
app.get("/openapi.json", (_req, res) => {
  const endpoints = [
    { method: "post", path: "/api/v1/chat/completions", price: "$0.04", tag: "ai", desc: "OpenAI-compatible chat via 200+ models" },
    { method: "post", path: "/bittensor/v1/chat/completions", price: "$0.03", tag: "ai", desc: "Bittensor SN64 inference" },
    { method: "post", path: "/api/v1/batch/execute", price: "$0.02", tag: "payments", desc: "Batch USDC payments on Base" },
    { method: "get", path: "/api/v1/oracle/prices", price: "$0.008", tag: "oracle", desc: "Multi-source price feed" },
    { method: "get", path: "/api/v1/swap/quote", price: "$0.008", tag: "defi", desc: "Uniswap V3 / Aerodrome quote" },
    { method: "post", path: "/api/v1/escrow/create", price: "$0.10", tag: "escrow", desc: "Create on-chain escrow" },
    { method: "post", path: "/api/v1/invoice/create", price: "$0.05", tag: "invoicing", desc: "Generate x402 invoice" },
    { method: "post", path: "/api/v1/payroll/execute", price: "$0.10", tag: "payroll", desc: "Crypto payroll run" },
    { method: "post", path: "/api/v1/gpu/run", price: "$0.06", tag: "compute", desc: "GPU workload execution" },
    { method: "post", path: "/api/v1/search/qna", price: "$0.03", tag: "search", desc: "Structured Q&A search" },
    { method: "post", path: "/api/v1/robots/task", price: "$0.05", tag: "rtp", desc: "Dispatch robot task via RTP" },
    { method: "post", path: "/api/v1/kyc/verify", price: "$0.08", tag: "identity", desc: "Lightweight KYC" },
    { method: "post", path: "/api/v1/agent-wallet/provision", price: "$0.05", tag: "agent-wallet", desc: "Provision agent wallet" },
    { method: "post", path: "/api/v1/sctp/pay", price: "$0.10", tag: "supply-chain", desc: "Execute supplier payment" },
  ];
  const paths: Record<string, any> = {};
  for (const e of endpoints) {
    if (!paths[e.path]) paths[e.path] = {};
    const op: any = {
      summary: e.desc,
      tags: [e.tag],
      description: `Paid endpoint — ${e.price} per call via x402. See ${BASE_URL}/.well-known/x402.json for full payment details.`,
      responses: {
        "200": { description: "Success", content: { "application/json": { schema: { type: "object" } } } },
        "402": { description: "Payment Required — retry with x402 payment header", content: { "application/json": { schema: { type: "object", properties: { accepts: { type: "array" }, x402Version: { type: "number" } } } } } },
      },
    };
    if (e.method === "post") {
      op.requestBody = { required: true, content: { "application/json": { schema: { type: "object" } } } };
    }
    paths[e.path][e.method] = op;
  }
  res.json({
    openapi: "3.1.0",
    info: {
      title: "Spraay x402 Gateway",
      version: "3.7.0",
      description: "Pay-per-use AI, DeFi, payment, compute, and RTP primitives for autonomous agents via x402 on Base.",
      contact: { name: "Spraay", url: "https://spraay.app", email: "hello@spraay.app" },
      license: { name: "MIT" },
    },
    servers: [{ url: BASE_URL, description: "Production (Base mainnet)" }],
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
    version: "3.7.0",
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
    _gateway: { provider: "spraay-x402", version: "3.7.0" },
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
      _gateway: { provider: "spraay-x402", version: "3.7.0" },
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
      _gateway: { provider: "spraay-x402", version: "3.7.0" },
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
    _gateway: { provider: "spraay-x402", version: "3.7.0" },
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
// Bittensor Drop-in API (Category 19) — OpenAI-compatible
app.get("/bittensor/v1/models", dropinModelsHandler);
app.post("/bittensor/v1/chat/completions", dropinChatHandler);
app.post("/bittensor/v1/images/generations", dropinImageHandler);
app.post("/bittensor/v1/embeddings", dropinEmbeddingsHandler);
app.get("/bittensor/v1/health", dropinHealthHandler);

app.listen(PORT, () => {
  console.log(`\n🥭 Spraay x402 Gateway v3.7.0 running on port ${PORT}`);
  console.log(`📡 Network: ${NETWORK} ${IS_MAINNET ? "(MAINNET)" : "(TESTNET)"}`);
  console.log(`💰 Payments to: ${PAY_TO}`);
  console.log(`🤖 RTP Robot Task Protocol endpoints active`);
  console.log(`👛 Agent Wallet provisioning active (Category 17)`);
  console.log(`📦 SCTP Supply Chain endpoints active (Category 18)`);
  console.log(`τ  Bittensor Drop-in API active (Category 19) — SN64 Chutes AI`);
  console.log(`🔍 Discovery endpoints active — .well-known suite, OpenAPI, llms.txt, agent cards`);
  console.log(`💼 Portfolio + Contract + DeFi Positions endpoints active (Categories 20, 21)`);
  console.log(`\n🌐 93 paid + 30+ free/discovery endpoints ready\n`);
});

export default app;
