import { Request, Response } from "express";

// x402 IPFS/Arweave — POST /storage/pin ($0.005), GET /storage/get ($0.002), GET /storage/status ($0.001)

interface StorageRecord {
  id: string;
  cid: string;
  provider: "ipfs" | "arweave";
  size: number;
  contentType: string;
  status: "pinning" | "pinned" | "failed";
  createdAt: string;
  pinnedAt?: string;
  metadata?: Record<string, any>;
}

const storage: Map<string, StorageRecord> = new Map();
function genId(): string { return `pin_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }
function fakeCid(): string { return `bafy${Array.from({ length: 52 }, () => "abcdefghijklmnopqrstuvwxyz234567"[Math.floor(Math.random() * 32)]).join("")}`; }

export async function storagePinHandler(req: Request, res: Response) {
  try {
    const { data, contentType, provider, metadata } = req.body;
    if (!data) return res.status(400).json({ error: "Missing required field: data (base64 or JSON string)" });

    const target = provider === "arweave" ? "arweave" : "ipfs";
    const size = typeof data === "string" ? Buffer.byteLength(data, "utf-8") : JSON.stringify(data).length;
    if (size > 5 * 1024 * 1024) return res.status(400).json({ error: "Data exceeds 5MB limit" });

    const id = genId();
    const cid = fakeCid();
    const record: StorageRecord = {
      id, cid, provider: target, size, contentType: contentType || "application/octet-stream",
      status: "pinning", createdAt: new Date().toISOString(), metadata: metadata || {},
    };
    storage.set(id, record);

    setTimeout(() => { const r = storage.get(id); if (r) { r.status = "pinned"; r.pinnedAt = new Date().toISOString(); } }, 2000);

    return res.json({
      id, cid, provider: target, size, status: "pinning",
      gateway: target === "ipfs" ? `https://ipfs.io/ipfs/${cid}` : `https://arweave.net/${cid}`,
      note: `Content queued for ${target} pinning. Production uses Pinata/web3.storage (IPFS) or Bundlr (Arweave).`,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to pin content", details: error.message });
  }
}

export async function storageGetHandler(req: Request, res: Response) {
  try {
    const { cid } = req.query;
    if (!cid || typeof cid !== "string") return res.status(400).json({ error: "Missing query param: cid" });

    const record = Array.from(storage.values()).find((r) => r.cid === cid);
    if (!record) return res.status(404).json({ error: "Content not found", cid });

    return res.json({
      cid: record.cid, provider: record.provider, size: record.size, contentType: record.contentType,
      status: record.status, pinnedAt: record.pinnedAt || null,
      gateway: record.provider === "ipfs" ? `https://ipfs.io/ipfs/${record.cid}` : `https://arweave.net/${record.cid}`,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to retrieve content", details: error.message });
  }
}

export async function storageStatusHandler(req: Request, res: Response) {
  try {
    const { id } = req.query;
    if (!id || typeof id !== "string") return res.status(400).json({ error: "Missing query param: id" });
    const record = storage.get(id);
    if (!record) return res.status(404).json({ error: "Pin not found", id });

    return res.json({
      id: record.id, cid: record.cid, provider: record.provider,
      status: record.status, createdAt: record.createdAt, pinnedAt: record.pinnedAt || null,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to check pin status", details: error.message });
  }
}