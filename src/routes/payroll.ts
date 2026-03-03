import { Request, Response } from "express";
import {
  JsonRpcProvider,
  Contract,
  Interface,
  isAddress,
  parseUnits,
  formatUnits,
} from "ethers";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;

// Spraay V2 contract on Base
const SPRAAY_V2 = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";

// Protocol fee: 0.3%
const PROTOCOL_FEE_BPS = 30;

// ============================================
// SUPPORTED PAYROLL TOKENS (stablecoins only)
// ============================================

interface PayrollToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  recommended: boolean;
}

const PAYROLL_TOKENS: Record<string, PayrollToken> = {
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    recommended: true,
  },
  USDT: {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    recommended: true,
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    recommended: false,
  },
  EURC: {
    address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol: "EURC",
    name: "Euro Coin",
    decimals: 6,
    recommended: false,
  },
  USDbC: {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    name: "USD Base Coin",
    decimals: 6,
    recommended: false,
  },
};

// ============================================
// ABIs
// ============================================

const SPRAAY_V2_ABI = [
  "function batchTransfer(address token, address[] calldata recipients, uint256[] calldata amounts) external",
  "function batchTransferETH(address[] calldata recipients, uint256[] calldata amounts) external payable",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// ============================================
// HELPERS
// ============================================

function resolvePayrollToken(input: string): PayrollToken | null {
  const upper = input.toUpperCase();
  if (PAYROLL_TOKENS[upper]) return PAYROLL_TOKENS[upper];

  const lower = input.toLowerCase();
  for (const token of Object.values(PAYROLL_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token;
  }
  return null;
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * POST /api/v1/payroll/execute
 *
 * Execute a payroll run via Spraay V2 batch payments.
 * Returns unsigned transactions (approval + batch transfer) ready to sign.
 *
 * Request body:
 *   token:      string   - Stablecoin symbol or address (USDC, USDT, DAI, EURC)
 *   sender:     string   - Employer/payer wallet address
 *   employees:  array    - Array of { address, amount, label? } objects
 *     address:  string   - Employee wallet address
 *     amount:   string   - Human-readable payment amount (e.g. "2500.00")
 *     label?:   string   - Optional label (e.g. "March salary", employee name)
 *   memo?:      string   - Optional payroll memo/reference
 */
export async function payrollExecuteHandler(req: Request, res: Response) {
  try {
    const { token, sender, employees, memo } = req.body;

    // ---- Validation ----
    if (!token || !sender || !employees) {
      return res.status(400).json({
        error: "Missing required fields",
        required: {
          token: "string (USDC, USDT, DAI, EURC, or token address)",
          sender: "string (employer wallet address)",
          employees: "array of { address, amount, label? }",
        },
        optional: { memo: "string (payroll reference)" },
        example: {
          token: "USDC",
          sender: "0xEmployerAddress",
          employees: [
            { address: "0xAlice", amount: "3000.00", label: "March salary" },
            { address: "0xBob", amount: "2500.00", label: "March salary" },
            { address: "0xCharlie", amount: "4000.00", label: "March salary + bonus" },
          ],
          memo: "March 2026 payroll",
        },
      });
    }

    // Resolve token
    const tokenInfo = resolvePayrollToken(token);
    if (!tokenInfo) {
      return res.status(400).json({
        error: `Unsupported payroll token: ${token}`,
        supported: Object.keys(PAYROLL_TOKENS),
        note: "Payroll supports stablecoins only for predictable payments",
      });
    }

    // Validate sender
    if (!isAddress(sender)) {
      return res.status(400).json({ error: "Invalid sender address" });
    }

    // Validate employees
    if (!Array.isArray(employees) || employees.length === 0) {
      return res.status(400).json({ error: "employees must be a non-empty array" });
    }

    if (employees.length > 200) {
      return res.status(400).json({
        error: `Too many employees: ${employees.length}. Maximum is 200 per batch.`,
        suggestion: "Split into multiple payroll runs",
      });
    }

    const recipients: string[] = [];
    const amounts: bigint[] = [];
    const breakdown: any[] = [];
    let totalRaw = 0n;

    for (let i = 0; i < employees.length; i++) {
      const emp = employees[i];

      if (!emp.address || !emp.amount) {
        return res.status(400).json({
          error: `Employee at index ${i} missing address or amount`,
          employee: emp,
        });
      }

      if (!isAddress(emp.address)) {
        return res.status(400).json({
          error: `Invalid address for employee at index ${i}: ${emp.address}`,
        });
      }

      const amountFloat = parseFloat(emp.amount);
      if (isNaN(amountFloat) || amountFloat <= 0) {
        return res.status(400).json({
          error: `Invalid amount for employee at index ${i}: ${emp.amount}`,
        });
      }

      const amountRaw = parseUnits(emp.amount, tokenInfo.decimals);
      recipients.push(emp.address);
      amounts.push(amountRaw);
      totalRaw += amountRaw;

      breakdown.push({
        index: i,
        address: emp.address,
        amount: emp.amount,
        amountRaw: amountRaw.toString(),
        label: emp.label || null,
      });
    }

    // Calculate protocol fee
    const protocolFee = (totalRaw * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
    const totalWithFee = totalRaw + protocolFee;

    // ---- Build transactions ----
    const spraayIface = new Interface(SPRAAY_V2_ABI);
    const erc20Iface = new Interface(ERC20_ABI);

    // Approval tx
    const approveCalldata = erc20Iface.encodeFunctionData("approve", [
      SPRAAY_V2,
      totalWithFee,
    ]);

    // Batch transfer tx
    const batchCalldata = spraayIface.encodeFunctionData("batchTransfer", [
      tokenInfo.address,
      recipients,
      amounts.map((a) => a.toString()),
    ]);

    // Gas estimation (rough: ~50k base + ~30k per recipient)
    const estimatedGas = 50000 + employees.length * 30000;

    // Check sender balance if possible
    let balanceCheck = null;
    try {
      const provider = new JsonRpcProvider(RPC_URL);
      const erc20 = new Contract(tokenInfo.address, ERC20_ABI, provider);
      const balance: bigint = await erc20.balanceOf(sender);
      const balanceFormatted = formatUnits(balance, tokenInfo.decimals);
      const sufficient = balance >= totalWithFee;

      balanceCheck = {
        balance: balanceFormatted,
        balanceRaw: balance.toString(),
        required: formatUnits(totalWithFee, tokenInfo.decimals),
        requiredRaw: totalWithFee.toString(),
        sufficient,
        shortfall: sufficient ? null : formatUnits(totalWithFee - balance, tokenInfo.decimals),
      };
    } catch {
      // Balance check is optional — don't fail the whole request
    }

    trackRequest("payroll_execute");

    return res.json({
      status: "ready",
      payroll: {
        token: {
          symbol: tokenInfo.symbol,
          name: tokenInfo.name,
          address: tokenInfo.address,
          decimals: tokenInfo.decimals,
        },
        sender,
        employeeCount: employees.length,
        totalAmount: formatUnits(totalRaw, tokenInfo.decimals),
        totalAmountRaw: totalRaw.toString(),
        protocolFee: formatUnits(protocolFee, tokenInfo.decimals),
        protocolFeeBps: PROTOCOL_FEE_BPS,
        totalWithFee: formatUnits(totalWithFee, tokenInfo.decimals),
        totalWithFeeRaw: totalWithFee.toString(),
        memo: memo || null,
      },
      breakdown,
      transactions: {
        approval: {
          to: tokenInfo.address,
          data: approveCalldata,
          value: "0x0",
          chainId: CHAIN_ID,
          note: `Approve Spraay V2 to spend ${formatUnits(totalWithFee, tokenInfo.decimals)} ${tokenInfo.symbol}`,
        },
        payroll: {
          to: SPRAAY_V2,
          data: batchCalldata,
          value: "0x0",
          chainId: CHAIN_ID,
          gasLimit: "0x" + estimatedGas.toString(16),
          note: `Batch payment to ${employees.length} employees via Spraay V2`,
        },
      },
      balanceCheck,
      instructions: [
        `1. Ensure you have ${formatUnits(totalWithFee, tokenInfo.decimals)} ${tokenInfo.symbol} (includes 0.3% protocol fee)`,
        "2. Sign and submit the approval transaction",
        "3. Sign and submit the payroll batch transaction",
        `4. All ${employees.length} employees will receive funds in a single transaction`,
      ],
      spraay: {
        contract: SPRAAY_V2,
        chain: "Base",
        chainId: CHAIN_ID,
        protocolFee: "0.3%",
        maxRecipients: 200,
        stablePayUrl: "https://stablepay.me",
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.4.0",
        endpoint: "POST /api/v1/payroll/execute",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Payroll execute error:", error.message);
    return res.status(500).json({
      error: "Failed to build payroll transactions",
      details: error.message,
    });
  }
}

/**
 * POST /api/v1/payroll/estimate
 *
 * Estimate gas costs for a payroll run.
 *
 * Request body:
 *   employeeCount: number - Number of employees
 *   token?:        string - Token symbol (optional, for fee calculation)
 *   totalAmount?:  string - Total payment amount (optional, for fee calculation)
 */
export async function payrollEstimateHandler(req: Request, res: Response) {
  try {
    const { employeeCount, token, totalAmount } = req.body;

    if (!employeeCount || typeof employeeCount !== "number" || employeeCount < 1) {
      return res.status(400).json({
        error: "employeeCount is required and must be a positive number",
        example: { employeeCount: 10, token: "USDC", totalAmount: "25000" },
      });
    }

    if (employeeCount > 200) {
      return res.status(400).json({
        error: `Maximum 200 employees per batch. You requested ${employeeCount}.`,
        suggestion: `Split into ${Math.ceil(employeeCount / 200)} payroll runs`,
      });
    }

    // Gas estimation
    const estimatedGas = 50000 + employeeCount * 30000;

    // Get current gas price
    let gasPriceGwei = "0.005"; // Base default
    let costETH = "0";
    let costUSD = "N/A";

    try {
      const provider = new JsonRpcProvider(RPC_URL);
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? 0n;
      gasPriceGwei = formatUnits(gasPrice, 9);
      const totalGasCost = gasPrice * BigInt(estimatedGas);
      costETH = formatUnits(totalGasCost, 18);
    } catch {
      // Use defaults
    }

    // Protocol fee calculation if amount provided
    let feeBreakdown = null;
    if (totalAmount && token) {
      const tokenInfo = resolvePayrollToken(token);
      if (tokenInfo) {
        const totalRaw = parseUnits(totalAmount, tokenInfo.decimals);
        const protocolFee = (totalRaw * BigInt(PROTOCOL_FEE_BPS)) / 10000n;
        feeBreakdown = {
          totalAmount: totalAmount,
          protocolFee: formatUnits(protocolFee, tokenInfo.decimals),
          protocolFeeBps: PROTOCOL_FEE_BPS,
          totalWithFee: formatUnits(totalRaw + protocolFee, tokenInfo.decimals),
          token: tokenInfo.symbol,
        };
      }
    }

    trackRequest("payroll_estimate");

    return res.json({
      estimate: {
        employeeCount,
        estimatedGas,
        gasPrice: gasPriceGwei + " gwei",
        estimatedCostETH: costETH,
        estimatedCostUSD: costUSD,
      },
      feeBreakdown,
      limits: {
        maxEmployees: 200,
        batchesNeeded: Math.ceil(employeeCount / 200),
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.4.0",
        endpoint: "POST /api/v1/payroll/estimate",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Payroll estimate error:", error.message);
    return res.status(500).json({
      error: "Failed to estimate payroll",
      details: error.message,
    });
  }
}

/**
 * GET /api/v1/payroll/tokens
 *
 * List supported stablecoins for payroll.
 */
export async function payrollTokensHandler(_req: Request, res: Response) {
  trackRequest("payroll_tokens");

  const tokens = Object.values(PAYROLL_TOKENS).map((t) => ({
    symbol: t.symbol,
    name: t.name,
    address: t.address,
    decimals: t.decimals,
    recommended: t.recommended,
  }));

  return res.json({
    tokens,
    tokenCount: tokens.length,
    recommended: tokens.filter((t) => t.recommended).map((t) => t.symbol),
    note: "Payroll uses stablecoins only for predictable, consistent payments",
    spraay: {
      contract: SPRAAY_V2,
      chain: "Base",
      chainId: CHAIN_ID,
      protocolFee: "0.3%",
      maxRecipients: 200,
      stablePayUrl: "https://stablepay.me",
    },
    _gateway: {
      provider: "spraay-x402",
      version: "2.4.0",
      endpoint: "GET /api/v1/payroll/tokens",
    },
    timestamp: new Date().toISOString(),
  });
}
