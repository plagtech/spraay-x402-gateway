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
import { GATEWAY_VERSION } from "../lib/version.js";
// 💧 Robinhood USDG rail under MPP (additive): registered as the spec `evm`
// charge method ONLY when the rail is enabled; otherwise this file behaves
// exactly as before (single tempo method, `mppx.charge`).
import { getRobinhoodUsdgRail, usdToUsdgUnits } from "../rails/robinhoodUsdg.js";
import { createRobinhoodUsdgMppMethod } from "../rails/robinhoodUsdgMpp.js";

// ─── Feature flag guard ───────────────────────────────────────────────
const MPP_ENABLED = process.env.MPP_ENABLED === "true";

// ─── Lazy-load mppx to avoid crash if not installed yet ───────────────
let mppxInstance: any = null;
let mppxInitError: string | null = null;
/** True once the Robinhood `evm/charge` method is registered alongside tempo. */
let mppEvmRegistered = false;

async function getMppx() {
  if (mppxInstance) return mppxInstance;
  if (mppxInitError) return null;

  try {
    // Dynamic import — won't crash the gateway if mppx isn't installed
    const { Mppx, tempo } = await import("mppx/server");
    const { privateKeyToAccount } = await import("viem/accounts");

    const PATH_USD = "0x20c0000000000000000000000000000000000000";
    const recipient = (process.env.MPP_RECIPIENT || process.env.PAY_TO_ADDRESS) as `0x${string}`;
    const secretKey = process.env.MPP_SECRET_KEY;
    const walletKey = process.env.MPP_WALLET_PRIVATE_KEY;

    if (!secretKey) {
      mppxInitError = "MPP_SECRET_KEY not set";
      console.warn("⚠️  MPP: MPP_SECRET_KEY not set — MPP payments disabled");
      return null;
    }
    if (!walletKey) {
      mppxInitError = "MPP_WALLET_PRIVATE_KEY not set";
      console.warn("⚠️  MPP: MPP_WALLET_PRIVATE_KEY not set — MPP payments disabled");
      return null;
    }

    const account = privateKeyToAccount(walletKey as `0x${string}`);

    const methods: any[] = [
      tempo({
        currency: PATH_USD,
        account,
        ...(process.env.MPP_TESTNET === "true" ? { testnet: true } : {}),
      }),
    ];

    // Robinhood USDG (evm/charge, EIP-3009) — additive, only when the rail
    // has its facilitator key. Failure to build it never disables tempo.
    const rail = getRobinhoodUsdgRail();
    if (rail.enabled) {
      try {
        methods.push(await createRobinhoodUsdgMppMethod(rail));
        mppEvmRegistered = true;
      } catch (err: any) {
        console.warn(`⚠️  MPP: could not register Robinhood USDG evm/charge method — ${err?.message || err}`);
      }
    }

    mppxInstance = Mppx.create({ secretKey, methods });

    console.log("✅ MPP: Initialized with Tempo (pathUSD) →", recipient,
      mppEvmRegistered ? `+ evm/charge USDG on eip155:4663 → ${rail.payTo}` : "");
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

  // Run mppx charge handler.
  //   - tempo only (today's behaviour): `mppx.charge({ amount })`
  //   - tempo + Robinhood USDG: `mppx.compose(...)` presents BOTH methods in the
  //     402 (one WWW-Authenticate per method) and routes the credential by
  //     method name. The tempo-only path is untouched.
  //
  // mppx 0.6.x resolves to a WRAPPER, not a Fetch Response:
  //   { status: 402, challenge: Response }            — challenge / rejected credential
  //   { status: 200, withReceipt(response?) => Response } — paid; NOTE the charge has
  //                                                     ALREADY settled inside verify()
  // Handling mirrors mppx's own Express adapter (node_modules/mppx/src/middlewares/express.ts),
  // copied inline rather than imported.
  let result: any;
  if (mppEvmRegistered && typeof mppx.compose === "function") {
    result = await mppx.compose(
      ["tempo/charge", { amount: priceUSD }],
      ["evm/charge", { amount: usdToUsdgUnits(Number(priceUSD)) }],
    )(fetchReq);
  } else {
    result = await mppx.charge({
      amount: priceUSD,
    })(fetchReq);
  }

  // Defensive fallback: a bare Fetch Response (older/future mppx shape).
  if (result instanceof globalThis.Response) {
    if (result.status === 402) {
      const wwwAuth = collectWwwAuthenticate(result);
      if (wwwAuth.length) res.setHeader("WWW-Authenticate", wwwAuth.length === 1 ? wwwAuth[0] : wwwAuth);
      await sendChallenge(res, result, priceUSD, category);
      return;
    }
    const receiptHeader = result.headers.get("payment-receipt");
    if (receiptHeader) res.setHeader("Payment-Receipt", receiptHeader);
    markPaidAndContinue(req, next, priceUSD, category);
    return;
  }

  // Challenge branch — no credential accepted (missing, malformed, expired, failed verify).
  if (result && result.status === 402) {
    const challenge = result.challenge as globalThis.Response;
    // Forward every WWW-Authenticate as a SEPARATE header (compose comma-joins them).
    const wwwAuth = collectWwwAuthenticate(challenge);
    if (wwwAuth.length) res.setHeader("WWW-Authenticate", wwwAuth.length === 1 ? wwwAuth[0] : wwwAuth);
    const cacheControl = challenge.headers.get("cache-control");
    if (cacheControl) res.setHeader("Cache-Control", cacheControl);
    await sendChallenge(res, challenge, priceUSD, category);
    return;
  }

  if (!result || result.status !== 200 || typeof result.withReceipt !== "function") {
    throw new Error(`Unexpected mppx result shape (status=${result?.status})`);
  }

  // Receipt branch. A method may own the whole response (management action,
  // e.g. session channel open) — then the route handler must NOT run.
  let managementResponse: globalThis.Response | null;
  try {
    managementResponse = result.withReceipt() as globalThis.Response;
  } catch (err: any) {
    if (err instanceof Error && err.message === "withReceipt() requires a response argument") {
      managementResponse = null;
    } else {
      throw err;
    }
  }
  if (managementResponse) {
    res.status(managementResponse.status);
    managementResponse.headers.forEach((v, k) => res.setHeader(k, v));
    if (managementResponse.body === null) {
      res.end();
      return;
    }
    res.send(Buffer.from(await managementResponse.arrayBuffer()));
    return;
  }

  // Payment verified — the receipt is independent of the body, so take it from an empty response.
  const receiptHeader = (result.withReceipt(new globalThis.Response(null)) as globalThis.Response)
    .headers.get("payment-receipt");
  if (receiptHeader) {
    // Attach receipt to Express response headers
    res.setHeader("Payment-Receipt", receiptHeader);
  }

  markPaidAndContinue(req, next, priceUSD, category);
}

/**
 * Marks the request as paid via MPP and hands it to the route.
 * `req.mppPaid` makes the x402 gate (solanaBypass wrapper) stand aside —
 * without it an MPP-paid request would be 402'd AFTER being charged.
 */
function markPaidAndContinue(req: Request, next: NextFunction, priceUSD: string, category: string): void {
  req.mppPaid = true;

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

/** Forward the challenge body (JSON merged with Spraay metadata; raw otherwise). */
async function sendChallenge(
  res: Response,
  challenge: globalThis.Response,
  priceUSD: string,
  category: string,
): Promise<void> {
  const text = await challenge.text();
  let challengeBody: unknown = {};
  if (text.trim() !== "") {
    try {
      challengeBody = JSON.parse(text);
    } catch {
      challengeBody = undefined;
    }
  }

  if (challengeBody === null || typeof challengeBody !== "object" || Array.isArray(challengeBody)) {
    // Not a JSON object — send it as-is with mppx's status and content type.
    const contentType = challenge.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.status(challenge.status).send(text);
    return;
  }

  // Add Spraay metadata to the challenge response
  res.status(challenge.status).json({
    ...(challengeBody as Record<string, unknown>),
    spraay: {
      gateway: "gateway.spraay.app",
      version: GATEWAY_VERSION,
      protocol: "mpp",
      category,
      priceUSD: `$${priceUSD}`,
      alternativeProtocols: ["x402"],
      ...(mppEvmRegistered ? { methods: ["tempo/charge", "evm/charge"], evm: { network: "eip155:4663", currency: "USDG", credentialTypes: ["authorization"] } } : {}),
    },
  });
}

/**
 * Fetch `Headers` joins repeated WWW-Authenticate values with ", " (mppx's
 * compose() appends one per method). Split them back into one string per
 * challenge: a new challenge starts at a top-level comma followed by
 * `token SP` (RFC 9110 §11.6.1) — an auth-param would be `token=`.
 */
export function collectWwwAuthenticate(response: globalThis.Response): string[] {
  const joined = response.headers.get("www-authenticate");
  if (!joined) return [];
  return splitChallenges(joined);
}

export function splitChallenges(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inQuotes = false;
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inQuotes = false;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === "," && /^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]+[^\s=]/.test(value.slice(i + 1))) {
      const part = value.slice(start, i).trim();
      if (part) out.push(part);
      start = i + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** @internal Test seam — inject a stub mppx instance (never used in production code). */
export function __setMppxForTests(instance: any, opts: { evmRegistered?: boolean } = {}): void {
  mppxInstance = instance;
  mppxInitError = null;
  mppEvmRegistered = opts.evmRegistered === true;
}

// ─── Initialization (call on startup to pre-warm) ─────────────────────
export async function initMpp(): Promise<void> {
  if (!MPP_ENABLED) {
    console.log("ℹ️  MPP: Disabled (set MPP_ENABLED=true to activate)");
    return;
  }
  await getMppx();
}
