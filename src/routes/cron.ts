import { Request, Response } from "express";
import { cronDb, CronJobRow } from "../db.js";
import { GATEWAY_VERSION } from "../lib/version.js";
import { generateWebhookSecret } from "../webhooks/signing.js";
import {
  CRON_EVENT_TYPE,
  CRON_MAX_ACTIVE_JOBS_PER_OWNER,
  CRON_MIN_INTERVAL_SECONDS,
  CRON_RUNS_INCLUDED,
} from "../cron/config.js";
import { resolveCronCaller } from "../cron/identity.js";
import { nextRun } from "../cron/schedule.js";
import {
  callerUnresolvableResponse,
  schedulerDisabledResponse,
  validateCronCreateBody,
} from "../cron/validate.js";

// Scheduler v1 is trigger-only: on each run the gateway POSTs a signed
// `cron.triggered` webhook to callback_url; the caller's agent then calls the
// paid endpoint itself. Jobs are owned by the paying wallet / API key, and
// list + cancel only ever see the caller's own jobs.

function genId(): string { return `cron_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

const gateway = () => ({ provider: "spraay-x402", version: GATEWAY_VERSION });

export async function cronCreateHandler(req: Request, res: Response) {
  try {
    const disabled = schedulerDisabledResponse();
    if (disabled && !disabled.ok) return res.status(disabled.status).json(disabled.body);

    const owner = resolveCronCaller(req);
    if (!owner) {
      const r = callerUnresolvableResponse();
      if (!r.ok) return res.status(r.status).json(r.body);
    }

    const now = new Date();
    const check = await validateCronCreateBody(req.body, now);
    if (!check.ok) return res.status(check.status).json(check.body);
    const input = check.value;

    const active = await cronDb.countActiveByOwner(owner!);
    if (active >= CRON_MAX_ACTIVE_JOBS_PER_OWNER) {
      return res.status(429).json({
        error: `Active job limit reached: ${CRON_MAX_ACTIVE_JOBS_PER_OWNER} per owner. Cancel a job first.`,
        activeJobs: active,
      });
    }

    const id = genId();
    const secret = generateWebhookSecret();
    const next = nextRun(input.schedule, now).toISOString();

    await cronDb.create({
      id, action: input.action, schedule: input.schedule, payload: input.payload,
      nextRun: next, maxRuns: input.maxRuns, metadata: input.metadata,
      owner: owner!, callbackUrl: input.callbackUrl, hmacSecret: secret,
      createdAt: now.toISOString(),
    });

    return res.json({
      id, action: input.action, schedule: input.schedule, status: "active", nextRun: next,
      maxRuns: input.maxRuns,
      timezone: "UTC",
      runsIncluded: CRON_RUNS_INCLUDED,
      minIntervalSeconds: CRON_MIN_INTERVAL_SECONDS,
      callback: {
        url: input.callbackUrl,
        event: CRON_EVENT_TYPE,
        webhook_secret: secret,
        signature_header: "X-Spraay-Signature",
        timestamp_header: "X-Spraay-Timestamp",
      },
      note: "On each run the gateway POSTs a signed cron.triggered webhook to callback.url. " +
        "Verify X-Spraay-Signature (sha256= HMAC-SHA256 of `${X-Spraay-Timestamp}.${body}` with webhook_secret), " +
        "then call the endpoint in data.next_step yourself. Store webhook_secret now: it is not shown again.",
      _gateway: gateway(), timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to create cron job", details: error.message });
  }
}

function publicJob(j: CronJobRow) {
  const maxRuns = j.max_runs ?? CRON_RUNS_INCLUDED;
  return {
    id: j.id, action: j.action, schedule: j.schedule, status: j.status,
    nextRun: j.next_run ?? null, lastRun: j.last_run ?? null, runCount: j.run_count,
    maxRuns, runsRemaining: Math.max(0, maxRuns - j.run_count),
    callbackUrl: j.callback_url ?? null, lastError: j.last_error ?? null,
  };
}

export async function cronListHandler(req: Request, res: Response) {
  try {
    const owner = resolveCronCaller(req);
    if (!owner) {
      const r = callerUnresolvableResponse();
      if (!r.ok) return res.status(r.status).json(r.body);
    }
    const { status, action } = req.query;
    const statusFilter = status && typeof status === "string" ? status : null;
    const actionFilter = action && typeof action === "string" ? action : null;
    const results = await cronDb.listByOwner(owner!, statusFilter, actionFilter);

    return res.json({
      jobs: results.map(publicJob),
      total: results.length,
      timezone: "UTC",
      _gateway: gateway(), timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to list jobs", details: error.message });
  }
}

export async function cronCancelHandler(req: Request, res: Response) {
  try {
    const body = req.body ?? {};
    // `cronId` is accepted because enrich402 advertised it before v1.
    const jobId = body.jobId ?? body.id ?? body.cronId;
    if (!jobId || typeof jobId !== "string") return res.status(400).json({ error: "Missing required field: jobId" });

    const owner = resolveCronCaller(req);
    if (!owner) {
      const r = callerUnresolvableResponse();
      if (!r.ok) return res.status(r.status).json(r.body);
    }

    // Unknown and someone-else's get the same 404, so ids cannot be probed.
    const job = await cronDb.get(jobId);
    if (!job || job.owner !== owner) return res.status(404).json({ error: "Job not found", jobId });
    if (job.status !== "active") {
      return res.status(400).json({ error: `Job is not active (status: ${job.status})`, jobId, status: job.status });
    }

    const cancelled = await cronDb.cancel(jobId, owner!);
    if (!cancelled) {
      // Lost a race with the worker completing it, or a concurrent cancel.
      const current = await cronDb.get(jobId);
      return res.status(400).json({ error: `Job is not active (status: ${current?.status ?? "unknown"})`, jobId, status: current?.status ?? null });
    }
    return res.json({
      jobId, status: "cancelled", runCount: cancelled.run_count,
      _gateway: gateway(), timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to cancel job", details: error.message });
  }
}
