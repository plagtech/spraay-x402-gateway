// ============================================================
// Mock x402 facilitator for rtp-ext-proof.mjs
// ============================================================
// Two jobs:
//
//  1. Let the gateway boot offline. @x402/core validates every advertised
//     route against GET /supported at startup and throws
//     RouteConfigurationError if a route's (scheme, network) pair is not
//     supported. This mock declares the EVM and Solana kinds the gateway
//     registers, so no live facilitator is needed.
//
//  2. Record every /verify and /settle call. That recording is the actual
//     evidence for the pay-before-validate assertions: a rejected payload
//     must produce ZERO facilitator calls, because reaching the payment
//     gate at all is the bug being guarded against.
//
// Control surface (not part of the x402 spec, used only by the proof):
//   GET    /_calls  -> recorded calls, in order
//   DELETE /_calls  -> reset the recording
//
// Payments are never real: /verify always approves and /settle returns a
// fixed fake transaction hash. Nothing is broadcast anywhere.
//
// Port comes from argv[2].
// ============================================================

import http from "node:http";

const PORT = Number(process.argv[2] || 5592);

const CALLS = [];

// Must cover every (scheme, network) the gateway registers in index.ts,
// or startup route validation fails.
const KINDS = [
  { x402Version: 2, scheme: "exact", network: "eip155:84532" },
  { x402Version: 2, scheme: "exact", network: "eip155:8453" },
  {
    x402Version: 2, scheme: "exact",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    extra: { feePayer: "CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5" },
  },
  { x402Version: 1, scheme: "exact", network: "base-sepolia" },
];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const path = req.url.split("?")[0];
    const send = (code, payload) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (path === "/_calls" && req.method === "GET") return send(200, CALLS);
    if (path === "/_calls" && req.method === "DELETE") {
      CALLS.length = 0;
      return send(200, { cleared: true });
    }

    if (path === "/supported") {
      return send(200, {
        kinds: KINDS,
        extensions: ["builder-code", "eip2612GasSponsoring", "erc20ApprovalGasSponsoring"],
        signers: {
          "eip155:*": ["0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf"],
          "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"],
        },
      });
    }

    let parsed = {};
    try { parsed = JSON.parse(raw || "{}"); } catch { /* leave empty */ }
    const resource = parsed?.paymentRequirements?.resource ?? null;

    if (path === "/verify") {
      CALLS.push({ op: "verify", resource });
      return send(200, { isValid: true, payer: "0xC0FFEE0000000000000000000000000000000001" });
    }

    if (path === "/settle") {
      CALLS.push({ op: "settle", resource });
      return send(200, {
        success: true,
        transaction: "0xproofmocksettlement000000000000000000000000000000000000000000001",
        network: parsed?.paymentRequirements?.network || "eip155:84532",
        payer: "0xC0FFEE0000000000000000000000000000000001",
      });
    }

    return send(404, { error: "not found", path });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-facilitator] listening on http://127.0.0.1:${PORT}`);
});
