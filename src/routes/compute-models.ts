// ============================================
// src/config/compute-models.ts
// Spraay Compute Services — Model Registry
// ============================================
// No tiers. Model-based pricing. Search-friendly naming.

export type ComputeJobType = "text-inference" | "image-generation" | "video-generation" | "text-to-speech" | "speech-to-text" | "embeddings";
export type ComputeProvider = "chutes" | "replicate" | "openrouter";

export interface ModelDef {
  id: string;
  provider: ComputeProvider;
  label: string;
  price: number;       // USDC per call
  description: string; // human-readable for discovery
}

export interface JobTypeDef {
  name: string;
  searchTerms: string[];  // for Bazaar/MCP discovery
  models: ModelDef[];
  defaultModel: string;   // model id
}

export const COMPUTE_JOBS: Record<ComputeJobType, JobTypeDef> = {

  "text-inference": {
    name: "Text Inference",
    searchTerms: ["LLM", "chat completion", "text generation", "AI chat", "language model", "text inference"],
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    models: [
      // Small / fast / cheap
      { id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B", provider: "chutes", label: "DeepSeek R1 Distill 7B", price: 0.005, description: "Fast reasoning model, great for classification and simple tasks" },
      { id: "mistralai/Mistral-7B-Instruct-v0.3", provider: "chutes", label: "Mistral 7B Instruct", price: 0.005, description: "Efficient instruction-following for routine agent tasks" },
      { id: "meta-llama/Llama-3.2-3B-Instruct", provider: "chutes", label: "Llama 3.2 3B", price: 0.003, description: "Smallest model, fastest responses, lowest cost" },
      { id: "Qwen/Qwen3-8B", provider: "chutes", label: "Qwen 3 8B", price: 0.005, description: "Strong multilingual reasoning at low cost" },
      // Medium / production
      { id: "meta-llama/Llama-3.3-70B-Instruct", provider: "chutes", label: "Llama 3.3 70B", price: 0.03, description: "Production-grade, strong general-purpose model" },
      { id: "Qwen/Qwen3-32B", provider: "chutes", label: "Qwen 3 32B", price: 0.02, description: "High-quality reasoning and code generation" },
      { id: "deepseek-ai/DeepSeek-R1-Distill-Llama-70B", provider: "chutes", label: "DeepSeek R1 70B", price: 0.03, description: "Deep reasoning on complex multi-step problems" },
      { id: "deepseek-ai/DeepSeek-V3-0324", provider: "chutes", label: "DeepSeek V3", price: 0.03, description: "Latest DeepSeek general-purpose model" },
      // Large / frontier
      { id: "meta-llama/Llama-3.1-405B-Instruct", provider: "chutes", label: "Llama 3.1 405B", price: 0.10, description: "Frontier open-source model, highest capability" },
      { id: "Qwen/Qwen3-235B-A22B", provider: "chutes", label: "Qwen 3 235B (MoE)", price: 0.08, description: "Massive mixture-of-experts for complex analysis" },
      { id: "deepseek-ai/DeepSeek-R1-0528", provider: "chutes", label: "DeepSeek R1 (latest)", price: 0.10, description: "Latest DeepSeek R1, strongest reasoning" },
    ],
  },

  "image-generation": {
    name: "Image Generation",
    searchTerms: ["text to image", "AI image generation", "image synthesis", "FLUX", "Stable Diffusion", "image creation"],
    defaultModel: "black-forest-labs/flux-schnell",
    models: [
      { id: "black-forest-labs/flux-schnell", provider: "replicate", label: "FLUX Schnell", price: 0.03, description: "Fast high-quality image generation, best for most use cases" },
      { id: "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc", provider: "replicate", label: "Stable Diffusion XL", price: 0.02, description: "Reliable image generation with broad style support" },
      { id: "black-forest-labs/flux-dev", provider: "replicate", label: "FLUX Dev", price: 0.06, description: "Higher quality FLUX with more detail and coherence" },
      { id: "black-forest-labs/flux-1.1-pro", provider: "replicate", label: "FLUX 1.1 Pro", price: 0.08, description: "Highest quality FLUX model, commercial grade" },
    ],
  },

  "video-generation": {
    name: "Video Generation",
    searchTerms: ["text to video", "AI video generation", "video synthesis", "video creation", "AI video"],
    defaultModel: "minimax/video-01-live",
    models: [
      { id: "minimax/video-01-live", provider: "replicate", label: "MiniMax Video 01", price: 0.50, description: "High-quality short video generation from text prompts" },
      { id: "wan-ai/wan-2.1:b851e7596b", provider: "replicate", label: "Wan 2.1", price: 0.40, description: "Fast video generation with good motion coherence" },
    ],
  },

  "text-to-speech": {
    name: "Text to Speech",
    searchTerms: ["TTS", "voice synthesis", "text to speech", "speech generation", "voice generation", "AI voice"],
    defaultModel: "lucataco/xtts-v2:684bc3855b",
    models: [
      { id: "lucataco/xtts-v2:684bc3855b", provider: "replicate", label: "XTTS V2", price: 0.03, description: "Natural multilingual text-to-speech with voice cloning" },
      { id: "meta/musicgen:671ac645ce5e", provider: "replicate", label: "MusicGen Large", price: 0.05, description: "AI music generation from text descriptions" },
    ],
  },

  "speech-to-text": {
    name: "Speech to Text",
    searchTerms: ["STT", "transcription", "audio transcription", "speech to text", "speech recognition", "whisper"],
    defaultModel: "openai/whisper:4d50797d",
    models: [
      { id: "openai/whisper:4d50797d", provider: "replicate", label: "Whisper Large V3", price: 0.02, description: "Industry-standard speech recognition, 100+ languages" },
    ],
  },

  "embeddings": {
    name: "Embeddings",
    searchTerms: ["text embeddings", "vector embeddings", "RAG", "semantic search", "similarity", "embedding model"],
    defaultModel: "BAAI/bge-large-en-v1.5",
    models: [
      { id: "BAAI/bge-large-en-v1.5", provider: "chutes", label: "BGE Large v1.5", price: 0.005, description: "High-quality text embeddings for RAG and semantic search" },
    ],
  },
};

export const BATCH_DISCOUNT = 0.10; // 10% discount on batch jobs

/** Validate job type */
export function isValidJobType(t: string): t is ComputeJobType {
  return t in COMPUTE_JOBS;
}

/** Get all models for a job type */
export function getModels(jobType: ComputeJobType): ModelDef[] {
  return COMPUTE_JOBS[jobType]?.models || [];
}

/** Resolve a model by id (exact or partial match), or return default */
export function resolveModel(jobType: ComputeJobType, requestedModel?: string): ModelDef | null {
  const jobDef = COMPUTE_JOBS[jobType];
  if (!jobDef || jobDef.models.length === 0) return null;

  if (!requestedModel || requestedModel === "auto") {
    return jobDef.models.find(m => m.id === jobDef.defaultModel) || jobDef.models[0];
  }

  // Exact match
  const exact = jobDef.models.find(m => m.id === requestedModel);
  if (exact) return exact;

  // Partial match (e.g. "flux-schnell" matches "black-forest-labs/flux-schnell")
  const partial = jobDef.models.find(m =>
    m.id.toLowerCase().includes(requestedModel.toLowerCase()) ||
    m.label.toLowerCase().includes(requestedModel.toLowerCase())
  );
  if (partial) return partial;

  return null;
}
