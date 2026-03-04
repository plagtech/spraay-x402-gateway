import { Request, Response } from "express";

// x402 Cron/Scheduler — POST /cron/create ($0.005), GET /cron/list ($0.001), POST /cron/cancel ($0.001)

interface CronJob {
  id: string;
  action: string;
  schedule: string;
  payload: Record<string, any>;
  status: "active" | "paused" | "cancelled" | "completed";
  createdAt: string;
  nextRun?: string;
  lastRun?: string;
  runCount: number;
  maxRuns?: number;
  metadata?: Record<string, any>;
}

const jobs: Map<string, CronJob> = new Map();
function genId(): string { return `cron_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

const VALID_ACTIONS = [
  "batch.execute", "payroll.execute", "swap.execute", "bridge.execute",
  "webhook.trigger", "notify.email", "notify.sms", "xmtp.send",
  "analytics.snapshot", "invoice.remind",
];

export async function cronCreateHandler(req: Request, res: Response) {
  try {
    const { action, schedule, payload, maxRuns, metadata } = req.body;
    if (!action || !schedule || !payload) return res.status(400).json({ error: "Missing required fields: action, schedule, payload" });
    if (!VALID_ACTIONS.includes(action)) return res.status(400).json({ error: `Invalid action: ${action}`, validActions: VALID_ACTIONS });

    // Validate cron expression (basic: 5 parts)
    const parts = schedule.split(" ");
    if (parts.length !== 5) return res.status(400).json({ error: "Invalid cron expression. Use 5-part format: min hour dom mon dow" });

    const id = genId();
    const now = new Date();
    const nextRun = new Date(now.getTime() + 60000).toISOString(); // simplified

    const job: CronJob = {
      id, action, schedule, payload, status: "active",
      createdAt: now.toISOString(), nextRun, runCount: 0,
      maxRuns: maxRuns || undefined, metadata: metadata || {},
    };
    jobs.set(id, job);

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
    let results = Array.from(jobs.values());
    if (status && typeof status === "string") results = results.filter((j) => j.status === status);
    if (action && typeof action === "string") results = results.filter((j) => j.action === action);

    return res.json({
      jobs: results.map((j) => ({
        id: j.id, action: j.action, schedule: j.schedule, status: j.status,
        nextRun: j.nextRun, lastRun: j.lastRun, runCount: j.runCount,
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
    const job = jobs.get(jobId);
    if (!job) return res.status(404).json({ error: "Job not found", jobId });
    if (job.status === "cancelled") return res.status(400).json({ error: "Job already cancelled" });

    job.status = "cancelled";
    return res.json({
      jobId, status: "cancelled", runCount: job.runCount,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to cancel job", details: error.message });
  }
}