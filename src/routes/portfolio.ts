/**
 * Portfolio API handlers — real Alchemy Portfolio API integration
 *
 * Endpoints:
 *   GET /api/v1/portfolio/tokens   — native + ERC-20 balances w/ USD values ($0.008)
 *   GET /api/v1/portfolio/nfts     — NFT holdings across chains ($0.01)
 *
 * Data source: Alchemy Portfolio API (api.g.alchemy.com/data/v1/{apiKey}/...)
 *   - Single multi-chain call instead of N per-chain RPC calls
 *   - Returns native, ERC-20, and NFTs with metadata and USD prices
 *
 * Supported networks (subset of the 30+ Alchemy supports):
 *   eth-mainnet, base-mainnet, arb-mainnet, opt-mainnet, matic-mainnet,
 *   bnb-mainnet, avax-mainnet, unichain-mainnet, solana-mainnet
 */

import type { Request, Response } from "express";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;
const ALCHEMY_BASE = "https://api.g.alchemy.com/data/v1";

// Networks we expose on the Portfolio endpoints — aligns with the chains
// Spraay already supports via RPC (Base, Ethereum, Arbitrum, Polygon, BNB,
// Avalanche, Unichain, Solana).
const DEFAULT_NETWORKS = [
  "eth-mainnet",
  "base-mainnet",
  "arb-mainnet",
  "opt-mainnet",
  "matic-mainnet",
  "bnb-mainnet",
  "avax-mainnet",
  "unichain-mainnet",
];

const ALL_NETWORKS = [...DEFAULT_NETWORKS, "solana-mainnet"];

// Simple address validation — full EVM hex or Solana base58-ish length.
// Alchemy will reject malformed addresses with a structured error anyway.
function looksLikeEvmAddress(a: string): boolean {
  return typeof a === "string" && /^0x[a-fA-F0-9]{40}$/.test(a);
}

function looksLikeSolanaAddress(a: string): boolean {
  return (
    typeof a === "string" &&
    a.length >= 32 &&
    a.length <= 44 &&
    /^[1-9A-HJ-NP-Za-km-z]+$/.test(a)
  );
}

function parseNetworksParam(raw: unknown): string[] {
  if (!raw || typeof raw !== "string") return DEFAULT_NETWORKS;
  if (raw === "all") return ALL_NETWORKS;
  const requested = raw
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  // Guard against arbitrary injection — only allow networks we whitelisted.
  const allowed = new Set(ALL_NETWORKS);
  const valid = requested.filter((n) => allowed.has(n));
  return valid.length > 0 ? valid : DEFAULT_NETWORKS;
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/portfolio/tokens
// ────────────────────────────────────────────────────────────────────────────

export async function portfolioTokensHandler(
  req: Request,
  res: Response
): Promise<void> {
  const address = String(req.query.address || "").trim();
  const networks = parseNetworksParam(req.query.networks);
  const includeNative = req.query.includeNative !== "false";
  const includeErc20 = req.query.includeErc20 !== "false";
  const includePrices = req.query.includePrices !== "false";

  if (!address) {
    res.status(400).json({
      error: "missing_address",
      message: "Query parameter 'address' is required.",
      example: "/api/v1/portfolio/tokens?address=0xabc...&networks=base-mainnet,eth-mainnet",
    });
    return;
  }

  const isEvm = looksLikeEvmAddress(address);
  const isSolana = looksLikeSolanaAddress(address);
  if (!isEvm && !isSolana) {
    res.status(400).json({
      error: "invalid_address",
      message: "Address must be a valid EVM (0x...) or Solana address.",
    });
    return;
  }

  if (!ALCHEMY_API_KEY) {
    res.status(503).json({
      error: "provider_not_configured",
      message: "Alchemy API key is not configured on this gateway.",
    });
    return;
  }

  // If the caller passed an EVM address, drop Solana networks and vice versa.
  const filteredNetworks = isSolana
    ? networks.filter((n) => n === "solana-mainnet")
    : networks.filter((n) => n !== "solana-mainnet");

  if (filteredNetworks.length === 0) {
    res.status(400).json({
      error: "no_matching_networks",
      message: isSolana
        ? "Solana addresses only support the solana-mainnet network."
        : "EVM addresses do not support solana-mainnet.",
    });
    return;
  }

  try {
    const body = {
      addresses: [{ address, networks: filteredNetworks }],
      includeNativeTokens: includeNative,
      includeErc20Tokens: includeErc20,
      withMetadata: true,
      withPrices: includePrices,
    };

    const url = `${ALCHEMY_BASE}/${ALCHEMY_API_KEY}/assets/tokens/balances/by-address`;
    const started = Date.now();

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - started;

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(502).json({
        error: "upstream_error",
        message: `Alchemy returned ${upstream.status}`,
        upstream_status: upstream.status,
        upstream_body: text.slice(0, 500),
      });
      return;
    }

    const data: any = await upstream.json();
    const tokens: any[] = data?.data?.tokens || [];

    // Compute a total USD value (skip tokens without prices).
    let totalUsd = 0;
    for (const t of tokens) {
      const price = Number(t?.tokenPrices?.[0]?.value);
      const balanceRaw = t?.tokenBalance;
      const decimals = Number(t?.tokenMetadata?.decimals ?? 18);
      if (Number.isFinite(price) && typeof balanceRaw === "string") {
        const human = Number(BigInt(balanceRaw)) / 10 ** decimals;
        if (Number.isFinite(human)) totalUsd += human * price;
      }
    }

    res.json({
      address,
      networks: filteredNetworks,
      token_count: tokens.length,
      total_usd_value: Number(totalUsd.toFixed(2)),
      tokens,
      _gateway: {
        provider: "alchemy",
        endpoint: "portfolio/tokens",
        price_usdc: "0.008",
        upstream_latency_ms: latencyMs,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      error: "portfolio_tokens_failed",
      message: err?.message || "Unknown error fetching portfolio tokens.",
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/portfolio/nfts
// ────────────────────────────────────────────────────────────────────────────

export async function portfolioNftsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const address = String(req.query.address || "").trim();
  const networks = parseNetworksParam(req.query.networks);
  const withMetadata = req.query.withMetadata !== "false";
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || 50, 1), 100);
  const pageKey = req.query.pageKey ? String(req.query.pageKey) : undefined;

  if (!address) {
    res.status(400).json({
      error: "missing_address",
      message: "Query parameter 'address' is required.",
      example: "/api/v1/portfolio/nfts?address=0xabc...&networks=base-mainnet",
    });
    return;
  }

  if (!looksLikeEvmAddress(address)) {
    res.status(400).json({
      error: "invalid_address",
      message: "NFT portfolio currently supports EVM addresses only.",
    });
    return;
  }

  if (!ALCHEMY_API_KEY) {
    res.status(503).json({
      error: "provider_not_configured",
      message: "Alchemy API key is not configured on this gateway.",
    });
    return;
  }

  // Solana NFTs go through a different Alchemy surface — exclude for now.
  const evmNetworks = networks.filter((n) => n !== "solana-mainnet");

  try {
    const body: Record<string, unknown> = {
      addresses: [{ address, networks: evmNetworks }],
      withMetadata,
      pageSize,
    };
    if (pageKey) body.pageKey = pageKey;

    const url = `${ALCHEMY_BASE}/${ALCHEMY_API_KEY}/assets/nfts/by-address`;
    const started = Date.now();

    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const latencyMs = Date.now() - started;

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      res.status(502).json({
        error: "upstream_error",
        message: `Alchemy returned ${upstream.status}`,
        upstream_status: upstream.status,
        upstream_body: text.slice(0, 500),
      });
      return;
    }

    const data: any = await upstream.json();
    const ownedNfts: any[] = data?.data?.ownedNfts || [];
    const totalCount =
      data?.data?.totalCount ?? data?.totalCount ?? ownedNfts.length;
    const nextPageKey = data?.data?.pageKey || data?.pageKey || null;

    res.json({
      address,
      networks: evmNetworks,
      total_count: totalCount,
      returned_count: ownedNfts.length,
      page_key: nextPageKey,
      nfts: ownedNfts,
      _gateway: {
        provider: "alchemy",
        endpoint: "portfolio/nfts",
        price_usdc: "0.01",
        upstream_latency_ms: latencyMs,
      },
    });
  } catch (err: any) {
    res.status(500).json({
      error: "portfolio_nfts_failed",
      message: err?.message || "Unknown error fetching NFTs.",
    });
  }
}
