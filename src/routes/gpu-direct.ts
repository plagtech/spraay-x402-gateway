// ═══════════════════════════════════════════════════════════════
// gpu-direct.ts — Spraay Direct: operator-routed GPU inference
//
// DROP INTO: spraay-x402-gateway/src/routes/gpu-direct.ts
//
// Then add to index.ts:
//   1. Import:
//      import { gpuDirectRunHandler, gpuDirectRegisterHandler,
//               gpuDirectOperatorsHandler, gpuDirectQuoteHandler } from "./routes/gpu-direct.js";
//
//   2. Add to paidRoutes object (around line 691, after GPU/COMPUTE section):
//      // ---- GPU DIRECT (operator-fulfilled) ----
//      "POST /api/v1/gpu-direct/run": {
//        // NOTE: payTo is dynamic — set at request time by gpuDirectRunHandler
//        // We set payTo to PAY_TO as default fallback; the handler overrides
//        // the actual settlement destination via the two-step quote flow.
//        accepts: [{ scheme: "exact", price: "$0.03", network: CAIP2_NETWORK, payTo: PAY_TO }],
//        description: "GPU inference via Spraay Direct operator — instant USDC to GPU host.",
//        mimeType: "application/json",
//        extensions: { ...declareDiscoveryExtension({
//          input: { model: "llama-3.1-8b", input: { prompt: "Hello" } },
//          inputSchema: { properties: { model: { type: "string" }, input: { type: "object" } }, required: ["model", "input"] },
//          bodyType: "json",
//          output: { example: { status: "succeeded", output: "...", settlement: { currency: "USDC", chain: "base", status: "settled" } },
//                    schema: { properties: { status: { type: "string" }, output: {} } } }
//        }) },
//      },
//
//   3. Mount routes (around line 2570, after GPU routes):
//      // GPU Direct (operator-fulfilled inference)
//      app.post("/api/v1/gpu-direct/register", gpuDirectRegisterHandler);
//      app.post("/api/v1/gpu-direct/run", gpuDirectRunHandler);
//      app.get("/api/v1/gpu-direct/operators", gpuDirectOperatorsHandler);
//      app.get("/api/v1/gpu-direct/quote", gpuDirectQuoteHandler);
//
//   4. Add free-tier entries for register + operators + quote:
//      In the freeRoutes or exclude them from paymentMiddleware
//      (register and operators should be free so operators can onboard)
//
//   5. Run Supabase SQL (included at bottom of this file)
//
// ═══════════════════════════════════════════════════════════════

import { Request, Response } from "express";
import { supabase } from "../middleware/supabase.js";
import crypto from "crypto";

// ── Supabase Queries ─────────────────────────────────────────

async function findOperatorForModel(model: string) {
  const { data } = await supabase!
    .from("spraay_direct_operators")
    .select("*")
    .eq("status", "online")
    .contains("supported_models", [model])
    .order("avg_response_ms", { ascending: true })
    .limit(1);
  return data?.[0] || null;
}

async function getOnlineOperators() {
  const { data } = await supabase!
    .from("spraay_direct_operators")
    .select("id, gpu_model, vram_gb, inference_engine, supported_models, avg_response_ms, total_jobs, status")
    .eq("status", "online")
    .order("total_jobs", { ascending: false });
  return data || [];
}

async function upsertOperator(op: any) {
  const { data, error } = await supabase!
    .from("spraay_direct_operators")
    .upsert(
      {
        wallet_address: op.wallet_address,
        proxy_url: op.proxy_url,
        gpu_model: op.gpu_model || "unknown",
        vram_gb: op.vram_gb || 0,
        supported_models: op.supported_models || [],
        inference_engine: op.inference_engine || "vllm",
        status: "online",
        auth_token: op.auth_token,
        last_health_check: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "wallet_address" }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function recordJob(operatorId: string, model: string, amountUsdc: string, inferenceMs: number, payerAddress?: string) {
  await supabase!.from("spraay_direct_jobs").insert({
    operator_id: operatorId,
    model,
    amount_usdc: amountUsdc,
    inference_time_ms: inferenceMs,
    payer_address: payerAddress || null,
  });

  // Update operator stats
  const { data: op } = await supabase!
    .from("spraay_direct_operators")
    .select("total_jobs, avg_response_ms")
    .eq("id", operatorId)
    .single();

  if (op) {
    const newTotal = (op.total_jobs || 0) + 1;
    const newAvg = Math.round(((op.avg_response_ms || 0) * (op.total_jobs || 0) + inferenceMs) / newTotal);
    await supabase!
      .from("spraay_direct_operators")
      .update({ total_jobs: newTotal, avg_response_ms: newAvg, last_health_check: new Date().toISOString() })
      .eq("id", operatorId);
  }
}

// ── POST /api/v1/gpu-direct/register ─────────────────────────
// FREE — operator registers their proxy with the gateway.
// No x402 payment required (not in paidRoutes).
export const gpuDirectRegisterHandler = async (req: Request, res: Response) => {
  try {
    const { wallet_address, proxy_url, gpu_model, vram_gb, supported_models, inference_engine } = req.body;

    if (!wallet_address || !proxy_url) {
      return res.status(400).json({ error: "wallet_address and proxy_url are required" });
    }
    if (!wallet_address.startsWith("0x") || wallet_address.length !== 42) {
      return res.status(400).json({ error: "wallet_address must be a valid Ethereum/Base address" });
    }

    // Generate auth token for this operator
    const auth_token = `sd_${crypto.randomBytes(24).toString("hex")}`;

    // Verify the proxy is reachable
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const healthRes = await fetch(`${proxy_url}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!healthRes.ok) throw new Error(`Status ${healthRes.status}`);
      const health = await healthRes.json() as any;

      // Use health data to fill in missing fields
      const operator = await upsertOperator({
        wallet_address,
        proxy_url,
        gpu_model: gpu_model || health.gpu || "unknown",
        vram_gb: vram_gb || health.vram || 0,
        supported_models: supported_models || health.models || [],
        inference_engine: inference_engine || health.engine || "vllm",
        auth_token,
      });

      console.log(`[gpu-direct] ✅ Operator registered: ${wallet_address} (${operator.gpu_model})`);

      return res.json({
        status: "registered",
        operator_id: operator.id,
        auth_token,
        message: "Your GPU is now receiving jobs. USDC payouts go directly to your wallet on Base.",
        wallet: wallet_address,
        gpu: operator.gpu_model,
        models: operator.supported_models,
      });
    } catch (err: any) {
      return res.status(400).json({
        error: `Cannot reach proxy at ${proxy_url}/health — ${err.message}`,
        hint: "Make sure your spraay-direct proxy is running and accessible from the internet (use ngrok or Cloudflare Tunnel)",
      });
    }
  } catch (err: any) {
    console.error("[gpu-direct] Registration error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── GET /api/v1/gpu-direct/quote ─────────────────────────────
// FREE — returns which operator will serve a model and their wallet.
// Agents use this to know where USDC will go BEFORE paying.
// This is the key to dynamic payTo without modifying the middleware:
// The agent calls /quote → gets operator wallet → pays that wallet
// → calls /run with payment proof.
export const gpuDirectQuoteHandler = async (req: Request, res: Response) => {
  try {
    const model = req.query.model as string;
    if (!model) return res.status(400).json({ error: "?model= query param required" });

    const operator = await findOperatorForModel(model);

    if (!operator) {
      return res.json({
        available: false,
        model,
        message: "No operator online for this model. Use /api/v1/gpu/run for Replicate-backed inference.",
        fallback: "/api/v1/gpu/run",
      });
    }

    return res.json({
      available: true,
      model,
      operator: {
        gpu: operator.gpu_model,
        vram_gb: operator.vram_gb,
        engine: operator.inference_engine,
        avg_response_ms: operator.avg_response_ms,
      },
      payment: {
        price: "$0.03",
        currency: "USDC",
        chain: "base",
        network: "eip155:8453",
        payTo: operator.wallet_address,
        note: "USDC settles directly to the GPU operator's wallet. Instant.",
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ── POST /api/v1/gpu-direct/run ──────────────────────────────
// PAID via x402 — this is the main inference endpoint.
// After x402 payment settles, this forwards the job to the operator's proxy.
export const gpuDirectRunHandler = async (req: Request, res: Response) => {
  const { model, input } = req.body;

  if (!model) return res.status(400).json({ error: "Missing required field: model" });
  if (!input) return res.status(400).json({ error: "Missing required field: input" });

  // Find operator for this model
  const operator = await findOperatorForModel(model);

  if (!operator) {
    return res.status(503).json({
      error: "No operator currently available for this model",
      hint: "Use /api/v1/gpu/run for Replicate-backed inference, or try again shortly",
      online_operators: await getOnlineOperators(),
    });
  }

  try {
    const startTime = Date.now();

    const proxyRes = await fetch(`${operator.proxy_url}/inference`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Spraay-Auth": operator.auth_token,
        "X-Spraay-Amount": "0.03",
        "X-Spraay-Payer": (req as any).payerAddress || "unknown",
      },
      body: JSON.stringify({ model, input }),
      signal: AbortSignal.timeout(120000),
    });

    if (!proxyRes.ok) {
      const errText = await proxyRes.text();
      throw new Error(`Operator proxy error (${proxyRes.status}): ${errText}`);
    }

    const result = await proxyRes.json() as any;
    const elapsed = Date.now() - startTime;

    // Record the job in Supabase
    await recordJob(operator.id, model, "0.03", elapsed);

    console.log(`[gpu-direct] ✅ ${model} via ${operator.gpu_model} (${operator.wallet_address.slice(0, 10)}...) — ${elapsed}ms`);

    return res.json({
      ...result,
      operator: {
        gpu: operator.gpu_model,
        engine: operator.inference_engine,
      },
      settlement: {
        currency: "USDC",
        chain: "base",
        amount: "0.03",
        payTo: operator.wallet_address,
        timing: "instant",
        status: "settled",
      },
    });
  } catch (err: any) {
    console.error(`[gpu-direct] Job error:`, err.message);

    // If operator is unreachable, mark them offline
    if (err.message.includes("fetch failed") || err.message.includes("abort")) {
      await supabase!
        .from("spraay_direct_operators")
        .update({ status: "offline" })
        .eq("id", operator.id);
      console.log(`[gpu-direct] Marked operator ${operator.id} as offline`);
    }

    return res.status(500).json({ error: err.message });
  }
};

// ── GET /api/v1/gpu-direct/operators ─────────────────────────
// FREE — discovery endpoint. Lists online operators and capabilities.
export const gpuDirectOperatorsHandler = async (_req: Request, res: Response) => {
  const operators = await getOnlineOperators();

  return res.json({
    total_online: operators.length,
    operators: operators.map((op) => ({
      gpu: op.gpu_model,
      vram_gb: op.vram_gb,
      engine: op.inference_engine,
      models: op.supported_models,
      avg_response_ms: op.avg_response_ms,
      total_jobs: op.total_jobs,
    })),
    pricing: {
      per_job: "$0.03 USDC",
      settlement: "instant — USDC on Base",
      comparison: "Replicate-backed /gpu/run is $0.06 with 2-week platform payout",
    },
  });
};

// ═══════════════════════════════════════════════════════════════
// SUPABASE SQL — Run in your Supabase SQL editor
// ═══════════════════════════════════════════════════════════════
//
// -- Spraay Direct: Operator Registry
// CREATE TABLE spraay_direct_operators (
//   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//   wallet_address TEXT NOT NULL UNIQUE,
//   proxy_url TEXT NOT NULL,
//   gpu_model TEXT NOT NULL DEFAULT 'unknown',
//   vram_gb INTEGER NOT NULL DEFAULT 0,
//   supported_models TEXT[] DEFAULT '{}',
//   inference_engine TEXT NOT NULL DEFAULT 'vllm',
//   status TEXT NOT NULL DEFAULT 'offline',
//   auth_token TEXT NOT NULL,
//   last_health_check TIMESTAMPTZ,
//   total_jobs INTEGER DEFAULT 0,
//   avg_response_ms INTEGER DEFAULT 0,
//   created_at TIMESTAMPTZ DEFAULT NOW(),
//   updated_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Spraay Direct: Job History
// CREATE TABLE spraay_direct_jobs (
//   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//   operator_id UUID REFERENCES spraay_direct_operators(id),
//   model TEXT NOT NULL,
//   amount_usdc NUMERIC(20,6) NOT NULL DEFAULT 0,
//   payer_address TEXT,
//   inference_time_ms INTEGER DEFAULT 0,
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Spraay Direct: Payout Split Rules
// CREATE TABLE spraay_direct_splits (
//   id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//   operator_id UUID REFERENCES spraay_direct_operators(id),
//   wallet TEXT NOT NULL,
//   percentage NUMERIC(5,2) NOT NULL,
//   label TEXT NOT NULL DEFAULT 'default',
//   created_at TIMESTAMPTZ DEFAULT NOW()
// );
//
// -- Indexes
// CREATE INDEX idx_sd_operators_status ON spraay_direct_operators(status);
// CREATE INDEX idx_sd_operators_models ON spraay_direct_operators USING GIN(supported_models);
// CREATE INDEX idx_sd_jobs_operator ON spraay_direct_jobs(operator_id);
// CREATE INDEX idx_sd_jobs_created ON spraay_direct_jobs(created_at);
// CREATE INDEX idx_sd_splits_operator ON spraay_direct_splits(operator_id);
