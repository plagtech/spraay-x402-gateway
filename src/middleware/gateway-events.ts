import type { Request, Response, NextFunction } from "express";
import { supabase } from "./supabase.js";

type EventType = "scan" | "intent" | "payment";

// x402 v2 settlement receipt. v2 (Dec 2025) renamed the headers and dropped the
// X- prefix: X-PAYMENT → PAYMENT-SIGNATURE (request), X-PAYMENT-RESPONSE →
// PAYMENT-RESPONSE (response). The receipt is base64-encoded JSON and is present
// on a successful 200 AND on some failed 402s — always check `.success`.
type Settlement = {
  success?: boolean;
  transaction?: string | null;
  network?: string;
  payer?: string;
  errorReason?: string;
};

// Reads the v2 receipt header, falling back to the v1 name for any legacy clients.
function decodeSettlement(res: Response): Settlement | null {
  const h = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
  const raw = Array.isArray(h) ? h[0] : h;
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as Settlement;
  } catch {
    return null; // not valid base64 JSON — treat as no receipt
  }
}

// True if the request carried an EVM payment proof — v2 `payment-signature`,
// with v1 `x-payment` kept for backwards compatibility.
function hasEvmPaymentHeader(req: Request): boolean {
  return Boolean(req.headers["payment-signature"]) || Boolean(req.headers["x-payment"]);
}

function classifyEvent(req: Request, res: Response, settlement: Settlement | null): EventType | null {
  const path = req.path;

  if (
    path.startsWith("/.well-known/x402") ||
    path.startsWith("/.well-known/solana") ||
    path.startsWith("/x402-resources") ||
    path.startsWith("/.well-known/x402-resources")
  ) {
    return "scan";
  }

  // Authoritative: a settlement receipt confirming success = a real payment.
  if (settlement?.success === true) return "payment";

  // A 402 (including a failed receipt) is an unconverted intent.
  if (res.statusCode === 402) return "intent";

  // Fallback for any path that doesn't surface a receipt header: EVM payment
  // header + 2xx. NOTE: we deliberately do NOT count `x-solana-tx` here —
  // solanaPaymentMiddleware already logs Solana payments, so counting them here
  // too would double-count every Solana settlement.
  if (hasEvmPaymentHeader(req) && res.statusCode >= 200 && res.statusCode < 300 && settlement?.success !== false) {
    return "payment";
  }

  return null;
}

function inferCategory(path: string): string | null {
  const p = path.toLowerCase();
  if (p.includes("/compute")) return "compute";
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
  if (p.includes("/portfolio")) return "portfolio";
  if (p.includes("/contract")) return "contract";
  if (p.includes("/defi")) return "defi";
  if (p.includes("/jupiter") || p.includes("/helius") || p.includes("/pyth")) return "solana_data";
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
  if (ua.includes("x402-healthbot")) return "decixa";
  if (ua.includes("x402-network-mapper") || ua.includes("smartflowproai")) return "smartflowproai";
  if (ua.includes("coinbase")) return "coinbase";
  if (ua === "node" || ua.startsWith("node/") || ua.startsWith("node ")) return "node_default";
  if (ua.includes("bot") || ua.includes("crawler") || ua.includes("spider")) return "generic_crawler";
  if (ua.includes("solana") || ua.includes("phantom") || ua.includes("jupiter")) return "solana_agent";
  return null;
}

function extractChain(req: Request): string | null {
  // 1. Strongest signal: explicit header / body / query
  if (req.headers["x-solana-tx"]) return "solana";
  const body = req.body as Record<string, unknown> | undefined;
  const query = req.query as Record<string, unknown>;
  const explicit = (body?.chain || body?.network || query?.chain || query?.network) as string | undefined;
  if (explicit) {
    const c = explicit.toLowerCase();
    if (c.includes("base")) return "base";
    if (c.includes("solana")) return "solana";
    if (c.includes("xrp")) return "xrp";
    if (c.includes("stellar") || c.includes("xlm")) return "stellar";
    if (c.includes("bitcoin") || c === "btc") return "bitcoin";
    if (c.includes("stacks")) return "stacks";
    if (c.includes("polygon")) return "polygon";
    if (c.includes("arbitrum")) return "arbitrum";
    if (c.includes("optimism")) return "optimism";
    return c;
  }
  // 2. Fallback: the path. Native batch endpoints are chain-specific, so they
  //    don't need a chain field in the body.
  const p = req.path.toLowerCase();
  if (p.includes("/xrp")) return "xrp";
  if (p.includes("/stellar") || p.includes("/xlm")) return "stellar";
  if (p.includes("/bitcoin") || p.includes("/btc")) return "bitcoin";
  if (p.includes("/stacks")) return "stacks";
  if (p.includes("/tao") || p.includes("/bittensor")) return "bittensor";
  if (p.includes("/solana") || p.includes("/jupiter") || p.includes("/helius") || p.includes("/pyth")) return "solana";
  return null; // generic EVM batch etc. → null, which the globe renders at Base by default
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

// Best-effort EVM payer from the request. In v2 the proof lives in a base64
// PAYMENT-SIGNATURE payload, so this usually returns null on the request side —
// the authoritative payer comes from the settlement receipt (see row below).
function extractPayerAddress(req: Request): string | null {
  const sig = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (typeof sig === "string") {
    const match = sig.match(/0x[a-fA-F0-9]{40}/);
    if (match) return match[0];
  }
  const body = req.body as Record<string, unknown> | undefined;
  const addr = (body?.from || body?.payer || body?.address) as string | undefined;
  if (typeof addr === "string" && /^0x[a-fA-F0-9]{40}$/.test(addr)) return addr;
  return null;
}

function extractSourceIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    return fwd.split(",")[0].trim();
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return fwd[0].split(",")[0].trim();
  }
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string" && realIp.length > 0) {
    return realIp;
  }
  return req.ip || null;
}

export function gatewayEventsMiddleware(req: Request, res: Response, next: NextFunction) {
  if (!supabase) {
    next();
    return;
  }

  const client = supabase;
  const startTime = Date.now();
  // v2 `payment-signature` (or v1 `x-payment`) or the Solana rail header.
  const paymentAttempted =
    hasEvmPaymentHeader(req) || Boolean(req.headers["x-solana-tx"]);

  res.on("finish", () => {
    try {
      const settlement = decodeSettlement(res);
      const eventType = classifyEvent(req, res, settlement);
      if (!eventType) return;

      const userAgent = req.headers["user-agent"];
      const row = {
        event_type: eventType,
        path: req.path,
        method: req.method,
        http_status: res.statusCode,
        category: inferCategory(req.path),
        chain: extractChain(req) ?? settlement?.network ?? null,
        endpoint_name: inferEndpointName(req.path),
        // Prefer the verified payer from the settlement receipt when present.
        payer_address: extractPayerAddress(req) ?? settlement?.payer ?? null,
        batch_size: extractBatchSize(req),
        // tx_hash now comes from the v2 PAYMENT-RESPONSE receipt — the only place
        // EVM settlement hashes are actually surfaced.
        tx_hash:
          settlement?.transaction ??
          ((res.locals as Record<string, unknown>)?.txHash as string | null) ??
          null,
        scanner_source: inferScanner(typeof userAgent === "string" ? userAgent : undefined),
        user_agent: typeof userAgent === "string" ? userAgent.slice(0, 200) : null,
        duration_ms: Date.now() - startTime,
        source_ip: extractSourceIp(req),
        payment_attempted: paymentAttempted,
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
