/**
 * 💧 Spraay x402 Gateway — Solana Payment Middleware
 * src/middleware/solanaPaymentMiddleware.ts
 *
 * Express middleware that handles Solana USDC payments as an
 * ALTERNATIVE rail alongside the existing EVM x402 flow.
 *
 * Detection logic:
 *   - If the request has `X-Solana-Tx` header → Solana verification path
 *   - Otherwise → falls through to @x402/express paymentMiddleware unchanged
 *
 * INTEGRATION:
 *   This middleware wraps the EXISTING paymentMiddleware from @x402/express.
 *   Since paymentMiddleware is a library function we can't patch internally,
 *   this middleware intercepts BEFORE it runs. When Solana payment is verified,
 *   we call the route handler directly (bypassing paymentMiddleware's 402 gate).
 *   When there's no Solana header, everything passes through to paymentMiddleware
 *   exactly as before.
 *
 * PLACEMENT in index.ts:
 *   app.use(enrich402Middleware);        // existing — wraps res.json
 *   app.use(protocolDetectorMiddleware); // existing — x402 vs MPP detection
 *   app.use(solanaPaymentMiddleware);    // ← NEW — before paymentMiddleware
 *   app.use(mppMiddleware);             // existing — MPP handling
 *   app.use(apiKeyAuthMiddleware);      // existing — API key bypass
 *   app.use(paymentMiddleware(...));     // existing — EVM x402 gate
 */

import type { Request, Response, NextFunction } from "express";
import { SolanaVerifier, SolanaPaymentConfig } from "../solana/solanaVerifier.js";
import { getEndpointPrice } from "../pricing.js";
import { supabase } from "../middleware/supabase.js";

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
    .then((result) => {
      if (result.verified) {
        // ✅ Solana payment confirmed
        // Mark the request so downstream middleware/handlers know
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
              // Solana-specific fields (add columns if desired)
            })
            .then(({ error }) => {
              if (error) console.error("[solana-pay] Supabase log error:", error.message);
            });
        }

        // Skip paymentMiddleware — the request will continue through
        // mppMiddleware (no-op since X-Solana-Tx != MPP), apiKeyAuthMiddleware,
        // then paymentMiddleware. We need paymentMiddleware to NOT block this.
        //
        // The trick: paymentMiddleware from @x402/express checks for x-payment
        // header. We can't fake that. Instead, we set a flag and use a wrapper
        // approach (see solanaBypassWrapper in index.ts integration).
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

// ----- helpers (mirrors gateway-events.ts patterns) ---------------------- //

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
