import { Request, Response } from "express";
import { isAddress } from "ethers";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

// LI.FI API — free aggregator across 30+ bridges
const LIFI_API = "https://li.quest/v1";

// Supported chains with Spraay contracts
const SUPPORTED_CHAINS: Record<string, ChainInfo> = {
  base: {
    chainId: 8453,
    name: "Base",
    nativeCurrency: "ETH",
    spraayContract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  ethereum: {
    chainId: 1,
    name: "Ethereum",
    nativeCurrency: "ETH",
    spraayContract: "0x15E7aEDa45094DD2E9E746FcA1C726cAd7aE58b3",
    usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  },
  arbitrum: {
    chainId: 42161,
    name: "Arbitrum",
    nativeCurrency: "ETH",
    spraayContract: "0x5be43aA67804aD84fcb890d0AE5F257fb1674302",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  },
  polygon: {
    chainId: 137,
    name: "Polygon",
    nativeCurrency: "MATIC",
    spraayContract: null,
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  bnb: {
    chainId: 56,
    name: "BNB Chain",
    nativeCurrency: "BNB",
    spraayContract: null,
    usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  },
  avalanche: {
    chainId: 43114,
    name: "Avalanche",
    nativeCurrency: "AVAX",
    spraayContract: null,
    usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
  },
  optimism: {
    chainId: 10,
    name: "Optimism",
    nativeCurrency: "ETH",
    spraayContract: null,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  unichain: {
    chainId: 130,
    name: "Unichain",
    nativeCurrency: "ETH",
    spraayContract: "0x08fA5D1c16CD6E2a16FC0E4839f262429959E073",
    usdc: null,
  },
};

interface ChainInfo {
  chainId: number;
  name: string;
  nativeCurrency: string;
  spraayContract: string | null;
  usdc: string | null;
}

// Common token addresses (native representation)
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

// ============================================
// HELPERS
// ============================================

function resolveChain(input: string): ChainInfo | null {
  const lower = input.toLowerCase();

  // By name
  if (SUPPORTED_CHAINS[lower]) return SUPPORTED_CHAINS[lower];

  // By chainId
  const chainId = parseInt(input);
  if (!isNaN(chainId)) {
    for (const chain of Object.values(SUPPORTED_CHAINS)) {
      if (chain.chainId === chainId) return chain;
    }
  }

  // Aliases
  const aliases: Record<string, string> = {
    eth: "ethereum",
    mainnet: "ethereum",
    arb: "arbitrum",
    poly: "polygon",
    matic: "polygon",
    bsc: "bnb",
    binance: "bnb",
    avax: "avalanche",
    op: "optimism",
    uni: "unichain",
  };

  if (aliases[lower]) return SUPPORTED_CHAINS[aliases[lower]];
  return null;
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * GET /api/v1/bridge/chains
 *
 * List supported chains with Spraay contract addresses and USDC addresses.
 */
export async function bridgeChainsHandler(_req: Request, res: Response) {
  trackRequest("bridge_chains");

  const chains = Object.entries(SUPPORTED_CHAINS).map(([key, chain]) => ({
    key,
    name: chain.name,
    chainId: chain.chainId,
    nativeCurrency: chain.nativeCurrency,
    spraayContract: chain.spraayContract,
    usdc: chain.usdc,
    hasSpraay: !!chain.spraayContract,
  }));

  return res.json({
    chains,
    chainCount: chains.length,
    spraayChains: chains.filter((c) => c.hasSpraay).length,
    _gateway: {
      provider: "spraay-x402",
      version: "2.3.0",
      endpoint: "GET /api/v1/bridge/chains",
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * GET /api/v1/bridge/quote
 *
 * Get a cross-chain bridge quote via LI.FI aggregator.
 * Returns estimated output, fees, bridge route, and estimated time.
 *
 * Query params:
 *   fromChain   - Source chain name or chainId (e.g. "base", "8453")
 *   toChain     - Destination chain name or chainId
 *   token       - Token address on source chain (or "USDC" / "native" shortcuts)
 *   amount      - Amount in atomic units (wei/smallest unit)
 *   fromAddress - Sender address
 */
export async function bridgeQuoteHandler(req: Request, res: Response) {
  try {
    const { fromChain, toChain, token, amount, fromAddress } = req.query;

    // ---- Validation ----
    if (!fromChain || !toChain || !token || !amount || !fromAddress) {
      return res.status(400).json({
        error: "Missing required query params",
        required: { fromChain: "string", toChain: "string", token: "string", amount: "string", fromAddress: "string" },
        example: "/api/v1/bridge/quote?fromChain=base&toChain=ethereum&token=USDC&amount=1000000000&fromAddress=0xYour...",
        supportedChains: Object.keys(SUPPORTED_CHAINS),
        tokenShortcuts: { USDC: "Auto-resolves to chain-specific USDC", native: "Native currency (ETH, MATIC, etc)" },
      });
    }

    const sourceChain = resolveChain(fromChain as string);
    const destChain = resolveChain(toChain as string);

    if (!sourceChain) {
      return res.status(400).json({
        error: `Unknown source chain: ${fromChain}`,
        supportedChains: Object.keys(SUPPORTED_CHAINS),
      });
    }
    if (!destChain) {
      return res.status(400).json({
        error: `Unknown destination chain: ${toChain}`,
        supportedChains: Object.keys(SUPPORTED_CHAINS),
      });
    }

    if (sourceChain.chainId === destChain.chainId) {
      return res.status(400).json({ error: "Source and destination chain cannot be the same. Use /swap/execute for same-chain swaps." });
    }

    if (!isAddress(fromAddress as string)) {
      return res.status(400).json({ error: "Invalid fromAddress" });
    }

    // Resolve token address
    let tokenAddress = token as string;
    const tokenUpper = tokenAddress.toUpperCase();

    if (tokenUpper === "USDC") {
      if (!sourceChain.usdc) {
        return res.status(400).json({ error: `USDC not available on ${sourceChain.name}` });
      }
      tokenAddress = sourceChain.usdc;
    } else if (tokenUpper === "NATIVE" || tokenUpper === "ETH" || tokenUpper === "MATIC" || tokenUpper === "BNB" || tokenUpper === "AVAX") {
      tokenAddress = NATIVE_TOKEN;
    }

    // ---- Query LI.FI for quote ----
    const quoteUrl = new URL(`${LIFI_API}/quote`);
    quoteUrl.searchParams.set("fromChain", sourceChain.chainId.toString());
    quoteUrl.searchParams.set("toChain", destChain.chainId.toString());
    quoteUrl.searchParams.set("fromToken", tokenAddress);
    quoteUrl.searchParams.set("toToken", tokenAddress === NATIVE_TOKEN ? NATIVE_TOKEN : (destChain.usdc || NATIVE_TOKEN));
    quoteUrl.searchParams.set("fromAmount", amount as string);
    quoteUrl.searchParams.set("fromAddress", fromAddress as string);

    const response = await fetch(quoteUrl.toString(), {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(422).json({
        error: "Bridge quote failed",
        details: errorBody,
        suggestion: "Check token addresses and amounts. Use 'USDC' or 'native' shortcuts for common tokens.",
      });
    }

    const quoteData = await response.json();

    // ---- Extract key fields ----
    const estimate = quoteData.estimate || {};
    const action = quoteData.action || {};
    const transactionRequest = quoteData.transactionRequest || {};

    trackRequest("bridge_quote");

    return res.json({
      status: "ready",
      route: {
        fromChain: {
          name: sourceChain.name,
          chainId: sourceChain.chainId,
          token: action.fromToken?.symbol || tokenUpper,
          tokenAddress: action.fromToken?.address || tokenAddress,
          amount: action.fromAmount || amount,
        },
        toChain: {
          name: destChain.name,
          chainId: destChain.chainId,
          token: action.toToken?.symbol || "USDC",
          tokenAddress: action.toToken?.address || destChain.usdc,
          estimatedAmount: estimate.toAmount || null,
          minimumAmount: estimate.toAmountMin || null,
        },
        bridge: quoteData.toolDetails?.name || quoteData.tool || "unknown",
        bridgeType: quoteData.type || "bridge",
      },
      fees: {
        gasCostUSD: estimate.gasCosts?.[0]?.amountUSD || null,
        bridgeFeeUSD: estimate.feeCosts?.[0]?.amountUSD || null,
        totalFeeUSD: estimate.gasCosts?.[0]?.amountUSD && estimate.feeCosts?.[0]?.amountUSD
          ? (parseFloat(estimate.gasCosts[0].amountUSD) + parseFloat(estimate.feeCosts[0].amountUSD)).toFixed(4)
          : null,
      },
      timing: {
        estimatedSeconds: estimate.executionDuration || null,
        estimatedMinutes: estimate.executionDuration ? Math.ceil(estimate.executionDuration / 60) : null,
      },
      transaction: transactionRequest.to
        ? {
            to: transactionRequest.to,
            data: transactionRequest.data,
            value: transactionRequest.value || "0x0",
            chainId: sourceChain.chainId,
            gasLimit: transactionRequest.gasLimit || null,
            gasPrice: transactionRequest.gasPrice || null,
          }
        : null,
      approval: estimate.approvalAddress
        ? {
            spender: estimate.approvalAddress,
            token: tokenAddress,
            amount: action.fromAmount || amount,
            note: `Approve ${estimate.approvalAddress} to spend tokens before bridging`,
          }
        : null,
      instructions: [
        estimate.approvalAddress ? "1. Approve the bridge contract to spend your tokens" : null,
        `${estimate.approvalAddress ? "2" : "1"}. Sign and submit the bridge transaction on ${sourceChain.name}`,
        `${estimate.approvalAddress ? "3" : "2"}. Wait ~${estimate.executionDuration ? Math.ceil(estimate.executionDuration / 60) : "5-15"} minutes for delivery on ${destChain.name}`,
      ].filter(Boolean),
      spraay: {
        sourceHasSpraay: !!sourceChain.spraayContract,
        destHasSpraay: !!destChain.spraayContract,
        sourceContract: sourceChain.spraayContract,
        destContract: destChain.spraayContract,
        tip: sourceChain.spraayContract && destChain.spraayContract
          ? "Both chains have Spraay — you can bridge then batch pay in one agent workflow"
          : null,
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.3.0",
        aggregator: "li.fi",
        endpoint: "GET /api/v1/bridge/quote",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Bridge quote error:", error.message);
    return res.status(500).json({
      error: "Failed to get bridge quote",
      details: error.message,
    });
  }
}
