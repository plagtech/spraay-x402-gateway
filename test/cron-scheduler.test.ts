/**
 * Tests for cron scheduler v1 (trigger-only):
 *   src/cron/*, src/routes/cron.ts, src/middleware/cronCreatePrecheck.ts,
 *   cronDb in src/db.ts, WebhookService.queueSignedEvent.
 *
 *   - schedule rules: exactly 5 fields, UTC, >= 1 hour between runs
 *   - create: field validation, scheduler-off 503, owner + secret stored,
 *     secret returned once
 *   - ownership: list/cancel only ever see the caller's own jobs; an API key
 *     wins over a (possibly forged) payment header
 *   - precheck: no payment proof passes through untouched; paid + invalid
 *     is answered before the payment gate
 *   - worker: exactly-one claim under parallel ticks, job secret signs the
 *     delivery, completion at maxRuns, missed / legacy / cancelled / unsafe
 *   - prices: $0.10 for cron/create on every code surface
 *
 * Offline: the real handlers run on a local Express app against a small
 * stateful PostgREST mock in this file. No network, no database, no funds.
 * Callback URLs are IP literals so the SSRF guard's DNS lookup never leaves
 * the machine.
 *   npx ts-node --project test/tsconfig.json test/cron-scheduler.test.ts
 */

import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { AddressInfo } from "node:net";

// ── stateful PostgREST mock ─────────────────────────────────────────
// Only the surface cronDb and WebhookService use: cron_jobs (select / count /
// insert / conditional update), cron_runs (insert), webhook_events (insert,
// update) and the increment_webhook_attempts rpc.
const tables: Record<string, Map<string, Record<string, any>>> = {
  cron_jobs: new Map(), cron_runs: new Map(), webhook_events: new Map(),
};
const jobs = tables.cron_jobs, runs = tables.cron_runs, events = tables.webhook_events;
let seq = 0;

function filters(url: URL) {
  const out: Array<(row: any) => boolean> = [];
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (v.startsWith("eq.")) out.push(r => r[k] != null && String(r[k]) === v.slice(3));
    else if (v === "not.is.null") out.push(r => r[k] != null);
    else if (v === "is.null") out.push(r => r[k] == null);
    else if (v.startsWith("lte.")) out.push(r => r[k] != null && String(r[k]) <= v.slice(4));
    else throw new Error(`mock: unsupported filter ${k}=${v}`);
  }
  return (row: any) => out.every(f => f(row));
}

const db = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url!, "http://mock");
    const name = url.pathname.replace("/rest/v1/", "");
    const single = String(req.headers.accept || "").includes("pgrst.object");
    const send = (code: number, payload?: any, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const one = (rows: any[]) => rows.length === 1
      ? send(200, rows[0])
      : send(406, { code: "PGRST116", details: `Results contain ${rows.length} rows`, hint: null,
                    message: "JSON object requested, multiple (or no) rows returned" });

    if (name.startsWith("rpc/")) return send(204);
    const table = tables[name];
    if (!table) return send(404, { message: `mock: no table ${name}` });
    const match = filters(url);

    if (req.method === "HEAD") {
      return send(200, undefined, { "Content-Range": `*/${[...table.values()].filter(match).length}` });
    }
    if (req.method === "GET") {
      let rows = [...table.values()].filter(match);
      const order = url.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        rows.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === "desc" ? -1 : 1));
      }
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return single ? one(rows) : send(200, rows);
    }
    if (req.method === "POST") {
      const body = JSON.parse(raw);
      const row = { ...body };
      if (!row.id) row.id = `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
      if (name === "webhook_events") Object.assign(row, { attempts: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      if (name === "cron_runs") {
        const dup = [...runs.values()].some(r => r.job_id === row.job_id && r.claim_seq === row.claim_seq);
        if (dup) return send(409, { code: "23505", message: "duplicate key value violates unique constraint" });
      }
      table.set(row.id, row);
      return single ? send(201, row) : send(201, [row]);
    }
    if (req.method === "PATCH") {
      const rows = [...table.values()].filter(match);
      for (const r of rows) Object.assign(r, JSON.parse(raw));
      return single ? one(rows) : send(200, rows);
    }
    return send(405, {});
  });
});

// ── harness ─────────────────────────────────────────────────────────
const out = (s: string) => process.stdout.write(s + "\n");
let failed = 0, passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; out(`  PASS  ${name}`); }
  catch (err: any) { failed++; out(`  FAIL  ${name}\n        ${String(err.message).split("\n").join("\n        ")}`); }
}

const logLines: string[] = [];
for (const m of ["log", "warn", "error", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: any[]) => {
    logLines.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    if (m === "error" && process.env.CRON_TEST_VERBOSE) orig(...a);
  };
}

// Stub DNS for *.test hostnames so the SSRF guard's two failure kinds can be
// driven offline: "dnsfail.test" fails to resolve (transient), "internal.test"
// resolves to a private address (unsafe). ssrf-guard calls lookup through the
// module object, so patching the export is enough.
const dnsPromises = require("node:dns/promises");
const realLookup = dnsPromises.lookup;
dnsPromises.lookup = async (host: string, ...rest: any[]) => {
  if (host === "dnsfail.test") throw Object.assign(new Error("getaddrinfo ENOTFOUND dnsfail.test"), { code: "ENOTFOUND" });
  if (host === "internal.test") return { address: "10.1.2.3", family: 4 };
  return realLookup(host, ...rest);
};

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET_C = "0xcccccccccccccccccccccccccccccccccccccccc";
const evmPayment = (from: string) =>
  Buffer.from(JSON.stringify({ x402Version: 2, payload: { signature: "0x00", authorization: { from } } })).toString("base64");
const asWallet = (w: string) => ({ "payment-signature": evmPayment(w) });

const SAFE_URL = "https://1.1.1.1/spraay/cron";     // public IP literal: no DNS, passes the guard
const PRIVATE_URL = "https://127.0.0.1/hook";
const VALID = {
  action: "webhook.trigger", schedule: "0 9 * * 1", payload: { note: "weekly payroll reminder" },
  callback_url: SAFE_URL,
};

let GW = "";
const responses: Array<{ route: string; text: string }> = [];
async function call(method: string, p: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(GW + p, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  responses.push({ route: `${method} ${p}`, text });
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const create = (b: any, h: Record<string, string>) => call("POST", "/api/v1/cron/create", b, h);
const list = (h: Record<string, string>, q = "") => call("GET", "/api/v1/cron/list" + q, undefined, h);
const cancel = (b: any, h: Record<string, string>) => call("POST", "/api/v1/cron/cancel", b, h);

function seedJob(over: Record<string, any>) {
  const row = {
    id: `cron_seed_${++seq}`, action: "webhook.trigger", schedule: "0 9 * * *", payload: { n: 1 },
    status: "active", next_run: "2026-10-12T09:00:00.000Z", last_run: null, run_count: 0, max_runs: 100,
    metadata: {}, created_at: "2026-10-01T00:00:00.000Z", owner: "evm:" + WALLET_C, callback_url: SAFE_URL,
    hmac_secret: "whsec_seed" + seq, claim_seq: 0, missed_count: 0, last_error: null, cancelled_at: null,
    ...over,
  };
  jobs.set(row.id, row);
  return row;
}
const eventsFor = (jobId: string) => [...events.values()].filter(e => e.source_endpoint === "cron:" + jobId);
const runsFor = (jobId: string) => [...runs.values()].filter(r => r.job_id === jobId);

async function main() {
  await new Promise<void>(ok => db.listen(0, "127.0.0.1", ok));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(db.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_KEY = "test";
  process.env.CRON_WORKER_ENABLED = "true";

  // require (not import()) so ts-node maps `.js` specifiers to the .ts source
  // after SUPABASE_URL is set — db.ts builds its client at load.
  const express: typeof import("express") = require("express");
  const { createClient } = require("@supabase/supabase-js");
  const h: typeof import("../src/routes/cron.js") = require("../src/routes/cron.js");
  const { cronCreatePrecheck }: typeof import("../src/middleware/cronCreatePrecheck.js") = require("../src/middleware/cronCreatePrecheck.js");
  const { validateSchedule, nextRun }: typeof import("../src/cron/schedule.js") = require("../src/cron/schedule.js");
  const { resolveCronCaller }: typeof import("../src/cron/identity.js") = require("../src/cron/identity.js");
  const { runCronTick }: typeof import("../src/cron/worker.js") = require("../src/cron/worker.js");
  const { WebhookService, verifySignature } = require("../src/webhooks/index.js");

  const webhookService = new WebhookService(createClient(process.env.SUPABASE_URL, "test"));
  const deps = { webhookService };

  const app = express();
  app.use(express.json());
  // Stand-in for apiKeyAuth.ts: a valid key sets these flags (and suppresses the 402).
  app.use((req: any, _res, next) => {
    const key = req.headers["x-test-api-key"];
    if (typeof key === "string") { req.apiKeyAuth = true; req.apiKeyEmail = key; }
    next();
  });
  app.post("/api/v1/cron/create", h.cronCreateHandler);
  app.get("/api/v1/cron/list", h.cronListHandler);
  app.post("/api/v1/cron/cancel", h.cronCancelHandler);
  // Precheck in front of a sentinel standing in for paymentMiddleware + handler.
  let reached = 0;
  app.post("/pre", cronCreatePrecheck, (_req, res) => { reached++; res.status(299).json({ reached: true }); });
  const gw = await new Promise<http.Server>(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  GW = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  // Local receiver for the end-to-end signature check.
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
  const receiver = http.createServer((req, res) => {
    let b = ""; req.on("data", c => (b += c));
    req.on("end", () => { received.push({ headers: req.headers, body: b }); res.writeHead(200); res.end("ok"); });
  });
  await new Promise<void>(ok => receiver.listen(0, "127.0.0.1", ok));
  const RECEIVER = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  try {
    out("── schedule rules");
    const NOW = new Date("2026-10-08T12:00:00Z");
    for (const s of ["", "   ", "0 9 * *", "0 0 9 * * *", "@daily", "61 * * * *", "0 0 31 2 *"]) {
      await test(`rejects ${JSON.stringify(s)}`, async () => {
        assert.strictEqual(validateSchedule(s, NOW).ok, false);
      });
    }
    for (const s of ["*/30 * * * *", "0,30 9 * * *", "* * * * *"]) {
      await test(`rejects ${JSON.stringify(s)} for the 1-hour minimum, error names it`, async () => {
        const r = validateSchedule(s, NOW);
        assert.strictEqual(r.ok, false);
        assert.match((r as any).error, /Minimum interval between runs is 1 hour \(3600 seconds\)/);
      });
    }
    for (const s of ["0 * * * *", "0 9 * * 1", "  0   9  *  *  1 "]) {
      await test(`accepts ${JSON.stringify(s)} (normalized)`, async () => {
        const r = validateSchedule(s, NOW);
        assert.strictEqual(r.ok, true);
        assert.match((r as any).schedule, /^\S+ \S+ \S+ \S+ \S+$/);
      });
    }
    await test("rejects a non-string schedule", async () => {
      assert.strictEqual(validateSchedule(123 as any, NOW).ok, false);
    });
    await test("nextRun is strictly after `from`, in UTC", async () => {
      assert.strictEqual(nextRun("0 9 * * *", NOW).toISOString(), "2026-10-09T09:00:00.000Z");
      assert.strictEqual(nextRun("0 9 * * *", new Date("2026-10-09T09:00:00Z")).toISOString(), "2026-10-10T09:00:00.000Z");
    });

    out("── create: validation (nothing stored on any rejection)");
    const rejects: Array<[string, any, RegExp]> = [
      ["missing callback_url", { ...VALID, callback_url: undefined }, /Missing required fields: action, schedule, payload, callback_url/],
      ["http:// callback_url", { ...VALID, callback_url: "http://1.1.1.1/x" }, /callback_url must use https/],
      ["callback_url resolving to a private address", { ...VALID, callback_url: PRIVATE_URL }, /callback_url rejected: Resolved to a private\/reserved IP range/],
      ["localhost callback_url", { ...VALID, callback_url: "https://localhost/x" }, /callback_url rejected: Blocked hostname/],
      ["disallowed action", { ...VALID, action: "swap.execute" }, /Invalid action: swap.execute/],
      ["maxRuns 0", { ...VALID, maxRuns: 0 }, /maxRuns must be an integer from 1 to 100/],
      ["maxRuns 101", { ...VALID, maxRuns: 101 }, /maxRuns must be an integer from 1 to 100/],
      ["maxRuns 1.5", { ...VALID, maxRuns: 1.5 }, /maxRuns must be an integer from 1 to 100/],
      ["maxRuns \"5\"", { ...VALID, maxRuns: "5" }, /maxRuns must be an integer from 1 to 100/],
      ["oversized payload", { ...VALID, payload: { blob: "x".repeat(17000) } }, /payload too large: \d+ bytes. Maximum is 16384/],
      ["array payload", { ...VALID, payload: [1, 2] }, /payload must be a JSON object/],
      ["every-minute schedule", { ...VALID, schedule: "* * * * *" }, /Minimum interval/],
      ["batch.execute without recipients", { ...VALID, action: "batch.execute", payload: { token: "USDC" } }, /payload.recipients must be an array of 1 to 200/],
      ["batch.execute flat format without amounts", { ...VALID, action: "batch.execute", payload: { recipients: [WALLET_B] } }, /payload.amounts must be an array the same length/],
      ["payroll.execute with a bad address", { ...VALID, action: "payroll.execute", payload: { employees: [{ address: "0xAlice", amount: "10" }] } }, /employees\[0\].address must be a valid EVM address/],
      ["payroll.execute with a zero amount", { ...VALID, action: "payroll.execute", payload: { employees: [{ address: WALLET_B, amount: "0" }] } }, /employees\[0\].amount must be a positive number/],
    ];
    for (const [label, body, re] of rejects) {
      await test(`${label} -> 400`, async () => {
        const before = jobs.size;
        const r = await create(body, asWallet(WALLET_A));
        assert.strictEqual(r.status, 400, JSON.stringify(r.body));
        assert.match(r.body.error, re);
        assert.strictEqual(jobs.size, before);
      });
    }
    await test("disallowed action lists exactly the three allowed actions", async () => {
      const r = await create({ ...VALID, action: "notify.email" }, asWallet(WALLET_A));
      assert.deepStrictEqual(r.body.validActions, ["batch.execute", "payroll.execute", "webhook.trigger"]);
    });
    await test("worker disabled -> 503 scheduler_not_enabled, nothing stored", async () => {
      process.env.CRON_WORKER_ENABLED = "false";
      const before = jobs.size;
      const r = await create(VALID, asWallet(WALLET_A));
      process.env.CRON_WORKER_ENABLED = "true";
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.body.error, "scheduler_not_enabled");
      assert.strictEqual(jobs.size, before);
    });
    await test("no resolvable owner (no key, no Solana, no EVM header) -> 400 naming the rails", async () => {
      const r = await create(VALID, {});
      assert.strictEqual(r.status, 400);
      assert.match(r.body.hint, /Base USDC.*Robinhood Chain USDG.*X-Solana-Tx.*API key/);
    });

    out("── create: success");
    let jobA = "", secretA = "";
    await test("valid create -> 200; owner and secret stored; secret returned once", async () => {
      const r = await create({ ...VALID, maxRuns: 3, metadata: { team: "ops" } }, asWallet(WALLET_A));
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      for (const k of ["id", "action", "schedule", "status", "nextRun", "maxRuns", "note", "_gateway", "timestamp",
                       "timezone", "runsIncluded", "minIntervalSeconds", "callback"]) {
        assert.ok(k in r.body, `missing key ${k}`);
      }
      assert.strictEqual(r.body.status, "active");
      assert.strictEqual(r.body.maxRuns, 3);
      assert.strictEqual(r.body.timezone, "UTC");
      assert.strictEqual(r.body.runsIncluded, 100);
      assert.strictEqual(r.body.minIntervalSeconds, 3600);
      assert.ok(new Date(r.body.nextRun).getTime() > Date.now());
      assert.deepStrictEqual(Object.keys(r.body.callback), ["url", "event", "webhook_secret", "signature_header", "timestamp_header"]);
      assert.strictEqual(r.body.callback.event, "cron.triggered");
      assert.match(r.body.callback.webhook_secret, /^whsec_[0-9a-f]{40}$/);
      assert.ok(!JSON.stringify(r.body).includes("evm:"));
      assert.ok(!/Bull|Redis/.test(r.body.note));
      jobA = r.body.id; secretA = r.body.callback.webhook_secret;
      const row = jobs.get(jobA)!;
      assert.strictEqual(row.owner, "evm:" + WALLET_A);
      assert.strictEqual(row.hmac_secret, secretA);
      assert.strictEqual(row.callback_url, SAFE_URL);
      assert.strictEqual(row.claim_seq, 0);
      assert.strictEqual(row.max_runs, 3);
    });
    await test("maxRuns defaults to 100", async () => {
      const r = await create(VALID, asWallet(WALLET_A));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(jobs.get(r.body.id)!.max_runs, 100);
    });
    await test("valid batch.execute and payroll.execute payloads are accepted", async () => {
      const b = await create({ ...VALID, action: "batch.execute", payload: { token: "USDC", recipients: [WALLET_B], amounts: ["1000000"] } }, asWallet(WALLET_A));
      assert.strictEqual(b.status, 200, JSON.stringify(b.body));
      const p = await create({ ...VALID, action: "payroll.execute", payload: { token: "USDC", employees: [{ address: WALLET_B, amount: "2500.00" }] } }, asWallet(WALLET_A));
      assert.strictEqual(p.status, 200, JSON.stringify(p.body));
    });
    await test("active-job cap: 26th active job for one owner -> 429, nothing stored", async () => {
      const owner = "evm:0xdddddddddddddddddddddddddddddddddddddddd";
      for (let i = 0; i < 25; i++) seedJob({ owner, next_run: "2099-01-01T00:00:00.000Z" });
      const before = jobs.size;
      const r = await create(VALID, asWallet("0xdddddddddddddddddddddddddddddddddddddddd"));
      assert.strictEqual(r.status, 429);
      assert.strictEqual(r.body.activeJobs, 25);
      assert.strictEqual(jobs.size, before);
    });

    out("── ownership");
    await test("wallet A's job is absent from wallet B's list, present in A's", async () => {
      const b = await list(asWallet(WALLET_B));
      assert.strictEqual(b.status, 200);
      assert.ok(!b.body.jobs.some((j: any) => j.id === jobA));
      const a = await list(asWallet(WALLET_A));
      const mine = a.body.jobs.find((j: any) => j.id === jobA);
      assert.ok(mine);
      assert.deepStrictEqual(Object.keys(mine), ["id", "action", "schedule", "status", "nextRun", "lastRun",
        "runCount", "maxRuns", "runsRemaining", "callbackUrl", "lastError"]);
      assert.strictEqual(mine.runsRemaining, 3);
      assert.strictEqual(a.body.total, a.body.jobs.length);
      assert.ok(a.body.jobs.every((j: any) => jobs.get(j.id)!.owner === "evm:" + WALLET_A));
    });
    await test("B cancelling A's job -> 404 identical to an unknown id; job stays active", async () => {
      const r = await cancel({ jobId: jobA }, asWallet(WALLET_B));
      const u = await cancel({ jobId: "cron_does_not_exist" }, asWallet(WALLET_B));
      assert.strictEqual(r.status, 404);
      assert.deepStrictEqual(r.body, { error: "Job not found", jobId: jobA });
      assert.deepStrictEqual(u.body, { error: "Job not found", jobId: "cron_does_not_exist" });
      assert.strictEqual(jobs.get(jobA)!.status, "active");
    });
    await test("legacy stub row (owner NULL) is not cancellable by anyone -> 404", async () => {
      const legacy = seedJob({ owner: null, callback_url: null, hmac_secret: null });
      const r = await cancel({ jobId: legacy.id }, asWallet(WALLET_A));
      assert.strictEqual(r.status, 404);
      assert.strictEqual(jobs.get(legacy.id)!.status, "active");
    });
    await test("A cancels its own job -> 200; second cancel -> 400 not active", async () => {
      const r = await cancel({ jobId: jobA }, asWallet(WALLET_A));
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.status, "cancelled");
      assert.strictEqual(jobs.get(jobA)!.status, "cancelled");
      assert.ok(jobs.get(jobA)!.cancelled_at);
      const again = await cancel({ jobId: jobA }, asWallet(WALLET_A));
      assert.strictEqual(again.status, 400);
    });
    await test("cancel accepts `id` and `cronId` as aliases for jobId", async () => {
      const c1 = await create(VALID, asWallet(WALLET_A));
      const c2 = await create(VALID, asWallet(WALLET_A));
      assert.strictEqual((await cancel({ id: c1.body.id }, asWallet(WALLET_A))).status, 200);
      assert.strictEqual((await cancel({ cronId: c2.body.id }, asWallet(WALLET_A))).status, 200);
    });
    await test("cancel without any id -> 400", async () => {
      const r = await cancel({}, asWallet(WALLET_A));
      assert.strictEqual(r.status, 400);
    });
    await test("API key + forged payment header resolves to the key identity", async () => {
      const headers = { "x-test-api-key": "Ops@Example.com", ...asWallet(WALLET_B) };
      const r = await create(VALID, headers);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.strictEqual(jobs.get(r.body.id)!.owner, "key:ops@example.com");
      const asB = await list(asWallet(WALLET_B));
      assert.ok(!asB.body.jobs.some((j: any) => j.id === r.body.id));
      assert.strictEqual(resolveCronCaller({ apiKeyAuth: true, apiKeyEmail: "X@Y.z", headers: asWallet(WALLET_B) } as any), "key:x@y.z");
    });
    await test("Solana pay-first sender resolves to sol:<sender>", async () => {
      assert.strictEqual(resolveCronCaller({ solanaPaid: true, solanaSender: "So1Sender", headers: {} } as any), "sol:So1Sender");
    });

    out("── precheck (before the payment gate)");
    await test("no payment proof -> next() called, precheck writes nothing (unpaid 402 untouched)", async () => {
      const before = reached;
      const r = await call("POST", "/pre", { garbage: true });
      assert.strictEqual(r.status, 299);
      assert.strictEqual(reached, before + 1);
    });
    await test("payment proof + invalid body -> 400, next() NOT called", async () => {
      const before = reached;
      const r = await call("POST", "/pre", { ...VALID, schedule: "*/5 * * * *" }, asWallet(WALLET_A));
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /Minimum interval/);
      assert.strictEqual(reached, before);
    });
    await test("payment proof + scheduler disabled -> 503, next() NOT called", async () => {
      process.env.CRON_WORKER_ENABLED = "false";
      const before = reached;
      const r = await call("POST", "/pre", VALID, asWallet(WALLET_A));
      process.env.CRON_WORKER_ENABLED = "true";
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.body.error, "scheduler_not_enabled");
      assert.strictEqual(reached, before);
    });
    await test("payment proof the rail cannot attribute (x-mpp-payment) -> 400, next() NOT called", async () => {
      const before = reached;
      const r = await call("POST", "/pre", VALID, { "x-mpp-payment": "abc" });
      assert.strictEqual(r.status, 400);
      assert.match(r.body.error, /Cannot identify the job owner/);
      assert.strictEqual(reached, before);
    });
    await test("payment proof + valid body -> next() called", async () => {
      const before = reached;
      const r = await call("POST", "/pre", VALID, asWallet(WALLET_A));
      assert.strictEqual(r.status, 299);
      assert.strictEqual(reached, before + 1);
    });

    out("── worker");
    // Park everything created above so only the seeded jobs below are due.
    for (const j of jobs.values()) if (j.status === "active") j.next_run = "2099-01-01T00:00:00.000Z";
    const T = new Date("2026-10-12T09:00:30.000Z"); // 30s after the 09:00 occurrence

    await test("five parallel ticks queue exactly one event for a due job", async () => {
      const job = seedJob({});
      await Promise.all([1, 2, 3, 4, 5].map(() => runCronTick(deps, T)));
      assert.strictEqual(eventsFor(job.id).length, 1);
      const row = jobs.get(job.id)!;
      assert.strictEqual(row.run_count, 1);
      assert.strictEqual(row.claim_seq, 1);
      assert.strictEqual(row.last_run, T.toISOString());
      assert.strictEqual(row.next_run, "2026-10-13T09:00:00.000Z");
      assert.strictEqual(row.status, "active");
      const r = runsFor(job.id);
      assert.strictEqual(r.length, 1);
      assert.strictEqual(r[0].status, "queued");
      assert.strictEqual(r[0].webhook_event_id, eventsFor(job.id)[0].id);
    });
    await test("queued event carries the job's secret, cron.triggered, and the documented data", async () => {
      const job = seedJob({ action: "batch.execute", payload: { token: "USDC", recipients: [WALLET_B], amounts: ["1"] }, max_runs: 10 });
      await runCronTick(deps, T);
      const [ev] = eventsFor(job.id);
      assert.strictEqual(ev.hmac_secret, job.hmac_secret);
      assert.strictEqual(ev.event_type, "cron.triggered");
      assert.strictEqual(ev.request_id, `${job.id}:1`);
      assert.strictEqual(ev.max_attempts, 3);
      assert.strictEqual(ev.status, "pending");
      assert.deepStrictEqual(Object.keys(ev.payload), ["job_id", "action", "run_number", "runs_remaining",
        "scheduled_for", "fired_at", "payload", "next_step"]);
      assert.strictEqual(ev.payload.run_number, 1);
      assert.strictEqual(ev.payload.runs_remaining, 9);
      assert.strictEqual(ev.payload.scheduled_for, "2026-10-12T09:00:00.000Z");
      assert.deepStrictEqual(ev.payload.next_step, { method: "POST", path: "/api/v1/batch/execute", price_usd: "0.02" });
    });
    await test("webhook.trigger has next_step null; payroll.execute points at payroll", async () => {
      const w = seedJob({});
      const p = seedJob({ action: "payroll.execute" });
      await runCronTick(deps, T);
      assert.strictEqual(eventsFor(w.id)[0].payload.next_step, null);
      assert.deepStrictEqual(eventsFor(p.id)[0].payload.next_step, { method: "POST", path: "/api/v1/payroll/execute", price_usd: "0.10" });
    });
    await test("end to end: a job created over HTTP fires, and verifySignature accepts the delivery with the create-time secret", async () => {
      const c = await create(VALID, asWallet(WALLET_A));
      assert.strictEqual(c.status, 200);
      const secret = c.body.callback.webhook_secret;
      const row = jobs.get(c.body.id)!;
      const fireAt = new Date(new Date(row.next_run).getTime() + 1000);
      await runCronTick(deps, fireAt);
      const [ev] = eventsFor(c.body.id);
      assert.ok(ev, "no event queued");
      // Deliver through the real WebhookService, redirected to the local receiver.
      const ok = await webhookService.deliverEvent({ ...ev, callback_url: RECEIVER });
      assert.strictEqual(ok, true);
      const got = received.at(-1)!;
      assert.strictEqual(got.headers["x-spraay-event"], "cron.triggered");
      assert.ok(verifySignature(secret, String(got.headers["x-spraay-timestamp"]), got.body, String(got.headers["x-spraay-signature"])));
      assert.ok(!verifySignature("whsec_wrong", String(got.headers["x-spraay-timestamp"]), got.body, String(got.headers["x-spraay-signature"])));
      assert.strictEqual(JSON.parse(got.body).data.job_id, c.body.id);
      assert.strictEqual(events.get(ev.id)!.status, "dispatched");
    });
    await test("job completes at maxRuns and never fires again", async () => {
      const job = seedJob({ max_runs: 2 });
      await runCronTick(deps, T);
      assert.strictEqual(jobs.get(job.id)!.status, "active");
      const t2 = new Date(new Date(jobs.get(job.id)!.next_run).getTime() + 1000);
      await runCronTick(deps, t2);
      assert.strictEqual(jobs.get(job.id)!.status, "completed");
      assert.strictEqual(jobs.get(job.id)!.run_count, 2);
      const t3 = new Date(new Date(jobs.get(job.id)!.next_run).getTime() + 1000);
      await runCronTick(deps, t3);
      assert.strictEqual(eventsFor(job.id).length, 2);
      assert.strictEqual(eventsFor(job.id)[1].payload.runs_remaining, 0);
    });
    await test("a job older than the 15-minute grace window records `missed`, queues nothing, keeps its runs", async () => {
      const job = seedJob({ next_run: "2026-10-12T08:40:00.000Z", schedule: "40 8 * * *" });
      await runCronTick(deps, T);
      const row = jobs.get(job.id)!;
      assert.strictEqual(eventsFor(job.id).length, 0);
      assert.strictEqual(row.run_count, 0);
      assert.strictEqual(row.missed_count, 1);
      assert.strictEqual(row.claim_seq, 1);
      assert.strictEqual(row.next_run, "2026-10-13T08:40:00.000Z");
      assert.strictEqual(row.status, "active");
      assert.deepStrictEqual(runsFor(job.id).map(r => r.status), ["missed"]);
    });
    await test("a legacy stub row with no callback_url never fires and is not modified", async () => {
      const job = seedJob({ owner: null, callback_url: null, hmac_secret: null, next_run: "2026-10-12T09:00:00.000Z" });
      const snapshot = JSON.stringify(job);
      await runCronTick(deps, T);
      assert.strictEqual(eventsFor(job.id).length, 0);
      assert.strictEqual(runsFor(job.id).length, 0);
      assert.strictEqual(JSON.stringify(jobs.get(job.id)), snapshot);
    });
    await test("a cancelled job never fires", async () => {
      const job = seedJob({ status: "cancelled" });
      await runCronTick(deps, T);
      assert.strictEqual(eventsFor(job.id).length, 0);
    });
    await test("a job cancelled between fetch and claim loses the claim and does not fire", async () => {
      const job = seedJob({});
      // Simulate the race: the row is fetched as active, then cancelled before the claim.
      const { cronDb } = require("../src/db.js");
      const fetched = (await cronDb.fetchDue(T.toISOString(), 50)).find((j: any) => j.id === job.id);
      jobs.get(job.id)!.status = "cancelled";
      assert.strictEqual(await cronDb.claim(fetched, { claim_seq: 1 }), null);
      await runCronTick(deps, T);
      assert.strictEqual(eventsFor(job.id).length, 0);
    });
    await test("a private-address callback_url at fire time suspends the job, queues nothing, uses no run", async () => {
      const job = seedJob({ callback_url: "https://10.0.0.5/hook" });
      await runCronTick(deps, T);
      const row = jobs.get(job.id)!;
      assert.strictEqual(eventsFor(job.id).length, 0);
      assert.strictEqual(row.status, "suspended");
      assert.strictEqual(row.run_count, 0);
      assert.match(row.last_error, /blocked at fire time: Resolved to a private\/reserved IP range/);
      assert.deepStrictEqual(runsFor(job.id).map(r => [r.status, r.run_number]), [["blocked", null]]);
      await runCronTick(deps, new Date(T.getTime() + 86_400_000));
      assert.strictEqual(eventsFor(job.id).length, 0, "suspended job fired later");
    });
    await test("a hostname that now resolves to a private address suspends the job", async () => {
      const job = seedJob({ callback_url: "https://internal.test/hook" });
      await runCronTick(deps, T);
      assert.strictEqual(jobs.get(job.id)!.status, "suspended");
      assert.strictEqual(eventsFor(job.id).length, 0);
    });
    await test("a blocked hostname (localhost) at fire time suspends the job", async () => {
      const job = seedJob({ callback_url: "https://localhost/hook" });
      await runCronTick(deps, T);
      assert.strictEqual(jobs.get(job.id)!.status, "suspended");
      assert.match(jobs.get(job.id)!.last_error, /Blocked hostname/);
    });
    await test("a DNS failure at fire time records blocked, queues nothing, job stays active on schedule", async () => {
      const job = seedJob({ callback_url: "https://dnsfail.test/hook" });
      await runCronTick(deps, T);
      const row = jobs.get(job.id)!;
      assert.strictEqual(eventsFor(job.id).length, 0);
      assert.strictEqual(row.status, "active");
      assert.strictEqual(row.run_count, 0, "a DNS blip must not use up a run");
      assert.strictEqual(row.claim_seq, 1);
      assert.strictEqual(row.next_run, "2026-10-13T09:00:00.000Z");
      assert.match(row.last_error, /DNS resolution failed/);
      const r = runsFor(job.id);
      assert.deepStrictEqual(r.map(x => [x.status, x.run_number]), [["blocked", null]]);
      assert.match(r[0].error, /DNS resolution failed: ENOTFOUND/);
      // Owner can see why in cron/list.
      const l = await list(asWallet(WALLET_C));
      assert.match(l.body.jobs.find((j: any) => j.id === job.id).lastError, /DNS resolution failed/);
      // DNS recovers: the next scheduled firing goes out and clears last_error.
      row.callback_url = SAFE_URL;
      await runCronTick(deps, new Date("2026-10-13T09:00:10.000Z"));
      assert.strictEqual(eventsFor(job.id).length, 1);
      assert.strictEqual(jobs.get(job.id)!.run_count, 1);
      assert.strictEqual(jobs.get(job.id)!.last_error, null);
    });
    await test("cron/list shows lastError for a suspended job", async () => {
      const job = seedJob({ callback_url: "https://10.9.9.9/hook" });
      await runCronTick(deps, T);
      const l = await list(asWallet(WALLET_C));
      const j = l.body.jobs.find((x: any) => x.id === job.id);
      assert.strictEqual(j.status, "suspended");
      assert.match(j.lastError, /private\/reserved/);
    });
    await test("one bad job does not stop the rest of the tick", async () => {
      const bad = seedJob({ schedule: "not a cron" });
      const good = seedJob({});
      await runCronTick(deps, T);
      assert.strictEqual(eventsFor(bad.id).length, 0);
      assert.strictEqual(eventsFor(good.id).length, 1);
    });

    out("── prices");
    const root = path.join(__dirname, "..");
    const read = (p: string) => fs.readFileSync(path.join(root, p), "utf8");
    await test("index.ts: every cron/create surface quotes $0.10 (paidRoutes, manifest, MCP card, root listing, OpenAPI)", async () => {
      const idx = read("src/index.ts").split(/\r?\n/);
      const i = idx.findIndex(l => l.includes('"POST /api/v1/cron/create": {'));
      assert.ok(i >= 0);
      assert.match(idx[i + 1], /price: "\$0\.10", network: CAIP2_NETWORK.*price: "\$0\.10", network: SOLANA_NETWORK/);
      const surfaces = idx.filter(l => /\/api\/v1\/cron\/create`|spraay_cron_create|"POST \/api\/v1\/cron\/create": "|path: "\/api\/v1\/cron\/create"/.test(l));
      assert.strictEqual(surfaces.length, 4, surfaces.join("\n"));
      for (const l of surfaces) {
        assert.match(l, /\$0\.10/);
        assert.ok(!l.includes("$0.01"), l);
      }
      assert.ok(idx.some(l => l.includes('path: "/api/v1/cron/create"') && l.includes('priceNum: "0.100000"')));
    });
    await test("pricing.ts: cron/create is 0.10 (read by MPP and the Solana rail)", async () => {
      const { getEndpointPrice } = require("../src/config/pricing.js");
      assert.strictEqual(getEndpointPrice("POST", "/api/v1/cron/create").price, "0.10");
      assert.strictEqual(getEndpointPrice("GET", "/api/v1/cron/list").price, "0.002");
      assert.strictEqual(getEndpointPrice("POST", "/api/v1/cron/cancel").price, "0.002");
    });
    await test("enrich402.ts: cron entries quote $0.10 and use the real field names", async () => {
      const e = read("src/middleware/enrich402.ts");
      const block = e.slice(e.indexOf('"POST /api/v1/cron/create": {'), e.indexOf('"POST /api/v1/logs/ingest": {'));
      assert.ok(block.length > 0);
      assert.ok(!block.includes("$0.01\""), "stale $0.01 in enrich402 cron block");
      assert.ok(block.includes('path: "/api/v1/cron/create", price: "$0.10"'));
      for (const stale of ["cronId", "endpoint:", "params:", "crons:"]) assert.ok(!block.includes(stale), `stale ${stale}`);
    });

    out("── leak scan");
    await test("no list or cancel response contains a webhook secret, owner string or hmac field", async () => {
      const secrets = [...jobs.values()].map(j => j.hmac_secret).filter(Boolean);
      const hits = responses
        .filter(r => /cron\/(list|cancel)/.test(r.route))
        .filter(r => secrets.some(s => r.text.includes(s)) || /evm:0x|key:|sol:|hmac|"owner"/.test(r.text));
      assert.deepStrictEqual(hits.map(h => h.route), []);
      assert.ok(responses.some(r => r.route.includes("cron/list")));
    });
    await test("no create response ever contains the owner string", async () => {
      assert.ok(!responses.filter(r => r.route.includes("cron/create")).some(r => /evm:0x|key:|"owner"/.test(r.text)));
    });
    await test("no log line contains a webhook secret", async () => {
      const secrets = [...jobs.values()].map(j => j.hmac_secret).filter(Boolean);
      assert.ok(secrets.includes(secretA));
      assert.ok(!logLines.some(l => secrets.some(s => l.includes(s))));
    });
  } finally {
    gw.close();
    receiver.close();
    db.close();
  }

  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
