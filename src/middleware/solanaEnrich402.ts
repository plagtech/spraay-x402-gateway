/**
 * 💧 Spraay x402 Gateway — Solana 402 Enrichment Patch
 * src/middleware/solanaEnrich402.ts
 *
 * This is a PATCH to the existing enrich402Middleware. It wraps
 * res.json a second time to inject the Solana `accepts` option
 * into 402 responses, AFTER enrich402 has done its work.
 *
 * The result: agents get both payment options in the 402 body:
 *   - accepts[0] = EVM x402 (from @x402/express, unchanged)
 *   - solana_accepts = Solana SPL USDC option (new)
 *
 * We use `solana_accepts` instead of modifying the x402 `accepts[]`
 * array to avoid breaking x402 protocol parsers that expect only
 * EVM scheme objects in that array.
 *
 * PLACEMENT: register AFTER enrich402Middleware but BEFORE paymentMiddleware.
 *
 *   app.use(enrich402Middleware);          // existing
 *   app.use(solanaEnrich402Middleware);    // ← NEW
 *   app.use(protocolDetectorMiddleware);   // existing
 *   ...
 */

import type { Request, Response, NextFunction } from "express";

const SOLANA_ENABLED = process.env.SOLANA_PAYMENTS_ENABLED === "true";
const SOLANA_RECEIVE_ADDRESS = process.env.SOLANA_RECEIVE_ADDRESS || "";
const SOLANA_CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function solanaEnrich402Middleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // If Solana isn't enabled, skip entirely — zero overhead
  if (!SOLANA_ENABLED || !SOLANA_RECEIVE_ADDRESS) {
    next();
    return;
  }

  // If this request already paid via Solana, skip enrichment
  // (the response won't be a 402)
  if ((req as any).solanaPaid) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = function (body: any): Response {
    // Only enrich 402 responses
    if (res.statusCode !== 402) {
      return originalJson(body);
    }

    // Inject Solana payment option alongside existing x402 fields
    const enrichedBody = {
      ...body,
      solana_accepts: {
        chain: "solana",
        cluster: SOLANA_CLUSTER,
        receiveAddress: SOLANA_RECEIVE_ADDRESS,
        usdcMint: USDC_MINT,
        txHeader: "X-Solana-Tx",
        // Pull the price from the existing x402 accepts if available,
        // or from the body-level price field
        amountRequired: extractPrice(body),
        protocol: "spl-transfer",
        instructions: "Send USDC to receiveAddress, then retry with X-Solana-Tx: <signature>",
      },
    };

    return originalJson(enrichedBody);
  };

  next();
}

/**
 * Extract the USD price from the x402 402 body.
 * The @x402/express library puts it in accepts[0].maxAmountRequired
 * with a "$" prefix.
 */
function extractPrice(body: any): string {
  try {
    const x402Price = body?.accepts?.[0]?.maxAmountRequired;
    if (x402Price) {
      // Strip "$" prefix if present
      return String(x402Price).replace(/^\$/, "");
    }
  } catch {}
  return "0.01"; // fallback
}
