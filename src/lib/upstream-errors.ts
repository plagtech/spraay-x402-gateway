// ============================================
// UPSTREAM AI PROVIDER FAILURES → GATEWAY STATUS
// src/lib/upstream-errors.ts
// ============================================
//
// 402 is reserved for x402 "payment required". When an upstream provider
// answers 402 (OpenRouter "Insufficient credits"), 404 (model gone) or 5xx,
// that is a gateway-side outage — the caller already paid correctly — so it
// must never reach the caller as 402, where a client would read it as a fresh
// payment challenge.
//
// Every status returned here is >= 400, so @x402/express cancels settlement
// (node_modules/@x402/express/dist/cjs/index.js: `if (res.statusCode >= 400)`)
// and the caller is not charged.

import type { Response } from "express";

// Grep-able marker for Railway logs. Emitted at error level whenever a
// provider rejects a paid request because the gateway's own account is out of
// credit. There is no alerting path in the gateway yet — see docs/FOLLOWUPS.md.
export const UPSTREAM_CREDITS_MARKER = "[SPRAAY_UPSTREAM_CREDITS_EXHAUSTED]";

/**
 * Gateway status for an upstream provider failure, or null when the upstream
 * status is not a provider failure and keeps its existing handling.
 *   402 (credits exhausted), 401 (the gateway's provider key rejected), 503 → 503
 *   404 (model not found), other 5xx → 502
 * An upstream 401 is about the gateway's key, never the caller's credentials,
 * so it must not reach the caller as 401 either.
 */
export function upstreamFailureStatus(upstreamStatus: number): 502 | 503 | null {
  if (upstreamStatus === 402 || upstreamStatus === 401 || upstreamStatus === 503) return 503;
  if (upstreamStatus === 404 || upstreamStatus >= 500) return 502;
  return null;
}

/**
 * Tags the response as an upstream-provider error so enrich402Middleware never
 * dresses it up as an x402 payment challenge.
 */
export function markUpstreamError(res: Response): void {
  res.locals.upstreamError = true;
}

/** Logs the credits marker when the gateway's provider account is out of credit. */
export function logCreditsExhausted(provider: string, detail: unknown): void {
  console.error(
    `${UPSTREAM_CREDITS_MARKER} ${provider} rejected a paid request: the gateway's provider account is out of credit. Top it up.`,
    detail
  );
}
