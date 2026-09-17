// src/lib/coingecko-ids.ts
// Symbol → CoinGecko coin id, shared by every route that resolves a spot or
// historical USD price from CoinGecko.
//
// Lifted verbatim out of routes/tax.ts (which owned the only copy) so
// /free/prices can resolve caller-requested symbols against the SAME table
// instead of growing a second one that drifts. Callers decide what an
// unresolvable symbol means: tax.ts attaches a warning to the transaction,
// /free/prices reports it in its `unknown` array.

export const SYMBOL_TO_CG_ID: Record<string, string> = {
  ETH: "ethereum",
  WETH: "ethereum", // wrapped ETH tracks ETH 1:1 for tax purposes
  BTC: "bitcoin",
  WBTC: "wrapped-bitcoin",
  CBBTC: "coinbase-wrapped-btc",
  SOL: "solana",
  MATIC: "matic-network",
  POL: "polygon-ecosystem-token",
  BNB: "binancecoin",
  AVAX: "avalanche-2",
  XRP: "ripple",
  ARB: "arbitrum",
  OP: "optimism",
  LINK: "chainlink",
  UNI: "uniswap",
  AAVE: "aave",
  CRV: "curve-dao-token",
  MKR: "maker",
  LDO: "lido-dao",
  PEPE: "pepe",
  SHIB: "shiba-inu",
  DOGE: "dogecoin",
  TAO: "bittensor",
  TRUMP: "official-trump",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
  PYUSD: "paypal-usd",
  EURC: "euro-coin",
};
