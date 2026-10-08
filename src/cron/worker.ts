/**
 * 💧 Spraay x402 Gateway — cron worker (v1, trigger-only)
 * src/cron/worker.ts
 *
 * Every CRON_TICK_MS: fetch due jobs, claim each with an optimistic
 * conditional update, then queue ONE signed `cron.triggered` webhook through
 * the existing webhook pipeline (which delivers, signs and retries). The
 * worker touches cron_jobs / cron_runs only through cronDb, and
 * webhook_events only through webhookService.queueSignedEvent.
 *
 * At-most-once on purpose: if the process dies between the claim and the
 * queue insert, that firing is lost and the job continues on schedule. For
 * payment triggers a lost reminder is safer than a duplicate.
 *
 * Skeleton follows src/webhooks/worker.ts. Off unless CRON_WORKER_ENABLED=true.
 */

import { cronDb, CronJobRow } from "../db.js";
import type { WebhookService } from "../webhooks/index.js";
import { validateOutboundURL } from "../lib/ssrf-guard.js";
import { getEndpointPrice } from "../config/pricing.js";
import {
  CRON_EVENT_TYPE,
  CRON_MISSED_GRACE_MS,
  CRON_RUNS_INCLUDED,
  CRON_TICK_BATCH,
  CRON_TICK_MS,
} from "./config.js";
import { nextRun } from "./schedule.js";

export interface CronWorkerDeps {
  webhookService: Pick<WebhookService, "queueSignedEvent">;
}

export interface CronWorkerHandle {
  stop: () => void;
  isRunning: () => boolean;
}

const NEXT_STEP_PATHS: Record<string, string> = {
  "batch.execute": "/api/v1/batch/execute",
  "payroll.execute": "/api/v1/payroll/execute",
};

function nextStep(action: string) {
  const path = NEXT_STEP_PATHS[action];
  if (!path) return null;
  return { method: "POST", path, price_usd: getEndpointPrice("POST", path)?.price ?? null };
}

async function recordRunSafe(row: Parameters<typeof cronDb.recordRun>[0]): Promise<void> {
  try {
    await cronDb.recordRun(row);
  } catch (err: any) {
    console.error(`[cron] failed to record ${row.status} run for ${row.job_id}:`, err?.message);
  }
}

async function processJob(deps: CronWorkerDeps, job: CronJobRow, now: Date): Promise<void> {
  const scheduledFor = new Date(job.next_run!);
  const base = now.getTime() > scheduledFor.getTime() ? now : scheduledFor;
  const next = nextRun(job.schedule, base).toISOString();
  const newSeq = job.claim_seq + 1;
  const nowIso = now.toISOString();

  // Missed: too late to be useful. Skip it without using up a run.
  if (now.getTime() - scheduledFor.getTime() > CRON_MISSED_GRACE_MS) {
    const claimed = await cronDb.claim(job, {
      claim_seq: newSeq, missed_count: (job.missed_count ?? 0) + 1, next_run: next,
    });
    if (!claimed) return;
    await recordRunSafe({
      job_id: job.id, claim_seq: newSeq, run_number: null,
      scheduled_for: scheduledFor.toISOString(), fired_at: nowIso, status: "missed",
    });
    console.log(`[cron] ${job.id} missed run scheduled for ${scheduledFor.toISOString()}; next ${next}`);
    return;
  }

  // Re-check the destination before claiming, so a blocked firing never uses
  // up one of the job's runs. Two outcomes, both recorded as `blocked`:
  //   - DNS lookup failed: transient. Skip this firing, job stays active.
  //   - blocked hostname / private or reserved address: suspend the job.
  const callbackUrl = job.callback_url!;
  const ssrf = await validateOutboundURL(callbackUrl);
  if (!ssrf.safe) {
    const transient = (ssrf.error ?? "").startsWith("DNS resolution failed");
    const reason = `callback_url blocked at fire time: ${ssrf.error ?? "unsafe destination"}`;
    const claimed = await cronDb.claim(job, transient
      ? { claim_seq: newSeq, next_run: next, last_error: reason.slice(0, 2000) }
      : { claim_seq: newSeq, status: "suspended", last_error: reason.slice(0, 2000) });
    if (!claimed) return;
    await recordRunSafe({
      job_id: job.id, claim_seq: newSeq, run_number: null,
      scheduled_for: scheduledFor.toISOString(), fired_at: nowIso, status: "blocked", error: reason,
    });
    if (transient) console.warn(`[cron] ${job.id} skipped (DNS failure), stays active; next ${next}`);
    else console.warn(`[cron] ${job.id} suspended: ${reason}`);
    return;
  }

  const maxRuns = job.max_runs ?? CRON_RUNS_INCLUDED;
  const runNumber = job.run_count + 1;
  const patch: Record<string, any> = {
    claim_seq: newSeq, run_count: runNumber, last_run: nowIso, next_run: next, last_error: null,
  };
  if (runNumber >= maxRuns) patch.status = "completed";

  const claimed = await cronDb.claim(job, patch);
  if (!claimed) return; // another worker or a cancel got there first

  let eventId: string;
  try {
    eventId = await deps.webhookService.queueSignedEvent({
      eventType: CRON_EVENT_TYPE,
      callbackUrl,
      hmacSecret: job.hmac_secret!,
      payload: {
        job_id: job.id,
        action: job.action,
        run_number: runNumber,
        runs_remaining: Math.max(0, maxRuns - runNumber),
        scheduled_for: scheduledFor.toISOString(),
        fired_at: nowIso,
        payload: job.payload,
        next_step: nextStep(job.action),
      },
      sourceEndpoint: "cron:" + job.id,
      requestId: job.id + ":" + newSeq,
      maxAttempts: 3,
    });
  } catch (err: any) {
    await recordRunSafe({
      job_id: job.id, claim_seq: newSeq, run_number: runNumber,
      scheduled_for: scheduledFor.toISOString(), fired_at: nowIso, status: "queue_failed",
      error: err?.message ?? String(err),
    });
    console.error(`[cron] ${job.id} run ${runNumber} queue failed:`, err?.message);
    return;
  }

  await recordRunSafe({
    job_id: job.id, claim_seq: newSeq, run_number: runNumber,
    scheduled_for: scheduledFor.toISOString(), fired_at: nowIso, status: "queued",
    webhook_event_id: eventId,
  });
  console.log(`[cron] ${job.id} run ${runNumber}/${maxRuns} queued (event ${eventId})`);
}

/** One pass over due jobs. Exported so tests can drive it with a fixed clock. */
export async function runCronTick(deps: CronWorkerDeps, now: Date = new Date()): Promise<void> {
  const due = await cronDb.fetchDue(now.toISOString(), CRON_TICK_BATCH);
  for (const job of due) {
    try {
      await processJob(deps, job, now);
    } catch (err: any) {
      console.error(`[cron] job ${job.id} tick error:`, err?.message);
    }
  }
}

export function startCronWorker(deps: CronWorkerDeps, tickMs: number = CRON_TICK_MS): CronWorkerHandle {
  let running = true;
  let processing = false;

  console.log(`[cron] 💧 Worker started (tick: ${tickMs}ms, batch: ${CRON_TICK_BATCH})`);

  const intervalId = setInterval(async () => {
    if (processing) return; // previous tick still running
    processing = true;
    try {
      await runCronTick(deps, new Date());
    } catch (err) {
      console.error("[cron] Worker tick error:", err);
    } finally {
      processing = false;
    }
  }, tickMs);

  return {
    stop: () => {
      if (running) {
        clearInterval(intervalId);
        running = false;
        console.log("[cron] Worker stopped");
      }
    },
    isRunning: () => running,
  };
}
