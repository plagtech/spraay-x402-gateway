// ============================================================
// Mock Supabase (PostgREST-compatible) for rtp-ext-proof.mjs
// ============================================================
// The proof run must not touch the real database, but the robots/task
// checks need robot lookups to resolve deterministically: one online robot
// that can 'pick', one offline robot, and a miss for anything else.
//
// Only the PostgREST surface robots.ts actually uses is implemented:
//   GET   /rest/v1/robots?select=*&robot_id=eq.<id>   (.single() via Accept)
//   POST  /rest/v1/robot_tasks                        (insert ... .select().single())
//   PATCH /rest/v1/robots?robot_id=eq.<id>            (status update)
//
// Port comes from argv[2].
// ============================================================

import http from "node:http";

const PORT = Number(process.argv[2] || 5591);

export const ROBOTS = {
  proof_bot_online: {
    robot_id: "proof_bot_online",
    name: "ProofBot-Online",
    capabilities: ["pick", "place", "scan"],
    price_per_task: "0.05",
    currency: "USDC",
    chain: "base",
    payment_address: "0x1111111111111111111111111111111111111111",
    status: "online",
    connection_type: "webhook",
    // Points at a closed port on purpose: dispatchToRobot() is fire-and-forget,
    // so the failed webhook is logged and never affects the HTTP response.
    connection_config: { webhookUrl: "http://127.0.0.1:9/rtp/task" },
    tags: ["proof"],
    metadata: {},
    registered_at: "2026-01-01T00:00:00.000Z",
  },
  proof_bot_offline: {
    robot_id: "proof_bot_offline",
    name: "ProofBot-Offline",
    capabilities: ["pick"],
    price_per_task: "0.05",
    currency: "USDC",
    chain: "base",
    payment_address: "0x2222222222222222222222222222222222222222",
    status: "offline",
    connection_type: "webhook",
    connection_config: { webhookUrl: "http://127.0.0.1:9/rtp/task" },
    tags: ["proof"],
    metadata: {},
    registered_at: "2026-01-01T00:00:00.000Z",
  },
};

function eqValue(url, field) {
  const v = url.searchParams.get(field);
  return v && v.startsWith("eq.") ? decodeURIComponent(v.slice(3)) : null;
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://placeholder");
    const table = url.pathname.replace("/rest/v1/", "");
    // supabase-js sets this Accept header for .single()
    const single = String(req.headers.accept || "").includes("pgrst.object");
    const send = (code, payload) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (table === "robots" && req.method === "GET") {
      const id = eqValue(url, "robot_id");
      const rows = id ? (ROBOTS[id] ? [ROBOTS[id]] : []) : Object.values(ROBOTS);
      if (single) {
        if (rows.length !== 1) {
          // PostgREST's real "no rows for .single()" response.
          return send(406, {
            code: "PGRST116",
            details: `Results contain ${rows.length} rows`,
            hint: null,
            message: "JSON object requested, multiple (or no) rows returned",
          });
        }
        return send(200, rows[0]);
      }
      return send(200, rows);
    }

    if (req.method === "POST") {
      let row = {};
      try { row = JSON.parse(raw || "{}"); } catch { /* echo an empty row */ }
      return send(201, single ? row : [row]);
    }

    if (req.method === "PATCH") return send(single ? 200 : 204, single ? {} : []);

    return send(200, single ? {} : []);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-supabase] listening on http://127.0.0.1:${PORT}`);
});
