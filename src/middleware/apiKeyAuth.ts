import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { supabase } from "../db.js";

/**
 * Hash an API key for safe storage/lookup.
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * Generate a new API key with a "spry_" prefix.
 */
export function generateApiKey(): string {
  return `spry_${crypto.randomBytes(32).toString("hex")}`;
}

// ── Paid-route matching ─────────────────────────────────────────────────────
// Mirrors @x402/core's x402HTTPResourceServer.parseRoutePattern/normalizePath
// so a request counts as "paid" here exactly when paymentMiddleware would
// charge it. Keys look like "POST /api/v1/batch/execute" or
// "GET /api/v1/escrow/:id".
interface CompiledRoute { key: string; verb: string; path: string; regex: RegExp; }

function compileRoutes(routes: Record<string, unknown>): CompiledRoute[] {
  return Object.keys(routes).map((key) => {
    const [verb, path] = key.includes(" ") ? key.split(/\s+/) : ["*", key];
    const regex = new RegExp(
      `^${path
        .replace(/\\/g, "\\\\")
        .replace(/[$()+.?^{|}]/g, "\\$&")
        .replace(/\*/g, ".*?")
        .replace(/\[([^\]]+)\]/g, "[^/]+")
        .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, "[^/]+")
        .replace(/\//g, "\\/")}$`,
      "i"
    );
    return { key, verb: verb.toUpperCase(), path, regex };
  });
}

function normalizePath(path: string): string {
  const parts = path.split(/[?#]/)[0].split(/(%2[fF]|%5[cC])/);
  const decoded = parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      try { return decodeURIComponent(part); } catch { return part; }
    })
    .join("");
  return decoded.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/(.+?)\/+$/, "$1");
}

/**
 * Middleware: check for X-API-Key header on paid routes.
 *
 * `getPaidRoutes` returns the same object handed to paymentMiddleware. It is
 * a getter because index.ts mounts this middleware before declaring that
 * object; it is first called on the first request.
 *
 * Only requests that paymentMiddleware would charge are considered. Free
 * routes, discovery and everything else pass through untouched, with or
 * without a key — a bad key never turns a free call into a 401.
 *
 * When a valid API key is found, we intercept the response so that
 * if paymentMiddleware tries to send a 402, we suppress it and let
 * the request continue to the actual route handler.
 *
 * If no API key header → passes through untouched (x402/MPP as usual).
 */
export function createApiKeyAuthMiddleware(getPaidRoutes: () => Record<string, unknown>) {
  let compiled: CompiledRoute[] | null = null;
  const matchPaidRoute = (method: string, path: string): CompiledRoute | undefined => {
    if (!compiled) compiled = compileRoutes(getPaidRoutes());
    const normalized = normalizePath(path);
    const verb = method.toUpperCase();
    return compiled.find((r) => r.regex.test(normalized) && (r.verb === "*" || r.verb === verb));
  };

  return async function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction) {
    const apiKey = req.headers["x-api-key"] as string | undefined;

    // No API key header → skip to x402/MPP flow (no disruption)
    if (!apiKey) {
      return next();
    }

    // Not a paid route → nothing for a key to unlock
    const paidRoute = matchPaidRoute(req.method, req.path);
    if (!paidRoute) {
      return next();
    }

    try {
      const keyHash = hashApiKey(apiKey);

      const { data: row, error } = await supabase
        .from("api_keys")
        .select("*")
        .eq("api_key_hash", keyHash)
        .single();

      if (error || !row) {
        return res.status(401).json({
          error: "invalid_api_key",
          message: "The API key provided is not valid. Check your key or sign up at spraay.app/pricing.",
        });
      }

      // Check subscription status
      if (row.status !== "active") {
        return res.status(401).json({
          error: "subscription_inactive",
          message: `Your subscription is ${row.status}. Please update your payment method.`,
          status: row.status,
        });
      }

      // Route restriction (B2B keys). Empty or missing = every paid route.
      // Entries may be a path ("/api/v1/batch/execute"), a paidRoutes key
      // ("POST /api/v1/batch/execute") or a pattern path ("/api/v1/escrow/:id").
      const allowed: string[] = Array.isArray(row.allowed_routes) ? row.allowed_routes : [];
      if (allowed.length > 0) {
        const candidates = [req.path, `${req.method.toUpperCase()} ${req.path}`, paidRoute.path, paidRoute.key];
        if (!candidates.some((c) => allowed.includes(c))) {
          return res.status(403).json({ error: "api_key_not_authorized_for_route" });
        }
      }

      // Reset daily counter if it's a new day (lazy reset — no cron needed)
      const today = new Date().toISOString().slice(0, 10);
      if (row.last_reset !== today) {
        await supabase
          .from("api_keys")
          .update({ daily_calls: 0, last_reset: today })
          .eq("id", row.id);
        row.daily_calls = 0;
      }

      // Check rate limit (a null daily_limit means no daily cap)
      if (row.daily_limit != null && row.daily_calls >= row.daily_limit) {
        return res.status(429).json({
          error: "daily_limit_exceeded",
          message: `You've used ${row.daily_calls}/${row.daily_limit} calls today. Resets at midnight UTC.`,
          plan: row.plan,
          upgrade: row.plan === "starter" ? "Upgrade to Pro for 10,000 calls/day at spraay.app/pricing" : undefined,
        });
      }

      // Increment counter
      await supabase
        .from("api_keys")
        .update({ daily_calls: row.daily_calls + 1 })
        .eq("id", row.id);

      // Usage stats (docs/sql/2026-10-28-api-keys-b2b.sql). Separate,
      // fire-and-forget write so a missing column never blocks the request
      // or the daily counter above.
      supabase
        .from("api_keys")
        .update({ last_used_at: new Date().toISOString(), total_requests: (row.total_requests ?? 0) + 1 })
        .eq("id", row.id)
        .then(({ error: statsError }) => {
          if (statsError) console.warn("API key usage stats not recorded:", statsError.message);
        });

      // Mark request as API-key authenticated
      (req as any).apiKeyAuth = true;
      (req as any).apiKeyPlan = row.plan;
      (req as any).apiKeyEmail = row.email;
      (req as any).apiKeyOwner = row.owner ?? null;
      (req as any).apiKeyId = row.id;

      // Intercept 402 responses from paymentMiddleware.
      // When paymentMiddleware sees no x402 payment, it calls res.status(402),
      // sets the PAYMENT-REQUIRED header(s), then res.json (or res.send for the
      // browser paywall). We swallow all three and let the request reach the
      // route handler, so the 200 carries no challenge headers.
      const originalStatus = res.status.bind(res);
      const originalJson = res.json.bind(res);
      const originalSend = res.send.bind(res);
      const originalSetHeader = res.setHeader.bind(res);
      let blocked402 = false;

      const restore = () => {
        res.status = originalStatus as any;
        res.json = originalJson;
        res.send = originalSend;
        res.setHeader = originalSetHeader as any;
      };

      const resume = () => {
        // paymentMiddleware tried to send its 402 body — suppress it
        blocked402 = false;
        restore();
        // Continue to next middleware/route handler
        next();
        return res;
      };

      res.status = function (code: number) {
        if (code === 402 && (req as any).apiKeyAuth) {
          // Suppress the 402 — paymentMiddleware is trying to block
          blocked402 = true;
          return res; // return res for chaining but don't actually set status
        }
        return originalStatus(code);
      } as any;

      res.setHeader = function (name: string, value: any) {
        if (blocked402) return res; // challenge header for the suppressed 402
        return originalSetHeader(name, value);
      } as any;

      res.json = function (body: any) {
        if (blocked402) return resume() as any;
        return originalJson(body);
      } as any;

      res.send = function (body?: any) {
        if (blocked402) return resume() as any;
        return originalSend(body);
      } as any;

      return next();
    } catch (err) {
      console.error("API key auth error:", err);
      // On error, fall through to x402 rather than blocking
      return next();
    }
  };
}
