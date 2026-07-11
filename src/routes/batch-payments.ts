import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// ============ Contract ============

const SPRAAY_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
export const SPRAAY_FEE_BPS = 30; // 0.3% flat for everything

// ============ Popular Tokens (Base Mainnet) ============
// Convenience lookup — any ERC-20 address works, these are just shortcuts

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

const BASE_TOKENS: Record<string, TokenInfo> = {
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
  },
  USDT: {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    decimals: 6,
  },
  EURC: {
    address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol: "EURC",
    decimals: 6,
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    decimals: 18,
  },
  WETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    decimals: 18,
  },
};

// Reverse lookup: address → symbol
const ADDRESS_TO_SYMBOL: Record<string, string> = {};
for (const [symbol, info] of Object.entries(BASE_TOKENS)) {
  ADDRESS_TO_SYMBOL[info.address.toLowerCase()] = symbol;
}

// ============ ABI ============

const SPRAAY_ABI = [
  {
    inputs: [
      {
        name: "recipients",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    name: "sprayETH",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      {
        name: "recipients",
        type: "tuple[]",
        components: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ],
    name: "sprayToken",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { name: "token", type: "address" },
      { name: "recipients", type: "address[]" },
      { name: "amountPerRecipient", type: "uint256" },
    ],
    name: "sprayEqual",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
];

const sprayInterface = new ethers.Interface(SPRAAY_ABI);

// ============ Token Resolution ============

/**
 * Resolve token input to address + decimals + symbol
 * Accepts: symbol ("USDC"), address ("0x..."), or "ETH" for native
 */
function resolveToken(tokenInput: string): {
  address: string;
  decimals: number;
  symbol: string;
  isETH: boolean;
} {
  if (!tokenInput || tokenInput.toUpperCase() === "ETH") {
    return {
      address: ethers.ZeroAddress,
      decimals: 18,
      symbol: "ETH",
      isETH: true,
    };
  }

  // Check by symbol
  const upper = tokenInput.toUpperCase();
  const known = BASE_TOKENS[upper];
  if (known) {
    return {
      address: known.address,
      decimals: known.decimals,
      symbol: known.symbol,
      isETH: false,
    };
  }

  // Check by address
  if (tokenInput.startsWith("0x") && tokenInput.length === 42) {
    const sym = ADDRESS_TO_SYMBOL[tokenInput.toLowerCase()] || "ERC20";
    const knownByAddr = Object.values(BASE_TOKENS).find(
      (t) => t.address.toLowerCase() === tokenInput.toLowerCase()
    );
    return {
      address: tokenInput,
      decimals: knownByAddr?.decimals || 18,
      symbol: sym,
      isETH: false,
    };
  }

  // Default: treat as unknown symbol, caller should provide address
  return {
    address: "",
    decimals: 18,
    symbol: tokenInput,
    isETH: false,
  };
}

// ============ Batch amount normalization ============

/** Thrown for bad batch input; handlers translate this to HTTP 400. */
class BatchInputError extends Error {
  readonly status = 400;
}

export interface NormalizedRecipient {
  recipient: string;
  amount: bigint; // raw base units
}

export interface ResolvedBatch {
  onchainRecipients: NormalizedRecipient[];
  totalRaw: bigint; // sum of all amounts, raw base units
}

/**
 * Normalize the two accepted body shapes into raw base-unit amounts.
 *
 * UNIT SEMANTICS DIFFER BY SHAPE — this is deliberate, and the shape is detected
 * from `typeof recipients[0]`:
 *
 *   • Flat format   — recipients: string[] (addresses), amounts: string[] in
 *                     RAW BASE UNITS. "310000" at 6dp = 0.31 USDC. Parsed with
 *                     BigInt directly — NO parseUnits (the client already scaled).
 *   • Legacy object — recipients: [{ address, amount }] where amount is a
 *                     HUMAN-DECIMAL string ("0.31"). Scaled with parseUnits.
 *
 * Both paths return raw base units, so every downstream calculation (totals,
 * fee, calldata, formatted response) is shape-agnostic from here on.
 */
export function resolveBatchAmounts(
  recipients: unknown,
  amounts: unknown,
  decimals: number
): ResolvedBatch {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BatchInputError("recipients array required");
  }

  const onchainRecipients: NormalizedRecipient[] = [];
  const first = recipients[0];

  if (typeof first === "string") {
    // ── Flat format: parallel amounts[] array, already in raw base units ──
    if (!Array.isArray(amounts) || amounts.length !== recipients.length) {
      throw new BatchInputError(
        "Flat format requires an 'amounts' array (raw base units) the same length as 'recipients'."
      );
    }
    for (let i = 0; i < recipients.length; i++) {
      const addr = recipients[i];
      if (typeof addr !== "string" || !addr) {
        throw new BatchInputError(`recipients[${i}] must be an address string.`);
      }
      let amount: bigint;
      try {
        amount = BigInt(String(amounts[i]));
      } catch {
        throw new BatchInputError(
          `amounts[${i}]="${amounts[i]}" is not a valid raw base-unit integer. ` +
            `Flat-format amounts are integers (e.g. "310000" = 0.31 at 6dp), not decimals.`
        );
      }
      if (amount < 0n) throw new BatchInputError(`amounts[${i}] must not be negative.`);
      onchainRecipients.push({ recipient: addr, amount });
    }
  } else if (first && typeof first === "object") {
    // ── Legacy object format: human-decimal amounts, scaled with parseUnits ──
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i] as { address?: unknown; amount?: unknown };
      if (typeof r.address !== "string" || !r.address) {
        throw new BatchInputError(`recipients[${i}].address is required.`);
      }
      if (r.amount === undefined || r.amount === null || r.amount === "") {
        throw new BatchInputError(`recipients[${i}].amount is required.`);
      }
      let amount: bigint;
      try {
        amount = ethers.parseUnits(String(r.amount), decimals);
      } catch {
        throw new BatchInputError(
          `recipients[${i}].amount="${r.amount}" is not a valid decimal amount.`
        );
      }
      onchainRecipients.push({ recipient: r.address, amount });
    }
  } else {
    throw new BatchInputError(
      "recipients must be an array of address strings (flat format) or {address, amount} objects (legacy format)."
    );
  }

  let totalRaw = 0n;
  for (const r of onchainRecipients) totalRaw += r.amount;

  return { onchainRecipients, totalRaw };
}

/** Spraay protocol fee (raw base units) for a raw total. Single source of truth. */
export function batchFee(totalRaw: bigint): bigint {
  return (totalRaw * BigInt(SPRAAY_FEE_BPS)) / BigInt(10000);
}

// ============ Handlers ============

/**
 * POST /api/v1/batch/execute
 *
 * Batch payment via Spraay V2 — any ERC-20 token or native ETH.
 *
 * Body:
 * {
 *   "token": "USDC" | "ETH" | "0x833589..." | "USDT" | "DAI" | etc,
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" },
 *     { "address": "0x456...", "amount": "25.50" }
 *   ],
 *   "sender": "0xYour..."   // for approval encoding
 * }
 *
 * Token defaults to USDC if not provided (backward compatible).
 */
export async function batchPaymentHandler(req: Request, res: Response) {
  trackRequest("/api/v1/batch/execute");
  try {
    const { token: tokenInput = "USDC", recipients, amounts, sender } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array required" });
    }
    if (recipients.length > 200) {
      return res.status(400).json({ error: "Maximum 200 recipients" });
    }

    // Resolve token
    const token = resolveToken(tokenInput);
    if (!token.isETH && !token.address) {
      return res.status(400).json({
        error: `Unknown token "${tokenInput}". Use a symbol (USDC, USDT, DAI, EURC, ETH) or a token contract address.`,
      });
    }

    // Normalize both accepted body shapes into raw base units (see resolveBatchAmounts).
    const { onchainRecipients, totalRaw } = resolveBatchAmounts(
      recipients,
      amounts,
      token.decimals
    );

    const feeRaw = batchFee(totalRaw);
    const totalWithFee = totalRaw + feeRaw;

    // Encode calldata
    let calldata: string;
    let txValue: string;

    if (token.isETH) {
      calldata = sprayInterface.encodeFunctionData("sprayETH", [
        onchainRecipients,
      ]);
      txValue = totalWithFee.toString();
    } else {
      calldata = sprayInterface.encodeFunctionData("sprayToken", [
        token.address,
        onchainRecipients,
      ]);
      txValue = "0";
    }

    const response: any = {
      success: true,
      contract: SPRAAY_CONTRACT,
      token: {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        isETH: token.isETH,
      },
      batch: {
        recipientCount: recipients.length,
        totalAmount: ethers.formatUnits(totalRaw, token.decimals),
        fee: ethers.formatUnits(feeRaw, token.decimals),
        feePercent: "0.3%",
        totalWithFee: ethers.formatUnits(totalWithFee, token.decimals),
      },
      transaction: {
        to: SPRAAY_CONTRACT,
        data: calldata,
        value: txValue,
        chainId: 8453,
      },
    };

    // ERC-20 tokens need approval
    if (!token.isETH) {
      response.approvalRequired = {
        token: token.address,
        spender: SPRAAY_CONTRACT,
        amount: totalWithFee.toString(),
        amountFormatted: ethers.formatUnits(totalWithFee, token.decimals),
      };
    }

    // 💧 Loop-native webhook callback
    if (req.webhookCallback) {
      const webhook = await req.webhookCallback('batch.created', {
        recipient_count: recipients.length,
        token: token.symbol,
        chain: 'base',
        total_amount: ethers.formatUnits(totalRaw, token.decimals),
        total_with_fee: ethers.formatUnits(totalWithFee, token.decimals),
        contract: SPRAAY_CONTRACT,
      });
      response.webhook = webhook;
    }
    return res.json(response);
  } catch (err: any) {
    const status = err?.status === 400 ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
}

/**
 * POST /api/v1/batch/estimate
 *
 * Estimate batch payment cost — any token or ETH.
 *
 * Body:
 * {
 *   "token": "USDC" | "ETH" | "0x...",
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" }
 *   ]
 * }
 *
 * Or simple format:
 * {
 *   "recipientCount": 5,
 *   "token": "USDC"
 * }
 */
export async function batchEstimateHandler(req: Request, res: Response) {
  trackRequest("/api/v1/batch/estimate");
  try {
    const { token: tokenInput = "USDC", recipients, amounts, recipientCount } = req.body;

    // Resolve token
    const token = resolveToken(tokenInput);

    // Detailed estimate: same normalization + fee math as the execute path,
    // so a quote can never disagree with what execute will charge.
    if (recipients && Array.isArray(recipients) && recipients.length > 0) {
      const { totalRaw } = resolveBatchAmounts(recipients, amounts, token.decimals);
      const feeRaw = batchFee(totalRaw);

      return res.json({
        success: true,
        token: {
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          isETH: token.isETH,
        },
        recipientCount: recipients.length,
        totalAmount: ethers.formatUnits(totalRaw, token.decimals),
        fee: ethers.formatUnits(feeRaw, token.decimals),
        feePercent: "0.3%",
        totalWithFee: ethers.formatUnits(totalRaw + feeRaw, token.decimals),
      });
    }

    // Simple format: just recipient count for gas estimation
    const count = recipientCount || 1;
    const baseGas = 50000;
    const perRecipientGas = token.isETH ? 30000 : 65000;
    const estimatedGas = baseGas + perRecipientGas * count;

    return res.json({
      success: true,
      token: {
        symbol: token.symbol,
        isETH: token.isETH,
      },
      recipientCount: count,
      feePercent: "0.3%",
      estimatedGas: estimatedGas.toString(),
      note: "Gas estimate is approximate. Provide recipients array for exact fee calculation.",
    });
  } catch (err: any) {
    const status = err?.status === 400 ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
}