/**
 * Spraay Base MCP Plugin Router
 *
 * Free GET endpoints that return unsigned calldata for Base MCP's send_calls.
 * These do NOT execute transactions — Base MCP handles wallet approval and submission.
 *
 * Mount in your gateway: app.use('/api/v1/plugin', pluginRouter);
 */

import { Router, Request, Response } from "express";
import { ethers } from "ethers";

const router = Router();

// --- Constants ---
const SPRAAY_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
const SPRAAY_FEE_BPS = 30; // 0.3%
const BASE_CHAIN_ID = 8453;

const BASE_TOKENS: Record<string, { address: string; symbol: string; decimals: number }> = {
  USDC:  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  USDT:  { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
  EURC:  { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
  DAI:   { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI",  decimals: 18 },
  WETH:  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
};

const DEFAULT_TOKEN = BASE_TOKENS.USDC;

// Actual Spraay contract ABI — matches your deployed contract
const SPRAAY_ABI = [
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
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

const sprayInterface = new ethers.Interface(SPRAAY_ABI);

const provider = new ethers.JsonRpcProvider(
  process.env.ALCHEMY_API_KEY
    ? `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    : "https://mainnet.base.org"
);

// --- Helpers ---

function resolveToken(input?: string) {
  if (!input || input.toUpperCase() === "ETH") {
    return { address: ethers.ZeroAddress, decimals: 18, symbol: "ETH", isETH: true };
  }
  const upper = input.toUpperCase();
  const known = BASE_TOKENS[upper];
  if (known) return { ...known, isETH: false };
  if (input.startsWith("0x") && input.length === 42) {
    const match = Object.values(BASE_TOKENS).find(
      (t) => t.address.toLowerCase() === input.toLowerCase()
    );
    return {
      address: input,
      decimals: match?.decimals || 18,
      symbol: match?.symbol || "ERC20",
      isETH: false,
    };
  }
  return { address: "", decimals: 18, symbol: input, isETH: false };
}

function parseRecipients(str: string): Array<{ address: string; amount: string }> {
  return str.split(",").map((pair) => {
    const [address, amount] = pair.trim().split(":");
    if (!address || !amount) throw new Error(`Invalid recipient: "${pair}". Use address:amount`);
    return { address: address.trim(), amount: amount.trim() };
  });
}

// --- Routes (all GET, all free — no x402 gating) ---

/**
 * GET /balance?address=0x...&token=USDC
 */
router.get("/balance", async (req: Request, res: Response) => {
  try {
    const { address, token: tokenInput } = req.query as Record<string, string>;
    if (!address) return res.status(400).json({ ok: false, error: "address is required" });

    const token = resolveToken(tokenInput);

    if (token.isETH) {
      const bal = await provider.getBalance(address);
      return res.json({
        ok: true,
        data: { address, token: ethers.ZeroAddress, symbol: "ETH", balance: ethers.formatEther(bal), decimals: 18 },
      });
    }

    const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
    const [rawBal, decimals, symbol] = await Promise.all([
      contract.balanceOf(address),
      contract.decimals(),
      contract.symbol(),
    ]);

    res.json({
      ok: true,
      data: { address, token: token.address, symbol, balance: ethers.formatUnits(rawBal, decimals), decimals: Number(decimals) },
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /quote?recipientCount=5&totalAmount=500&token=USDC
 */
router.get("/quote", async (req: Request, res: Response) => {
  try {
    const { recipientCount, totalAmount, token: tokenInput } = req.query as Record<string, string>;
    if (!recipientCount || !totalAmount) {
      return res.status(400).json({ ok: false, error: "recipientCount and totalAmount required" });
    }

    const token = resolveToken(tokenInput);
    const count = parseInt(recipientCount, 10);
    const total = parseFloat(totalAmount);

    // Gas estimate matching your batch-payments.ts logic
    const baseGas = 50000;
    const perRecipientGas = token.isETH ? 30000 : 65000;
    const estimatedGasUnits = baseGas + perRecipientGas * count;
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || ethers.parseUnits("0.1", "gwei");
    const estimatedGasEth = ethers.formatEther(gasPrice * BigInt(estimatedGasUnits));

    const spraayFee = (total * SPRAAY_FEE_BPS / 10000).toFixed(token.decimals <= 6 ? 2 : 6);

    res.json({
      ok: true,
      data: {
        recipientCount: count,
        totalAmount,
        estimatedGas: estimatedGasEth,
        spraayFee,
        feePercent: "0.3%",
        token: token.isETH ? "ETH" : token.address,
        symbol: token.symbol,
      },
    });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * GET /prepare/batch?from=0x...&recipients=0xA:50,0xB:30&token=USDC
 *
 * Returns unsigned calldata in the ordered-batch format for Base MCP's send_calls.
 * Does NOT execute anything.
 */
router.get("/prepare/batch", async (req: Request, res: Response) => {
  try {
    const { from, recipients: recipientsStr, token: tokenInput } = req.query as Record<string, string>;

    if (!from) return res.status(400).json({ ok: false, error: "from address is required" });
    if (!recipientsStr) return res.status(400).json({ ok: false, error: "recipients required (addr:amount,addr:amount)" });

    const token = resolveToken(tokenInput);
    if (!token.isETH && !token.address) {
      return res.status(400).json({ ok: false, error: `Unknown token "${tokenInput}"` });
    }

    const parsed = parseRecipients(recipientsStr);
    if (parsed.length < 2) return res.status(400).json({ ok: false, error: "At least 2 recipients required" });
    if (parsed.length > 200) return res.status(400).json({ ok: false, error: "Maximum 200 recipients" });

    // Build recipient tuples matching your contract's struct format
    const onchainRecipients = parsed.map((r) => ({
      recipient: r.address,
      amount: ethers.parseUnits(r.amount, token.decimals),
    }));

    let totalRaw = 0n;
    for (const r of onchainRecipients) totalRaw += r.amount;
    const feeRaw = (totalRaw * BigInt(SPRAAY_FEE_BPS)) / 10000n;
    const totalWithFee = totalRaw + feeRaw;

    const transactions: Array<{ step: string; to: string; data: string; value: string; chainId: number }> = [];

    if (token.isETH) {
      // ETH: single call with value
      const calldata = sprayInterface.encodeFunctionData("sprayETH", [onchainRecipients]);
      transactions.push({
        step: "batch_transfer",
        to: SPRAAY_CONTRACT,
        data: calldata,
        value: "0x" + totalWithFee.toString(16),
        chainId: BASE_CHAIN_ID,
      });
    } else {
      // ERC-20: check allowance, maybe approve, then sprayToken
      const tokenContract = new ethers.Contract(token.address, ERC20_ABI, provider);
      const currentAllowance = await tokenContract.allowance(from, SPRAAY_CONTRACT);

      if (currentAllowance < totalWithFee) {
        const erc20Iface = new ethers.Interface(ERC20_ABI);
        const approveData = erc20Iface.encodeFunctionData("approve", [
          SPRAAY_CONTRACT,
          totalWithFee,
        ]);
        transactions.push({
          step: "approve",
          to: token.address,
          data: approveData,
          value: "0x0",
          chainId: BASE_CHAIN_ID,
        });
      }

      const calldata = sprayInterface.encodeFunctionData("sprayToken", [
        token.address,
        onchainRecipients,
      ]);
      transactions.push({
        step: "batch_transfer",
        to: SPRAAY_CONTRACT,
        data: calldata,
        value: "0x0",
        chainId: BASE_CHAIN_ID,
      });
    }

    res.json({ transactions });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
