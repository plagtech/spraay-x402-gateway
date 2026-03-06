import { createClient, SupabaseClient } from "@supabase/supabase-js";

// ============================================
// Spraay x402 Gateway — Database Layer
// Drop-in replacement for all Map() stores
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_KEY (or SUPABASE_SERVICE_KEY) are required");
}

const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================
// Generic helpers
// ============================================

async function insert<T extends Record<string, any>>(table: string, row: T): Promise<T> {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) throw new Error(`DB insert ${table}: ${error.message}`);
  return data as T;
}

async function getById<T>(table: string, id: string): Promise<T | null> {
  const { data, error } = await supabase.from(table).select("*").eq("id", id).single();
  if (error && error.code === "PGRST116") return null; // not found
  if (error) throw new Error(`DB get ${table}: ${error.message}`);
  return data as T;
}

async function update<T extends Record<string, any>>(table: string, id: string, updates: Partial<T>): Promise<T> {
  const { data, error } = await supabase.from(table).update(updates).eq("id", id).select().single();
  if (error) throw new Error(`DB update ${table}: ${error.message}`);
  return data as T;
}

async function deleteById(table: string, id: string): Promise<boolean> {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw new Error(`DB delete ${table}: ${error.message}`);
  return true;
}

// ============================================
// ESCROW
// ============================================

export const escrowDb = {
  async create(escrow: any) {
    return insert("escrows", {
      id: escrow.id,
      depositor: escrow.depositor,
      beneficiary: escrow.beneficiary,
      arbiter: escrow.arbiter,
      token_symbol: escrow.token.symbol,
      token_address: escrow.token.address,
      token_decimals: escrow.token.decimals,
      amount: escrow.amount,
      amount_raw: escrow.amountRaw,
      description: escrow.description,
      conditions: escrow.conditions,
      status: escrow.status,
      expires_at: escrow.expiresAt,
      funded_at: escrow.fundedAt,
      released_at: escrow.releasedAt,
      cancelled_at: escrow.cancelledAt,
      release_tx_hash: escrow.releaseTxHash,
      created_at: escrow.createdAt,
      updated_at: escrow.updatedAt,
    });
  },

  async get(id: string) {
    const row = await getById<any>("escrows", id.toUpperCase());
    return row ? escrowDb._fromRow(row) : null;
  },

  async update(id: string, updates: Record<string, any>) {
    // Convert camelCase to snake_case for the fields we update
    const mapped: Record<string, any> = {};
    if ("status" in updates) mapped.status = updates.status;
    if ("fundedAt" in updates) mapped.funded_at = updates.fundedAt;
    if ("releasedAt" in updates) mapped.released_at = updates.releasedAt;
    if ("cancelledAt" in updates) mapped.cancelled_at = updates.cancelledAt;
    if ("releaseTxHash" in updates) mapped.release_tx_hash = updates.releaseTxHash;
    mapped.updated_at = new Date().toISOString();
    await update("escrows", id.toUpperCase(), mapped);
  },

  async listByAddress(address: string, statusFilter?: string | null) {
    const lower = address.toLowerCase();
    let query = supabase.from("escrows").select("*")
      .or(`depositor.ilike.${lower},beneficiary.ilike.${lower},arbiter.ilike.${lower}`);
    if (statusFilter) query = query.eq("status", statusFilter);
    query = query.order("created_at", { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(`DB list escrows: ${error.message}`);
    return (data || []).map(escrowDb._fromRow);
  },

  _fromRow(row: any) {
    return {
      id: row.id,
      depositor: row.depositor,
      beneficiary: row.beneficiary,
      arbiter: row.arbiter,
      token: { symbol: row.token_symbol, address: row.token_address, decimals: row.token_decimals },
      amount: row.amount,
      amountRaw: row.amount_raw,
      description: row.description,
      conditions: row.conditions || [],
      status: row.status,
      expiresAt: row.expires_at,
      fundedAt: row.funded_at,
      releasedAt: row.released_at,
      cancelledAt: row.cancelled_at,
      releaseTxHash: row.release_tx_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
};

// ============================================
// INVOICE
// ============================================

export const invoiceDb = {
  async create(inv: any) {
    return insert("invoices", {
      id: inv.id,
      creator: inv.creator,
      recipient: inv.recipient,
      token_symbol: inv.token.symbol,
      token_name: inv.token.name,
      token_address: inv.token.address,
      token_decimals: inv.token.decimals,
      amount: inv.amount,
      amount_raw: inv.amountRaw,
      memo: inv.memo,
      reference: inv.reference,
      due_date: inv.dueDate,
      status: inv.status,
      payment_tx: inv.paymentTx,
      created_at: inv.createdAt,
      updated_at: inv.updatedAt,
    });
  },

  async get(id: string) {
    const row = await getById<any>("invoices", id.toUpperCase());
    return row ? invoiceDb._fromRow(row) : null;
  },

  async update(id: string, updates: Record<string, any>) {
    const mapped: Record<string, any> = {};
    if ("status" in updates) mapped.status = updates.status;
    if ("paymentTx" in updates) mapped.payment_tx = updates.paymentTx;
    mapped.updated_at = new Date().toISOString();
    await update("invoices", id.toUpperCase(), mapped);
  },

  async listByAddress(address: string, statusFilter?: string | null) {
    const lower = address.toLowerCase();
    let query = supabase.from("invoices").select("*")
      .or(`creator.ilike.${lower},recipient.ilike.${lower}`);
    if (statusFilter) query = query.eq("status", statusFilter);
    query = query.order("created_at", { ascending: false });
    const { data, error } = await query;
    if (error) throw new Error(`DB list invoices: ${error.message}`);
    return (data || []).map(invoiceDb._fromRow);
  },

  _fromRow(row: any) {
    return {
      id: row.id,
      creator: row.creator,
      recipient: row.recipient,
      token: { symbol: row.token_symbol, name: row.token_name, address: row.token_address, decimals: row.token_decimals },
      amount: row.amount,
      amountRaw: row.amount_raw,
      memo: row.memo,
      reference: row.reference,
      dueDate: row.due_date,
      status: row.status,
      paymentTx: row.payment_tx,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  },
};

// ============================================
// WEBHOOK
// ============================================

export const webhookDb = {
  async create(wh: any) {
    return insert("webhooks", {
      id: wh.id, url: wh.url, events: wh.events, secret: wh.secret,
      status: wh.status, fail_count: wh.failCount,
      metadata: wh.metadata, created_at: wh.createdAt,
    });
  },

  async get(id: string) {
    return getById<any>("webhooks", id);
  },

  async update(id: string, updates: Record<string, any>) {
    const mapped: Record<string, any> = {};
    if ("lastTriggered" in updates) mapped.last_triggered = updates.lastTriggered;
    if ("status" in updates) mapped.status = updates.status;
    if ("failCount" in updates) mapped.fail_count = updates.failCount;
    await update("webhooks", id, mapped);
  },

  async delete(id: string) {
    return deleteById("webhooks", id);
  },

  async list(statusFilter?: string | null) {
    let query = supabase.from("webhooks").select("*");
    if (statusFilter) query = query.eq("status", statusFilter);
    const { data, error } = await query;
    if (error) throw new Error(`DB list webhooks: ${error.message}`);
    return data || [];
  },
};

// ============================================
// CRON JOBS
// ============================================

export const cronDb = {
  async create(job: any) {
    return insert("cron_jobs", {
      id: job.id, action: job.action, schedule: job.schedule,
      payload: job.payload, status: job.status,
      next_run: job.nextRun, run_count: job.runCount,
      max_runs: job.maxRuns || null, metadata: job.metadata,
      created_at: job.createdAt,
    });
  },

  async get(id: string) {
    return getById<any>("cron_jobs", id);
  },

  async update(id: string, updates: Record<string, any>) {
    const mapped: Record<string, any> = {};
    if ("status" in updates) mapped.status = updates.status;
    if ("lastRun" in updates) mapped.last_run = updates.lastRun;
    if ("nextRun" in updates) mapped.next_run = updates.nextRun;
    if ("runCount" in updates) mapped.run_count = updates.runCount;
    await update("cron_jobs", id, mapped);
  },

  async list(statusFilter?: string | null, actionFilter?: string | null) {
    let query = supabase.from("cron_jobs").select("*");
    if (statusFilter) query = query.eq("status", statusFilter);
    if (actionFilter) query = query.eq("action", actionFilter);
    const { data, error } = await query;
    if (error) throw new Error(`DB list cron_jobs: ${error.message}`);
    return data || [];
  },
};

// ============================================
// AUTH SESSIONS
// ============================================

export const authDb = {
  async create(session: any) {
    return insert("auth_sessions", {
      id: session.id, address: session.address, token: session.token,
      permissions: session.permissions, expires_at: session.expiresAt,
      last_used: session.lastUsed, metadata: session.metadata,
      created_at: session.createdAt,
    });
  },

  async getByToken(token: string) {
    const { data, error } = await supabase.from("auth_sessions").select("*").eq("token", token).single();
    if (error && error.code === "PGRST116") return null;
    if (error) throw new Error(`DB get auth_sessions: ${error.message}`);
    return data;
  },

  async update(id: string, updates: Record<string, any>) {
    const mapped: Record<string, any> = {};
    if ("lastUsed" in updates) mapped.last_used = updates.lastUsed;
    await update("auth_sessions", id, mapped);
  },

  async deleteByToken(token: string) {
    const { error } = await supabase.from("auth_sessions").delete().eq("token", token);
    if (error) throw new Error(`DB delete auth_sessions: ${error.message}`);
    return true;
  },
};

// ============================================
// AUDIT LOG
// ============================================

export const auditDb = {
  async create(entry: any) {
    return insert("audit_log", {
      id: entry.id, action: entry.action, actor: entry.actor,
      resource: entry.resource, details: entry.details,
      tx_hash: entry.txHash, ip: entry.ip, created_at: entry.timestamp,
    });
  },

  async query(filters: { actor?: string; action?: string; resource?: string; since?: string; until?: string; limit?: number }) {
    let query = supabase.from("audit_log").select("*");
    if (filters.actor) query = query.ilike("actor", filters.actor);
    if (filters.action) query = query.eq("action", filters.action);
    if (filters.resource) query = query.ilike("resource", `%${filters.resource}%`);
    if (filters.since) query = query.gte("created_at", filters.since);
    if (filters.until) query = query.lte("created_at", filters.until);
    query = query.order("created_at", { ascending: false }).limit(filters.limit || 50);
    const { data, error } = await query;
    if (error) throw new Error(`DB query audit_log: ${error.message}`);
    return (data || []).map((row: any) => ({
      id: row.id, action: row.action, actor: row.actor,
      resource: row.resource, details: row.details,
      txHash: row.tx_hash, ip: row.ip, timestamp: row.created_at,
    }));
  },
};

// ============================================
// KYC RECORDS
// ============================================

export const kycDb = {
  async create(record: any) {
    return insert("kyc_records", {
      id: record.id, type: record.type, address: record.address,
      status: record.status, level: record.level, checks: record.checks,
      completed_at: record.completedAt || null,
      expires_at: record.expiresAt || null, metadata: record.metadata,
      created_at: record.createdAt,
    });
  },

  async get(id: string) {
    return getById<any>("kyc_records", id);
  },

  async getByAddress(address: string) {
    const { data, error } = await supabase.from("kyc_records").select("*")
      .ilike("address", address).order("created_at", { ascending: false }).limit(1).single();
    if (error && error.code === "PGRST116") return null;
    if (error) throw new Error(`DB get kyc by address: ${error.message}`);
    return data;
  },

  async update(id: string, updates: Record<string, any>) {
    const mapped: Record<string, any> = {};
    if ("status" in updates) mapped.status = updates.status;
    if ("checks" in updates) mapped.checks = updates.checks;
    if ("completedAt" in updates) mapped.completed_at = updates.completedAt;
    await update("kyc_records", id, mapped);
  },
};

// ============================================
// TAX REPORTS
// ============================================

export const taxDb = {
  async create(reportId: string, events: any[], summary: any) {
    return insert("tax_reports", {
      id: reportId, events, summary, created_at: new Date().toISOString(),
    });
  },

  async get(reportId: string) {
    return getById<any>("tax_reports", reportId);
  },

  async listIds() {
    const { data, error } = await supabase.from("tax_reports").select("id, events").order("created_at", { ascending: false });
    if (error) throw new Error(`DB list tax_reports: ${error.message}`);
    return (data || []).map((row: any) => ({
      reportId: row.id, transactions: Array.isArray(row.events) ? row.events.length : 0,
    }));
  },
};

// ============================================
// LOGS
// ============================================

export const logsDb = {
  async ingest(entries: any[]) {
    const rows = entries.map((e: any) => ({
      id: e.id, level: e.level, service: e.service,
      message: e.message, data: e.data || {},
      created_at: e.timestamp || new Date().toISOString(),
    }));
    const { error } = await supabase.from("logs").insert(rows);
    if (error) throw new Error(`DB ingest logs: ${error.message}`);
    return rows.map((r: any) => r.id);
  },

  async query(filters: { service?: string; level?: string; since?: string; limit?: number }) {
    let query = supabase.from("logs").select("*");
    if (filters.service) query = query.eq("service", filters.service);
    if (filters.level) query = query.eq("level", filters.level);
    if (filters.since) query = query.gte("created_at", filters.since);
    query = query.order("created_at", { ascending: false }).limit(filters.limit || 50);
    const { data, error } = await query;
    if (error) throw new Error(`DB query logs: ${error.message}`);
    return (data || []).map((row: any) => ({
      id: row.id, level: row.level, service: row.service,
      message: row.message, data: row.data, timestamp: row.created_at,
    }));
  },
};

export default supabase;
