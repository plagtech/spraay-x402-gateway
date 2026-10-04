/**
 * Regression tests for the opt-in per-robot secret on
 * PATCH /api/v1/robots/update and POST /api/v1/robots/deregister
 * (src/routes/robots.ts).
 *
 *   - a robot registered WITHOUT update_secret updates and deregisters
 *     exactly as before (same status, same body)
 *   - a robot registered WITH update_secret needs X-Robot-Secret:
 *     401 missing, 403 wrong, 200 right — on both routes
 *   - update_secret must be a 32–256 char string, else 400
 *   - neither the plaintext secret nor its hash ever appears in a
 *     register / list / profile / update / deregister response, and the
 *     plaintext is never stored or logged
 *
 * Offline: the real handlers run on a local Express app against a small
 * stateful PostgREST mock in this file. No network, no database, no funds.
 *   npx ts-node --project test/tsconfig.json test/robots-secret.test.ts
 */

import assert from "node:assert";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

// ── stateful PostgREST mock ─────────────────────────────────────────
// Only the surface robots.ts uses: select (single / maybeSingle / list),
// insert, update and delete on `robots`, plus HEAD counts on `robot_tasks`.
const robots = new Map<string, Record<string, any>>();
let tasks: Array<{ robot_id: string; status: string }> = [];
const storedWrites: string[] = []; // every raw insert/update body the "database" received

function filters(url: URL) {
  const out: Array<(row: any) => boolean> = [];
  for (const [k, v] of url.searchParams) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    if (v.startsWith("eq.")) out.push(r => String(r[k]) === decodeURIComponent(v.slice(3)));
    else if (v.startsWith("in.(")) {
      const set = v.slice(4, -1).split(",").map(s => s.replace(/^"|"$/g, ""));
      out.push(r => set.includes(String(r[k])));
    }
  }
  return (row: any) => out.every(f => f(row));
}

const db = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url!, "http://mock");
    const table = url.pathname.replace("/rest/v1/", "");
    const single = String(req.headers.accept || "").includes("pgrst.object");
    const send = (code: number, payload?: any, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    const one = (rows: any[]) => rows.length === 1
      ? send(200, rows[0])
      : send(406, { code: "PGRST116", details: `Results contain ${rows.length} rows`, hint: null,
                    message: "JSON object requested, multiple (or no) rows returned" });
    const match = filters(url);

    if (table === "robot_tasks" && req.method === "HEAD") {
      const n = tasks.filter(match).length;
      return send(200, undefined, { "Content-Range": `*/${n}` });
    }
    if (table !== "robots") return send(200, single ? {} : []);

    if (req.method === "GET") {
      const rows = [...robots.values()].filter(match);
      return single ? one(rows) : send(200, rows);
    }
    if (req.method === "POST") {
      storedWrites.push(raw);
      const row = { ...JSON.parse(raw), registered_at: "2026-01-01T00:00:00.000Z", updated_at: null };
      robots.set(row.robot_id, row);
      return single ? send(201, row) : send(201, [row]);
    }
    if (req.method === "PATCH") {
      storedWrites.push(raw);
      const rows = [...robots.values()].filter(match);
      for (const r of rows) Object.assign(r, JSON.parse(raw));
      return single ? one(rows) : send(200, rows);
    }
    if (req.method === "DELETE") {
      const rows = [...robots.values()].filter(match);
      for (const r of rows) robots.delete(r.robot_id);
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
  catch (err: any) { failed++; out(`  FAIL  ${name}\n        ${err.message.split("\n").join("\n        ")}`); }
}

// Every console line the handlers emit, so the plaintext secret can be
// asserted absent from logs too.
const logLines: string[] = [];
for (const m of ["log", "warn", "error", "info"] as const) {
  const orig = console[m].bind(console);
  console[m] = (...a: any[]) => {
    logLines.push(a.map(x => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
    if (m !== "log") orig(...a);
  };
}

let GW = "";
const responses: Array<{ route: string; text: string }> = [];
async function call(method: string, path: string, body?: any, headers: Record<string, string> = {}) {
  const r = await fetch(GW + path, {
    method, headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  responses.push({ route: `${method} ${path}`, text });
  return { status: r.status, body: JSON.parse(text) };
}
const register = (b: any) => call("POST", "/api/v1/robots/register", b);
const update = (b: any, h?: Record<string, string>) => call("PATCH", "/api/v1/robots/update", b, h);
const deregister = (b: any, h?: Record<string, string>) => call("POST", "/api/v1/robots/deregister", b, h);

// The update response carries a server-generated updated_at; check it is an
// ISO timestamp, then drop it so the rest of the body compares exactly.
function stripUpdatedAt(body: any) {
  assert.match(body.robot.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  const { updated_at, ...robot } = body.robot;
  return { ...body, robot };
}

const SECRET = "s3cret-" + "a".repeat(40);           // 47 chars
const SECRET_HASH = crypto.createHash("sha256").update(SECRET).digest("hex");
const BASE = {
  name: "TestBot", capabilities: ["pick", "scan"], price_per_task: "0.05",
  payment_address: "0x1111111111111111111111111111111111111111",
  connection: { type: "webhook", webhookUrl: "https://example.com/rtp" },
};

async function main() {
  await new Promise<void>(ok => db.listen(0, "127.0.0.1", ok));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(db.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_KEY = "test";
  process.env.BASE_URL = "https://gw.test";

  // require (not import()) so ts-node maps the `.js` specifier to the .ts
  // source, after SUPABASE_URL is set — robots.ts builds its client at load.
  const express: typeof import("express") = require("express");
  const h: typeof import("../src/routes/robots.js") = require("../src/routes/robots.js");
  const app = express();
  app.use(express.json());
  app.post("/api/v1/robots/register", h.robotRegisterHandler);
  app.get("/api/v1/robots/list", h.robotListHandler);
  app.get("/api/v1/robots/profile", h.robotProfileHandler);
  app.patch("/api/v1/robots/update", h.robotUpdateHandler);
  app.post("/api/v1/robots/deregister", h.robotDeregisterHandler);
  const gw = await new Promise<http.Server>(ok => { const s = app.listen(0, "127.0.0.1", () => ok(s)); });
  GW = `http://127.0.0.1:${(gw.address() as AddressInfo).port}`;

  try {
    out("── robot registered WITHOUT update_secret: unchanged behaviour");
    let plainId = "";
    await test("register (no secret) -> 201, insert payload carries no secret column", async () => {
      const r = await register(BASE);
      assert.strictEqual(r.status, 201);
      plainId = r.body.robot_id;
      assert.deepStrictEqual(Object.keys(r.body), ["status", "robot_id", "rtp_uri", "x402_endpoint", "robot"]);
      assert.deepStrictEqual(Object.keys(r.body.robot), ["robot_id", "name", "description", "capabilities",
        "price_per_task", "currency", "chain", "payment_address", "connection", "tags", "status", "registered_at"]);
      assert.deepStrictEqual(Object.keys(JSON.parse(storedWrites.at(-1)!)), ["robot_id", "name", "description",
        "capabilities", "price_per_task", "currency", "chain", "payment_address", "connection_type",
        "connection_config", "tags", "metadata", "status"]);
    });
    await test("update (no secret, no header) -> 200, exact body", async () => {
      const r = await update({ robot_id: plainId, price_per_task: "0.07" });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(stripUpdatedAt(r.body), {
        status: "updated", robot_id: plainId, updated_fields: ["price_per_task"],
        robot: { robot_id: plainId, name: "TestBot", capabilities: ["pick", "scan"], price_per_task: "0.07", status: "online" },
      });
    });
    await test("update (no secret) ignores a stray X-Robot-Secret header -> 200", async () => {
      const r = await update({ robot_id: plainId, status: "online" }, { "X-Robot-Secret": "whatever" });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.updated_fields, ["status"]);
    });
    await test("update missing robot_id -> 400, exact body", async () => {
      const r = await update({ name: "x" });
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(r.body, { error: "Missing required field: robot_id",
        updatable_fields: ["name", "description", "capabilities", "price_per_task", "currency", "chain",
          "payment_address", "connection", "tags", "status", "metadata"] });
    });
    await test("update with no valid fields -> 400, exact body", async () => {
      const r = await update({ robot_id: plainId, bogus: 1 });
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(r.body, { error: "No valid fields to update",
        updatable_fields: ["name", "description", "capabilities", "price_per_task", "currency", "chain",
          "payment_address", "tags", "status", "metadata", "connection"] });
    });
    await test("update unknown robot -> 404, exact body", async () => {
      const r = await update({ robot_id: "robo_missing", name: "x" });
      assert.strictEqual(r.status, 404);
      assert.deepStrictEqual(r.body, { error: "Robot not found or update failed", robot_id: "robo_missing" });
    });
    await test("deregister missing robot_id -> 400, exact body", async () => {
      const r = await deregister({});
      assert.strictEqual(r.status, 400);
      assert.deepStrictEqual(r.body, { error: "Missing required field: robot_id" });
    });
    await test("deregister unknown robot -> 404, exact body", async () => {
      const r = await deregister({ robot_id: "robo_missing" });
      assert.strictEqual(r.status, 404);
      assert.deepStrictEqual(r.body, { error: "Robot not found", robot_id: "robo_missing" });
    });
    await test("deregister (no secret) with an active task -> 409, exact body", async () => {
      tasks = [{ robot_id: plainId, status: "DISPATCHED" }];
      const r = await deregister({ robot_id: plainId });
      tasks = [];
      assert.strictEqual(r.status, 409);
      assert.deepStrictEqual(r.body, { error: "Cannot deregister robot with active tasks", active_tasks: 1,
        hint: "Complete or cancel active tasks first" });
    });
    await test("deregister (no secret, no header) -> 200, exact body", async () => {
      const r = await deregister({ robot_id: plainId });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body, { status: "deregistered", robot_id: plainId, name: "TestBot" });
      assert.ok(!robots.has(plainId));
    });

    out("── update_secret validation at register");
    for (const [label, value] of [["31 chars", "x".repeat(31)], ["257 chars", "x".repeat(257)], ["non-string", 12345678901234567890123456789012345]] as const) {
      await test(`register with update_secret ${label} -> 400, nothing stored`, async () => {
        const before = robots.size;
        const r = await register({ ...BASE, update_secret: value });
        assert.strictEqual(r.status, 400);
        assert.deepStrictEqual(r.body, { error: "Invalid update_secret",
          hint: "Optional string of 32-256 characters. Store it: it cannot be retrieved later." });
        assert.strictEqual(robots.size, before);
      });
    }
    await test("register missing required fields + bad secret -> the existing missing-fields 400", async () => {
      const r = await register({ name: "x", update_secret: "short" });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, "Missing required fields");
    });
    await test("register with update_secret of exactly 32 and 256 chars -> 201", async () => {
      for (const n of [32, 256]) {
        const r = await register({ ...BASE, update_secret: "y".repeat(n) });
        assert.strictEqual(r.status, 201);
        robots.delete(r.body.robot_id);
      }
    });

    out("── robot registered WITH update_secret");
    let secId = "";
    await test("register (secret) -> 201, only the sha256 hash is stored", async () => {
      const r = await register({ ...BASE, name: "SecretBot", update_secret: SECRET });
      assert.strictEqual(r.status, 201);
      secId = r.body.robot_id;
      const row = robots.get(secId)!;
      assert.strictEqual(row.update_secret_hash, SECRET_HASH);
      assert.ok(!("update_secret" in row));
      assert.ok(!JSON.stringify(row).includes(SECRET));
    });
    await test("update without X-Robot-Secret -> 401, nothing changed", async () => {
      const r = await update({ robot_id: secId, payment_address: "0xATTACKER" });
      assert.strictEqual(r.status, 401);
      assert.deepStrictEqual(r.body, { error: "Robot update secret required", robot_id: secId,
        hint: "This robot was registered with an update_secret. Send it in the X-Robot-Secret header." });
      assert.strictEqual(robots.get(secId)!.payment_address, BASE.payment_address);
    });
    await test("update with wrong X-Robot-Secret -> 403, nothing changed", async () => {
      const r = await update({ robot_id: secId, payment_address: "0xATTACKER" }, { "X-Robot-Secret": SECRET + "x" });
      assert.strictEqual(r.status, 403);
      assert.deepStrictEqual(r.body, { error: "Invalid robot update secret", robot_id: secId });
      assert.strictEqual(robots.get(secId)!.payment_address, BASE.payment_address);
    });
    await test("update with correct X-Robot-Secret -> 200, change applied", async () => {
      const r = await update({ robot_id: secId, price_per_task: "0.09" }, { "X-Robot-Secret": SECRET });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body.updated_fields, ["price_per_task"]);
      assert.strictEqual(robots.get(secId)!.price_per_task, "0.09");
    });
    await test("update_secret is not updatable (stays out of the allowlist)", async () => {
      const r = await update({ robot_id: secId, update_secret: "z".repeat(40), update_secret_hash: "00" },
        { "X-Robot-Secret": SECRET });
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.error, "No valid fields to update");
      assert.strictEqual(robots.get(secId)!.update_secret_hash, SECRET_HASH);
    });
    await test("list and profile never expose the secret or its hash", async () => {
      const l = await call("GET", "/api/v1/robots/list");
      assert.strictEqual(l.status, 200);
      assert.ok(l.body.robots.some((r: any) => r.robot_id === secId));
      const p = await call("GET", `/api/v1/robots/profile?robot_id=${secId}`);
      assert.strictEqual(p.status, 200);
      assert.ok(!("update_secret_hash" in p.body));
    });
    await test("deregister without X-Robot-Secret -> 401, robot kept", async () => {
      const r = await deregister({ robot_id: secId });
      assert.strictEqual(r.status, 401);
      assert.deepStrictEqual(r.body, { error: "Robot update secret required", robot_id: secId,
        hint: "This robot was registered with an update_secret. Send it in the X-Robot-Secret header." });
      assert.ok(robots.has(secId));
    });
    await test("deregister with wrong X-Robot-Secret -> 403, robot kept", async () => {
      const r = await deregister({ robot_id: secId }, { "X-Robot-Secret": "wrong" });
      assert.strictEqual(r.status, 403);
      assert.deepStrictEqual(r.body, { error: "Invalid robot update secret", robot_id: secId });
      assert.ok(robots.has(secId));
    });
    await test("deregister unauthenticated cannot probe active tasks (401 before 409)", async () => {
      tasks = [{ robot_id: secId, status: "IN_PROGRESS" }];
      const r = await deregister({ robot_id: secId });
      tasks = [];
      assert.strictEqual(r.status, 401);
    });
    await test("deregister with correct X-Robot-Secret -> 200, robot removed", async () => {
      const r = await deregister({ robot_id: secId }, { "X-Robot-Secret": SECRET });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(r.body, { status: "deregistered", robot_id: secId, name: "SecretBot" });
      assert.ok(!robots.has(secId));
    });

    out("── leak scan");
    await test("no response ever contains the plaintext secret or its hash", async () => {
      const hits = responses.filter(r => r.text.includes(SECRET) || r.text.includes(SECRET_HASH)
        || r.text.includes("update_secret_hash"));
      assert.deepStrictEqual(hits.map(h => h.route), []);
      assert.ok(responses.some(r => r.route.startsWith("POST /api/v1/robots/register")));
    });
    await test("the plaintext secret is never stored or logged", async () => {
      assert.ok(!storedWrites.some(w => w.includes(SECRET)));
      assert.ok(!logLines.some(l => l.includes(SECRET)));
    });
  } finally {
    gw.close();
    db.close();
  }

  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
