import { Request, Response } from "express";

// x402 Audit Trail — POST /audit/log ($0.001), GET /audit/query ($0.005)

interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  resource: string;
  details: Record<string, any>;
  txHash?: string;
  ip?: string;
  timestamp: string;
}

const auditLog: AuditEntry[] = [];
function genId(): string { return `aud_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

const VALID_AUDIT_ACTIONS = [
  "payment.sent", "payment.received", "batch.executed",
  "swap.executed", "bridge.initiated", "bridge.completed",
  "payroll.executed", "invoice.created", "invoice.paid",
  "escrow.created", "escrow.funded", "escrow.released", "escrow.cancelled",
  "kyc.initiated", "kyc.completed", "auth.session_created", "auth.session_revoked",
  "webhook.registered", "webhook.triggered",
  "cron.created", "cron.executed", "cron.cancelled",
  "storage.pinned", "settings.changed",
];

export async function auditLogHandler(req: Request, res: Response) {
  try {
    const { action, actor, resource, details, txHash } = req.body;
    if (!action || !actor || !resource) return res.status(400).json({ error: "Missing required fields: action, actor, resource" });
    if (!VALID_AUDIT_ACTIONS.includes(action)) {
      return res.status(400).json({ error: `Invalid audit action: ${action}`, validActions: VALID_AUDIT_ACTIONS });
    }

    const id = genId();
    const entry: AuditEntry = {
      id, action, actor, resource, details: details || {},
      txHash: txHash || undefined, timestamp: new Date().toISOString(),
    };
    auditLog.push(entry);
    if (auditLog.length > 50000) auditLog.shift();

    return res.json({
      id, action, actor, resource, recorded: true,
      note: "Audit entry recorded. Production uses append-only storage (Postgres + optional on-chain anchoring).",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: entry.timestamp,
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to log audit entry", details: error.message });
  }
}

export async function auditQueryHandler(req: Request, res: Response) {
  try {
    const { actor, action, resource, since, until, limit } = req.query;
    let results = [...auditLog];
    if (actor && typeof actor === "string") results = results.filter((e) => e.actor.toLowerCase() === actor.toLowerCase());
    if (action && typeof action === "string") results = results.filter((e) => e.action === action);
    if (resource && typeof resource === "string") results = results.filter((e) => e.resource.toLowerCase().includes(resource.toLowerCase()));
    if (since && typeof since === "string") results = results.filter((e) => new Date(e.timestamp) >= new Date(since));
    if (until && typeof until === "string") results = results.filter((e) => new Date(e.timestamp) <= new Date(until));

    const maxResults = Math.min(parseInt(limit as string) || 50, 500);
    results = results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, maxResults);

    return res.json({
      entries: results, total: results.length,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to query audit log", details: error.message });
  }
}