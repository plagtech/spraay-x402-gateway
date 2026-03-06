import { Request, Response } from "express";
import { logsDb } from "../db.js";

function genId(): string { return `log_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function logsIngestHandler(req: Request, res: Response) {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "Missing required field: entries[] (array of log objects)" });
    }
    if (entries.length > 100) return res.status(400).json({ error: "Max 100 entries per batch" });

    const validEntries = entries
      .filter((entry: any) => entry.level && entry.service && entry.message)
      .map((entry: any) => ({
        id: genId(), level: entry.level, service: entry.service,
        message: entry.message, data: entry.data || {},
        timestamp: entry.timestamp || new Date().toISOString(),
      }));

    const ids = await logsDb.ingest(validEntries);

    return res.json({
      ingested: ids.length, skipped: entries.length - ids.length, ids,
      note: "Logs stored in persistent database.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to ingest logs", details: error.message });
  }
}

export async function logsQueryHandler(req: Request, res: Response) {
  try {
    const { service, level, since, limit } = req.query;
    const maxResults = Math.min(parseInt(limit as string) || 50, 500);

    const results = await logsDb.query({
      service: service as string,
      level: level as string,
      since: since as string,
      limit: maxResults,
    });

    return res.json({
      logs: results, total: results.length,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to query logs", details: error.message });
  }
}
