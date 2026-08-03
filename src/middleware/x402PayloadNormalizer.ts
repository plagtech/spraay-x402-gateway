// ============================================
// x402 v2 PAYMENT PAYLOAD NORMALIZER
// src/middleware/x402PayloadNormalizer.ts
// ============================================
//
// WHY THIS EXISTS
//
// A v2 client proves payment by echoing back the `accepts[]` entry it chose,
// as `accepted`, inside the PAYMENT-SIGNATURE header. @x402/core then matches
// that echo against its own internal requirement with a symmetric deep compare
// (`paymentRequirementsMatchAccepted` -> `deepEqual`), which requires the two
// objects to have *identical key sets*.
//
// enrich402Middleware injects a `resource` field into every advertised
// `accepts[]` entry in the 402 JSON body. That field is a v1-ism: the v2
// PaymentRequirements schema is exactly
//
//     { scheme, network, amount, asset, payTo, maxTimeoutSeconds, extra }
//
// and carries no `resource` (in v2 the resource moved to the top-level
// `resource` object on the challenge). So a client echoing our advertised body
// verbatim sends one key the server's internal requirement does not have, the
// deep compare returns false, and every v2 payment is rejected with
// "No matching payment requirements".
//
// WHAT THIS DOES
//
// Runs immediately before paymentMiddleware and drops any key from `accepted`
// that is not part of the v2 PaymentRequirements schema, then re-encodes the
// header. This is safe in both directions:
//
//   - The server's internal requirement is built by @x402/core to the v2
//     schema, so it can only ever contain those seven fields. Removing a
//     non-schema key can therefore never remove a key the server actually
//     advertised internally.
//   - `accepted` is NOT covered by the EIP-3009 signature (which signs only
//     the `authorization` tuple), so rewriting it cannot invalidate the
//     client's signature.
//
// It also guards the crash path: a payload whose `accepted` is missing or not
// an object used to reach @x402/core and surface a raw
// "Cannot destructure property 'extra' of 'accepted' as it is undefined"
// TypeError to the caller. Such payloads now have the header neutralised so
// the caller receives the normal, well-formed 402 challenge, plus a clean
// explanation via res.locals -> enrich402Middleware.
//
// SCOPE / SAFETY
//
//   - v1 (`X-PAYMENT`) requests are never touched — the header is not even
//     read. v1 matching compares only scheme+network and is unaffected.
//   - Only payloads that decode to JSON with x402Version === 2 are considered.
//   - Anything unparseable is passed through untouched so @x402/core produces
//     its own canonical error rather than one invented here.
//   - Purely additive: no route, price, or response shape changes.
// ============================================

import { Request, Response, NextFunction } from "express";

// The complete v2 PaymentRequirements field set, per
// PaymentRequirementsV2Schema in @x402/core. Anything outside this set cannot
// be part of a server-side requirement and so must not take part in matching.
const V2_REQUIREMENT_FIELDS = new Set([
  "scheme",
  "network",
  "amount",
  "asset",
  "payTo",
  "maxTimeoutSeconds",
  "extra",
]);

const PAYMENT_SIGNATURE_HEADER = "payment-signature";

export function x402PayloadNormalizer(req: Request, res: Response, next: NextFunction) {
  const raw = req.headers[PAYMENT_SIGNATURE_HEADER];

  // No v2 payment proof on this request — nothing to do. Note we deliberately
  // ignore `x-payment`: the v1 path must stay byte-identical.
  if (typeof raw !== "string" || raw.length === 0) {
    return next();
  }

  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
  } catch {
    // Not decodable — let @x402/core reject it with its own error.
    return next();
  }

  if (!payload || typeof payload !== "object" || payload.x402Version !== 2) {
    return next();
  }

  // ─── Crash-path guard ───
  // `accepted` absent or not an object: @x402/core destructures it
  // unconditionally and leaks a TypeError. Neutralise the header so the client
  // gets the standard 402 challenge it needs in order to retry correctly.
  if (!payload.accepted || typeof payload.accepted !== "object" || Array.isArray(payload.accepted)) {
    delete req.headers[PAYMENT_SIGNATURE_HEADER];
    res.locals.x402PaymentError =
      "Malformed x402 v2 payment payload: `accepted` must be an object echoing one of the advertised `accepts[]` entries.";
    return next();
  }

  // ─── Strip non-schema fields from the echoed requirement ───
  const cleaned: Record<string, unknown> = {};
  const stripped: string[] = [];

  for (const [key, value] of Object.entries(payload.accepted)) {
    if (V2_REQUIREMENT_FIELDS.has(key)) {
      cleaned[key] = value;
    } else {
      stripped.push(key);
    }
  }

  // Already spec-clean — leave the header exactly as sent.
  if (stripped.length === 0) {
    return next();
  }

  payload.accepted = cleaned;
  req.headers[PAYMENT_SIGNATURE_HEADER] = Buffer.from(JSON.stringify(payload)).toString("base64");

  // Diagnostic only; nothing branches on this.
  res.locals.x402NormalizedFields = stripped;

  return next();
}
