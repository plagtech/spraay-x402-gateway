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
import {
  JsonRpcProvider,
  Contract,
  Interface,
  isAddress,
  parseUnits,
  formatUnits,
} from "ethers";

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

// Numeric chain IDs (EIP-155) for the transaction payloads
const CHAIN_IDS: Record<string, number> = {
  base: 8453,
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  bnb: 56,
  avalanche: 43114,
};

// Public RPC fallbacks; Alchemy used when key is present
const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY || "";
const RPC_URLS: Record<string, string> = ALCHEMY_KEY
  ? {
      base: `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      ethereum: `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      polygon: `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      bnb: `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
      avalanche: `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`,
    }
  : {
      base: "https://mainnet.base.org",
      ethereum: "https://eth.llamarpc.com",
      arbitrum: "https://arb1.arbitrum.io/rpc",
      polygon: "https://polygon-rpc.com",
      bnb: "https://bsc-dataseed.binance.org",
      avalanche: "https://api.avax.network/ext/bc/C/rpc",
    };

// USDC is 6 decimals on every supported chain (verified against contracts).
// Different tokens would need their own decimals — but SCTP only pays USDC for now.
const USDC_DECIMALS = 6;

// Spraay V2 batch contract ABI (matches payroll.ts) + ERC-20 minimum
const SPRAAY_V2_ABI = [
  "function batchTransfer(address token, address[] calldata recipients, uint256[] calldata amounts) external",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// Protocol fee: 0.3% (matches payroll.ts)
const PROTOCOL_FEE_BPS = 30;

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
    let verification: any;

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
    const { invoiceId, supplierId, amount, token, chain, payments, sender } = req.body || {};

    // ── Resolve which chain we're on and validate it ──
    const chainKey = (chain || (payments?.[0]?.chain) || "base").toLowerCase();
    if (!SPRAAY_CONTRACTS[chainKey]) {
      return res.status(400).json({
        error: `Chain "${chainKey}" not supported`,
        supportedChains: Object.keys(SPRAAY_CONTRACTS),
      });
    }
    // Only USDC is supported for SCTP payments today.
    const tokenSymbol = (token || payments?.[0]?.token || "USDC").toUpperCase();
    if (tokenSymbol !== "USDC") {
      return res.status(400).json({
        error: `Token "${tokenSymbol}" not supported for SCTP payments`,
        supportedTokens: ["USDC"],
        note: "USDC is currently the only supported settlement token. More tokens coming soon.",
      });
    }
    if (sender && !isAddress(sender)) {
      return res.status(400).json({ error: "Invalid sender address" });
    }

    // ── Normalize to a list of payment line items ──
    let items: Array<{ invoiceId?: string; supplierId: string; amount: number }>;
    let isBatch = false;
    if (Array.isArray(payments) && payments.length > 0) {
      isBatch = true;
      items = payments.map((p: any) => ({
        invoiceId: p.invoiceId,
        supplierId: p.supplierId,
        amount: Number(p.amount),
      }));
    } else {
      if (!supplierId || amount === undefined || amount === null) {
        return res.status(400).json({
          error: "supplierId and amount are required (or provide payments[] for batch)",
        });
      }
      items = [{ invoiceId, supplierId, amount: Number(amount) }];
    }

    // Validate each item up front before we touch the DB or chain.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.supplierId || typeof it.supplierId !== "string") {
        return res.status(400).json({ error: `payments[${i}]: missing supplierId` });
      }
      if (!isFinite(it.amount) || it.amount <= 0) {
        return res.status(400).json({ error: `payments[${i}]: amount must be a positive number` });
      }
    }
    if (items.length > 200) {
      return res.status(400).json({ error: "Max 200 payments per batch" });
    }

    // ── Look up every supplier wallet in one query ──
    const supplierIds = items.map((it) => it.supplierId);
    const { data: suppliers, error: supErr } = await db()
      .from("sctp_suppliers")
      .select("id, name, wallet")
      .in("id", supplierIds);
    if (supErr) {
      return res.status(500).json({ error: `Supplier lookup failed: ${supErr.message}` });
    }
    const supplierMap = new Map<string, { id: string; name: string; wallet: string }>();
    for (const s of suppliers || []) supplierMap.set(s.id, s);

    // Reject if any supplier is missing or has no/invalid wallet.
    const recipients: string[] = [];
    const amounts: bigint[] = [];
    const breakdown: any[] = [];
    let totalRaw = 0n;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const sup = supplierMap.get(it.supplierId);
      if (!sup) {
        return res.status(404).json({ error: `Supplier not found: ${it.supplierId}`, index: i });
      }
      if (!sup.wallet || !isAddress(sup.wallet)) {
        return res.status(422).json({
          error: `Supplier ${it.supplierId} has no valid wallet address on file`,
          index: i,
        });
      }
      const amountRaw = parseUnits(it.amount.toString(), USDC_DECIMALS);
      recipients.push(sup.wallet);
      amounts.push(amountRaw);
      totalRaw += amountRaw;
      breakdown.push({
        index: i,
        invoiceId: it.invoiceId || null,
        supplierId: sup.id,
        supplierName: sup.name,
        supplierWallet: sup.wallet,
        amount: it.amount,
        amountRaw: amountRaw.toString(),
      });
    }

    // ── Record payment intents in Supabase ──
    const intentRows = items.map((it, i) => ({
      invoice_id: it.invoiceId || null,
      supplier_id: it.supplierId,
      amount: it.amount,
      token: tokenSymbol,
      chain: chainKey,
      status: "intent_recorded",
      recipient_wallet: recipients[i],
    }));
    const { data: insertedIntents, error: insErr } = await db()
      .from("sctp_payments")
      .insert(intentRows)
      .select();
    if (insErr) {
      return res.status(500).json({ error: `Payment intent insert failed: ${insErr.message}` });
    }

    // ── Calculate protocol fee and build calldata ──
    const protocolFee = (totalRaw * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
    const totalWithFee = totalRaw + protocolFee;

    const usdcAddress = USDC_ADDRESSES[chainKey];
    const spraayContract = SPRAAY_CONTRACTS[chainKey];
    const chainId = CHAIN_IDS[chainKey];

    const spraayIface = new Interface(SPRAAY_V2_ABI);
    const erc20Iface = new Interface(ERC20_ABI);

    const approveCalldata = erc20Iface.encodeFunctionData("approve", [
      spraayContract,
      totalWithFee,
    ]);
    const batchCalldata = spraayIface.encodeFunctionData("batchTransfer", [
      usdcAddress,
      recipients,
      amounts,
    ]);

    // Rough gas estimate: 50k base + 30k per recipient
    const estimatedGas = 50000 + recipients.length * 30000;

    // ── Best-effort balance + allowance check ──
    let balanceCheck: any = null;
    if (sender) {
      try {
        const provider = new JsonRpcProvider(RPC_URLS[chainKey]);
        const usdc = new Contract(usdcAddress, ERC20_ABI, provider);
        const [balance, allowance] = await Promise.all([
          usdc.balanceOf(sender) as Promise<bigint>,
          usdc.allowance(sender, spraayContract) as Promise<bigint>,
        ]);
        const sufficient = balance >= totalWithFee;
        const approvalNeeded = allowance < totalWithFee;
        balanceCheck = {
          balance: formatUnits(balance, USDC_DECIMALS),
          required: formatUnits(totalWithFee, USDC_DECIMALS),
          sufficient,
          shortfall: sufficient ? null : formatUnits(totalWithFee - balance, USDC_DECIMALS),
          allowance: formatUnits(allowance, USDC_DECIMALS),
          approvalNeeded,
        };
      } catch (e: any) {
        // Don't fail the request just because the balance check hiccupped.
        balanceCheck = { error: e?.message || "balance check failed" };
      }
    }

    // ── Update invoice statuses where linked ──
    const linkedInvoiceIds = items.map((it) => it.invoiceId).filter((id): id is string => !!id);
    if (linkedInvoiceIds.length > 0) {
      try {
        await db()
          .from("sctp_invoices")
          .update({ status: "payment_initiated" })
          .in("id", linkedInvoiceIds);
      } catch (e: any) {
        // Non-fatal — log and continue.
        console.warn(`[sctp/pay] invoice status update failed: ${e?.message || e}`);
      }
    }

    // ── Build the per-payment summary for the response ──
    const paymentsOut = breakdown.map((b, i) => ({
      paymentId: insertedIntents?.[i]?.id || null,
      invoiceId: b.invoiceId,
      supplierId: b.supplierId,
      supplierName: b.supplierName,
      supplierWallet: b.supplierWallet,
      amount: b.amount,
      token: tokenSymbol,
      chain: chainKey,
    }));

    const settlement =
      chainKey === "base" || chainKey === "arbitrum" || chainKey === "polygon" || chainKey === "avalanche"
        ? "~2s after submission"
        : "~15s after submission";

    return res.json({
      status: "ready",
      batch: isBatch,
      count: items.length,
      payments: paymentsOut,
      summary: {
        token: tokenSymbol,
        chain: chainKey,
        chainId,
        totalAmount: formatUnits(totalRaw, USDC_DECIMALS),
        totalAmountRaw: totalRaw.toString(),
        protocolFee: formatUnits(protocolFee, USDC_DECIMALS),
        protocolFeeBps: PROTOCOL_FEE_BPS,
        totalWithFee: formatUnits(totalWithFee, USDC_DECIMALS),
        totalWithFeeRaw: totalWithFee.toString(),
        recipientCount: recipients.length,
      },
      transactions: {
        approval: {
          to: usdcAddress,
          data: approveCalldata,
          value: "0x0",
          chainId,
          note: `Approve Spraay batch contract to spend ${formatUnits(totalWithFee, USDC_DECIMALS)} ${tokenSymbol}`,
        },
        batchPayment: {
          to: spraayContract,
          data: batchCalldata,
          value: "0x0",
          chainId,
          gasLimit: "0x" + estimatedGas.toString(16),
          note: `Batch payment to ${recipients.length} supplier${recipients.length === 1 ? "" : "s"} via Spraay batchTransfer`,
        },
      },
      balanceCheck,
      instructions: [
        sender
          ? `1. Ensure ${sender} holds ${formatUnits(totalWithFee, USDC_DECIMALS)} ${tokenSymbol} on ${chainKey}`
          : `1. Ensure the sender wallet holds ${formatUnits(totalWithFee, USDC_DECIMALS)} ${tokenSymbol} on ${chainKey}`,
        "2. Sign and submit the approval transaction (skip if allowance is already sufficient)",
        "3. Sign and submit the batchPayment transaction",
        `4. All ${recipients.length} supplier${recipients.length === 1 ? "" : "s"} will be paid in a single on-chain transaction`,
      ],
      estimatedSettlement: settlement,
      spraay: {
        contract: spraayContract,
        chain: chainKey,
        chainId,
        protocolFee: "0.3%",
        maxRecipients: 200,
      },
      note: "Endpoint returns signed-ready calldata. The caller's wallet must broadcast both transactions. Payment intents are recorded with status 'intent_recorded'; transition to 'submitted'/'confirmed' is the caller's responsibility (use POST /api/v1/sctp/pay/confirm if available).",
      _gateway: { provider: "spraay-x402", version: "2.10.0", endpoint: "POST /api/v1/sctp/pay" },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[sctp/pay] unexpected error:", err?.message || err);
    return res.status(500).json({ error: err?.message || "Unknown error" });
  }
}
