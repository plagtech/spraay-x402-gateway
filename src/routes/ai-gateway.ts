import { Request, Response } from "express";
import axios from "axios";
import { trackRequest } from "./health";

// ── Provider: OpenRouter (API key auth) ──────────────────────────────
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// ── Provider: BlockRun (x402 wallet auth — no API key needed) ────────
let blockrunClient: any = null;
const BLOCKRUN_WALLET_KEY = process.env.BLOCKRUN_WALLET_KEY;
const BLOCKRUN_ENABLED = process.env.BLOCKRUN_ENABLED !== "false"; // enabled by default if wallet key exists

async function getBlockRunClient() {
  if (blockrunClient) return blockrunClient;
  if (!BLOCKRUN_WALLET_KEY) return null;

  try {
    const { LLMClient } = await import("@blockrun/llm");
    blockrunClient = new LLMClient({
      privateKey: BLOCKRUN_WALLET_KEY,
    });
    console.log("[AI Gateway] BlockRun provider initialized (x402 wallet auth)");
    return blockrunClient;
  } catch (err: any) {
    console.error("[AI Gateway] BlockRun init failed:", err.message);
    return null;
  }
}

// Initialize on startup (non-blocking)
if (BLOCKRUN_WALLET_KEY && BLOCKRUN_ENABLED) {
  getBlockRunClient().catch(() => {});
}

/**
 * POST /api/v1/chat/completions
 *
 * OpenAI-compatible chat completions endpoint.
 * Supports two providers after x402 payment verification:
 *
 *   - "openrouter" (default) — 200+ models via API key
 *   - "blockrun" — 41+ models via x402 wallet payments (no API key)
 *
 * Body format (OpenAI-compatible):
 * {
 *   "model": "openai/gpt-4o",
 *   "messages": [{ "role": "user", "content": "Hello" }],
 *   "max_tokens": 1000,
 *   "temperature": 0.7,
 *   "provider": "blockrun",                  // optional — default: "openrouter"
 *   "routing_profile": "auto"                // optional — blockrun only: "free" | "eco" | "auto" | "premium"
 * }
 *
 * When provider is "blockrun" and model is "blockrun/auto", smart routing
 * selects the cheapest capable model automatically (saves up to 78%).
 */
export async function aiChatHandler(req: Request, res: Response) {
  try {
    const {
      model,
      messages,
      max_tokens,
      temperature,
      stream,
      provider = "openrouter",
      routing_profile,
      ...rest
    } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: "Missing required fields: model, messages",
        example: {
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
          provider: "openrouter",
        },
        providers: {
          openrouter: "200+ models via API key (default)",
          blockrun: "41+ models via x402 wallet — no API key needed",
        },
      });
    }

    // ── Route to BlockRun ────────────────────────────────────────────
    if (provider === "blockrun") {
      const client = await getBlockRunClient();

      if (!client || !BLOCKRUN_ENABLED) {
        return res.status(503).json({
          error: "BlockRun provider not available",
          details: !BLOCKRUN_WALLET_KEY
            ? "BLOCKRUN_WALLET_KEY not configured"
            : "BLOCKRUN_ENABLED is set to false",
          fallback: "Use provider: 'openrouter' instead",
        });
      }

      try {
        let result: any;
        let routingInfo: any = null;

        // Smart routing — let ClawRouter pick the cheapest capable model
        if (model === "blockrun/auto" || model === "auto") {
          const userMessage =
            messages
              .filter((m: any) => m.role === "user")
              .map((m: any) => m.content)
              .join("\n") || "";

          const smartResult = await client.smartChat(userMessage, {
            routingProfile: routing_profile || "auto",
            ...(messages.find((m: any) => m.role === "system")
              ? { system: messages.find((m: any) => m.role === "system").content }
              : {}),
          });

          result = smartResult.response;
          routingInfo = {
            routed_model: smartResult.model,
            tier: smartResult.routing?.tier,
            savings: smartResult.routing?.savings
              ? `${(smartResult.routing.savings * 100).toFixed(0)}%`
              : undefined,
            profile: routing_profile || "auto",
          };
        }
        // Direct model call — full chat completion with message history
        else {
          const chatResult = await client.chatCompletion(model, messages, {
            max_tokens: max_tokens || 1000,
            temperature: temperature || 0.7,
          });

          // Return in OpenAI-compatible format
          trackRequest("ai_chat");

          return res.json({
            ...chatResult,
            _gateway: {
              provider: "spraay-x402",
              protocol: "x402",
              powered_by: "blockrun",
              payment: "x402-to-x402",
            },
          });
        }

        // Smart routing response — wrap in OpenAI-compatible format
        trackRequest("ai_chat");

        return res.json({
          id: `spraay-${Date.now()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: result,
              },
              finish_reason: "stop",
            },
          ],
          _gateway: {
            provider: "spraay-x402",
            protocol: "x402",
            powered_by: "blockrun",
            payment: "x402-to-x402",
            routing: routingInfo,
          },
        });
      } catch (blockrunError: any) {
        console.error(
          "[AI Gateway] BlockRun error:",
          blockrunError?.message || blockrunError
        );

        // If it's a payment error, surface it clearly
        if (blockrunError?.constructor?.name === "PaymentError") {
          return res.status(402).json({
            error: "BlockRun payment failed",
            details:
              "Spraay gateway wallet may have insufficient USDC balance for BlockRun",
            suggestion: "Try provider: 'openrouter' as fallback",
          });
        }

        return res.status(500).json({
          error: "BlockRun AI completion failed",
          details: blockrunError?.message || "Unknown error",
          suggestion: "Try provider: 'openrouter' as fallback",
        });
      }
    }

    // ── Route to OpenRouter (default) ────────────────────────────────
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: "AI gateway not configured. OPENROUTER_API_KEY missing.",
      });
    }

    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model,
        messages,
        max_tokens: max_tokens || 1000,
        temperature: temperature || 0.7,
        ...rest,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://gateway.spraay.app",
          "X-Title": "Spraay x402 Gateway",
        },
      }
    );

    trackRequest("ai_chat");

    return res.json({
      ...response.data,
      _gateway: {
        provider: "spraay-x402",
        protocol: "x402",
        powered_by: "openrouter",
      },
    });
  } catch (error: any) {
    console.error("AI chat error:", error?.response?.data || error.message);
    return res.status(error?.response?.status || 500).json({
      error: "AI completion failed",
      details: error?.response?.data?.error || error.message,
    });
  }
}

/**
 * GET /api/v1/models
 *
 * Returns available AI models from both providers.
 * Agents can discover which models are available and pick a provider.
 */
export async function aiModelsHandler(_req: Request, res: Response) {
  try {
    const results: any = {
      providers: {
        openrouter: { status: "active", auth: "api_key", models_count: 0 },
        blockrun: {
          status: BLOCKRUN_WALLET_KEY && BLOCKRUN_ENABLED ? "active" : "inactive",
          auth: "x402_wallet",
          models_count: 0,
        },
      },
      models: [],
      _gateway: { provider: "spraay-x402" },
    };

    // ── BlockRun models ──────────────────────────────────────────────
    if (BLOCKRUN_WALLET_KEY && BLOCKRUN_ENABLED) {
      try {
        const client = await getBlockRunClient();
        if (client) {
          const blockrunModels = await client.listModels();
          const formatted = blockrunModels.map((m: any) => ({
            id: m.id,
            name: m.name || m.id,
            context_length: m.contextLength || m.context_length,
            pricing: {
              input: m.inputPrice,
              output: m.outputPrice,
            },
            provider: "blockrun",
            payment: "x402_wallet",
          }));
          results.models.push(...formatted);
          results.providers.blockrun.models_count = formatted.length;
        }
      } catch (err: any) {
        console.error("[AI Gateway] BlockRun models fetch failed:", err.message);
      }
    }

    // ── OpenRouter models ────────────────────────────────────────────
    if (OPENROUTER_API_KEY) {
      try {
        const response = await axios.get(`${OPENROUTER_BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
        });

        const openrouterModels = response.data.data.slice(0, 50).map((m: any) => ({
          id: m.id,
          name: m.name,
          context_length: m.context_length,
          pricing: m.pricing,
          provider: "openrouter",
          payment: "api_key",
        }));

        results.models.push(...openrouterModels);
        results.providers.openrouter.models_count = openrouterModels.length;
      } catch (err: any) {
        console.error("[AI Gateway] OpenRouter models fetch failed:", err.message);
        // Fall back to curated list
        const curated = CURATED_MODELS.map((m) => ({
          ...m,
          provider: "openrouter",
          payment: "api_key",
        }));
        results.models.push(...curated);
        results.providers.openrouter.models_count = curated.length;
      }
    } else {
      // No API key — use curated list
      const curated = CURATED_MODELS.map((m) => ({
        ...m,
        provider: "openrouter",
        payment: "api_key",
      }));
      results.models.push(...curated);
      results.providers.openrouter.models_count = curated.length;
    }

    results.total = results.models.length;
    trackRequest("ai_models");

    return res.json(results);
  } catch (error: any) {
    console.error("Models list error:", error.message);
    return res.status(500).json({ error: "Failed to fetch models" });
  }
}

// ── Curated fallback models (OpenRouter) ─────────────────────────────
const CURATED_MODELS = [
  { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", context_length: 128000 },
  {
    id: "anthropic/claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    context_length: 200000,
  },
  {
    id: "anthropic/claude-haiku-3.5",
    name: "Claude Haiku 3.5",
    context_length: 200000,
  },
  {
    id: "meta-llama/llama-3.1-405b-instruct",
    name: "Llama 3.1 405B",
    context_length: 131072,
  },
  {
    id: "meta-llama/llama-3.1-70b-instruct",
    name: "Llama 3.1 70B",
    context_length: 131072,
  },
  {
    id: "google/gemini-2.0-flash-001",
    name: "Gemini 2.0 Flash",
    context_length: 1048576,
  },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", context_length: 65536 },
  {
    id: "mistralai/mistral-large-latest",
    name: "Mistral Large",
    context_length: 128000,
  },
  { id: "x-ai/grok-2", name: "Grok 2", context_length: 131072 },
];
