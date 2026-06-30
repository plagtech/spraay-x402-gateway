// src/routes/paid/stocks.ts — Stock Market Data via Finnhub
// Matches BlockRun's blockrun_price stocks ($0.001/call)
//
// Finnhub free tier: 60 API calls/min, no credit card
// Requires FINNHUB_API_KEY env var (free at finnhub.io)

import { Router, Request, Response } from "express";

const router = Router();

const FINNHUB_BASE = "https://finnhub.io/api/v1";
const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

async function finnhubFetch(path: string): Promise<any> {
  if (!FINNHUB_KEY) throw new Error("FINNHUB_API_KEY not configured");
  const sep = path.includes("?") ? "&" : "?";
  const resp = await fetch(`${FINNHUB_BASE}${path}${sep}token=${FINNHUB_KEY}`);
  if (!resp.ok) throw new Error(`Finnhub ${resp.status}: ${resp.statusText}`);
  return resp.json();
}

// GET /api/v1/stocks/price?symbol=AAPL
router.get("/price", async (req: Request, res: Response) => {
  try {
    const { symbol } = req.query as Record<string, string>;
    if (!symbol) return res.status(400).json({ error: "Missing ?symbol= (e.g. AAPL)" });

    const data: any = await finnhubFetch(`/quote?symbol=${symbol.toUpperCase()}`);

    res.json({
      source: "finnhub",
      symbol: symbol.toUpperCase(),
      current: data.c,
      high: data.h,
      low: data.l,
      open: data.o,
      previousClose: data.pc,
      change: data.d,
      changePercent: data.dp,
      timestamp: data.t,
    });
  } catch (err: any) {
    console.error("[stocks/price] error:", err.message);
    res.status(502).json({ error: "Finnhub error", detail: err.message });
  }
});

// GET /api/v1/stocks/search?q=apple
router.get("/search", async (req: Request, res: Response) => {
  try {
    const { q } = req.query as Record<string, string>;
    if (!q) return res.status(400).json({ error: "Missing ?q= search term" });

    const data: any = await finnhubFetch(`/search?q=${encodeURIComponent(q)}`);

    res.json({
      source: "finnhub",
      query: q,
      count: data.count || 0,
      results: (data.result || []).slice(0, 20).map((r: any) => ({
        symbol: r.symbol,
        description: r.description,
        type: r.type,
        displaySymbol: r.displaySymbol,
      })),
    });
  } catch (err: any) {
    console.error("[stocks/search] error:", err.message);
    res.status(502).json({ error: "Finnhub error", detail: err.message });
  }
});

// GET /api/v1/stocks/history?symbol=AAPL&resolution=D&from=&to=
router.get("/history", async (req: Request, res: Response) => {
  try {
    const { symbol, resolution = "D", from, to } = req.query as Record<string, string>;
    if (!symbol) return res.status(400).json({ error: "Missing ?symbol=" });

    const now = Math.floor(Date.now() / 1000);
    const fromTs = from || String(now - 30 * 86400); // default 30 days
    const toTs = to || String(now);

    const data: any = await finnhubFetch(
      `/stock/candle?symbol=${symbol.toUpperCase()}&resolution=${resolution}&from=${fromTs}&to=${toTs}`
    );

    if (data.s === "no_data") {
      return res.json({ source: "finnhub", symbol: symbol.toUpperCase(), candles: [], note: "No data for range" });
    }

    const candles = (data.t || []).map((t: number, i: number) => ({
      timestamp: t,
      open: data.o[i],
      high: data.h[i],
      low: data.l[i],
      close: data.c[i],
      volume: data.v[i],
    }));

    res.json({
      source: "finnhub",
      symbol: symbol.toUpperCase(),
      resolution,
      count: candles.length,
      candles,
    });
  } catch (err: any) {
    console.error("[stocks/history] error:", err.message);
    res.status(502).json({ error: "Finnhub error", detail: err.message });
  }
});

// GET /api/v1/stocks/company?symbol=AAPL
router.get("/company", async (req: Request, res: Response) => {
  try {
    const { symbol } = req.query as Record<string, string>;
    if (!symbol) return res.status(400).json({ error: "Missing ?symbol=" });

    const data: any = await finnhubFetch(`/stock/profile2?symbol=${symbol.toUpperCase()}`);

    res.json({
      source: "finnhub",
      symbol: data.ticker,
      name: data.name,
      country: data.country,
      currency: data.currency,
      exchange: data.exchange,
      ipo: data.ipo,
      marketCap: data.marketCapitalization,
      industry: data.finnhubIndustry,
      logo: data.logo,
      weburl: data.weburl,
    });
  } catch (err: any) {
    console.error("[stocks/company] error:", err.message);
    res.status(502).json({ error: "Finnhub error", detail: err.message });
  }
});

export default router;
