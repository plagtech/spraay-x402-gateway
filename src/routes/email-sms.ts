import { Request, Response } from "express";

// x402 Email/SMS — POST /notify/email ($0.003), POST /notify/sms ($0.005), GET /notify/status ($0.001)

interface NotificationRecord {
  id: string;
  type: "email" | "sms";
  to: string;
  subject?: string;
  body: string;
  status: "queued" | "sent" | "delivered" | "failed";
  createdAt: string;
  deliveredAt?: string;
  metadata?: Record<string, any>;
}

const notifications: Map<string, NotificationRecord> = new Map();
function genId(): string { return `ntf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function notifyEmailHandler(req: Request, res: Response) {
  try {
    const { to, subject, body, cc, bcc, replyTo, metadata } = req.body;
    if (!to || !body) return res.status(400).json({ error: "Missing required fields: to, body" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: "Invalid email address" });

    const id = genId();
    const record: NotificationRecord = {
      id, type: "email", to, subject: subject || "(no subject)", body,
      status: "queued", createdAt: new Date().toISOString(),
      metadata: { ...metadata, cc: cc || null, bcc: bcc || null, replyTo: replyTo || null },
    };
    notifications.set(id, record);
    setTimeout(() => { const n = notifications.get(id); if (n) { n.status = "sent"; n.deliveredAt = new Date().toISOString(); } }, 1000);

    return res.json({
      id, type: "email", to, subject: record.subject, status: "queued",
      note: "Email queued. Production integrates with SendGrid/Resend/SES.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to send email", details: error.message });
  }
}

export async function notifySmsHandler(req: Request, res: Response) {
  try {
    const { to, body, metadata } = req.body;
    if (!to || !body) return res.status(400).json({ error: "Missing required fields: to, body" });
    if (!/^\+[1-9]\d{1,14}$/.test(to)) return res.status(400).json({ error: "Invalid phone. Use E.164 format (+14155551234)" });
    if (body.length > 1600) return res.status(400).json({ error: "SMS body exceeds 1600 char limit" });

    const id = genId();
    const record: NotificationRecord = { id, type: "sms", to, body, status: "queued", createdAt: new Date().toISOString(), metadata: metadata || {} };
    notifications.set(id, record);
    setTimeout(() => { const n = notifications.get(id); if (n) { n.status = "sent"; n.deliveredAt = new Date().toISOString(); } }, 500);

    return res.json({
      id, type: "sms", to, segments: Math.ceil(body.length / 160), status: "queued",
      note: "SMS queued. Production integrates with Twilio/Vonage.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to send SMS", details: error.message });
  }
}

export async function notifyStatusHandler(req: Request, res: Response) {
  try {
    const { id } = req.query;
    if (!id || typeof id !== "string") return res.status(400).json({ error: "Missing query param: id" });
    const record = notifications.get(id);
    if (!record) return res.status(404).json({ error: "Notification not found", id });

    return res.json({
      id: record.id, type: record.type, to: record.to, subject: record.subject || undefined,
      status: record.status, createdAt: record.createdAt, deliveredAt: record.deliveredAt || null,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to check status", details: error.message });
  }
}