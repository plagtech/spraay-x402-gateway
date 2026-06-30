// src/routes/paid/image.ts — Dedicated Image Generation
// Matches BlockRun's blockrun_image ($0.015-$0.12)
//
// Routes through OpenAI (DALL-E 3 / GPT-image-2) and Replicate (FLUX/SDXL)
// Requires OPENAI_API_KEY and/or REPLICATE_API_TOKEN env vars

import { Router, Request, Response } from "express";

const router = Router();

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const REPLICATE_KEY = process.env.REPLICATE_API_TOKEN;

// POST /api/v1/image/generate
// Unified image generation endpoint
router.post("/generate", async (req: Request, res: Response) => {
  try {
    const {
      prompt,
      model = "dall-e-3",
      size = "1024x1024",
      quality = "standard",
      n = 1,
      style = "vivid",
    } = req.body;

    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    // Route to appropriate provider
    if (model === "dall-e-3" || model === "gpt-image-2" || model === "dall-e-2") {
      if (!OPENAI_KEY) return res.status(503).json({ error: "OpenAI not configured" });

      const resp = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify({
          model,
          prompt,
          size,
          quality,
          n: Math.min(n, 4),
          ...(model === "dall-e-3" && { style }),
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return res.status(resp.status).json({ error: "OpenAI image error", detail: err });
      }

      const data: any = await resp.json();
      return res.json({
        source: "openai",
        model,
        images: data.data.map((d: any) => ({
          url: d.url,
          revised_prompt: d.revised_prompt,
        })),
      });
    }

    // FLUX / SDXL via Replicate
    if (model.startsWith("flux") || model === "sdxl") {
      if (!REPLICATE_KEY) return res.status(503).json({ error: "Replicate not configured" });

      const replicateModel = model === "sdxl"
        ? "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b"
        : "black-forest-labs/flux-schnell";

      const resp = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${REPLICATE_KEY}`,
        },
        body: JSON.stringify({
          model: replicateModel,
          input: { prompt, num_outputs: Math.min(n, 4) },
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        return res.status(resp.status).json({ error: "Replicate error", detail: err });
      }

      const prediction: any = await resp.json();
      return res.json({
        source: "replicate",
        model,
        status: prediction.status,
        id: prediction.id,
        images: prediction.output || [],
        statusUrl: `/api/v1/image/status/${prediction.id}`,
        note: prediction.status !== "succeeded" ? "Poll statusUrl for completion" : undefined,
      });
    }

    return res.status(400).json({
      error: `Unknown model: ${model}`,
      available: ["dall-e-3", "gpt-image-2", "dall-e-2", "flux-schnell", "sdxl"],
    });
  } catch (err: any) {
    console.error("[image/generate] error:", err.message);
    res.status(502).json({ error: "Image generation error", detail: err.message });
  }
});

// POST /api/v1/image/edit — Image editing (img2img)
router.post("/edit", async (req: Request, res: Response) => {
  try {
    const { image_url, prompt } = req.body;
    if (!image_url || !prompt) {
      return res.status(400).json({ error: "image_url and prompt are required" });
    }

    if (!OPENAI_KEY) return res.status(503).json({ error: "OpenAI not configured" });

    // For DALL-E edit, we need to download the image first and send as form data
    // Simplified: use the variations endpoint or FLUX img2img
    return res.json({
      source: "spraay",
      note: "Image editing via FLUX img2img — use POST /api/v1/compute/image-generation with image_url parameter",
      redirect: "/api/v1/compute/image-generation",
    });
  } catch (err: any) {
    console.error("[image/edit] error:", err.message);
    res.status(502).json({ error: "Image edit error", detail: err.message });
  }
});

// GET /api/v1/image/status/:id — Poll Replicate prediction
router.get("/status/:id", async (req: Request, res: Response) => {
  try {
    if (!REPLICATE_KEY) return res.status(503).json({ error: "Replicate not configured" });

    const resp = await fetch(`https://api.replicate.com/v1/predictions/${req.params.id}`, {
      headers: { Authorization: `Bearer ${REPLICATE_KEY}` },
    });

    if (!resp.ok) throw new Error(`Replicate ${resp.status}`);
    const data: any = await resp.json();

    res.json({
      source: "replicate",
      id: data.id,
      status: data.status,
      images: data.output || [],
      error: data.error,
    });
  } catch (err: any) {
    console.error("[image/status] error:", err.message);
    res.status(502).json({ error: "Status check error", detail: err.message });
  }
});

export default router;
