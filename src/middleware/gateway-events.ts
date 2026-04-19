import type { Request, Response, NextFunction } from "express";
import { supabase } from "./supabase.js";

type EventType = "scan" | "intent" | "payment";

function classifyEvent(req: Request, res: Response): EventType | null {
  const path = req.path;

  if (
    path.startsWith("/.well-known/x402") ||
    path.startsWith("/x402-resources") ||
    path.startsWith("/.well-known/x402-resources")
  ) {
    return "scan";
  }

  if (res.statusCode === 402) {
    return "intent";
  }

  const hasPaymentHeader = Boolean(req.headers["x-payment"]);
  if (hasPaymentHeader && res.statusCode >= 200 && res.statusCode < 300) {
    return "payment";
  }

  return null;
}

function inferCategory(path: string): string | null {
  const p = path.toLowerCase();
  if (p.includes("/chat/") || p.includes("/inference")) return "ai_inference";
  if (p.includes("/oracle") || p.includes("/prices") || p.includes("/gas") || p.includes("/fx")) return "oracle";
  if (p.includes("/escrow")) return "escrow";
  if (p.includes("/payroll")) return "payroll";
  if (p.includes("/bridge")) return "bridge";
  if (p.includes("/swap")) return "swap";
  if (p.includes("/xrp")) return "xrp";
  if (p.includes("/stellar")) return "stellar";
  if (p.includes("/batch")) return "batch_payment";
  if (p.includes("/robot") || p.includes("/rtp")) return "rtp";
  if (p.includes("/agent-wallet")) return "agent_wallet";
  if (p.includes("/wallet")) return "wallet";
  if (p.includes("/search")) return "search";
  if (p.includes("/storage") || p.includes("/ipfs")) return "storage";
  if (p.includes("/cron")) return "cron";
  if (p.includes("/kyc")) return "kyc";
  if (p.includes("/auth")) return "auth";
  if (p.includes("/audit")) return "audit";
  if (p.includes("/tax")) return "tax";
  if (p.includes("/gpu")) return "gpu";
  if (p.includes("/webhook")) return "webhook";
  if (p.includes("/email") || p.includes("/sms") || p.includes("/xmtp")) return "communication";
  if (p.includes("/rpc")) return "rpc";
  if (p.includes("/sctp")) return "sctp";
  if (p.includes("/dropin")) return "bittensor_dropin";
  if (p.includes("/invoice")) return "invoice";
  if (p.includes("/analytics")) return "analytics";
  if (p.includes("/balance")) return "balances";
  if (p.includes("/resolve")) return "resolve";
  return null;
}

function inferEndpointName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  const last = parts[parts.length - 1] || path;
  return last.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferScanner(userAgent: string | undefined): string | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  if (ua.includes("bazaar")) return "bazaar";
  if (ua.includes("x402scan")) return "x402scan";
  if (ua.includes("coinbase")) return "coinbase";
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "generic_crawler";
  return null;
}

function extractChain(req: Request): string | null {
  const body = req.body as Record<string, unknown> | undefined;
  const query = req.query as Record<string, unknown>;
  const chain = (body?.chain || body?.network || query?.chain || query?.network) as string | undefined;
  if (!chain) return null;
  const c = chain.toLowerCase();
  if (c.includes("base")) return "base";
  if (c.includes("solana")) return "solana";
  if (c.includes("xrp")) return "xrp";
  if (c.includes("stellar")) return "stellar";
  if (c.includes("bitcoin") || c === "btc") return "bitcoin";
  if (c.includes("stacks")) return "stacks";
  if (c.includes("polygon")) return "polygon";
  if (c.includes("arbitrum")) return "arbitrum";
  if (c.includes("optimism")) return "optimism";
  return c;
}

function extractBatchSize(req: Request): number | null {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body) return null;
  const recipients = body.recipients as unknown[] | undefined;
  if (Array.isArray(recipients) && recipients.length > 0) return recipients.length;
  const batch = body.batch as unknown[] | undefined;
  if (Array.isArray(batch) && batch.length > 0) return batch.length;
  const payments = body.payments as unknown[] | undefined;
  if (Array.isArray(payments) && payments.length > 0) return payments.length;
  return null;
}

function extractPayerAddress(req: Request): string | null {
  const paymentHeader = req.headers["x-payment"];
  if (typeof paymentHeader === "string") {
    const match = paymentHeader.match(/0x[a-fA-F0-9]{40}/);
    if (match) return match[0];
  }
  const body = req.body as Record<string, unknown> | undefined;
  const addr = (body?.from || body?.payer || body?.address) as string | undefined;
  if (typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr)) return addr;
  return null;
}

export function gatewayEventsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!supabase) {
    next();
    return;
  }

  const client = supabase;
  const startTime = Date.now();

  res.on("finish", () => {
    try {
      const eventType = classifyEvent(req, res);
      if (!eventType) return;

      const userAgent = req.headers["user-agent"];
      const row = {
        event_type: eventType,
        path: req.path,
        method: req.method,
        http_status: res.statusCode,
        category: inferCategory(req.path),
        chain: extractChain(req),
        endpoint_name: inferEndpointName(req.path),
        payer_address: extractPayerAddress(req),
        batch_size: extractBatchSize(req),
        tx_hash: ((res.locals as Record<string, unknown>)?.txHash as string | null) ?? null,
        scanner_source: inferScanner(typeof userAgent === "string" ? userAgent : undefined),
        user_agent: typeof userAgent === "string" ? userAgent.slice(0, 200) : null,
        duration_ms: Date.now() - startTime
      };

      client
        .from("gateway_events")
        .insert(row)
        .then(({ error }) => {
          if (error) console.error("[gateway-events] insert failed:", error.message);
        });
    } catch (err) {
      console.error("[gateway-events] middleware error:", err);
    }
  });

  next();
}