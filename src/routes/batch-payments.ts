import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// ============ Contract Addresses ============

// V2 (legacy — still works, existing integrations untouched)
const SPRAAY_V2 = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";

// V3 (multi-stablecoin + CCIP receiver)
const SPRAAY_V3 = "0x3eFf027045230A277293aC27bd571FBC729e0dcE";

const SPRAAY_FEE_BPS = 30; // 0.3% default protocol fee

// ============ Token Registry (Base Mainnet) ============

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  feeBps: number; // 0 = use default (30 bps)
}

const BASE_TOKENS: Record<string, TokenInfo> = {
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    decimals: 6,
    feeBps: 0,
  },
  USDT: {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    decimals: 6,
    feeBps: 0,
  },
  EURC: {
    address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol: "EURC",
    decimals: 6,
    feeBps: 25, // 0.25% competitive EUR rate
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    decimals: 18,
    feeBps: 0,
  },
};

// ============ ABIs ============

// V2 ABI (backward compatible)
const SPRAAY_V2_ABI = [
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

// V3 ABI (adds sprayTokenWithMeta)
const SPRAAY_V3_ABI = [
  ...SPRAAY_V2_ABI,
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
      { name: "memo", type: "string" },
      { name: "agentId", type: "uint256" },
    ],
    name: "sprayTokenWithMeta",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
];

const v2Interface = new ethers.Interface(SPRAAY_V2_ABI);
const v3Interface = new ethers.Interface(SPRAAY_V3_ABI);

const BASE_RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(BASE_RPC);

// ============ V2 Handlers (existing — unchanged) ============

/**
 * POST /api/v1/batch/execute
 * Legacy USDC-only batch payment (V2 contract)
 */
export async function batchPaymentHandler(req: Request, res: Response) {
  trackRequest("/api/v1/batch/execute");
  try {
    const { recipients, memo } = req.body;
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array required" });
    }
    if (recipients.length > 200) {
      return res.status(400).json({ error: "Maximum 200 recipients" });
    }

    const BASE_USDC = BASE_TOKENS.USDC.address;
    const onchainRecipients = recipients.map((r: any) => ({
      recipient: r.address,
      amount: ethers.parseUnits(String(r.amount), 6),
    }));

    let totalRaw = BigInt(0);
    for (const r of onchainRecipients) totalRaw += r.amount;

    const feeRaw = (totalRaw * BigInt(SPRAAY_FEE_BPS)) / BigInt(10000);
    const totalWithFee = totalRaw + feeRaw;

    const calldata = v2Interface.encodeFunctionData("sprayToken", [
      BASE_USDC,
      onchainRecipients,
    ]);

    return res.json({
      success: true,
      contract: SPRAAY_V2,
      version: "v2",
      token: "USDC",
      tokenAddress: BASE_USDC,
      recipientCount: recipients.length,
      totalAmount: ethers.formatUnits(totalRaw, 6),
      fee: ethers.formatUnits(feeRaw, 6),
      totalWithFee: ethers.formatUnits(totalWithFee, 6),
      transaction: {
        to: SPRAAY_V2,
        data: calldata,
        value: "0",
        chainId: 8453,
      },
      approvalRequired: {
        token: BASE_USDC,
        spender: SPRAAY_V2,
        amount: totalWithFee.toString(),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/v1/batch/estimate
 * Legacy estimate (V2, USDC only)
 */
export async function batchEstimateHandler(req: Request, res: Response) {
  trackRequest("/api/v1/batch/estimate");
  try {
    const { recipients } = req.body;
    if (!recipients || !Array.isArray(recipients)) {
      return res.status(400).json({ error: "recipients array required" });
    }

    let totalRaw = BigInt(0);
    for (const r of recipients) {
      totalRaw += ethers.parseUnits(String(r.amount), 6);
    }

    const feeRaw = (totalRaw * BigInt(SPRAAY_FEE_BPS)) / BigInt(10000);

    return res.json({
      success: true,
      version: "v2",
      token: "USDC",
      recipientCount: recipients.length,
      totalAmount: ethers.formatUnits(totalRaw, 6),
      fee: ethers.formatUnits(feeRaw, 6),
      feePercent: "0.3%",
      totalWithFee: ethers.formatUnits(totalRaw + feeRaw, 6),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

// ============ V3 Handlers (new — multi-stablecoin) ============

/**
 * POST /api/v3/batch/execute
 *
 * Multi-stablecoin batch payment via SprayContractV3.
 * Supports USDC, USDT, EURC, DAI, or any ERC-20 by address.
 *
 * Body:
 * {
 *   "token": "USDC" | "USDT" | "EURC" | "DAI" | "0x...",
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" },
 *     { "address": "0x456...", "amount": "25.50" }
 *   ],
 *   "memo": "January contributor payments",    // optional
 *   "agentId": 42                              // ERC-8004 ID, optional
 * }
 */
export async function batchPaymentV3Handler(req: Request, res: Response) {
  trackRequest("/api/v3/batch/execute");
  try {
    const {
      token: tokenInput = "USDC",
      recipients,
      memo = "",
      agentId = 0,
    } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array required" });
    }
    if (recipients.length > 200) {
      return res.status(400).json({ error: "Maximum 200 recipients" });
    }

    // Resolve token
    let tokenAddress: string;
    let tokenDecimals: number;
    let tokenSymbol: string;
    let tokenFeeBps: number;

    if (tokenInput.startsWith("0x")) {
      tokenAddress = tokenInput;
      tokenDecimals = 18;
      tokenSymbol = "CUSTOM";
      tokenFeeBps = SPRAAY_FEE_BPS;
    } else {
      const symbol = tokenInput.toUpperCase();
      const info = BASE_TOKENS[symbol];
      if (!info) {
        return res.status(400).json({
          error: `Token ${symbol} not supported. Available: ${Object.keys(BASE_TOKENS).join(", ")}`,
        });
      }
      tokenAddress = info.address;
      tokenDecimals = info.decimals;
      tokenSymbol = info.symbol;
      tokenFeeBps = info.feeBps || SPRAAY_FEE_BPS;
    }

    // Build recipients
    const onchainRecipients = recipients.map((r: any) => ({
      recipient: r.address,
      amount: ethers.parseUnits(String(r.amount), tokenDecimals),
    }));

    let totalRaw = BigInt(0);
    for (const r of onchainRecipients) totalRaw += r.amount;

    const feeRaw = (totalRaw * BigInt(tokenFeeBps)) / BigInt(10000);
    const totalWithFee = totalRaw + feeRaw;

    // Encode — use sprayTokenWithMeta if memo or agentId provided
    let calldata: string;
    if (memo || agentId > 0) {
      calldata = v3Interface.encodeFunctionData("sprayTokenWithMeta", [
        tokenAddress,
        onchainRecipients,
        memo,
        agentId,
      ]);
    } else {
      calldata = v3Interface.encodeFunctionData("sprayToken", [
        tokenAddress,
        onchainRecipients,
      ]);
    }

    return res.json({
      success: true,
      contract: SPRAAY_V3,
      version: "v3",
      token: {
        symbol: tokenSymbol,
        address: tokenAddress,
        decimals: tokenDecimals,
      },
      batch: {
        recipientCount: recipients.length,
        totalAmount: ethers.formatUnits(totalRaw, tokenDecimals),
        fee: ethers.formatUnits(feeRaw, tokenDecimals),
        feePercent: `${tokenFeeBps / 100}%`,
        totalWithFee: ethers.formatUnits(totalWithFee, tokenDecimals),
      },
      transaction: {
        to: SPRAAY_V3,
        data: calldata,
        value: "0",
        chainId: 8453,
      },
      approvalRequired: {
        token: tokenAddress,
        spender: SPRAAY_V3,
        amount: totalWithFee.toString(),
        amountFormatted: ethers.formatUnits(totalWithFee, tokenDecimals),
      },
      meta: {
        memo: memo || null,
        agentId: agentId || null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/v3/batch/estimate
 * Multi-stablecoin fee estimation
 */
export async function batchEstimateV3Handler(req: Request, res: Response) {
  trackRequest("/api/v3/batch/estimate");
  try {
    const { token: tokenInput = "USDC", recipients } = req.body;

    if (!recipients || !Array.isArray(recipients)) {
      return res.status(400).json({ error: "recipients array required" });
    }

    // Resolve token
    const symbol = tokenInput.startsWith("0x")
      ? "CUSTOM"
      : tokenInput.toUpperCase();
    const info = BASE_TOKENS[symbol];
    const decimals = info?.decimals || 18;
    const feeBps = info?.feeBps || SPRAAY_FEE_BPS;

    let totalRaw = BigInt(0);
    for (const r of recipients) {
      totalRaw += ethers.parseUnits(String(r.amount), decimals);
    }

    const feeRaw = (totalRaw * BigInt(feeBps)) / BigInt(10000);

    return res.json({
      success: true,
      version: "v3",
      token: symbol,
      recipientCount: recipients.length,
      totalAmount: ethers.formatUnits(totalRaw, decimals),
      fee: ethers.formatUnits(feeRaw, decimals),
      feePercent: `${feeBps / 100}%`,
      totalWithFee: ethers.formatUnits(totalRaw + feeRaw, decimals),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/v3/tokens
 * List supported stablecoins with fee info (FREE endpoint)
 */
export function tokensHandler(_req: Request, res: Response) {
  trackRequest("/api/v3/tokens");

  const tokens = Object.entries(BASE_TOKENS).map(([symbol, info]) => ({
    symbol,
    address: info.address,
    decimals: info.decimals,
    feeBps: info.feeBps || SPRAAY_FEE_BPS,
    feePercent: `${(info.feeBps || SPRAAY_FEE_BPS) / 100}%`,
  }));

  return res.json({
    success: true,
    chain: "base",
    chainId: 8453,
    contract: SPRAAY_V3,
    defaultFeeBps: SPRAAY_FEE_BPS,
    tokens,
  });
}

/**
 * GET /api/v3/chains
 * List supported chains (FREE endpoint)
 */
export function chainsHandler(_req: Request, res: Response) {
  trackRequest("/api/v3/chains");

  return res.json({
    success: true,
    chains: [
      {
        name: "base",
        chainId: 8453,
        contract: SPRAAY_V3,
        tokens: ["USDC", "USDT", "EURC", "DAI"],
        ccipEnabled: true,
        version: "v3",
      },
      {
        name: "unichain",
        chainId: 130,
        contract: "0x08fA5D1c16CD6E2a16FC0E4839f262429959E073",
        tokens: ["USDC"],
        ccipEnabled: false,
        version: "v2",
      },
      {
        name: "bob",
        chainId: 60808,
        contract: "TBD",
        tokens: ["USDC"],
        ccipEnabled: false,
        version: "v2",
      },
      {
        name: "plasma",
        chainId: 1012,
        contract: "TBD",
        tokens: ["USDT0", "XPL"],
        ccipEnabled: false,
        version: "v2",
      },
      {
        name: "bittensor",
        chainId: null,
        contract: "spraay-tao",
        tokens: ["TAO"],
        ccipEnabled: false,
        version: "native",
      },
    ],
  });
}
