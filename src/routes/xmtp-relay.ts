import { Request, Response } from "express";
import axios from "axios";

// x402 XMTP Relay — proxies to Agent Mango on agent.spraay.app
const AGENT_URL = process.env.XMTP_AGENT_URL || "https://agent.spraay.app";

export async function xmtpSendHandler(req: Request, res: Response) {
  try {
    const { to, content, contentType, metadata } = req.body;
    if (!to || !content) {
      return res.status(400).json({ error: "Missing required fields: to, content" });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
      return res.status(400).json({ error: "Invalid recipient address. Must be a valid Ethereum address." });
    }

    const response = await axios.post(`${AGENT_URL}/api/xmtp/send`, {
      to,
      message: content,
    });

    return res.json({
      ...response.data,
      contentType: contentType || "text/plain",
      metadata: metadata || {},
      _gateway: { provider: "spraay-x402", version: "3.0.0" },
    });
  } catch (error: any) {
    console.error("[XMTP Relay] Send error:", error?.response?.data || error.message);
    return res.status(500).json({ error: "Failed to send XMTP message", details: error?.response?.data || error.message });
  }
}

export async function xmtpInboxHandler(req: Request, res: Response) {
  try {
    const { address } = req.query;
    if (!address || typeof address !== "string") {
      return res.status(400).json({ error: "Missing query param: address" });
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: "Invalid Ethereum address" });
    }

    // Return agent info — full inbox requires XMTP client on caller side
    return res.json({
      address,
      agentAddress: "0xd136d8D5e7aaD3a76e08950a76b418B013c6d546",
      network: "production",
      agents: [
        { name: "MangoSwap", id: 26345, commands: ["/swap", "/dca", "/quote"] },
        { name: "Spraay", id: 26346, commands: ["/batch", "/x402"] },
      ],
      note: "Send messages to the agent address via XMTP to interact directly. Use /api/v1/xmtp/send to deliver messages.",
      _gateway: { provider: "spraay-x402", version: "3.0.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch inbox", details: error.message });
  }
}
