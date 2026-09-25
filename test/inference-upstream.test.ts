/**
 * Regression tests for the inference-upstream fixes:
 *   1.1 Bittensor example model — src/lib/bittensor-model.ts
 *   1.2 upstream provider failure → 502/503, never 402 —
 *       src/lib/upstream-errors.ts, src/routes/ai-gateway.ts,
 *       src/routes/bittensor-dropin.ts, src/middleware/enrich402.ts
 *   1.3 credits-exhausted log marker
 *
 * Offline: upstream HTTP (axios for OpenRouter, fetch for Chutes, the BlockRun
 * client) is stubbed. No network, no keys, no funds.
 *   npx ts-node --project test/tsconfig.json test/inference-upstream.test.ts   (npm run test:inference)
 */

import assert from "node:assert";

// Handlers read their provider keys at module load, so set them before the
// dynamic imports in main(). Dummy values only — nothing leaves the process.
process.env.OPENROUTER_API_KEY = "test-openrouter-key";
process.env.CHUTES_API_KEY = "test-chutes-key";
process.env.BLOCKRUN_WALLET_KEY = "0x" + "11".repeat(32);
// enrich402 → escrow → db constructs a Supabase client at import (no
// connection until a query, and none is made). Unreachable on purpose.
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_SERVICE_KEY = "test";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

// Minimal Express response double: records status, JSON body and locals.
function fakeRes() {
  const res: any = {
    statusCode: 200,
    locals: {},
    body: undefined as any,
    headers: {} as Record<string, string>,
    status(code: number) { res.statusCode = code; return res; },
    json(body: any) { res.body = body; return res; },
    set(k: string, v: string) { res.headers[k] = v; return res; },
    setHeader(k: string, v: string) { res.headers[k] = v; },
    getHeader(k: string) { return res.headers[k]; },
  };
  return res;
}

// Captures console.error lines for the duration of fn.
async function captureErrors(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: any[]) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.error = orig; }
  return lines;
}

async function main() {
  // require (not import()) so ts-node maps the `.js` specifiers to the .ts
  // sources; loaded here, after the env keys above are set.
  const { upstreamFailureStatus, UPSTREAM_CREDITS_MARKER }: typeof import("../src/lib/upstream-errors.js") = require("../src/lib/upstream-errors.js");
  const model: typeof import("../src/lib/bittensor-model.js") = require("../src/lib/bittensor-model.js");
  const dropin: typeof import("../src/routes/bittensor-dropin.js") = require("../src/routes/bittensor-dropin.js");
  const { aiChatHandler }: typeof import("../src/routes/ai-gateway.js") = require("../src/routes/ai-gateway.js");
  const { enrich402Middleware }: typeof import("../src/middleware/enrich402.js") = require("../src/middleware/enrich402.js");
  const axios: { post: unknown } = require("axios").default;
  // ai-gateway.ts loads @blockrun/llm with a native import(); do the same so
  // the prototype patched below is the one the handler's client uses.
  const blockrun = await import("@blockrun/llm");

  // ── 1.2 mapping table ─────────────────────────────────────────────
  console.log("\nupstreamFailureStatus");
  await test("402 credits exhausted → 503", () => assert.strictEqual(upstreamFailureStatus(402), 503));
  await test("503 → 503", () => assert.strictEqual(upstreamFailureStatus(503), 503));
  await test("404 model not found → 502", () => assert.strictEqual(upstreamFailureStatus(404), 502));
  await test("500 / 502 / 504 → 502", () => {
    for (const s of [500, 502, 504]) assert.strictEqual(upstreamFailureStatus(s), 502);
  });
  await test("400 / 429 are not provider failures (null)", () => {
    for (const s of [400, 429]) assert.strictEqual(upstreamFailureStatus(s), null);
  });

  // ── 1.2 Bittensor: status code, not body text ─────────────────────
  console.log("\nbittensorChatErrorStatus");
  const { UpstreamHttpError, ProviderNotConfiguredError, bittensorChatErrorStatus } = dropin;
  await test("404 whose body mentions 429 and 401 → 502 (was 429 by text match)", () => {
    const err = new UpstreamHttpError('Chutes AI returned 404: {"detail":"model 429-401 not found"}', 404);
    assert.strictEqual(bittensorChatErrorStatus(err), 502);
  });
  await test("402 → 503, 5xx → 502, 503 → 503", () => {
    assert.strictEqual(bittensorChatErrorStatus(new UpstreamHttpError("x", 402)), 503);
    assert.strictEqual(bittensorChatErrorStatus(new UpstreamHttpError("x", 500)), 502);
    assert.strictEqual(bittensorChatErrorStatus(new UpstreamHttpError("x", 503)), 503);
  });
  await test("429 keeps its pass-through", () => {
    assert.strictEqual(bittensorChatErrorStatus(new UpstreamHttpError("x", 429)), 429);
  });
  await test("not configured → 503; network error → 502", () => {
    assert.strictEqual(bittensorChatErrorStatus(new ProviderNotConfiguredError("Chutes AI (SN64) not configured")), 503);
    assert.strictEqual(bittensorChatErrorStatus(new TypeError("fetch failed")), 502);
  });

  console.log("\ndropinChatHandler (fetch stubbed)");
  const realFetch = globalThis.fetch;
  const chatReq = (m: string) => ({ body: { model: m, messages: [{ role: "user", content: "hi" }] } }) as any;
  try {
    await test("upstream 404 model not found → 502 with provider message, tagged upstream", async () => {
      globalThis.fetch = (async () => new Response('{"detail":"model not found: deepseek-ai/DeepSeek-V3-0324"}', { status: 404 })) as any;
      const res = fakeRes();
      await captureErrors(() => dropin.dropinChatHandler(chatReq("deepseek-ai/DeepSeek-V3-0324"), res));
      assert.strictEqual(res.statusCode, 502);
      assert.match(res.body.error.message, /model not found: deepseek-ai\/DeepSeek-V3-0324/);
      assert.strictEqual(res.locals.upstreamError, true);
    });
    await test("upstream 402 → 503 and logs the credits marker", async () => {
      globalThis.fetch = (async () => new Response('{"detail":"insufficient balance"}', { status: 402 })) as any;
      const res = fakeRes();
      const lines = await captureErrors(() => dropin.dropinChatHandler(chatReq("deepseek-ai/DeepSeek-V3.2-TEE"), res));
      assert.strictEqual(res.statusCode, 503);
      assert.ok(lines.some((l) => l.includes(UPSTREAM_CREDITS_MARKER)), "credits marker logged");
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  // ── 1.2 OpenRouter: no pass-through of 402/404/5xx ────────────────
  console.log("\naiChatHandler / OpenRouter (axios stubbed)");
  const realPost = axios.post;
  const orReq = { body: { model: "openai/gpt-5.5", messages: [{ role: "user", content: "hi" }] } } as any;
  const upstream = (status: number, data: any) => async () => { throw Object.assign(new Error(`Request failed with status code ${status}`), { response: { status, data } }); };
  try {
    await test("upstream 402 insufficient credits → 503, provider message kept, marker logged", async () => {
      const data = { error: { message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits", code: 402 } };
      (axios as any).post = upstream(402, data);
      const res = fakeRes();
      const lines = await captureErrors(() => aiChatHandler(orReq, res));
      assert.strictEqual(res.statusCode, 503);
      assert.deepStrictEqual(res.body, { error: "AI completion failed", details: data.error, upstream_status: 402 });
      assert.strictEqual(res.locals.upstreamError, true);
      assert.ok(lines.some((l) => l.includes(UPSTREAM_CREDITS_MARKER)), "credits marker logged");
    });
    await test("upstream 404 → 502, no credits marker", async () => {
      (axios as any).post = upstream(404, { error: { message: "No endpoints found", code: 404 } });
      const res = fakeRes();
      const lines = await captureErrors(() => aiChatHandler(orReq, res));
      assert.strictEqual(res.statusCode, 502);
      assert.strictEqual(res.body.upstream_status, 404);
      assert.ok(!lines.some((l) => l.includes(UPSTREAM_CREDITS_MARKER)));
    });
    await test("upstream 500 → 502, upstream 503 → 503", async () => {
      (axios as any).post = upstream(500, { error: { message: "boom" } });
      let res = fakeRes();
      await captureErrors(() => aiChatHandler(orReq, res));
      assert.strictEqual(res.statusCode, 502);
      (axios as any).post = upstream(503, { error: { message: "overloaded" } });
      res = fakeRes();
      await captureErrors(() => aiChatHandler(orReq, res));
      assert.strictEqual(res.statusCode, 503);
    });
    await test("upstream 400 unchanged: passes through with the original body shape", async () => {
      (axios as any).post = upstream(400, { error: { message: "bad param" } });
      const res = fakeRes();
      await captureErrors(() => aiChatHandler(orReq, res));
      assert.strictEqual(res.statusCode, 400);
      assert.deepStrictEqual(res.body, { error: "AI completion failed", details: { message: "bad param" } });
      assert.strictEqual(res.locals.upstreamError, undefined);
    });
    await test("no upstream response (network error) unchanged: 500", async () => {
      (axios as any).post = async () => { throw new Error("ECONNRESET"); };
      const res = fakeRes();
      await captureErrors(() => aiChatHandler(orReq, res));
      assert.strictEqual(res.statusCode, 500);
    });
  } finally {
    (axios as any).post = realPost;
  }

  // ── 1.2 BlockRun PaymentError → 502 ───────────────────────────────
  console.log("\naiChatHandler / BlockRun (client stubbed)");
  const realChat = blockrun.LLMClient.prototype.chatCompletion;
  try {
    await test("BlockRun PaymentError → 502 (was 402), marker logged, tagged upstream", async () => {
      blockrun.LLMClient.prototype.chatCompletion = async () => { throw new blockrun.PaymentError("Payment was rejected. Check your wallet balance."); };
      const res = fakeRes();
      const lines = await captureErrors(() => aiChatHandler({ body: { ...orReq.body, provider: "blockrun" } } as any, res));
      assert.strictEqual(res.statusCode, 502);
      assert.strictEqual(res.body.error, "BlockRun payment failed");
      assert.strictEqual(res.locals.upstreamError, true);
      assert.ok(lines.some((l) => l.includes(UPSTREAM_CREDITS_MARKER)), "credits marker logged");
    });
  } finally {
    blockrun.LLMClient.prototype.chatCompletion = realChat;
  }

  // ── 1.2 upstream 401 = the gateway's key rejected → 503 ───────────
  console.log("\nupstream 401 (all three providers)");
  try {
    await test("OpenRouter, Chutes and BlockRun upstream 401 → 503, tagged upstream, never 401", async () => {
      (axios as any).post = upstream(401, { error: { message: "No auth credentials found", code: 401 } });
      const or = fakeRes();
      await captureErrors(() => aiChatHandler(orReq, or));
      assert.strictEqual(or.statusCode, 503);
      assert.strictEqual(or.body.upstream_status, 401);
      assert.strictEqual(or.locals.upstreamError, true);

      globalThis.fetch = (async () => new Response('{"detail":"Invalid token"}', { status: 401 })) as any;
      const ch = fakeRes();
      await captureErrors(() => dropin.dropinChatHandler(chatReq("deepseek-ai/DeepSeek-V3.2-TEE"), ch));
      assert.strictEqual(ch.statusCode, 503);
      assert.match(ch.body.error.message, /Invalid token/);
      assert.strictEqual(ch.locals.upstreamError, true);

      blockrun.LLMClient.prototype.chatCompletion = async () => { throw new blockrun.APIError("Unauthorized", 401); };
      const br = fakeRes();
      await captureErrors(() => aiChatHandler({ body: { ...orReq.body, provider: "blockrun" } } as any, br));
      assert.strictEqual(br.statusCode, 503);
      assert.strictEqual(br.body.error, "BlockRun AI completion failed");
      assert.strictEqual(br.locals.upstreamError, true);
    });
  } finally {
    (axios as any).post = realPost;
    globalThis.fetch = realFetch;
    blockrun.LLMClient.prototype.chatCompletion = realChat;
  }

  // ── 1.2 enrich402 skips tagged upstream errors ────────────────────
  console.log("\nenrich402Middleware");
  const run402 = (path: string, body: any, upstreamError: boolean) => {
    const res = fakeRes();
    res.statusCode = 402;
    if (upstreamError) res.locals.upstreamError = true;
    enrich402Middleware({ method: "POST", baseUrl: "", path } as any, res, () => {});
    res.json(body);
    return res.body;
  };
  await test("a 402 tagged as upstream error passes through untouched", () => {
    const body = { error: "AI completion failed", details: { message: "Insufficient credits" } };
    assert.deepStrictEqual(run402("/api/v1/chat/completions", body, true), body);
  });
  await test("an untagged 402 is still enriched (x402 challenge path unchanged)", () => {
    const out = run402("/api/v1/chat/completions", { x402Version: 2, accepts: [] }, false);
    assert.ok(out._spraay, "_spraay added");
    assert.strictEqual(out.x402Version, 2);
  });

  // ── 1.1 Bittensor example model ───────────────────────────────────
  console.log("\nBittensor example model");
  const { PREFERRED_BITTENSOR_MODEL, pickBittensorModel, resolveBittensorModel, bindBittensorModel, bittensorExampleModel } = model;
  const live = [ // shapes and prices from the live GET /bittensor/v1/models, 2026-09-25
    { id: "Qwen/Qwen3.6-27B-TEE", pricing: { prompt: 0.3, completion: 2 } },
    { id: "deepseek-ai/DeepSeek-V3.2-TEE", pricing: { prompt: 1, completion: 1 } },
    { id: "moonshotai/Kimi-K3-TEE", pricing: { prompt: 3, completion: 15 } },
    { id: "unsloth/Mistral-Nemo-Instruct-2407-TEE", pricing: { prompt: 0.0245, completion: 0.0978 } },
  ];
  const withoutPreferred = live.filter((m) => m.id !== PREFERRED_BITTENSOR_MODEL);
  await test("preferred id is deepseek-ai/DeepSeek-V3.2-TEE and the pre-resolve default", () => {
    assert.strictEqual(PREFERRED_BITTENSOR_MODEL, "deepseek-ai/DeepSeek-V3.2-TEE");
    assert.strictEqual(bittensorExampleModel(), PREFERRED_BITTENSOR_MODEL);
  });
  await test("preferred listed → preferred", () => {
    assert.deepStrictEqual(pickBittensorModel(live), { id: PREFERRED_BITTENSOR_MODEL, source: "preferred" });
  });
  await test("preferred not listed → cheapest listed (prompt + completion)", () => {
    assert.deepStrictEqual(pickBittensorModel(withoutPreferred), { id: "unsloth/Mistral-Nemo-Instruct-2407-TEE", source: "cheapest" });
  });
  await test("no priced models / empty list → preferred as fallback", () => {
    assert.deepStrictEqual(pickBittensorModel([{ id: "a" }, { id: "b", pricing: { prompt: "1", completion: 2 } }]), { id: PREFERRED_BITTENSOR_MODEL, source: "fallback" });
    assert.deepStrictEqual(pickBittensorModel([]), { id: PREFERRED_BITTENSOR_MODEL, source: "fallback" });
  });
  await test("bound example objects follow the resolved id; enrich402 serves it", async () => {
    const example = bindBittensorModel({ model: "", messages: [] });
    assert.strictEqual(example.model, PREFERRED_BITTENSOR_MODEL);
    const pick = await resolveBittensorModel(async () => withoutPreferred);
    assert.strictEqual(pick.source, "cheapest");
    assert.strictEqual(example.model, "unsloth/Mistral-Nemo-Instruct-2407-TEE");
    const out = run402("/bittensor/v1/chat/completions", { x402Version: 2, accepts: [] }, false);
    assert.strictEqual(out._spraay.example_request.model, "unsloth/Mistral-Nemo-Instruct-2407-TEE");
  });
  await test("list call fails → preferred live id, never the dead DeepSeek-V3-0324", async () => {
    const example = bindBittensorModel({ model: "" });
    const pick = await resolveBittensorModel(async () => { throw new Error("Chutes AI returned 500: down"); });
    assert.deepStrictEqual(pick, { id: PREFERRED_BITTENSOR_MODEL, source: "fallback" });
    assert.strictEqual(example.model, PREFERRED_BITTENSOR_MODEL);
    assert.notStrictEqual(example.model, "deepseek-ai/DeepSeek-V3-0324");
  });
  await test("list call hangs → times out to the preferred id", async () => {
    const pick = await resolveBittensorModel(() => new Promise(() => {}), 50);
    assert.deepStrictEqual(pick, { id: PREFERRED_BITTENSOR_MODEL, source: "fallback" });
  });

  console.log(`\n${passed} passed`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error(err); process.exit(1); }
);
