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

// ============================================
// CONSTANTS
// ============================================

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;

// ============================================
// SUPPORTED TOKENS
// ============================================

interface EscrowToken {
  address: string;
  symbol: string;
  decimals: number;
}

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

// ============================================
// IN-MEMORY ESCROW STORE
// ============================================

type EscrowStatus = "created" | "funded" | "released" | "cancelled" | "disputed" | "expired";

interface Escrow {
  id: string;
  depositor: string;
  beneficiary: string;
  arbiter: string | null;
  token: EscrowToken;
  amount: string;
  amountRaw: string;
  description: string | null;
  conditions: string[];
  status: EscrowStatus;
  expiresAt: string | null;
  fundedAt: string | null;
  releasedAt: string | null;
  cancelledAt: string | null;
  releaseTxHash: string | null;
  createdAt: string;
  updatedAt: string;
}

const escrowStore: Map<string, Escrow> = new Map();

// ============================================
// HELPERS
// ============================================

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
  const bytes = randomBytes(8);
  return "ESC-" + hexlify(bytes).slice(2).toUpperCase();
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * POST /api/v1/escrow/create
 *
 * Create a new escrow agreement.
 *
 * Body:
 *   depositor:    string   - Who deposits funds
 *   beneficiary:  string   - Who receives funds on release
 *   token:        string   - Token symbol or address
 *   amount:       string   - Human-readable amount
 *   arbiter?:     string   - Optional third-party arbiter address
 *   description?: string   - What the escrow is for
 *   conditions?:  string[] - Release conditions (milestones)
 *   expiresIn?:   number   - Expiration in hours (default: 168 = 7 days)
 */
export async function escrowCreateHandler(req: Request, res: Response) {
  try {
    const { depositor, beneficiary, token, amount, arbiter, description, conditions, expiresIn } = req.body;

    if (!depositor || !beneficiary || !token || !amount) {
      return res.status(400).json({
        error: "Missing required fields",
        required: {
          depositor: "string (who deposits funds)",
          beneficiary: "string (who receives on release)",
          token: "string (USDC, USDT, DAI, EURC, WETH)",
          amount: "string (human-readable, e.g. '5000.00')",
        },
        optional: {
          arbiter: "string (third-party arbiter address)",
          description: "string (escrow purpose)",
          conditions: "string[] (release conditions / milestones)",
          expiresIn: "number (hours until expiry, default 168 = 7 days)",
        },
        example: {
          depositor: "0xClient",
          beneficiary: "0xFreelancer",
          token: "USDC",
          amount: "5000.00",
          arbiter: "0xMediator",
          description: "Website redesign project",
          conditions: ["Design mockups approved", "Development complete", "Final review passed"],
          expiresIn: 336,
        },
      });
    }

    if (!isAddress(depositor)) return res.status(400).json({ error: "Invalid depositor address" });
    if (!isAddress(beneficiary)) return res.status(400).json({ error: "Invalid beneficiary address" });
    if (depositor.toLowerCase() === beneficiary.toLowerCase()) {
      return res.status(400).json({ error: "Depositor and beneficiary cannot be the same address" });
    }
    if (arbiter && !isAddress(arbiter)) return res.status(400).json({ error: "Invalid arbiter address" });

    const tokenInfo = resolveEscrowToken(token);
    if (!tokenInfo) {
      return res.status(400).json({ error: `Unsupported token: ${token}`, supported: Object.keys(ESCROW_TOKENS) });
    }

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    const escrowId = generateEscrowId();
    const amountRaw = parseUnits(amount, tokenInfo.decimals);
    const now = new Date();
    const hours = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 168;
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();

    const escrow: Escrow = {
      id: escrowId,
      depositor,
      beneficiary,
      arbiter: arbiter || null,
      token: tokenInfo,
      amount,
      amountRaw: amountRaw.toString(),
      description: description || null,
      conditions: Array.isArray(conditions) ? conditions : [],
      status: "created",
      expiresAt,
      fundedAt: null,
      releasedAt: null,
      cancelledAt: null,
      releaseTxHash: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };

    escrowStore.set(escrowId, escrow);

    // Build funding transaction (depositor sends to a holding concept — in production this would be a smart contract)
    // For now, we encode a transfer to the gateway's pay-to address with escrow ID reference
    const erc20Iface = new Interface(ERC20_ABI);

    // In MVP, funding = transferring to the beneficiary address is held off until release
    // The escrow tracks state; actual fund custody would require a dedicated escrow contract
    // For now, we provide the deposit tx that the depositor would sign

    trackRequest("escrow_create");

    return res.json({
      status: "created",
      escrow: {
        id: escrowId,
        depositor,
        beneficiary,
        arbiter: arbiter || null,
        token: { symbol: tokenInfo.symbol, address: tokenInfo.address, decimals: tokenInfo.decimals },
        amount,
        amountRaw: amountRaw.toString(),
        description: description || null,
        conditions: escrow.conditions,
        status: "created",
        expiresAt,
        expiresInHours: hours,
      },
      actions: {
        fund: {
          endpoint: `POST /api/v1/escrow/${escrowId}/fund`,
          note: "Mark escrow as funded after depositor transfers tokens",
        },
        release: {
          endpoint: `POST /api/v1/escrow/${escrowId}/release`,
          note: "Release funds to beneficiary (depositor or arbiter only)",
        },
        cancel: {
          endpoint: `POST /api/v1/escrow/${escrowId}/cancel`,
          note: "Cancel escrow and return funds to depositor",
        },
        status: {
          endpoint: `GET /api/v1/escrow/${escrowId}`,
          note: "Check escrow status",
        },
      },
      instructions: [
        `1. Escrow ${escrowId} created for ${amount} ${tokenInfo.symbol}`,
        `2. Depositor (${depositor}) should transfer ${amount} ${tokenInfo.symbol} to fund the escrow`,
        `3. Once conditions are met, depositor or arbiter releases funds to beneficiary`,
        `4. Escrow expires ${hours} hours after creation if not funded/released`,
      ],
      _gateway: {
        provider: "spraay-x402",
        version: "2.7.0",
        endpoint: "POST /api/v1/escrow/create",
        note: "MVP uses in-memory tracking. Production will use on-chain escrow contract.",
      },
      timestamp: now.toISOString(),
    });
  } catch (error: any) {
    console.error("Escrow create error:", error.message);
    return res.status(500).json({ error: "Failed to create escrow", details: error.message });
  }
}

/**
 * GET /api/v1/escrow/:id
 *
 * Get escrow status and details.
 */
export async function escrowGetHandler(req: Request, res: Response) {
  try {
    const id = (req.params.id as string).toUpperCase();
    const escrow = escrowStore.get(id);

    if (!escrow) {
      return res.status(404).json({
        error: `Escrow not found: ${id}`,
        note: "Escrows are stored in-memory and may be lost on server restart",
      });
    }

    // Check expiration
    if (escrow.status === "created" || escrow.status === "funded") {
      if (escrow.expiresAt && new Date(escrow.expiresAt) < new Date()) {
        escrow.status = "expired";
        escrow.updatedAt = new Date().toISOString();
      }
    }

    // Check on-chain balance if funded
    let balanceCheck = null;
    if (escrow.status === "funded") {
      try {
        const provider = new JsonRpcProvider(RPC_URL);
        const erc20 = new Contract(escrow.token.address, ERC20_ABI, provider);
        const balance: bigint = await erc20.balanceOf(escrow.depositor);
        balanceCheck = {
          depositorBalance: formatUnits(balance, escrow.token.decimals),
          token: escrow.token.symbol,
        };
      } catch {
        // Non-critical
      }
    }

    trackRequest("escrow_get");

    return res.json({
      escrow: {
        id: escrow.id,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        arbiter: escrow.arbiter,
        token: { symbol: escrow.token.symbol, address: escrow.token.address },
        amount: escrow.amount,
        amountRaw: escrow.amountRaw,
        description: escrow.description,
        conditions: escrow.conditions,
        status: escrow.status,
        expiresAt: escrow.expiresAt,
        fundedAt: escrow.fundedAt,
        releasedAt: escrow.releasedAt,
        cancelledAt: escrow.cancelledAt,
        createdAt: escrow.createdAt,
        updatedAt: escrow.updatedAt,
      },
      balanceCheck,
      _gateway: { provider: "spraay-x402", version: "2.7.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Escrow get error:", error.message);
    return res.status(500).json({ error: "Failed to fetch escrow", details: error.message });
  }
}

/**
 * POST /api/v1/escrow/:id/fund
 *
 * Mark an escrow as funded.
 * Body: { txHash?: string }
 */
export async function escrowFundHandler(req: Request, res: Response) {
  try {
    const id = (req.params.id as string).toUpperCase();
    const escrow = escrowStore.get(id);

    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${id}` });
    if (escrow.status !== "created") {
      return res.status(400).json({ error: `Cannot fund escrow in status: ${escrow.status}. Must be 'created'.` });
    }

    // Check expiration
    if (escrow.expiresAt && new Date(escrow.expiresAt) < new Date()) {
      escrow.status = "expired";
      escrow.updatedAt = new Date().toISOString();
      return res.status(400).json({ error: "Escrow has expired" });
    }

    escrow.status = "funded";
    escrow.fundedAt = new Date().toISOString();
    escrow.updatedAt = new Date().toISOString();

    trackRequest("escrow_fund");

    return res.json({
      status: "funded",
      escrow: {
        id: escrow.id,
        status: escrow.status,
        amount: escrow.amount,
        token: escrow.token.symbol,
        fundedAt: escrow.fundedAt,
        beneficiary: escrow.beneficiary,
      },
      nextSteps: [
        "Conditions can now be fulfilled",
        `Release: POST /api/v1/escrow/${id}/release`,
        `Cancel: POST /api/v1/escrow/${id}/cancel`,
      ],
      _gateway: { provider: "spraay-x402", version: "2.7.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Escrow fund error:", error.message);
    return res.status(500).json({ error: "Failed to fund escrow", details: error.message });
  }
}

/**
 * POST /api/v1/escrow/:id/release
 *
 * Release escrowed funds to the beneficiary.
 * Returns unsigned transfer transaction.
 *
 * Body: { caller: string } — must be depositor or arbiter
 */
export async function escrowReleaseHandler(req: Request, res: Response) {
  try {
    const id = (req.params.id as string).toUpperCase();
    const { caller } = req.body;
    const escrow = escrowStore.get(id);

    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${id}` });
    if (escrow.status !== "funded") {
      return res.status(400).json({ error: `Cannot release escrow in status: ${escrow.status}. Must be 'funded'.` });
    }

    if (!caller || !isAddress(caller)) {
      return res.status(400).json({ error: "caller address is required in request body", example: { caller: "0xDepositorOrArbiter" } });
    }

    const callerLower = caller.toLowerCase();
    const isDepositor = callerLower === escrow.depositor.toLowerCase();
    const isArbiter = escrow.arbiter && callerLower === escrow.arbiter.toLowerCase();

    if (!isDepositor && !isArbiter) {
      return res.status(403).json({ error: "Only the depositor or arbiter can release funds" });
    }

    // Build release transaction (transfer from depositor to beneficiary)
    const erc20Iface = new Interface(ERC20_ABI);
    const transferCalldata = erc20Iface.encodeFunctionData("transfer", [
      escrow.beneficiary,
      BigInt(escrow.amountRaw),
    ]);

    escrow.status = "released";
    escrow.releasedAt = new Date().toISOString();
    escrow.updatedAt = new Date().toISOString();

    trackRequest("escrow_release");

    return res.json({
      status: "released",
      escrow: {
        id: escrow.id,
        status: escrow.status,
        amount: escrow.amount,
        token: escrow.token.symbol,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        releasedBy: isDepositor ? "depositor" : "arbiter",
        releasedAt: escrow.releasedAt,
      },
      transaction: {
        to: escrow.token.address,
        data: transferCalldata,
        value: "0x0",
        chainId: CHAIN_ID,
        note: `Transfer ${escrow.amount} ${escrow.token.symbol} from depositor to ${escrow.beneficiary}`,
        signer: escrow.depositor,
      },
      instructions: [
        `1. Depositor (${escrow.depositor}) signs the transfer transaction`,
        `2. ${escrow.amount} ${escrow.token.symbol} is sent to beneficiary (${escrow.beneficiary})`,
        "3. Escrow is now complete",
      ],
      _gateway: { provider: "spraay-x402", version: "2.7.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Escrow release error:", error.message);
    return res.status(500).json({ error: "Failed to release escrow", details: error.message });
  }
}

/**
 * POST /api/v1/escrow/:id/cancel
 *
 * Cancel an escrow and return funds to depositor.
 *
 * Body: { caller: string } — must be depositor or arbiter (if funded), depositor only (if created)
 */
export async function escrowCancelHandler(req: Request, res: Response) {
  try {
    const id = (req.params.id as string).toUpperCase();
    const { caller } = req.body;
    const escrow = escrowStore.get(id);

    if (!escrow) return res.status(404).json({ error: `Escrow not found: ${id}` });

    if (escrow.status !== "created" && escrow.status !== "funded") {
      return res.status(400).json({ error: `Cannot cancel escrow in status: ${escrow.status}` });
    }

    if (!caller || !isAddress(caller)) {
      return res.status(400).json({ error: "caller address is required", example: { caller: "0xDepositor" } });
    }

    const callerLower = caller.toLowerCase();
    const isDepositor = callerLower === escrow.depositor.toLowerCase();
    const isArbiter = escrow.arbiter && callerLower === escrow.arbiter.toLowerCase();

    // Only depositor can cancel unfunded escrow
    // Depositor or arbiter can cancel funded escrow
    if (escrow.status === "created" && !isDepositor) {
      return res.status(403).json({ error: "Only the depositor can cancel an unfunded escrow" });
    }
    if (escrow.status === "funded" && !isDepositor && !isArbiter) {
      return res.status(403).json({ error: "Only the depositor or arbiter can cancel a funded escrow" });
    }

    escrow.status = "cancelled";
    escrow.cancelledAt = new Date().toISOString();
    escrow.updatedAt = new Date().toISOString();

    trackRequest("escrow_cancel");

    return res.json({
      status: "cancelled",
      escrow: {
        id: escrow.id,
        status: escrow.status,
        amount: escrow.amount,
        token: escrow.token.symbol,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        cancelledBy: isDepositor ? "depositor" : "arbiter",
        cancelledAt: escrow.cancelledAt,
        wasFunded: escrow.fundedAt !== null,
      },
      note: escrow.fundedAt
        ? "Escrow was funded. Depositor retains their tokens (no on-chain transfer was made to escrow contract in MVP)."
        : "Escrow was not yet funded. No funds to return.",
      _gateway: { provider: "spraay-x402", version: "2.7.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Escrow cancel error:", error.message);
    return res.status(500).json({ error: "Failed to cancel escrow", details: error.message });
  }
}

/**
 * GET /api/v1/escrow/list
 *
 * List escrows by depositor, beneficiary, or arbiter address.
 *
 * Query: address, status? (optional filter)
 */
export async function escrowListHandler(req: Request, res: Response) {
  try {
    const { address, status } = req.query;

    if (!address || !isAddress(address as string)) {
      return res.status(400).json({
        error: "Valid address query param is required",
        example: "/api/v1/escrow/list?address=0xYour&status=funded",
      });
    }

    const lowerAddress = (address as string).toLowerCase();
    const statusFilter = status ? (status as string).toLowerCase() : null;

    const results: any[] = [];

    for (const escrow of escrowStore.values()) {
      const isDepositor = escrow.depositor.toLowerCase() === lowerAddress;
      const isBeneficiary = escrow.beneficiary.toLowerCase() === lowerAddress;
      const isArbiter = escrow.arbiter && escrow.arbiter.toLowerCase() === lowerAddress;

      if (!isDepositor && !isBeneficiary && !isArbiter) continue;
      if (statusFilter && escrow.status !== statusFilter) continue;

      let role = "unknown";
      if (isDepositor) role = "depositor";
      else if (isBeneficiary) role = "beneficiary";
      else if (isArbiter) role = "arbiter";

      results.push({
        id: escrow.id,
        role,
        depositor: escrow.depositor,
        beneficiary: escrow.beneficiary,
        token: escrow.token.symbol,
        amount: escrow.amount,
        status: escrow.status,
        description: escrow.description,
        conditions: escrow.conditions,
        expiresAt: escrow.expiresAt,
        createdAt: escrow.createdAt,
      });
    }

    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    trackRequest("escrow_list");

    return res.json({
      address,
      escrows: results,
      count: results.length,
      filters: { status: statusFilter || "all" },
      note: "Escrows are stored in-memory. Production will use on-chain escrow contracts.",
      _gateway: { provider: "spraay-x402", version: "2.7.0" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Escrow list error:", error.message);
    return res.status(500).json({ error: "Failed to list escrows", details: error.message });
  }
}
