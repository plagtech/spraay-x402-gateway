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

export async function escrowCreateHandler(req: Request, res: Response) {
  try {
    const { depositor, beneficiary, token, amount, arbiter, description, conditions, expiresIn } = req.body;
    if (!depositor || !beneficiary || !token || !amount) {
      return res.status(400).json({
        error: "Missing required fields",
        required: { depositor: "string", beneficiary: "string", token: "string", amount: "string" },
        optional: { arbiter: "string", description: "string", conditions: "string[]", expiresIn: "number (hours, default 168)" },
        example: { depositor: "0xClient", beneficiary: "0xFreelancer", token: "USDC", amount: "5000.00", conditions: ["Design approved", "Dev complete"] },
      });
    }
    if (!isAddress(depositor)) return res.status(400).json({ error: "Invalid depositor address" });
    if (!isAddress(beneficiary)) return res.status(400).json({ error: "Invalid beneficiary address" });
    if (depositor.toLowerCase() === beneficiary.toLowerCase()) return res.status(400).json({ error: "Depositor and beneficiary cannot be the same" });
    if (arbiter && !isAddress(arbiter)) return res.status(400).json({ error: "Invalid arbiter address" });
    const tokenInfo = resolveEscrowToken(token);
    if (!tokenInfo) return res.status(400).json({ error: `Unsupported token: ${token}`, supported: Object.keys(ESCROW_TOKENS) });
    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) return res.status(400).json({ error: "Amount must be positive" });

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

    return res.json({
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
    });
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

    return res.json({
      status: "funded",
      escrow: { id: escrow.id, status: "funded", amount: escrow.amount, token: escrow.token.symbol, fundedAt: now, beneficiary: escrow.beneficiary },
      nextSteps: ["POST /api/v1/escrow/release with { escrowId, caller }", "POST /api/v1/escrow/cancel with { escrowId, caller }"],
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: now,
    });
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

    return res.json({
      status: "released",
      escrow: { id: escrow.id, status: "released", amount: escrow.amount, token: escrow.token.symbol, depositor: escrow.depositor, beneficiary: escrow.beneficiary, releasedBy: isDepositor ? "depositor" : "arbiter", releasedAt: now },
      transaction: { to: escrow.token.address, data: transferCalldata, value: "0x0", chainId: CHAIN_ID, signer: escrow.depositor },
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: now,
    });
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

    return res.json({
      status: "cancelled",
      escrow: { id: escrow.id, status: "cancelled", amount: escrow.amount, token: escrow.token.symbol, cancelledBy: isDepositor ? "depositor" : "arbiter", cancelledAt: now, wasFunded: escrow.fundedAt !== null },
      _gateway: { provider: "spraay-x402", version: "2.8.0" },
      timestamp: now,
    });
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
