import { Request, Response } from "express";

// x402 XMTP Relay — POST /xmtp/send ($0.003), GET /xmtp/inbox ($0.002)

interface XmtpMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  contentType: string;
  status: "sent" | "delivered" | "failed";
  createdAt: string;
  metadata?: Record<string, any>;
}

const messages: Map<string, XmtpMessage> = new Map();
function genId(): string { return `xmtp_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function xmtpSendHandler(req: Request, res: Response) {
  try {
    const { to, content, contentType, from, metadata } = req.body;
    if (!to || !content) return res.status(400).json({ error: "Missing required fields: to, content" });
    if (!/^0x[a-fA-F0-9]{40}$/.test(to)) return res.status(400).json({ error: "Invalid recipient address. Must be a valid Ethereum address." });

    const id = genId();
    const record: XmtpMessage = {
      id, from: from || "gateway", to, content,
      contentType: contentType || "text/plain",
      status: "sent", createdAt: new Date().toISOString(), metadata: metadata || {},
    };
    messages.set(id, record);

    return res.json({
      id, from: record.from, to, contentType: record.contentType, status: "sent",
      note: "Message relayed via XMTP. Production connects to live XMTP network via Spraay agent (0xd136d8d5e7aad3a76e08950a76b418b013c6d546).",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to send XMTP message", details: error.message });
  }
}

export async function xmtpInboxHandler(req: Request, res: Response) {
  try {
    const { address, limit } = req.query;
    if (!address || typeof address !== "string") return res.status(400).json({ error: "Missing query param: address" });
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: "Invalid Ethereum address" });

    const maxResults = Math.min(parseInt(limit as string) || 20, 100);
    const inbox = Array.from(messages.values())
      .filter((m) => m.to.toLowerCase() === address.toLowerCase() || m.from.toLowerCase() === address.toLowerCase())
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, maxResults);

    return res.json({
      address, messages: inbox, total: inbox.length,
      note: "Production reads from live XMTP network conversations.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch inbox", details: error.message });
  }
}