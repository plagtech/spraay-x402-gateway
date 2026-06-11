/**
 * 💧 Spraay x402 Gateway — Token Safety Check (GoPlus)
 *
 * GET /api/v1/token/safety
 *
 * Pre-trade safety primitive for trading agents. Wraps the GoPlus Token
 * Security API (free upstream) and normalizes its boolean-soup output into a
 * single rolled-up verdict + 0–100 score + plain-English summary — the thing
 * agents actually want to branch on.
 *
 * Upstream: https://api.gopluslabs.io/api/v1/token_security/{chainId}
 *   - Free tier: 30 calls/min, keyless. Single token per call (batch is paid).
 *   - Optional: set GOPLUS_APP_KEY + GOPLUS_APP_SECRET to use the signed
 *     access-token flow for a higher limit (apply via GoPlus).
 *
 * The cache is the economic engine: token security barely changes between
 * blocks, so repeat lookups serve from an in-memory TTL cache and upstream
 * calls stay near zero per unique token. TTL is tiered by token *behavior*
 * (mutable tokens cached briefly, renounced/verified/live ones cached longer)
 * — the tiering is doing safety work, not just cost work: a stale "ok" on a
 * token that just armed its honeypot is a lie we refuse to tell.
 */

import { Request, Response } from "express";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";

// EVM chains → GoPlus chain_id. Solana uses a SEPARATE GoPlus endpoint
// (different response shape) — explicitly rejected below, fast-follow.
const CHAIN_IDS: Record<string, string> = {
  base: "8453",
  ethereum: "1",
  eth: "1",
  arbitrum: "42161",
  optimism: "10",
  polygon: "137",
  bsc: "56",
  bnb: "56",
  avalanche: "43114",
  avax: "43114",
};

// TTL tiers (ms) — keyed off token behavior, not age (which GoPlus doesn't give us cleanly).
const TTL_MUTABLE = 60_000; // tax/owner mutable → trust briefly
const TTL_DEFAULT = 300_000; // 5 min baseline
const TTL_STABLE = 900_000; // renounced + verified + in DEX → 15 min

// ============================================
// IN-MEMORY CACHE
// Single-instance only. For horizontal scale on Railway, swap this Map for a
// Supabase table or Redis (key = `${chainId}:${address}`, value = body+expiry).
// ============================================

interface CacheEntry {
  body: any;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

// ============================================
// OPTIONAL: GoPlus signed access token (higher rate limit)
// Only activates if GOPLUS_APP_KEY + GOPLUS_APP_SECRET are set. Otherwise the
// endpoint runs keyless at the 30/min free tier (cache covers the gap).
// ============================================

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string | null> {
  const appKey = process.env.GOPLUS_APP_KEY;
  const appSecret = process.env.GOPLUS_APP_SECRET;
  if (!appKey || !appSecret) return null; // keyless mode

  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const time = Math.floor(Date.now() / 1000);
  // sign = sha1(app_key + time + app_secret)
  const { createHash } = await import("crypto");
  const sign = createHash("sha1").update(`${appKey}${time}${appSecret}`).digest("hex");

  try {
    const resp = await fetch(`${GOPLUS_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_key: appKey, time, sign }),
    });
    const json: any = await resp.json();
    // VERIFY field names against a live GoPlus /token response — expires_in
    // and access_token are the documented keys but confirm before trusting.
    if (json?.code === 1 && json?.result?.access_token) {
      const ttlSec = Number(json.result.expires_in) || 3600;
      cachedToken = {
        token: json.result.access_token,
        expiresAt: Date.now() + ttlSec * 1000,
      };
      return cachedToken.token;
    }
  } catch {
    /* fall through to keyless */
  }
  return null;
}

// ============================================
// FIELD PARSING
// GoPlus returns "1" | "0" | "" strings. CRITICAL: "" / missing → unknown
// (null), NEVER coerce to false, or you stamp un-indexed scams as safe.
// ============================================

function flag(v: any): boolean | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v) === "1";
}

function num(v: any): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = parseFloat(String(v));
  return Number.isNaN(n) ? null : n;
}

// true if ANY value is "1"; null only if ALL are unknown; otherwise false.
function anyFlag(...vals: any[]): boolean | null {
  let sawKnown = false;
  for (const v of vals) {
    const f = flag(v);
    if (f === true) return true;
    if (f !== null) sawKnown = true;
  }
  return sawKnown ? false : null;
}

// ============================================
// SEVERITY MODEL (spraay-severity-v1)
// Deterministic, documented. Hard-danger flags force tradeable=false
// regardless of score. Unknown critical fields → insufficient_data.
// ============================================

interface Assessment {
  verdict: "danger" | "caution" | "ok" | "insufficient_data";
  tradeable: boolean;
  score: number | null;
  reasons: string[];
  summary: string;
}

function assess(r: Record<string, any>): Assessment {
  const honeypot = flag(r.is_honeypot);
  const cannotSellAll = flag(r.cannot_sell_all);
  const cannotBuy = flag(r.cannot_buy);
  const buyTax = num(r.buy_tax);
  const sellTax = num(r.sell_tax);
  const taxModifiable = anyFlag(r.slippage_modifiable, r.personal_slippage_modifiable);
  const transferPausable = flag(r.transfer_pausable);
  const tradingCooldown = flag(r.trading_cooldown);
  const blacklisted = flag(r.is_blacklisted);
  const selfdestruct = flag(r.selfdestruct);
  const hiddenOwner = flag(r.hidden_owner);
  const reclaimOwnership = flag(r.can_take_back_ownership);
  const ownerChangeBalance = flag(r.owner_change_balance);
  const isProxy = flag(r.is_proxy);
  const mintable = flag(r.is_mintable);
  const openSource = flag(r.is_open_source);
  const antiWhaleModifiable = flag(r.anti_whale_modifiable);
  const honeypotSameCreator = flag(r.honeypot_with_same_creator);
  const trustListed = flag(r.trust_list);

  // Critical fields all unknown → don't pretend it's safe.
  if (honeypot === null && sellTax === null && openSource === null) {
    return {
      verdict: "insufficient_data",
      tradeable: false,
      score: null,
      reasons: ["GoPlus has not indexed this token yet (likely a fresh deploy)."],
      summary:
        "Insufficient data — GoPlus returned no security signals. Common for tokens deployed in the last few minutes. Treat as unknown, NOT safe.",
    };
  }

  const reasons: string[] = [];
  let score = 100;
  let danger = false;

  // ---- HARD DANGER (forces tradeable = false) ----
  if (honeypot === true) { reasons.push("Honeypot: buys succeed but sells fail."); danger = true; score -= 100; }
  if (cannotSellAll === true) { reasons.push("Cannot sell entire balance (partial-sell trap)."); danger = true; score -= 80; }
  if (cannotBuy === true) { reasons.push("Buying is disabled."); danger = true; score -= 60; }
  if (sellTax !== null && sellTax >= 0.5) { reasons.push(`Sell tax ${(sellTax * 100).toFixed(0)}% — confiscatory.`); danger = true; score -= 80; }
  if (transferPausable === true) { reasons.push("Transfers can be paused by owner."); danger = true; score -= 50; }
  if (tradingCooldown === true) { reasons.push("Trading cooldown can block sells."); danger = true; score -= 40; }
  if (blacklisted === true) { reasons.push("Address blacklisting is active."); danger = true; score -= 50; }
  if (selfdestruct === true) { reasons.push("Contract can self-destruct."); danger = true; score -= 60; }
  if (honeypotSameCreator === true) { reasons.push("Deployer has previously launched honeypot tokens."); danger = true; score -= 70; }

  // ---- CAUTION (risky, not certain loss) ----
  if (!danger) {
    if (sellTax !== null && sellTax >= 0.1) { reasons.push(`Sell tax ${(sellTax * 100).toFixed(0)}%.`); score -= 25; }
    if (buyTax !== null && buyTax >= 0.1) { reasons.push(`Buy tax ${(buyTax * 100).toFixed(0)}%.`); score -= 15; }
    if (taxModifiable === true) { reasons.push("Owner can modify tax/slippage."); score -= 20; }
    if (mintable === true) { reasons.push("Supply is mintable."); score -= 15; }
    if (hiddenOwner === true) { reasons.push("Hidden owner detected."); score -= 20; }
    if (reclaimOwnership === true) { reasons.push("Ownership can be reclaimed after renounce."); score -= 20; }
    if (ownerChangeBalance === true) { reasons.push("Owner can change balances."); score -= 25; }
    if (isProxy === true) { reasons.push("Upgradeable proxy — logic can change."); score -= 10; }
    if (openSource === false) { reasons.push("Source not verified."); score -= 15; }
    if (antiWhaleModifiable === true) { reasons.push("Anti-whale limit is modifiable."); score -= 10; }
  }

  score = Math.max(0, Math.min(100, score));

  // Positive override: GoPlus-trust-listed tokens (verified majors) shouldn't read
  // "caution" for benign structural traits — e.g. USDC is a legitimate upgradeable
  // proxy and on the trust list. Verified live: USDC returns trust_list "1".
  if (!danger && trustListed === true) {
    return {
      verdict: "ok",
      tradeable: true,
      score: Math.max(score, 90),
      reasons,
      summary: reasons.length
        ? `On GoPlus trust list (verified token). Noted: ${reasons[0]}`
        : "On GoPlus trust list (verified token). No disqualifying risk flags.",
    };
  }

  let verdict: Assessment["verdict"];
  let tradeable: boolean;
  if (danger) {
    verdict = "danger";
    tradeable = false;
  } else if (reasons.length > 0 || score < 90) {
    verdict = "caution";
    tradeable = true;
  } else {
    verdict = "ok";
    tradeable = true;
  }

  const summary =
    verdict === "danger"
      ? `DO NOT TRADE. ${reasons[0]}`
      : verdict === "ok"
      ? "No major risk flags. Standard caution still applies."
      : `Tradeable with caution: ${reasons.slice(0, 2).join(" ")}`;

  return { verdict, tradeable, score, reasons, summary };
}

function ttlFor(r: Record<string, any>, a: Assessment): number {
  if (
    a.verdict === "insufficient_data" ||
    flag(r.slippage_modifiable) === true ||
    flag(r.anti_whale_modifiable) === true ||
    flag(r.owner_change_balance) === true
  ) {
    return TTL_MUTABLE; // can turn malicious → re-check soon
  }
  if (
    flag(r.is_open_source) === true &&
    flag(r.is_in_dex) === true &&
    flag(r.can_take_back_ownership) !== true &&
    flag(r.hidden_owner) !== true
  ) {
    return TTL_STABLE; // renounced + verified + live → safe to hold longer
  }
  return TTL_DEFAULT;
}

// ============================================
// ROUTE HANDLER
// ============================================

/**
 * GET /api/v1/token/safety
 *
 * Query params:
 *   address (required) — token contract address (0x…)
 *   chain   (optional) — base | ethereum | arbitrum | optimism | polygon | bsc | avalanche
 *                        (default: base)
 */
export async function tokenSafetyHandler(req: Request, res: Response) {
  try {
    const address = String(req.query.address || "").trim();
    const chain = String(req.query.chain || "base").trim().toLowerCase();

    // ---- validation ----
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({
        error: "Invalid or missing 'address' — expected an EVM token contract (0x…).",
        example: "/api/v1/token/safety?address=0x...&chain=base",
      });
    }
    if (chain === "solana" || chain === "sol") {
      return res.status(400).json({
        error: "Solana is not supported on this endpoint yet (different upstream). EVM only for now.",
        supportedChains: Object.keys(CHAIN_IDS),
      });
    }
    const chainId = CHAIN_IDS[chain];
    if (!chainId) {
      return res.status(400).json({
        error: `Unsupported chain: ${chain}`,
        supportedChains: Object.keys(CHAIN_IDS),
      });
    }

    const addrLower = address.toLowerCase();
    const cacheKey = `${chainId}:${addrLower}`;

    // ---- cache hit ----
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      trackRequest("token_safety");
      return res.json({ ...hit.body, cached: true });
    }

    // ---- upstream ----
    const token = await getAccessToken();
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = token;

    const url = `${GOPLUS_BASE}/token_security/${chainId}?contract_addresses=${addrLower}`;
    const resp = await fetch(url, { headers });

    if (!resp.ok) {
      return res.status(502).json({
        error: "Upstream security provider error.",
        upstreamStatus: resp.status,
        hint:
          resp.status === 429
            ? "GoPlus rate limit hit (30/min keyless). Set GOPLUS_APP_KEY/SECRET, or rely on cache."
            : undefined,
      });
    }

    const json: any = await resp.json();
    // GoPlus result is keyed by the LOWERCASED contract address.
    const r: Record<string, any> = json?.result?.[addrLower] ?? {};

    const a = assess(r);

    const body = {
      chain,
      chainId: Number(chainId),
      address,
      tokenName: r.token_name ?? null,
      tokenSymbol: r.token_symbol ?? null,
      verdict: a.verdict,
      tradeable: a.tradeable,
      score: a.score,
      summary: a.summary,
      reasons: a.reasons,
      flags: {
        honeypot: flag(r.is_honeypot),
        buyTax: num(r.buy_tax),
        sellTax: num(r.sell_tax),
        cannotSellAll: flag(r.cannot_sell_all),
        cannotBuy: flag(r.cannot_buy),
        taxModifiable: flag(r.slippage_modifiable),
        transferPausable: flag(r.transfer_pausable),
        tradingCooldown: flag(r.trading_cooldown),
        blacklisted: flag(r.is_blacklisted),
        hiddenOwner: flag(r.hidden_owner),
        canReclaimOwnership: flag(r.can_take_back_ownership),
        ownerChangeBalance: flag(r.owner_change_balance),
        isProxy: flag(r.is_proxy),
        mintable: flag(r.is_mintable),
        selfdestruct: flag(r.selfdestruct),
        openSource: flag(r.is_open_source),
        inDex: flag(r.is_in_dex),
        honeypotSameCreator: flag(r.honeypot_with_same_creator),
        trustListed: flag(r.trust_list),
      },
      meta: {
        source: "goplus-token-security",
        authMode: token ? "access-token" : "keyless",
        scoreModel: "spraay-severity-v1.1",
      },
      cached: false,
      checkedAt: new Date().toISOString(),
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/token/safety",
      },
      timestamp: new Date().toISOString(),
    };

    // ---- store (tiered TTL) ----
    cache.set(cacheKey, { body, expiresAt: Date.now() + ttlFor(r, a) });

    trackRequest("token_safety");
    return res.json(body);
  } catch (error: any) {
    console.error("Token safety error:", error?.message);
    return res.status(500).json({
      error: "Failed to run token safety check",
      details: error?.message,
    });
  }
}
