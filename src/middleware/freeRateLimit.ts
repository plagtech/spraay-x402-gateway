// src/middleware/freeRateLimit.ts
import rateLimit from "express-rate-limit";

const sharedOpts = {
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: any) => req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip,
};

/** Standard free tier: 60 req/min per IP */
export const freeLimit = rateLimit({
  ...sharedOpts,
  windowMs: 60_000, max: 60,
  message: { error: "Free tier rate limit exceeded", limit: "60 req/min", upgrade: "Paid endpoints at gateway.spraay.app have higher limits via x402" },
});

/** Tighter limit for outbound-fetch endpoints (x402-check): 20 req/min */
export const fetchLimit = rateLimit({
  ...sharedOpts,
  windowMs: 60_000, max: 20,
  message: { error: "Free tier rate limit exceeded for fetch endpoints", limit: "20 req/min", upgrade: "Paid endpoints at gateway.spraay.app have higher limits via x402" },
});
