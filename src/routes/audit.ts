import { Request, Response } from "express";
import { auditDb } from "../db.js";

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
    const entry = {
      id, action, actor, resource, details: details || {},
      txHash: txHash || undefined, timestamp: new Date().toISOString(),
    };
    await auditDb.create(entry);

    return res.json({
      id, action, actor, resource, recorded: true,
      note: "Audit entry recorded in persistent storage.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: entry.timestamp,
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to log audit entry", details: error.message });
  }
}

export async function auditQueryHandler(req: Request, res: Response) {
  try {
    const { actor, action, resource, since, until, limit } = req.query;
    const maxResults = Math.min(parseInt(limit as string) || 50, 500);

    const results = await auditDb.query({
      actor: actor as string,
      action: action as string,
      resource: resource as string,
      since: since as string,
      until: until as string,
      limit: maxResults,
    });

    return res.json({
      entries: results, total: results.length,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to query audit log", details: error.message });
  }
}
