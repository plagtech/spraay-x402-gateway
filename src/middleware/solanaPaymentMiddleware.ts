/**
 * 💧 Spraay x402 Gateway — Solana Payment Middleware
 * src/middleware/solanaPaymentMiddleware.ts
 */

import type { Request, Response, NextFunction } from "express";
import { SolanaVerifier, SolanaPaymentConfig } from "../solana/solanaVerifier.js";
import { getEndpointPrice } from "../config/pricing.js";
import { supabase } from "./supabase.js";

// ----- config ------------------------------------------------------------ //

const SOLANA_ENABLED = process.env.SOLANA_PAYMENTS_ENABLED === "true";
const SOLANA_RECEIVE_ADDRESS = process.env.SOLANA_RECEIVE_ADDRESS || "";

const solanaConfig: SolanaPaymentConfig = {
  receiveAddress: SOLANA_RECEIVE_ADDRESS,
  rpcUrl: process.env.SOLANA_RPC_URL,
  minConfirmations: parseInt(process.env.SOLANA_MIN_CONFIRMATIONS || "1", 10),
  maxTxAgeSeconds: parseInt(process.env.SOLANA_MAX_TX_AGE || "300", 10),
};

let verifier: SolanaVerifier | null = null;

function getVerifier(): SolanaVerifier {
  if (!verifier) {
    verifier = new SolanaVerifier(solanaConfig);
  }
  return verifier;
}

// ----- single-use guard --------------------------------------------------- //
//
// A Solana transfer signature is public the moment it lands on-chain, and the
// verifier only proves the transfer happened recently. Without this guard the
// same signature unlocks every request it is replayed on for maxTxAgeSeconds.
//
// The guard is one INSERT into a table whose primary key is the signature. The
// database decides atomically: the first request wins, every later (or
// parallel) request gets a unique violation. There is deliberately no
// "select, then insert" — that would let concurrent replays through.
//
// Fail closed: if the store is unreachable or not configured, the payment is
// NOT accepted. Nothing is consumed in that case, so the client can retry the
// same signature inside the age window.

const USED_SIGNATURES_TABLE = "solana_used_signatures";
const PG_UNIQUE_VIOLATION = "23505";

type ClaimResult = "claimed" | "already_used" | "unavailable";

async function claimSignature(row: {
  signature: string;
  method: string;
  path: string;
  payer_address: string | null;
  amount_usdc: number | null;
}): Promise<ClaimResult> {
  if (!supabase) return "unavailable";
  try {
    const { error } = await supabase.from(USED_SIGNATURES_TABLE).insert(row);
    if (!error) return "claimed";
    if (error.code === PG_UNIQUE_VIOLATION) return "already_used";
    console.error("[solana-pay] Signature store error:", error.code, error.message);
    return "unavailable";
  } catch (err: any) {
    console.error("[solana-pay] Signature store unreachable:", err?.message);
    return "unavailable";
  }
}

// ----- middleware --------------------------------------------------------- //

export function solanaPaymentMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Gate: feature flag off
  if (!SOLANA_ENABLED) {
    next();
    return;
  }

  // Gate: no receive address configured
  if (!SOLANA_RECEIVE_ADDRESS) {
    next();
    return;
  }

  // Gate: no Solana tx header → not a Solana payment, fall through to EVM x402
  const txSignature = req.headers["x-solana-tx"] as string | undefined;
  if (!txSignature) {
    next();
    return;
  }

  // Determine required amount from centralized pricing.ts
  const endpointPrice = getEndpointPrice(req.method, req.path);
  if (!endpointPrice) {
    // Route has no price → free endpoint, skip payment verification
    next();
    return;
  }

  const requiredAmount = parseFloat(endpointPrice.price);

  // Run async verification
  const sv = getVerifier();
  sv.verifyPayment(txSignature, requiredAmount)
    .then(async (result) => {
      if (result.verified) {
        // Single use: claim the signature before the request is treated as paid.
        const claim = await claimSignature({
          signature: result.signature || txSignature,
          method: req.method,
          path: req.path,
          payer_address: result.sender,
          amount_usdc: result.amount,
        });

        if (claim === "already_used") {
          console.warn(`[solana-pay] ❌ ${req.method} ${req.path}: signature already used`);
          res.status(402).json({
            error: "Solana payment verification failed",
            detail: "Transaction signature already used — each payment covers one request",
            chain: "solana",
            required_amount: endpointPrice.price,
            receive_address: SOLANA_RECEIVE_ADDRESS,
            usdc_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          });
          return;
        }

        if (claim === "unavailable") {
          res.status(503).json({
            error: "Solana payment rail temporarily unavailable",
            detail: "Payment could not be recorded, so it was not consumed. Retry with the same signature.",
            chain: "solana",
          });
          return;
        }

        // ✅ Solana payment confirmed
        (req as any).solanaPaid = true;
        (req as any).solanaTxSignature = txSignature;
        (req as any).solanaSender = result.sender;
        (req as any).solanaAmount = result.amount;

        console.log(
          `[solana-pay] ✅ Verified ${result.amount} USDC from ${result.sender} ` +
          `for ${req.method} ${req.path} (slot ${result.slot})`
        );

        // Log to Supabase (fire-and-forget, matches gateway-events.ts pattern)
        if (supabase) {
          const sourceIp = extractSourceIp(req);
          supabase
            .from("gateway_events")
            .insert({
              event_type: "payment" as const,
              path: req.path,
              method: req.method,
              http_status: 200,
              category: endpointPrice.category,
              chain: "solana",
              endpoint_name: inferEndpointName(req.path),
              payer_address: result.sender,
              tx_hash: txSignature,
              source_ip: sourceIp,
              payment_attempted: true,
            })
            .then(({ error }) => {
              if (error) console.error("[solana-pay] Supabase log error:", error.message);
            });
        }

        next();
      } else {
        // ❌ Verification failed — return 402 with Solana error detail
        console.warn(`[solana-pay] ❌ ${req.method} ${req.path}: ${result.error}`);
        res.status(402).json({
          error: "Solana payment verification failed",
          detail: result.error,
          chain: "solana",
          required_amount: endpointPrice.price,
          receive_address: SOLANA_RECEIVE_ADDRESS,
          usdc_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        });
      }
    })
    .catch((err) => {
      console.error("[solana-pay] Middleware error:", err.message);
      // Don't block — fall through to EVM path
      next();
    });
}

// ----- helpers ----------------------------------------------------------- //

function extractSourceIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return fwd[0].split(",")[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp;
  }
  return req.ip || null;
}

function inferEndpointName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || path;
  return last.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
