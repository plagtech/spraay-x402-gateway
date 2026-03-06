import { Request, Response } from "express";
import { cronDb } from "../db.js";

const VALID_ACTIONS = [
  "batch.execute", "payroll.execute", "swap.execute", "bridge.execute",
  "webhook.trigger", "notify.email", "notify.sms", "xmtp.send",
  "analytics.snapshot", "invoice.remind",
];

function genId(): string { return `cron_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function cronCreateHandler(req: Request, res: Response) {
  try {
    const { action, schedule, payload, maxRuns, metadata } = req.body;
    if (!action || !schedule || !payload) return res.status(400).json({ error: "Missing required fields: action, schedule, payload" });
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: `Invalid action: ${action}`, validActions: VALID_ACTIONS });

    const parts = schedule.split(" ");
    if (parts.length !== 5) return res.status(400).json({ error: "Invalid cron expression. Use 5-part format: min hour dom mon dow" });

    const id = genId();
    const now = new Date();
    const nextRun = new Date(now.getTime() + 60000).toISOString();

    await cronDb.create({
      id, action, schedule, payload, status: "active",
      createdAt: now.toISOString(), nextRun, runCount: 0,
      maxRuns: maxRuns || null, metadata: metadata || {},
    });

    return res.json({
      id, action, schedule, status: "active", nextRun,
      maxRuns: maxRuns || "unlimited",
      note: "Job scheduled. Production uses Bull/BullMQ with Redis for reliable scheduling.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to create cron job", details: error.message });
  }
}

export async function cronListHandler(req: Request, res: Response) {
  try {
    const { status, action } = req.query;
    const statusFilter = status && typeof status === "string" ? status : null;
    const actionFilter = action && typeof action === "string" ? action : null;
    const results = await cronDb.list(statusFilter, actionFilter);

    return res.json({
      jobs: results.map((j: any) => ({
        id: j.id, action: j.action, schedule: j.schedule, status: j.status,
        nextRun: j.next_run, lastRun: j.last_run, runCount: j.run_count,
      })),
      total: results.length,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to list jobs", details: error.message });
  }
}

export async function cronCancelHandler(req: Request, res: Response) {
  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: "Missing required field: jobId" });
    const job = await cronDb.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found", jobId });
    if (job.status === "cancelled") return res.status(400).json({ error: "Job already cancelled" });

    await cronDb.update(jobId, { status: "cancelled" });
    return res.json({
      jobId, status: "cancelled", runCount: job.run_count,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to cancel job", details: error.message });
  }
}
