// src/routes/free/dex.ts — Free DEX data via DexScreener (no API key)
// Matches BlockRun's blockrun_dex (free)

import { Router, Request, Response } from "express";

const router = Router();

const DEXSCREENER_BASE = "https://api.dexscreener.com";

// Cache layer — 15s TTL like our other free endpoints
const cache = new Map<string, { data: any; ts: number }>();
const CACHE_TTL = 15_000;

function cached(key: string, fetcher: (req: Request) => Promise<any>) {
  return async (req: Request, res: Response) => {
    const cacheKey = `${key}:${JSON.stringify(req.params)}:${JSON.stringify(req.query)}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.ts < CACHE_TTL) {
      return res.json(hit.data);
    }
    try {
      const data = await fetcher(req);
      cache.set(cacheKey, { data, ts: Date.now() });
      res.json(data);
    } catch (err: any) {
      console.error(`[free/dex] ${key} error:`, err.message);
      res.status(502).json({ error: "Upstream error", detail: err.message });
    }
  };
}

async function dexFetch(path: string): Promise<any> {
  const resp = await fetch(`${DEXSCREENER_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`DexScreener ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

// GET /free/dex/search?q=PEPE
// Search for token pairs across all chains
router.get("/search", cached("dex-search", async (req: Request) => {
  const q = (req.query.q as string) || "";
  if (!q) throw new Error("Missing ?q= search query");
  const data = await dexFetch(`/latest/dex/search?q=${encodeURIComponent(q)}`);
  return {
    source: "dexscreener",
    query: q,
    pairs: (data.pairs || []).slice(0, 20).map((p: any) => ({
      chain: p.chainId,
      dex: p.dexId,
      baseToken: { symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: p.baseToken?.address },
      quoteToken: { symbol: p.quoteToken?.symbol, name: p.quoteToken?.name },
      priceUsd: p.priceUsd,
      priceNative: p.priceNative,
      volume24h: p.volume?.h24,
      priceChange24h: p.priceChange?.h24,
      liquidity: p.liquidity?.usd,
      fdv: p.fdv,
      pairAddress: p.pairAddress,
      url: p.url,
    })),
  };
}));

// GET /free/dex/pairs/:chainId/:pairAddress
// Get detailed pair info
router.get("/pairs/:chainId/:pairAddress", cached("dex-pair", async (req: Request) => {
  const { chainId, pairAddress } = req.params;
  const data = await dexFetch(`/latest/dex/pairs/${chainId}/${pairAddress}`);
  const p = data.pairs?.[0];
  if (!p) throw new Error("Pair not found");
  return {
    source: "dexscreener",
    chain: p.chainId,
    dex: p.dexId,
    baseToken: p.baseToken,
    quoteToken: p.quoteToken,
    priceUsd: p.priceUsd,
    priceNative: p.priceNative,
    volume: p.volume,
    priceChange: p.priceChange,
    liquidity: p.liquidity,
    fdv: p.fdv,
    txns: p.txns,
    pairAddress: p.pairAddress,
    url: p.url,
  };
}));

// GET /free/dex/tokens/:address
// Get all pairs for a token address
router.get("/tokens/:address", cached("dex-token", async (req: Request) => {
  const { address } = req.params;
  const data = await dexFetch(`/latest/dex/tokens/${address}`);
  return {
    source: "dexscreener",
    token: address,
    pairCount: data.pairs?.length || 0,
    pairs: (data.pairs || []).slice(0, 20).map((p: any) => ({
      chain: p.chainId,
      dex: p.dexId,
      quoteToken: p.quoteToken?.symbol,
      priceUsd: p.priceUsd,
      volume24h: p.volume?.h24,
      liquidity: p.liquidity?.usd,
      pairAddress: p.pairAddress,
    })),
  };
}));

// GET /free/dex/trending
// Trending tokens/pairs (DexScreener boosted tokens as proxy)
router.get("/trending", cached("dex-trending", async () => {
  const data = await dexFetch("/token-boosts/latest/v1");
  return {
    source: "dexscreener",
    trending: (Array.isArray(data) ? data : []).slice(0, 20).map((t: any) => ({
      chain: t.chainId,
      tokenAddress: t.tokenAddress,
      symbol: t.symbol || t.tokenAddress?.slice(0, 8),
      description: t.description,
      url: t.url,
    })),
  };
}));

export default router;
