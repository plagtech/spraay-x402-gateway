/**
 * SCTP v0.1 — Supply Chain Task Protocol
 * "Programmable accounts payable for AI agents"
 *
 * 5 core endpoints:
 *   POST /api/v1/sctp/supplier       — Register supplier
 *   GET  /api/v1/sctp/supplier/:id   — Get supplier
 *   POST /api/v1/sctp/po             — Create purchase order
 *   GET  /api/v1/sctp/po/:id         — Get purchase order
 *   POST /api/v1/sctp/invoice        — Submit invoice
 *   GET  /api/v1/sctp/invoice/:id    — Get invoice
 *   POST /api/v1/sctp/invoice/verify — Verify invoice against PO (AI-powered)
 *   POST /api/v1/sctp/pay            — Execute payment (single or batch)
 */

import { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";

// ─── Config ──────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

// Spraay batch contract addresses per chain
const SPRAAY_CONTRACTS: Record<string, string> = {
  base: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
  ethereum: "0x15E7aEDa45094DD2E9E746FcA1C726cAd7aE58b3",
  arbitrum: "0x5be43aA67804aD84fcb890d0AE5F257fb1674302",
  polygon: "0x6d2453ab7416c99aeDCA47CF552695be5789D7ff",
  bnb: "0x3093a2951FB77b3beDfB8BA20De645F7413432C1",
  avalanche: "0x6A41Fb5F5CfE632f9446b548980dA6cE2d75afcC",
};

// USDC addresses per chain
const USDC_ADDRESSES: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  polygon: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  bnb: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
  avalanche: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
};

// ─── Lazy Supabase init ──────────────────────────────

let _supabase: any = null;
function db() {
  if (!_supabase) _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  return _supabase as any;
}

// ─── 1. POST /api/v1/sctp/supplier ───────────────────
// Register a new supplier

export async function sctpSupplierCreateHandler(req: Request, res: Response) {
  try {
    const { name, wallet, chain, preferredToken, contactEmail, metadata } = req.body;

    if (!name || !wallet) {
      return res.status(400).json({ error: "name and wallet are required" });
    }

    const { data, error } = await db()
      .from("sctp_suppliers")
      .insert({
        name,
        wallet,
        chain: chain || "base",
        preferred_token: preferredToken || "USDC",
        contact_email: contactEmail || null,
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      supplierId: data.id,
      name: data.name,
      wallet: data.wallet,
      chain: data.chain,
      preferredToken: data.preferred_token,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/v1/sctp/supplier/:id ───────────────────
// Get supplier details

export async function sctpSupplierGetHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const { data, error } = await db()
      .from("sctp_suppliers")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Supplier not found" });
    }

    return res.json({
      supplierId: data.id,
      name: data.name,
      wallet: data.wallet,
      chain: data.chain,
      preferredToken: data.preferred_token,
      contactEmail: data.contact_email,
      metadata: data.metadata,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── 2. POST /api/v1/sctp/po ────────────────────────
// Create a purchase order

export async function sctpPoCreateHandler(req: Request, res: Response) {
  try {
    const { supplierId, items, total, currency, metadata } = req.body;

    if (!supplierId || !items || total === undefined) {
      return res.status(400).json({ error: "supplierId, items, and total are required" });
    }

    // Verify supplier exists
    const { data: supplier, error: supErr } = await db()
      .from("sctp_suppliers")
      .select("id, name")
      .eq("id", supplierId)
      .single();

    if (supErr || !supplier) {
      return res.status(404).json({ error: "Supplier not found" });
    }

    const { data, error } = await db()
      .from("sctp_purchase_orders")
      .insert({
        supplier_id: supplierId,
        items,
        total,
        currency: currency || "USD",
        status: "open",
        metadata: metadata || {},
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      poId: data.id,
      supplierId: data.supplier_id,
      supplierName: supplier.name,
      items: data.items,
      total: data.total,
      currency: data.currency,
      status: data.status,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/v1/sctp/po/:id ────────────────────────
// Get purchase order details

export async function sctpPoGetHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const { data, error } = await db()
      .from("sctp_purchase_orders")
      .select("*, sctp_suppliers(name, wallet)")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Purchase order not found" });
    }

    return res.json({
      poId: data.id,
      supplierId: data.supplier_id,
      supplierName: (data as any).sctp_suppliers?.name,
      items: data.items,
      total: data.total,
      currency: data.currency,
      status: data.status,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── 3. POST /api/v1/sctp/invoice ───────────────────
// Submit an invoice

export async function sctpInvoiceSubmitHandler(req: Request, res: Response) {
  try {
    const { poId, supplierId, items, total, currency } = req.body;

    if (!supplierId || !items || total === undefined) {
      return res.status(400).json({ error: "supplierId, items, and total are required" });
    }

    // If poId given, verify it exists
    if (poId) {
      const { data: po, error: poErr } = await db()
        .from("sctp_purchase_orders")
        .select("id")
        .eq("id", poId)
        .single();
      if (poErr || !po) {
        return res.status(404).json({ error: "Purchase order not found" });
      }
    }

    const { data, error } = await db()
      .from("sctp_invoices")
      .insert({
        po_id: poId || null,
        supplier_id: supplierId,
        items,
        total,
        currency: currency || "USD",
        status: "submitted",
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      invoiceId: data.id,
      poId: data.po_id,
      supplierId: data.supplier_id,
      items: data.items,
      total: data.total,
      status: data.status,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/v1/sctp/invoice/:id ───────────────────
// Get invoice details

export async function sctpInvoiceGetHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const { data, error } = await db()
      .from("sctp_invoices")
      .select("*, sctp_suppliers(name, wallet)")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    return res.json({
      invoiceId: data.id,
      poId: data.po_id,
      supplierId: data.supplier_id,
      supplierName: (data as any).sctp_suppliers?.name,
      items: data.items,
      total: data.total,
      status: data.status,
      verification: data.verification,
      txHash: data.tx_hash,
      paidAt: data.paid_at,
      createdAt: data.created_at,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ─── 4. POST /api/v1/sctp/invoice/verify ─────────────
// Invoice verification: fast deterministic check first, AI only for fuzzy cases
// THE MAGIC ENDPOINT
//
// Strategy: speed > intelligence for v0.1
//   1. Exact match? → return instantly (< 50ms)
//   2. Fuzzy mismatch? → call AI for deeper analysis
//   3. AI fails? → return deterministic result anyway

export async function sctpInvoiceVerifyHandler(req: Request, res: Response) {
  try {
    const startTime = Date.now();
    const { invoiceId } = req.body;

    if (!invoiceId) {
      return res.status(400).json({ error: "invoiceId is required" });
    }

    // Fetch invoice
    const { data: invoice, error: invErr } = await db()
      .from("sctp_invoices")
      .select("*")
      .eq("id", invoiceId)
      .single();

    if (invErr || !invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }

    // Fetch PO if linked
    let po = null;
    if (invoice.po_id) {
      const { data: poData } = await db()
        .from("sctp_purchase_orders")
        .select("*")
        .eq("id", invoice.po_id)
        .single();
      po = poData;
    }

    // ── FAST PATH: deterministic check first ──────────
    const fastResult = deterministicVerify(invoice, po);

    // If exact match or clear mismatch, return instantly — no AI needed
    if (fastResult.status === "matched" || fastResult.status === "mismatched") {
      const verification = { ...fastResult, verifiedBy: "deterministic", latencyMs: Date.now() - startTime };

      // Store and return
      await db()
        .from("sctp_invoices")
        .update({
          verification,
          status: verification.recommendation === "approve_payment" ? "verified" : "review_required",
        })
        .eq("id", invoiceId);

      return res.json({ invoiceId, poId: invoice.po_id, ...verification });
    }

    // ── SLOW PATH: fuzzy mismatch → ask AI ────────────
    let verification;

    try {
      const prompt = buildVerificationPrompt(invoice, po);
      const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 500,
          temperature: 0.1,
        }),
      });

      const aiData = await aiResponse.json();
      const content = aiData.choices?.[0]?.message?.content || "";

      try {
        verification = JSON.parse(content);
      } catch {
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        verification = jsonMatch ? JSON.parse(jsonMatch[0]) : fastResult;
      }
      verification.verifiedBy = "ai";
    } catch {
      // AI failed — use the deterministic result (always have an answer)
      verification = fastResult;
      verification.verifiedBy = "deterministic_fallback";
    }

    verification.latencyMs = Date.now() - startTime;

    // Store result
    await db()
      .from("sctp_invoices")
      .update({
        verification,
        status: verification.recommendation === "approve_payment" ? "verified" : "review_required",
      })
      .eq("id", invoiceId);

    return res.json({ invoiceId, poId: invoice.po_id, ...verification });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ── Deterministic verification (instant) ─────────────

function deterministicVerify(invoice: any, po: any | null) {
  const invoiceItems = invoice.items || [];
  const invoiceTotal = Number(invoice.total);

  // Check if line items sum correctly
  const itemsSum = invoiceItems.reduce(
    (sum: number, item: any) => sum + (item.quantity || 1) * (item.unitPrice || item.price || 0),
    0
  );
  const itemsSumMatch = Math.abs(itemsSum - invoiceTotal) < 0.01;

  if (!po) {
    // No PO — validate invoice internal consistency
    return {
      status: itemsSumMatch ? "valid" : "needs_review",
      confidence: itemsSumMatch ? 0.90 : 0.50,
      totalMatch: itemsSumMatch,
      itemsMatch: true,
      discrepancies: itemsSumMatch ? [] : [`Line items sum to ${itemsSum.toFixed(2)}, invoice total is ${invoiceTotal.toFixed(2)}`],
      recommendation: itemsSumMatch ? "approve_payment" : "review_required",
    };
  }

  // Compare against PO
  const poTotal = Number(po.total);
  const poItems = po.items || [];
  const totalMatch = Math.abs(invoiceTotal - poTotal) < 0.01;
  const itemCountMatch = invoiceItems.length === poItems.length;

  // Deep item comparison — check if items match by description + quantity + price
  let itemsExactMatch = false;
  if (itemCountMatch) {
    itemsExactMatch = invoiceItems.every((invItem: any, i: number) => {
      const poItem = poItems[i];
      const descMatch =
        (invItem.description || "").toLowerCase().trim() ===
        (poItem.description || "").toLowerCase().trim();
      const qtyMatch = Number(invItem.quantity) === Number(poItem.quantity);
      const priceMatch =
        Math.abs(Number(invItem.unitPrice || invItem.price || 0) - Number(poItem.unitPrice || poItem.price || 0)) < 0.001;
      return descMatch && qtyMatch && priceMatch;
    });
  }

  const discrepancies: string[] = [];
  if (!totalMatch) discrepancies.push(`Total: PO ${poTotal.toFixed(2)} vs Invoice ${invoiceTotal.toFixed(2)}`);
  if (!itemCountMatch) discrepancies.push(`Items: PO has ${poItems.length}, Invoice has ${invoiceItems.length}`);

  // EXACT MATCH — return instantly, no AI
  if (totalMatch && itemsExactMatch) {
    return {
      status: "matched" as const,
      confidence: 0.99,
      totalMatch: true,
      itemsMatch: true,
      discrepancies: [],
      recommendation: "approve_payment" as const,
    };
  }

  // CLEAR MISMATCH — totals way off or items completely different
  if (!totalMatch && Math.abs(invoiceTotal - poTotal) / poTotal > 0.10) {
    return {
      status: "mismatched" as const,
      confidence: 0.95,
      totalMatch: false,
      itemsMatch: itemCountMatch,
      discrepancies,
      recommendation: "reject" as const,
    };
  }

  // FUZZY — totals close but not exact, or items similar but not identical
  // → send to AI for deeper analysis
  return {
    status: "needs_review" as const,
    confidence: 0.60,
    totalMatch,
    itemsMatch: itemCountMatch && !itemsExactMatch,
    discrepancies,
    recommendation: "review_required" as const,
  };
}

// ── AI verification prompt builder ───────────────────

function buildVerificationPrompt(invoice: any, po: any | null): string {
  if (po) {
    return `You are an invoice verification system. Compare this invoice against its purchase order.

PO: ${JSON.stringify({ id: po.id, items: po.items, total: po.total, currency: po.currency })}
INVOICE: ${JSON.stringify({ id: invoice.id, items: invoice.items, total: invoice.total, currency: invoice.currency })}

The totals are close but not exact, or line items have minor differences. Determine if this is an acceptable match (rounding, minor description variations) or a real discrepancy.

Respond ONLY with JSON:
{"status":"matched"|"mismatched"|"partial_match","confidence":0.0-1.0,"totalMatch":true|false,"itemsMatch":true|false,"discrepancies":["..."],"recommendation":"approve_payment"|"review_required"|"reject"}`;
  }

  return `You are an invoice verification system. Validate this standalone invoice.

INVOICE: ${JSON.stringify({ id: invoice.id, items: invoice.items, total: invoice.total, currency: invoice.currency })}

Check: do items sum correctly? Are prices reasonable?

Respond ONLY with JSON:
{"status":"valid"|"invalid"|"needs_review","confidence":0.0-1.0,"totalMatch":true|false,"itemsMatch":true|false,"discrepancies":["..."],"recommendation":"approve_payment"|"review_required"|"reject"}`;
}

// ─── 5. POST /api/v1/sctp/pay ────────────────────────
// Execute payment — single or batch
// Wraps existing Spraay batch contracts

export async function sctpPayExecuteHandler(req: Request, res: Response) {
  try {
    const { invoiceId, supplierId, amount, token, chain, payments } = req.body;

    // Batch mode
    if (payments && Array.isArray(payments)) {
      const results = [];
      for (const p of payments) {
        const result = await executeSinglePayment(p);
        results.push(result);
      }
      return res.json({
        batch: true,
        count: results.length,
        payments: results,
      });
    }

    // Single mode
    if (!supplierId || !amount) {
      return res.status(400).json({
        error: "supplierId and amount are required (or provide payments[] for batch)",
      });
    }

    const result = await executeSinglePayment({
      invoiceId,
      supplierId,
      amount,
      token: token || "USDC",
      chain: chain || "base",
    });

    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

async function executeSinglePayment(params: {
  invoiceId?: string;
  supplierId: string;
  amount: number;
  token?: string;
  chain?: string;
}) {
  const { invoiceId, supplierId, amount, token = "USDC", chain = "base" } = params;

  // Fetch supplier wallet
  const { data: supplier, error: supErr } = await db()
    .from("sctp_suppliers")
    .select("wallet, name")
    .eq("id", supplierId)
    .single();

  if (supErr || !supplier) {
    return { error: "Supplier not found", supplierId };
  }

  const contractAddress = SPRAAY_CONTRACTS[chain];
  const usdcAddress = USDC_ADDRESSES[chain];

  if (!contractAddress) {
    return { error: `Chain ${chain} not supported`, supplierId };
  }

  // Record payment intent
  const { data: payment, error: payErr } = await db()
    .from("sctp_payments")
    .insert({
      invoice_id: invoiceId || null,
      supplier_id: supplierId,
      amount,
      token,
      chain,
      status: "pending",
    })
    .select()
    .single();

  if (payErr) {
    return { error: payErr.message, supplierId };
  }

  // NOTE: Actual on-chain execution would go here.
  // For v0.1, we record the payment intent and return the tx params
  // that the calling agent can execute with their own signer.
  //
  // In production, this integrates with the Agent Wallet for
  // autonomous execution, or returns unsigned tx data.

  const txParams = {
    to: contractAddress,
    chain,
    method: "batchSendToken",
    args: {
      token: usdcAddress,
      recipients: [supplier.wallet],
      amounts: [String(Math.floor(amount * 1e6))], // USDC has 6 decimals
    },
  };

  // Update invoice status if linked
  if (invoiceId) {
    await db()
      .from("sctp_invoices")
      .update({ status: "payment_initiated" })
      .eq("id", invoiceId);
  }

  return {
    paymentId: payment.id,
    status: "processing",
    invoiceId: invoiceId || null,
    supplierId,
    supplierName: supplier.name,
    supplierWallet: supplier.wallet,
    amount,
    token,
    chain,
    estimatedSettlement: chain === "base" ? "~2s" : chain === "arbitrum" ? "~2s" : "~15s",
    txParams,
    spraayContract: contractAddress,
  };
}
