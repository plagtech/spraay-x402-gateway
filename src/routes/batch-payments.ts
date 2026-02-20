import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// Spraay contract on Base mainnet
const SPRAAY_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SPRAAY_FEE_BPS = 30; // 0.3% protocol fee

// Spraay contract ABI (the functions we need)
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

const spraayInterface = new ethers.Interface(SPRAAY_ABI);

// Base mainnet RPC
const BASE_RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(BASE_RPC);

/**
 * POST /api/v1/batch/execute
 *
 * Returns encoded transaction data for a batch USDC payment via Spraay.
 * The calling agent submits this transaction to Base.
 *
 * Body:
 * {
 *   "token": "USDC",
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" },
 *     { "address": "0x456...", "amount": "25.50" }
 *   ],
 *   "memo": "January contributor payments"
 * }
 *
 * The agent must:
 * 1. Approve the Spraay contract to spend their USDC (totalAmount + fee)
 * 2. Submit the spray transaction with the returned calldata
 */
export async function batchPaymentHandler(req: Request, res: Response) {
  try {
    const { token, recipients, memo } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({
        error: "Missing or empty recipients array",
        example: {
          token: "USDC",
          recipients: [
            { address: "0x742d35Cc6634C0532925a3b844C0532925a3b844", amount: "10.00" },
            { address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B", amount: "25.50" },
          ],
          memo: "Payment batch",
        },
      });
    }

    if (recipients.length > 200) {
      return res.status(400).json({
        error: "Maximum 200 recipients per batch",
      });
    }

    // Validate recipients
    for (const r of recipients) {
      if (!r.address || !r.amount) {
        return res.status(400).json({
          error: "Each recipient must have 'address' and 'amount'",
        });
      }
      if (!ethers.isAddress(r.address)) {
        return res.status(400).json({
          error: `Invalid address: ${r.address}`,
        });
      }
      if (isNaN(parseFloat(r.amount)) || parseFloat(r.amount) <= 0) {
        return res.status(400).json({
          error: `Invalid amount for ${r.address}: ${r.amount}`,
        });
      }
    }

    // USDC has 6 decimals
    const decimals = 6;
    const recipientTuples = recipients.map((r: any) => ({
      recipient: r.address,
      amount: ethers.parseUnits(r.amount.toString(), decimals),
    }));

    const totalAmountRaw = recipientTuples.reduce(
      (sum: bigint, r: any) => sum + r.amount,
      0n
    );

    const feeAmount = (totalAmountRaw * BigInt(SPRAAY_FEE_BPS)) / 10000n;
    const requiredApproval = totalAmountRaw + feeAmount;

    const tokenAddress = BASE_USDC;

    // Encode the actual sprayToken calldata
    const calldata = spraayInterface.encodeFunctionData("sprayToken", [
      tokenAddress,
      recipientTuples,
    ]);

    // Encode the approval calldata the agent needs to do first
    const erc20Interface = new ethers.Interface([
      "function approve(address spender, uint256 amount) returns (bool)",
    ]);
    const approvalCalldata = erc20Interface.encodeFunctionData("approve", [
      SPRAAY_CONTRACT,
      requiredApproval,
    ]);

    // Get real gas price from Base
    let estimatedCostETH = "0.00000100";
    const gasEstimate = 80000 + 45000 * recipients.length;

    try {
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || ethers.parseUnits("0.01", "gwei");
      const estimatedCostWei = gasPrice * BigInt(gasEstimate);
      estimatedCostETH = ethers.formatEther(estimatedCostWei);
    } catch {
      // Use fallback
    }

    trackRequest("batch_execute");

    return res.json({
      status: "ready",
      contract: SPRAAY_CONTRACT,
      network: "base",
      chainId: 8453,
      token: {
        symbol: token || "USDC",
        address: tokenAddress,
        decimals,
      },
      recipients: recipients.length,
      totalAmount: ethers.formatUnits(totalAmountRaw, decimals),
      protocolFee: {
        bps: SPRAAY_FEE_BPS,
        percent: "0.3%",
        amount: ethers.formatUnits(feeAmount, decimals),
      },
      requiredApproval: ethers.formatUnits(requiredApproval, decimals),
      memo: memo || null,
      gasEstimate: {
        estimatedGas: gasEstimate,
        estimatedCostETH,
      },
      // Step 1: Agent must approve USDC spending first
      approvalTransaction: {
        to: tokenAddress,
        data: approvalCalldata,
        value: "0",
        chainId: 8453,
        description: "Approve Spraay contract to spend USDC",
      },
      // Step 2: Execute the batch payment
      sprayTransaction: {
        to: SPRAAY_CONTRACT,
        data: calldata,
        value: "0",
        chainId: 8453,
        description: "Execute batch USDC payment via Spraay",
      },
      breakdown: recipients.map((r: any) => ({
        to: r.address,
        amount: `${r.amount} USDC`,
      })),
      _gateway: {
        provider: "spraay-x402",
        protocol: "spraay-batch-v1",
        contractVersion: "Spraay V2",
      },
    });
  } catch (error: any) {
    console.error("Batch payment error:", error.message);
    return res.status(500).json({ error: "Batch payment preparation failed", details: error.message });
  }
}

/**
 * POST /api/v1/batch/estimate
 *
 * Estimate gas cost for a batch payment.
 */
export async function batchEstimateHandler(req: Request, res: Response) {
  try {
    const { recipients } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "Missing recipients array" });
    }

    if (recipients.length > 200) {
      return res.status(400).json({ error: "Maximum 200 recipients per batch" });
    }

    const recipientCount = recipients.length;
    const totalAmount = recipients.reduce(
      (sum: number, r: any) => sum + parseFloat(r.amount || 0),
      0
    );

    const baseGas = 80000;
    const perRecipientGas = 45000;
    const estimatedGas = baseGas + perRecipientGas * recipientCount;
    const individualGas = recipientCount * 65000;

    // Get real gas price from Base
    let gasPriceGwei = 0.01;
    try {
      const feeData = await provider.getFeeData();
      if (feeData.gasPrice) {
        gasPriceGwei = parseFloat(ethers.formatUnits(feeData.gasPrice, "gwei"));
      }
    } catch {
      // Use default
    }

    const ethPriceUSD = 2500; // Could fetch live, but good enough for estimates
    const estimatedCostETH = estimatedGas * gasPriceGwei * 1e-9;
    const individualCostETH = individualGas * gasPriceGwei * 1e-9;
    const savingsPercent = (
      ((individualGas - estimatedGas) / individualGas) * 100
    ).toFixed(1);

    const feeAmount = totalAmount * (SPRAAY_FEE_BPS / 10000);

    trackRequest("batch_estimate");

    return res.json({
      recipients: recipientCount,
      totalPaymentAmount: `${totalAmount.toFixed(6)} USDC`,
      protocolFee: {
        bps: SPRAAY_FEE_BPS,
        percent: "0.3%",
        amount: `${feeAmount.toFixed(6)} USDC`,
      },
      totalCost: `${(totalAmount + feeAmount).toFixed(6)} USDC (including 0.3% fee)`,
      gasEstimate: {
        estimatedGas,
        gasPriceGwei: gasPriceGwei.toFixed(4),
        estimatedCostETH: estimatedCostETH.toFixed(10),
        estimatedCostUSD: `$${(estimatedCostETH * ethPriceUSD).toFixed(6)}`,
      },
      savings: {
        vsIndividualTransfers: {
          gasWithoutBatch: individualGas,
          gasWithBatch: estimatedGas,
          gasSaved: individualGas - estimatedGas,
          savingsPercent: `${savingsPercent}%`,
        },
      },
      contract: SPRAAY_CONTRACT,
      maxRecipients: 200,
      _gateway: { provider: "spraay-x402" },
    });
  } catch (error: any) {
    console.error("Batch estimate error:", error.message);
    return res.status(500).json({ error: "Estimation failed" });
  }
}
