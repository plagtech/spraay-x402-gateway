/**
 * 💧 Spraay x402 Gateway — cron scheduler v1 constants
 * src/cron/config.ts
 *
 * v1 is trigger-only: a due job sends a signed `cron.triggered` webhook to
 * the job's callback_url, and the customer's agent calls batch/payroll
 * itself (and pays for that call as usual). The gateway signs nothing and
 * moves no money on a firing.
 */

export const CRON_ALLOWED_ACTIONS = ["batch.execute", "payroll.execute", "webhook.trigger"] as const;
export type CronAction = (typeof CRON_ALLOWED_ACTIONS)[number];

/** Runs covered by the one-off cron/create price. Also the maxRuns ceiling. */
export const CRON_RUNS_INCLUDED = 100;
/** Minimum gap between any two consecutive firings. */
export const CRON_MIN_INTERVAL_SECONDS = 3600;
export const CRON_MAX_ACTIVE_JOBS_PER_OWNER = 25;
export const CRON_MAX_PAYLOAD_BYTES = 16384;
export const CRON_TICK_MS = 60_000;
export const CRON_TICK_BATCH = 50;
/** A job more than this late is recorded as missed instead of fired. */
export const CRON_MISSED_GRACE_MS = 15 * 60_000;

export const CRON_EVENT_TYPE = "cron.triggered";

/**
 * The worker is OFF unless CRON_WORKER_ENABLED=true. While it is off, paid
 * cron/create is refused with 503 before settlement (see
 * cronCreatePrecheck.ts), so nobody pays for a job that would never run.
 */
export function cronWorkerEnabled(): boolean {
  return process.env.CRON_WORKER_ENABLED === "true";
}
