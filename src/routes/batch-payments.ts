import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// ============ Contract ============

const SPRAAY_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
const SPRAAY_FEE_BPS = 30; // 0.3% flat for everything

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
    const { token: tokenInput = "USDC", recipients, sender } = req.body;

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

    // Build recipients
    const onchainRecipients = recipients.map((r: any) => ({
      recipient: r.address,
      amount: ethers.parseUnits(String(r.amount), token.decimals),
    }));

    let totalRaw = BigInt(0);
    for (const r of onchainRecipients) totalRaw += r.amount;

    const feeRaw = (totalRaw * BigInt(SPRAAY_FEE_BPS)) / BigInt(10000);
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

    return res.json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
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
    const { token: tokenInput = "USDC", recipients, recipientCount } = req.body;

    // Resolve token
    const token = resolveToken(tokenInput);

    // Support both detailed and simple estimate formats
    if (recipients && Array.isArray(recipients)) {
      let totalRaw = BigInt(0);
      for (const r of recipients) {
        totalRaw += ethers.parseUnits(String(r.amount), token.decimals);
      }

      const feeRaw = (totalRaw * BigInt(SPRAAY_FEE_BPS)) / BigInt(10000);

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
    return res.status(500).json({ error: err.message });
  }
}