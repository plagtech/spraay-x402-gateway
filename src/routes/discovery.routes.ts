/**
 * discovery.routes.ts — serves llms.txt + llms-full.txt (free, no x402).
 *
 * Mount BEFORE your x402 payment middleware so these stay free:
 *
 *   import discoveryRoutes from "./routes/discovery.routes";
 *   app.use(discoveryRoutes);          // <-- before app.use(x402Middleware)
 *
 * IMPORTANT: delete your existing inline app.get("/llms.txt", ...) handler
 * (around line 1845 of src/index.ts) or it will collide with this route.
 * Keep your existing /openapi.json route — this router does NOT touch it.
 *
 * Files are produced by scripts/gen-discovery.mjs into ./public.
 * Add to package.json: "prebuild": "node scripts/gen-discovery.mjs"
 * They're read once at startup and cached in memory.
 */

import { Router, type Request, type Response } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = process.env.DISCOVERY_OUT_DIR || join(process.cwd(), "public");

function load(file: string): string {
  try {
    return readFileSync(join(PUBLIC_DIR, file), "utf8");
  } catch {
    console.warn(`[discovery] ${file} not found in ${PUBLIC_DIR} — run gen-discovery.mjs`);
    return "";
  }
}

const llms = load("llms.txt");
const llmsFull = load("llms-full.txt");

const router = Router();

const sendText = (res: Response, body: string) => {
  if (!body) return res.status(404).type("text/plain").send("Not generated yet");
  res
    .status(200)
    .type("text/plain; charset=utf-8")
    .set("Cache-Control", "public, max-age=3600")
    .send(body);
};

router.get("/llms.txt", (_req: Request, res: Response) => sendText(res, llms));
router.get("/llms-full.txt", (_req: Request, res: Response) => sendText(res, llmsFull));

export default router;
