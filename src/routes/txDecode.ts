/**
 * 💧 Spraay x402 Gateway — TX Decoder (Blockscout)
 *
 * GET /api/v1/tx/decode
 *
 * Decode any EVM transaction into structured data + plain-English summary.
 * Template-based — covers transfers, swaps, approvals, wraps, mints, and
 * NFT transfers with zero inference cost. Falls back to raw calldata + token
 * transfer reconstruction for unknown selectors.
 *
 * FREE ENDPOINT — loss-leader #2. Every agent that decodes a tx has
 * gateway.spraay.app in its config, right next to 140+ paid endpoints.
 *
 * Upstream: Blockscout API v2 (public, no key, generous limits)
 *   Base:     https://base.blockscout.com/api/v2
 *   Ethereum: https://eth.blockscout.com/api/v2
 *   Arbitrum: https://arbitrum.blockscout.com/api/v2
 *   Optimism: https://optimism.blockscout.com/api/v2
 *   Polygon:  https://polygon.blockscout.com/api/v2
 */

import { Request, Response } from "express";
import { trackRequest } from "./health.js";

// ============================================
// CHAIN → BLOCKSCOUT BASE URL
// ============================================

const BLOCKSCOUT_URLS: Record<string, string> = {
  base: "https://base.blockscout.com/api/v2",
  ethereum: "https://eth.blockscout.com/api/v2",
  eth: "https://eth.blockscout.com/api/v2",
  arbitrum: "https://arbitrum.blockscout.com/api/v2",
  optimism: "https://optimism.blockscout.com/api/v2",
  polygon: "https://polygon.blockscout.com/api/v2",
};

// ============================================
// KNOWN FUNCTION SELECTORS (4-byte)
// Covers ~80%+ of agent-relevant transactions.
// ============================================

const SELECTORS: Record<string, { name: string; type: string }> = {
  // ERC-20
  "0xa9059cbb": { name: "transfer(address,uint256)", type: "transfer" },
  "0x095ea7b3": { name: "approve(address,uint256)", type: "approval" },
  "0x23b872dd": { name: "transferFrom(address,address,uint256)", type: "transfer" },

  // Uniswap / DEX
  "0x3593564c": { name: "execute(bytes,bytes[],uint256)", type: "swap" },       // Universal Router
  "0x5ae401dc": { name: "multicall(uint256,bytes[])", type: "swap" },           // V3 Router multicall
  "0x04e45aaf": { name: "exactInputSingle(...)", type: "swap" },               // V3 exactInputSingle
  "0xb858183f": { name: "exactInput(...)", type: "swap" },                     // V3 exactInput
  "0xdb3e2198": { name: "exactOutputSingle(...)", type: "swap" },              // V3 exactOutputSingle
  "0x09b81346": { name: "exactOutput(...)", type: "swap" },                    // V3 exactOutput
  "0x472b43f3": { name: "swapExactTokensForTokens(...)", type: "swap" },       // V2 style
  "0x38ed1739": { name: "swapExactTokensForTokens(...)", type: "swap" },       // V2 Router
  "0x7ff36ab5": { name: "swapExactETHForTokens(...)", type: "swap" },          // V2 Router
  "0x18cbafe5": { name: "swapExactTokensForETH(...)", type: "swap" },          // V2 Router
  "0x8803dbee": { name: "swapTokensForExactTokens(...)", type: "swap" },       // V2 Router
  "0xfb3bdb41": { name: "swapETHForExactTokens(...)", type: "swap" },          // V2 Router
  "0x414bf389": { name: "exactInputSingle(...)", type: "swap" },               // V3 SwapRouter (old)
  "0xc04b8d59": { name: "exactInput(...)", type: "swap" },                     // V3 SwapRouter (old)
  "0xac9650d8": { name: "multicall(bytes[])", type: "swap" },                  // V3 multicall (no deadline)

  // Aerodrome / Velodrome
  "0xb6f9de95": { name: "swapExactETHForTokensSupportingFeeOnTransferTokens", type: "swap" },
  "0x5c11d795": { name: "swapExactTokensForTokensSupportingFeeOnTransferTokens", type: "swap" },

  // WETH
  "0xd0e30db0": { name: "deposit()", type: "wrap" },
  "0x2e1a7d4d": { name: "withdraw(uint256)", type: "unwrap" },

  // NFT (ERC-721)
  "0x42842e0e": { name: "safeTransferFrom(address,address,uint256)", type: "nft_transfer" },
  "0xb88d4fde": { name: "safeTransferFrom(address,address,uint256,bytes)", type: "nft_transfer" },

  // ERC-1155
  "0xf242432a": { name: "safeTransferFrom(address,address,uint256,uint256,bytes)", type: "nft_transfer" },
  "0x2eb2c2d6": { name: "safeBatchTransferFrom(...)", type: "nft_transfer" },

  // Spraay 💧
  "0x4d3a1d47": { name: "batchTransfer(address,address[],uint256[])", type: "batch_payment" },

  // Common admin/misc
  "0x8456cb59": { name: "pause()", type: "admin" },
  "0x3f4ba83a": { name: "unpause()", type: "admin" },
  "0x715018a6": { name: "renounceOwnership()", type: "admin" },
  "0xf2fde38b": { name: "transferOwnership(address)", type: "admin" },
};

// ============================================
// TOKEN TRANSFER PARSING
// ============================================

interface ParsedTransfer {
  from: string;
  to: string;
  value: string;
  valueFormatted: string | null;
  symbol: string;
  tokenAddress: string;
  tokenType: string;
  decimals: number | null;
}

function parseTokenTransfers(transfers: any[]): ParsedTransfer[] {
  return (transfers || []).map(t => {
    const token = t.token || {};
    const total = t.total || {};
    const decimals = parseInt(total.decimals || token.decimals) || null;
    const rawValue = total.value || "0";

    let valueFormatted: string | null = null;
    if (decimals && rawValue !== "0") {
      const num = parseInt(rawValue) / Math.pow(10, decimals);
      valueFormatted = num > 0.001 ? num.toLocaleString("en-US", { maximumFractionDigits: 6 }) : num.toExponential(4);
    }

    return {
      from: t.from?.hash || "",
      to: t.to?.hash || "",
      value: rawValue,
      valueFormatted,
      symbol: token.symbol || "UNKNOWN",
      tokenAddress: token.address || "",
      tokenType: token.type || "ERC-20",
      decimals,
    };
  });
}

// ============================================
// PLAIN-ENGLISH SUMMARY (template tier)
// ============================================

function formatAddress(addr: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "unknown";
}

function formatValue(val: string, decimals: number): string {
  if (!val || val === "0") return "0";
  const num = parseInt(val) / Math.pow(10, decimals);
  return num > 0.001 ? num.toLocaleString("en-US", { maximumFractionDigits: 6 }) : num.toExponential(4);
}

function generateSummary(
  type: string,
  method: string | null,
  from: string,
  to: string,
  value: string,
  transfers: ParsedTransfer[],
  status: string,
): string {
  const ok = status === "ok" || status === "success";
  const statusStr = ok ? "" : " [FAILED]";

  // Native ETH transfer (no calldata)
  if ((!method || method === "0x") && value !== "0") {
    const ethAmount = formatValue(value, 18);
    return `${formatAddress(from)} sent ${ethAmount} ETH to ${formatAddress(to)}.${statusStr}`;
  }

  switch (type) {
    case "transfer": {
      if (transfers.length === 1) {
        const t = transfers[0];
        return `${formatAddress(t.from)} transferred ${t.valueFormatted || t.value} ${t.symbol} to ${formatAddress(t.to)}.${statusStr}`;
      }
      if (transfers.length > 1) {
        return `${formatAddress(from)} made ${transfers.length} token transfers.${statusStr}`;
      }
      return `Token transfer from ${formatAddress(from)} to ${formatAddress(to)}.${statusStr}`;
    }

    case "approval": {
      if (transfers.length === 0) {
        return `${formatAddress(from)} approved ${formatAddress(to)} to spend tokens.${statusStr}`;
      }
      return `${formatAddress(from)} approved token spending.${statusStr}`;
    }

    case "swap": {
      // Identify the swap by looking at token transfers:
      // the user sends one token and receives another.
      const sent = transfers.filter(t => t.from.toLowerCase() === from.toLowerCase());
      const received = transfers.filter(t => t.to.toLowerCase() === from.toLowerCase());

      if (sent.length >= 1 && received.length >= 1) {
        const s = sent[0];
        const r = received[0];
        return `${formatAddress(from)} swapped ${s.valueFormatted || s.value} ${s.symbol} for ${r.valueFormatted || r.value} ${r.symbol}.${statusStr}`;
      }
      return `Swap via ${formatAddress(to)} with ${transfers.length} token movements.${statusStr}`;
    }

    case "wrap":
      return `${formatAddress(from)} wrapped ${formatValue(value, 18)} ETH to WETH.${statusStr}`;

    case "unwrap":
      return `${formatAddress(from)} unwrapped WETH to ETH.${statusStr}`;

    case "nft_transfer": {
      const nft = transfers.find(t => t.tokenType === "ERC-721" || t.tokenType === "ERC-1155");
      if (nft) {
        return `${formatAddress(nft.from)} transferred ${nft.symbol} NFT to ${formatAddress(nft.to)}.${statusStr}`;
      }
      return `NFT transfer from ${formatAddress(from)}.${statusStr}`;
    }

    case "batch_payment":
      return `Spraay batch payment from ${formatAddress(from)} — ${transfers.length} recipients.${statusStr}`;

    case "admin":
      return `Admin action (${method}) on contract ${formatAddress(to)}.${statusStr}`;

    default:
      if (transfers.length > 0) {
        return `Contract call to ${formatAddress(to)} with ${transfers.length} token transfer(s).${statusStr}`;
      }
      return `Contract call from ${formatAddress(from)} to ${formatAddress(to)}.${statusStr}`;
  }
}

// ============================================
// CACHE (tx data is immutable once confirmed — long TTL)
// ============================================

interface CacheEntry { body: any; expiresAt: number; }
const cache = new Map<string, CacheEntry>();
const TTL = 3_600_000; // 1 hour — confirmed txs don't change

// ============================================
// ROUTE HANDLER
// ============================================

/**
 * GET /api/v1/tx/decode
 *
 * Query params:
 *   hash  (required) — transaction hash (0x…)
 *   chain (optional) — base | ethereum | arbitrum | optimism | polygon (default: base)
 */
export async function txDecodeHandler(req: Request, res: Response) {
  try {
    const hash = String(req.query.hash || "").trim();
    const chain = String(req.query.chain || "base").trim().toLowerCase();

    if (!/^0x[a-fA-F0-9]{64}$/.test(hash)) {
      return res.status(400).json({
        error: "Invalid or missing 'hash' — expected a 66-character tx hash (0x…).",
        example: "/api/v1/tx/decode?hash=0x...&chain=base",
      });
    }

    const baseUrl = BLOCKSCOUT_URLS[chain];
    if (!baseUrl) {
      return res.status(400).json({
        error: `Unsupported chain: ${chain}`,
        supportedChains: Object.keys(BLOCKSCOUT_URLS),
      });
    }

    const cacheKey = `tx:${chain}:${hash.toLowerCase()}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      trackRequest("tx_decode");
      return res.json({ ...hit.body, cached: true });
    }

    // Fetch from Blockscout v2
    const resp = await fetch(`${baseUrl}/transactions/${hash}`);
    if (!resp.ok) {
      if (resp.status === 404) {
        return res.status(404).json({
          error: "Transaction not found.",
          hash,
          chain,
          hint: "Ensure the hash and chain are correct. Pending transactions may not be indexed yet.",
        });
      }
      return res.status(502).json({
        error: "Blockscout upstream error.",
        upstreamStatus: resp.status,
      });
    }

    const tx: any = await resp.json();
    if (tx.errors) {
      return res.status(404).json({ error: "Transaction not found.", hash, chain });
    }

    // Parse
    const rawInput = tx.raw_input || "0x";
    const selector = rawInput.length >= 10 ? rawInput.slice(0, 10).toLowerCase() : null;
    const known = selector ? SELECTORS[selector] || null : null;
    const txType = known?.type || (rawInput === "0x" && tx.value !== "0" ? "native_transfer" : "unknown");

    const fromAddr = tx.from?.hash || "";
    const toAddr = tx.to?.hash || "";
    const transfers = parseTokenTransfers(tx.token_transfers || []);

    const summary = generateSummary(
      txType,
      known?.name || selector,
      fromAddr,
      toAddr,
      tx.value || "0",
      transfers,
      tx.status || "",
    );

    const body = {
      hash,
      chain,
      status: tx.status || null,
      result: tx.result || null,
      blockNumber: tx.block_number || null,
      timestamp: tx.timestamp || null,
      from: fromAddr,
      to: toAddr,
      value: tx.value || "0",
      gasUsed: tx.gas_used || null,
      fee: tx.fee?.value || null,
      decoded: {
        selector: selector || null,
        functionName: known?.name || null,
        type: txType,
        summary,
      },
      tokenTransfers: transfers,
      raw: {
        inputLength: rawInput.length,
        inputPrefix: rawInput.slice(0, 74), // selector + first param
        method: tx.method || selector || null,
        decodedInput: tx.decoded_input || null, // pass through if Blockscout has it
      },
      meta: {
        source: "blockscout-v2",
        decoderVersion: "spraay-tx-v1",
        templatesMatched: !!known,
      },
      cached: false,
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/tx/decode",
      },
      timestamp: new Date().toISOString(),
    };

    cache.set(cacheKey, { body, expiresAt: Date.now() + TTL });

    trackRequest("tx_decode");
    return res.json(body);
  } catch (error: any) {
    console.error("TX decode error:", error?.message);
    return res.status(500).json({
      error: "Failed to decode transaction",
      details: error?.message,
    });
  }
}
