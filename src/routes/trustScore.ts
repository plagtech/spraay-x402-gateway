/**
 * 💧 Spraay x402 Gateway — Trust Score (ProofLayer)
 *
 * GET /api/v1/trust/score
 *
 * Multi-dimensional wallet/agent trust scoring powered by ProofLayer
 * (api.prooflayer.net — Spraay's own infrastructure). Returns overall score,
 * 4-axis breakdown (financial, reliability, trust, social), on-chain signals,
 * XMTP reputation data, and a verdict/tier.
 *
 * PAID ENDPOINT — $0.03. This is Spraay's proprietary data; no upstream ToS
 * restrictions. The moat: nobody else has this scoring + XMTP reputation
 * combination, and it's natively aimed at agents doing x402 payments.
 *
 * Upstream: GET https://api.prooflayer.net/v1/scan/:address
 */

import { Request, Response } from "express";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const PROOFLAYER_BASE = process.env.PROOFLAYER_API_URL || "https://api.prooflayer.net";

// Cache: trust scores change slowly — 10 min default.
const TTL_DEFAULT = 600_000;

interface CacheEntry { body: any; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

// ============================================
// ROUTE HANDLER
// ============================================

/**
 * GET /api/v1/trust/score
 *
 * Query params:
 *   address (required) — wallet or agent address (0x…)
 */
export async function trustScoreHandler(req: Request, res: Response) {
  try {
    const address = String(req.query.address || "").trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({
        error: "Invalid or missing 'address' — expected an EVM address (0x…).",
        example: "/api/v1/trust/score?address=0x...",
      });
    }

    const addrLower = address.toLowerCase();
    const cacheKey = `trust:${addrLower}`;

    // Cache hit
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      trackRequest("trust_score");
      return res.json({ ...hit.body, cached: true });
    }

    // Upstream — ProofLayer /v1/scan/:address
    const url = `${PROOFLAYER_BASE}/v1/scan/${addrLower}`;
    const resp = await fetch(url, {
      headers: { "Accept": "application/json" },
    });

    if (!resp.ok) {
      return res.status(502).json({
        error: "ProofLayer upstream error.",
        upstreamStatus: resp.status,
      });
    }

    const json: any = await resp.json();

    if (!json?.success || !json?.data) {
      return res.status(502).json({
        error: "ProofLayer returned an unexpected response shape.",
        raw: json,
      });
    }

    const d = json.data;

    const body = {
      address,
      overall: d.overall ?? null,
      verdict: d.verdict ?? null,
      tier: d.tier ?? null,
      breakdown: {
        financial: d.breakdown?.financial ?? null,
        reliability: d.breakdown?.reliability ?? null,
        trust: d.breakdown?.trust ?? null,
        social: d.breakdown?.social ?? null,
      },
      signals: {
        walletAgeDays: d.signals?.walletAgeDays ?? null,
        txCount: d.signals?.txCount ?? null,
        uniqueContracts: d.signals?.uniqueContracts ?? null,
        chainsActive: d.signals?.chainsActive ?? null,
        totalValueUsd: d.signals?.totalValueUsd ?? null,
        fundingSource: d.signals?.fundingSource ?? null,
      },
      xmtp: {
        active: d.xmtp?.active ?? false,
        messagesSent: d.xmtp?.messagesSent ?? 0,
        conversations: d.xmtp?.conversations ?? 0,
        spamFlagged: d.xmtp?.spamFlagged ?? false,
        consentRate: d.xmtp?.consentRate ?? null,
        lastActive: d.xmtp?.lastActive ?? null,
      },
      meta: {
        source: "prooflayer",
        apiVersion: "0.2.0",
        scoreModel: "prooflayer-v1",
      },
      cached: false,
      scannedAt: d.scannedAt ?? new Date().toISOString(),
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/trust/score",
      },
      timestamp: new Date().toISOString(),
    };

    cache.set(cacheKey, { body, expiresAt: Date.now() + TTL_DEFAULT });

    trackRequest("trust_score");
    return res.json(body);
  } catch (error: any) {
    console.error("Trust score error:", error?.message);
    return res.status(500).json({
      error: "Failed to fetch trust score",
      details: error?.message,
    });
  }
}
