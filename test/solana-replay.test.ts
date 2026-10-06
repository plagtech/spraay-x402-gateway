/**
 * Regression tests for the single-use guard on the pay-first Solana rail
 * (X-Solana-Tx → src/middleware/solanaPaymentMiddleware.ts).
 *
 * The bug this pins shut: the verifier proved a USDC transfer was recent and
 * big enough, but nothing recorded the signature as spent, so one transfer
 * unlocked unlimited paid requests for maxTxAgeSeconds (300s).
 *
 *   - no header            → middleware does nothing (unpaid path untouched)
 *   - first use            → paid
 *   - same signature again → 402, handler never runs (same route, other
 *                            route, other body — all rejected)
 *   - 5 parallel uses      → exactly 1 paid
 *   - two header spellings of one on-chain signature → second rejected
 *   - store erroring       → 503, NOT paid, NOT consumed (retry then works)
 *   - store not configured → 503, NOT paid
 *   - tx with no blockTime → 402 (previously skipped the age check)
 *   - aged tx              → 402 and nothing is claimed
 *   - free route + header  → passes through, nothing is claimed
 *
 * Offline: the real middleware and the real verifier run on a local Express
 * app. Only the Solana RPC read (Connection.getParsedTransaction) and the
 * database (a small PostgREST mock in this file) are stubbed. No network, no
 * database, no funds.
 *   npx ts-node --project test/tsconfig.json test/solana-replay.test.ts
 */

import assert from "node:assert";
import http from "node:http";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";

const RECEIVE = "8WhWE8YgY5QBWyLowEHuaZiWdwDM3SrgDk36xYBNvYNS";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYER = "11111111111111111111111111111112";
const ATA = "9m2ye5PejtKuvcyYH5BRpZvgnmbr8i3TT6NvDMS9PrEY";
const NO_STORE_CHILD = process.env.SOLANA_REPLAY_NO_STORE === "1";

// ── PostgREST mock ──────────────────────────────────────────────────
// `solana_used_signatures` behaves like a table whose primary key is
// `signature`: a second insert of the same value is a 23505 unique violation.
const used = new Set<string>();
let storeDown = false;
let eventRows = 0;

const db = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const table = new URL(req.url!, "http://mock").pathname.replace("/rest/v1/", "");
    const send = (code: number, payload?: any) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (req.method !== "POST") return send(405, { message: "unexpected method" });
    if (table === "gateway_events") { eventRows++; return send(201); }
    if (table !== "solana_used_signatures") return send(404, { message: `unexpected table ${table}` });
    if (storeDown) return send(500, { code: "XX000", message: "internal error", details: null, hint: null });
    const row = JSON.parse(raw);
    if (used.has(row.signature)) {
      return send(409, {
        code: "23505", details: `Key (signature)=(${row.signature}) already exists.`, hint: null,
        message: 'duplicate key value violates unique constraint "solana_used_signatures_pkey"',
      });
    }
    used.add(row.signature);
    send(201);
  });
});

// ── fake chain ──────────────────────────────────────────────────────
// header value → what the chain says about it.
type Fake = { ageSeconds: number | null; amount: string; canonical?: string };
const chain = new Map<string, Fake>();

function fakeTx(headerSig: string, f: Fake, PublicKey: any) {
  return {
    slot: 1,
    blockTime: f.ageSeconds === null ? null : Math.floor(Date.now() / 1000) - f.ageSeconds,
    meta: {
      err: null,
      innerInstructions: [],
      postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: RECEIVE }],
    },
    transaction: {
      signatures: [f.canonical ?? headerSig],
      message: {
        accountKeys: [{ pubkey: new PublicKey(PAYER) }, { pubkey: new PublicKey(ATA) }],
        instructions: [{
          program: "spl-token",
          parsed: {
            type: "transferChecked",
            info: { mint: USDC, destination: ATA, authority: PAYER, tokenAmount: { uiAmountString: f.amount } },
          },
        }],
      },
    },
  };
}

// ── harness ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

async function main() {
  await new Promise<void>(r => db.listen(0, "127.0.0.1", r));
  process.env.SOLANA_PAYMENTS_ENABLED = "true";
  process.env.SOLANA_RECEIVE_ADDRESS = RECEIVE;
  process.env.SOLANA_RPC_URL = "http://127.0.0.1:1"; // never dialled — RPC read is stubbed below
  if (NO_STORE_CHILD) {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  } else {
    process.env.SUPABASE_URL = `http://127.0.0.1:${(db.address() as AddressInfo).port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test";
  }

  // require (not import()) so ts-node maps the `.js` specifier to the .ts
  // source, and so the env above is in place before the modules read it.
  const web3: typeof import("@solana/web3.js") = require("@solana/web3.js");
  (web3.Connection.prototype as any).getParsedTransaction = async (sig: string) => {
    const f = chain.get(sig);
    return f ? fakeTx(sig, f, web3.PublicKey) : null;
  };
  const express: typeof import("express") = require("express");
  const { solanaPaymentMiddleware }: typeof import("../src/middleware/solanaPaymentMiddleware.js") =
    require("../src/middleware/solanaPaymentMiddleware.js");

  let handlerRuns = 0;
  const app = express();
  app.use(express.json());
  app.use(solanaPaymentMiddleware);
  // Stand-in for everything after the middleware: the x402 gate (402 when the
  // request is not Solana-paid) and then the route handler.
  app.use((req, res) => {
    if ((req as any).solanaPaid !== true) { res.status(402).json({ gate: "x402" }); return; }
    handlerRuns++;
    res.json({ ok: true });
  });
  const srv = http.createServer(app);
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  const call = async (sig: string | null, path = "/api/v1/batch/estimate", body: any = { recipientCount: 1 }) => {
    const r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(sig ? { "x-solana-tx": sig } : {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as any };
  };
  const fresh = (sig: string, over: Partial<Fake> = {}) => chain.set(sig, { ageSeconds: 5, amount: "1.0", ...over });

  if (NO_STORE_CHILD) {
    console.log("\nSolana rail — signature store NOT configured");
    await test("valid fresh payment is refused (503), handler never runs", async () => {
      fresh("NOSTORE");
      const r = await call("NOSTORE");
      assert.strictEqual(r.status, 503);
      assert.strictEqual(handlerRuns, 0);
    });
  } else {
    console.log("\nSolana rail — single-use signatures");

    await test("no X-Solana-Tx header → middleware does nothing", async () => {
      const r = await call(null);
      assert.deepStrictEqual(r, { status: 402, body: { gate: "x402" } });
      assert.strictEqual(used.size, 0);
    });

    await test("first use of a fresh signature → paid", async () => {
      fresh("SIG_A");
      const r = await call("SIG_A");
      assert.strictEqual(r.status, 200);
      assert.strictEqual(handlerRuns, 1);
      assert.ok(used.has("SIG_A"));
    });

    await test("same signature again → 402, handler does not run", async () => {
      const r = await call("SIG_A");
      assert.strictEqual(r.status, 402);
      assert.strictEqual(r.body.error, "Solana payment verification failed");
      assert.match(r.body.detail, /already used/);
      assert.strictEqual(handlerRuns, 1);
    });

    await test("same signature, different body and different route → still 402", async () => {
      const a = await call("SIG_A", "/api/v1/batch/estimate", { recipientCount: 7 });
      const b = await call("SIG_A", "/api/v1/batch/execute", { anything: true });
      assert.strictEqual(a.status, 402);
      assert.strictEqual(b.status, 402);
      assert.strictEqual(handlerRuns, 1);
    });

    await test("5 parallel uses of one fresh signature → exactly 1 paid", async () => {
      fresh("SIG_B");
      const before = handlerRuns;
      const rs = await Promise.all([1, 2, 3, 4, 5].map(n => call("SIG_B", "/api/v1/batch/estimate", { recipientCount: n })));
      assert.strictEqual(rs.filter(r => r.status === 200).length, 1);
      assert.strictEqual(rs.filter(r => r.status === 402).length, 4);
      assert.strictEqual(handlerRuns, before + 1);
    });

    await test("two header spellings of one on-chain signature → second rejected", async () => {
      fresh("SPELLING_1", { canonical: "CANON" });
      fresh("SPELLING_2", { canonical: "CANON" });
      assert.strictEqual((await call("SPELLING_1")).status, 200);
      assert.strictEqual((await call("SPELLING_2")).status, 402);
      assert.ok(used.has("CANON") && !used.has("SPELLING_1"));
    });

    await test("store erroring → 503, not paid, not consumed; retry works once store is back", async () => {
      fresh("SIG_C");
      const before = handlerRuns;
      storeDown = true;
      const down = await call("SIG_C");
      storeDown = false;
      assert.strictEqual(down.status, 503);
      assert.strictEqual(handlerRuns, before);
      assert.ok(!used.has("SIG_C"));
      assert.strictEqual((await call("SIG_C")).status, 200);
    });

    await test("transaction with no blockTime → 402, nothing claimed", async () => {
      fresh("SIG_NOTIME", { ageSeconds: null });
      const r = await call("SIG_NOTIME");
      assert.strictEqual(r.status, 402);
      assert.match(r.body.detail, /block time unavailable/i);
      assert.ok(!used.has("SIG_NOTIME"));
    });

    await test("aged transaction → 402 as before, nothing claimed", async () => {
      fresh("SIG_OLD", { ageSeconds: 301 });
      const r = await call("SIG_OLD");
      assert.strictEqual(r.status, 402);
      assert.match(r.body.detail, /too old/);
      assert.ok(!used.has("SIG_OLD"));
    });

    await test("underpaid transaction → 402 as before, nothing claimed", async () => {
      fresh("SIG_SMALL", { amount: "0.0001" });
      const r = await call("SIG_SMALL");
      assert.strictEqual(r.status, 402);
      assert.match(r.body.detail, /Insufficient amount/);
      assert.ok(!used.has("SIG_SMALL"));
    });

    await test("unpriced route + header → passes through, nothing claimed", async () => {
      fresh("SIG_FREE");
      const r = await call("SIG_FREE", "/free/validate-batch");
      assert.deepStrictEqual(r, { status: 402, body: { gate: "x402" } }); // stand-in gate; middleware itself did nothing
      assert.ok(!used.has("SIG_FREE"));
    });

    await test("store not configured → 503, not paid (separate process)", async () => {
      const child = spawnSync(process.execPath, ["-r", "ts-node/register", __filename], {
        env: { ...process.env, SOLANA_REPLAY_NO_STORE: "1", TS_NODE_PROJECT: "test/tsconfig.json" },
        encoding: "utf8",
      });
      assert.strictEqual(child.status, 0, child.stdout + child.stderr);
    });
  }

  srv.close();
  db.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
