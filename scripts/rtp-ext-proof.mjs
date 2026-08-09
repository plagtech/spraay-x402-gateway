#!/usr/bin/env node
// ============================================================
// rtp-ext-proof.mjs — commit gate for the frozen NVIDIA paths
// ============================================================
//
// CLAUDE.md requires this to pass before any commit touching index.ts,
// batch, escrow or robots routes.
//
//   node scripts/rtp-ext-proof.mjs                 # the gate: exits 0 or 1
//   node scripts/rtp-ext-proof.mjs --update-baseline
//   node scripts/rtp-ext-proof.mjs --no-build      # reuse existing dist/
//   node scripts/rtp-ext-proof.mjs --verbose       # stream gateway logs
//
// WHAT IT PROVES
//
//   Block A — NVIDIA compat. The nine frozen paths still answer with the
//   same status code, content type, top-level key set and full nested key
//   path set as the committed baseline. Values are ignored: prices move,
//   block heights move, versions get bumped. Shape is the contract, and
//   additive-only means new keys are a deliberate re-baseline, never a
//   silent drift.
//
//   Block B — robots/task pay-before-validate. An unpaid request still
//   gets the unchanged 402 challenge; a paid request with an unusable
//   payload is rejected with ZERO facilitator calls; a paid valid request
//   still verifies, settles and dispatches.
//
//   Block C — no leak. The payment gate still runs for paid routes other
//   than robots/task, so the precheck cannot have been mounted globally.
//
// HOW IT RUNS OFFLINE
//
//   Compiles src/ with tsc, then boots dist/index.js against a mock
//   Supabase and a mock x402 facilitator (scripts/rtp-proof/). No live
//   funds, no real database, no facilitator dependency. The mock
//   facilitator records verify/settle calls, which is what makes "the
//   payment gate was never reached" an assertion rather than a claim.
//
//   Two of the nine frozen paths (/free/prices, /free/chain-status) call
//   upstream providers. They are checked for shape like the rest; if an
//   upstream is unreachable their body shape changes and this script
//   fails. That is a true negative for a shape gate but can look like a
//   flake on a bad network — the failure output names the path so it is
//   obvious which case you are in.
//
// RE-BASELINING
//
//   --update-baseline rewrites scripts/rtp-proof/baseline.json from the
//   current build. Only do this when a response shape changed ON PURPOSE
//   and the change is additive. Commit the regenerated baseline in the
//   same commit as the change that caused it, so review sees both.
// ============================================================

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const PROOF_DIR = join(__dirname, "rtp-proof");
const BASELINE_PATH = join(PROOF_DIR, "baseline.json");

const args = new Set(process.argv.slice(2));
const UPDATE_BASELINE = args.has("--update-baseline");
const NO_BUILD = args.has("--no-build");
const VERBOSE = args.has("--verbose");

if (args.has("--help") || args.has("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf-8")
    .split("\n").filter(l => l.startsWith("//")).join("\n"));
  process.exit(0);
}

// Deliberately not the dev defaults, so a proof run never collides with a
// gateway the developer already has running.
const GATEWAY_PORT = 3499;
const SUPABASE_PORT = 5591;
const FACILITATOR_PORT = 5592;
const GW = `http://127.0.0.1:${GATEWAY_PORT}`;
const FAC = `http://127.0.0.1:${FACILITATOR_PORT}`;

// ── the nine frozen NVIDIA-integration paths ────────────────────────
// Consumed by merged NeMo-Agent-Toolkit-Examples PRs #20 and #27.
const FROZEN = [
  { name: "POST /free/validate-batch", method: "POST", path: "/free/validate-batch",
    body: { version: "1.0", chain: "base", token: "USDC",
            payments: [{ to: "0x1111111111111111111111111111111111111111", amount: "1.00" }] } },
  { name: "GET  /free/estimate-batch", method: "GET", path: "/free/estimate-batch?recipients=5&chain=base&amount=100" },
  { name: "GET  /free/prices", method: "GET", path: "/free/prices" },
  { name: "GET  /free/chain-status", method: "GET", path: "/free/chain-status" },
  { name: "GET  /api/v1/tokens", method: "GET", path: "/api/v1/tokens" },
  { name: "POST /api/v1/batch/execute (unpaid -> 402)", method: "POST", path: "/api/v1/batch/execute",
    body: { chain: "base", token: "USDC",
            payments: [{ to: "0x1111111111111111111111111111111111111111", amount: "1.00" }] } },
  { name: "POST /api/v1/escrow/create (unpaid -> 402)", method: "POST", path: "/api/v1/escrow/create",
    body: { amount: "10.00", token: "USDC", recipient: "0x1111111111111111111111111111111111111111" } },
  { name: "GET  /api/v1/robots/list (unpaid -> 402, default response)", method: "GET", path: "/api/v1/robots/list" },
  { name: "GET  /api/v1/balances (unpaid -> 402)", method: "GET",
    path: "/api/v1/balances?address=0x1111111111111111111111111111111111111111" },
];

// ── result collection ───────────────────────────────────────────────
const results = [];
const record = (block, name, pass, detail = "") => {
  results.push({ block, name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `\n        ${detail}` : ""}`);
};

// ── shape helpers ───────────────────────────────────────────────────
// Every nested key path, values discarded. Array elements collapse to a
// single "[]" segment so list length never enters the comparison.
function keyPaths(v, prefix = "", acc = new Set()) {
  if (Array.isArray(v)) {
    for (const el of v) keyPaths(el, `${prefix}[]`, acc);
  } else if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      acc.add(`${prefix}.${k}`);
      keyPaths(v[k], `${prefix}.${k}`, acc);
    }
  }
  return acc;
}

// Version values are reported rather than masked: a bump is expected and
// fine, but it should be visible in the run output, not silently swallowed.
function versionValues(v, acc = []) {
  if (Array.isArray(v)) v.forEach(el => versionValues(el, acc));
  else if (v && typeof v === "object") {
    for (const [k, val] of Object.entries(v)) {
      if (k === "version" && typeof val === "string") acc.push(val);
      versionValues(val, acc);
    }
  }
  return acc;
}

const setDiff = (a, b) => a.filter(x => !b.includes(x));

// ── http helpers ────────────────────────────────────────────────────
async function req(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(GW + path, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, contentType: res.headers.get("content-type"), body: parsed };
}

const clearCalls = () => fetch(`${FAC}/_calls`, { method: "DELETE" });
const getCalls = async () => (await fetch(`${FAC}/_calls`)).json();

// An x402 v2 PAYMENT-SIGNATURE header echoing an advertised accepts[]
// entry, exactly as a paying client would send it. The signature is
// nonsense; the mock facilitator approves regardless, because what is
// under test is WHETHER the gate is reached, not crypto validity.
function buildPayment(accepted) {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted,
    payload: {
      signature: "0x" + "ab".repeat(65),
      authorization: {
        from: "0xC0FFEE0000000000000000000000000000000001",
        to: accepted.payTo,
        value: accepted.amount,
        validAfter: "0",
        validBefore: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: "0x" + "11".repeat(32),
      },
    },
  })).toString("base64");
}

// ── process management ──────────────────────────────────────────────
const children = [];
function launch(label, command, cmdArgs, opts = {}) {
  // No shell: these are all `process.execPath <abs path>`, and on Windows the
  // node binary lives under "C:\Program Files\...", which a shell would split.
  const child = spawn(command, cmdArgs, { cwd: REPO_ROOT, ...opts });
  child.__label = label;
  child.__log = "";
  const capture = d => {
    child.__log += d.toString();
    if (VERBOSE) process.stdout.write(`[${label}] ${d}`);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  children.push(child);
  return child;
}

function shutdown() {
  for (const c of children) {
    try { c.kill(); } catch { /* already gone */ }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitForHealth(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${GW}/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  return false;
}

function run(command, cmdArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, cmdArgs, {
      cwd: REPO_ROOT, stdio: "inherit", shell: process.platform === "win32",
    });
    child.on("exit", code => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))));
    child.on("error", reject);
  });
}

// ── main ────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(64));
  console.log("RTP EXT PROOF — NVIDIA frozen-path + robots/task commit gate");
  console.log("═".repeat(64));

  if (!NO_BUILD) {
    console.log("\n▸ Compiling src/ with tsc ...");
    // tsc directly, not `npm run build`: the prebuild step fetches remote
    // discovery data and this gate must not need the network.
    await run("npx", ["tsc"]);
  }
  if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
    throw new Error("dist/index.js missing — run without --no-build");
  }

  console.log("▸ Starting mock Supabase + mock facilitator ...");
  launch("mock-supabase", process.execPath, [join(PROOF_DIR, "mock-supabase.mjs"), String(SUPABASE_PORT)]);
  launch("mock-facilitator", process.execPath, [join(PROOF_DIR, "mock-facilitator.mjs"), String(FACILITATOR_PORT)]);
  await sleep(1500);

  console.log("▸ Booting gateway on port " + GATEWAY_PORT + " ...");
  const gateway = launch("gateway", process.execPath, [join(REPO_ROOT, "dist", "index.js")], {
    env: {
      ...process.env,
      PORT: String(GATEWAY_PORT),
      BASE_URL: GW,
      SUPABASE_URL: `http://127.0.0.1:${SUPABASE_PORT}`,
      SUPABASE_SERVICE_KEY: "proof",
      SUPABASE_SERVICE_ROLE_KEY: "proof",
      SUPABASE_ANON_KEY: "proof",
      X402_FACILITATOR_URL: FAC,
      PAY_TO_ADDRESS: "0x9999999999999999999999999999999999999999",
      SOLANA_RECEIVE_ADDRESS: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5",
      SOLANA_PAYMENTS_ENABLED: "false",
      RESEND_API_KEY: "re_proof_placeholder",
      STRIPE_SECRET_KEY: "sk_test_proof_placeholder",
      STRIPE_WEBHOOK_SECRET: "whsec_proof_placeholder",
      TWILIO_ACCOUNT_SID: "ACproof00000000000000000000000000",
      TWILIO_AUTH_TOKEN: "proof",
      NODE_ENV: "development",
    },
  });

  if (!(await waitForHealth())) {
    console.error("\nGateway failed to become healthy. Last output:\n");
    console.error(gateway.__log.slice(-4000));
    throw new Error("gateway did not start");
  }
  console.log("  gateway healthy\n");

  // ══ BLOCK A — frozen NVIDIA paths ═════════════════════════════════
  console.log("─".repeat(64));
  console.log("BLOCK A — nine frozen NVIDIA paths (shape vs committed baseline)");
  console.log("─".repeat(64));

  const observed = [];
  for (const c of FROZEN) {
    const r = await req(c.path, { method: c.method, body: c.body });
    observed.push({
      name: c.name,
      status: r.status,
      contentType: r.contentType,
      topLevelKeys: r.body && typeof r.body === "object" && !Array.isArray(r.body)
        ? Object.keys(r.body).sort() : typeof r.body,
      keyPaths: [...keyPaths(r.body)].sort(),
      versionValues: [...new Set(versionValues(r.body))].sort(),
    });
  }

  if (UPDATE_BASELINE) {
    writeFileSync(BASELINE_PATH, JSON.stringify({
      note: "Shape baseline for the nine frozen NVIDIA paths. Regenerate ONLY " +
            "for an intentional, additive change, with --update-baseline, and " +
            "commit alongside the change that caused it.",
      paths: observed,
    }, null, 2) + "\n");
    console.log(`\n  Baseline rewritten: ${BASELINE_PATH}`);
    for (const o of observed) {
      console.log(`  ${String(o.status).padEnd(4)} ${o.name}  (${o.keyPaths.length} key paths)`);
    }
    console.log("\n  --update-baseline: no assertions run. Re-run without the flag to verify.");
    shutdown();
    process.exit(0);
  }

  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`No baseline at ${BASELINE_PATH}. Create one with --update-baseline.`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));

  for (const o of observed) {
    const b = baseline.paths.find(p => p.name === o.name);
    if (!b) { record("A", o.name, false, "not present in baseline"); continue; }

    const problems = [];
    if (o.status !== b.status) problems.push(`status ${b.status} -> ${o.status}`);
    if (o.contentType !== b.contentType) problems.push(`content-type ${b.contentType} -> ${o.contentType}`);

    const tlAdded = setDiff(o.topLevelKeys, b.topLevelKeys);
    const tlRemoved = setDiff(b.topLevelKeys, o.topLevelKeys);
    if (tlAdded.length) problems.push(`top-level keys ADDED: ${tlAdded.join(", ")}`);
    if (tlRemoved.length) problems.push(`top-level keys REMOVED: ${tlRemoved.join(", ")}`);

    const kpAdded = setDiff(o.keyPaths, b.keyPaths);
    const kpRemoved = setDiff(b.keyPaths, o.keyPaths);
    if (kpAdded.length) problems.push(`key paths ADDED: ${kpAdded.slice(0, 8).join(", ")}${kpAdded.length > 8 ? ` (+${kpAdded.length - 8})` : ""}`);
    if (kpRemoved.length) problems.push(`key paths REMOVED: ${kpRemoved.slice(0, 8).join(", ")}${kpRemoved.length > 8 ? ` (+${kpRemoved.length - 8})` : ""}`);

    // Reported, never asserted — a version bump is an expected value change.
    let note = "";
    if (o.versionValues.length) {
      const changed = JSON.stringify(o.versionValues) !== JSON.stringify(b.versionValues ?? []);
      note = `version fields: ${JSON.stringify(o.versionValues)}` +
             (changed ? ` (baseline ${JSON.stringify(b.versionValues ?? [])}) — value change, shape unaffected` : "");
    }
    record("A", o.name, problems.length === 0, problems.length ? problems.join("; ") : note);
  }

  // ══ BLOCK B — robots/task pay-before-validate ═════════════════════
  console.log("\n" + "─".repeat(64));
  console.log("BLOCK B — robots/task: validation runs before the payment gate");
  console.log("─".repeat(64));

  const challenge = await req("/api/v1/robots/task", {
    method: "POST", body: { robot_id: "proof_bot_online", task: "pick" },
  });
  const evmAccept = (challenge.body?.accepts || []).find(a => String(a.network).startsWith("eip155"));

  record("B", "unpaid + valid payload -> 402, x402Version 2, amount 50000",
    challenge.status === 402 && challenge.body?.x402Version === 2 &&
      !!evmAccept && String(evmAccept.amount) === "50000",
    `status=${challenge.status} x402Version=${challenge.body?.x402Version} amount=${evmAccept?.amount} accepts=${(challenge.body?.accepts || []).length}`);

  if (!evmAccept) throw new Error("no EVM accepts[] entry on the robots/task challenge — cannot continue");

  // Unpaid + invalid must STILL be the 402 challenge. Agents probe this
  // endpoint with empty bodies to read accepts[]; answering 400 there would
  // break x402 discovery, and nothing settles on an unpaid request anyway.
  const unpaidInvalid = [
    ["empty body", {}],
    ["missing task", { robot_id: "proof_bot_online" }],
    ["unknown robot", { robot_id: "proof_bot_missing", task: "pick" }],
    ["offline robot", { robot_id: "proof_bot_offline", task: "pick" }],
    ["unsupported capability", { robot_id: "proof_bot_online", task: "fly" }],
  ];
  let unpaidOk = true;
  const unpaidDetail = [];
  for (const [label, body] of unpaidInvalid) {
    const r = await req("/api/v1/robots/task", { method: "POST", body });
    const ok = r.status === 402 && r.body?.x402Version === 2;
    unpaidOk &&= ok;
    unpaidDetail.push(`${label}=${r.status}`);
  }
  record("B", "unpaid + invalid payload -> unchanged 402 (discovery preserved)",
    unpaidOk, unpaidDetail.join("  "));

  // The core assertion: rejected payloads must never reach the payment gate.
  const paidInvalid = [
    ["missing fields", { robot_id: "proof_bot_online" }, 400],
    ["unknown robot", { robot_id: "proof_bot_missing", task: "pick" }, 404],
    ["offline robot", { robot_id: "proof_bot_offline", task: "pick" }, 409],
    ["unsupported capability", { robot_id: "proof_bot_online", task: "fly" }, 400],
  ];
  for (const [label, body, expected] of paidInvalid) {
    await clearCalls();
    const r = await req("/api/v1/robots/task", {
      method: "POST", body, headers: { "PAYMENT-SIGNATURE": buildPayment(evmAccept) },
    });
    const calls = await getCalls();
    const ops = calls.map(c => c.op);
    record("B", `paid + invalid (${label}) -> ${expected}, zero facilitator calls`,
      r.status === expected && calls.length === 0,
      `status=${r.status} (want ${expected})  facilitator=${JSON.stringify(ops)}  error=${JSON.stringify(r.body?.error ?? null)}`);
  }

  // The valid path must be untouched: still verifies, settles and dispatches.
  await clearCalls();
  const good = await req("/api/v1/robots/task", {
    method: "POST",
    body: { robot_id: "proof_bot_online", task: "pick", parameters: { bin: "A3" }, timeout_seconds: 0 },
    headers: { "PAYMENT-SIGNATURE": buildPayment(evmAccept) },
  });
  const goodOps = (await getCalls()).map(c => c.op);
  record("B", "paid + valid -> 201 DISPATCHED, verify + settle both called",
    good.status === 201 && good.body?.status === "DISPATCHED" &&
      goodOps.includes("verify") && goodOps.includes("settle"),
    `status=${good.status} body.status=${good.body?.status} facilitator=${JSON.stringify(goodOps)}`);

  // ══ BLOCK C — no leak onto other paid routes ══════════════════════
  console.log("\n" + "─".repeat(64));
  console.log("BLOCK C — payment gate still runs for other paid endpoints");
  console.log("─".repeat(64));

  const otherPaid = [
    { name: "GET /api/v1/robots/list", method: "GET", path: "/api/v1/robots/list" },
    { name: "POST /api/v1/batch/execute", method: "POST", path: "/api/v1/batch/execute",
      body: { chain: "base", token: "USDC",
              payments: [{ to: "0x1111111111111111111111111111111111111111", amount: "1.00" }] } },
    { name: "POST /api/v1/escrow/create", method: "POST", path: "/api/v1/escrow/create",
      body: { amount: "10.00", token: "USDC", recipient: "0x1111111111111111111111111111111111111111" } },
  ];
  for (const t of otherPaid) {
    const ch = await req(t.path, { method: t.method, body: t.body });
    const accept = (ch.body?.accepts || []).find(a => String(a.network).startsWith("eip155"));
    if (!accept) { record("C", `${t.name} advertises an EVM price`, false, `status=${ch.status}`); continue; }
    await clearCalls();
    const r = await req(t.path, {
      method: t.method, body: t.body, headers: { "PAYMENT-SIGNATURE": buildPayment(accept) },
    });
    const ops = (await getCalls()).map(c => c.op);
    record("C", `${t.name} still reaches the payment gate when paid`,
      ops.includes("verify"),
      `unpaid=402 amount=${accept.amount}  paid=${r.status}  facilitator=${JSON.stringify(ops)}`);
  }

  // ══ summary ═══════════════════════════════════════════════════════
  const failed = results.filter(r => !r.pass);
  console.log("\n" + "═".repeat(64));
  console.log("SUMMARY");
  console.log("═".repeat(64));
  for (const block of ["A", "B", "C"]) {
    const inBlock = results.filter(r => r.block === block);
    const bad = inBlock.filter(r => !r.pass).length;
    console.log(`  Block ${block}: ${inBlock.length - bad}/${inBlock.length} passed`);
  }
  console.log("─".repeat(64));

  if (failed.length) {
    console.log(`\n  NVIDIA COMPAT BLOCK: FAILED (${failed.length} check${failed.length === 1 ? "" : "s"})`);
    for (const f of failed) console.log(`    - [${f.block}] ${f.name}\n      ${f.detail}`);
    console.log("\n  Do not commit. If a shape change was intentional and additive,");
    console.log("  re-run with --update-baseline and commit the new baseline with it.");
    return 1;
  }

  console.log(`\n  NVIDIA COMPAT BLOCK: PASSED (${results.length} checks)`);
  console.log("  Nine frozen paths unchanged; robots/task validates before it charges.");
  return 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(`\nPROOF ERROR: ${err.message}`);
  exitCode = 1;
} finally {
  shutdown();
}
// The gateway keeps timers and sockets alive; nothing left to wait for.
process.exit(exitCode);
