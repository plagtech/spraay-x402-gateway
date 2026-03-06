import { Request, Response } from "express";
import { kycDb } from "../db.js";

function genId(): string { return `kyc_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function kycVerifyHandler(req: Request, res: Response) {
  try {
    const { address, type, level, metadata } = req.body;
    if (!address) return res.status(400).json({ error: "Missing required field: address" });
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return res.status(400).json({ error: "Invalid Ethereum address" });

    const kycType = type === "business" ? "business" : "individual";
    const kycLevel = ["basic", "enhanced", "full"].includes(level) ? level : "basic";

    const id = genId();
    const now = new Date();
    const record = {
      id, type: kycType, address, status: "pending", level: kycLevel,
      checks: { identity: false, sanctions: false, pep: false, adverse_media: false },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      metadata: metadata || {},
    };
    await kycDb.create(record);

    // Simulate async verification — update in DB after delay
    setTimeout(async () => {
      try {
        await kycDb.update(id, {
          status: "approved",
          checks: { identity: true, sanctions: true, pep: true, adverse_media: true },
          completedAt: new Date().toISOString(),
        });
      } catch { /* non-critical */ }
    }, 3000);

    return res.json({
      id, type: kycType, address, level: kycLevel, status: "pending",
      estimatedTime: "30-60 seconds",
      note: "KYC check initiated. Production integrates with Sumsub/Persona/Chainalysis.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: now.toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to initiate KYC", details: error.message });
  }
}

export async function kycStatusHandler(req: Request, res: Response) {
  try {
    const { id, address } = req.query;
    let record: any = null;
    if (id && typeof id === "string") record = await kycDb.get(id);
    else if (address && typeof address === "string") record = await kycDb.getByAddress(address);
    if (!record) return res.status(404).json({ error: "KYC record not found" });

    return res.json({
      id: record.id, type: record.type, address: record.address, level: record.level,
      status: record.status, checks: record.checks,
      createdAt: record.created_at, completedAt: record.completed_at || null, expiresAt: record.expires_at,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to check KYC status", details: error.message });
  }
}
