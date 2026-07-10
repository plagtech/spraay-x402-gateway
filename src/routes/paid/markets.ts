// src/routes/paid/markets.ts — Prediction Markets (Polymarket)
// Matches BlockRun's blockrun_markets ($0.001/query)
//
// Polymarket has a free public API — no keys needed.
// We charge $0.001 per call (same as BlockRun) via the x402 paymentMiddleware.

import { Router, Request, Response } from "express";

const router = Router();

const POLYMARKET_BASE = "https://gamma-api.polymarket.com";
const POLYMARKET_CLOB = "https://clob.polymarket.com";

// ─── Polymarket ──────────────────────────────────────────

// GET /api/v1/markets/polymarket/events?query=&limit=&active=
router.get("/polymarket/events", async (req: Request, res: Response) => {
  try {
    const { query, limit = "10", active = "true", offset = "0" } = req.query as Record<string, string>;
    const params = new URLSearchParams({
      limit: String(Math.min(Number(limit), 50)),
      active: String(active === "true"),
      offset: String(offset),
      ...(query ? { tag_slug: String(query) } : {}),
    });

    const resp = await fetch(`${POLYMARKET_BASE}/events?${params}`);
    if (!resp.ok) throw new Error(`Polymarket ${resp.status}`);
    const events: any[] = await resp.json();

    res.json({
      source: "polymarket",
      count: events.length,
      events: events.map((e: any) => ({
        id: e.id,
        title: e.title,
        slug: e.slug,
        description: e.description?.slice(0, 300),
        active: e.active,
        closed: e.closed,
        volume: e.volume,
        liquidity: e.liquidity,
        startDate: e.startDate,
        endDate: e.endDate,
        markets: (e.markets || []).map((m: any) => ({
          id: m.id,
          question: m.question,
          outcomePrices: m.outcomePrices,
          outcomes: m.outcomes,
          volume: m.volume,
          volume24h: m.volume24hr,
        })),
      })),
    });
  } catch (err: any) {
    console.error("[markets/polymarket] events error:", err.message);
    res.status(502).json({ error: "Polymarket API error", detail: err.message });
  }
});

// GET /api/v1/markets/polymarket/market/:conditionId
router.get("/polymarket/market/:conditionId", async (req: Request, res: Response) => {
  try {
    const { conditionId } = req.params;
    const resp = await fetch(`${POLYMARKET_BASE}/markets/${conditionId}`);
    if (!resp.ok) throw new Error(`Polymarket ${resp.status}`);
    const m: any = await resp.json();

    res.json({
      source: "polymarket",
      id: m.id,
      conditionId: m.conditionId,
      question: m.question,
      description: m.description?.slice(0, 500),
      outcomes: m.outcomes,
      outcomePrices: m.outcomePrices,
      volume: m.volume,
      volume24h: m.volume24hr,
      liquidity: m.liquidity,
      active: m.active,
      closed: m.closed,
      endDate: m.endDate,
      tokens: m.clobTokenIds,
    });
  } catch (err: any) {
    console.error("[markets/polymarket] market error:", err.message);
    res.status(502).json({ error: "Polymarket API error", detail: err.message });
  }
});

// GET /api/v1/markets/polymarket/orderbook/:tokenId
router.get("/polymarket/orderbook/:tokenId", async (req: Request, res: Response) => {
  try {
    const { tokenId } = req.params;
    const resp = await fetch(`${POLYMARKET_CLOB}/book?token_id=${tokenId}`);
    if (!resp.ok) throw new Error(`Polymarket CLOB ${resp.status}`);
    const book: any = await resp.json();

    res.json({
      source: "polymarket-clob",
      tokenId,
      bids: (book.bids || []).slice(0, 20),
      asks: (book.asks || []).slice(0, 20),
      spread: book.spread,
      midpoint: book.midpoint,
    });
  } catch (err: any) {
    console.error("[markets/polymarket] orderbook error:", err.message);
    res.status(502).json({ error: "Polymarket CLOB error", detail: err.message });
  }
});

// GET /api/v1/markets/polymarket/trades/:conditionId?limit=
router.get("/polymarket/trades/:conditionId", async (req: Request, res: Response) => {
  try {
    const { conditionId } = req.params;
    const { limit = "20" } = req.query as Record<string, string>;

    const resp = await fetch(`${POLYMARKET_CLOB}/trades?market=${conditionId}&limit=${Math.min(Number(limit), 100)}`);
    if (!resp.ok) throw new Error(`Polymarket CLOB ${resp.status}`);
    const data: any = await resp.json();

    res.json({
      source: "polymarket-clob",
      conditionId,
      count: data.length,
      trades: (Array.isArray(data) ? data : []).map((t: any) => ({
        id: t.id,
        price: t.price,
        size: t.size,
        side: t.side,
        outcome: t.outcome,
        timestamp: t.timestamp,
      })),
    });
  } catch (err: any) {
    console.error("[markets/polymarket] trades error:", err.message);
    res.status(502).json({ error: "Polymarket CLOB error", detail: err.message });
  }
});

// ─── Search ──────────────────────────────────────────────

// GET /api/v1/markets/search?q=
router.get("/search", async (req: Request, res: Response) => {
  try {
    const { q } = req.query as Record<string, string>;
    if (!q) return res.status(400).json({ error: "Missing ?q= search query" });

    const results: { source: string; query: string; markets: any[]; count?: number } = {
      source: "polymarket",
      query: q,
      markets: [],
    };

    // Polymarket search
    try {
      const pResp = await fetch(`${POLYMARKET_BASE}/events?limit=10&active=true`);
      if (pResp.ok) {
        const events: any[] = await pResp.json();
        const filtered = events.filter((e: any) =>
          e.title?.toLowerCase().includes(q.toLowerCase()) ||
          e.description?.toLowerCase().includes(q.toLowerCase())
        );
        filtered.forEach((e: any) => {
          (e.markets || []).forEach((m: any) => {
            results.markets.push({
              source: "polymarket",
              id: m.id,
              question: m.question,
              outcomePrices: m.outcomePrices,
              volume: m.volume,
            });
          });
        });
      }
    } catch { /* Polymarket search failed, continue */ }

    results.count = results.markets.length;
    res.json(results);
  } catch (err: any) {
    console.error("[markets/search] error:", err.message);
    res.status(502).json({ error: "Market search error", detail: err.message });
  }
});

export default router;
