// src/routes/free/chat.ts — Free AI chat via OpenRouter open-weight models
// Matches BlockRun's blockrun_chat mode:"free" (open models at $0)
//
// Reuses the same OpenRouter client/config as paid chat completions.
// Targets OpenRouter's ":free" model tier — no USDC charge to callers.
// Requires OPENROUTER_API_KEY env var (already set for paid chat).

import { Router, Request, Response } from "express";

const router = Router();

// Reuse the shared OpenRouter config used by paid chat completions.
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${OPENROUTER_API_KEY}`,
  "HTTP-Referer": "https://gateway.spraay.app",
  "X-Title": "Spraay x402 Gateway",
};

// Free open-weight models available through OpenRouter's ":free" tier.
const FREE_MODELS: Record<string, { id: string; description: string }> = {
  "llama-3.3-70b": { id: "meta-llama/llama-3.3-70b-instruct:free", description: "Llama 3.3 70B — strong general instruct" },
  "qwen3-80b": { id: "qwen/qwen3-next-80b-a3b-instruct:free", description: "Qwen3 Next 80B — multilingual & reasoning" },
  "gpt-oss-120b": { id: "openai/gpt-oss-120b:free", description: "GPT-OSS 120B — open-weight flagship" },
  "gpt-oss-20b": { id: "openai/gpt-oss-20b:free", description: "GPT-OSS 20B — fast & lightweight" },
  "qwen3-coder": { id: "qwen/qwen3-coder:free", description: "Qwen3 Coder — code generation" },
};

const DEFAULT_MODEL = "llama-3.3-70b";

// Back-compat: legacy aliases from the previous free-chat backend still resolve
// so existing callers/MCP tools don't break. Not advertised in /models.
const LEGACY_ALIASES: Record<string, string> = {
  "nvidia/deepseek-v4-flash": "llama-3.3-70b",
  "nvidia/qwen3-next-80b": "qwen3-80b",
  "nvidia/llama-4-maverick": "llama-3.3-70b",
  "nvidia/mistral-large-3": "gpt-oss-120b",
  "nvidia/nemotron-nano": "gpt-oss-20b",
};

// GET /free/chat/models — List available free models
router.get("/models", (_req: Request, res: Response) => {
  res.json({
    source: "openrouter",
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
  if (!OPENROUTER_API_KEY) {
    return res.status(503).json({
      error: "Free chat not configured",
      detail: "Free chat requires OPENROUTER_API_KEY environment variable",
    });
  }

  try {
    const { model, messages, max_tokens, temperature, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    // Resolve model — default to llama-3.3-70b; map legacy aliases transparently.
    let selectedAlias = model || DEFAULT_MODEL;
    if (LEGACY_ALIASES[selectedAlias]) selectedAlias = LEGACY_ALIASES[selectedAlias];
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
      const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: OPENROUTER_HEADERS,
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return res.status(resp.status).json({ error: "Upstream API error", detail: errText });
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
    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: OPENROUTER_HEADERS,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: "Upstream API error", detail: errText });
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
      source: "openrouter",
    });
  } catch (err: any) {
    console.error("[free/chat] error:", err.message);
    res.status(502).json({ error: "Upstream error", detail: err.message });
  }
});

export default router;
