// ============================================
// src/services/compute-router.ts
// Spraay Compute Services — Provider Router
// ============================================
// Real API calls to Chutes AI, Replicate, and OpenRouter.
// No mocks. No stubs.

import { ComputeProvider, ModelDef } from "../config/compute-models.js";

const CHUTES_BASE = "https://chutes.ai/v1";
const REPLICATE_BASE = "https://api.replicate.com/v1";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

function getChutesKey(): string {
  const key = process.env.CHUTES_API_KEY;
  if (!key) throw new Error("CHUTES_API_KEY not set");
  return key;
}

function getReplicateKey(): string {
  const key = process.env.REPLICATE_API_TOKEN;
  if (!key) throw new Error("REPLICATE_API_TOKEN not set");
  return key;
}

function getOpenRouterKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  return key;
}

// ─── Chat / Text Inference (Chutes + OpenRouter) ─────────────

export interface ChatRequest {
  model: ModelDef;
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatResponse {
  provider: ComputeProvider;
  model: string;
  choices: Array<{ message: { role: string; content: string }; finish_reason: string }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export async function chatCompletion(req: ChatRequest): Promise<ChatResponse> {
  const { model, messages, max_tokens = 1024, temperature = 0.7, stream = false } = req;

  if (model.provider === "chutes") {
    const resp = await fetch(`${CHUTES_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getChutesKey()}`,
      },
      body: JSON.stringify({ model: model.id, messages, max_tokens, temperature, stream }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`Chutes error ${resp.status}: ${err}`);
    }
    const data = await resp.json();
    return {
      provider: "chutes",
      model: model.id,
      choices: data.choices,
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  if (model.provider === "openrouter") {
    const resp = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${getOpenRouterKey()}`,
        "HTTP-Referer": "https://gateway.spraay.app",
        "X-Title": "Spraay Compute Gateway",
      },
      body: JSON.stringify({ model: model.id, messages, max_tokens, temperature }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenRouter error ${resp.status}: ${err}`);
    }
    const data = await resp.json();
    return {
      provider: "openrouter",
      model: model.id,
      choices: data.choices,
      usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  throw new Error(`Chat not supported on provider: ${model.provider}`);
}

// ─── Embeddings (Chutes) ─────────────────────────────────────

export interface EmbeddingsRequest {
  model: ModelDef;
  input: string | string[];
}

export interface EmbeddingsResponse {
  provider: ComputeProvider;
  model: string;
  data: Array<{ embedding: number[]; index: number }>;
  usage: { prompt_tokens: number; total_tokens: number };
}

export async function generateEmbeddings(req: EmbeddingsRequest): Promise<EmbeddingsResponse> {
  const { model, input } = req;

  const resp = await fetch(`${CHUTES_BASE}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${getChutesKey()}`,
    },
    body: JSON.stringify({ model: model.id, input }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Chutes embeddings error ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  return {
    provider: "chutes",
    model: model.id,
    data: data.data,
    usage: data.usage || { prompt_tokens: 0, total_tokens: 0 },
  };
}

// ─── Replicate Predictions (shared helper) ───────────────────

interface ReplicatePredictionOpts {
  model: ModelDef;
  input: Record<string, unknown>;
  waitForResult?: boolean;
}

interface ReplicatePredictionResult {
  id: string;
  status: string;
  output: unknown;
  error: string | null;
}

async function runReplicatePrediction(opts: ReplicatePredictionOpts): Promise<ReplicatePredictionResult> {
  const { model, input, waitForResult = true } = opts;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${getReplicateKey()}`,
  };
  if (waitForResult) headers["Prefer"] = "wait";

  const body: Record<string, unknown> = model.id.includes(":")
    ? { version: model.id.split(":")[1], input }
    : { model: model.id, input };

  const resp = await fetch(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Replicate error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return { id: data.id, status: data.status, output: data.output, error: data.error || null };
}

// ─── Image Generation ────────────────────────────────────────

export interface ImageRequest {
  model: ModelDef;
  prompt: string;
  width?: number;
  height?: number;
  num_outputs?: number;
}

export interface ImageResponse {
  provider: ComputeProvider;
  model: string;
  status: "completed" | "processing";
  images: Array<{ url: string; width: number; height: number }>;
  prediction_id: string;
}

export async function imageGeneration(req: ImageRequest): Promise<ImageResponse> {
  const { model, prompt, width = 1024, height = 1024, num_outputs = 1 } = req;

  const result = await runReplicatePrediction({
    model,
    input: { prompt, width, height, num_outputs },
  });

  if (result.status === "succeeded" && result.output) {
    const urls = Array.isArray(result.output) ? result.output : [result.output];
    return {
      provider: "replicate", model: model.id, status: "completed",
      images: urls.map((url: string) => ({ url, width, height })),
      prediction_id: result.id,
    };
  }

  return { provider: "replicate", model: model.id, status: "processing", images: [], prediction_id: result.id };
}

// ─── Video Generation ────────────────────────────────────────

export interface VideoRequest {
  model: ModelDef;
  prompt: string;
  duration_seconds?: number;
}

export interface VideoResponse {
  provider: ComputeProvider;
  model: string;
  status: "completed" | "processing";
  video_url: string | null;
  prediction_id: string;
}

export async function videoGeneration(req: VideoRequest): Promise<VideoResponse> {
  const { model, prompt, duration_seconds = 4 } = req;

  const result = await runReplicatePrediction({
    model,
    input: { prompt, duration: duration_seconds },
    waitForResult: false, // video is always async
  });

  if (result.status === "succeeded" && result.output) {
    const url = Array.isArray(result.output) ? result.output[0] : result.output;
    return { provider: "replicate", model: model.id, status: "completed", video_url: url as string, prediction_id: result.id };
  }

  return { provider: "replicate", model: model.id, status: "processing", video_url: null, prediction_id: result.id };
}

// ─── Text to Speech ──────────────────────────────────────────

export interface TTSRequest {
  model: ModelDef;
  text: string;
  language?: string;
}

export interface TTSResponse {
  provider: ComputeProvider;
  model: string;
  status: "completed" | "processing";
  audio_url: string | null;
  prediction_id: string;
}

export async function textToSpeech(req: TTSRequest): Promise<TTSResponse> {
  const { model, text, language = "en" } = req;

  const result = await runReplicatePrediction({
    model,
    input: { text, language },
  });

  if (result.status === "succeeded" && result.output) {
    const url = Array.isArray(result.output) ? result.output[0] : result.output;
    return { provider: "replicate", model: model.id, status: "completed", audio_url: url as string, prediction_id: result.id };
  }

  return { provider: "replicate", model: model.id, status: "processing", audio_url: null, prediction_id: result.id };
}

// ─── Speech to Text ──────────────────────────────────────────

export interface STTRequest {
  model: ModelDef;
  audio_url: string;
}

export interface STTResponse {
  provider: ComputeProvider;
  model: string;
  status: "completed" | "processing";
  transcription: string | null;
  prediction_id: string;
}

export async function speechToText(req: STTRequest): Promise<STTResponse> {
  const { model, audio_url } = req;

  const result = await runReplicatePrediction({
    model,
    input: { audio: audio_url },
  });

  if (result.status === "succeeded" && result.output) {
    const text = typeof result.output === "object"
      ? (result.output as any).transcription || JSON.stringify(result.output)
      : String(result.output);
    return { provider: "replicate", model: model.id, status: "completed", transcription: text, prediction_id: result.id };
  }

  return { provider: "replicate", model: model.id, status: "processing", transcription: null, prediction_id: result.id };
}

// ─── Job Status ──────────────────────────────────────────────

export async function getJobStatus(predictionId: string): Promise<Record<string, unknown>> {
  const resp = await fetch(`${REPLICATE_BASE}/predictions/${predictionId}`, {
    headers: { "Authorization": `Bearer ${getReplicateKey()}` },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Replicate status error ${resp.status}: ${err}`);
  }
  return resp.json();
}
