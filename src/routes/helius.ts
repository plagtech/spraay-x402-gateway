/**
 * 💧 Spraay Gateway — Solana Helius DAS endpoints
 *
 * Upstream: Helius DAS (Digital Asset Standard) API
 * Docs: https://docs.helius.dev/compression-and-das-api/digital-asset-standard-das-api
 *
 * Requires HELIUS_API_KEY env var. Free tier covers ~100k requests/month.
 *
 * Routes (wired in index.ts):
 *   GET /api/v1/solana/helius/assets-by-owner  — $0.003 — list all assets for a wallet
 *   GET /api/v1/solana/helius/asset            — $0.002 — full metadata for one asset
 */

import type { Request, Response } from "express";

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

function isValidSolanaAddress(s: string): boolean {
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

async function heliusRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(HELIUS_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "spraay-" + Date.now(),
      method,
      params,
    }),
  });

  if (res.status === 429) {
    throw new Error("helius_rate_limit: Helius rate limit or monthly credit cap reached. Retry shortly.");
  }
  if (!res.ok) {
    throw new Error(`helius_http_${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const body = await res.json() as { result?: unknown; error?: { code: number; message: string } };
  if (body.error) {
    // -32005 is Helius's standard rate-limit error code over JSON-RPC
    if (body.error.code === -32005) {
      throw new Error("helius_rate_limit: " + body.error.message);
    }
    throw new Error(`helius_rpc_${body.error.code}: ${body.error.message}`);
  }
  return body.result;
}

/**
 * GET /api/v1/solana/helius/assets-by-owner
 * Query params:
 *   owner          (required) — base58 Solana address
 *   page           (optional, default 1)
 *   limit          (optional, default 100, max 1000)
 *   showFungible   (optional, default true) — include SPL tokens, not just NFTs
 *   showNativeBalance (optional, default true)
 */
export async function heliusAssetsByOwnerHandler(req: Request, res: Response) {
  try {
    if (!HELIUS_API_KEY) {
      return res.status(503).json({ error: "helius_not_configured", message: "HELIUS_API_KEY not set on gateway" });
    }

    const { owner, page, limit, showFungible, showNativeBalance } = req.query;

    if (!owner || !isValidSolanaAddress(String(owner))) {
      return res.status(400).json({ error: "invalid_owner", message: "owner must be a base58 Solana address" });
    }

    const pageNum = page ? Math.max(1, Number(page)) : 1;
    const limitNum = limit ? Math.min(1000, Math.max(1, Number(limit))) : 100;

    if (Number.isNaN(pageNum) || Number.isNaN(limitNum)) {
      return res.status(400).json({ error: "invalid_pagination" });
    }

    const result = await heliusRpc("getAssetsByOwner", {
      ownerAddress: String(owner),
      page: pageNum,
      limit: limitNum,
      displayOptions: {
        showFungible: showFungible !== "false",
        showNativeBalance: showNativeBalance !== "false",
      },
    }) as {
      total: number;
      limit: number;
      page: number;
      items: Array<unknown>;
      nativeBalance?: { lamports: number; price_per_sol?: number; total_price?: number };
    };

    return res.json({
      owner: String(owner),
      total: result.total,
      page: result.page,
      limit: result.limit,
      itemCount: Array.isArray(result.items) ? result.items.length : 0,
      nativeBalance: result.nativeBalance,
      items: result.items,
      source: "helius-das",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    if (msg.startsWith("helius_rate_limit")) {
      return res.status(429).json({
        error: "rate_limit",
        message: "Upstream rate limit reached. Retry in a few seconds.",
        retryAfter: 5,
      });
    }
    const status = msg.startsWith("helius_") ? 502 : 500;
    return res.status(status).json({ error: status === 502 ? "upstream_error" : "internal_error", message: msg });
  }
}

/**
 * GET /api/v1/solana/helius/asset
 * Query params:
 *   id  (required) — asset mint address (SPL or compressed NFT id)
 */
export async function heliusAssetHandler(req: Request, res: Response) {
  try {
    if (!HELIUS_API_KEY) {
      return res.status(503).json({ error: "helius_not_configured", message: "HELIUS_API_KEY not set on gateway" });
    }

    const { id } = req.query;

    if (!id || !isValidSolanaAddress(String(id))) {
      return res.status(400).json({ error: "invalid_id", message: "id must be a base58 asset address" });
    }

    const result = await heliusRpc("getAsset", { id: String(id) });

    return res.json({
      id: String(id),
      asset: result,
      source: "helius-das",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    if (msg.startsWith("helius_rate_limit")) {
      return res.status(429).json({
        error: "rate_limit",
        message: "Upstream rate limit reached. Retry in a few seconds.",
        retryAfter: 5,
      });
    }
    const status = msg.startsWith("helius_") ? 502 : 500;
    return res.status(status).json({ error: status === 502 ? "upstream_error" : "internal_error", message: msg });
  }
}
