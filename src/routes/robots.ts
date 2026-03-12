/**
 * RTP — Robot Task Protocol Routes
 * Spraay x402 Gateway — Category 15: Robotics / RTP
 *
 * Endpoints:
 *   POST /api/v1/robots/register      — Register a robot (FREE, API key auth)
 *   POST /api/v1/robots/task           — Dispatch task to robot (x402 paid)
 *   POST /api/v1/robots/complete       — Report task completion (FREE, API key auth)
 *   GET  /api/v1/robots/list           — Discover robots (x402 paid)
 *   GET  /api/v1/robots/status         — Poll task status (x402 paid)
 *   GET  /api/v1/robots/profile        — Robot profile (x402 paid)
 *   PATCH /api/v1/robots/update        — Update robot (FREE, API key auth)
 *   POST /api/v1/robots/deregister     — Remove robot (FREE, API key auth)
 */

import { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import axios from "axios";

const supabase = createClient(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || ""
);

// ---- Helpers ----

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function getAssetContract(chain: string, currency: string): string {
  const c: Record<string, Record<string, string>> = {
    base: { USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    arbitrum: { USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" },
    ethereum: { USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
    polygon: { USDT: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", USDC: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" },
  };
  return c[chain]?.[currency] || "";
}

// ---- POST /api/v1/robots/register ----

export async function robotRegisterHandler(req: Request, res: Response) {
  try {
    const { name, description, capabilities, price_per_task, currency, chain, payment_address, connection, tags, metadata } = req.body;

    if (!name || !capabilities?.length || !price_per_task || !payment_address || !connection?.type) {
      return res.status(400).json({ error: "Missing required: name, capabilities, price_per_task, payment_address, connection.type" });
    }

    const validTypes = ["webhook", "xmtp", "wifi", "websocket"];
    if (!validTypes.includes(connection.type)) {
      return res.status(400).json({ error: `Invalid connection type. Use: ${validTypes.join(", ")}` });
    }

    const robotId = genId("robo");
    const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";

    const { data, error } = await supabase.from("robots").insert({
      robot_id: robotId,
      name,
      description: description || null,
      capabilities,
      price_per_task: String(price_per_task),
      currency: currency || "USDC",
      chain: chain || "base",
      payment_address,
      connection_type: connection.type,
      connection_config: connection,
      tags: tags || [],
      metadata: metadata || {},
      status: "online",
      registered_at: new Date().toISOString(),
    }).select().single();

    if (error) {
      console.error("Robot registration error:", error);
      return res.status(500).json({ error: "Registration failed", details: error.message });
    }

    // Audit
    await supabase.from("audit_log").insert({
      event: "robot_registered", details: { robot_id: robotId, name, capabilities, price_per_task },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({
      status: "registered",
      robot_id: robotId,
      rtp_uri: `rtp://gateway.spraay.app/${robotId}`,
      x402_endpoint: `${BASE_URL}/api/v1/robots/task?robot_id=${robotId}`,
      registered_at: data?.registered_at,
    });
  } catch (err: any) {
    console.error("Robot register error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- POST /api/v1/robots/task (x402 paid) ----

export async function robotTaskHandler(req: Request, res: Response) {
  try {
    const robotId = req.body.robot_id || req.query.robot_id;
    if (!robotId) return res.status(400).json({ error: "robot_id required" });

    const { data: robot } = await supabase.from("robots").select("*").eq("robot_id", robotId).single();
    if (!robot) return res.status(404).json({ error: "Robot not found" });
    if (robot.status === "offline") return res.status(503).json({ error: "RTP_ROBOT_OFFLINE", message: "Robot is currently offline" });

    const { task, parameters, callback_url, timeout_seconds } = req.body;
    const timeout = timeout_seconds || 60;

    if (task && !robot.capabilities.includes(task)) {
      return res.status(400).json({ error: "RTP_UNKNOWN_CAPABILITY", message: `Robot does not support: ${task}`, supported: robot.capabilities });
    }

    const taskId = genId("task");
    const escrowId = genId("escrow");

    // Create escrow record
    await supabase.from("escrows").insert({
      escrow_id: escrowId, depositor: "x402-agent", beneficiary: robot.payment_address,
      token: robot.currency, amount: robot.price_per_task, chain: robot.chain,
      status: "held", conditions: [{ type: "rtp_task", task_id: taskId }],
      created_at: new Date().toISOString(),
    });

    // Create task record
    await supabase.from("robot_tasks").insert({
      task_id: taskId, robot_id: robotId, task_type: task || "custom",
      parameters: parameters || {}, callback_url: callback_url || null,
      timeout_seconds: timeout, escrow_id: escrowId,
      payment_amount: robot.price_per_task, payment_currency: robot.currency,
      payment_chain: robot.chain, status: "PENDING",
      issued_at: new Date().toISOString(),
    });

    // Build task envelope
    const envelope = {
      rtp_version: "1.0", task_id: taskId, robot_id: robotId, task: task || "custom",
      parameters: parameters || {},
      payment: { amount: robot.price_per_task, currency: robot.currency, chain: robot.chain },
      callback_url: callback_url || null, timeout_seconds: timeout,
      issued_at: new Date().toISOString(),
    };

    // Dispatch to robot
    let dispatched = false;
    try {
      if (robot.connection_type === "webhook" && robot.connection_config?.webhookUrl) {
        const body = JSON.stringify(envelope);
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (robot.connection_config.secret) {
          headers["X-RTP-Signature"] = "sha256=" + crypto.createHmac("sha256", robot.connection_config.secret).update(body).digest("hex");
        }
        await axios.post(robot.connection_config.webhookUrl, envelope, { headers, timeout: 10000 });
        dispatched = true;
      }
      // TODO: xmtp, wifi, websocket dispatch
    } catch (dispatchErr: any) {
      console.warn(`Dispatch to ${robotId} failed: ${dispatchErr.message}`);
    }

    const status = dispatched ? "DISPATCHED" : "PENDING";
    await supabase.from("robot_tasks").update({ status, dispatched_at: dispatched ? new Date().toISOString() : null }).eq("task_id", taskId);

    // Timeout watchdog
    setTimeout(async () => {
      const { data: current } = await supabase.from("robot_tasks").select("status").eq("task_id", taskId).single();
      if (current && !["COMPLETED", "FAILED", "TIMEOUT"].includes(current.status)) {
        await supabase.from("robot_tasks").update({ status: "TIMEOUT", completed_at: new Date().toISOString() }).eq("task_id", taskId);
        try { await supabase.from("escrows").update({ status: "refunded" }).eq("escrow_id", escrowId); } catch {}
        if (callback_url) { try { axios.post(callback_url, { rtp_version: "1.0", task_id: taskId, status: "TIMEOUT", result: { success: false, error: "Timed out" } }); } catch {} }
      }
    }, timeout * 1000);

    // Audit
    await supabase.from("audit_log").insert({ event: "robot_task_dispatched", details: { task_id: taskId, robot_id: robotId, task, payment: robot.price_per_task }, timestamp: new Date().toISOString() });

    res.json({ status, task_id: taskId, robot_id: robotId, escrow_id: escrowId, rtp_version: "1.0", dispatched_at: new Date().toISOString() });
  } catch (err: any) {
    console.error("Robot task error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- POST /api/v1/robots/complete ----

export async function robotCompleteHandler(req: Request, res: Response) {
  try {
    const { task_id, robot_id, status, result } = req.body;
    if (!task_id || !status || !result) return res.status(400).json({ error: "Missing: task_id, status, result" });

    const { data: task } = await supabase.from("robot_tasks").select("*").eq("task_id", task_id).single();
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (["COMPLETED", "FAILED", "TIMEOUT"].includes(task.status)) {
      return res.status(409).json({ error: "Task already terminal", current_status: task.status });
    }

    await supabase.from("robot_tasks").update({ status, result, completed_at: new Date().toISOString() }).eq("task_id", task_id);

    let escrowAction = null;
    if (status === "COMPLETED" && task.escrow_id) {
      await supabase.from("escrows").update({ status: "released" }).eq("escrow_id", task.escrow_id);
      escrowAction = "released";
    } else if (["FAILED", "TIMEOUT"].includes(status) && task.escrow_id) {
      await supabase.from("escrows").update({ status: "refunded" }).eq("escrow_id", task.escrow_id);
      escrowAction = "refunded";
    }

    // Fire callback
    if (task.callback_url) {
      axios.post(task.callback_url, { rtp_version: "1.0", task_id, robot_id: robot_id || task.robot_id, status, result, completed_at: new Date().toISOString() });
    }

    await supabase.from("audit_log").insert({ event: `robot_task_${status.toLowerCase()}`, details: { task_id, status, output: result?.output || result?.error }, timestamp: new Date().toISOString() });

    res.json({ task_id, status, escrow: escrowAction });
  } catch (err: any) {
    console.error("Robot complete error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- GET /api/v1/robots/list ----

export async function robotListHandler(req: Request, res: Response) {
  try {
    let query = supabase.from("robots").select("robot_id, name, description, capabilities, price_per_task, currency, chain, status, tags, registered_at").order("registered_at", { ascending: false });
    if (req.query.capability) query = query.contains("capabilities", [req.query.capability as string]);
    if (req.query.chain) query = query.eq("chain", req.query.chain as string);
    if (req.query.max_price) query = query.lte("price_per_task", req.query.max_price as string);
    if (req.query.status) query = query.eq("status", req.query.status as string);

    const { data: robots, error } = await query;
    if (error) return res.status(500).json({ error: "Query failed" });

    const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";
    res.json({
      robots: (robots || []).map((r: any) => ({
        ...r,
        rtp_uri: `rtp://gateway.spraay.app/${r.robot_id}`,
        x402_endpoint: `${BASE_URL}/api/v1/robots/task?robot_id=${r.robot_id}`,
      })),
      total: robots?.length || 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- GET /api/v1/robots/status ----

export async function robotTaskStatusHandler(req: Request, res: Response) {
  try {
    const taskId = req.query.task_id as string;
    if (!taskId) return res.status(400).json({ error: "task_id query param required" });

    const { data: task } = await supabase.from("robot_tasks").select("task_id, robot_id, task_type, status, parameters, result, issued_at, dispatched_at, completed_at").eq("task_id", taskId).single();
    if (!task) return res.status(404).json({ error: "Task not found" });

    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- GET /api/v1/robots/profile ----

export async function robotProfileHandler(req: Request, res: Response) {
  try {
    const robotId = req.query.robot_id as string;
    if (!robotId) return res.status(400).json({ error: "robot_id query param required" });

    const { data: robot } = await supabase.from("robots").select("*").eq("robot_id", robotId).single();
    if (!robot) return res.status(404).json({ error: "Robot not found" });

    const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";
    res.json({
      ...robot,
      rtp_uri: `rtp://gateway.spraay.app/${robot.robot_id}`,
      x402_endpoint: `${BASE_URL}/api/v1/robots/task?robot_id=${robot.robot_id}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- PATCH /api/v1/robots/update ----

export async function robotUpdateHandler(req: Request, res: Response) {
  try {
    const { robot_id, ...updates } = req.body;
    if (!robot_id) return res.status(400).json({ error: "robot_id required" });

    const allowed = ["name", "description", "capabilities", "price_per_task", "currency", "chain", "payment_address", "connection", "tags", "metadata", "status"];
    const patch: Record<string, any> = {};
    for (const k of allowed) {
      if (updates[k] !== undefined) {
        if (k === "connection") { patch.connection_type = updates[k].type; patch.connection_config = updates[k]; }
        else patch[k] = updates[k];
      }
    }
    patch.updated_at = new Date().toISOString();

    const { error } = await supabase.from("robots").update(patch).eq("robot_id", robot_id);
    if (error) return res.status(500).json({ error: "Update failed" });

    res.json({ robot_id, updated: Object.keys(patch), updated_at: patch.updated_at });
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
}

// ---- POST /api/v1/robots/deregister ----

export async function robotDeregisterHandler(req: Request, res: Response) {
  try {
    const { robot_id } = req.body;
    if (!robot_id) return res.status(400).json({ error: "robot_id required" });

    const { data: active } = await supabase.from("robot_tasks").select("task_id").eq("robot_id", robot_id).in("status", ["PENDING", "DISPATCHED", "IN_PROGRESS"]);
    if (active && active.length > 0) return res.status(409).json({ error: "Robot has active tasks", active_tasks: active.length });

    const { error } = await supabase.from("robots").delete().eq("robot_id", robot_id);
    if (error) return res.status(500).json({ error: "Deregistration failed" });

    await supabase.from("audit_log").insert({ event: "robot_deregistered", details: { robot_id }, timestamp: new Date().toISOString() });
    res.json({ robot_id, deregistered: true });
  } catch (err: any) {
    res.status(500).json({ error: "Internal server error" });
  }
}
