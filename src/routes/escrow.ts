import { Request, Response } from "express";
import {
  JsonRpcProvider,
  Contract,
  Interface,
  isAddress,
  parseUnits,
  formatUnits,
  randomBytes,
  hexlify,
} from "ethers";
import { trackRequest } from "./health.js";
import { escrowDb } from "../db.js";

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;

interface EscrowToken { address: string; symbol: string; decimals: number; }

const ESCROW_TOKENS: Record<string, EscrowToken> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
};

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

function resolveEscrowToken(input: string): EscrowToken | null {
  const upper = input.toUpperCase();
  if (ESCROW_TOKENS[upper]) return ESCROW_TOKENS[upper];
  const lower = input.toLowerCase();
  for (const token of Object.values(ESCROW_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token;
  }
  return null;
}

function generateEscrowId(): string {
  return "ESC-" + hexlify(randomBytes(8)).slice(2).toUpperCase();
}

async function lookupEscrow(id: string) {
  if (!id) return null;
  const escrow = await escrowDb.get(id);
  if (!escrow) return null;
  // Check expiry
  if ((escrow.status === "created" || escrow.status === "funded") && escrow.expiresAt) {
    if (new Date(escrow.expiresAt) < new Date()) {
      await escrowDb.update(id, { status: "expired" });
      escrow.status = "expired";
    }
  }
  return escrow;
}

/**
 * Resolve the paying wallet from the request's x402 payment header.
 *
 * For the exact-EVM scheme the header is base64 JSON whose payload carries
 * the EIP-3009 authorization, and `authorization.from` is the payer. By the
 * time the route handler runs, @x402/express has already verified the
 * signature over this exact header (payment-verified branch), so the value
 * is trustworthy here. Non-EVM rails (Solana, MPP) don't match this shape
 * and return null — those callers keep passing depositor explicitly.
 */
function payerFromPaymentHeader(req: Request): string | null {
  const raw = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    const from =
      decoded?.payload?.authorization?.from ?? decoded?.authorization?.from;
    if (typeof from === "string" && isAddress(from)) return from;
  } catch {
    /* not a decodable EVM payment header */
  }
  return null;
}

// ---------------------------------------------------------------------------
// 💧 Create-body normalization + validation.
// Exported so escrowCreatePrecheck (pre-payment) and escrowCreateHandler
// (post-payment) share ONE definition of a valid body and can never disagree.
// ---------------------------------------------------------------------------

/**
 * Normalize tolerated input shapes into the canonical create body:
 *   - `conditions` given as a single string → wrapped as a one-item array
 *     (several published integrations send it this way; previously those
 *     conditions were silently dropped by the Array.isArray guard)
 *   - `condition` (singular string) → accepted as an alias for `conditions`
 * Unknown extra fields (e.g. `chain`) are left alone and ignored by the
 * handler exactly as before. Never throws; never rejects anything the
 * handler previously accepted.
 */
export function normalizeEscrowCreateBody(input: any): any {
  const body = { ...(input ?? {}) };
  if (typeof body.conditions === "string" && body.conditions.length > 0) {
    body.conditions = [body.conditions];
  }
  if (
    !Array.isArray(body.conditions) &&
    typeof body.condition === "string" &&
    body.condition.length > 0
  ) {
    body.conditions = [body.condition];
  }
  return body;
}

type EscrowCreateCheck =
  | { ok: true }
  | { ok: false; status: number; body: { error: string; [k: string]: any } };

/**
 * The create-body validation, verbatim from the handler. With
 * `allowMissingDepositor` (used by the pre-payment check, where the verified
 * payer identity does not exist yet), a missing depositor passes — but a
 * PRESENT depositor is still fully validated.
 */
export function validateEscrowCreateBody(
  body: any,
  opts: { allowMissingDepositor?: boolean } = {}
): EscrowCreateCheck {
  const { depositor, beneficiary, token, amount, arbiter } = body ?? {};
  const depositorRequired = !opts.allowMissingDepositor;

  if ((depositorRequired && !depositor) || !beneficiary || !token || !amount) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "Missing required fields",
        required: { depositor: "string", beneficiary: "string", token: "string", amount: "string" },
        optional: { arbiter: "string", description: "string", conditions: "string[]", expiresIn: "number (hours, default 168)" },
        note: "depositor may be omitted on a paid request; it then defaults to the paying wallet.",
        example: { depositor: "0xClient", beneficiary: "0xFreelancer", token: "USDC", amount: "5000.00", conditions: ["Design approved", "Dev complete"] },
      },
    };
  }
  if (depositor && !isAddress(depositor)) return { ok: false, status: 400, body: { error: "Invalid depositor address" } };
  if (!isAddress(beneficiary)) return { ok: false, status: 400, body: { error: "Invalid beneficiary address" } };
  if (depositor && depositor.toLowerCase() === beneficiary.toLowerCase()) {
    return { ok: false, status: 400, body: { error: "Depositor and beneficiary cannot be the same" } };
  }
  if (arbiter && !isAddress(arbiter)) return { ok: false, status: 400, body: { error: "Invalid arbiter address" } };
  const tokenInfo = resolveEscrowToken(token);
  if (!tokenInfo) return { ok: false, status: 400, body: { error: `Unsupported token: ${token}`, supported: Object.keys(ESCROW_TOKENS) } };
  const amountFloat = parseFloat(amount);
  if (isNaN(amountFloat) || amountFloat <= 0) return { ok: false, status: 400, body: { error: "Amount must be positive" } };

  return { ok: true };
}

export async function escrowCreateHandler(req: Request, res: Response) {
  try {
    const body = normalizeEscrowCreateBody(req.body);

    // Default a missing depositor to the wallet paying for this call,
    // read from the signature-verified x402 payment header. (The settlement
    // receipt can't be used here: @x402/express settles only AFTER the
    // handler succeeds, so no receipt exists yet at this point.)
    if (!body.depositor) {
      const payer = payerFromPaymentHeader(req);
      if (payer) {
        body.depositor = payer;
      }
    }

    const check = validateEscrowCreateBody(body);
    if (!check.ok) {
      return res.status(check.status).json(check.body);
    }

    const { depositor, beneficiary, token, amount, arbiter, description, conditions, expiresIn } = body;
    const tokenInfo = resolveEscrowToken(token)!;

    const escrowId = generateEscrowId();
    const amountRaw = parseUnits(amount, tokenInfo.decimals);
    const now = new Date();
    const hours = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 168;
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

    const escrow = {
      id: escrowId, depositor, beneficiary, arbiter: arbiter || null, token: tokenInfo,
      amount, amountRaw: amountRaw.toString(), description: description || null,
      conditions: Array.isArray(conditions) ? conditions : [], status: "created", expiresAt,
      fundedAt: null, releasedAt: null, cancelledAt: null, releaseTxHash: null,
      createdAt: now.toISOString(), updatedAt: now.toISOString(),
    };
    await escrowDb.create(escrow);
    trackRequest("escrow_create");

    const response: any = {
      status: "created",
      escrow: { id: escrowId, depositor, beneficiary, arbiter: arbiter || null, token: { symbol: tokenInfo.symbol, address: tokenInfo.address, decimals: tokenInfo.decimals }, amount, amountRaw: amountRaw.toString(), description: description || null, conditions: escrow.conditions, status: "created", expiresAt, expiresInHours: hours },
      actions: {
        fund: { endpoint: "POST /api/v1/escrow/fund", body: { escrowId } },
        release: { endpoint: "POST /api/v1/escrow/release", body: { escrowId, caller: depositor } },
        cancel: { endpoint: "POST /api/v1/escrow/cancel", body: { escrowId, caller: depositor } },
        status: { endpoint: `GET /api/v1/escrow/${escrowId}` },
      },
      _gateway: { provider: "spraay-x402", version: "2.8.0", endpoint: "POST /api/v1/escrow/create" },
      timestamp: now.toISOString(),
    };

    // 💧 Loop-native webhook callback
    if (req.webhookCallback) {
      response.webhook = await req.webhookCallback('escrow.created' as any, {
        escrow_id: escrowId, depositor, beneficiary, token: tokenInfo.symbol,
        amount, expires_at: expiresAt,
      });
    }

    return res.json(response);
  } catch (error: any) {
    console.error("Escrow create error:", error.message);
    return res.status(500).json({ error: "Failed to create escrow", details: error.message });
  }
}

export async function escrowGetHandler(req: Request, res: Response) {
  try {
    const id = (req.params.id as string).toUpperCase();
    const escrow = await lookupEscrow(id);
    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${id}` });

    let balanceCheck = null;
    if (escrow.status === "funded") {
      try {
        const provider = new JsonRpcProvider(RPC_URL);
        const erc20 = new Contract(escrow.token.address, ERC20_ABI, provider);
        const balance: bigint = await erc20.balanceOf(escrow.depositor);
        balanceCheck = { depositorBalance: formatUnits(balance, escrow.token.decimals), token: escrow.token.symbol };
      } catch { /* non-critical */ }
    }
    trackRequest("escrow_get");

    return res.json({
      escrow: { id: escrow.id, depositor: escrow.depositor, beneficiary: escrow.beneficiary, arbiter: escrow.arbiter, token: { symbol: escrow.token.symbol, address: escrow.token.address }, amount: escrow.amount, amountRaw: escrow.amountRaw, description: escrow.description, conditions: escrow.conditions, status: escrow.status, expiresAt: escrow.expiresAt, fundedAt: escrow.fundedAt, releasedAt: escrow.releasedAt, cancelledAt: escrow.cancelledAt, createdAt: escrow.createdAt, updatedAt: escrow.updatedAt },
      balanceCheck,
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch escrow", details: error.message });
  }
}

export async function escrowFundHandler(req: Request, res: Response) {
  try {
    const { escrowId } = req.body;
    if (!escrowId) return res.status(400).json({ error: "escrowId is required", example: { escrowId: "ESC-A1B2C3D4E5F6" } });
    const escrow = await lookupEscrow(escrowId);
    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${escrowId}` });
    if (escrow.status === "expired") return res.status(400).json({ error: "Escrow has expired" });
    if (escrow.status !== "created") return res.status(400).json({ error: `Cannot fund escrow in status: ${escrow.status}` });

    const now = new Date().toISOString();
    await escrowDb.update(escrowId, { status: "funded", fundedAt: now });
    trackRequest("escrow_fund");

    const response: any = {
      status: "funded",
      escrow: { id: escrow.id, status: "funded", amount: escrow.amount, token: escrow.token.symbol, fundedAt: now, beneficiary: escrow.beneficiary },
      nextSteps: ["POST /api/v1/escrow/release with { escrowId, caller }", "POST /api/v1/escrow/cancel with { escrowId, caller }"],
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: now,
    };

    // 💧 Loop-native webhook callback
    if (req.webhookCallback) {
      response.webhook = await req.webhookCallback('escrow.funded' as any, {
        escrow_id: escrow.id, amount: escrow.amount, token: escrow.token.symbol,
        beneficiary: escrow.beneficiary, funded_at: now,
      });
    }

    return res.json(response);
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fund escrow", details: error.message });
  }
}

export async function escrowReleaseHandler(req: Request, res: Response) {
  try {
    const { escrowId, caller } = req.body;
    if (!escrowId || !caller) return res.status(400).json({ error: "escrowId and caller are required", example: { escrowId: "ESC-A1B2", caller: "0xDepositor" } });
    const escrow = await lookupEscrow(escrowId);
    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${escrowId}` });
    if (escrow.status !== "funded") return res.status(400).json({ error: `Cannot release escrow in status: ${escrow.status}` });
    if (!isAddress(caller)) return res.status(400).json({ error: "Invalid caller address" });

    const callerLower = caller.toLowerCase();
    const isDepositor = callerLower === escrow.depositor.toLowerCase();
    const isArbiter = escrow.arbiter && callerLower === escrow.arbiter.toLowerCase();
    if (!isDepositor && !isArbiter) return res.status(403).json({ error: "Only depositor or arbiter can release" });

    const erc20Iface = new Interface(ERC20_ABI);
    const transferCalldata = erc20Iface.encodeFunctionData("transfer", [escrow.beneficiary, BigInt(escrow.amountRaw)]);

    const now = new Date().toISOString();
    await escrowDb.update(escrowId, { status: "released", releasedAt: now });
    trackRequest("escrow_release");

    const response: any = {
      status: "released",
      escrow: { id: escrow.id, status: "released", amount: escrow.amount, token: escrow.token.symbol, depositor: escrow.depositor, beneficiary: escrow.beneficiary, releasedBy: isDepositor ? "depositor" : "arbiter", releasedAt: now },
      transaction: { to: escrow.token.address, data: transferCalldata, value: "0x0", chainId: CHAIN_ID, signer: escrow.depositor },
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: now,
    };

    // 💧 Loop-native webhook callback
    if (req.webhookCallback) {
      response.webhook = await req.webhookCallback('escrow.released' as any, {
        escrow_id: escrow.id, amount: escrow.amount, token: escrow.token.symbol,
        beneficiary: escrow.beneficiary, released_by: isDepositor ? "depositor" : "arbiter",
        released_at: now,
      });
    }

    return res.json(response);
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to release escrow", details: error.message });
  }
}

export async function escrowCancelHandler(req: Request, res: Response) {
  try {
    const { escrowId, caller } = req.body;
    if (!escrowId || !caller) return res.status(400).json({ error: "escrowId and caller are required", example: { escrowId: "ESC-A1B2", caller: "0xDepositor" } });
    const escrow = await lookupEscrow(escrowId);
    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${escrowId}` });
    if (escrow.status !== "created" && escrow.status !== "funded") return res.status(400).json({ error: `Cannot cancel escrow in status: ${escrow.status}` });
    if (!isAddress(caller)) return res.status(400).json({ error: "Invalid caller address" });

    const callerLower = caller.toLowerCase();
    const isDepositor = callerLower === escrow.depositor.toLowerCase();
    const isArbiter = escrow.arbiter && callerLower === escrow.arbiter.toLowerCase();
    if (escrow.status === "created" && !isDepositor) return res.status(403).json({ error: "Only depositor can cancel unfunded escrow" });
    if (escrow.status === "funded" && !isDepositor && !isArbiter) return res.status(403).json({ error: "Only depositor or arbiter can cancel funded escrow" });

    const now = new Date().toISOString();
    await escrowDb.update(escrowId, { status: "cancelled", cancelledAt: now });
    trackRequest("escrow_cancel");

    const response: any = {
      status: "cancelled",
      escrow: { id: escrow.id, status: "cancelled", amount: escrow.amount, token: escrow.token.symbol, cancelledBy: isDepositor ? "depositor" : "arbiter", cancelledAt: now, wasFunded: escrow.fundedAt !== null },
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: now,
    };

    // 💧 Loop-native webhook callback
    if (req.webhookCallback) {
      response.webhook = await req.webhookCallback('escrow.disputed' as any, {
        escrow_id: escrow.id, amount: escrow.amount, token: escrow.token.symbol,
        cancelled_by: isDepositor ? "depositor" : "arbiter", was_funded: escrow.fundedAt !== null,
        cancelled_at: now,
      });
    }

    return res.json(response);
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to cancel escrow", details: error.message });
  }
}

export async function escrowListHandler(req: Request, res: Response) {
  try {
    const { address, status } = req.query;
    if (!address || !isAddress(address as string)) return res.status(400).json({ error: "Valid address required", example: "/api/v1/escrow/list?address=0x..." });
    const statusFilter = status ? (status as string).toLowerCase() : null;

    const escrows = await escrowDb.listByAddress(address as string, statusFilter);
    const results = escrows.map((e: any) => {
      const lowerAddress = (address as string).toLowerCase();
      const isDepositor = e.depositor.toLowerCase() === lowerAddress;
      const isBeneficiary = e.beneficiary.toLowerCase() === lowerAddress;
      return {
        id: e.id, role: isDepositor ? "depositor" : isBeneficiary ? "beneficiary" : "arbiter",
        depositor: e.depositor, beneficiary: e.beneficiary, token: e.token.symbol,
        amount: e.amount, status: e.status, description: e.description,
        expiresAt: e.expiresAt, createdAt: e.createdAt,
      };
    });
    trackRequest("escrow_list");

    return res.json({ address, escrows: results, count: results.length, filters: { status: statusFilter || "all" }, _gateway: { provider: "spraay-x402", version: "2.8.0" }, timestamp: new Date().toISOString() });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to list escrows", details: error.message });
  }
}
