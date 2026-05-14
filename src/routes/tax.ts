// ═══════════════════════════════════════════════════════════════
// tax.ts — Transaction-level crypto P&L calculation
//
// Resolves historical USD prices for the last 365 days automatically;
// callers may supply explicit prices for older dates or non-listed
// assets. Prices are cached in Supabase forever — historical prices
// never change.
//
// Scope: per-transaction realized gain/loss in USD. NOT a tax-lot
//        FIFO/LIFO accounting engine (that requires the caller's
//        complete acquisition history, which the API can't assume).
//
// Exports:
//   taxCalculateHandler  POST /api/v1/tax/calculate
//   taxReportHandler     GET  /api/v1/tax/report
// ═══════════════════════════════════════════════════════════════

import { Request, Response } from "express";
import { taxDb, supabase } from "../db.js";

// ── Config ─────────────────────────────────────────────────

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || "";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const HISTORY_TIMEOUT_MS = 8000;
const MAX_TRANSACTIONS = 500;

// Historical price data covers the last 365 days. Older dates require
// the caller to supply priceAtAcquisition / priceAtDisposal explicitly.
const HISTORY_WINDOW_DAYS = 365;
const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

// Symbol → CoinGecko coin id. Add more as needed; unknown symbols
// fall through to a default-zero with a warning attached to the tx.
const SYMBOL_TO_CG_ID: Record<string, string> = {
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

// Stablecoins assumed to be $1.00 — skip the API call.
const STABLES = new Set(["USDC", "USDT", "DAI", "PYUSD"]);

// ── Helpers ────────────────────────────────────────────────

function genId(): string {
  return `tax_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

function normalizeSymbol(s: any): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toUpperCase();
  return t.length > 0 && t.length <= 20 ? t : null;
}

/** Convert any timestamp the caller might send into "DD-MM-YYYY" — CoinGecko's required format. */
function toCgDate(input: any): { date: string; outOfWindow: boolean } | null {
  if (!input) return null;
  let d: Date;
  if (typeof input === "number") {
    // unix seconds or ms
    d = new Date(input > 1e12 ? input : input * 1000);
  } else if (typeof input === "string") {
    d = new Date(input);
  } else {
    return null;
  }
  if (isNaN(d.getTime())) return null;
  // Reject future dates — no prices for the future.
  if (d.getTime() > Date.now()) return null;
  // Flag dates outside the 365-day historical window so the caller knows
  // we can't auto-resolve a price; they'll need to supply one.
  const outOfWindow = d.getTime() < Date.now() - HISTORY_WINDOW_MS;
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = d.getUTCFullYear();
  return { date: `${dd}-${mm}-${yyyy}`, outOfWindow };
}

// ── Price cache (Supabase) ─────────────────────────────────
// Historical prices are immutable. We cache by (coin_id, date) and
// only hit CoinGecko on cache miss. Schema:
//   create table price_cache (
//     coin_id   text not null,
//     date      text not null,   -- "DD-MM-YYYY"
//     price_usd numeric not null,
//     fetched_at timestamptz default now(),
//     primary key (coin_id, date)
//   );
// If the table doesn't exist, the code falls back to direct API
// lookups — no fatal failure.

async function cacheGet(coinId: string, date: string): Promise<number | null> {
  try {
    const { data, error } = await supabase
      .from("price_cache")
      .select("price_usd")
      .eq("coin_id", coinId)
      .eq("date", date)
      .maybeSingle();
    if (error || !data) return null;
    return typeof data.price_usd === "number"
      ? data.price_usd
      : parseFloat(data.price_usd);
  } catch {
    return null;
  }
}

async function cacheSet(coinId: string, date: string, price: number): Promise<void> {
  try {
    await (supabase.from("price_cache") as any).upsert(
      { coin_id: coinId, date, price_usd: price, fetched_at: new Date().toISOString() },
      { onConflict: "coin_id,date" }
    );
  } catch (e: any) {
    // Cache is best-effort. Log but don't fail the request.
    console.warn(`[tax] price_cache upsert failed: ${e?.message || e}`);
  }
}

// ── CoinGecko historical price lookup ──────────────────────

async function fetchHistoricalPrice(coinId: string, date: string): Promise<number | null> {
  const url = new URL(`${COINGECKO_BASE}/coins/${coinId}/history`);
  url.searchParams.set("date", date);
  url.searchParams.set("localization", "false");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (COINGECKO_API_KEY) headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HISTORY_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    if (!res.ok) {
      console.warn(`[tax] coingecko ${coinId} ${date} → ${res.status}`);
      return null;
    }
    const json: any = await res.json();
    const price = json?.market_data?.current_price?.usd;
    if (typeof price !== "number" || !isFinite(price)) return null;
    return price;
  } catch (e: any) {
    console.warn(`[tax] coingecko fetch error for ${coinId} ${date}: ${e?.message || e}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Look up the USD price of `symbol` on `date`. Cache-first, then CoinGecko. */
async function priceOn(symbol: string, date: string | null): Promise<number | null> {
  if (!date) return null;
  if (STABLES.has(symbol)) return 1.0;
  const coinId = SYMBOL_TO_CG_ID[symbol];
  if (!coinId) return null; // unknown asset

  const cached = await cacheGet(coinId, date);
  if (cached !== null) return cached;

  const live = await fetchHistoricalPrice(coinId, date);
  if (live !== null) await cacheSet(coinId, date, live);
  return live;
}

// ── POST /api/v1/tax/calculate ─────────────────────────────
//
// Body:
//   transactions: [
//     {
//       type: "swap" | "sale" | "transfer" | "income"   (optional, default "swap")
//       asset: "ETH"                                     (required, symbol from registry)
//       amount: 1.5                                      (required, number)
//       acquisitionDate: ISO date or unix epoch          (optional)
//       disposalDate:    ISO date or unix epoch          (optional)
//       priceAtAcquisition: 2400.0                       (optional override, in USD)
//       priceAtDisposal:    3200.0                       (optional override, in USD)
//       costBasisUsd:  3600.0                            (optional override, in USD)
//       proceedsUsd:   4800.0                            (optional override, in USD)
//       txHash: "0x..."                                  (optional)
//       holdingDays: 90                                  (optional, computed from dates if missing)
//     }
//   ]
//
// Returns per-transaction P&L plus aggregate summary.

export async function taxCalculateHandler(req: Request, res: Response) {
  try {
    const { transactions } = req.body || {};
    if (!Array.isArray(transactions) || transactions.length === 0) {
      return res.status(400).json({ error: "Missing required field: transactions[] (non-empty array)" });
    }
    if (transactions.length > MAX_TRANSACTIONS) {
      return res.status(400).json({ error: `Max ${MAX_TRANSACTIONS} transactions per batch` });
    }

    const events: any[] = [];
    const warnings: string[] = [];
    let priceCacheHits = 0;
    let priceCacheMisses = 0;

    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];

      // ── Validate the transaction ─────────────────────
      const symbol = normalizeSymbol(tx?.asset);
      if (!symbol) {
        return res.status(400).json({ error: `transactions[${i}]: missing or invalid 'asset' symbol` });
      }
      const amount = Number(tx?.amount);
      if (!isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: `transactions[${i}]: 'amount' must be a positive number` });
      }

      const type = ["swap", "sale", "transfer", "income"].includes(tx?.type) ? tx.type : "swap";
      const acqInfo = toCgDate(tx?.acquisitionDate);
      const dispInfo = toCgDate(tx?.disposalDate);
      const acquisitionDate = acqInfo?.date || null;
      const disposalDate = dispInfo?.date || null;

      // ── Resolve prices (caller override → cache → CoinGecko) ──
      let priceAtAcq: number | null =
        typeof tx?.priceAtAcquisition === "number" ? tx.priceAtAcquisition : null;
      let priceAtDisp: number | null =
        typeof tx?.priceAtDisposal === "number" ? tx.priceAtDisposal : null;
      let acqSource = "caller-provided";
      let dispSource = "caller-provided";

      if (priceAtAcq === null && acquisitionDate) {
        if (acqInfo!.outOfWindow) {
          acqSource = "out-of-window";
        } else {
          const cgId = SYMBOL_TO_CG_ID[symbol];
          const cached = cgId ? await cacheGet(cgId, acquisitionDate) : null;
          if (cached !== null) {
            priceAtAcq = cached;
            acqSource = "cache";
            priceCacheHits++;
          } else {
            priceAtAcq = await priceOn(symbol, acquisitionDate);
            acqSource = priceAtAcq !== null ? "lookup" : "unavailable";
            if (priceAtAcq !== null) priceCacheMisses++;
          }
        }
      }
      if (priceAtDisp === null && disposalDate) {
        if (dispInfo!.outOfWindow) {
          dispSource = "out-of-window";
        } else {
          const cgId = SYMBOL_TO_CG_ID[symbol];
          const cached = cgId ? await cacheGet(cgId, disposalDate) : null;
          if (cached !== null) {
            priceAtDisp = cached;
            dispSource = "cache";
            priceCacheHits++;
          } else {
            priceAtDisp = await priceOn(symbol, disposalDate);
            dispSource = priceAtDisp !== null ? "lookup" : "unavailable";
            if (priceAtDisp !== null) priceCacheMisses++;
          }
        }
      }

      // ── Compute cost basis and proceeds ──────────────
      let costBasisUsd: number | null = null;
      let proceedsUsd: number | null = null;
      const warningsForTx: string[] = [];

      if (typeof tx?.costBasisUsd === "number") {
        costBasisUsd = tx.costBasisUsd;
      } else if (priceAtAcq !== null) {
        costBasisUsd = amount * priceAtAcq;
      } else if (acqSource === "out-of-window") {
        warningsForTx.push("acquisitionDate is more than 365 days ago; historical price not auto-resolved. Supply priceAtAcquisition or costBasisUsd.");
      } else {
        warningsForTx.push("cost basis unavailable: supply priceAtAcquisition, costBasisUsd, or a resolvable acquisitionDate within the last 365 days.");
      }

      if (typeof tx?.proceedsUsd === "number") {
        proceedsUsd = tx.proceedsUsd;
      } else if (priceAtDisp !== null) {
        proceedsUsd = amount * priceAtDisp;
      } else if (priceAtAcq !== null && type !== "sale") {
        // For non-sale events (e.g. transfers) with no disposal date, treat proceeds = cost basis (zero gain).
        proceedsUsd = amount * priceAtAcq;
        warningsForTx.push("no disposalDate; proceeds set to cost basis (zero gain assumed)");
      } else if (dispSource === "out-of-window") {
        warningsForTx.push("disposalDate is more than 365 days ago; historical price not auto-resolved. Supply priceAtDisposal or proceedsUsd.");
      } else {
        warningsForTx.push("proceeds unavailable: supply priceAtDisposal, proceedsUsd, or a resolvable disposalDate within the last 365 days.");
      }

      const gainLoss =
        costBasisUsd !== null && proceedsUsd !== null
          ? proceedsUsd - costBasisUsd
          : null;

      // ── Holding period ──────────────────────────────
      let holdingDays =
        typeof tx?.holdingDays === "number" && isFinite(tx.holdingDays) && tx.holdingDays >= 0
          ? Math.floor(tx.holdingDays)
          : null;
      if (holdingDays === null && tx?.acquisitionDate && tx?.disposalDate) {
        const acqT = new Date(tx.acquisitionDate).getTime();
        const dispT = new Date(tx.disposalDate).getTime();
        if (isFinite(acqT) && isFinite(dispT) && dispT >= acqT) {
          holdingDays = Math.floor((dispT - acqT) / (1000 * 60 * 60 * 24));
        }
      }
      const holdingPeriod =
        holdingDays === null ? "unknown" : holdingDays > 365 ? "long" : "short";

      if (warningsForTx.length > 0) {
        warnings.push(`transactions[${i}] (${symbol}): ${warningsForTx.join("; ")}`);
      }

      events.push({
        type,
        txHash: typeof tx?.txHash === "string" ? tx.txHash : null,
        timestamp: tx?.timestamp || tx?.disposalDate || tx?.acquisitionDate || new Date().toISOString(),
        asset: symbol,
        amount,
        costBasisUsd: costBasisUsd !== null ? Math.round(costBasisUsd * 100) / 100 : null,
        proceedsUsd: proceedsUsd !== null ? Math.round(proceedsUsd * 100) / 100 : null,
        gainLoss: gainLoss !== null ? Math.round(gainLoss * 100) / 100 : null,
        holdingDays,
        holdingPeriod,
        priceSources: { acquisition: acqSource, disposal: dispSource },
        warnings: warningsForTx.length > 0 ? warningsForTx : undefined,
      });
    }

    // ── Aggregate summary ──────────────────────────────
    const realized = events.filter((e) => typeof e.gainLoss === "number");
    const shortTerm = realized.filter((e) => e.holdingPeriod === "short");
    const longTerm = realized.filter((e) => e.holdingPeriod === "long");
    const unknownTerm = realized.filter((e) => e.holdingPeriod === "unknown");

    const sum = (arr: any[]) => Math.round(arr.reduce((s, e) => s + (e.gainLoss || 0), 0) * 100) / 100;

    const summary = {
      totalTransactions: events.length,
      transactionsWithFullData: realized.length,
      transactionsMissingData: events.length - realized.length,
      totalGainLossUsd: sum(realized),
      shortTermGainLoss: sum(shortTerm),
      longTermGainLoss: sum(longTerm),
      unknownTermGainLoss: sum(unknownTerm),
      shortTermCount: shortTerm.length,
      longTermCount: longTerm.length,
      unknownTermCount: unknownTerm.length,
      priceLookups: { cacheHits: priceCacheHits, coingeckoCalls: priceCacheMisses },
    };

    const reportId = genId();
    try {
      await taxDb.create(reportId, events, summary);
    } catch (dbErr: any) {
      console.error("[tax/calculate] db write failed:", dbErr?.message || dbErr);
      // Continue — caller still gets the computed answer.
    }

    return res.json({
      reportId,
      summary,
      events,
      method: "transaction-level realized P&L (per-tx cost basis vs proceeds in USD)",
      priceSource: "Historical USD prices auto-resolved for dates within the last 365 days; supply priceAtAcquisition / priceAtDisposal for older dates.",
      scope: {
        included: [
          "Per-transaction realized gain/loss in USD",
          "Short-term (≤365d) vs long-term (>365d) classification",
          "Auto-resolved historical USD prices for supported assets within the last 365 days",
          "Caller-supplied prices accepted for any date",
        ],
        excluded: [
          "Automatic price resolution beyond 365 days back",
          "FIFO/LIFO/HIFO tax lot tracking across multiple acquisitions",
          "Wash-sale rule application",
          "Form 8949 / Schedule D file generation",
          "Income event valuation (mining, staking, airdrops require separate flows)",
          "Non-USD reporting currencies",
        ],
        disclaimer: "Informational output only. Not tax or legal advice. Consult a qualified tax professional.",
      },
      warnings: warnings.length > 0 ? warnings : undefined,
      _gateway: { provider: "spraay-x402", version: "2.10.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[tax/calculate] unexpected error:", error?.message || error);
    return res.status(500).json({ error: "Failed to calculate tax", details: error?.message });
  }
}

// ── GET /api/v1/tax/report ─────────────────────────────────
//
// Query params:
//   reportId  - fetch a specific stored report (optional)
//
// Without reportId: returns the list of stored report IDs.

export async function taxReportHandler(req: Request, res: Response) {
  try {
    const { reportId } = req.query;

    if (reportId && typeof reportId === "string") {
      const report = await taxDb.get(reportId);
      if (!report) {
        return res.status(404).json({ error: "Report not found", reportId });
      }
      return res.json({
        reportId,
        summary: report.summary || null,
        events: report.events || [],
        totalEvents: Array.isArray(report.events) ? report.events.length : 0,
        createdAt: report.created_at,
        _gateway: { provider: "spraay-x402", version: "2.10.0" },
        timestamp: new Date().toISOString(),
      });
    }

    const reports = await taxDb.listIds();
    return res.json({
      reports,
      totalReports: reports.length,
      note: "Pass ?reportId=tax_xxx to retrieve a full report.",
      _gateway: { provider: "spraay-x402", version: "2.10.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[tax/report] error:", error?.message || error);
    return res.status(500).json({ error: "Failed to retrieve tax report", details: error?.message });
  }
}
