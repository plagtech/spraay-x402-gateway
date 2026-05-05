/**
 * Spraay Gateway — MPP (Machine Payments Protocol) Middleware
 * 
 * Handles payment verification for agents using the MPP protocol.
 * Uses the `mppx` npm package with Express integration.
 * 
 * This middleware:
 *   1. Checks req.paymentProtocol (set by protocolDetector)
 *   2. If "mpp" or "none" (first request, no credential yet) → handle via mppx
 *   3. If "x402" or "l402" → skip, let downstream middleware handle
 * 
 * IMPORTANT: When protocol is "none", both this middleware and x402's
 * paymentMiddleware could try to claim the request. We solve this by:
 *   - MPP middleware runs FIRST
 *   - For "none" protocol on a paid route, MPP returns a MULTI-PROTOCOL
 *     402 response that includes both MPP and x402 payment instructions
 *   - OR: we let x402 handle "none" (since it's the existing default)
 *     and MPP only activates when it sees "Authorization: Payment"
 * 
 * For Phase 1, we take the simpler approach: MPP middleware ONLY handles
 * requests that arrive with MPP credentials. Requests with no credentials
 * continue to x402 (existing behavior preserved exactly).
 * 
 * Install: npm install mppx stripe
 * 
 * Env vars:
 *   MPP_SECRET_KEY    — random 32-byte base64 string for challenge signing
 *   MPP_ENABLED       — "true" to activate MPP (feature flag)
 *   MPP_RECIPIENT     — payment recipient address (defaults to PAY_TO_ADDRESS)
 *   STRIPE_SECRET_KEY — (optional, Phase 1b) for fiat SPT payments
 */

import { Request, Response, NextFunction } from "express";
import { getEndpointPrice } from "../config/pricing.js";

// ─── Feature flag guard ───────────────────────────────────────────────
const MPP_ENABLED = process.env.MPP_ENABLED === "true";

// ─── Lazy-load mppx to avoid crash if not installed yet ───────────────
let mppxInstance: any = null;
let mppxInitError: string | null = null;

async function getMppx() {
  if (mppxInstance) return mppxInstance;
  if (mppxInitError) return null;

  try {
    // Dynamic import — won't crash the gateway if mppx isn't installed
    const { Mppx, tempo } = await import("mppx/server");

    const PATH_USD = "0x20c0000000000000000000000000000000000000";
    const recipient = (process.env.MPP_RECIPIENT || process.env.PAY_TO_ADDRESS) as `0x${string}`;
    const secretKey = process.env.MPP_SECRET_KEY;

    if (!secretKey) {
      mppxInitError = "MPP_SECRET_KEY not set";
      console.warn("⚠️  MPP: MPP_SECRET_KEY not set — MPP payments disabled");
      return null;
    }
    if (!recipient) {
      mppxInitError = "MPP_RECIPIENT / PAY_TO_ADDRESS not set";
      console.warn("⚠️  MPP: No recipient address — MPP payments disabled");
      return null;
    }

    mppxInstance = Mppx.create({
      secretKey,
      methods: [
        tempo({
          currency: PATH_USD,
          recipient,
          // Remove testnet: true for mainnet
          ...(process.env.MPP_TESTNET === "true" ? { testnet: true } : {}),
        }),
      ],
    });

    console.log("✅ MPP: Initialized with Tempo (pathUSD) →", recipient);
    return mppxInstance;

  } catch (err: any) {
    mppxInitError = err.message || "Failed to load mppx";
    console.warn(`⚠️  MPP: Could not initialize mppx — ${mppxInitError}`);
    console.warn("   Run: npm install mppx");
    return null;
  }
}

// ─── Convert Express req to Fetch API Request (mppx uses Fetch API) ──
function expressToFetchRequest(req: Request): globalThis.Request {
  const protocol = req.protocol || "https";
  const host = req.get("host") || "gateway.spraay.app";
  const url = `${protocol}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
  }

  const init: RequestInit = {
    method: req.method,
    headers,
  };

  // Include body for POST/PUT/PATCH
  if (["POST", "PUT", "PATCH"].includes(req.method) && req.body) {
    init.body = JSON.stringify(req.body);
  }

  return new globalThis.Request(url, init);
}

// ─── Main MPP Middleware ──────────────────────────────────────────────

/**
 * MPP payment middleware for Spraay gateway.
 * 
 * Mount BEFORE x402 paymentMiddleware in the Express chain.
 * Only intercepts requests with "Authorization: Payment" headers.
 * All other requests pass through untouched to x402.
 */
export function mppMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Gate 1: Feature flag
  if (!MPP_ENABLED) {
    return next();
  }

  // Gate 2: Only handle MPP-protocol requests
  // If protocol is "x402", "l402", or "none" → skip, let x402 handle
  if (req.paymentProtocol !== "mpp") {
    return next();
  }

  // Gate 3: Check if this is a paid route
  const price = getEndpointPrice(req.method, req.path);
  if (!price) {
    // Not a paid route — skip payment processing entirely
    return next();
  }

  // Handle MPP payment asynchronously
  handleMppPayment(req, res, next, price.price, price.category).catch((err) => {
    console.error("MPP payment error:", err);
    res.status(500).json({
      error: "MPP payment processing failed",
      protocol: "mpp",
    });
  });
}

async function handleMppPayment(
  req: Request,
  res: Response,
  next: NextFunction,
  priceUSD: string,
  category: string
): Promise<void> {
  const mppx = await getMppx();
  if (!mppx) {
    // mppx not available — return error, don't fall through to x402
    // (the agent explicitly sent MPP headers, so they expect MPP)
    res.status(503).json({
      error: "MPP payments temporarily unavailable",
      protocol: "mpp",
      fallback: "Use x402 protocol (X-PAYMENT header) instead",
    });
    return;
  }

  // Convert Express request to Fetch API Request for mppx
  const fetchReq = expressToFetchRequest(req);

  // Run mppx charge handler
  const mppResponse: globalThis.Response = await mppx.charge({
    amount: priceUSD,
  })(fetchReq);

  // If 402 — payment required, forward the MPP challenge to the agent
  if (mppResponse.status === 402) {
    const challengeBody = await mppResponse.json();

    // Add Spraay metadata to the challenge response
    res.status(402).json({
      ...challengeBody,
      spraay: {
        gateway: "gateway.spraay.app",
        version: "3.7.0",
        protocol: "mpp",
        category,
        priceUSD: `$${priceUSD}`,
        alternativeProtocols: ["x402"],
      },
    });
    return;
  }

  // Payment verified — extract receipt and continue to route handler
  const receiptHeader = mppResponse.headers.get("payment-receipt");
  if (receiptHeader) {
    // Attach receipt to Express response headers
    res.setHeader("Payment-Receipt", receiptHeader);
  }

  // Tag the request so gateway-events middleware can log the protocol
  req.mppReceipt = {
    protocol: "mpp",
    amount: priceUSD,
    category,
    timestamp: new Date().toISOString(),
  };

  // Continue to the actual route handler
  next();
}

// ─── Initialization (call on startup to pre-warm) ─────────────────────
export async function initMpp(): Promise<void> {
  if (!MPP_ENABLED) {
    console.log("ℹ️  MPP: Disabled (set MPP_ENABLED=true to activate)");
    return;
  }
  await getMppx();
}
