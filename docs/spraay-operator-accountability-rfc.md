# Spraay Operator Accountability Layer — Design RFC

**Version:** 0.1.0 (Draft)
**Author:** @plagtech
**Date:** March 29, 2026
**Context:** [NVIDIA/NemoClaw#625](https://github.com/NVIDIA/NemoClaw/issues/625) — Operator-side payment authorization for AI agent sandboxes

---

## Summary

This document specifies an operator accountability layer for the Spraay x402 Gateway. It introduces a three-phase payment lifecycle — `payment_required → payment_approval → payment_receipt` — that gives operators visibility and control over agent spending before transactions execute on-chain.

The goal: any NemoClaw operator (or any agent framework operator) knows **who authorized** every payment, **what was spent**, and **on which tool**, with a durable per-call audit trail.

---

## Problem

Spraay's gateway currently solves the **agent execution side** — an agent hits `gateway.spraay.app/v1/batch/execute`, pays via x402, and gets encoded calldata back. What's missing:

- **No operator attribution.** The gateway doesn't track *who* authorized a payment. Session keys enforce spending limits, but the authorizing principal isn't surfaced.
- **No per-call receipts.** The gateway returns a transaction object but doesn't bundle it into a structured receipt with operator, tool, amount, and correlation tracking.
- **No fail-closed gate.** If an agent wallet submits a batch payment request without operator authorization, the gateway still processes it. There's no mechanism to pause and require approval.

For sandboxes where agents can spawn sub-agents and hire robots (e.g., NemoClaw, RTP), this distinction matters. The operator needs to know which agent spent what, on which Spraay tool, before it happened — not after.

---

## Design

### Three-Phase Payment Lifecycle

```
┌─────────────────────┐
│  1. payment_required │  Agent declares intent. authorized_by = null.
│                      │  Gateway returns a correlation_id and rejects
│                      │  execution until operator approval arrives.
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  2. payment_approval │  Operator resolves authorization.
│                      │  Threshold check: if amount < session cap,
│                      │  auto-approve. If above, checkpoint.
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  3. payment_receipt  │  Gateway executes. Returns structured receipt
│                      │  with tx_hash, amount, chain, tool,
│                      │  authorized_by, and correlation_id.
└─────────────────────┘
```

### Behavior Modes

| Scenario | Behavior |
|----------|----------|
| No `agent_wallet` in request | Current behavior. No gate, no receipt. Backward compatible. |
| `agent_wallet` present, `authorized_by` present | Execute immediately. Return `payment_receipt`. |
| `agent_wallet` present, `authorized_by` null/missing | **Fail-closed.** Return `payment_required` with `correlation_id`. Do not execute. |
| Amount below session-key spend cap | Auto-approve (operator can configure autonomous threshold). |
| Amount above session-key spend cap | Require explicit `payment_approval` before execution. |

---

## Schema Changes

### Request: `POST /api/v1/batch/execute`

New optional fields (backward compatible — omitting them preserves current behavior):

```typescript
interface BatchExecuteRequest {
  // Existing fields
  token: string;            // "USDC" | "ETH" | "0x..."
  recipients: Array<{
    address: string;
    amount: string;
  }>;
  sender?: string;

  // NEW: Operator accountability fields
  agent_wallet?: string;     // Agent wallet address (triggers accountability flow)
  authorized_by?: string;    // Operator principal, e.g. "operator:alice"
  correlation_id?: string;   // Client-generated UUID linking required → approval → receipt
  session_id?: string;       // Optional session identifier for grouping
}
```

### Response: `payment_required` (fail-closed)

Returned when `agent_wallet` is present but `authorized_by` is null or missing:

```json
{
  "status": "payment_required",
  "correlation_id": "req-001",
  "agent_wallet": "0xAgentWallet...",
  "tool": "spraay/batch_payment",
  "endpoint": "gateway.spraay.app/v1/batch/execute",
  "amount_usd": 0.03,
  "token": "USDC",
  "chain": "base",
  "recipient_count": 5,
  "requires": "authorized_by field must be set to an operator principal",
  "session_spend_remaining": "47.50",
  "auto_approve_threshold": "50.00"
}
```

### Response: `payment_receipt` (after approval)

Returned when execution succeeds with operator attribution:

```json
{
  "status": "payment_receipt",
  "correlation_id": "req-001",
  "tool": "spraay/batch_payment",
  "amount_usd": 0.03,
  "token": {
    "symbol": "USDC",
    "address": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "decimals": 6
  },
  "chain": "base",
  "chain_id": 8453,
  "authorized_by": "operator:alice",
  "session_id": "claw-session-abc123",
  "agent_wallet": "0xAgentWallet...",
  "transaction": {
    "to": "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    "data": "0x...",
    "value": "0",
    "tx_hash": "0xabc..."
  },
  "batch": {
    "recipient_count": 5,
    "total_amount": "50.00",
    "fee": "0.15",
    "fee_percent": "0.3%"
  },
  "timestamp": "2026-03-29T15:30:00Z"
}
```

---

## Database: `payment_receipts` Table (Supabase)

```sql
CREATE TABLE payment_receipts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  correlation_id  TEXT NOT NULL,
  authorized_by   TEXT NOT NULL,
  agent_wallet    TEXT NOT NULL,
  tool            TEXT NOT NULL DEFAULT 'spraay/batch_payment',
  endpoint        TEXT NOT NULL,
  amount_usd      NUMERIC(12,4),
  token_symbol    TEXT,
  token_address   TEXT,
  chain           TEXT DEFAULT 'base',
  chain_id        INTEGER DEFAULT 8453,
  recipient_count INTEGER,
  tx_data         JSONB,
  tx_hash         TEXT,
  session_id      TEXT,
  status          TEXT DEFAULT 'completed',
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- Indexes for operator queries
CREATE INDEX idx_receipts_correlation ON payment_receipts(correlation_id);
CREATE INDEX idx_receipts_authorized  ON payment_receipts(authorized_by);
CREATE INDEX idx_receipts_wallet      ON payment_receipts(agent_wallet);
CREATE INDEX idx_receipts_session     ON payment_receipts(session_id);
```

---

## Implementation Plan

### Phase 1: Schema + Gate (Minimal Viable)

**Files changed:**
- `routes/batch-payments.ts` — Add `agent_wallet`, `authorized_by`, `correlation_id` to request parsing. Add fail-closed gate logic before calldata encoding.
- `db.ts` — Add `paymentReceiptDb` section with `create()` and `query()` methods.

**Effort:** ~1 day

**What it delivers:** Any agent framework can send `agent_wallet` + `authorized_by` and get structured receipts back. Omitting those fields preserves current behavior for all existing callers.

### Phase 2: Session-Key Threshold Integration

**Files changed:**
- `routes/batch-payments.ts` — Before returning `payment_required`, check the agent wallet's session key spend remaining. If the payment amount is below the remaining cap, auto-approve and set `authorized_by` to `session_key:<address>`.
- `routes/agent-wallet.ts` — Add a helper to query session key info by wallet address.

**Effort:** ~1 day

**What it delivers:** Autonomous execution below operator-configured thresholds, checkpoint above. The dual mode hermesnousagent proposed.

### Phase 3: Reusable Middleware

**New file:** `middleware/operator-gate.ts`

Extract the fail-closed logic into Express middleware that can sit in front of any paid endpoint (not just batch payments). This lets escrow, payroll, bridge, and swap endpoints all participate in the operator accountability flow.

**Effort:** ~0.5 day

### Phase 4: Receipt Query Endpoint

**New route:** `GET /api/v1/receipts`

Query params: `correlation_id`, `authorized_by`, `agent_wallet`, `session_id`, `since`, `limit`.

Returns paginated receipts for operator dashboards and audit.

**Effort:** ~0.5 day

---

## Compatibility

- **Fully backward compatible.** All new fields are optional. Existing callers that don't send `agent_wallet` get identical behavior to today.
- **x402 layer unchanged.** The operator accountability gate sits *inside* the route handler, after x402 payment clears. The x402 payment middleware in `index.ts` is not modified.
- **MCP server update.** The `@plagtech/spraay-x402-mcp` Smithery package will need updated tool descriptions to document the new fields, but existing tool calls continue to work.

---

## Relation to Existing Infrastructure

| Component | Role in This Design |
|-----------|-------------------|
| Agent Wallet (Category 17) | Provides wallet address + session key spend limits |
| Session Keys (`session_keys` table) | Source of truth for autonomous spending thresholds |
| Audit Log (`audit_log` table) | Can cross-reference with `payment_receipts` for full trace |
| Webhook system | Future: notify operators when `payment_required` is triggered |
| RTP (Category 15) | Robot task payments will use the same accountability flow |

---

## Open Questions

1. **Should `payment_required` responses be persisted?** Currently spec'd as stateless (the gateway returns the response and forgets). Persisting them would let operators see pending requests in a dashboard but adds complexity.

2. **Multi-chain receipts.** This spec assumes Base. When agents execute batch payments on Ethereum, Arbitrum, Polygon, etc., the receipt schema works as-is (chain + chain_id fields) but session-key validation only works for Base agent wallets today.

3. **Operator identity format.** The spec uses `"operator:alice"` as a convention. Should this be an Ethereum address, an ENS name, an email, or freeform? Freeform is simplest but makes cross-system correlation harder.

4. **NemoClaw integration surface.** Is the expectation that NemoClaw calls Spraay's gateway directly, or does Bit-Chat's skill layer sit in between? The answer affects whether the `payment_approval` step happens inside Spraay or upstream.

---

## References

- [NVIDIA/NemoClaw#625](https://github.com/NVIDIA/NemoClaw/issues/625) — Original feature request
- [hermesnousagent comment](https://github.com/NVIDIA/NemoClaw/issues/625) — Operator-side accountability proposal
- [Bit-Chat skill layer](https://bit-chat.me/skill.md?ref=github-nvidia-nemoclaw-x402) — Reference implementation of payment_required/approval/receipt pattern
- [Spraay Gateway Docs](https://docs.spraay.app) — Current API documentation
- [Agent Wallet Factory](https://basescan.org/address/0xFBD832Db6D9a05A0434cd497707a1bDC43389CfD) — Base mainnet contract
- [Spraay Batch Contract](https://basescan.org/address/0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC) — Base mainnet contract
