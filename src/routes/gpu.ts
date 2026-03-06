// ═══════════════════════════════════════════════════════════════
// gpu.ts — x402 GPU/Compute handlers for Spraay Gateway
// Proxies AI inference, image gen, video gen, audio, and custom
// model runs through Replicate.
//
// ENV: REPLICATE_API_TOKEN (required)
//
// Exports:
//   gpuRunHandler          POST /api/v1/gpu/run
//   gpuStatusHandler       GET  /api/v1/gpu/status/:id
//   gpuModelsHandler       GET  /api/v1/gpu/models   (free)
// ═══════════════════════════════════════════════════════════════

import { Request, Response } from "express";

const REPLICATE_API = "https://api.replicate.com/v1";
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;

// ── Popular model shortcuts ─────────────────────────────────
const MODEL_SHORTCUTS: Record<string, { model: string; description: string; category: string }> = {
  // Image Generation
  "flux-pro":        { model: "black-forest-labs/flux-1.1-pro", description: "Fastest high-quality image generation", category: "image" },
  "flux-dev":        { model: "black-forest-labs/flux-dev", description: "FLUX dev model for experimentation", category: "image" },
  "sdxl":            { model: "stability-ai/sdxl", description: "Stable Diffusion XL", category: "image" },
  "ideogram":        { model: "ideogram-ai/ideogram-v2-turbo", description: "Ideogram v2 turbo — text rendering", category: "image" },
  // Video Generation
  "wan-video":       { model: "wavespeed-ai/wan-2.1-i2v-480p", description: "Wan 2.1 image-to-video", category: "video" },
  "minimax-video":   { model: "minimax/video-01", description: "MiniMax video generation", category: "video" },
  // Language Models
  "llama-70b":       { model: "meta/meta-llama-3-70b-instruct", description: "Llama 3 70B Instruct", category: "llm" },
  "llama-8b":        { model: "meta/meta-llama-3-8b-instruct", description: "Llama 3 8B Instruct", category: "llm" },
  "mixtral":         { model: "mistralai/mixtral-8x7b-instruct-v0.1", description: "Mixtral 8x7B", category: "llm" },
  // Audio
  "whisper":         { model: "openai/whisper", description: "Speech-to-text transcription", category: "audio" },
  "musicgen":        { model: "meta/musicgen", description: "Music generation from text", category: "audio" },
  // Upscaling / Utility
  "esrgan":          { model: "nightmareai/real-esrgan", description: "Image upscaling 4x", category: "utility" },
  "rembg":           { model: "cjwbw/rembg", description: "Background removal", category: "utility" },
};

// ── Helpers ─────────────────────────────────────────────────

async function replicateRequest(path: string, method: string = "GET", body?: any): Promise<any> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${REPLICATE_TOKEN}`,
    "Content-Type": "application/json",
    "Prefer": "wait",
  };

  const opts: any = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${REPLICATE_API}${path}`, opts);

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Replicate API error (${resp.status}): ${errText}`);
  }

  return resp.json();
}

function resolveModel(input: string): string {
  const shortcut = MODEL_SHORTCUTS[input.toLowerCase()];
  if (shortcut) return shortcut.model;
  if (input.includes("/")) return input;
  throw new Error(
    `Unknown model "${input}". Use a shortcut (${Object.keys(MODEL_SHORTCUTS).join(", ")}) or full ID "owner/model".`
  );
}

// ── POST /api/v1/gpu/run ────────────────────────────────────
export const gpuRunHandler = async (req: Request, res: Response) => {
  try {
    if (!REPLICATE_TOKEN) {
      return res.status(500).json({ error: "GPU service not configured (missing REPLICATE_API_TOKEN)" });
    }

    const { model, input, version, webhook } = req.body;

    if (!model) return res.status(400).json({ error: "Missing required field: model" });
    if (!input || typeof input !== "object") return res.status(400).json({ error: "Missing required field: input (object)" });

    let resolvedModel: string;
    try {
      resolvedModel = resolveModel(model);
    } catch (err: any) {
      return res.status(400).json({ error: err.message });
    }

    const [owner, name] = resolvedModel.split("/");
    let prediction: any;

    if (version) {
      prediction = await replicateRequest("/predictions", "POST", {
        version, input,
        ...(webhook ? { webhook, webhook_events_filter: ["completed"] } : {}),
      });
    } else {
      prediction = await replicateRequest(`/models/${owner}/${name}/predictions`, "POST", {
        input,
        ...(webhook ? { webhook, webhook_events_filter: ["completed"] } : {}),
      });
    }

    const response: any = {
      id: prediction.id,
      status: prediction.status,
      model: resolvedModel,
      created_at: prediction.created_at,
    };

    if (prediction.status === "succeeded") {
      response.output = prediction.output;
      response.metrics = prediction.metrics;
    } else if (prediction.status === "failed") {
      response.error = prediction.error;
    } else {
      response.poll_url = `/api/v1/gpu/status/${prediction.id}`;
      response.message = "Prediction is processing. Poll status URL or use a webhook.";
    }

    if (prediction.urls) response.urls = prediction.urls;

    return res.json(response);
  } catch (err: any) {
    console.error("[gpu/run]", err.message);
    return res.status(500).json({ error: err.message || "GPU request failed" });
  }
};

// ── GET /api/v1/gpu/status/:id ──────────────────────────────
export const gpuStatusHandler = async (req: Request, res: Response) => {
  try {
    if (!REPLICATE_TOKEN) return res.status(500).json({ error: "GPU service not configured" });

    const { id } = req.params;
    const prediction = await replicateRequest(`/predictions/${id}`);

    const response: any = {
      id: prediction.id,
      status: prediction.status,
      model: prediction.model,
      created_at: prediction.created_at,
    };

    if (prediction.status === "succeeded") {
      response.output = prediction.output;
      response.metrics = prediction.metrics;
      response.completed_at = prediction.completed_at;
    } else if (prediction.status === "failed") {
      response.error = prediction.error;
    } else {
      response.poll_url = `/api/v1/gpu/status/${prediction.id}`;
      response.logs = prediction.logs?.slice(-500);
    }

    return res.json(response);
  } catch (err: any) {
    console.error("[gpu/status]", err.message);
    return res.status(500).json({ error: err.message || "Failed to fetch status" });
  }
};

// ── GET /api/v1/gpu/models ──────────────────────────────────
export const gpuModelsHandler = async (_req: Request, res: Response) => {
  const categories: Record<string, any[]> = {};

  for (const [shortcut, info] of Object.entries(MODEL_SHORTCUTS)) {
    if (!categories[info.category]) categories[info.category] = [];
    categories[info.category].push({
      shortcut,
      model: info.model,
      description: info.description,
    });
  }

  return res.json({
    total: Object.keys(MODEL_SHORTCUTS).length,
    note: "You can also use any Replicate model by full ID (owner/model-name)",
    categories,
  });
};
