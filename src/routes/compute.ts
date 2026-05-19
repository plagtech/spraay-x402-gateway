// ============================================
// src/routes/compute.ts
// Spraay Compute Services — Route Handlers
// ============================================
// 10 endpoints: 7 paid + 3 free
// No tiers. Model-based pricing. Search-friendly names.

import { Request, Response } from "express";
import { randomUUID } from "crypto";
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
  getJobStatus,
} from "../services/compute-router.js";

// ─── 1. POST /api/v1/compute/text-inference ─────────────────

export async function textInferenceHandler(req: Request, res: Response) {
  try {
    const { messages, model: requestedModel, max_tokens, temperature, stream } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required." });
    }

    const modelDef = resolveModel("text-inference", requestedModel);
    if (!modelDef) {
      return res.status(400).json({
        error: `Model '${requestedModel}' not available. Use /compute/models to see available models, or pass "auto" for the default.`,
      });
    }

    const result = await chatCompletion({
      model: modelDef,
      messages,
      max_tokens: max_tokens || 1024,
      temperature: temperature ?? 0.7,
      stream: stream || false,
    });

    return res.json({
      provider: result.provider,
      model: result.model,
      model_label: modelDef.label,
      choices: result.choices,
      usage: result.usage,
      price_usdc: modelDef.price.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/text-inference]", err.message);
    return res.status(502).json({ error: "Text inference failed", details: err.message });
  }
}

// ─── 2. POST /api/v1/compute/image-generation ───────────────

export async function imageGenerationHandler(req: Request, res: Response) {
  try {
    const { prompt, model: requestedModel, width, height, num_outputs } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required." });
    }

    const modelDef = resolveModel("image-generation", requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for image generation.` });
    }

    const result = await imageGeneration({
      model: modelDef,
      prompt,
      width: width || 1024,
      height: height || 1024,
      num_outputs: num_outputs || 1,
    });

    return res.json({
      provider: result.provider,
      model: result.model,
      model_label: modelDef.label,
      status: result.status,
      images: result.images,
      prediction_id: result.prediction_id,
      poll_url: result.status === "processing" ? `/api/v1/compute/status/${result.prediction_id}` : undefined,
      price_usdc: modelDef.price.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/image-generation]", err.message);
    return res.status(502).json({ error: "Image generation failed", details: err.message });
  }
}

// ─── 3. POST /api/v1/compute/video-generation ───────────────

export async function videoGenerationHandler(req: Request, res: Response) {
  try {
    const { prompt, model: requestedModel, duration_seconds } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "prompt is required." });
    }

    const modelDef = resolveModel("video-generation", requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for video generation.` });
    }

    const result = await videoGeneration({
      model: modelDef,
      prompt,
      duration_seconds: duration_seconds || 4,
    });

    return res.json({
      provider: result.provider,
      model: result.model,
      model_label: modelDef.label,
      status: result.status,
      video_url: result.video_url,
      prediction_id: result.prediction_id,
      poll_url: `/api/v1/compute/status/${result.prediction_id}`,
      price_usdc: modelDef.price.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/video-generation]", err.message);
    return res.status(502).json({ error: "Video generation failed", details: err.message });
  }
}

// ─── 4. POST /api/v1/compute/text-to-speech ─────────────────

export async function textToSpeechHandler(req: Request, res: Response) {
  try {
    const { text, model: requestedModel, language } = req.body;

    if (!text) {
      return res.status(400).json({ error: "text is required." });
    }

    const modelDef = resolveModel("text-to-speech", requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for text-to-speech.` });
    }

    const result = await textToSpeech({
      model: modelDef,
      text,
      language: language || "en",
    });

    return res.json({
      provider: result.provider,
      model: result.model,
      model_label: modelDef.label,
      status: result.status,
      audio_url: result.audio_url,
      prediction_id: result.prediction_id,
      poll_url: result.status === "processing" ? `/api/v1/compute/status/${result.prediction_id}` : undefined,
      price_usdc: modelDef.price.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/text-to-speech]", err.message);
    return res.status(502).json({ error: "Text-to-speech failed", details: err.message });
  }
}

// ─── 5. POST /api/v1/compute/speech-to-text ─────────────────

export async function speechToTextHandler(req: Request, res: Response) {
  try {
    const { audio_url, model: requestedModel } = req.body;

    if (!audio_url) {
      return res.status(400).json({ error: "audio_url is required." });
    }

    const modelDef = resolveModel("speech-to-text", requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for speech-to-text.` });
    }

    const result = await speechToText({ model: modelDef, audio_url });

    return res.json({
      provider: result.provider,
      model: result.model,
      model_label: modelDef.label,
      status: result.status,
      transcription: result.transcription,
      prediction_id: result.prediction_id,
      poll_url: result.status === "processing" ? `/api/v1/compute/status/${result.prediction_id}` : undefined,
      price_usdc: modelDef.price.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/speech-to-text]", err.message);
    return res.status(502).json({ error: "Speech-to-text failed", details: err.message });
  }
}

// ─── 6. POST /api/v1/compute/embeddings ─────────────────────

export async function embeddingsHandler(req: Request, res: Response) {
  try {
    const { input, model: requestedModel } = req.body;

    if (!input) {
      return res.status(400).json({ error: "input is required (string or string array)." });
    }

    const modelDef = resolveModel("embeddings", requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for embeddings.` });
    }

    const result = await generateEmbeddings({ model: modelDef, input: String(input) });

    return res.json({
      provider: result.provider,
      model: result.model,
      model_label: modelDef.label,
      data: result.data,
      usage: result.usage,
      price_usdc: modelDef.price.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/embeddings]", err.message);
    return res.status(502).json({ error: "Embeddings generation failed", details: err.message });
  }
}

// ─── 7. POST /api/v1/compute/batch ──────────────────────────

interface BatchJob {
  type: ComputeJobType;
  model?: string;
  // text-inference
  messages?: Array<{ role: string; content: string }>;
  max_tokens?: number;
  // image/video
  prompt?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  // tts
  text?: string;
  language?: string;
  // stt
  audio_url?: string;
  // embeddings
  input?: string | string[];
}

export async function computeBatchHandler(req: Request, res: Response) {
  try {
    const { jobs } = req.body;

    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) {
      return res.status(400).json({ error: "jobs array is required and must not be empty." });
    }
    if (jobs.length > 50) {
      return res.status(400).json({ error: "Maximum 50 jobs per batch." });
    }

    // Validate and calculate pricing upfront
    let subtotal = 0;
    const resolvedJobs: Array<{ job: BatchJob; model: any; index: number }> = [];
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i] as BatchJob;
      if (!job.type || !isValidJobType(job.type)) {
        return res.status(400).json({ error: `Job ${i}: invalid type. Must be one of: ${Object.keys(COMPUTE_JOBS).join(", ")}` });
      }
      const modelDef = resolveModel(job.type, job.model);
      if (!modelDef) {
        return res.status(400).json({ error: `Job ${i}: model '${job.model || "auto"}' not available for ${job.type}.` });
      }
      subtotal += modelDef.price;
      resolvedJobs.push({ job, model: modelDef, index: i });
    }

    const discount = subtotal * BATCH_DISCOUNT;
    const total = subtotal - discount;
    const batchId = `batch_${randomUUID().slice(0, 12)}`;

    // Execute all jobs concurrently
    const results = await Promise.allSettled(
      resolvedJobs.map(async ({ job, model, index }: { job: BatchJob; model: any; index: number }) => {
        try {
          switch (job.type) {
            case "text-inference": {
              const r = await chatCompletion({ model, messages: job.messages || [], max_tokens: job.max_tokens || 512 });
              return { job_index: index, type: job.type, status: "completed", result: r };
            }
            case "image-generation": {
              const r = await imageGeneration({ model, prompt: job.prompt || "", width: job.width, height: job.height });
              return { job_index: index, type: job.type, status: r.status, result: r };
            }
            case "video-generation": {
              const r = await videoGeneration({ model, prompt: job.prompt || "", duration_seconds: job.duration_seconds });
              return { job_index: index, type: job.type, status: r.status, result: r };
            }
            case "text-to-speech": {
              const r = await textToSpeech({ model, text: job.text || "", language: job.language });
              return { job_index: index, type: job.type, status: r.status, result: r };
            }
            case "speech-to-text": {
              const r = await speechToText({ model, audio_url: job.audio_url || "" });
              return { job_index: index, type: job.type, status: r.status, result: r };
            }
            case "embeddings": {
              const r = await generateEmbeddings({ model, input: Array.isArray(job.input) ? job.input.join(" ") : (job.input || "") });
              return { job_index: index, type: job.type, status: "completed", result: r };
            }
            default:
              throw new Error(`Unknown job type: ${job.type}`);
          }
        } catch (err: any) {
          return { job_index: index, type: job.type, status: "failed", error: err.message };
        }
      })
    );

    const formatted = results.map((r, i) => {
      if (r.status === "fulfilled") return r.value;
      return { job_index: i, type: jobs[i].type, status: "failed", error: r.reason?.message || "Unknown error" };
    });

    return res.json({
      batch_id: batchId,
      jobs_submitted: jobs.length,
      jobs_completed: formatted.filter((r: any) => r.status === "completed").length,
      jobs_processing: formatted.filter((r: any) => r.status === "processing").length,
      jobs_failed: formatted.filter((r: any) => r.status === "failed").length,
      subtotal_usdc: subtotal.toFixed(3),
      discount_percent: `${BATCH_DISCOUNT * 100}%`,
      total_cost_usdc: total.toFixed(3),
      results: formatted,
    });
  } catch (err: any) {
    console.error("[compute/batch]", err.message);
    return res.status(502).json({ error: "Batch compute failed", details: err.message });
  }
}

// ─── 8. GET /api/v1/compute/status/:jobId ───────────────────

export async function computeStatusHandler(req: Request, res: Response) {
  try {
    const { jobId } = req.params;
    if (!jobId) return res.status(400).json({ error: "jobId is required." });

    const data = await getJobStatus(jobId) as any;

    return res.json({
      prediction_id: jobId,
      status: data.status,
      output: data.output || null,
      error: data.error || null,
      created_at: data.created_at,
      completed_at: data.completed_at,
      metrics: data.metrics || null,
    });
  } catch (err: any) {
    console.error("[compute/status]", err.message);
    return res.status(502).json({ error: "Failed to fetch job status", details: err.message });
  }
}

// ─── 9. GET /api/v1/compute/models (FREE) ───────────────────

export async function computeModelsHandler(_req: Request, res: Response) {
  const categories: Record<string, any> = {};
  let totalModels = 0;

  for (const [jobType, jobDef] of Object.entries(COMPUTE_JOBS)) {
    categories[jobType] = {
      name: jobDef.name,
      search_terms: jobDef.searchTerms,
      default_model: jobDef.defaultModel,
      models: jobDef.models.map(m => ({
        id: m.id,
        provider: m.provider,
        label: m.label,
        price_usdc: m.price.toFixed(3),
        description: m.description,
      })),
    };
    totalModels += jobDef.models.length;
  }

  return res.json({
    categories,
    total_models: totalModels,
    providers: ["chutes", "replicate", "openrouter"],
    batch_discount: `${BATCH_DISCOUNT * 100}%`,
    max_batch_size: 50,
  });
}

// ─── 10. POST /api/v1/compute/estimate (FREE) ──────────────

export async function computeEstimateHandler(req: Request, res: Response) {
  try {
    const { type, model: requestedModel, count } = req.body;

    if (!type || !isValidJobType(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${Object.keys(COMPUTE_JOBS).join(", ")}` });
    }

    const modelDef = resolveModel(type, requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel || "auto"}' not available for ${type}.` });
    }

    const quantity = Math.max(1, Math.min(count || 1, 1000));
    const subtotal = modelDef.price * quantity;
    const batchDiscount = quantity > 1 ? subtotal * BATCH_DISCOUNT : 0;
    const total = subtotal - batchDiscount;

    return res.json({
      type,
      model: { id: modelDef.id, provider: modelDef.provider, label: modelDef.label },
      unit_price_usdc: modelDef.price.toFixed(3),
      quantity,
      subtotal_usdc: subtotal.toFixed(3),
      batch_discount_usdc: batchDiscount.toFixed(3),
      total_usdc: total.toFixed(3),
    });
  } catch (err: any) {
    console.error("[compute/estimate]", err.message);
    return res.status(500).json({ error: "Estimate failed", details: err.message });
  }
}
