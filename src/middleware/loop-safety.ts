/**
 * 💧 Spraay Loop Safety Guards
 *
 * Three layers of protection against runaway agent loops:
 *   1. Rate limiter  — caps calls per API key per endpoint per time window
 *   2. Duplicate detection — rejects identical PAID submissions within a cooldown.
 *      Keyed by payer + payload (or an explicit idempotency_key). Unpaid x402/MPP
 *      probes (no payment header) are ignored so the two-leg flow isn't blocked.
 *   3. Webhook cooldown — prevents rapid-fire callback delivery to the same URL
 *
 * NON-BREAKING: All middleware is additive. If no API key is present (free tier),
 * the rate limiter uses IP as the key. Existing behavior is unchanged.
 *
 * INTEGRATION:
 *   import { loopRateLimiter, duplicatePaymentGuard } from "./middleware/loop-safety.js";
 *
 *   // Mount AFTER apiKeyAuthMiddleware, BEFORE routes:
 *   app.use(loopRateLimiter());
 *   app.use("/api/v1/batch", duplicatePaymentGuard());
 *   app.use("/api/v1/escrow", duplicatePaymentGuard());
 *   app.use("/api/v1/payroll", duplicatePaymentGuard());
 */

import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

// ═══════════════════════════════════════════════════════════════════════════
// 1. RATE LIMITER — sliding window per API key per endpoint
// ═══════════════════════════════════════════════════════════════════════════

interface RateLimitConfig {
  /** Max requests per window. Default: 30 */
  maxRequests: number;
  /** Window size in ms. Default: 60_000 (1 minute) */
  windowMs: number;
  /** Endpoint patterns that get tighter limits (regex matched against req.path) */
  strictPaths?: { pattern: RegExp; maxRequests: number }[];
}

const DEFAULT_RATE_CONFIG: RateLimitConfig = {
  maxRequests: 30,
  windowMs: 60_000,
  strictPaths: [
    // Payment-moving endpoints get tighter limits
    { pattern: /\/batch\/execute/i, maxRequests: 10 },
    { pattern: /\/escrow\/(create|fund|release)/i, maxRequests: 10 },
    { pattern: /\/payroll\/execute/i, maxRequests: 10 },
    { pattern: /\/xrp\/batch/i, maxRequests: 10 },
    { pattern: /\/stellar\/batch/i, maxRequests: 10 },
    { pattern: /\/compute-futures\/deposit/i, maxRequests: 10 },
    { pattern: /\/wallet\/send-transaction/i, maxRequests: 10 },
  ],
};

// In-memory sliding window store. Each key maps to an array of timestamps.
// For single-instance Railway deployments this is sufficient.
// If you scale to multiple instances, swap this for Redis.
const windowStore = new Map<string, number[]>();

// Cleanup stale entries every 5 minutes to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of windowStore.entries()) {
    const valid = timestamps.filter((t) => now - t < 300_000); // 5 min max
    if (valid.length === 0) {
      windowStore.delete(key);
    } else {
      windowStore.set(key, valid);
    }
  }
}, 300_000);

function getClientKey(req: Request): string {
  // Prefer API key, fall back to IP
  const apiKey =
    (req.headers["authorization"]?.replace(/^Bearer\s+/i, "")) ||
    (req.headers["x-api-key"] as string) ||
    req.ip ||
    "unknown";
  return apiKey;
}

export function loopRateLimiter(config?: Partial<RateLimitConfig>) {
  const cfg = { ...DEFAULT_RATE_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only rate-limit POST requests (reads don't move money)
    if (req.method !== "POST") return next();

    const clientKey = getClientKey(req);

    // Determine the limit for this specific path
    let limit = cfg.maxRequests;
    if (cfg.strictPaths) {
      for (const sp of cfg.strictPaths) {
        if (sp.pattern.test(req.path)) {
          limit = sp.maxRequests;
          break;
        }
      }
    }

    const bucketKey = `${clientKey}::${req.path}`;
    const now = Date.now();
    const windowStart = now - cfg.windowMs;

    // Get existing timestamps, filter to current window
    const timestamps = (windowStore.get(bucketKey) || []).filter(
      (t) => t > windowStart
    );

    if (timestamps.length >= limit) {
      const retryAfterSec = Math.ceil(cfg.windowMs / 1000);
      console.warn(
        `[loop-safety] 🛑 Rate limit hit: ${bucketKey} (${timestamps.length}/${limit} in ${retryAfterSec}s)`
      );

      res.status(429).json({
        error: "rate_limit_exceeded",
        message: `Too many requests to ${req.path}. Limit: ${limit} per ${retryAfterSec}s. If you are running an agent loop, check your exit conditions.`,
        limit,
        window_seconds: retryAfterSec,
        retry_after_seconds: retryAfterSec,
        hint: "If this is a loop-engineered agent, ensure your loop has proper termination conditions and doesn't re-fire on every callback.",
      });
      return;
    }

    // Record this request
    timestamps.push(now);
    windowStore.set(bucketKey, timestamps);

    // Set rate limit headers (helpful for agents to self-regulate)
    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - timestamps.length));
    res.setHeader("X-RateLimit-Reset", new Date(now + cfg.windowMs).toISOString());

    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. DUPLICATE PAYMENT GUARD — rejects identical payloads within a cooldown
// ═══════════════════════════════════════════════════════════════════════════

interface DuplicateGuardConfig {
  /** Cooldown window in ms. Default: 60_000 (60 seconds) */
  cooldownMs: number;
  /** Fields to include in the hash. Default: common payment fields */
  hashFields?: string[];
}

const DEFAULT_DUPLICATE_CONFIG: DuplicateGuardConfig = {
  cooldownMs: 60_000,
  hashFields: [
    "recipients", "amounts", "token", "chain", "sender",
    "recipient", "amount",  // single-payment variants
    "to", "value",          // escrow variants
  ],
};

// Hash → { timestamp, endpoint }
const duplicateStore = new Map<string, { timestamp: number; endpoint: string }>();

// Cleanup stale entries every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of duplicateStore.entries()) {
    if (now - entry.timestamp > 120_000) {
      duplicateStore.delete(key);
    }
  }
}, 120_000);

// A payment credential on any rail the gateway speaks. The x402/MPP two-leg
// flow starts with an UNPAID probe that carries NONE of these — leg 1 exists
// only to fetch the 402 challenge. Such probes must skip the guard entirely (no
// check, no register), so the identical body replayed on leg 2 WITH a
// credential isn't wrongly rejected as a duplicate.
//   • x402   — `X-PAYMENT` (v1) / `Payment-Signature` (v2)
//   • Solana — `X-Solana-Tx`
//   • MPP    — `Authorization: Payment …`  (also tolerates `X-MPP-Payment`)
//   • L402   — `Authorization: L402 …`
function hasPaymentCredential(req: Request): boolean {
  const h = req.headers;
  if (h["x-payment"] || h["payment-signature"] || h["x-solana-tx"] || h["x-mpp-payment"]) {
    return true;
  }
  const auth = h["authorization"];
  return typeof auth === "string" && (/^Payment\s/i.test(auth) || /^L402\s/i.test(auth));
}

// Identity of the paying party. Keying on this (and not the payload alone) stops
// two different payers who happen to submit an identical body from colliding —
// one must never be able to 409 the other. Prefers the on-chain sender in the
// body, then falls back to the API-key / IP client key.
function getPayerKey(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const sender = body.sender ?? body.from ?? body.payer;
  const senderStr = typeof sender === "string" && sender ? sender.toLowerCase() : "";
  return `${getClientKey(req)}::${senderStr}`;
}

// Build the dedupe key: payer + (explicit idempotency_key | payment payload).
// Returns "" when there is nothing payment-relevant to dedupe on.
function buildDedupeKey(req: Request, fields: string[]): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const payer = getPayerKey(req);

  // An explicit idempotency_key is the caller's own dedupe token — honor it
  // verbatim instead of hashing the payload. Same payer + same key = duplicate;
  // a different key is always treated as a distinct request.
  const idem = body.idempotency_key;
  if (typeof idem === "string" && idem.length > 0) {
    return crypto.createHash("sha256").update(`${payer}|idem:${idem}`).digest("hex");
  }

  // Otherwise hash the payer together with the payment-relevant fields.
  const parts: string[] = [payer];
  for (const field of fields) {
    const val = body[field];
    if (val !== undefined) {
      parts.push(`${field}:${JSON.stringify(val)}`);
    }
  }

  // No payment-relevant fields found — skip dedup (it's probably not a payment).
  if (parts.length <= 1) return "";

  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

export function duplicatePaymentGuard(config?: Partial<DuplicateGuardConfig>) {
  const cfg = { ...DEFAULT_DUPLICATE_CONFIG, ...config };

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only check POSTs with a body
    if (req.method !== "POST" || !req.body) return next();

    // x402/MPP two-leg flow: leg 1 is an UNPAID probe (no payment credential),
    // sent only to retrieve the 402 challenge. It must never be recorded or
    // checked — otherwise leg 2, the SAME body replayed WITH a payment
    // credential, collides with leg 1 and is wrongly rejected as a duplicate.
    if (!hasPaymentCredential(req)) return next();

    const clientKey = getClientKey(req);
    const hash = buildDedupeKey(req, cfg.hashFields!);

    // No payment-relevant fields / idempotency key found — pass through
    if (!hash) return next();

    const now = Date.now();
    const existing = duplicateStore.get(hash);

    if (existing && now - existing.timestamp < cfg.cooldownMs) {
      const cooldownSec = Math.ceil(cfg.cooldownMs / 1000);
      const ageMs = now - existing.timestamp;
      const waitSec = Math.ceil((cfg.cooldownMs - ageMs) / 1000);

      console.warn(
        `[loop-safety] 🔄 Duplicate payment blocked: ${clientKey} → ${req.path} (same payload ${Math.round(ageMs / 1000)}s ago)`
      );

      res.status(409).json({
        error: "duplicate_payment_detected",
        message: `An identical payment was submitted ${Math.round(ageMs / 1000)}s ago. Wait ${waitSec}s or modify the payload. This guard prevents runaway agent loops from making duplicate payments.`,
        cooldown_seconds: cooldownSec,
        retry_after_seconds: waitSec,
        original_endpoint: existing.endpoint,
        hint: "If this is intentional, add a unique 'idempotency_key' field to differentiate the requests.",
      });
      return;
    }

    // Record this payload
    duplicateStore.set(hash, { timestamp: now, endpoint: req.path });

    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. WEBHOOK COOLDOWN — minimum interval between deliveries to the same URL
// ═══════════════════════════════════════════════════════════════════════════

// Tracks last delivery time per callback_url
const deliveryCooldowns = new Map<string, number>();

// Cleanup every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [url, timestamp] of deliveryCooldowns.entries()) {
    if (now - timestamp > 300_000) {
      deliveryCooldowns.delete(url);
    }
  }
}, 300_000);

/**
 * Check if a webhook delivery should be delayed.
 * Called by the webhook worker before dispatching.
 *
 * @param callbackUrl - The target URL
 * @param minIntervalMs - Minimum ms between deliveries. Default: 5000 (5s)
 * @returns true if delivery is allowed, false if still in cooldown
 */
export function checkWebhookCooldown(
  callbackUrl: string,
  minIntervalMs: number = 5_000
): boolean {
  const now = Date.now();
  const lastDelivery = deliveryCooldowns.get(callbackUrl);

  if (lastDelivery && now - lastDelivery < minIntervalMs) {
    return false; // Still in cooldown
  }

  return true;
}

/**
 * Record that a webhook was delivered to a URL.
 * Called by the webhook worker after successful dispatch.
 */
export function recordWebhookDelivery(callbackUrl: string): void {
  deliveryCooldowns.set(callbackUrl, Date.now());
}
