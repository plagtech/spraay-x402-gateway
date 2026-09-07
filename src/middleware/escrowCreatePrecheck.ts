/**
 * 💧 Spraay x402 Gateway — Pre-payment validation for POST /api/v1/escrow/create
 * src/middleware/escrowCreatePrecheck.ts
 *
 * THE PROBLEM:
 *   Same class as robots/task (see robotTaskPrecheck.ts): paymentMiddleware
 *   is mounted globally and runs before the route handler, so the $0.10 was
 *   verified and settled first, and only then did escrowCreateHandler reject
 *   the body (missing depositor, bad token, non-positive amount). The caller
 *   paid for an escrow that was never created. At least one published
 *   integration ships a docstring example that omits the required depositor,
 *   so this is not hypothetical.
 *
 * THE FIX:
 *   Run the handler's own normalization + validation ahead of the payment
 *   gate, mounted on this ONE route only (app.post(path, escrowCreatePrecheck)
 *   before the app.use(paymentMiddleware) line). Invalid payloads are
 *   answered with the handler's exact status + body, and paymentMiddleware
 *   never runs, so nothing settles.
 *
 *   One deliberate difference from the robots precheck: a MISSING depositor
 *   is not rejected here, because the handler now defaults it to the verified
 *   payer from the settlement receipt — and at precheck time the payment has
 *   not settled yet, so that identity does not exist. Everything else
 *   (beneficiary, token, amount, address formats) is checked pre-payment.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   Requests with no payment proof are passed straight through untouched, so
 *   the unpaid 402 challenge stays byte-for-byte what it is today. That keeps
 *   x402 discovery working — agents probe this endpoint with an empty or
 *   placeholder body specifically to read the 402 accepts[] block, and they
 *   must not get a 400 instead. Nothing settles on an unpaid request anyway,
 *   so there is no charge to prevent there.
 */

import type { Request, Response, NextFunction } from "express";
import {
  normalizeEscrowCreateBody,
  validateEscrowCreateBody,
} from "../routes/escrow.js";

/**
 * True if the caller is presenting a payment for settlement on any rail:
 * x402 v2 (`payment-signature`), x402 v1 (`x-payment`), Solana
 * (`x-solana-tx`) or MPP (`x-mpp-payment`).
 */
function hasPaymentProof(req: Request): boolean {
  const h = req.headers;
  return Boolean(
    h["payment-signature"] ||
    h["x-payment"] ||
    h["x-solana-tx"] ||
    h["x-mpp-payment"]
  );
}

export async function escrowCreatePrecheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  // No payment on the request → let the 402 challenge happen exactly as before.
  if (!hasPaymentProof(req)) {
    next();
    return;
  }

  try {
    // Same normalization the handler applies (condition → conditions, etc.)
    // so the two can never disagree about what a valid body looks like.
    const body = normalizeEscrowCreateBody(req.body);
    // Depositor may legitimately be absent pre-payment (defaulted to the
    // verified payer in the handler), so it is not required here.
    const check = validateEscrowCreateBody(body, { allowMissingDepositor: true });
    if (!check.ok) {
      console.log(
        `[ESCROW] pre-payment reject ${check.status} for POST /api/v1/escrow/create ` +
        `— payment not settled (${check.body?.error})`
      );
      res.status(check.status).json(check.body);
      return;
    }
  } catch (err: any) {
    // Fail open. This middleware exists to save the caller money, never to
    // become a new way for the paid path to break: if the pre-flight itself
    // errors, defer to paymentMiddleware + the handler as before.
    console.error("[ESCROW] precheck error, deferring to handler:", err?.message);
  }

  next();
}
