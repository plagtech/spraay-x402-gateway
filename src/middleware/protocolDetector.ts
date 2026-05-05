/**
 * Spraay Gateway — Protocol Detector Middleware
 * 
 * Sits ABOVE both x402 and MPP middleware.
 * Inspects incoming request headers to determine which payment protocol
 * the agent is using, then tags the request so downstream middleware
 * knows whether to handle or skip.
 * 
 * Header detection:
 *   - MPP:  "Authorization: Payment ..." (RFC Payment scheme)
 *   - L402: "Authorization: L402 <macaroon>:<preimage>"
 *   - x402: "X-PAYMENT" header (EVM signature blob)
 *   - none: No payment credential — will trigger a 402 from whichever
 *           middleware handles it first
 * 
 * This middleware NEVER blocks or returns a response — it only tags req.
 */

import { Request, Response, NextFunction } from "express";

export type PaymentProtocol = "x402" | "mpp" | "l402" | "none";

// Extend Express Request to carry protocol tag
declare global {
  namespace Express {
    interface Request {
      paymentProtocol?: PaymentProtocol;
      /** Set by MPP middleware after successful payment verification */
      mppReceipt?: unknown;
    }
  }
}

/**
 * Detect which payment protocol the agent is speaking.
 */
export function detectProtocol(req: Request): PaymentProtocol {
  // MPP: Authorization header with "Payment" scheme
  // Format: "Payment <base64-credential>"
  const authHeader = req.headers["authorization"] || "";
  if (typeof authHeader === "string" && authHeader.startsWith("Payment ")) {
    return "mpp";
  }

  // L402: Authorization header with "L402" scheme
  // Format: "L402 <macaroon>:<preimage>"
  if (typeof authHeader === "string" && authHeader.startsWith("L402 ")) {
    return "l402";
  }

  // x402: X-PAYMENT header (used by @x402/express)
  if (req.headers["x-payment"]) {
    return "x402";
  }

  // No payment credential detected
  return "none";
}

/**
 * Express middleware — tags req.paymentProtocol for downstream use.
 * Must be mounted BEFORE both x402 paymentMiddleware and mppMiddleware.
 */
export function protocolDetectorMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  req.paymentProtocol = detectProtocol(req);
  next();
}
