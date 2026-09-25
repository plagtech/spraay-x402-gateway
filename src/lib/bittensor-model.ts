// ============================================
// BITTENSOR EXAMPLE MODEL
// src/lib/bittensor-model.ts
// ============================================
//
// The model id the gateway publishes in its Bittensor examples (the 402
// bazaar input for /bittensor/v1/chat/completions, the _spraay
// example_request, the /bittensor/v1/models output example).
//
// Chutes retires model ids without notice: deepseek-ai/DeepSeek-V3-0324 was
// the documented example and returned "model not found" in Sep 2026. So the
// preferred id is checked against the live model list once at startup:
//   preferred id listed      → preferred id
//   preferred id not listed  → cheapest listed model (prompt + completion price)
//   list call fails or empty → preferred id (live as of 2026-09-25)
//
// The chat handler has no default model — callers always send one — so this
// only keeps the published examples runnable.

export const PREFERRED_BITTENSOR_MODEL = "deepseek-ai/DeepSeek-V3.2-TEE";

const LIST_TIMEOUT_MS = 10_000;

export interface ListedModel {
  id: string;
  pricing?: { prompt?: unknown; completion?: unknown };
}

export type ModelSource = "preferred" | "cheapest" | "fallback";

let current = PREFERRED_BITTENSOR_MODEL;
const bindings: Array<{ obj: Record<string, unknown>; key: string }> = [];

export function bittensorExampleModel(): string {
  return current;
}

/**
 * Registers an example object whose `key` field carries the model id. The
 * field is set now and rewritten in place when the live list resolves; the
 * x402 route config and enrich402 hold these objects by reference, so the
 * served examples follow without rebuilding the payment middleware.
 */
export function bindBittensorModel<T extends Record<string, unknown>>(obj: T, key = "model"): T {
  (obj as Record<string, unknown>)[key] = current;
  bindings.push({ obj, key });
  return obj;
}

function listedPrice(m: ListedModel): number | null {
  const prompt = m.pricing?.prompt;
  const completion = m.pricing?.completion;
  if (typeof prompt !== "number" || typeof completion !== "number") return null;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return prompt + completion;
}

export function pickBittensorModel(models: ListedModel[]): { id: string; source: ModelSource } {
  if (models.some((m) => m.id === PREFERRED_BITTENSOR_MODEL)) {
    return { id: PREFERRED_BITTENSOR_MODEL, source: "preferred" };
  }
  let cheapest: { id: string; price: number } | null = null;
  for (const m of models) {
    const price = listedPrice(m);
    if (price === null || typeof m.id !== "string" || !m.id) continue;
    if (!cheapest || price < cheapest.price) cheapest = { id: m.id, price };
  }
  if (cheapest) return { id: cheapest.id, source: "cheapest" };
  return { id: PREFERRED_BITTENSOR_MODEL, source: "fallback" };
}

/** Resolves the example model from the live list. Never throws. */
export async function resolveBittensorModel(
  listModels: () => Promise<ListedModel[]>,
  timeoutMs = LIST_TIMEOUT_MS
): Promise<{ id: string; source: ModelSource }> {
  let pick: { id: string; source: ModelSource };
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`model list timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    pick = pickBittensorModel(await Promise.race([listModels(), timeout]));
  } catch (err) {
    console.warn(`[bittensor] model list unavailable (${(err as Error).message}) — using ${PREFERRED_BITTENSOR_MODEL}`);
    pick = { id: PREFERRED_BITTENSOR_MODEL, source: "fallback" };
  } finally {
    if (timer) clearTimeout(timer);
  }

  current = pick.id;
  for (const { obj, key } of bindings) obj[key] = current;
  console.log(`[bittensor] example model: ${current} (${pick.source})`);
  return pick;
}
