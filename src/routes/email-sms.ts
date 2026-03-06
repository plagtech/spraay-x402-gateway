import { Request, Response } from "express";
import { AgentMailClient } from "agentmail";

// x402 Email/SMS — POST /notify/email ($0.003), POST /notify/sms ($0.005), GET /notify/status ($0.001)

const AGENTMAIL_API_KEY = process.env.AGENTMAIL_API_KEY || "";
const AGENTMAIL_INBOX_ID = process.env.AGENTMAIL_INBOX_ID || "";

// Lazy-init AgentMail client
let agentmailClient: AgentMailClient | null = null;
function getAgentMail(): AgentMailClient {
  if (!agentmailClient) {
    agentmailClient = new AgentMailClient({ apiKey: AGENTMAIL_API_KEY });
  }
  return agentmailClient;
}

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

    // If AgentMail is configured, send real email
    if (AGENTMAIL_API_KEY && AGENTMAIL_INBOX_ID) {
      try {
        const client = getAgentMail();
        const result = await client.inboxes.messages.send(AGENTMAIL_INBOX_ID, {
          to: [to, ...(cc ? [cc] : [])],
          subject: subject || "(no subject)",
          text: body,
          replyTo: replyTo || undefined,
        });

        const record: NotificationRecord = {
          id, type: "email", to, subject: subject || "(no subject)", body,
          status: "delivered", createdAt: new Date().toISOString(),
          deliveredAt: new Date().toISOString(),
          metadata: { ...metadata, agentmailMessageId: result.messageId, agentmailThreadId: result.threadId },
        };
        notifications.set(id, record);

        return res.json({
          id, type: "email", to, subject: record.subject, status: "delivered",
          messageId: result.messageId, threadId: result.threadId,
          provider: "agentmail",
          _gateway: { provider: "spraay-x402", version: "2.9.0", live: true }, timestamp: new Date().toISOString(),
        });
      } catch (emailErr: any) {
        return res.status(500).json({ error: "AgentMail delivery failed", details: emailErr.message });
      }
    }

    // Fallback: simulated if AgentMail not configured
    const record: NotificationRecord = {
      id, type: "email", to, subject: subject || "(no subject)", body,
      status: "queued", createdAt: new Date().toISOString(),
      metadata: { ...metadata, cc: cc || null, bcc: bcc || null, replyTo: replyTo || null },
    };
    notifications.set(id, record);
    setTimeout(() => { const n = notifications.get(id); if (n) { n.status = "sent"; n.deliveredAt = new Date().toISOString(); } }, 1000);

    return res.json({
      id, type: "email", to, subject: record.subject, status: "queued",
      note: "Email queued (simulated). Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID for real delivery.",
      _gateway: { provider: "spraay-x402", version: "2.9.0", live: false }, timestamp: new Date().toISOString(),
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
      _gateway: { provider: "spraay-x402", version: "2.9.0", live: false }, timestamp: new Date().toISOString(),
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
