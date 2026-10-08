/**
 * Tests for outbound-URL hardening:
 *
 *   src/lib/ssrf-guard.ts
 *     - all of fc00::/7 is blocked (fc00:: – fdff::), not only "fc00:"
 *     - IPv4-mapped IPv6 (::ffff:a.b.c.d and the hex form ::ffff:a00:1 that
 *       WHATWG URL produces) is checked against the IPv4 ranges
 *     - bracketed IPv6 literals in URLs are looked up unbracketed
 *
 *   src/webhooks/service.ts deliverEvent
 *     - callback_url re-checked with the guard before fetch; unsafe (or DNS
 *       failure) is a failed attempt and nothing is sent
 *     - fetch uses redirect: "manual"; any 3xx is a failed attempt
 *
 * Offline: a small PostgREST mock for the webhook_events state updates,
 * global fetch captured for deliveries, and *.test hostnames resolved by a
 * stub. IP literals never leave the machine.
 *   npx ts-node --project test/tsconfig.json test/webhook-ssrf.test.ts
 */

import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";

// ── DNS stub for *.test hostnames (everything else is real) ───────────
const dnsPromises = require("node:dns/promises");
const realLookup = dnsPromises.lookup;
const STUB: Record<string, { address: string; family: number }> = {
  "public.test": { address: "93.184.215.14", family: 4 },
  "nat64-private.test": { address: "64:ff9b::a00:5", family: 6 },
  "linklocal.test": { address: "fea0::1", family: 6 },
  "unspecified.test": { address: "::", family: 6 },
  "mapped-private.test": { address: "::ffff:192.168.0.5", family: 6 },
  "mapped-hex.test": { address: "::ffff:a00:5", family: 6 },
  "ula.test": { address: "fd00:1::5", family: 6 },
  "ula-fc.test": { address: "fc12:3456::1", family: 6 },
};
dnsPromises.lookup = async (host: string, ...rest: any[]) => {
  if (host === "dnsfail.test") throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  if (STUB[host]) return STUB[host];
  return realLookup(host, ...rest);
};

// ── PostgREST mock: webhook_events updates + the attempts rpc ─────────
const updates: Array<{ id: string; patch: any }> = [];
let rpcCalls = 0;
const db = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url!, "http://mock");
    if (url.pathname.endsWith("/rpc/increment_webhook_attempts")) { rpcCalls++; res.writeHead(204); return res.end(); }
    if (req.method === "PATCH" && url.pathname.endsWith("/webhook_events")) {
      updates.push({ id: (url.searchParams.get("id") || "").replace(/^eq\./, ""), patch: JSON.parse(raw) });
      res.writeHead(204); return res.end();
    }
    res.writeHead(404, { "Content-Type": "application/json" }); res.end("{}");
  });
});

// ── harness ─────────────────────────────────────────────────────────
const out = (s: string) => process.stdout.write(s + "\n");
let failed = 0, passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; out(`  PASS  ${name}`); }
  catch (err: any) { failed++; out(`  FAIL  ${name}\n        ${String(err.message).split("\n").join("\n        ")}`); }
}
for (const m of ["log", "warn"] as const) console[m] = () => {};
// Close a server and its keep-alive sockets before exit (a bare close() racing
// process.exit trips a libuv assertion on Windows).
const closeServer = (s: http.Server) => new Promise<void>(ok => { s.close(() => ok()); s.closeAllConnections(); });

async function main() {
  await new Promise<void>(ok => db.listen(0, "127.0.0.1", ok));
  const SUPABASE_URL = `http://127.0.0.1:${(db.address() as AddressInfo).port}`;
  const { createClient } = require("@supabase/supabase-js");
  const { isBlockedAddress, validateOutboundURL }: typeof import("../src/lib/ssrf-guard.js") = require("../src/lib/ssrf-guard.js");
  const { WebhookService } = require("../src/webhooks/index.js");
  const service = new WebhookService(createClient(SUPABASE_URL, "test"));

  // Capture deliveries; let the mock-DB traffic through.
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; init: any }> = [];
  let reply: () => Response = () => new Response("ok", { status: 200 });
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).startsWith(SUPABASE_URL)) return realFetch(url, init);
    sent.push({ url: String(url), init });
    return reply();
  }) as any;

  let n = 0;
  const event = (callback_url: string, over: Record<string, any> = {}) => ({
    id: `evt-${++n}`, event_type: "cron.triggered", payload: { x: 1 }, callback_url,
    hmac_secret: "whsec_test", status: "pending", attempts: 0, max_attempts: 3,
    next_retry_at: new Date().toISOString(), last_error: null, dispatched_at: null,
    source_endpoint: null, request_id: null, batch_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
  });
  const lastUpdate = (id: string) => updates.filter(u => u.id === id).at(-1)?.patch;

  try {
    out("── isBlockedAddress: fc00::/7");
    for (const a of ["fc00::1", "fc12:3456::1", "fd00::1", "fd12:3456:789a::1", "fdff:ffff:ffff::1", "FD12::1"]) {
      await test(`${a} blocked`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }
    for (const a of ["fbff::1", "fe00::1", "fc::1", "fd::1", "2606:4700:4700::1111", "2001:db8::fc00"]) {
      await test(`${a} not blocked (outside fc00::/7)`, async () => assert.strictEqual(isBlockedAddress(a), false));
    }

    out("── isBlockedAddress: IPv4-mapped IPv6");
    for (const a of ["::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:192.168.1.1", "::ffff:169.254.169.254",
                     "::ffff:172.16.0.1", "::ffff:100.64.0.1", "::ffff:0.0.0.0",
                     "::ffff:a00:1", "::ffff:7f00:1", "::ffff:c0a8:101", "::ffff:a9fe:a9fe", "::FFFF:A00:1",
                     "0:0:0:0:0:ffff:10.0.0.1", "0000:0000:0000:0000:0000:ffff:7f00:0001"]) {
      await test(`${a} blocked (embedded IPv4 is private/reserved)`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }
    for (const a of ["::ffff:8.8.8.8", "::ffff:808:808", "::ffff:93.184.215.14"]) {
      await test(`${a} not blocked (embedded IPv4 is public)`, async () => assert.strictEqual(isBlockedAddress(a), false));
    }

    out("── isBlockedAddress: unspecified ::");
    for (const a of ["::", "0:0:0:0:0:0:0:0", "0000:0000:0000:0000:0000:0000:0000:0000"]) {
      await test(`${a} blocked`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }

    out("── isBlockedAddress: fe80::/10 link-local");
    for (const a of ["fe80::1", "fe90::1", "fea0::1", "feb0::1", "febf::1", "febf:ffff::1", "FE9A::1"]) {
      await test(`${a} blocked`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }
    for (const a of ["fe7f::1", "fec0::1", "fe::1"]) {
      await test(`${a} not blocked (outside fe80::/10)`, async () => assert.strictEqual(isBlockedAddress(a), false));
    }

    out("── isBlockedAddress: NAT64 64:ff9b::/96");
    for (const a of ["64:ff9b::a00:1", "64:ff9b::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::c0a8:101", "64:ff9b::a9fe:a9fe",
                     "0064:ff9b:0000:0000:0000:0000:0a00:0001", "64:ff9b:0:0:0:0:127.0.0.1", "64:FF9B::A00:1",
                     "64:ff9b::1", "64:ff9b::"]) {
      await test(`${a} blocked (embedded IPv4 is private/reserved)`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }
    for (const a of ["64:ff9b::808:808", "64:ff9b::8.8.8.8", "64:ff9b:1::a00:1"]) {
      await test(`${a} not blocked (public embedded IPv4, or outside the /96)`, async () => assert.strictEqual(isBlockedAddress(a), false));
    }
    for (const a of ["::ffff:1", "::ffff:0:1"]) {
      await test(`${a} blocked (short hex form of a mapped 0.x address)`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }

    out("── isBlockedAddress: unchanged behaviour");
    for (const a of ["127.0.0.1", "10.1.2.3", "172.31.255.255", "192.168.0.1", "169.254.169.254", "0.0.0.0", "100.127.0.1", "::1", "fe80::1"]) {
      await test(`${a} blocked`, async () => assert.strictEqual(isBlockedAddress(a), true));
    }
    // (100.128.0.0/16 and 100.129.0.0/16 are over-blocked by the existing 100.64/10
    // pattern; pre-existing and on the safe side, logged as a follow-up.)
    for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.130.0.1"]) {
      await test(`${a} not blocked`, async () => assert.strictEqual(isBlockedAddress(a), false));
    }

    out("── validateOutboundURL");
    const unsafe: Array<[string, RegExp]> = [
      ["https://[fd12::1]/hook", /private\/reserved/],
      ["https://[fc00::5]/hook", /private\/reserved/],
      ["https://[::ffff:10.0.0.1]/hook", /private\/reserved/],   // URL serializes this as [::ffff:a00:1]
      ["https://[::ffff:127.0.0.1]/hook", /private\/reserved/],
      ["https://[::1]/hook", /private\/reserved/],
      ["https://[::]/x", /private\/reserved/],
      ["https://[0:0:0:0:0:0:0:0]/x", /private\/reserved/],
      ["https://[fe90::1]/hook", /private\/reserved/],
      ["https://[febf::1]/hook", /private\/reserved/],
      ["https://[64:ff9b::a00:1]/hook", /private\/reserved/],
      ["https://[64:ff9b::10.0.0.1]/hook", /private\/reserved/],
      ["https://nat64-private.test/hook", /private\/reserved/],
      ["https://linklocal.test/hook", /private\/reserved/],
      ["https://unspecified.test/hook", /private\/reserved/],
      ["https://mapped-private.test/hook", /private\/reserved/],
      ["https://mapped-hex.test/hook", /private\/reserved/],
      ["https://ula.test/hook", /private\/reserved/],
      ["https://ula-fc.test/hook", /private\/reserved/],
      ["https://127.0.0.1/hook", /private\/reserved/],
      ["https://localhost/hook", /Blocked hostname/],
      ["https://dnsfail.test/hook", /DNS resolution failed: ENOTFOUND/],
      ["ftp://1.1.1.1/x", /Protocol "ftp:" not allowed/],
    ];
    for (const [u, re] of unsafe) {
      await test(`${u} -> unsafe`, async () => {
        const r = await validateOutboundURL(u);
        assert.strictEqual(r.safe, false);
        assert.match(r.error!, re);
      });
    }
    for (const u of ["https://1.1.1.1/hook", "https://[::ffff:8.8.8.8]/hook", "https://[64:ff9b::808:808]/hook", "https://public.test/hook"]) {
      await test(`${u} -> safe`, async () => assert.strictEqual((await validateOutboundURL(u)).safe, true));
    }

    out("── deliverEvent: SSRF guard before fetch");
    await test("safe URL -> delivered, fetch called with redirect: \"manual\", marked dispatched", async () => {
      const e = event("https://1.1.1.1/hook");
      const before = sent.length;
      assert.strictEqual(await service.deliverEvent(e), true);
      assert.strictEqual(sent.length, before + 1);
      assert.strictEqual(sent.at(-1)!.init.redirect, "manual");
      assert.strictEqual(lastUpdate(e.id).status, "dispatched");
      assert.ok(rpcCalls >= 1);
    });
    for (const [u, re] of [
      ["https://127.0.0.1/hook", /^callback_url blocked: Resolved to a private\/reserved IP range$/],
      ["http://localhost:3000/hook", /^callback_url blocked: Blocked hostname$/],
      ["https://[::ffff:a00:1]/hook", /^callback_url blocked: Resolved to a private\/reserved IP range$/],
      ["https://ula.test/hook", /^callback_url blocked: Resolved to a private\/reserved IP range$/],
      ["https://[::]/hook", /^callback_url blocked: Resolved to a private\/reserved IP range$/],
      ["https://[fe90::1]/hook", /^callback_url blocked: Resolved to a private\/reserved IP range$/],
      ["https://[64:ff9b::a00:1]/hook", /^callback_url blocked: Resolved to a private\/reserved IP range$/],
      ["https://dnsfail.test/hook", /^callback_url blocked: DNS resolution failed: ENOTFOUND$/],
    ] as const) {
      await test(`${u} -> failed attempt, nothing sent`, async () => {
        const e = event(u);
        const before = sent.length;
        assert.strictEqual(await service.deliverEvent(e), false);
        assert.strictEqual(sent.length, before, "fetch must not be called");
        const p = lastUpdate(e.id);
        assert.strictEqual(p.status, "failed");
        assert.strictEqual(p.attempts, 1);
        assert.match(p.last_error, re);
      });
    }
    await test("unsafe URL on the last allowed attempt -> exhausted", async () => {
      const e = event("https://10.0.0.9/hook", { attempts: 2 });
      assert.strictEqual(await service.deliverEvent(e), false);
      assert.strictEqual(lastUpdate(e.id).status, "exhausted");
    });

    out("── deliverEvent: redirects are never followed");
    for (const code of [301, 302, 303, 307, 308]) {
      await test(`${code} -> failed attempt, not dispatched`, async () => {
        reply = () => new Response(null, { status: code, headers: { Location: "http://169.254.169.254/latest/meta-data/" } });
        const e = event("https://1.1.1.1/hook");
        try { assert.strictEqual(await service.deliverEvent(e), false); }
        finally { reply = () => new Response("ok", { status: 200 }); }
        const p = lastUpdate(e.id);
        assert.strictEqual(p.status, "failed");
        assert.strictEqual(p.last_error, `HTTP ${code}: redirect not followed`);
        assert.strictEqual(sent.at(-1)!.init.redirect, "manual");
      });
    }
    await test("non-redirect error status is still a plain failed attempt", async () => {
      reply = () => new Response("nope", { status: 500 });
      const e = event("https://1.1.1.1/hook");
      try { assert.strictEqual(await service.deliverEvent(e), false); }
      finally { reply = () => new Response("ok", { status: 200 }); }
      assert.strictEqual(lastUpdate(e.id).last_error, "HTTP 500: nope");
    });
    await test("Node fetch with redirect: \"manual\" returns the 3xx and does not follow it", async () => {
      let targetHits = 0;
      const target = http.createServer((_q, s) => { targetHits++; s.end("internal"); });
      await new Promise<void>(ok => target.listen(0, "127.0.0.1", ok));
      const origin = http.createServer((_q, s) => {
        s.writeHead(302, { Location: `http://127.0.0.1:${(target.address() as AddressInfo).port}/` }); s.end();
      });
      await new Promise<void>(ok => origin.listen(0, "127.0.0.1", ok));
      try {
        const r = await realFetch(`http://127.0.0.1:${(origin.address() as AddressInfo).port}/`, { method: "POST", body: "{}", redirect: "manual", headers: { Connection: "close" } });
        assert.strictEqual(r.status, 302);
        assert.strictEqual(targetHits, 0);
      } finally { await closeServer(target); await closeServer(origin); }
    });
  } finally {
    globalThis.fetch = realFetch;
    await closeServer(db);
  }

  out(`\n${passed} passed, ${failed} failed`);
  // exitCode, not process.exit(): exiting while the SSRF guard's DNS lookups
  // and fetch handles are winding down trips a libuv assertion on Windows.
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => { console.error(err); process.exit(1); });
