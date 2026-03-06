// ============================================================
// REAL RPC PROXY — replaces simulated rpc.ts in spraay-x402-gateway
// ============================================================
// Env var needed on Railway:  ALCHEMY_API_KEY=your_key_here
//
// Alchemy free tier: 30M compute units/month (~1.8M simple calls)
// That's more than enough for x402 pay-per-call usage.
// ============================================================

import { Request, Response } from "express";
import axios from "axios";

// ── Chain → Alchemy RPC mapping ──────────────────────────────
// Format: https://{slug}.g.alchemy.com/v2/{ALCHEMY_API_KEY}
// Chains not on Alchemy use public RPCs as fallback.

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";

interface ChainConfig {
  name: string;
  chainId: number;
  rpcUrl: string; // will have API key injected at runtime
  type: "alchemy" | "public";
}

const SUPPORTED_CHAINS: Record<string, ChainConfig> = {
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    type: "alchemy",
  },
  ethereum: {
    name: "Ethereum",
    chainId: 1,
    rpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    type: "alchemy",
  },
  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    type: "alchemy",
  },
  polygon: {
    name: "Polygon",
    chainId: 137,
    rpcUrl: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    type: "alchemy",
  },
  optimism: {
    name: "Optimism",
    chainId: 10,
    rpcUrl: `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
    type: "alchemy",
  },
  avalanche: {
    name: "Avalanche C-Chain",
    chainId: 43114,
    rpcUrl: "https://api.avax.network/ext/bc/C/rpc",
    type: "public",
  },
  bsc: {
    name: "BNB Chain",
    chainId: 56,
    rpcUrl: "https://bsc-dataseed1.binance.org",
    type: "public",
  },
};

// ── Allowed JSON-RPC methods (read-only, no signing) ─────────
const ALLOWED_METHODS = [
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getTransactionReceipt",
  "eth_getTransactionByHash",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_chainId",
  "eth_getTransactionCount",
  "net_version",
];

// ── POST /api/v1/rpc/call ────────────────────────────────────
export async function rpcCallHandler(req: Request, res: Response) {
  try {
    const { chain, method, params } = req.body;

    if (!chain || !method) {
      return res.status(400).json({ error: "Missing required fields: chain, method" });
    }

    const chainConfig = SUPPORTED_CHAINS[chain];
    if (!chainConfig) {
      return res.status(400).json({
        error: `Unsupported chain: ${chain}`,
        supported: Object.keys(SUPPORTED_CHAINS),
      });
    }

    if (!ALLOWED_METHODS.includes(method)) {
      return res.status(400).json({
        error: `Method not allowed: ${method}`,
        allowed: ALLOWED_METHODS,
      });
    }

    // Check Alchemy key for Alchemy-backed chains
    if (chainConfig.type === "alchemy" && !ALCHEMY_API_KEY) {
      return res.status(503).json({
        error: "RPC provider not configured for this chain",
        chain,
      });
    }

    // Forward the JSON-RPC call to the real provider
    const rpcPayload = {
      jsonrpc: "2.0",
      id: 1,
      method,
      params: params || [],
    };

    const rpcResponse = await axios.post(chainConfig.rpcUrl, rpcPayload, {
      headers: { "Content-Type": "application/json" },
      timeout: 15000, // 15s timeout
    });

    return res.json({
      chain,
      chainId: chainConfig.chainId,
      method,
      result: rpcResponse.data.result,
      error: rpcResponse.data.error || null,
      _gateway: {
        provider: chainConfig.type === "alchemy" ? "alchemy" : "public",
        version: "2.9.0",
        live: true,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    // Distinguish timeout vs other errors
    if (error.code === "ECONNABORTED") {
      return res.status(504).json({ error: "RPC call timed out", chain: req.body?.chain });
    }
    return res.status(500).json({
      error: "RPC call failed",
      details: error.response?.data?.error?.message || error.message,
    });
  }
}

// ── GET /api/v1/rpc/chains ───────────────────────────────────
export async function rpcChainsHandler(_req: Request, res: Response) {
  const chains = Object.entries(SUPPORTED_CHAINS).map(([key, config]) => ({
    key,
    name: config.name,
    chainId: config.chainId,
    provider: config.type,
    status: config.type === "alchemy" && !ALCHEMY_API_KEY ? "unavailable" : "live",
  }));

  return res.json({
    chains,
    allowedMethods: ALLOWED_METHODS,
    _gateway: { provider: "spraay-x402", version: "2.9.0", live: true },
    timestamp: new Date().toISOString(),
  });
}
