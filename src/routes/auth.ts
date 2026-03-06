import { Request, Response } from "express";
import { authDb } from "../db.js";

function genId(): string { return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }
function genToken(): string { return `spr_${Array.from({ length: 48 }, () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 62)]).join("")}`; }

const VALID_PERMISSIONS = [
  "batch:execute", "batch:estimate", "swap:execute", "swap:quote",
  "bridge:quote", "payroll:execute", "invoice:create", "invoice:read",
  "escrow:create", "escrow:manage", "analytics:read", "oracle:read",
  "notify:send", "webhook:manage", "cron:manage", "storage:write", "storage:read",
  "rpc:call", "logs:write", "logs:read", "kyc:verify", "audit:read", "tax:read",
];

export async function authSessionHandler(req: Request, res: Response) {
  try {
    const { address, permissions, ttlSeconds, metadata } = req.body;
    if (!address) return res.status(400).json({ error: "Missing required field: address" });
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: "Invalid Ethereum address" });

    const requestedPerms = permissions || ["*"];
    if (Array.isArray(requestedPerms) && !requestedPerms.includes("*")) {
      const invalid = requestedPerms.filter((p: string) => !VALID_PERMISSIONS.includes(p));
      if (invalid.length > 0) return res.status(400).json({ error: "Invalid permissions", invalid, valid: VALID_PERMISSIONS });
    }

    const ttl = Math.min(Math.max(ttlSeconds || 3600, 60), 86400);
    const now = new Date();
    const id = genId();
    const token = genToken();

    const session = {
      id, address, token,
      permissions: requestedPerms.includes("*") ? VALID_PERMISSIONS : requestedPerms,
      expiresAt: new Date(now.getTime() + ttl * 1000).toISOString(),
      createdAt: now.toISOString(), lastUsed: now.toISOString(), metadata: metadata || {},
    };
    await authDb.create(session);

    return res.json({
      sessionId: id, token, address, permissions: session.permissions,
      expiresAt: session.expiresAt, ttlSeconds: ttl,
      note: "Session token created. Use in Authorization header: Bearer <token>. Production uses SIWE for wallet-based auth.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: now.toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to create session", details: error.message });
  }
}

export async function authVerifyHandler(req: Request, res: Response) {
  try {
    const { token } = req.query;
    if (!token || typeof token !== "string") return res.status(400).json({ error: "Missing query param: token" });

    const session = await authDb.getByToken(token);
    if (!session) return res.status(401).json({ valid: false, error: "Invalid or expired token" });

    if (new Date(session.expires_at) < new Date()) {
      await authDb.deleteByToken(token);
      return res.status(401).json({ valid: false, error: "Token expired" });
    }

    await authDb.update(session.id, { lastUsed: new Date().toISOString() });

    return res.json({
      valid: true, sessionId: session.id, address: session.address,
      permissions: session.permissions, expiresAt: session.expires_at,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to verify token", details: error.message });
  }
}
