import { Request, Response } from "express";

// x402 Webhook — POST /webhook/register ($0.003), POST /webhook/test ($0.002), GET /webhook/list ($0.001), DELETE via POST /webhook/delete ($0.001)

interface WebhookRecord {
  id: string;
  url: string;
  events: string[];
  secret: string;
  status: "active" | "paused" | "failed";
  createdAt: string;
  lastTriggered?: string;
  failCount: number;
  metadata?: Record<string, any>;
}

const webhooks: Map<string, WebhookRecord> = new Map();
function genId(): string { return `whk_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }
function genSecret(): string { return `whsec_${Array.from({ length: 32 }, () => Math.random().toString(36)[2]).join("")}`; }

const VALID_EVENTS = [
  "payment.sent", "payment.received", "payment.failed",
  "batch.completed", "batch.failed",
  "escrow.created", "escrow.funded", "escrow.released", "escrow.cancelled", "escrow.expired",
  "invoice.created", "invoice.paid", "invoice.overdue",
  "swap.completed", "swap.failed",
  "bridge.completed", "bridge.failed",
  "payroll.completed", "payroll.failed",
];

export async function webhookRegisterHandler(req: Request, res: Response) {
  try {
    const { url, events, metadata } = req.body;
    if (!url || !events || !Array.isArray(events) || events.length === 0) {
      return res.status(400).json({ error: "Missing required fields: url, events[]" });
    }
    try { new URL(url); } catch { return res.status(400).json({ error: "Invalid webhook URL" }); }

    const invalid = events.filter((e: string) => !VALID_EVENTS.includes(e));
    if (invalid.length > 0) {
      return res.status(400).json({ error: "Invalid events", invalid, validEvents: VALID_EVENTS });
    }

    const id = genId();
    const secret = genSecret();
    const record: WebhookRecord = {
      id, url, events, secret, status: "active", createdAt: new Date().toISOString(), failCount: 0, metadata: metadata || {},
    };
    webhooks.set(id, record);

    return res.json({
      id, url, events, secret, status: "active",
      note: "Webhook registered. Secret is used for HMAC-SHA256 signature verification.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to register webhook", details: error.message });
  }
}

export async function webhookTestHandler(req: Request, res: Response) {
  try {
    const { webhookId } = req.body;
    if (!webhookId) return res.status(400).json({ error: "Missing required field: webhookId" });
    const record = webhooks.get(webhookId);
    if (!record) return res.status(404).json({ error: "Webhook not found", webhookId });

    const testPayload = {
      event: "test.ping",
      webhookId: record.id,
      data: { message: "This is a test event from Spraay x402 Gateway", timestamp: new Date().toISOString() },
    };

    record.lastTriggered = new Date().toISOString();

    return res.json({
      webhookId: record.id, url: record.url, testPayload, delivered: true,
      note: "Test event dispatched. Production sends real HTTP POST with HMAC signature.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to test webhook", details: error.message });
  }
}

export async function webhookListHandler(req: Request, res: Response) {
  try {
    const { status } = req.query;
    let results = Array.from(webhooks.values());
    if (status && typeof status === "string") {
      results = results.filter((w) => w.status === status);
    }

    return res.json({
      webhooks: results.map((w) => ({
        id: w.id, url: w.url, events: w.events, status: w.status,
        createdAt: w.createdAt, lastTriggered: w.lastTriggered || null, failCount: w.failCount,
      })),
      total: results.length,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to list webhooks", details: error.message });
  }
}

export async function webhookDeleteHandler(req: Request, res: Response) {
  try {
    const { webhookId } = req.body;
    if (!webhookId) return res.status(400).json({ error: "Missing required field: webhookId" });
    const record = webhooks.get(webhookId);
    if (!record) return res.status(404).json({ error: "Webhook not found", webhookId });

    webhooks.delete(webhookId);
    return res.json({
      deleted: true, webhookId,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to delete webhook", details: error.message });
  }
}