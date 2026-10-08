/**
 * 💧 Spraay x402 Gateway — cron/create body validation
 * src/cron/validate.ts
 *
 * One function shared by cronCreatePrecheck (before payment) and
 * cronCreateHandler (after payment), so the two can never disagree about
 * what a valid body is.
 *
 * Payload checks are deliberately light: they only stop a job from being
 * scheduled that would fail on every run. The real batch/payroll endpoint
 * stays authoritative when the customer's agent calls it.
 */

import { isAddress } from "ethers";
import { validateOutboundURL } from "../lib/ssrf-guard.js";
import {
  CRON_ALLOWED_ACTIONS,
  CRON_MAX_PAYLOAD_BYTES,
  CRON_RUNS_INCLUDED,
  CronAction,
  cronWorkerEnabled,
} from "./config.js";
import { validateSchedule } from "./schedule.js";
import { CRON_IDENTITY_RAILS } from "./identity.js";

export interface CronCreateInput {
  action: CronAction;
  schedule: string;
  payload: Record<string, unknown>;
  callbackUrl: string;
  maxRuns: number;
  metadata: Record<string, unknown>;
}

export type CronCheck =
  | { ok: true; value: CronCreateInput }
  | { ok: false; status: number; body: Record<string, unknown> };

const MAX_BATCH_ITEMS = 200;

const fail = (status: number, body: Record<string, unknown>): CronCheck => ({ ok: false, status, body });
const bad = (error: string, extra: Record<string, unknown> = {}) => fail(400, { error, ...extra });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function schedulerDisabledResponse(): CronCheck | null {
  if (cronWorkerEnabled()) return null;
  return fail(503, {
    error: "scheduler_not_enabled",
    message: "The cron scheduler is not enabled on this gateway yet. No payment was taken.",
  });
}

export function callerUnresolvableResponse(): CronCheck {
  return bad("Cannot identify the job owner from this payment method", {
    hint: `cron jobs are owned by the paying wallet or API key. Pay with ${CRON_IDENTITY_RAILS}.`,
  });
}

function checkPayloadShape(action: CronAction, payload: Record<string, unknown>): string | null {
  if (action === "batch.execute") {
    const { recipients, amounts } = payload as any;
    if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > MAX_BATCH_ITEMS) {
      return `payload.recipients must be an array of 1 to ${MAX_BATCH_ITEMS} items for batch.execute`;
    }
    if (typeof recipients[0] === "string" && (!Array.isArray(amounts) || amounts.length !== recipients.length)) {
      return "payload.amounts must be an array the same length as payload.recipients when recipients are address strings";
    }
    return null;
  }
  if (action === "payroll.execute") {
    const { employees } = payload as any;
    if (!Array.isArray(employees) || employees.length < 1 || employees.length > MAX_BATCH_ITEMS) {
      return `payload.employees must be an array of 1 to ${MAX_BATCH_ITEMS} items for payroll.execute`;
    }
    for (let i = 0; i < employees.length; i++) {
      const e = employees[i];
      if (!isPlainObject(e) || typeof e.address !== "string" || !isAddress(e.address)) {
        return `payload.employees[${i}].address must be a valid EVM address`;
      }
      const amt = typeof e.amount === "number" || typeof e.amount === "string" ? Number(e.amount) : NaN;
      if (!Number.isFinite(amt) || amt <= 0) {
        return `payload.employees[${i}].amount must be a positive number`;
      }
    }
    return null;
  }
  return null; // webhook.trigger: any object
}

/**
 * Field validation only. The scheduler-enabled and caller checks are
 * separate (they come first, in that order), and the per-owner cap needs
 * the verified owner, so it lives in the handler.
 */
export async function validateCronCreateBody(raw: unknown, now: Date = new Date()): Promise<CronCheck> {
  const body = isPlainObject(raw) ? raw : {};
  const { action, schedule, payload, callback_url, maxRuns, metadata } = body as any;

  if (!action || !schedule || payload === undefined || !callback_url) {
    return bad("Missing required fields: action, schedule, payload, callback_url");
  }
  if (!(CRON_ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    return bad(`Invalid action: ${action}`, { validActions: [...CRON_ALLOWED_ACTIONS] });
  }

  const sched = validateSchedule(schedule, now);
  if (!sched.ok) return bad(sched.error, { timezone: "UTC" });

  if (!isPlainObject(payload)) return bad("payload must be a JSON object");
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
  if (payloadBytes > CRON_MAX_PAYLOAD_BYTES) {
    return bad(`payload too large: ${payloadBytes} bytes. Maximum is ${CRON_MAX_PAYLOAD_BYTES}.`);
  }
  const shapeError = checkPayloadShape(action, payload);
  if (shapeError) return bad(shapeError);

  let runs = CRON_RUNS_INCLUDED;
  if (maxRuns !== undefined && maxRuns !== null) {
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > CRON_RUNS_INCLUDED) {
      return bad(`maxRuns must be an integer from 1 to ${CRON_RUNS_INCLUDED}`);
    }
    runs = maxRuns;
  }
  if (metadata !== undefined && metadata !== null && !isPlainObject(metadata)) {
    return bad("metadata must be a JSON object");
  }

  if (typeof callback_url !== "string") return bad("callback_url must be a string");
  let parsed: URL;
  try { parsed = new URL(callback_url); } catch { return bad("callback_url is not a valid URL"); }
  if (parsed.protocol !== "https:") return bad("callback_url must use https");
  const ssrf = await validateOutboundURL(callback_url);
  if (!ssrf.safe) return bad(`callback_url rejected: ${ssrf.error ?? "unsafe destination"}`);

  return {
    ok: true,
    value: {
      action,
      schedule: sched.schedule,
      payload,
      callbackUrl: callback_url,
      maxRuns: runs,
      metadata: isPlainObject(metadata) ? metadata : {},
    },
  };
}
