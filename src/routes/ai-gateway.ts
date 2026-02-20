import { Request, Response } from "express";
import axios from "axios";
import { trackRequest } from "./health";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * POST /api/v1/chat/completions
 * 
 * OpenAI-compatible chat completions endpoint.
 * Proxies to OpenRouter (200+ models) after x402 payment is verified.
 * 
 * Agent sends USDC → x402 verifies → request proxied to OpenRouter → response returned.
 * 
 * Body format (OpenAI-compatible):
 * {
 *   "model": "openai/gpt-4o",          // or "anthropic/claude-sonnet-4-20250514", "meta-llama/llama-3-70b", etc.
 *   "messages": [
 *     { "role": "user", "content": "Hello" }
 *   ],
 *   "max_tokens": 1000,
 *   "temperature": 0.7
 * }
 */
export async function aiChatHandler(req: Request, res: Response) {
  try {
    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({
        error: "AI gateway not configured. OPENROUTER_API_KEY missing.",
      });
    }

    const { model, messages, max_tokens, temperature, stream, ...rest } = req.body;

    if (!model || !messages) {
      return res.status(400).json({
        error: "Missing required fields: model, messages",
        example: {
          model: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
    }

    // Proxy to OpenRouter
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
          "HTTP-Referer": "https://spraay-x402-gateway.vercel.app",
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
 * Returns available AI models with their pricing.
 * Useful for agents to discover which models they can use.
 */
export async function aiModelsHandler(_req: Request, res: Response) {
  try {
    if (!OPENROUTER_API_KEY) {
      // Return a curated list even without API key
      return res.json({
        models: CURATED_MODELS,
        total: CURATED_MODELS.length,
        _gateway: { provider: "spraay-x402" },
      });
    }

    // Fetch live models from OpenRouter
    const response = await axios.get(`${OPENROUTER_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
    });

    // Return top models with relevant info
    const models = response.data.data
      .slice(0, 50)
      .map((m: any) => ({
        id: m.id,
        name: m.name,
        context_length: m.context_length,
        pricing: m.pricing,
      }));

    trackRequest("ai_models");

    return res.json({
      models,
      total: response.data.data.length,
      _gateway: { provider: "spraay-x402" },
    });
  } catch (error: any) {
    console.error("Models list error:", error.message);
    return res.status(500).json({ error: "Failed to fetch models" });
  }
}

// Curated fallback list of popular models
const CURATED_MODELS = [
  { id: "openai/gpt-4o", name: "GPT-4o", context_length: 128000 },
  { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", context_length: 128000 },
  { id: "anthropic/claude-sonnet-4-20250514", name: "Claude Sonnet 4", context_length: 200000 },
  { id: "anthropic/claude-haiku-3.5", name: "Claude Haiku 3.5", context_length: 200000 },
  { id: "meta-llama/llama-3.1-405b-instruct", name: "Llama 3.1 405B", context_length: 131072 },
  { id: "meta-llama/llama-3.1-70b-instruct", name: "Llama 3.1 70B", context_length: 131072 },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", context_length: 1048576 },
  { id: "deepseek/deepseek-chat", name: "DeepSeek Chat", context_length: 65536 },
  { id: "mistralai/mistral-large-latest", name: "Mistral Large", context_length: 128000 },
  { id: "x-ai/grok-2", name: "Grok 2", context_length: 131072 },
];
