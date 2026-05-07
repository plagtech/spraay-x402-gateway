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

/**
 * Middleware: check for X-API-Key header.
 * 
 * When a valid API key is found, we intercept the response so that
 * if paymentMiddleware tries to send a 402, we suppress it and let
 * the request continue to the actual route handler.
 * 
 * If no API key header → passes through untouched (x402/MPP as usual).
 */
export async function apiKeyAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string | undefined;

  // No API key header → skip to x402/MPP flow (no disruption)
  if (!apiKey) {
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

    // Reset daily counter if it's a new day (lazy reset — no cron needed)
    const today = new Date().toISOString().slice(0, 10);
    if (row.last_reset !== today) {
      await supabase
        .from("api_keys")
        .update({ daily_calls: 0, last_reset: today })
        .eq("id", row.id);
      row.daily_calls = 0;
    }

    // Check rate limit
    if (row.daily_calls >= row.daily_limit) {
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

    // Mark request as API-key authenticated
    (req as any).apiKeyAuth = true;
    (req as any).apiKeyPlan = row.plan;
    (req as any).apiKeyEmail = row.email;

    // Intercept 402 responses from paymentMiddleware.
    // When paymentMiddleware sees no x402 payment, it sends 402.
    // We override res.status so that if a 402 is about to be sent,
    // we skip it and let the request reach the route handler.
    const originalStatus = res.status.bind(res);
    const originalJson = res.json.bind(res);
    let blocked402 = false;

    res.status = function (code: number) {
      if (code === 402 && (req as any).apiKeyAuth) {
        // Suppress the 402 — paymentMiddleware is trying to block
        blocked402 = true;
        return res; // return res for chaining but don't actually set status
      }
      return originalStatus(code);
    } as any;

    res.json = function (body: any) {
      if (blocked402) {
        // paymentMiddleware tried to send 402 JSON response — suppress it
        blocked402 = false;
        // Reset status and json back to originals
        res.status = originalStatus as any;
        res.json = originalJson;
        // Continue to next middleware/route handler
        return next() as any;
      }
      return originalJson(body);
    } as any;

    return next();
  } catch (err) {
    console.error("API key auth error:", err);
    // On error, fall through to x402 rather than blocking
    return next();
  }
}
