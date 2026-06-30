// src/routes/free/chat.ts — Free AI chat via NVIDIA NIM API
// Matches BlockRun's blockrun_chat mode:"free" (NVIDIA models at $0)
//
// NVIDIA NIM provides free inference for select models.
// Requires NVIDIA_NIM_API_KEY env var (free to obtain at build.nvidia.com)

import { Router, Request, Response } from "express";

const router = Router();

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const NVIDIA_API_KEY = process.env.NVIDIA_NIM_API_KEY;

// Free models available through NVIDIA NIM
const FREE_MODELS: Record<string, { id: string; description: string }> = {
  "nvidia/deepseek-v4-flash": { id: "deepseek-ai/deepseek-r1-distill-llama-70b", description: "DeepSeek V4 Flash — fast chat & reasoning" },
  "nvidia/qwen3-next-80b": { id: "nvidia/qwen3-next-80b-a3b-thinking", description: "Qwen3 80B MoE — strong multilingual" },
  "nvidia/llama-4-maverick": { id: "meta/llama-4-maverick-17b-128e-instruct", description: "Llama 4 Maverick — efficient reasoning" },
  "nvidia/mistral-large-3": { id: "mistralai/mistral-large-2-instruct", description: "Mistral Large — code & analysis" },
  "nvidia/nemotron-nano": { id: "nvidia/llama-3.3-nemotron-super-49b-v1", description: "Nemotron Super — NVIDIA optimized" },
};

// GET /free/chat/models — List available free models
router.get("/models", (_req: Request, res: Response) => {
  res.json({
    source: "nvidia-nim",
    tier: "free",
    cost: "$0.00",
    models: Object.entries(FREE_MODELS).map(([alias, m]) => ({
      id: alias,
      upstream: m.id,
      description: m.description,
    })),
    note: "All models are free. No USDC charge. Fund your wallet for paid endpoints only.",
  });
});

// POST /free/chat — Free chat completion
router.post("/", async (req: Request, res: Response) => {
  if (!NVIDIA_API_KEY) {
    return res.status(503).json({
      error: "NVIDIA NIM not configured",
      detail: "Free chat requires NVIDIA_NIM_API_KEY environment variable",
    });
  }

  try {
    const { model, messages, max_tokens, temperature, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Resolve model — default to deepseek-v4-flash
    const selectedAlias = model || "nvidia/deepseek-v4-flash";
    const modelEntry = FREE_MODELS[selectedAlias];
    if (!modelEntry) {
      return res.status(400).json({
        error: `Unknown free model: ${selectedAlias}`,
        available: Object.keys(FREE_MODELS),
        hint: "Use a paid endpoint for 200+ models: POST /api/v1/chat/completions",
      });
    }

    const upstreamModel = modelEntry.id;

    const body = {
      model: upstreamModel,
      messages,
      max_tokens: max_tokens || 1024,
      temperature: temperature ?? 0.7,
      stream: !!stream,
    };

    // Streaming response
    if (stream) {
      const resp = await fetch(`${NVIDIA_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${NVIDIA_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: "NVIDIA API error", detail: errText });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const reader = resp.body?.getReader();
      if (!reader) {
        res.end();
        return;
      }
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } finally {
        res.end();
      }
      return;
    }

    // Non-streaming response
    const resp = await fetch(`${NVIDIA_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${NVIDIA_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: "NVIDIA API error", detail: errText });
    }

    const data: any = await resp.json();

    // Return OpenAI-compatible format
    res.json({
      id: data.id || `spraay-free-${Date.now()}`,
      object: "chat.completion",
      model: selectedAlias,
      upstream_model: upstreamModel,
      tier: "free",
      cost: "$0.00",
      choices: data.choices,
      usage: data.usage,
      source: "nvidia-nim",
    });
  } catch (err: any) {
    console.error("[free/chat] error:", err.message);
    res.status(502).json({ error: "Upstream error", detail: err.message });
  }
});

export default router;
