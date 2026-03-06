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
import { invoiceDb } from "../db.js";

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;

interface InvoiceToken { address: string; symbol: string; name: string; decimals: number; }

const INVOICE_TOKENS: Record<string, InvoiceToken> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6 },
  USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", name: "Tether USD", decimals: 6 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", name: "Euro Coin", decimals: 6 },
  WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
};

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
];

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
  return "INV-" + hexlify(randomBytes(8)).slice(2).toUpperCase();
}

export async function invoiceCreateHandler(req: Request, res: Response) {
  try {
    const { creator, recipient, token, amount, memo, reference, dueDate } = req.body;

    if (!creator || !token || !amount) {
      return res.status(400).json({
        error: "Missing required fields",
        required: { creator: "string (payee wallet address)", token: "string (USDC, USDT, DAI, EURC, WETH or address)", amount: "string (human-readable, e.g. '500.00')" },
        optional: { recipient: "string (payer address)", memo: "string", reference: "string", dueDate: "string (ISO date)" },
        example: { creator: "0xYourAddress", recipient: "0xClientAddress", token: "USDC", amount: "1500.00", memo: "Web development - March 2026", reference: "PRJ-2026-042", dueDate: "2026-04-15" },
      });
    }

    if (!isAddress(creator)) return res.status(400).json({ error: "Invalid creator address" });
    if (recipient && !isAddress(recipient)) return res.status(400).json({ error: "Invalid recipient (payer) address" });

    const tokenInfo = resolveInvoiceToken(token);
    if (!tokenInfo) return res.status(400).json({ error: `Unsupported token: ${token}`, supported: Object.keys(INVOICE_TOKENS) });

    const amountFloat = parseFloat(amount);
    if (isNaN(amountFloat) || amountFloat <= 0) return res.status(400).json({ error: "Amount must be a positive number" });

    let dueDateISO: string | null = null;
    if (dueDate) {
      const parsed = new Date(dueDate);
      if (isNaN(parsed.getTime())) return res.status(400).json({ error: "Invalid dueDate format. Use ISO date (e.g. '2026-04-15')" });
      dueDateISO = parsed.toISOString();
    }

    const invoiceId = generateInvoiceId();
    const amountRaw = parseUnits(amount, tokenInfo.decimals);
    const now = new Date().toISOString();

    const invoice = {
      id: invoiceId, creator, recipient: recipient || "open", token: tokenInfo,
      amount, amountRaw: amountRaw.toString(), memo: memo || null,
      reference: reference || null, dueDate: dueDateISO,
      status: "pending", paymentTx: null, createdAt: now, updatedAt: now,
    };
    await invoiceDb.create(invoice);

    const erc20Iface = new Interface(ERC20_ABI);
    const transferCalldata = erc20Iface.encodeFunctionData("transfer", [creator, amountRaw]);
    trackRequest("invoice_create");

    return res.json({
      status: "created",
      invoice: {
        id: invoiceId, creator, recipient: recipient || "open (anyone can pay)",
        token: { symbol: tokenInfo.symbol, name: tokenInfo.name, address: tokenInfo.address, decimals: tokenInfo.decimals },
        amount, amountRaw: amountRaw.toString(), memo: memo || null,
        reference: reference || null, dueDate: dueDateISO, status: "pending",
      },
      payment: {
        transaction: { to: tokenInfo.address, data: transferCalldata, value: "0x0", chainId: CHAIN_ID, note: `Pay ${amount} ${tokenInfo.symbol} to ${creator}` },
        instructions: [
          `1. Send ${amount} ${tokenInfo.symbol} to ${creator} on Base`,
          "2. Use the pre-encoded transaction above, or send directly via any wallet",
          `3. Check payment status: GET /api/v1/invoice/${invoiceId}`,
        ],
      },
      lookup: { endpoint: `GET /api/v1/invoice/${invoiceId}`, note: "Use this endpoint to check payment status" },
      _gateway: { provider: "spraay-x402", version: "2.5.0", endpoint: "POST /api/v1/invoice/create" },
      timestamp: now,
    });
  } catch (error: any) {
    console.error("Invoice create error:", error.message);
    return res.status(500).json({ error: "Failed to create invoice", details: error.message });
  }
}

export async function invoiceGetHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    if (!id) return res.status(400).json({ error: "Invoice ID is required" });

    const invoice = await invoiceDb.get(id as string);
    if (!invoice) return res.status(404).json({ error: `Invoice not found: ${id}` });

    let onChainCheck = null;
    if (invoice.status === "pending") {
      try {
        const provider = new JsonRpcProvider(RPC_URL);
        const erc20 = new Contract(invoice.token.address, ERC20_ABI, provider);
        const balance: bigint = await erc20.balanceOf(invoice.creator);
        onChainCheck = { creatorBalance: formatUnits(balance, invoice.token.decimals), token: invoice.token.symbol, note: "Balance check only — full payment verification requires tx monitoring" };
      } catch { /* non-critical */ }

      if (invoice.dueDate && new Date(invoice.dueDate) < new Date()) {
        await invoiceDb.update(id as string, { status: "expired" });
        invoice.status = "expired";
      }
    }
    trackRequest("invoice_get");

    return res.json({
      invoice: {
        id: invoice.id, creator: invoice.creator, recipient: invoice.recipient,
        token: { symbol: invoice.token.symbol, name: invoice.token.name, address: invoice.token.address },
        amount: invoice.amount, amountRaw: invoice.amountRaw, memo: invoice.memo,
        reference: invoice.reference, dueDate: invoice.dueDate, status: invoice.status,
        paymentTx: invoice.paymentTx, createdAt: invoice.createdAt, updatedAt: invoice.updatedAt,
      },
      onChainCheck,
      _gateway: { provider: "spraay-x402", version: "2.5.0", endpoint: `GET /api/v1/invoice/${id}` },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Invoice get error:", error.message);
    return res.status(500).json({ error: "Failed to fetch invoice", details: error.message });
  }
}

export async function invoiceListHandler(req: Request, res: Response) {
  try {
    const { address, status } = req.query;
    if (!address) return res.status(400).json({ error: "address query param is required", example: "/api/v1/invoice/list?address=0xYour&status=pending" });
    if (!isAddress(address as string)) return res.status(400).json({ error: "Invalid address" });

    const statusFilter = status ? (status as string).toLowerCase() : null;
    const invoices = await invoiceDb.listByAddress(address as string, statusFilter);

    const lowerAddress = (address as string).toLowerCase();
    const results = invoices.map((inv: any) => ({
      id: inv.id, role: inv.creator.toLowerCase() === lowerAddress ? "creator" : "payer",
      creator: inv.creator, recipient: inv.recipient, token: inv.token.symbol,
      amount: inv.amount, status: inv.status, memo: inv.memo,
      reference: inv.reference, dueDate: inv.dueDate, createdAt: inv.createdAt,
    }));
    trackRequest("invoice_list");

    return res.json({
      address, invoices: results, count: results.length,
      filters: { status: statusFilter || "all" },
      _gateway: { provider: "spraay-x402", version: "2.5.0", endpoint: "GET /api/v1/invoice/list" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Invoice list error:", error.message);
    return res.status(500).json({ error: "Failed to list invoices", details: error.message });
  }
}
