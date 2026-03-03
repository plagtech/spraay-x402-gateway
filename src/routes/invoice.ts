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
// SUPPORTED INVOICE TOKENS
// ============================================

interface InvoiceToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

const INVOICE_TOKENS: Record<string, InvoiceToken> = {
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
  },
  USDT: {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
  },
  EURC: {
    address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol: "EURC",
    name: "Euro Coin",
    decimals: 6,
  },
  WETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
  },
};

// ============================================
// ABIs
// ============================================

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

// ============================================
// IN-MEMORY INVOICE STORE
// ============================================

interface Invoice {
  id: string;
  creator: string;
  recipient: string;
  token: InvoiceToken;
  amount: string;
  amountRaw: string;
  memo: string | null;
  reference: string | null;
  dueDate: string | null;
  status: "pending" | "paid" | "expired" | "cancelled";
  paymentTx: string | null;
  createdAt: string;
  updatedAt: string;
}

const invoiceStore: Map<string, Invoice> = new Map();

// ============================================
// HELPERS
// ============================================

function resolveInvoiceToken(input: string): InvoiceToken | null {
  const upper = input.toUpperCase();
  if (INVOICE_TOKENS[upper]) return INVOICE_TOKENS[upper];

  const lower = input.toLowerCase();
  for (const token of Object.values(INVOICE_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token;
  }
  return null;
}

function generateInvoiceId(): string {
  const bytes = randomBytes(8);
  return "INV-" + hexlify(bytes).slice(2).toUpperCase();
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * POST /api/v1/invoice/create
 *
 * Create a new invoice with payment instructions.
 *
 * Request body:
 *   creator:    string - Invoice creator address (who gets paid)
 *   recipient:  string - Who should pay (optional, open invoice if omitted)
 *   token:      string - Token symbol or address (USDC, USDT, DAI, EURC, WETH)
 *   amount:     string - Human-readable amount (e.g. "500.00")
 *   memo?:      string - Invoice description
 *   reference?: string - External reference (e.g. order ID, project name)
 *   dueDate?:   string - ISO date string for payment deadline
 */
export async function invoiceCreateHandler(req: Request, res: Response) {
  try {
    const { creator, recipient, token, amount, memo, reference, dueDate } = req.body;

    // ---- Validation ----
    if (!creator || !token || !amount) {
      return res.status(400).json({
        error: "Missing required fields",
        required: {
          creator: "string (payee wallet address)",
          token: "string (USDC, USDT, DAI, EURC, WETH or address)",
          amount: "string (human-readable, e.g. '500.00')",
        },
        optional: {
          recipient: "string (payer address — omit for open invoice)",
          memo: "string (invoice description)",
          reference: "string (external reference / order ID)",
          dueDate: "string (ISO date, e.g. '2026-04-01')",
        },
        example: {
          creator: "0xYourAddress",
          recipient: "0xClientAddress",
          token: "USDC",
          amount: "1500.00",
          memo: "Web development - March 2026",
          reference: "PRJ-2026-042",
          dueDate: "2026-04-15",
        },
      });
    }

    if (!isAddress(creator)) {
      return res.status(400).json({ error: "Invalid creator address" });
    }

    if (recipient && !isAddress(recipient)) {
      return res.status(400).json({ error: "Invalid recipient (payer) address" });
    }

    const tokenInfo = resolveInvoiceToken(token);
    if (!tokenInfo) {
      return res.status(400).json({
        error: `Unsupported token: ${token}`,
        supported: Object.keys(INVOICE_TOKENS),
      });
    }

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) {
      return res.status(400).json({ error: "Amount must be a positive number" });
    }

    // Validate due date if provided
    let dueDateISO: string | null = null;
    if (dueDate) {
      const parsed = new Date(dueDate);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ error: "Invalid dueDate format. Use ISO date (e.g. '2026-04-15')" });
      }
      dueDateISO = parsed.toISOString();
    }

    // ---- Generate invoice ----
    const invoiceId = generateInvoiceId();
    const amountRaw = parseUnits(amount, tokenInfo.decimals);
    const now = new Date().toISOString();

    const invoice: Invoice = {
      id: invoiceId,
      creator,
      recipient: recipient || "open",
      token: tokenInfo,
      amount,
      amountRaw: amountRaw.toString(),
      memo: memo || null,
      reference: reference || null,
      dueDate: dueDateISO,
      status: "pending",
      paymentTx: null,
      createdAt: now,
      updatedAt: now,
    };

    invoiceStore.set(invoiceId, invoice);

    // ---- Build payment transaction for the payer ----
    const erc20Iface = new Interface(ERC20_ABI);
    const transferCalldata = erc20Iface.encodeFunctionData("transfer", [
      creator,
      amountRaw,
    ]);

    trackRequest("invoice_create");

    return res.json({
      status: "created",
      invoice: {
        id: invoiceId,
        creator,
        recipient: recipient || "open (anyone can pay)",
        token: {
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          address: tokenInfo.address,
          decimals: tokenInfo.decimals,
        },
        amount,
        amountRaw: amountRaw.toString(),
        memo: memo || null,
        reference: reference || null,
        dueDate: dueDateISO,
        status: "pending",
      },
      payment: {
        transaction: {
          to: tokenInfo.address,
          data: transferCalldata,
          value: "0x0",
          chainId: CHAIN_ID,
          note: `Pay ${amount} ${tokenInfo.symbol} to ${creator}`,
        },
        instructions: [
          `1. Send ${amount} ${tokenInfo.symbol} to ${creator} on Base`,
          "2. Use the pre-encoded transaction above, or send directly via any wallet",
          `3. Check payment status: GET /api/v1/invoice/${invoiceId}`,
        ],
      },
      lookup: {
        endpoint: `GET /api/v1/invoice/${invoiceId}`,
        note: "Use this endpoint to check payment status",
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.5.0",
        endpoint: "POST /api/v1/invoice/create",
      },
      timestamp: now,
    });
  } catch (error: any) {
    console.error("Invoice create error:", error.message);
    return res.status(500).json({
      error: "Failed to create invoice",
      details: error.message,
    });
  }
}

/**
 * GET /api/v1/invoice/:id
 *
 * Look up an invoice by ID and check on-chain payment status.
 */
export async function invoiceGetHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ error: "Invoice ID is required" });
    }

    const invoice = invoiceStore.get((id as string).toUpperCase());
    if (!invoice) {
      return res.status(404).json({
        error: `Invoice not found: ${id}`,
        note: "Invoices are stored in-memory and may be lost on server restart",
      });
    }

    // Check on-chain if the creator received the payment
    let onChainCheck = null;
    if (invoice.status === "pending") {
      try {
        const provider = new JsonRpcProvider(RPC_URL);
        const erc20 = new Contract(invoice.token.address, ERC20_ABI, provider);
        const balance: bigint = await erc20.balanceOf(invoice.creator);
        const balanceFormatted = formatUnits(balance, invoice.token.decimals);

        onChainCheck = {
          creatorBalance: balanceFormatted,
          token: invoice.token.symbol,
          note: "Balance check only — full payment verification requires tx monitoring",
        };
      } catch {
        // Non-critical
      }

      // Check if expired
      if (invoice.dueDate && new Date(invoice.dueDate) < new Date()) {
        invoice.status = "expired";
        invoice.updatedAt = new Date().toISOString();
      }
    }

    trackRequest("invoice_get");

    return res.json({
      invoice: {
        id: invoice.id,
        creator: invoice.creator,
        recipient: invoice.recipient,
        token: {
          symbol: invoice.token.symbol,
          name: invoice.token.name,
          address: invoice.token.address,
        },
        amount: invoice.amount,
        amountRaw: invoice.amountRaw,
        memo: invoice.memo,
        reference: invoice.reference,
        dueDate: invoice.dueDate,
        status: invoice.status,
        paymentTx: invoice.paymentTx,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
      },
      onChainCheck,
      _gateway: {
        provider: "spraay-x402",
        version: "2.5.0",
        endpoint: `GET /api/v1/invoice/${id}`,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Invoice get error:", error.message);
    return res.status(500).json({
      error: "Failed to fetch invoice",
      details: error.message,
    });
  }
}

/**
 * GET /api/v1/invoice/list
 *
 * List invoices by creator or recipient address.
 *
 * Query params:
 *   address - Creator or recipient address to filter by
 *   status  - Optional: pending, paid, expired, cancelled
 */
export async function invoiceListHandler(req: Request, res: Response) {
  try {
    const { address, status } = req.query;

    if (!address) {
      return res.status(400).json({
        error: "address query param is required",
        example: "/api/v1/invoice/list?address=0xYour&status=pending",
      });
    }

    if (!isAddress(address as string)) {
      return res.status(400).json({ error: "Invalid address" });
    }

    const lowerAddress = (address as string).toLowerCase();
    const statusFilter = status ? (status as string).toLowerCase() : null;

    const results: any[] = [];

    for (const invoice of invoiceStore.values()) {
      const isCreator = invoice.creator.toLowerCase() === lowerAddress;
      const isRecipient = invoice.recipient.toLowerCase() === lowerAddress;

      if (!isCreator && !isRecipient) continue;
      if (statusFilter && invoice.status !== statusFilter) continue;

      results.push({
        id: invoice.id,
        role: isCreator ? "creator" : "payer",
        creator: invoice.creator,
        recipient: invoice.recipient,
        token: invoice.token.symbol,
        amount: invoice.amount,
        status: invoice.status,
        memo: invoice.memo,
        reference: invoice.reference,
        dueDate: invoice.dueDate,
        createdAt: invoice.createdAt,
      });
    }

    // Sort by creation date, newest first
    results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    trackRequest("invoice_list");

    return res.json({
      address,
      invoices: results,
      count: results.length,
      filters: {
        status: statusFilter || "all",
      },
      note: "Invoices are stored in-memory and may be lost on server restart. Production version will use persistent storage.",
      _gateway: {
        provider: "spraay-x402",
        version: "2.5.0",
        endpoint: "GET /api/v1/invoice/list",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Invoice list error:", error.message);
    return res.status(500).json({
      error: "Failed to list invoices",
      details: error.message,
    });
  }
}

