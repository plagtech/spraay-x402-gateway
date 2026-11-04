/**
 * Offline tests for the MPP payment middleware (src/middleware/mppMiddleware.ts)
 * and its hand-off to the x402 gate (src/middleware/solanaBypass.ts).
 *
 *   npm run test:mpp
 *
 * No network, no real mppx, no funds. A stub mppx instance is injected through
 * `__setMppxForTests` and returns exactly the result shapes mppx 0.6.14 resolves
 * to (node_modules/mppx/src/server/Mppx.ts):
 *   { status: 402, challenge: Response }
 *   { status: 200, withReceipt(response?) => Response }
 *
 * Requests go through a real Express app and a raw node:http client, so the
 * WWW-Authenticate assertions see the headers as they appear on the wire
 * (fetch's Headers would re-join repeated values and hide the bug).
 */

import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";

// mppMiddleware reads MPP_ENABLED at module load — set it before requiring.
process.env.MPP_ENABLED = "true";

const express: typeof import("express") = require("express");
const mpp: typeof import("../src/middleware/mppMiddleware.js") = require("../src/middleware/mppMiddleware.js");
const { protocolDetectorMiddleware }: typeof import("../src/middleware/protocolDetector.js") = require("../src/middleware/protocolDetector.js");
const { wrapWithSolanaBypass }: typeof import("../src/middleware/solanaBypass.js") = require("../src/middleware/solanaBypass.js");

// ── harness ─────────────────────────────────────────────────────────
const out = (s: string) => process.stdout.write(s + "\n");
let failed = 0, passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; out(`  PASS  ${name}`); }
  catch (err: any) { failed++; out(`  FAIL  ${name}\n        ${String(err?.stack || err).split("\n").join("\n        ")}`); }
}

// Keep expected console noise (mppMiddleware's catch logs) out of the report.
const logLines: string[] = [];
for (const m of ["log", "warn", "error"] as const) {
  console[m] = (...a: any[]) => { logLines.push(a.map(String).join(" ")); };
}

// ── stub mppx ───────────────────────────────────────────────────────
type Outcome = (req: Request) => Promise<any> | any;
const calls: { kind: "charge" | "compose"; args: any[]; auth: string | null }[] = [];
let outcome: Outcome = () => { throw new Error("no outcome set"); };

const stubMppx = {
  charge: (opts: any) => async (req: Request) => {
    calls.push({ kind: "charge", args: [opts], auth: req.headers.get("authorization") });
    return outcome(req);
  },
  compose: (...entries: any[]) => async (req: Request) => {
    calls.push({ kind: "compose", args: entries, auth: req.headers.get("authorization") });
    return outcome(req);
  },
};

const CH_TEMPO = 'Payment id="ch_tempo", realm="gateway.spraay.app", method="tempo", intent="charge", request="eyJhbW91bnQiOiIwLjAwNSJ9", description="gas, oracle"';
const CH_EVM = 'Payment id="ch_evm", realm="gateway.spraay.app", method="evm", intent="charge", request="eyJhbW91bnQiOiI1MDAwIn0"';
const PROBLEM = {
  type: "https://paymentauth.org/problems/malformed-credential",
  title: "Malformed credential",
  status: 402,
  detail: "Credential could not be parsed.",
  challengeId: "ch_tempo",
};

/** 402 exactly as mppx's HTTP transport builds it (Transport.ts respondChallenge). */
function challenge402(wwwAuth: string[], body: string | null = JSON.stringify(PROBLEM)) {
  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const v of wwwAuth) headers.append("WWW-Authenticate", v); // compose() appends
  if (body !== null) headers.set("Content-Type", "application/problem+json");
  return { status: 402, challenge: new Response(body, { status: 402, headers }) };
}

/** 200 exactly as mppx returns it for a charge (no management `respond` hook). */
function paid200(receipt = "rcpt_stub_123") {
  return {
    status: 200,
    withReceipt(response?: Response) {
      if (!response) throw new Error("withReceipt() requires a response argument");
      const headers = new Headers(response.headers);
      headers.set("Payment-Receipt", receipt);
      return new Response(response.body, { status: response.status, headers });
    },
  };
}

// ── app: same order as src/index.ts (detector → mpp → … → wrapped x402 gate) ─
const handlerSeen: { mppPaid?: boolean; mppReceipt?: any; ran: boolean } = { ran: false };
let x402GateRuns = 0;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(protocolDetectorMiddleware);
  app.use(mpp.mppMiddleware);
  // Stand-in for paymentMiddleware(paidRoutes, server): an MPP request carries no
  // x402 proof, so the real gate would answer 402 here.
  app.use(wrapWithSolanaBypass((req, res, next) => {
    x402GateRuns++;
    if (req.path.startsWith("/free/")) return next();
    // Stand-in for a credential-less request served by another rail (API key, Solana tx).
    if (req.headers["x-test-gate-pass"]) return next();
    res.status(402).json({ x402Version: 2, error: "Payment required" });
  }));
  const handler = (req: any, res: any) => {
    handlerSeen.ran = true;
    handlerSeen.mppPaid = req.mppPaid;
    handlerSeen.mppReceipt = req.mppReceipt;
    res.json({ ok: true, path: req.path });
  };
  app.get("/api/v1/oracle/gas", handler);
  app.get("/free/prices", handler);
  return app;
}

interface Wire { status: number; raw: string[]; body: string; json?: any }
function header(w: Wire, name: string): string[] {
  const vals: string[] = [];
  for (let i = 0; i < w.raw.length; i += 2) if (w.raw[i].toLowerCase() === name.toLowerCase()) vals.push(w.raw[i + 1]);
  return vals;
}

let port = 0;
function get(path: string, headers: Record<string, string> = {}): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        const w: Wire = { status: res.statusCode || 0, raw: res.rawHeaders, body };
        try { w.json = JSON.parse(body); } catch { /* not JSON */ }
        resolve(w);
      });
    });
    r.on("error", reject);
    r.end();
  });
}

function reset(o: Outcome, evmRegistered = false) {
  mpp.__setMppxForTests(stubMppx, { evmRegistered });
  outcome = o;
  calls.length = 0;
  x402GateRuns = 0;
  handlerSeen.ran = false;
  handlerSeen.mppPaid = undefined;
  handlerSeen.mppReceipt = undefined;
}

const MPP_AUTH = { Authorization: "Payment eyJjaGFsbGVuZ2UiOnt9fQ" };

async function main() {
  const server = buildApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  port = (server.address() as AddressInfo).port;

  out("mpp-middleware");

  // ── splitter ──────────────────────────────────────────────────────
  await test("splitChallenges: separates comma-joined challenges, keeps quoted commas", () => {
    assert.deepStrictEqual(mpp.splitChallenges(`${CH_TEMPO}, ${CH_EVM}`), [CH_TEMPO, CH_EVM]);
    assert.deepStrictEqual(mpp.splitChallenges(CH_TEMPO), [CH_TEMPO]);
    // auth-params after a comma (token= or token = ) never start a new challenge
    assert.deepStrictEqual(mpp.splitChallenges('Payment a="1", b = "2",c="x, Payment y=1"'), ['Payment a="1", b = "2",c="x, Payment y=1"']);
    assert.deepStrictEqual(mpp.splitChallenges('Basic realm="x", Payment id="y"'), ['Basic realm="x"', 'Payment id="y"']);
    assert.deepStrictEqual(mpp.splitChallenges(""), []);
  });

  // ── challenge branch ─────────────────────────────────────────────
  await test("402, one method (tempo charge): 402 + WWW-Authenticate + problem body + spraay; route not run", async () => {
    reset(() => challenge402([CH_TEMPO]));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 402);
    assert.deepStrictEqual(header(w, "www-authenticate"), [CH_TEMPO]);
    assert.strictEqual(header(w, "cache-control")[0], "no-store");
    assert.strictEqual(w.json.type, PROBLEM.type);
    assert.strictEqual(w.json.challengeId, "ch_tempo");
    assert.strictEqual(w.json.spraay.protocol, "mpp");
    assert.strictEqual(w.json.spraay.priceUSD, "$0.005");
    assert.strictEqual(w.json.spraay.category, "oracle");
    assert.strictEqual(w.json.spraay.methods, undefined);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].kind, "charge");
    assert.deepStrictEqual(calls[0].args, [{ amount: "0.005" }]);
    assert.strictEqual(calls[0].auth, MPP_AUTH.Authorization);
    assert.strictEqual(handlerSeen.ran, false);
    assert.strictEqual(x402GateRuns, 0);
  });

  await test("402, two methods (compose tempo + evm): BOTH WWW-Authenticate sent as separate header lines", async () => {
    reset(() => challenge402([CH_TEMPO, CH_EVM]), true);
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 402);
    assert.deepStrictEqual(header(w, "www-authenticate"), [CH_TEMPO, CH_EVM]);
    assert.strictEqual(calls[0].kind, "compose");
    assert.deepStrictEqual(calls[0].args, [["tempo/charge", { amount: "0.005" }], ["evm/charge", { amount: "5000" }]]);
    assert.deepStrictEqual(w.json.spraay.methods, ["tempo/charge", "evm/charge"]);
    assert.strictEqual(w.json.spraay.evm.network, "eip155:4663");
    assert.strictEqual(handlerSeen.ran, false);
  });

  await test("malformed credential (Authorization: Payment Zm9v) → mppx re-challenges → 402, not 500", async () => {
    reset(() => challenge402([CH_TEMPO]), true);
    const w = await get("/api/v1/oracle/gas", { Authorization: "Payment Zm9v" });
    assert.strictEqual(w.status, 402);
    assert.notStrictEqual(w.json.error, "MPP payment processing failed");
    assert.strictEqual(w.json.title, "Malformed credential");
    assert.strictEqual(handlerSeen.ran, false);
  });

  await test("402 with empty challenge body → JSON body with spraay metadata only", async () => {
    reset(() => challenge402([CH_TEMPO], null));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 402);
    assert.deepStrictEqual(Object.keys(w.json), ["spraay"]);
    assert.deepStrictEqual(header(w, "www-authenticate"), [CH_TEMPO]);
  });

  await test("challenge status other than 402 (e.g. mppx error status) is passed through", async () => {
    reset(() => {
      const c = challenge402([CH_TEMPO]);
      return { status: 402, challenge: new Response(JSON.stringify(PROBLEM), { status: 400, headers: c.challenge.headers }) };
    });
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 400);
    assert.strictEqual(w.json.spraay.protocol, "mpp");
  });

  await test("402 with non-JSON body → sent raw with mppx status and content type", async () => {
    reset(() => ({ status: 402, challenge: new Response("<html>pay</html>", { status: 402, headers: { "WWW-Authenticate": CH_TEMPO, "Content-Type": "text/html; charset=utf-8" } }) }));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 402);
    assert.strictEqual(w.body, "<html>pay</html>");
    assert.match(header(w, "content-type")[0], /^text\/html/);
  });

  // ── receipt branch ───────────────────────────────────────────────
  await test("200 paid: Payment-Receipt set, req.mppPaid=true, route runs, x402 gate skipped", async () => {
    reset(() => paid200("rcpt_stub_123"), true);
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 200);
    assert.deepStrictEqual(w.json, { ok: true, path: "/api/v1/oracle/gas" });
    assert.deepStrictEqual(header(w, "payment-receipt"), ["rcpt_stub_123"]);
    assert.strictEqual(handlerSeen.ran, true);
    assert.strictEqual(handlerSeen.mppPaid, true);
    assert.strictEqual(handlerSeen.mppReceipt.protocol, "mpp");
    assert.strictEqual(handlerSeen.mppReceipt.amount, "0.005");
    assert.strictEqual(handlerSeen.mppReceipt.category, "oracle");
    assert.strictEqual(x402GateRuns, 0, "x402 gate must not run for an MPP-paid request");
  });

  await test("200 tempo-only (charge path) also forwards", async () => {
    reset(() => paid200("rcpt_tempo"));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 200);
    assert.deepStrictEqual(header(w, "payment-receipt"), ["rcpt_tempo"]);
    assert.strictEqual(calls[0].kind, "charge");
    assert.strictEqual(x402GateRuns, 0);
  });

  await test("200 with management response: method's response is sent, route NOT run", async () => {
    reset(() => ({
      status: 200,
      withReceipt: () => new Response(JSON.stringify({ channel: "opened" }), { status: 200, headers: { "Content-Type": "application/json", "Payment-Receipt": "rcpt_mgmt" } }),
    }));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 200);
    assert.deepStrictEqual(w.json, { channel: "opened" });
    assert.deepStrictEqual(header(w, "payment-receipt"), ["rcpt_mgmt"]);
    assert.strictEqual(handlerSeen.ran, false);
    assert.strictEqual(x402GateRuns, 0);
  });

  // ── fallback / failure modes ─────────────────────────────────────
  await test("legacy bare Response (defensive fallback): 402 handled", async () => {
    reset(() => new Response(JSON.stringify(PROBLEM), { status: 402, headers: { "WWW-Authenticate": CH_TEMPO } }));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 402);
    assert.deepStrictEqual(header(w, "www-authenticate"), [CH_TEMPO]);
    assert.strictEqual(w.json.spraay.protocol, "mpp");
  });

  await test("legacy bare Response (defensive fallback): 200 forwards with receipt", async () => {
    reset(() => new Response(null, { status: 200, headers: { "Payment-Receipt": "rcpt_legacy" } }));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 200);
    assert.deepStrictEqual(header(w, "payment-receipt"), ["rcpt_legacy"]);
    assert.strictEqual(handlerSeen.mppPaid, true);
    assert.strictEqual(x402GateRuns, 0);
  });

  await test("unknown mppx result shape fails closed (500, route not run)", async () => {
    reset(() => ({ status: 200 }));
    const w = await get("/api/v1/oracle/gas", MPP_AUTH);
    assert.strictEqual(w.status, 500);
    assert.strictEqual(handlerSeen.ran, false);
    assert.strictEqual(handlerSeen.mppPaid, undefined);
  });

  // ── non-MPP paths unchanged ──────────────────────────────────────
  // ── unpaid 402 discovery (credential-less requests) ───────────────
  const X402_BODY = JSON.stringify({ x402Version: 2, error: "Payment required" });

  await test("unpaid, one method: x402 402 unchanged + WWW-Authenticate added; route not run", async () => {
    reset(() => challenge402([CH_TEMPO]));
    const w = await get("/api/v1/oracle/gas");
    assert.strictEqual(w.status, 402);
    assert.strictEqual(w.body, X402_BODY, "x402 body must be byte-identical");
    assert.match(header(w, "content-type")[0], /^application\/json/);
    assert.deepStrictEqual(header(w, "www-authenticate"), [CH_TEMPO]);
    assert.deepStrictEqual(header(w, "cache-control"), [], "no mppx headers other than WWW-Authenticate");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].kind, "charge");
    assert.deepStrictEqual(calls[0].args, [{ amount: "0.005" }]);
    assert.strictEqual(calls[0].auth, null, "mppx sees no credential → challenge only, nothing settles");
    assert.strictEqual(x402GateRuns, 1);
    assert.strictEqual(handlerSeen.ran, false);
  });

  await test("unpaid, two methods (compose): BOTH WWW-Authenticate lines added to the x402 402", async () => {
    reset(() => challenge402([CH_TEMPO, CH_EVM]), true);
    const w = await get("/api/v1/oracle/gas");
    assert.strictEqual(w.status, 402);
    assert.strictEqual(w.body, X402_BODY);
    assert.deepStrictEqual(header(w, "www-authenticate"), [CH_TEMPO, CH_EVM]);
    assert.strictEqual(calls[0].kind, "compose");
    assert.deepStrictEqual(calls[0].args, [["tempo/charge", { amount: "0.005" }], ["evm/charge", { amount: "5000" }]]);
  });

  await test("unpaid: only WWW-Authenticate differs from the response without MPP", async () => {
    reset(() => { throw new Error("mppx down"); });
    const without = await get("/api/v1/oracle/gas");
    reset(() => challenge402([CH_TEMPO]));
    const withMpp = await get("/api/v1/oracle/gas");
    const names = (w: Wire) => w.raw.filter((_, i) => i % 2 === 0).map((n) => n.toLowerCase()).sort();
    const valuesExcept = (w: Wire, skip: string[]) =>
      w.raw.reduce<string[]>((acc, v, i) => (i % 2 === 0 && !skip.includes(v.toLowerCase()) ? [...acc, `${v.toLowerCase()}: ${w.raw[i + 1]}`] : acc), []);
    assert.deepStrictEqual(names(withMpp).filter((n) => n !== "www-authenticate"), names(without));
    assert.deepStrictEqual(valuesExcept(withMpp, ["www-authenticate", "date"]), valuesExcept(without, ["date"]));
    assert.strictEqual(withMpp.body, without.body);
    assert.strictEqual(withMpp.status, without.status);
  });

  await test("unpaid, mppx throws: x402 402 sent unchanged without WWW-Authenticate", async () => {
    reset(() => { throw new Error("boom"); });
    const w = await get("/api/v1/oracle/gas");
    assert.strictEqual(w.status, 402);
    assert.strictEqual(w.body, X402_BODY);
    assert.deepStrictEqual(header(w, "www-authenticate"), []);
  });

  await test("unpaid, mppx returns a non-402 result: no header added", async () => {
    reset(() => paid200());
    const w = await get("/api/v1/oracle/gas");
    assert.strictEqual(w.status, 402);
    assert.strictEqual(w.body, X402_BODY);
    assert.deepStrictEqual(header(w, "www-authenticate"), []);
    assert.strictEqual(handlerSeen.ran, false);
    assert.strictEqual(handlerSeen.mppPaid, undefined);
  });

  await test("unpaid but served 200 by another rail: no WWW-Authenticate on the 200", async () => {
    reset(() => challenge402([CH_TEMPO]));
    const w = await get("/api/v1/oracle/gas", { "x-test-gate-pass": "1" });
    assert.strictEqual(w.status, 200);
    assert.deepStrictEqual(w.json, { ok: true, path: "/api/v1/oracle/gas" });
    assert.deepStrictEqual(header(w, "www-authenticate"), []);
    assert.strictEqual(handlerSeen.mppPaid, undefined);
  });

  await test("unpaid on a free route: mppx never called, no WWW-Authenticate", async () => {
    reset(() => challenge402([CH_TEMPO]));
    const w = await get("/free/prices");
    assert.strictEqual(w.status, 200);
    assert.strictEqual(calls.length, 0);
    assert.deepStrictEqual(header(w, "www-authenticate"), []);
  });

  await test("x402 header present: mppx never called, x402 gate runs", async () => {
    reset(() => paid200());
    await get("/api/v1/oracle/gas", { "X-PAYMENT": "0xdeadbeef" });
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(x402GateRuns, 1);
  });

  await test("Authorization: Payment on a free endpoint is ignored (no mppx call, route runs)", async () => {
    reset(() => challenge402([CH_TEMPO]));
    const w = await get("/free/prices", MPP_AUTH);
    assert.strictEqual(w.status, 200);
    assert.strictEqual(calls.length, 0);
    assert.strictEqual(handlerSeen.mppPaid, undefined);
  });

  // ── solanaBypass unit ────────────────────────────────────────────
  await test("wrapWithSolanaBypass: mppPaid=true skips the wrapped gate; absent/false runs it", () => {
    let gate = 0, nexts = 0;
    const wrapped = wrapWithSolanaBypass(((_q: any, _s: any, _n: any) => { gate++; }) as any);
    wrapped({ mppPaid: true, headers: {} } as any, {} as any, () => { nexts++; });
    assert.deepStrictEqual([gate, nexts], [0, 1]);
    wrapped({ headers: {} } as any, {} as any, () => { nexts++; });
    wrapped({ mppPaid: false, headers: {} } as any, {} as any, () => { nexts++; });
    wrapped({ mppPaid: "true", headers: {} } as any, {} as any, () => { nexts++; });
    assert.deepStrictEqual([gate, nexts], [3, 1]);
  });

  server.close();
  out(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => { process.stdout.write(String(err?.stack || err) + "\n"); process.exit(1); });
