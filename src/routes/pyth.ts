/**
 * 💧 Spraay Gateway — Solana Pyth price feed endpoints
 *
 * Upstream: Pyth Hermes API (public, no key required)
 * Docs: https://hermes.pyth.network/docs/
 *
 * Routes (wired in index.ts):
 *   GET /api/v1/solana/pyth/price   — $0.005 — latest price for one feed
 *   GET /api/v1/solana/pyth/prices  — $0.008 — batch latest prices (up to 50 feeds)
 *
 * Pyth feed IDs are 64-char hex strings (with or without 0x prefix).
 * Common feeds catalog: https://www.pyth.network/developers/price-feed-ids
 */

import type { Request, Response } from "express";

const HERMES_BASE = "https://hermes.pyth.network";

// Convenience aliases for common feed IDs (mainnet)
// Full list: https://www.pyth.network/developers/price-feed-ids#solana-mainnet-beta
const FEED_ALIASES: Record<string, string> = {
  SOL:   "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC:   "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH:   "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  USDC:  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  USDT:  "2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b",
  JUP:   "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  PYTH:  "0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff",
  BONK:  "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  WIF:   "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc",
  JTO:   "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
};

function normalizeFeedId(input: string): string | null {
  if (!input) return null;
  const upper = input.toUpperCase();
  if (FEED_ALIASES[upper]) return FEED_ALIASES[upper];

  // Strip 0x prefix if present
  const clean = input.startsWith("0x") || input.startsWith("0X") ? input.slice(2) : input;

  // Must be 64-char hex
  if (/^[0-9a-fA-F]{64}$/.test(clean)) return clean.toLowerCase();

  return null;
}

interface HermesPriceUpdate {
  binary: { encoding: string; data: string[] };
  parsed?: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
    ema_price: { price: string; conf: string; expo: number; publish_time: number };
    metadata?: { slot?: number; proof_available_time?: number; prev_publish_time?: number };
  }>;
}

function formatPrice(parsed: NonNullable<HermesPriceUpdate["parsed"]>[number]) {
  const expo = parsed.price.expo;
  const rawPrice = Number(parsed.price.price);
  const rawConf = Number(parsed.price.conf);
  const scaled = rawPrice * Math.pow(10, expo);
  const conf = rawConf * Math.pow(10, expo);
  return {
    feedId: parsed.id,
    price: scaled,
    confidence: conf,
    raw: parsed.price.price,
    expo,
    publishTime: parsed.price.publish_time,
    publishTimeIso: new Date(parsed.price.publish_time * 1000).toISOString(),
    emaPrice: Number(parsed.ema_price.price) * Math.pow(10, parsed.ema_price.expo),
  };
}

/**
 * GET /api/v1/solana/pyth/price
 * Query params:
 *   feedId  (required) — symbol alias (SOL, BTC, ETH...) or 64-char hex feed ID
 */
export async function pythPriceHandler(req: Request, res: Response) {
  try {
    const { feedId: rawFeed } = req.query;

    if (!rawFeed) {
      return res.status(400).json({
        error: "missing_feed_id",
        message: "Pass feedId as a symbol (SOL, BTC, ETH...) or 64-char hex ID",
        availableAliases: Object.keys(FEED_ALIASES),
      });
    }

    const feedId = normalizeFeedId(String(rawFeed));
    if (!feedId) {
      return res.status(400).json({
        error: "invalid_feed_id",
        value: rawFeed,
        message: "Must be a known alias or 64-char hex feed ID",
      });
    }

    const url = new URL(`${HERMES_BASE}/v2/updates/price/latest`);
    url.searchParams.append("ids[]", feedId);
    url.searchParams.set("parsed", "true");

    const upstream = await fetch(url.toString(), { headers: { "Accept": "application/json" } });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(502).json({
        error: "upstream_error",
        source: "pyth-hermes",
        status: upstream.status,
        detail: body.slice(0, 500),
      });
    }

    const data = await upstream.json() as HermesPriceUpdate;
    const parsed = data.parsed?.[0];

    if (!parsed) {
      return res.status(404).json({ error: "feed_not_found", feedId });
    }

    return res.json({
      symbol: String(rawFeed).toUpperCase(),
      ...formatPrice(parsed),
      source: "pyth-hermes",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    return res.status(500).json({ error: "internal_error", message: msg });
  }
}

/**
 * GET /api/v1/solana/pyth/prices
 * Query params:
 *   feedIds (required) — comma-separated list of aliases or hex IDs (max 50)
 */
export async function pythPricesHandler(req: Request, res: Response) {
  try {
    const { feedIds: rawFeeds } = req.query;

    if (!rawFeeds) {
      return res.status(400).json({
        error: "missing_feed_ids",
        message: "Pass feedIds as comma-separated symbols or hex IDs (e.g. SOL,BTC,ETH)",
        availableAliases: Object.keys(FEED_ALIASES),
      });
    }

    const tokens = String(rawFeeds).split(",").map(s => s.trim()).filter(Boolean);
    if (tokens.length === 0) {
      return res.status(400).json({ error: "no_feed_ids_provided" });
    }
    if (tokens.length > 50) {
      return res.status(400).json({ error: "too_many_feeds", max: 50, provided: tokens.length });
    }

    const resolved: Array<{ original: string; feedId: string | null }> = tokens.map(t => ({
      original: t,
      feedId: normalizeFeedId(t),
    }));

    const valid = resolved.filter(r => r.feedId !== null) as Array<{ original: string; feedId: string }>;
    const invalid = resolved.filter(r => r.feedId === null).map(r => r.original);

    if (valid.length === 0) {
      return res.status(400).json({ error: "no_valid_feed_ids", invalid });
    }

    const url = new URL(`${HERMES_BASE}/v2/updates/price/latest`);
    for (const v of valid) {
      url.searchParams.append("ids[]", v.feedId);
    }
    url.searchParams.set("parsed", "true");

    const upstream = await fetch(url.toString(), { headers: { "Accept": "application/json" } });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(502).json({
        error: "upstream_error",
        source: "pyth-hermes",
        status: upstream.status,
        detail: body.slice(0, 500),
      });
    }

    const data = await upstream.json() as HermesPriceUpdate;

    // Map results back to original symbols
    const byFeedId = new Map<string, ReturnType<typeof formatPrice>>();
    for (const p of data.parsed ?? []) {
      // Hermes returns feed IDs sometimes prefixed with 0x — normalize for lookup
      const idKey = p.id.startsWith("0x") ? p.id.slice(2).toLowerCase() : p.id.toLowerCase();
      byFeedId.set(idKey, formatPrice(p));
    }

    const prices: Record<string, ReturnType<typeof formatPrice> | null> = {};
    for (const v of valid) {
      const symbol = v.original.toUpperCase();
      prices[symbol] = byFeedId.get(v.feedId) ?? null;
    }

    return res.json({
      count: valid.length,
      invalid: invalid.length > 0 ? invalid : undefined,
      prices,
      source: "pyth-hermes",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    return res.status(500).json({ error: "internal_error", message: msg });
  }
}
