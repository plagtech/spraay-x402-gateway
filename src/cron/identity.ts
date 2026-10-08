/**
 * 💧 Spraay x402 Gateway — who is calling a cron route
 * src/cron/identity.ts
 *
 * Cron jobs are owned by the caller that created them. The owner string is
 * stored on the row and used to scope list/cancel; it is never returned.
 *
 * Order matters:
 *   1. API key. apiKeyAuth.ts suppresses the 402 for a valid key, so a key
 *      holder could attach a forged payment header and still reach the
 *      handler. With a key, payment headers are ignored entirely.
 *   2. Solana pay-first (X-Solana-Tx): sender verified on-chain by
 *      solanaPaymentMiddleware.
 *   3. EVM x402 (Base USDC, Robinhood USDG): payload.authorization.from.
 *      Trustworthy in the handler only because paymentMiddleware has
 *      verified the signature by then (same reasoning as escrow.ts).
 *
 * x402 exact-SVM via the facilitator carries no `from`, and MPP is broken
 * (docs/FOLLOWUPS.md), so neither can own a job.
 */

import type { Request } from "express";
import { isAddress } from "ethers";

export const CRON_IDENTITY_RAILS =
  "Base USDC (x402), Robinhood Chain USDG (x402), Solana pay-first (X-Solana-Tx header), or an API key";

function evmPayerFromHeader(req: Request): string | null {
  const raw = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    const from = decoded?.payload?.authorization?.from ?? decoded?.authorization?.from;
    if (typeof from === "string" && isAddress(from)) return from;
  } catch {
    /* not a decodable EVM payment header */
  }
  return null;
}

export function resolveCronCaller(req: Request): string | null {
  const r = req as any;
  if (r.apiKeyAuth === true) {
    return typeof r.apiKeyEmail === "string" && r.apiKeyEmail
      ? "key:" + r.apiKeyEmail.toLowerCase()
      : null;
  }
  if (r.solanaPaid === true && typeof r.solanaSender === "string" && r.solanaSender) {
    return "sol:" + r.solanaSender;
  }
  const evm = evmPayerFromHeader(req);
  return evm ? "evm:" + evm.toLowerCase() : null;
}

/**
 * For the precheck, which runs before the payment is verified: can this
 * request's rail establish an owner at all? Not an identity check.
 */
export function cronCallerResolvable(req: Request): boolean {
  const r = req as any;
  if (r.apiKeyAuth === true) return true;
  if (r.solanaPaid === true && r.solanaSender) return true;
  return evmPayerFromHeader(req) !== null;
}
