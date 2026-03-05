// routes/xmtp.js
// Spraay x402 Gateway — XMTP Relay routes
// Proxies to Agent Mango on Railway/Fly.io

import axios from "axios";

const AGENT_URL = process.env.XMTP_AGENT_URL || "https://agent.spraay.app";

export function xmtpRoutes(app, x402Middleware) {

  // POST /api/v1/xmtp/send — $0.005
  // Send encrypted XMTP message to any wallet address
  app.post(
    "/api/v1/xmtp/send",
    x402Middleware({ amount: "0.005", asset: "USDC" }),
    async (req, res) => {
      try {
        const { to, message } = req.body;
        if (!to || !message) {
          return res.status(400).json({ error: "Missing 'to' or 'message'" });
        }
        const response = await axios.post(`${AGENT_URL}/api/xmtp/send`, {
          to,
          message
        });
        res.json(response.data);
      } catch (err) {
        console.error("[XMTP] Send error:", err?.response?.data || err.message);
        res.status(500).json({ error: "Failed to send XMTP message" });
      }
    }
  );

  // POST /api/v1/xmtp/broadcast — $0.005
  // Broadcast message to multiple wallet addresses
  app.post(
    "/api/v1/xmtp/broadcast",
    x402Middleware({ amount: "0.005", asset: "USDC" }),
    async (req, res) => {
      try {
        const { recipients, message } = req.body;
        if (!recipients || !Array.isArray(recipients) || !message) {
          return res.status(400).json({ error: "Missing 'recipients' array or 'message'" });
        }
        if (recipients.length > 100) {
          return res.status(400).json({ error: "Maximum 100 recipients per broadcast" });
        }
        const response = await axios.post(`${AGENT_URL}/api/xmtp/broadcast`, {
          recipients,
          message
        });
        res.json(response.data);
      } catch (err) {
        console.error("[XMTP] Broadcast error:", err?.response?.data || err.message);
        res.status(500).json({ error: "Failed to broadcast XMTP message" });
      }
    }
  );

  // GET /api/v1/xmtp/inbox — $0.002
  // Check agent inbox (recent messages received)
  app.get(
    "/api/v1/xmtp/inbox",
    x402Middleware({ amount: "0.002", asset: "USDC" }),
    async (req, res) => {
      try {
        // Return agent address and status — full inbox requires XMTP SDK on client
        res.json({
          agentAddress: "0xd136d8D5e7aaD3a76e08950a76b418B013c6d546",
          network: "production",
          agents: [
            { name: "MangoSwap", id: 26345, commands: ["/swap", "/dca", "/quote"] },
            { name: "Spraay", id: 26346, commands: ["/batch", "/x402"] }
          ],
          note: "Send messages to the agent address via XMTP to interact directly",
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        res.status(500).json({ error: "Failed to fetch inbox" });
      }
    }
  );
}
