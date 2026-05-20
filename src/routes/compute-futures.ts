// ============================================
// src/routes/compute-futures.ts
// Spraay Compute Futures — Prepaid Compute Credits
// ============================================
// Deposit USDC into escrow → get a credit balance → draw down per inference
// User can refund unused balance at any time
// Gateway never holds funds — escrow contract does
//
// 6 endpoints:
//   POST /api/v1/compute-futures/deposit    — create prepaid account ($0.01 x402 fee)
//   GET  /api/v1/compute-futures/balance    — check remaining credits ($0.001)
//   POST /api/v1/compute-futures/execute    — run compute, deduct from balance ($0.001)
//   GET  /api/v1/compute-futures/history    — usage ledger ($0.002)
//   POST /api/v1/compute-futures/refund     — withdraw unused balance ($0.01)
//   GET  /api/v1/compute-futures/pricing    — tier discounts and per-model costs ($0.001)

import { Request, Response } from "express";
import { isAddress, parseUnits, formatUnits, hexlify, randomBytes } from "ethers";
import { trackRequest } from "./health.js";
import { computeFuturesDb } from "../db.js";
import {
  COMPUTE_JOBS, BATCH_DISCOUNT,
  isValidJobType, resolveModel,
  ComputeJobType,
} from "../config/compute-models.js";
import {
  chatCompletion,
  generateEmbeddings,
  imageGeneration,
  videoGeneration,
  textToSpeech,
  speechToText,
} from "../services/compute-router.js";

// ── Constants ─────────────────────────────────────────────────────

const USDC_DECIMALS = 6;
const GATEWAY_ADDRESS = process.env.PAY_TO_ADDRESS || "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8";

// Tier discounts: deposit more, pay less per inference
const TIERS = [
  { name: "starter",    minDeposit: 1,    discount: 0,    label: "No discount" },
  { name: "builder",    minDeposit: 10,   discount: 0.05, label: "5% discount" },
  { name: "scale",      minDeposit: 50,   discount: 0.10, label: "10% discount" },
  { name: "enterprise", minDeposit: 200,  discount: 0.15, label: "15% discount" },
];

function getTier(depositAmount: number) {
  let tier = TIERS[0];
  for (const t of TIERS) {
    if (depositAmount >= t.minDeposit) tier = t;
  }
  return tier;
}

function generateFuturesId(): string {
  return "CFE-" + hexlify(randomBytes(8)).slice(2).toUpperCase();
}

// ── 1. POST /api/v1/compute-futures/deposit ───────────────────────

export async function computeFuturesDepositHandler(req: Request, res: Response) {
  try {
    const { depositor, amount, expiresInDays } = req.body;

    if (!depositor || !amount) {
      return res.status(400).json({
        error: "Missing required fields",
        required: { depositor: "0x... (your wallet address)", amount: "USDC amount to deposit (e.g. '50')" },
        optional: { expiresInDays: "number (default 90)" },
        tiers: TIERS.map(t => ({ name: t.name, minDeposit: `$${t.minDeposit}`, discount: t.label })),
        example: { depositor: "0xYourAddress", amount: "50" },
      });
    }

    if (!isAddress(depositor)) {
      return res.status(400).json({ error: "Invalid depositor address" });
    }

    const depositFloat = parseFloat(amount);
    if (isNaN(depositFloat) || depositFloat < 1) {
      return res.status(400).json({ error: "Minimum deposit is $1 USDC" });
    }

    const tier = getTier(depositFloat);
    const futuresId = generateFuturesId();
    const now = new Date();
    const days = typeof expiresInDays === "number" && expiresInDays > 0 ? expiresInDays : 90;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
    const amountRaw = parseUnits(amount, USDC_DECIMALS).toString();

    const record = {
      id: futuresId,
      depositor,
      beneficiary: GATEWAY_ADDRESS,
      depositAmount: amount,
      depositAmountRaw: amountRaw,
      balanceRemaining: amount,
      balanceRemainingRaw: amountRaw,
      totalUsed: "0",
      totalUsedRaw: "0",
      tier: tier.name,
      discount: tier.discount,
      status: "active",     // active | exhausted | refunded | expired
      jobCount: 0,
      expiresAt,
      refundedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    await computeFuturesDb.create(record);
    trackRequest("compute_futures_deposit");

    return res.json({
      status: "active",
      computeFuture: {
        id: futuresId,
        depositor,
        depositAmount: `${amount} USDC`,
        balanceRemaining: `${amount} USDC`,
        tier: tier.name,
        discount: tier.label,
        expiresAt,
        expiresInDays: days,
      },
      actions: {
        execute: { endpoint: "POST /api/v1/compute-futures/execute", body: { futuresId, type: "text-inference", messages: [{ role: "user", content: "Hello" }] } },
        balance: { endpoint: `GET /api/v1/compute-futures/balance?id=${futuresId}` },
        history: { endpoint: `GET /api/v1/compute-futures/history?id=${futuresId}` },
        refund: { endpoint: "POST /api/v1/compute-futures/refund", body: { futuresId, caller: depositor } },
      },
      note: "Deposit USDC to the escrow contract. Your balance is drawn down per compute call. Refund unused balance anytime.",
      _gateway: { provider: "spraay-x402", version: "3.8.0", endpoint: "POST /api/v1/compute-futures/deposit" },
      timestamp: now.toISOString(),
    });
  } catch (error: any) {
    console.error("[compute-futures/deposit]", error.message);
    return res.status(500).json({ error: "Failed to create compute future", details: error.message });
  }
}

// ── 2. GET /api/v1/compute-futures/balance ────────────────────────

export async function computeFuturesBalanceHandler(req: Request, res: Response) {
  try {
    const id = req.query.id as string;
    if (!id) return res.status(400).json({ error: "id query param required", example: "/api/v1/compute-futures/balance?id=CFE-..." });

    const record = await computeFuturesDb.get(id);
    if (!record) return res.status(404).json({ error: `Compute future not found: ${id}` });

    // Check expiry
    if (record.status === "active" && new Date(record.expiresAt) < new Date()) {
      await computeFuturesDb.update(id, { status: "expired" });
      record.status = "expired";
    }

    const tier = getTier(parseFloat(record.depositAmount));
    trackRequest("compute_futures_balance");

    return res.json({
      id: record.id,
      depositor: record.depositor,
      depositAmount: `${record.depositAmount} USDC`,
      balanceRemaining: `${record.balanceRemaining} USDC`,
      totalUsed: `${record.totalUsed} USDC`,
      tier: tier.name,
      discount: tier.label,
      jobCount: record.jobCount,
      status: record.status,
      expiresAt: record.expiresAt,
      _gateway: { provider: "spraay-x402", version: "3.8.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch balance", details: error.message });
  }
}

// ── 3. POST /api/v1/compute-futures/execute ───────────────────────

export async function computeFuturesExecuteHandler(req: Request, res: Response) {
  try {
    const { futuresId, type, model: requestedModel, ...jobParams } = req.body;

    if (!futuresId || !type) {
      return res.status(400).json({
        error: "futuresId and type are required",
        types: ["text-inference", "image-generation", "video-generation", "text-to-speech", "speech-to-text", "embeddings"],
        example: { futuresId: "CFE-...", type: "text-inference", messages: [{ role: "user", content: "Hello" }] },
      });
    }

    if (!isValidJobType(type)) {
      return res.status(400).json({ error: `Invalid compute type: ${type}`, valid: ["text-inference", "image-generation", "video-generation", "text-to-speech", "speech-to-text", "embeddings"] });
    }

    const record = await computeFuturesDb.get(futuresId);
    if (!record) return res.status(404).json({ error: `Compute future not found: ${futuresId}` });
    if (record.status !== "active") return res.status(400).json({ error: `Cannot execute: account status is '${record.status}'` });

    // Check expiry
    if (new Date(record.expiresAt) < new Date()) {
      await computeFuturesDb.update(futuresId, { status: "expired" });
      return res.status(400).json({ error: "Compute future has expired. Refund remaining balance or create a new deposit." });
    }

    // Resolve model and price
    const modelDef = resolveModel(type as ComputeJobType, requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for ${type}. Use /compute/models to see options.` });
    }

    // Apply tier discount
    const discount = record.discount || 0;
    const effectivePrice = modelDef.price * (1 - discount);

    // Check balance
    const balanceFloat = parseFloat(record.balanceRemaining);
    if (effectivePrice > balanceFloat) {
      return res.status(402).json({
        error: "Insufficient compute credits",
        required: `$${effectivePrice.toFixed(4)} USDC`,
        balanceRemaining: `$${balanceFloat.toFixed(4)} USDC`,
        suggestion: "Deposit more credits or choose a cheaper model.",
      });
    }

    // Execute the compute job
    let result: any;
    try {
      switch (type) {
        case "text-inference":
          if (!jobParams.messages || !Array.isArray(jobParams.messages)) {
            return res.status(400).json({ error: "messages array required for text-inference" });
          }
          result = await chatCompletion({
            model: modelDef,
            messages: jobParams.messages,
            max_tokens: jobParams.max_tokens || 1024,
            temperature: jobParams.temperature ?? 0.7,
            stream: false,
          });
          break;
        case "image-generation":
          if (!jobParams.prompt) return res.status(400).json({ error: "prompt required for image-generation" });
          result = await imageGeneration({
            model: modelDef,
            prompt: jobParams.prompt,
            width: jobParams.width || 1024,
            height: jobParams.height || 1024,
            num_outputs: jobParams.num_outputs || 1,
          });
          break;
        case "video-generation":
          if (!jobParams.prompt) return res.status(400).json({ error: "prompt required for video-generation" });
          result = await videoGeneration({
            model: modelDef,
            prompt: jobParams.prompt,
            duration_seconds: jobParams.duration_seconds || 4,
          });
          break;
        case "text-to-speech":
          if (!jobParams.text) return res.status(400).json({ error: "text required for text-to-speech" });
          result = await textToSpeech({
            model: modelDef,
            text: jobParams.text,
            language: jobParams.language || "en",
          });
          break;
        case "speech-to-text":
          if (!jobParams.audio_url) return res.status(400).json({ error: "audio_url required for speech-to-text" });
          result = await speechToText({
            model: modelDef,
            audio_url: jobParams.audio_url,
          });
          break;
        case "embeddings":
          if (!jobParams.input) return res.status(400).json({ error: "input required for embeddings" });
          result = await generateEmbeddings({
            model: modelDef,
            input: jobParams.input,
          });
          break;
        default:
          return res.status(400).json({ error: `Unsupported type: ${type}` });
      }
    } catch (computeErr: any) {
      // Compute failed — do NOT deduct balance
      return res.status(502).json({
        error: `Compute failed (balance not charged)`,
        details: computeErr.message,
        balanceRemaining: `${balanceFloat.toFixed(4)} USDC`,
      });
    }

    // Deduct from balance
    const newBalance = (balanceFloat - effectivePrice).toFixed(6);
    const newTotalUsed = (parseFloat(record.totalUsed) + effectivePrice).toFixed(6);
    const newJobCount = record.jobCount + 1;
    const newStatus = parseFloat(newBalance) <= 0.0001 ? "exhausted" : "active";

    await computeFuturesDb.update(futuresId, {
      balanceRemaining: newBalance,
      balanceRemainingRaw: parseUnits(newBalance, USDC_DECIMALS).toString(),
      totalUsed: newTotalUsed,
      totalUsedRaw: parseUnits(newTotalUsed, USDC_DECIMALS).toString(),
      jobCount: newJobCount,
      status: newStatus,
    });

    // Log the usage
    await computeFuturesDb.logUsage({
      futuresId,
      jobType: type,
      model: modelDef.id,
      modelLabel: modelDef.label,
      basePrice: modelDef.price.toFixed(6),
      discount: discount.toFixed(4),
      effectivePrice: effectivePrice.toFixed(6),
      balanceBefore: balanceFloat.toFixed(6),
      balanceAfter: newBalance,
      timestamp: new Date().toISOString(),
    });

    trackRequest("compute_futures_execute");

    return res.json({
      status: "completed",
      billing: {
        basePrice: `$${modelDef.price.toFixed(4)}`,
        discount: discount > 0 ? `${(discount * 100).toFixed(0)}%` : "none",
        charged: `$${effectivePrice.toFixed(4)} USDC`,
        balanceRemaining: `$${newBalance} USDC`,
        jobNumber: newJobCount,
        accountStatus: newStatus,
      },
      compute: {
        type,
        model: modelDef.id,
        modelLabel: modelDef.label,
        provider: result.provider || modelDef.provider,
        result,
      },
      _gateway: { provider: "spraay-x402", version: "3.8.0", endpoint: "POST /api/v1/compute-futures/execute" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[compute-futures/execute]", error.message);
    return res.status(500).json({ error: "Compute futures execution failed", details: error.message });
  }
}

// ── 4. GET /api/v1/compute-futures/history ────────────────────────

export async function computeFuturesHistoryHandler(req: Request, res: Response) {
  try {
    const id = req.query.id as string;
    const limit = parseInt(req.query.limit as string) || 50;
    if (!id) return res.status(400).json({ error: "id query param required" });

    const record = await computeFuturesDb.get(id);
    if (!record) return res.status(404).json({ error: `Compute future not found: ${id}` });

    const usage = await computeFuturesDb.getUsage(id, limit);
    trackRequest("compute_futures_history");

    return res.json({
      id: record.id,
      depositor: record.depositor,
      depositAmount: `${record.depositAmount} USDC`,
      balanceRemaining: `${record.balanceRemaining} USDC`,
      totalUsed: `${record.totalUsed} USDC`,
      jobCount: record.jobCount,
      status: record.status,
      usage,
      _gateway: { provider: "spraay-x402", version: "3.8.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch history", details: error.message });
  }
}

// ── 5. POST /api/v1/compute-futures/refund ────────────────────────

export async function computeFuturesRefundHandler(req: Request, res: Response) {
  try {
    const { futuresId, caller } = req.body;

    if (!futuresId || !caller) {
      return res.status(400).json({
        error: "futuresId and caller are required",
        example: { futuresId: "CFE-...", caller: "0xYourAddress" },
      });
    }

    if (!isAddress(caller)) return res.status(400).json({ error: "Invalid caller address" });

    const record = await computeFuturesDb.get(futuresId);
    if (!record) return res.status(404).json({ error: `Compute future not found: ${futuresId}` });

    if (caller.toLowerCase() !== record.depositor.toLowerCase()) {
      return res.status(403).json({ error: "Only the depositor can request a refund" });
    }

    if (record.status === "refunded") {
      return res.status(400).json({ error: "Already refunded" });
    }

    const balanceFloat = parseFloat(record.balanceRemaining);
    if (balanceFloat <= 0) {
      return res.status(400).json({ error: "No balance remaining to refund" });
    }

    const now = new Date().toISOString();
    await computeFuturesDb.update(futuresId, {
      status: "refunded",
      refundedAt: now,
    });
    trackRequest("compute_futures_refund");

    return res.json({
      status: "refunded",
      refund: {
        futuresId,
        depositor: record.depositor,
        refundAmount: `${record.balanceRemaining} USDC`,
        totalUsed: `${record.totalUsed} USDC`,
        jobsExecuted: record.jobCount,
      },
      note: "Remaining USDC balance is released back to the depositor via the escrow contract.",
      _gateway: { provider: "spraay-x402", version: "3.8.0", endpoint: "POST /api/v1/compute-futures/refund" },
      timestamp: now,
    });
  } catch (error: any) {
    console.error("[compute-futures/refund]", error.message);
    return res.status(500).json({ error: "Failed to process refund", details: error.message });
  }
}

// ── 6. GET /api/v1/compute-futures/pricing ────────────────────────

export async function computeFuturesPricingHandler(req: Request, res: Response) {
  try {
    trackRequest("compute_futures_pricing");

    // Build pricing table from compute models
    const pricing: Record<string, any[]> = {};
    for (const [jobType, def] of Object.entries(COMPUTE_JOBS)) {
      pricing[jobType] = def.models.map(m => ({
        model: m.id,
        label: m.label,
        provider: m.provider,
        basePrice: `$${m.price.toFixed(3)}`,
        // Show discounted prices per tier
        tierPrices: TIERS.filter(t => t.discount > 0).map(t => ({
          tier: t.name,
          price: `$${(m.price * (1 - t.discount)).toFixed(4)}`,
          discount: t.label,
        })),
      }));
    }

    return res.json({
      tiers: TIERS.map(t => ({
        name: t.name,
        minDeposit: `$${t.minDeposit} USDC`,
        discount: t.label,
      })),
      pricing,
      batchDiscount: `${(BATCH_DISCOUNT * 100).toFixed(0)}% (via /compute/batch)`,
      note: "Deposit USDC → get tier discount on all compute. Higher deposits = lower per-inference costs. Unused balance refundable anytime.",
      _gateway: { provider: "spraay-x402", version: "3.8.0", endpoint: "GET /api/v1/compute-futures/pricing" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch pricing", details: error.message });
  }
}
