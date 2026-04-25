/**
 * DeFi Positions handler — real on-chain reads of a wallet's DeFi exposure.
 * (ethers v6 compatible)
 *
 * Endpoint:
 *   GET /api/v1/defi/positions?address=0x...&chain=base-mainnet  ($0.02)
 *
 * Supported protocols (Base-first, since that's where Spraay's volume is):
 *   - Aave V3  (lending/borrowing)
 *   - Compound V3 (cUSDCv3)
 *   - Aerodrome (LP receipts via ERC-20 balance of pool tokens)
 *
 * Approach:
 *   We call each protocol's on-chain position reader directly using the
 *   gateway's Alchemy RPC. No third-party DeFi-position API is needed — this
 *   keeps Spraay on a single provider (Alchemy) and avoids an extra dependency.
 *
 *   If a wallet has zero exposure to a given protocol, that protocol is
 *   simply omitted from the response (rather than returning an empty stub).
 */

import type { Request, Response } from "express";
import {
  isAddress,
  JsonRpcProvider,
  Contract,
  formatUnits,
  type Provider,
} from "ethers";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

const RPC_URLS: Record<string, string> = {
  "base-mainnet": `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "eth-mainnet": `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
};

// ────────────────────────────────────────────────────────────────────────────
// Protocol contract addresses (Base mainnet)
// ────────────────────────────────────────────────────────────────────────────

const BASE = {
  // Aave V3 on Base
  aaveV3UiPoolDataProvider: "0x174446a6741ff0dAcBC3b4464f25c497E58F1fE8",
  aaveV3PoolAddressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",

  // Compound V3 — cUSDCv3 market on Base
  compoundV3cUSDC: "0xb125E6687d4313864e53df431d5425969c15Eb2F",

  // Aerodrome — Voter contract (kept for future expansion)
  aerodromeVoter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
};

// ────────────────────────────────────────────────────────────────────────────
// ABIs (minimal — only the methods we actually call)
// ────────────────────────────────────────────────────────────────────────────

const AAVE_UI_POOL_DATA_PROVIDER_ABI = [
  "function getUserReservesData(address provider, address user) view returns ((address underlyingAsset, uint256 scaledATokenBalance, bool usageAsCollateralEnabledOnUser, uint256 stableBorrowRate, uint256 scaledVariableDebt, uint256 principalStableDebt, uint256 stableBorrowLastUpdateTimestamp)[], uint8)",
];

const COMPOUND_V3_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function borrowBalanceOf(address account) view returns (uint256)",
  "function baseToken() view returns (address)",
  "function symbol() view returns (string)",
];

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function name() view returns (string)",
];

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface Position {
  protocol: string;
  category: "lending" | "borrowing" | "liquidity" | "staking";
  chain: string;
  asset_address: string;
  asset_symbol?: string;
  asset_decimals?: number;
  balance_raw: string;
  balance_human?: string;
  extra?: Record<string, any>;
}

// ────────────────────────────────────────────────────────────────────────────
// Protocol readers
// ────────────────────────────────────────────────────────────────────────────

async function readAaveV3(
  user: string,
  provider: Provider,
  chain: string
): Promise<Position[]> {
  if (chain !== "base-mainnet") return [];

  const ui = new Contract(
    BASE.aaveV3UiPoolDataProvider,
    AAVE_UI_POOL_DATA_PROVIDER_ABI,
    provider
  );

  const result = await ui.getUserReservesData(
    BASE.aaveV3PoolAddressesProvider,
    user
  );
  // ethers v6 returns a Result object; the first member is the array of reserves.
  const reserves = result[0] as Array<any>;

  const positions: Position[] = [];

  for (const r of reserves) {
    // Reserve fields are accessible by name on a struct-typed Result.
    const supplied: bigint = r.scaledATokenBalance ?? r[1];
    const borrowed: bigint = r.scaledVariableDebt ?? r[4];
    const underlyingAsset: string = r.underlyingAsset ?? r[0];
    const usageAsCollateralEnabledOnUser: boolean =
      r.usageAsCollateralEnabledOnUser ?? r[2];

    if (supplied === 0n && borrowed === 0n) continue;

    const meta = await fetchErc20Meta(underlyingAsset, provider);

    if (supplied !== 0n) {
      positions.push({
        protocol: "aave-v3",
        category: "lending",
        chain,
        asset_address: underlyingAsset,
        asset_symbol: meta.symbol,
        asset_decimals: meta.decimals,
        balance_raw: supplied.toString(),
        balance_human: safeFormatUnits(supplied, meta.decimals),
        extra: {
          used_as_collateral: usageAsCollateralEnabledOnUser,
        },
      });
    }

    if (borrowed !== 0n) {
      positions.push({
        protocol: "aave-v3",
        category: "borrowing",
        chain,
        asset_address: underlyingAsset,
        asset_symbol: meta.symbol,
        asset_decimals: meta.decimals,
        balance_raw: borrowed.toString(),
        balance_human: safeFormatUnits(borrowed, meta.decimals),
      });
    }
  }

  return positions;
}

async function readCompoundV3(
  user: string,
  provider: Provider,
  chain: string
): Promise<Position[]> {
  if (chain !== "base-mainnet") return [];

  const market = new Contract(
    BASE.compoundV3cUSDC,
    COMPOUND_V3_ABI,
    provider
  );

  const [supplied, borrowed, baseToken] = await Promise.all([
    market.balanceOf(user) as Promise<bigint>,
    market.borrowBalanceOf(user) as Promise<bigint>,
    market.baseToken() as Promise<string>,
  ]);

  if (supplied === 0n && borrowed === 0n) return [];

  const meta = await fetchErc20Meta(baseToken, provider);
  const positions: Position[] = [];

  if (supplied !== 0n) {
    positions.push({
      protocol: "compound-v3",
      category: "lending",
      chain,
      asset_address: baseToken,
      asset_symbol: meta.symbol,
      asset_decimals: meta.decimals,
      balance_raw: supplied.toString(),
      balance_human: safeFormatUnits(supplied, meta.decimals),
      extra: { market: "cUSDCv3" },
    });
  }

  if (borrowed !== 0n) {
    positions.push({
      protocol: "compound-v3",
      category: "borrowing",
      chain,
      asset_address: baseToken,
      asset_symbol: meta.symbol,
      asset_decimals: meta.decimals,
      balance_raw: borrowed.toString(),
      balance_human: safeFormatUnits(borrowed, meta.decimals),
      extra: { market: "cUSDCv3" },
    });
  }

  return positions;
}

/**
 * Aerodrome LP detection: LP tokens are regular ERC-20s (the pool contract
 * itself). We check the user's balance against a curated set of high-volume
 * Aerodrome pools. This list can be expanded later by indexing the Voter.
 */
const AERODROME_POOLS_BASE = [
  { address: "0xcDAC0d6c6C59727a65F871236188350531885C43", name: "vAMM-USDC/WETH" },
  { address: "0x4e829F8A5213c42535AB84AA40BD4aDCCe9cBa02", name: "sAMM-USDC/USDT" },
  { address: "0x9287C921f5d920cEeE0d07d7c58d476E46aCC640", name: "vAMM-AERO/USDC" },
];

async function readAerodrome(
  user: string,
  provider: Provider,
  chain: string
): Promise<Position[]> {
  if (chain !== "base-mainnet") return [];

  const positions: Position[] = [];

  const calls = AERODROME_POOLS_BASE.map(async (pool) => {
    const c = new Contract(
      pool.address,
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );
    const bal = (await c.balanceOf(user)) as bigint;
    if (bal === 0n) return null;

    const meta = await fetchErc20Meta(pool.address, provider);
    return {
      protocol: "aerodrome",
      category: "liquidity" as const,
      chain,
      asset_address: pool.address,
      asset_symbol: meta.symbol || pool.name,
      asset_decimals: meta.decimals,
      balance_raw: bal.toString(),
      balance_human: safeFormatUnits(bal, meta.decimals),
      extra: { pool_name: pool.name },
    };
  });

  const results = await Promise.all(calls);
  for (const r of results) if (r) positions.push(r);
  return positions;
}

// ────────────────────────────────────────────────────────────────────────────
// Handler
// ────────────────────────────────────────────────────────────────────────────

export async function defiPositionsHandler(
  req: Request,
  res: Response
): Promise<void> {
  const address = String(req.query.address || "").trim();
  const chain = String(req.query.chain || "base-mainnet").trim();

  if (!isAddress(address)) {
    res.status(400).json({
      error: "invalid_address",
      message: "Query parameter 'address' must be a valid EVM address.",
    });
    return;
  }

  if (!RPC_URLS[chain]) {
    res.status(400).json({
      error: "unsupported_chain",
      message: `DeFi positions currently support: ${Object.keys(RPC_URLS).join(", ")}`,
    });
    return;
  }

  if (!ALCHEMY_API_KEY) {
    res.status(503).json({
      error: "provider_not_configured",
      message: "RPC provider is not configured.",
    });
    return;
  }

  const provider = new JsonRpcProvider(RPC_URLS[chain]);
  const started = Date.now();

  // Run all protocol readers in parallel. If one fails we still return the others.
  const results = await Promise.allSettled([
    readAaveV3(address, provider, chain),
    readCompoundV3(address, provider, chain),
    readAerodrome(address, provider, chain),
  ]);

  const positions: Position[] = [];
  const errors: Array<{ protocol: string; message: string }> = [];
  const protocolNames = ["aave-v3", "compound-v3", "aerodrome"];

  results.forEach((r, idx) => {
    if (r.status === "fulfilled") {
      positions.push(...r.value);
    } else {
      errors.push({
        protocol: protocolNames[idx],
        message: String(r.reason?.message || r.reason).slice(0, 200),
      });
    }
  });

  // Group by protocol for easier consumption.
  const byProtocol: Record<string, Position[]> = {};
  for (const p of positions) {
    if (!byProtocol[p.protocol]) byProtocol[p.protocol] = [];
    byProtocol[p.protocol].push(p);
  }

  const latencyMs = Date.now() - started;

  res.json({
    address,
    chain,
    total_positions: positions.length,
    protocols_with_exposure: Object.keys(byProtocol),
    positions,
    by_protocol: byProtocol,
    partial_errors: errors.length > 0 ? errors : undefined,
    _gateway: {
      endpoint: "defi/positions",
      price_usdc: "0.02",
      upstream_latency_ms: latencyMs,
      protocols_checked: protocolNames,
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Metadata cache (in-memory, per-process)
// ────────────────────────────────────────────────────────────────────────────

const metaCache = new Map<string, { symbol: string; decimals: number }>();

async function fetchErc20Meta(
  address: string,
  provider: Provider
): Promise<{ symbol: string; decimals: number }> {
  const key = address.toLowerCase();
  if (metaCache.has(key)) return metaCache.get(key)!;

  const c = new Contract(address, ERC20_ABI, provider);
  try {
    const [symbolRaw, decimalsRaw] = await Promise.all([
      (c.symbol() as Promise<string>).catch(() => "UNKNOWN"),
      (c.decimals() as Promise<bigint>).catch(() => 18n),
    ]);
    const meta = {
      symbol: String(symbolRaw),
      decimals: typeof decimalsRaw === "bigint" ? Number(decimalsRaw) : Number(decimalsRaw),
    };
    metaCache.set(key, meta);
    return meta;
  } catch {
    const fallback = { symbol: "UNKNOWN", decimals: 18 };
    metaCache.set(key, fallback);
    return fallback;
  }
}

function safeFormatUnits(value: bigint, decimals: number): string {
  try {
    return formatUnits(value, decimals);
  } catch {
    return value.toString();
  }
}
