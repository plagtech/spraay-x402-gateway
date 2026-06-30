/**
 * Spraay Gateway — Centralized Pricing Config
 * 
 * Single source of truth for endpoint pricing.
 * Used by both x402 paymentMiddleware and MPP middleware.
 * Prices are in USD strings (without "$" prefix for MPP).
 * 
 * When you add a new paid route, add it here — both protocols pick it up.
 */

export interface EndpointPrice {
  /** USD price as string, e.g. "0.04" */
  price: string;
  /** Category for analytics/dashboard */
  category: string;
}

/**
 * Route key format: "METHOD /path" — matches the x402 paymentMiddleware key format.
 * This is the COMPLETE list extracted from the existing paymentMiddleware config.
 */
export const ENDPOINT_PRICES: Record<string, EndpointPrice> = {
  // ---- AI ----
  "POST /api/v1/chat/completions":        { price: "0.005", category: "ai" },
  "GET /api/v1/models":                    { price: "0.001", category: "ai" },

  // ---- Batch Payments ----
  "POST /api/v1/batch/execute":            { price: "0.02",  category: "payments" },
  "POST /api/v1/batch/estimate":           { price: "0.001", category: "payments" },

  // ---- Stellar ----
  "POST /api/v1/stellar/batch":            { price: "0.02",  category: "payments" },
  "POST /api/v1/stellar/estimate":         { price: "0.001", category: "payments" },

  // ---- XRP ----
  "POST /api/v1/xrp/batch":               { price: "0.02",  category: "payments" },
  "POST /api/v1/xrp/estimate":            { price: "0.001", category: "payments" },

  // ---- Swap / DeFi ----
  "GET /api/v1/swap/quote":                { price: "0.008", category: "defi" },
  "GET /api/v1/swap/tokens":               { price: "0.001", category: "defi" },
  "POST /api/v1/swap/execute":             { price: "0.015", category: "defi" },

  // ---- Oracle ----
  "GET /api/v1/oracle/prices":             { price: "0.008", category: "oracle" },
  "GET /api/v1/oracle/gas":                { price: "0.005", category: "oracle" },
  "GET /api/v1/oracle/fx":                 { price: "0.008", category: "oracle" },

  // ---- Bridge ----
  "GET /api/v1/bridge/quote":              { price: "0.05",  category: "bridge" },
  "GET /api/v1/bridge/chains":             { price: "0.002", category: "bridge" },

  // ---- Payroll ----
  "POST /api/v1/payroll/execute":          { price: "0.10",  category: "payroll" },
  "POST /api/v1/payroll/estimate":         { price: "0.003", category: "payroll" },
  "GET /api/v1/payroll/tokens":            { price: "0.002", category: "payroll" },

  // ---- Invoice ----
  "POST /api/v1/invoice/create":           { price: "0.05",  category: "invoice" },
  "GET /api/v1/invoice/list":              { price: "0.01",  category: "invoice" },
  "GET /api/v1/invoice/:id":               { price: "0.01",  category: "invoice" },

  // ---- Analytics ----
  "GET /api/v1/analytics/wallet":          { price: "0.01",  category: "analytics" },
  "GET /api/v1/analytics/txhistory":       { price: "0.008", category: "analytics" },

  // ---- Escrow ----
  "POST /api/v1/escrow/create":            { price: "0.10",  category: "escrow" },
  "GET /api/v1/escrow/list":               { price: "0.02",  category: "escrow" },
  "GET /api/v1/escrow/:id":                { price: "0.005", category: "escrow" },
  "POST /api/v1/escrow/fund":              { price: "0.02",  category: "escrow" },
  "POST /api/v1/escrow/release":           { price: "0.08",  category: "escrow" },
  "POST /api/v1/escrow/cancel":            { price: "0.02",  category: "escrow" },

  // ---- Inference ----
  "POST /api/v1/inference/classify-address": { price: "0.03", category: "inference" },
  "POST /api/v1/inference/classify-tx":      { price: "0.03", category: "inference" },
  "POST /api/v1/inference/explain-contract": { price: "0.03", category: "inference" },
  "POST /api/v1/inference/summarize":        { price: "0.03", category: "inference" },

  // ---- Communication ----
  "POST /api/v1/notify/email":             { price: "0.01",  category: "communication" },
  "POST /api/v1/notify/sms":               { price: "0.02",  category: "communication" },
  "GET /api/v1/notify/status":             { price: "0.002", category: "communication" },
  "POST /api/v1/webhook/register":         { price: "0.01",  category: "communication" },
  "POST /api/v1/webhook/test":             { price: "0.005", category: "communication" },
  "GET /api/v1/webhook/list":              { price: "0.002", category: "communication" },
  "POST /api/v1/webhook/delete":           { price: "0.002", category: "communication" },
  "POST /api/v1/xmtp/send":               { price: "0.01",  category: "communication" },
  "GET /api/v1/xmtp/inbox":               { price: "0.01",  category: "communication" },

  // ---- Infrastructure ----
  "POST /api/v1/rpc/call":                 { price: "0.001", category: "infrastructure" },
  "GET /api/v1/rpc/chains":                { price: "0.001", category: "infrastructure" },
  "POST /api/v1/storage/pin":              { price: "0.01",  category: "infrastructure" },
  "GET /api/v1/storage/get":               { price: "0.005", category: "infrastructure" },
  "GET /api/v1/storage/status":            { price: "0.002", category: "infrastructure" },
  "POST /api/v1/cron/create":              { price: "0.01",  category: "infrastructure" },
  "GET /api/v1/cron/list":                 { price: "0.002", category: "infrastructure" },
  "POST /api/v1/cron/cancel":              { price: "0.002", category: "infrastructure" },
  "POST /api/v1/logs/ingest":              { price: "0.002", category: "infrastructure" },
  "GET /api/v1/logs/query":                { price: "0.005", category: "infrastructure" },

  // ---- Identity & Access ----
  "POST /api/v1/kyc/verify":               { price: "0.02",  category: "identity" },
  "GET /api/v1/kyc/status":                { price: "0.01",  category: "identity" },
  "POST /api/v1/auth/session":             { price: "0.01",  category: "identity" },
  "GET /api/v1/auth/verify":               { price: "0.005", category: "identity" },

  // ---- Compliance ----
  "POST /api/v1/audit/log":                { price: "0.005", category: "compliance" },
  "GET /api/v1/audit/query":               { price: "0.03",  category: "compliance" },
  "POST /api/v1/tax/calculate":            { price: "0.08",  category: "compliance" },
  "GET /api/v1/tax/report":                { price: "0.05",  category: "compliance" },

  // ---- GPU/Compute ----
  "POST /api/v1/gpu/run":                  { price: "0.06",  category: "gpu" },
  "GET /api/v1/gpu/status/:id":            { price: "0.005", category: "gpu" },

  // ---- Search/RAG ----
  "POST /api/v1/search/web":               { price: "0.02",  category: "search" },
  "POST /api/v1/search/extract":           { price: "0.02",  category: "search" },
  "POST /api/v1/search/qna":              { price: "0.03",  category: "search" },

  // ---- Data ----
  "GET /api/v1/prices":                    { price: "0.005", category: "data" },
  "GET /api/v1/balances":                  { price: "0.005", category: "data" },
  "GET /api/v1/resolve":                   { price: "0.002", category: "identity" },

  // ---- Robotics / RTP (Category 15) ----
  "POST /api/v1/robots/task":              { price: "0.05",  category: "rtp" },
  "GET /api/v1/robots/list":               { price: "0.005", category: "rtp" },
  "GET /api/v1/robots/status":             { price: "0.002", category: "rtp" },
  "GET /api/v1/robots/profile":            { price: "0.002", category: "rtp" },

  // ---- Wallet Provisioning (Category 14) ----
  "GET /api/v1/wallet/list":               { price: "0.002", category: "wallet" },
  "GET /api/v1/wallet/:walletId":          { price: "0.001", category: "wallet" },
  "GET /api/v1/wallet/:walletId/addresses":{ price: "0.001", category: "wallet" },
  "POST /api/v1/wallet/sign-message":      { price: "0.005", category: "wallet" },
  "POST /api/v1/wallet/send-transaction":  { price: "0.02",  category: "wallet" },

  // ---- Agent Wallet (Category 17) ----
  "POST /api/v1/agent-wallet/provision":   { price: "0.05",  category: "agent-wallet" },
  "POST /api/v1/agent-wallet/session-key": { price: "0.02",  category: "agent-wallet" },
  "GET /api/v1/agent-wallet/info":         { price: "0.005", category: "agent-wallet" },
  "POST /api/v1/agent-wallet/revoke-key":  { price: "0.02",  category: "agent-wallet" },
  "GET /api/v1/agent-wallet/predict":      { price: "0.001", category: "agent-wallet" },

  // ---- Supply Chain / SCTP (Category 18) ----
  "POST /api/v1/sctp/supplier":            { price: "0.02",  category: "supply-chain" },
  "GET /api/v1/sctp/supplier/:id":         { price: "0.005", category: "supply-chain" },
  "POST /api/v1/sctp/po":                  { price: "0.02",  category: "supply-chain" },
  "GET /api/v1/sctp/po/:id":               { price: "0.005", category: "supply-chain" },
  "POST /api/v1/sctp/invoice":             { price: "0.02",  category: "supply-chain" },
  "GET /api/v1/sctp/invoice/:id":          { price: "0.005", category: "supply-chain" },
  "POST /api/v1/sctp/invoice/verify":      { price: "0.03",  category: "supply-chain" },
  "POST /api/v1/sctp/pay":                 { price: "0.10",  category: "supply-chain" },

  // ---- Bittensor Drop-in API (Category 19) ----
  "GET /bittensor/v1/models":              { price: "0.001", category: "bittensor" },
  "POST /bittensor/v1/chat/completions":   { price: "0.03",  category: "bittensor" },
  "POST /bittensor/v1/images/generations": { price: "0.05",  category: "bittensor" },
  "POST /bittensor/v1/embeddings":         { price: "0.005", category: "bittensor" },

  // ---- Portfolio (Category 20) ----
  "GET /api/v1/portfolio/tokens":          { price: "0.008", category: "portfolio" },
  "GET /api/v1/portfolio/nfts":            { price: "0.01",  category: "portfolio" },

  // ---- Contract (Category 21) ----
  "POST /api/v1/contract/read":            { price: "0.002", category: "contract" },
  "POST /api/v1/contract/write":           { price: "0.015", category: "contract" },

  // ---- DeFi Positions ----
  "GET /api/v1/defi/positions":            { price: "0.02",  category: "defi" },

  // ---- Trust / Reputation ----
  "GET /api/v1/trust/score":               { price: "0.03",  category: "trust" },

  // ---- Prediction Markets (BlockRun parity) ----
  "GET /api/v1/markets/polymarket/events":              { price: "0.001", category: "markets" },
  "GET /api/v1/markets/polymarket/market/:conditionId": { price: "0.001", category: "markets" },
  "GET /api/v1/markets/polymarket/orderbook/:tokenId":  { price: "0.001", category: "markets" },
  "GET /api/v1/markets/polymarket/trades/:conditionId": { price: "0.001", category: "markets" },
  "GET /api/v1/markets/kalshi/events":                  { price: "0.001", category: "markets" },
  "GET /api/v1/markets/kalshi/market/:ticker":          { price: "0.001", category: "markets" },
  "GET /api/v1/markets/search":                         { price: "0.002", category: "markets" },

  // ---- Stock Market Data (BlockRun parity) ----
  "GET /api/v1/stocks/price":                           { price: "0.001", category: "stocks" },
  "GET /api/v1/stocks/search":                          { price: "0.001", category: "stocks" },
  "GET /api/v1/stocks/history":                         { price: "0.001", category: "stocks" },
  "GET /api/v1/stocks/company":                         { price: "0.001", category: "stocks" },

  // ---- Image Generation (BlockRun parity) ----
  "POST /api/v1/image/generate":                        { price: "0.06",  category: "image" },
  "POST /api/v1/image/edit":                            { price: "0.05",  category: "image" },
  "GET /api/v1/image/status/:id":                       { price: "0.001", category: "image" },
};

/**
 * Lookup helper — matches "METHOD /path" against the pricing table.
 * Handles Express-style param routes (e.g. /wallet/:walletId → /wallet/abc123).
 */
export function getEndpointPrice(method: string, path: string): EndpointPrice | null {
  // Try exact match first (fastest path, covers ~90% of routes)
  const key = `${method} ${path}`;
  if (ENDPOINT_PRICES[key]) return ENDPOINT_PRICES[key];

  // Try param-pattern matching for routes like /escrow/:id, /wallet/:walletId
  for (const [pattern, price] of Object.entries(ENDPOINT_PRICES)) {
    const [pMethod, pPath] = pattern.split(" ");
    if (pMethod !== method) continue;

    // Convert Express pattern to regex: :param → [^/]+
    const regexStr = "^" + pPath.replace(/:[^/]+/g, "[^/]+") + "$";
    if (new RegExp(regexStr).test(path)) return price;
  }

  return null; // Not a paid route
}
