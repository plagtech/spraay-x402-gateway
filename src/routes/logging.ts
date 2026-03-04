import { Request, Response } from "express";

// x402 Logging — POST /logs/ingest ($0.001), GET /logs/query ($0.003)

interface LogEntry {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  service: string;
  message: string;
  data?: Record<string, any>;
  timestamp: string;
}

const logs: LogEntry[] = [];
function genId(): string { return `log_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`; }

export async function logsIngestHandler(req: Request, res: Response) {
  try {
    const { entries } = req.body;
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: "Missing required field: entries[] (array of log objects)" });
    }
    if (entries.length > 100) return res.status(400).json({ error: "Max 100 entries per batch" });

    const ingested: string[] = [];
    for (const entry of entries) {
      if (!entry.level || !entry.service || !entry.message) continue;
      const id = genId();
      logs.push({
        id, level: entry.level, service: entry.service,
        message: entry.message, data: entry.data || {},
        timestamp: entry.timestamp || new Date().toISOString(),
      });
      ingested.push(id);
      if (logs.length > 10000) logs.shift(); // cap in-memory
    }

    return res.json({
      ingested: ingested.length, skipped: entries.length - ingested.length, ids: ingested,
      note: "Logs stored in-memory. Production uses Elasticsearch/Loki/ClickHouse.",
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to ingest logs", details: error.message });
  }
}

export async function logsQueryHandler(req: Request, res: Response) {
  try {
    const { service, level, since, limit } = req.query;
    let results = [...logs];
    if (service && typeof service === "string") results = results.filter((l) => l.service === service);
    if (level && typeof level === "string") results = results.filter((l) => l.level === level);
    if (since && typeof since === "string") {
      const sinceDate = new Date(since).getTime();
      results = results.filter((l) => new Date(l.timestamp).getTime() >= sinceDate);
    }

    const maxResults = Math.min(parseInt(limit as string) || 50, 500);
    results = results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, maxResults);

    return res.json({
      logs: results, total: results.length,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to query logs", details: error.message });
  }
}