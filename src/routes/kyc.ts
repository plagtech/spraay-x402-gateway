// ═══════════════════════════════════════════════════════════════
// kyc.ts — OFAC sanctions screening via the Chainalysis Oracle
//
// On-chain `isSanctioned(address) → bool` call against the free,
// Chainalysis-maintained sanctions oracle deployed on every major
// EVM chain. Reads only — no API key, no rate limit, no monthly fee.
//
// Source: https://go.chainalysis.com/chainalysis-oracle-docs.html
// Scope:  OFAC SDN list only. NOT a full KYC suite — no PEP,
//         adverse media, identity, or document checks. Persona /
//         Sumsub / Chainalysis Address Screening cover those, and
//         can be layered in later behind a higher-priced endpoint.
//
// Exports:
//   kycVerifyHandler  POST /api/v1/kyc/verify   — screen one address
//   kycStatusHandler  GET  /api/v1/kyc/status   — look up a prior record
// ═══════════════════════════════════════════════════════════════

import { Request, Response } from "express";
import { JsonRpcProvider, Contract, isAddress } from "ethers";
import { kycDb } from "../db.js";

// ── Chainalysis Sanctions Oracle deployments ─────────────────
// Same contract address on every chain EXCEPT Base, which has its
// own deployment. Source verified at go.chainalysis.com/chainalysis-oracle-docs.html

const CHAINALYSIS_ORACLE: Record<string, string> = {
  base:      "0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B",
  ethereum:  "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  arbitrum:  "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  optimism:  "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  polygon:   "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  bnb:       "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  avalanche: "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  fantom:    "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  celo:      "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
  blast:     "0x40C57923924B5c5c5455c48D93317139ADDaC8fb",
};

// Default RPC endpoints used when no Alchemy key is configured.
// Public endpoints are fine here — we only do read-only static calls.
const PUBLIC_RPC: Record<string, string> = {
  base:      "https://mainnet.base.org",
  ethereum:  "https://eth.llamarpc.com",
  arbitrum:  "https://arb1.arbitrum.io/rpc",
  optimism:  "https://mainnet.optimism.io",
  polygon:   "https://polygon-rpc.com",
  bnb:       "https://bsc-dataseed.binance.org",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  fantom:    "https://rpc.ftm.tools",
  celo:      "https://forno.celo.org",
  blast:     "https://rpc.blast.io",
};

// Optional: prefer Alchemy when available (faster + higher quality).
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "";
const ALCHEMY_RPC: Record<string, string> = ALCHEMY_KEY
  ? {
      base:      `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      ethereum:  `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      arbitrum:  `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      optimism:  `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      polygon:   `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      bnb:       `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      avalanche: `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    }
  : {};

// Chain aliases — match the conventions used elsewhere in the gateway.
const CHAIN_ALIASES: Record<string, string> = {
  base: "base",
  eth: "ethereum",
  ethereum: "ethereum",
  mainnet: "ethereum",
  arb: "arbitrum",
  arbitrum: "arbitrum",
  op: "optimism",
  opt: "optimism",
  optimism: "optimism",
  matic: "polygon",
  poly: "polygon",
  polygon: "polygon",
  bsc: "bnb",
  binance: "bnb",
  bnb: "bnb",
  avax: "avalanche",
  avalanche: "avalanche",
  ftm: "fantom",
  fantom: "fantom",
  celo: "celo",
  blast: "blast",
};

const ORACLE_ABI = [
  "function isSanctioned(address addr) external view returns (bool)",
  "function name() external pure returns (string)",
];

const ORACLE_NAME = "Chainalysis sanctions oracle";
const SANCTIONS_LIST_SOURCE = "OFAC SDN (US Treasury)";

// ── Helpers ─────────────────────────────────────────────────

function resolveChain(input: unknown): string | null {
  if (typeof input !== "string") return "base";
  const key = input.toLowerCase().trim();
  const resolved = CHAIN_ALIASES[key];
  return resolved && CHAINALYSIS_ORACLE[resolved] ? resolved : null;
}

function pickRpcUrl(chain: string): string {
  return ALCHEMY_RPC[chain] || PUBLIC_RPC[chain];
}

function genId(): string {
  return `kyc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Check whether an address appears on the Chainalysis sanctions oracle
 * on a given chain. Returns the boolean plus context for the response.
 */
async function screenAddress(address: string, chain: string): Promise<{
  isSanctioned: boolean;
  oracleAddress: string;
  rpcUrl: string;
  durationMs: number;
}> {
  const oracleAddress = CHAINALYSIS_ORACLE[chain];
  const rpcUrl = pickRpcUrl(chain);
  const provider = new JsonRpcProvider(rpcUrl);
  const oracle = new Contract(oracleAddress, ORACLE_ABI, provider);

  const start = Date.now();
  const isSanctioned: boolean = await oracle.isSanctioned(address);
  const durationMs = Date.now() - start;

  return { isSanctioned, oracleAddress, rpcUrl, durationMs };
}

// ── POST /api/v1/kyc/verify ─────────────────────────────────
//
// Body:
//   address  - the wallet to screen (required, EVM 0x... address)
//   chain    - chain to query the oracle on (optional, default "base")
//   type     - "individual" | "business" (optional, stored only)
//   metadata - any caller-supplied JSON (optional, stored only)
//
// Returns the screening result and persists a record to Supabase.

export async function kycVerifyHandler(req: Request, res: Response) {
  try {
    const { address, chain, type, metadata } = req.body || {};

    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "Missing required field: address" });
    }
    if (!isAddress(address)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }

    const resolvedChain = resolveChain(chain);
    if (!resolvedChain) {
      return res.status(400).json({
        error: `Unsupported chain: ${chain}`,
        supportedChains: Object.keys(CHAINALYSIS_ORACLE),
        note: "Chainalysis sanctions oracle is only deployed on these chains. Defaults to 'base'.",
      });
    }

    const kycType = type === "business" ? "business" : "individual";

    // ── Run the on-chain screening ────────────────────────────
    let screen;
    try {
      screen = await screenAddress(address, resolvedChain);
    } catch (rpcErr: any) {
      console.error("[kyc/verify] oracle call failed:", rpcErr?.message || rpcErr);
      return res.status(502).json({
        error: "Sanctions oracle call failed",
        details: rpcErr?.message || "RPC error",
        chain: resolvedChain,
      });
    }

    const id = genId();
    const now = new Date();
    const status = screen.isSanctioned ? "rejected" : "approved";

    // The oracle ONLY covers OFAC SDN. Be honest about what was and
    // wasn't checked so this never gets mistaken for full KYC.
    const checks = {
      sanctions: true,
      sanctions_result: screen.isSanctioned ? "match" : "clear",
      identity: false,
      pep: false,
      adverse_media: false,
    };

    const record = {
      id,
      type: kycType,
      address,
      status,
      level: "sanctions-screening",
      checks,
      createdAt: now.toISOString(),
      completedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(), // sanctions can change daily
      metadata: { chain: resolvedChain, ...(metadata || {}) },
    };

    // Persist asynchronously — don't fail the response if the DB write hiccups.
    try {
      await kycDb.create(record);
    } catch (dbErr: any) {
      console.error("[kyc/verify] db write failed:", dbErr?.message || dbErr);
      // Continue — the caller still gets a real answer.
    }

    return res.json({
      id,
      type: kycType,
      address,
      chain: resolvedChain,
      status,
      level: "sanctions-screening",
      checks,
      result: {
        isSanctioned: screen.isSanctioned,
        listSource: SANCTIONS_LIST_SOURCE,
        oracle: {
          name: ORACLE_NAME,
          contract: screen.oracleAddress,
          chain: resolvedChain,
        },
        latencyMs: screen.durationMs,
      },
      scope: {
        included: ["OFAC SDN sanctions list (on-chain)"],
        excluded: [
          "Identity / document verification",
          "Liveness check",
          "PEP screening",
          "Adverse media",
          "EU / UN / UK sanctions lists",
          "Behavioral / address-cluster risk",
        ],
        note: "This endpoint only screens against the Chainalysis Sanctions Oracle (OFAC SDN). For full KYC, layer in a dedicated provider (Persona, Sumsub, Chainalysis Address Screening).",
      },
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      expiresAt: record.expiresAt,
      _gateway: { provider: "spraay-x402", version: "2.10.0" },
      timestamp: now.toISOString(),
    });
  } catch (error: any) {
    console.error("[kyc/verify] unexpected error:", error?.message || error);
    return res.status(500).json({ error: "Sanctions screening failed", details: error?.message });
  }
}

// ── GET /api/v1/kyc/status ──────────────────────────────────
//
// Query params:
//   id       - prior screening record id (optional)
//   address  - wallet to look up the most recent record for (optional)
//
// At least one of `id` or `address` is required.

export async function kycStatusHandler(req: Request, res: Response) {
  try {
    const { id, address } = req.query;
    let record: any = null;

    if (id && typeof id === "string") {
      record = await kycDb.get(id);
    } else if (address && typeof address === "string") {
      if (!isAddress(address)) {
        return res.status(400).json({ error: "Invalid Ethereum address" });
      }
      record = await kycDb.getByAddress(address);
    } else {
      return res.status(400).json({ error: "Provide either `id` or `address`" });
    }

    if (!record) {
      return res.status(404).json({ error: "KYC record not found" });
    }

    return res.json({
      id: record.id,
      type: record.type,
      address: record.address,
      level: record.level,
      status: record.status,
      checks: record.checks,
      metadata: record.metadata || {},
      createdAt: record.created_at,
      completedAt: record.completed_at || null,
      expiresAt: record.expires_at,
      _gateway: { provider: "spraay-x402", version: "2.10.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[kyc/status] error:", error?.message || error);
    return res.status(500).json({ error: "Failed to fetch KYC record", details: error?.message });
  }
}
