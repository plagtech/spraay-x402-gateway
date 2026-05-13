/**
 * 💧 Spraay x402 Gateway — Solana Bypass Wrapper
 * src/middleware/solanaBypass.ts
 *
 * THE CORE PROBLEM:
 *   @x402/express's paymentMiddleware is a library function. We can't
 *   patch its internals to check req.solanaPaid. It will always demand
 *   an x-payment header with a valid EVM payment proof.
 *
 * THE SOLUTION:
 *   Wrap paymentMiddleware. If the request has already been verified
 *   by solanaPaymentMiddleware (req.solanaPaid === true), skip the
 *   x402 gate entirely. Otherwise, delegate to paymentMiddleware
 *   as normal.
 *
 * USAGE in index.ts:
 *   Replace:
 *     app.use(paymentMiddleware({ ... }, server));
 *   With:
 *     app.use(wrapWithSolanaBypass(paymentMiddleware({ ... }, server)));
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";

/**
 * Wraps an existing Express middleware (paymentMiddleware) to skip it
 * when the request has already been paid via Solana.
 */
export function wrapWithSolanaBypass(
  originalMiddleware: RequestHandler
): RequestHandler {
  return function solanaBypassWrapper(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // If Solana payment was already verified, skip the EVM payment gate
    if ((req as any).solanaPaid === true) {
      console.log(
        `[solana-bypass] Skipping x402 paymentMiddleware for ${req.method} ${req.path} ` +
        `(paid via Solana tx ${((req as any).solanaTxSignature || "").slice(0, 16)}...)`
      );
      next();
      return;
    }

    // Otherwise, run the original paymentMiddleware as normal
    originalMiddleware(req, res, next);
  };
}
