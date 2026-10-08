/**
 * 💧 Spraay x402 Gateway — Pre-payment validation for POST /api/v1/cron/create
 * src/middleware/cronCreatePrecheck.ts
 *
 * Same pattern as escrowCreatePrecheck.ts: mounted on this ONE route ahead
 * of the global paymentMiddleware. With payment proof present, it answers
 * with the handler's exact status + body when the request cannot succeed,
 * so paymentMiddleware never runs and nothing settles:
 *
 *   503 scheduler_not_enabled  — CRON_WORKER_ENABLED is not "true"
 *   400                        — the payment rail cannot establish a job owner
 *   400                        — the shared body validation failed
 *
 * Deploying with the worker off therefore makes paid cron/create return 503
 * before settlement, so nobody pays for a job that would never run.
 *
 * Requests with NO payment proof pass straight through, so the unpaid 402
 * challenge (and x402 discovery) is untouched. Fails open on internal error.
 *
 * Note: the Solana pay-first rail (X-Solana-Tx) is verified and consumed by
 * solanaPaymentMiddleware before this runs; that transfer is already on-chain
 * and is not ours to withhold (see robotTaskPrecheck.ts).
 */

import type { Request, Response, NextFunction } from "express";
import { cronCallerResolvable } from "../cron/identity.js";
import {
  callerUnresolvableResponse,
  schedulerDisabledResponse,
  validateCronCreateBody,
} from "../cron/validate.js";

function hasPaymentProof(req: Request): boolean {
  const h = req.headers;
  return Boolean(
    h["payment-signature"] ||
    h["x-payment"] ||
    h["x-solana-tx"] ||
    h["x-mpp-payment"]
  );
}

export async function cronCreatePrecheck(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!hasPaymentProof(req)) {
    next();
    return;
  }

  try {
    const check =
      schedulerDisabledResponse() ??
      (cronCallerResolvable(req) ? await validateCronCreateBody(req.body) : callerUnresolvableResponse());
    if (!check.ok) {
      console.log(
        `[CRON] pre-payment reject ${check.status} for POST /api/v1/cron/create ` +
        `— payment not settled (${check.body?.error})`
      );
      res.status(check.status).json(check.body);
      return;
    }
  } catch (err: any) {
    // Fail open: never let the pre-flight become a new way for the paid path to break.
    console.error("[CRON] precheck error, deferring to handler:", err?.message);
  }

  next();
}
