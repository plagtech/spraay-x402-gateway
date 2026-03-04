import { Request, Response } from "express";

// x402 KYC/KYB — POST /kyc/verify ($0.05), GET /kyc/status ($0.005)

interface KycRecord {
  id: string;
  type: "individual" | "business";
  address: string;
  status: "pending" | "approved" | "rejected" | "review";
  level: "basic" | "enhanced" | "full";
  checks: { identity: boolean; sanctions: boolean; pep: boolean; adverse_media: boolean };
  createdAt: string;
  completedAt?: string;
  expiresAt?: string;
  metadata?: Record<string, any>;
}

const kycRecords: Map<string, KycRecord> = new Map();
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
    const record: KycRecord = {
      id, type: kycType, address, status: "pending", level: kycLevel,
      checks: { identity: false, sanctions: false, pep: false, adverse_media: false },
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      metadata: metadata || {},
    };
    kycRecords.set(id, record);

    // Simulate async verification
    setTimeout(() => {
      const r = kycRecords.get(id);
      if (r) {
        r.status = "approved";
        r.checks = { identity: true, sanctions: true, pep: true, adverse_media: true };
        r.completedAt = new Date().toISOString();
      }
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
    let record: KycRecord | undefined;
    if (id && typeof id === "string") record = kycRecords.get(id);
    else if (address && typeof address === "string") {
      record = Array.from(kycRecords.values()).find((r) => r.address.toLowerCase() === address.toLowerCase());
    }
    if (!record) return res.status(404).json({ error: "KYC record not found" });

    return res.json({
      id: record.id, type: record.type, address: record.address, level: record.level,
      status: record.status, checks: record.checks,
      createdAt: record.createdAt, completedAt: record.completedAt || null, expiresAt: record.expiresAt,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to check KYC status", details: error.message });
  }
}