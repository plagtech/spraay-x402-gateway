import { Request, Response } from "express";
import axios from "axios";

// x402 IPFS/Arweave — POST /storage/pin ($0.005), GET /storage/get ($0.002), GET /storage/status ($0.001)
// Real IPFS via Pinata. Arweave stays simulated.
// Env vars: PINATA_API_KEY, PINATA_API_SECRET

const PINATA_API_KEY = process.env.PINATA_API_KEY || "";
const PINATA_API_SECRET = process.env.PINATA_API_SECRET || "";
const PINATA_BASE = "https://api.pinata.cloud";

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

    // Real IPFS pinning via Pinata
    if (target === "ipfs" && PINATA_API_KEY && PINATA_API_SECRET) {
      try {
        const pinataPayload: any = {
          pinataContent: typeof data === "string" ? { raw: data } : data,
          pinataMetadata: {
            name: metadata?.name || `spraay-${id}`,
            keyvalues: metadata || {},
          },
          pinataOptions: { cidVersion: 1 },
        };

        const pinataRes = await axios.post(`${PINATA_BASE}/pinning/pinJSONToIPFS`, pinataPayload, {
          headers: {
            "Content-Type": "application/json",
            pinata_api_key: PINATA_API_KEY,
            pinata_secret_api_key: PINATA_API_SECRET,
          },
          timeout: 30000,
        });

        const cid = pinataRes.data.IpfsHash;
        const pinSize = pinataRes.data.PinSize;

        const record: StorageRecord = {
          id, cid, provider: "ipfs", size: pinSize, contentType: contentType || "application/json",
          status: "pinned", createdAt: new Date().toISOString(), pinnedAt: new Date().toISOString(),
          metadata: metadata || {},
        };
        storage.set(id, record);

        return res.json({
          id, cid, provider: "ipfs", size: pinSize, status: "pinned",
          gateway: `https://gateway.pinata.cloud/ipfs/${cid}`,
          ipfsUri: `ipfs://${cid}`,
          _gateway: { provider: "spraay-x402", version: "2.9.0", live: true }, timestamp: new Date().toISOString(),
        });
      } catch (pinErr: any) {
        return res.status(500).json({
          error: "Pinata pinning failed",
          details: pinErr.response?.data?.error || pinErr.message,
        });
      }
    }

    // Fallback: simulated (Arweave or Pinata not configured)
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
      note: target === "arweave"
        ? "Arweave pinning simulated. Production uses Bundlr."
        : "IPFS pinning simulated. Set PINATA_API_KEY and PINATA_API_SECRET for real pinning.",
      _gateway: { provider: "spraay-x402", version: "2.9.0", live: false }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to pin content", details: error.message });
  }
}

export async function storageGetHandler(req: Request, res: Response) {
  try {
    const { cid } = req.query;
    if (!cid || typeof cid !== "string") return res.status(400).json({ error: "Missing query param: cid" });

    // Check local cache first
    const record = Array.from(storage.values()).find((r) => r.cid === cid);
    if (record) {
      return res.json({
        cid: record.cid, provider: record.provider, size: record.size, contentType: record.contentType,
        status: record.status, pinnedAt: record.pinnedAt || null,
        gateway: record.provider === "ipfs" ? `https://gateway.pinata.cloud/ipfs/${record.cid}` : `https://arweave.net/${record.cid}`,
        _gateway: { provider: "spraay-x402", version: "2.9.0", live: true }, timestamp: new Date().toISOString(),
      });
    }

    // Try fetching from IPFS gateway if not in local cache
    if (PINATA_API_KEY && PINATA_API_SECRET) {
      try {
        const gatewayRes = await axios.head(`https://gateway.pinata.cloud/ipfs/${cid}`, { timeout: 10000 });
        return res.json({
          cid, provider: "ipfs", size: parseInt(gatewayRes.headers["content-length"] || "0"),
          contentType: gatewayRes.headers["content-type"] || "unknown",
          status: "pinned", pinnedAt: null,
          gateway: `https://gateway.pinata.cloud/ipfs/${cid}`,
          _gateway: { provider: "spraay-x402", version: "2.9.0", live: true }, timestamp: new Date().toISOString(),
        });
      } catch {
        return res.status(404).json({ error: "Content not found on IPFS", cid });
      }
    }

    return res.status(404).json({ error: "Content not found", cid });
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
