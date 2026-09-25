// ============================================
// SPRAAY BITTENSOR DROP-IN API
// src/routes/bittensor-dropin.ts
// ============================================
//
// A fully OpenAI-compatible API that routes to Bittensor inference
// subnets under the hood. Agents just swap their base_url:
//
//   baseURL: "https://gateway.spraay.app/bittensor/v1"
//
// Same endpoints, same format, same SDKs. x402 handles payment.
//
// Supported OpenAI-compatible endpoints:
//   GET  /bittensor/v1/models               — List available models
//   POST /bittensor/v1/chat/completions      — Chat completions (LLM)
//   POST /bittensor/v1/images/generations    — Image generation
//   POST /bittensor/v1/embeddings            — Text embeddings
//
// Providers:
//   Chutes AI (SN64)   — LLMs, embeddings (default for text)
//   Nineteen AI (SN19) — LLMs, image generation (default for images)
//
// Required env vars:
//   CHUTES_API_KEY      — from https://chutes.ai
//   NINETEEN_API_KEY    — from https://nineteen.ai (optional Phase 1)
//
// ============================================

import { Request, Response } from "express";
import { upstreamFailureStatus, markUpstreamError, logCreditsExhausted } from "../lib/upstream-errors.js";
import type { ListedModel } from "../lib/bittensor-model.js";

// A provider answered with a non-2xx status. Carries the status so callers map
// on the code, never on the upstream body text.
export class UpstreamHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "UpstreamHttpError";
  }
}

// The provider has no API key configured on this gateway.
export class ProviderNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderNotConfiguredError";
  }
}

// ============================================
// PROVIDER REGISTRY
// ============================================

interface Provider {
  id: string;
  name: string;
  subnet: number;
  baseUrl: string;
  getApiKey: () => string;
  supports: Set<string>;
}

const providers: Record<string, Provider> = {
  chutes: {
    id: "chutes",
    name: "Chutes AI",
    subnet: 64,
    baseUrl: process.env.CHUTES_API_URL || "https://llm.chutes.ai/v1",
    getApiKey: () => process.env.CHUTES_API_KEY || "",
    supports: new Set(["chat", "models", "embeddings"]),
  },
  nineteen: {
    id: "nineteen",
    name: "Nineteen AI",
    subnet: 19,
    baseUrl: process.env.NINETEEN_API_URL || "https://api.nineteen.ai/v1",
    getApiKey: () => process.env.NINETEEN_API_KEY || "",
    supports: new Set(["chat", "models", "images"]),
  },
};

// ============================================
// MODEL → PROVIDER ROUTING
// ============================================
// The router maps model IDs to the right provider.
// Known model prefixes route explicitly.
// Unknown models try the default, then fallback.

const MODEL_ROUTING: Record<string, string> = {
  // These prefixes are known to be on Chutes
  "deepseek-ai/": "chutes",
  "meta-llama/": "chutes",
  "mistralai/": "chutes",
  "Qwen/": "chutes",
  "microsoft/": "chutes",
  "google/": "chutes",
  "NousResearch/": "chutes",
  "01-ai/": "chutes",
  "bigcode/": "chutes",
  "codellama/": "chutes",
  "openchat/": "chutes",
  "teknium/": "chutes",
  "togethercomputer/": "chutes",
  "upstage/": "chutes",
  "WizardLM/": "chutes",
  "lmsys/": "chutes",
  "databricks/": "chutes",
  "unsloth/": "chutes",
};

const DEFAULT_CHAT_PROVIDER = "chutes";
const DEFAULT_IMAGE_PROVIDER = "nineteen";
const DEFAULT_EMBED_PROVIDER = "chutes";

function routeModel(model: string, taskType: "chat" | "images" | "embeddings"): Provider {
  // Check explicit model prefix routing
  for (const [prefix, providerId] of Object.entries(MODEL_ROUTING)) {
    if (model.startsWith(prefix)) {
      const p = providers[providerId];
      if (p.getApiKey() && p.supports.has(taskType)) return p;
    }
  }

  // Route by task type defaults
  const defaultId =
    taskType === "images"
      ? DEFAULT_IMAGE_PROVIDER
      : taskType === "embeddings"
        ? DEFAULT_EMBED_PROVIDER
        : DEFAULT_CHAT_PROVIDER;

  const defaultProvider = providers[defaultId];
  if (defaultProvider.getApiKey() && defaultProvider.supports.has(taskType)) {
    return defaultProvider;
  }

  // Fallback: try any configured provider that supports this task
  for (const p of Object.values(providers)) {
    if (p.getApiKey() && p.supports.has(taskType)) return p;
  }

  throw new Error("No inference provider configured. Set CHUTES_API_KEY or NINETEEN_API_KEY.");
}

// ============================================
// UPSTREAM PROXY
// ============================================

async function proxyToProvider(
  provider: Provider,
  path: string,
  method: string,
  body: any | undefined,
  isStream: boolean
): Promise<{ response: globalThis.Response; provider: Provider }> {
  const apiKey = provider.getApiKey();
  if (!apiKey) {
    throw new ProviderNotConfiguredError(`${provider.name} (SN${provider.subnet}) not configured`);
  }

  const url = `${provider.baseUrl}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  const response = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new UpstreamHttpError(
      `${provider.name} returned ${response.status}: ${errBody.slice(0, 300)}`,
      response.status
    );
  }

  return { response, provider };
}

// Chat models from Chutes (SN64), for resolving the published example model.
export async function listBittensorChatModels(): Promise<ListedModel[]> {
  const { response } = await proxyToProvider(providers.chutes, "/models", "GET", undefined, false);
  const data = (await response.json()) as any;
  return Array.isArray(data?.data) ? data.data : [];
}

// Status for a failed chat completion, decided by the upstream status code.
// 429 keeps its existing pass-through; provider failures (401 gateway key
// rejected, 402 credits, 404 model gone, 5xx) map via upstreamFailureStatus;
// anything else, including network errors, stays 502 as before.
export function bittensorChatErrorStatus(err: unknown): number {
  if (err instanceof ProviderNotConfiguredError) return 503;
  if (err instanceof UpstreamHttpError) {
    if (err.status === 429) return err.status;
    return upstreamFailureStatus(err.status) ?? 502;
  }
  return 502;
}

// ============================================
// Spraay metadata injector
// Adds _spraay block to non-streaming JSON responses
// ============================================
function addSpraayMeta(data: any, provider: Provider, latencyMs: number, extra?: Record<string, any>): any {
  return {
    ...data,
    _spraay: {
      gateway: "gateway.spraay.app",
      provider: provider.name,
      subnet: provider.subnet,
      network: "bittensor",
      latencyMs,
      protocol: "x402",
      payTo: process.env.PAY_TO_ADDRESS || "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8",
      ...extra,
    },
  };
}

// ============================================
// GET /bittensor/v1/models
// ============================================
export async function dropinModelsHandler(req: Request, res: Response) {
  try {
    const allModels: any[] = [];
    const errors: string[] = [];

    for (const provider of Object.values(providers)) {
      if (!provider.getApiKey() || !provider.supports.has("models")) continue;
      try {
        const { response } = await proxyToProvider(provider, "/models", "GET", undefined, false);
        const data = await response.json() as any;
        // Tag each model with its provider for routing transparency
        if (data?.data) {
          for (const model of data.data) {
            // Dedupe: skip if we already have this model ID
            if (!allModels.find((m) => m.id === model.id)) {
              allModels.push({
                ...model,
                // Optional: agents can ignore these extra fields
                _provider: provider.id,
                _subnet: provider.subnet,
              });
            }
          }
        }
      } catch (err) {
        errors.push(`${provider.name}: ${(err as Error).message}`);
      }
    }

    // Return in standard OpenAI format
    res.json({
      object: "list",
      data: allModels,
      // Extra metadata (ignored by standard OpenAI SDKs)
      ...(errors.length > 0 && { _warnings: errors }),
    });
  } catch (err) {
    console.error("[bittensor-dropin] models error:", err);
    res.status(500).json({
      error: {
        message: "Failed to fetch models",
        type: "server_error",
        code: "provider_error",
      },
    });
  }
}

// ============================================
// POST /bittensor/v1/chat/completions
// ============================================
export async function dropinChatHandler(req: Request, res: Response) {
  try {
    const body = req.body;
    const model = body?.model;
    const isStream = body?.stream === true;

    if (!model) {
      return res.status(400).json({
        error: {
          message: "Missing required parameter: 'model'",
          type: "invalid_request_error",
          param: "model",
          code: "missing_model",
        },
      });
    }

    if (!body?.messages || !Array.isArray(body.messages)) {
      return res.status(400).json({
        error: {
          message: "Missing required parameter: 'messages'",
          type: "invalid_request_error",
          param: "messages",
          code: "missing_messages",
        },
      });
    }

    const provider = routeModel(model, "chat");
    const startTime = Date.now();

    if (isStream) {
      const { response } = await proxyToProvider(
        provider,
        "/chat/completions",
        "POST",
        body,
        true
      );

      // Pass through SSE headers exactly as OpenAI does
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      // Extra headers that don't break anything but add transparency
      res.setHeader("X-Spraay-Provider", provider.id);
      res.setHeader("X-Spraay-Subnet", String(provider.subnet));

      const reader = response.body?.getReader();
      if (!reader) {
        return res.status(502).json({
          error: { message: "No stream from provider", type: "server_error" },
        });
      }

      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (streamErr) {
        console.error("[bittensor-dropin] stream error:", streamErr);
      } finally {
        res.end();
      }
      return;
    }

    // Non-streaming
    const { response } = await proxyToProvider(
      provider,
      "/chat/completions",
      "POST",
      body,
      false
    );
    const data = await response.json();
    const latencyMs = Date.now() - startTime;

    res.json(addSpraayMeta(data, provider, latencyMs, { model }));
  } catch (err) {
    console.error("[bittensor-dropin] chat error:", err);
    const message = (err as Error).message;

    // Return errors in OpenAI error format
    const status = bittensorChatErrorStatus(err);
    if (err instanceof UpstreamHttpError) {
      if (err.status === 402) logCreditsExhausted("Chutes AI", message);
      markUpstreamError(res);
    }

    res.status(status).json({
      error: {
        message: `Bittensor inference error: ${message}`,
        type: status === 429 ? "rate_limit_error" : "server_error",
        code: status === 429 ? "rate_limit_exceeded" : "provider_error",
      },
    });
  }
}

// ============================================
// POST /bittensor/v1/images/generations
// ============================================
export async function dropinImageHandler(req: Request, res: Response) {
  try {
    const body = req.body;

    if (!body?.prompt) {
      return res.status(400).json({
        error: {
          message: "Missing required parameter: 'prompt'",
          type: "invalid_request_error",
          param: "prompt",
          code: "missing_prompt",
        },
      });
    }

    const provider = routeModel(body.model || "default-image", "images");
    const startTime = Date.now();

    const { response } = await proxyToProvider(
      provider,
      "/images/generations",
      "POST",
      body,
      false
    );
    const data = await response.json();
    const latencyMs = Date.now() - startTime;

    res.json(addSpraayMeta(data, provider, latencyMs, { type: "image" }));
  } catch (err) {
    console.error("[bittensor-dropin] image error:", err);
    const message = (err as Error).message;
    const status = message.includes("not configured") ? 503 : 502;

    res.status(status).json({
      error: {
        message: `Image generation error: ${message}`,
        type: "server_error",
        code: "provider_error",
      },
    });
  }
}

// ============================================
// POST /bittensor/v1/embeddings
// ============================================
export async function dropinEmbeddingsHandler(req: Request, res: Response) {
  try {
    const body = req.body;

    if (!body?.input) {
      return res.status(400).json({
        error: {
          message: "Missing required parameter: 'input'",
          type: "invalid_request_error",
          param: "input",
          code: "missing_input",
        },
      });
    }

    if (!body?.model) {
      return res.status(400).json({
        error: {
          message: "Missing required parameter: 'model'",
          type: "invalid_request_error",
          param: "model",
          code: "missing_model",
        },
      });
    }

    const provider = routeModel(body.model, "embeddings");
    const startTime = Date.now();

    const { response } = await proxyToProvider(
      provider,
      "/embeddings",
      "POST",
      body,
      false
    );
    const data = await response.json();
    const latencyMs = Date.now() - startTime;

    res.json(addSpraayMeta(data, provider, latencyMs, { type: "embedding" }));
  } catch (err) {
    console.error("[bittensor-dropin] embeddings error:", err);
    const message = (err as Error).message;
    const status = message.includes("not configured") ? 503 : 502;

    res.status(status).json({
      error: {
        message: `Embeddings error: ${message}`,
        type: "server_error",
        code: "provider_error",
      },
    });
  }
}

// ============================================
// GET /bittensor/v1/health
// Non-standard but useful — won't break SDKs
// ============================================
export async function dropinHealthHandler(_req: Request, res: Response) {
  const status: Record<string, any> = {};

  for (const [id, provider] of Object.entries(providers)) {
    const apiKey = provider.getApiKey();
    if (!apiKey) {
      status[id] = { status: "not_configured", subnet: provider.subnet };
      continue;
    }
    try {
      const start = Date.now();
      const { response } = await proxyToProvider(provider, "/models", "GET", undefined, false);
      const data = await response.json() as any;
      status[id] = {
        status: "ok",
        subnet: provider.subnet,
        name: provider.name,
        latencyMs: Date.now() - start,
        models: data?.data?.length || 0,
      };
    } catch (err) {
      status[id] = {
        status: "error",
        subnet: provider.subnet,
        name: provider.name,
        error: (err as Error).message,
      };
    }
  }

  const liveCount = Object.values(status).filter((s) => s.status === "ok").length;

  res.json({
    status: liveCount > 0 ? "ok" : "degraded",
    providers: status,
    dropin: {
      baseUrl: "https://gateway.spraay.app/bittensor/v1",
      endpoints: [
        "GET  /models",
        "POST /chat/completions",
        "POST /images/generations",
        "POST /embeddings",
      ],
      payment: "x402 (USDC on Base)",
      note: "Drop-in replacement for OpenAI. Just change your base_url.",
    },
  });
}
