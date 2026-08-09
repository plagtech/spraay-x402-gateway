/**
 * 💧 Spraay x402 Gateway — Pre-payment validation for POST /api/v1/robots/task
 * src/middleware/robotTaskPrecheck.ts
 *
 * THE PROBLEM:
 *   paymentMiddleware is mounted globally (index.ts) and therefore runs
 *   *before* any route handler. For POST /api/v1/robots/task that meant the
 *   $0.05 was verified and settled first, and only then did robotTaskHandler
 *   discover the robot did not exist / was offline / could not do the task.
 *   The caller paid for a dispatch that never happened.
 *
 * THE FIX:
 *   Run the handler's own validation ahead of the payment gate, mounted on
 *   this ONE route only (app.post(path, robotTaskPrecheck) before the
 *   app.use(paymentMiddleware) line). Invalid payloads are answered with the
 *   handler's exact status + body, and paymentMiddleware never runs, so
 *   nothing settles.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   Requests with no payment proof are passed straight through untouched, so
 *   the unpaid 402 challenge stays byte-for-byte what it is today. That keeps
 *   x402 discovery working — agents probe this endpoint with an empty or
 *   placeholder body specifically to read the 402 accepts[] block, and they
 *   must not get a 400 instead. Nothing settles on an unpaid request anyway,
 *   so there is no charge to prevent there.
 *
 *   The Solana rail (x-solana-tx) is short-circuited too, which stops a
 *   pointless dispatch, but note that rail is pay-first by design: the client
 *   has already broadcast the transfer on-chain before calling us, so that
 *   payment is not ours to withhold.
 */

import type { Request, Response, NextFunction } from "express";
import { validateRobotTaskPayload } from "../routes/robots.js";

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

export async function robotTaskPrecheck(
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
    const check = await validateRobotTaskPayload(req.body);
    if (!check.ok) {
      console.log(
        `[RTP] pre-payment reject ${check.status} for POST /api/v1/robots/task ` +
        `— payment not settled (${check.body?.error})`
      );
      res.status(check.status).json(check.body);
      return;
    }
  } catch (err: any) {
    // Fail open. This middleware exists to save the caller money, never to
    // become a new way for the paid path to break: if the pre-flight itself
    // errors, defer to paymentMiddleware + the handler as before.
    console.error("[RTP] precheck error, deferring to handler:", err?.message);
  }

  next();
}
