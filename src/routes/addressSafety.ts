/**
 * 💧 Spraay x402 Gateway — Address Safety Check (GoPlus)
 *
 * GET /api/v1/address/safety
 *
 * Pre-payment safety primitive. Screen recipient wallets before batch payments,
 * escrow funding, or any outbound transfer. Wraps GoPlus Malicious Address API
 * (free upstream, keyless, 30/min shared with token safety).
 *
 * FREE ENDPOINT — loss-leader alongside token safety. Same ToS rationale:
 * free distribution of free data, revenue comes from the 150+ paid endpoints
 * agents discover once gateway.spraay.app is in their config.
 *
 * Upstream: GET https://api.gopluslabs.io/api/v1/address_security/{address}?chain_id={chainId}
 */

import { Request, Response } from "express";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";

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
  solana: "solana",
  tron: "tron",
};

// Cache: address safety changes rarely — 15 min default.
const TTL_DEFAULT = 900_000;
const TTL_FLAGGED = 3600_000; // Flagged addresses stay flagged → cache longer.

interface CacheEntry { body: any; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

// ============================================
// FIELD PARSING (same pattern as tokenSafety)
// ============================================

function flag(v: any): boolean | null {
  if (v === undefined || v === null || v === "") return null;
  return String(v) === "1";
}

// ============================================
// SEVERITY MODEL
// ============================================

interface Assessment {
  verdict: "malicious" | "suspicious" | "clean" | "unknown";
  safe: boolean;
  riskFlags: string[];
  summary: string;
}

function assess(r: Record<string, any>): Assessment {
  // GoPlus returns all-string fields. If the result object is essentially
  // empty (no data_source, all fields absent), it's unknown.
  const hasData = Object.keys(r).length > 2; // code + message keys only → empty
  if (!hasData) {
    return {
      verdict: "unknown",
      safe: false,
      riskFlags: [],
      summary: "Address not found in GoPlus database. Treat as unverified.",
    };
  }

  const flags: string[] = [];

  // Hard malicious signals
  if (flag(r.stealing_attack) === true)         flags.push("Stealing/exploit attack");
  if (flag(r.phishing_activities) === true)      flags.push("Phishing activity");
  if (flag(r.cybercrime) === true)               flags.push("Cybercrime");
  if (flag(r.money_laundering) === true)         flags.push("Money laundering");
  if (flag(r.financial_crime) === true)          flags.push("Financial crime");
  if (flag(r.blackmail_activities) === true)     flags.push("Blackmail/extortion");
  if (flag(r.sanctioned) === true)               flags.push("Sanctioned address");
  if (flag(r.darkweb_transactions) === true)     flags.push("Darkweb transactions");
  if (flag(r.malicious_mining_activities) === true) flags.push("Malicious mining");

  // Suspicious signals (not definitive, but worth surfacing)
  if (flag(r.mixer) === true)                    flags.push("Mixer usage");
  if (flag(r.fake_kyc) === true)                 flags.push("Fake KYC");
  if (flag(r.fake_token) === true)               flags.push("Deployed fake tokens");
  if (flag(r.fake_standard_interface) === true)  flags.push("Fake standard interface");
  if (flag(r.honeypot_related_address) === true) flags.push("Honeypot-related");
  if (flag(r.blacklist_doubt) === true)          flags.push("Blacklist doubt");
  if (flag(r.gas_abuse) === true)                flags.push("Gas abuse");
  if (flag(r.reinit) === true)                   flags.push("Re-initialization risk");

  const maliciousCount = flags.filter(f =>
    !["Mixer usage", "Blacklist doubt", "Gas abuse"].includes(f)
  ).length;

  let verdict: Assessment["verdict"];
  let safe: boolean;

  if (maliciousCount > 0) {
    verdict = "malicious";
    safe = false;
  } else if (flags.length > 0) {
    verdict = "suspicious";
    safe = false;
  } else {
    verdict = "clean";
    safe = true;
  }

  const summary =
    verdict === "malicious"
      ? `DO NOT SEND. ${flags[0]}.`
      : verdict === "suspicious"
      ? `Suspicious: ${flags.join(", ")}. Proceed with caution.`
      : "No malicious signals detected.";

  return { verdict, safe, riskFlags: flags, summary };
}

// ============================================
// ROUTE HANDLER
// ============================================

/**
 * GET /api/v1/address/safety
 *
 * Query params:
 *   address (required) — wallet or contract address (0x…)
 *   chain   (optional) — base | ethereum | arbitrum | optimism | polygon | bsc | avalanche | solana | tron
 *                        (default: base)
 */
export async function addressSafetyHandler(req: Request, res: Response) {
  try {
    const address = String(req.query.address || "").trim();
    const chain = String(req.query.chain || "base").trim().toLowerCase();

    if (!/^0x[a-fA-F0-9]{40}$/.test(address) && chain !== "solana" && chain !== "tron") {
      return res.status(400).json({
        error: "Invalid or missing 'address' — expected a valid address.",
        example: "/api/v1/address/safety?address=0x...&chain=base",
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
    const cacheKey = `addr:${chainId}:${addrLower}`;

    // Cache hit
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      trackRequest("address_safety");
      return res.json({ ...hit.body, cached: true });
    }

    // Upstream
    const url = `${GOPLUS_BASE}/address_security/${addrLower}?chain_id=${chainId}`;
    const resp = await fetch(url);

    if (!resp.ok) {
      return res.status(502).json({
        error: "Upstream security provider error.",
        upstreamStatus: resp.status,
        hint: resp.status === 429 ? "GoPlus rate limit hit (30/min keyless)." : undefined,
      });
    }

    const json: any = await resp.json();
    const r: Record<string, any> = json?.result ?? {};
    const a = assess(r);

    const body = {
      chain,
      chainId: isNaN(Number(chainId)) ? chainId : Number(chainId),
      address,
      verdict: a.verdict,
      safe: a.safe,
      riskFlags: a.riskFlags,
      summary: a.summary,
      raw: {
        stealingAttack: flag(r.stealing_attack),
        phishing: flag(r.phishing_activities),
        cybercrime: flag(r.cybercrime),
        moneyLaundering: flag(r.money_laundering),
        financialCrime: flag(r.financial_crime),
        blackmail: flag(r.blackmail_activities),
        sanctioned: flag(r.sanctioned),
        darkweb: flag(r.darkweb_transactions),
        mixer: flag(r.mixer),
        fakeKyc: flag(r.fake_kyc),
        fakeToken: flag(r.fake_token),
        honeypotRelated: flag(r.honeypot_related_address),
        gasAbuse: flag(r.gas_abuse),
        maliciousMining: flag(r.malicious_mining_activities),
        isContract: flag(r.contract_address),
        maliciousContractsCreated: r.number_of_malicious_contracts_created ?? null,
        dataSource: r.data_source || null,
      },
      meta: {
        source: "goplus-address-security",
        scoreModel: "spraay-address-v1",
      },
      cached: false,
      checkedAt: new Date().toISOString(),
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/address/safety",
      },
      timestamp: new Date().toISOString(),
    };

    const ttl = a.verdict === "malicious" || a.verdict === "suspicious" ? TTL_FLAGGED : TTL_DEFAULT;
    cache.set(cacheKey, { body, expiresAt: Date.now() + ttl });

    trackRequest("address_safety");
    return res.json(body);
  } catch (error: any) {
    console.error("Address safety error:", error?.message);
    return res.status(500).json({
      error: "Failed to run address safety check",
      details: error?.message,
    });
  }
}
