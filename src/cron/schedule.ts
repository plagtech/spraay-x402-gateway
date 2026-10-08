/**
 * 💧 Spraay x402 Gateway — cron schedule parsing
 * src/cron/schedule.ts
 *
 * All schedules are standard five-field cron (min hour dom mon dow) in UTC.
 *
 * cron-parser is lenient: it accepts "" (every minute), four fields, six
 * fields (with seconds) and "@daily"-style shortcuts. The exactly-five-fields
 * check below runs BEFORE the parser so none of those get through.
 */

import { CronExpressionParser } from "cron-parser";
import { CRON_MIN_INTERVAL_SECONDS } from "./config.js";

const INTERVAL_SAMPLE = 100;

export type ScheduleCheck = { ok: true; schedule: string } | { ok: false; error: string };

export function validateSchedule(raw: unknown, now: Date = new Date()): ScheduleCheck {
  if (typeof raw !== "string") {
    return { ok: false, error: "schedule must be a string: 5-field cron (min hour dom mon dow), UTC" };
  }
  const fields = raw.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5) {
    return { ok: false, error: "Invalid cron expression. Use exactly 5 fields: min hour dom mon dow (UTC). Shortcuts like @daily are not supported." };
  }
  const schedule = fields.join(" ");

  let times: number[];
  try {
    const expr = CronExpressionParser.parse(schedule, { currentDate: now, tz: "UTC" });
    times = expr.take(INTERVAL_SAMPLE).map((d) => d.toDate().getTime());
  } catch (err: any) {
    return { ok: false, error: `Invalid cron expression: ${err?.message ?? "unparseable"}` };
  }
  if (times.length === 0) {
    return { ok: false, error: "Invalid cron expression: it never fires" };
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] < CRON_MIN_INTERVAL_SECONDS * 1000) {
      return {
        ok: false,
        error: `Schedule fires too often. Minimum interval between runs is ${CRON_MIN_INTERVAL_SECONDS / 3600} hour (${CRON_MIN_INTERVAL_SECONDS} seconds).`,
      };
    }
  }
  return { ok: true, schedule };
}

/** First occurrence strictly after `from`, in UTC. */
export function nextRun(schedule: string, from: Date): Date {
  const expr = CronExpressionParser.parse(schedule, { currentDate: from, tz: "UTC" });
  return expr.next().toDate();
}
