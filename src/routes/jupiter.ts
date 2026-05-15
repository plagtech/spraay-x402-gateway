/**
 * 💧 Spraay Gateway — Solana Jupiter endpoints
 *
 * Category 22: Solana DeFi
 * Upstream: Jupiter v6 API
 *   - With JUPITER_API_KEY:  https://api.jup.ag/swap/v1   (paid tier, higher rate limit)
 *   - Without:               https://quote-api.jup.ag/v6  (public, rate-limited)
 *
 * No custody — gateway never signs, never holds funds.
 * Returns unsigned base64 versioned tx for client to sign and submit.
 *
 * Routes (wired in index.ts):
 *   GET  /api/v1/solana/jupiter/quote      — $0.005  — price + route for a swap
 *   POST /api/v1/solana/jupiter/swap-tx    — $0.01   — unsigned swap transaction
 */

import type { Request, Response } from "express";

const JUPITER_API_KEY = process.env.JUPITER_API_KEY || "";
const JUPITER_BASE = JUPITER_API_KEY
  ? "https://api.jup.ag/swap/v1"
  : "https://quote-api.jup.ag/v6";

function jupiterHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { "Accept": "application/json", ...extra };
  if (JUPITER_API_KEY) h["x-api-key"] = JUPITER_API_KEY;
  return h;
}

// Common SPL mints — accepted as symbols OR raw mints
const TOKEN_ALIASES: Record<string, string> = {
  SOL:   "So11111111111111111111111111111111111111112",
  USDC:  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  USDT:  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  WIF:   "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  BONK:  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  JUP:   "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  PYTH:  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3",
  JTO:   "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
};

function resolveMint(input: string): string {
  if (!input) return input;
  const upper = input.toUpperCase();
  return TOKEN_ALIASES[upper] || input;
}

function isValidMint(s: string): boolean {
  // Solana addresses are base58, 32-44 chars
  return typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
}

interface JupiterQuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<unknown>;
  contextSlot?: number;
  timeTaken?: number;
}

/**
 * GET /api/v1/solana/jupiter/quote
 * Query params:
 *   inputMint   (required) — symbol or mint address
 *   outputMint  (required) — symbol or mint address
 *   amount      (required) — atomic units of inputMint (e.g. "1000000" = 1 USDC)
 *   slippageBps (optional) — default 50 (0.5%)
 */
export async function jupiterQuoteHandler(req: Request, res: Response) {
  try {
    const { inputMint: rawIn, outputMint: rawOut, amount, slippageBps } = req.query;

    if (!rawIn || !rawOut || !amount) {
      return res.status(400).json({
        error: "missing_params",
        message: "Required: inputMint, outputMint, amount",
        example: "?inputMint=USDC&outputMint=SOL&amount=1000000",
      });
    }

    const inputMint = resolveMint(String(rawIn));
    const outputMint = resolveMint(String(rawOut));

    if (!isValidMint(inputMint)) {
      return res.status(400).json({ error: "invalid_input_mint", value: rawIn });
    }
    if (!isValidMint(outputMint)) {
      return res.status(400).json({ error: "invalid_output_mint", value: rawOut });
    }
    if (!/^\d+$/.test(String(amount))) {
      return res.status(400).json({ error: "invalid_amount", message: "amount must be atomic units (integer string)" });
    }

    const slippage = slippageBps ? Number(slippageBps) : 50;
    if (Number.isNaN(slippage) || slippage < 0 || slippage > 10000) {
      return res.status(400).json({ error: "invalid_slippage", message: "slippageBps must be 0-10000" });
    }

    const url = new URL(`${JUPITER_BASE}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amount));
    url.searchParams.set("slippageBps", String(slippage));
    url.searchParams.set("onlyDirectRoutes", "false");
    url.searchParams.set("asLegacyTransaction", "false");

    const upstream = await fetch(url.toString(), {
      headers: jupiterHeaders(),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(502).json({
        error: "upstream_error",
        source: "jupiter",
        status: upstream.status,
        detail: body.slice(0, 500),
      });
    }

    const data = (await upstream.json()) as JupiterQuoteResponse;

    return res.json({
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      otherAmountThreshold: data.otherAmountThreshold,
      priceImpactPct: data.priceImpactPct,
      slippageBps: data.slippageBps,
      swapMode: data.swapMode,
      routeHops: Array.isArray(data.routePlan) ? data.routePlan.length : 0,
      raw: data, // full route plan for clients that want it
      source: "jupiter-v6",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    return res.status(500).json({ error: "internal_error", message: msg });
  }
}

/**
 * POST /api/v1/solana/jupiter/swap-tx
 * Body:
 *   quoteResponse  (required) — the full quote object from /quote
 *   userPublicKey  (required) — payer/signer base58 pubkey
 *   wrapAndUnwrapSol (optional, default true)
 *   prioritizationFeeLamports (optional) — "auto" or integer
 *
 * Returns: { swapTransaction: base64, lastValidBlockHeight, prioritizationFeeLamports }
 *
 * The client signs `swapTransaction` (VersionedTransaction) and submits via their RPC.
 * Gateway never holds the key, never signs.
 */
export async function jupiterSwapTxHandler(req: Request, res: Response) {
  try {
    const {
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol = true,
      prioritizationFeeLamports = "auto",
    } = req.body ?? {};

    if (!quoteResponse || typeof quoteResponse !== "object") {
      return res.status(400).json({
        error: "missing_quote",
        message: "Pass the full quoteResponse object returned by /quote",
      });
    }
    if (!userPublicKey || !isValidMint(userPublicKey)) {
      return res.status(400).json({
        error: "invalid_user_public_key",
        message: "userPublicKey must be a base58 Solana address",
      });
    }

    const upstream = await fetch(`${JUPITER_BASE}/swap`, {
      method: "POST",
      headers: jupiterHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        quoteResponse,
        userPublicKey,
        wrapAndUnwrapSol,
        prioritizationFeeLamports,
        dynamicComputeUnitLimit: true,
      }),
    });

    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(502).json({
        error: "upstream_error",
        source: "jupiter",
        status: upstream.status,
        detail: body.slice(0, 500),
      });
    }

    const data = await upstream.json() as {
      swapTransaction: string;
      lastValidBlockHeight?: number;
      prioritizationFeeLamports?: number;
    };

    return res.json({
      swapTransaction: data.swapTransaction,
      lastValidBlockHeight: data.lastValidBlockHeight,
      prioritizationFeeLamports: data.prioritizationFeeLamports,
      instructions: "Deserialize as VersionedTransaction, sign with userPublicKey, submit via Solana RPC.",
      source: "jupiter-v6",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown_error";
    return res.status(500).json({ error: "internal_error", message: msg });
  }
}
