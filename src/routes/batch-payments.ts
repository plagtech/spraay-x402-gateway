import { Request, Response } from "express";
import { trackRequest } from "./health";

// Spraay contract on Base
const SPRAAY_CONTRACT = "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC";

/**
 * POST /api/v1/batch/execute
 * 
 * Execute a batch USDC payment to multiple recipients via Spraay protocol.
 * This is the killer feature - agents managing DAO treasuries, payroll, 
 * subnet rewards, etc. can pay multiple addresses in one call.
 * 
 * Body:
 * {
 *   "token": "USDC",                    // Token to send (currently USDC on Base)
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" },
 *     { "address": "0x456...", "amount": "25.50" },
 *     { "address": "0x789...", "amount": "5.00" }
 *   ],
 *   "memo": "January contributor payments"   // Optional memo
 * }
 * 
 * NOTE: In production, this would interact with the Spraay contract.
 * For now, we return the transaction data that the calling agent
 * would submit to the blockchain.
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
            { address: "0x123...", amount: "10.00" },
            { address: "0x456...", amount: "25.50" },
          ],
          memo: "Payment batch",
        },
      });
    }

    // Validate recipients
    for (const r of recipients) {
      if (!r.address || !r.amount) {
        return res.status(400).json({
          error: "Each recipient must have 'address' and 'amount'",
        });
      }
      if (!/^0x[a-fA-F0-9]{40}$/.test(r.address)) {
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

    const totalAmount = recipients.reduce(
      (sum: number, r: any) => sum + parseFloat(r.amount),
      0
    );

    // Build the Spraay batch transaction calldata
    // In production, this encodes the actual contract call
    const addresses = recipients.map((r: any) => r.address);
    const amounts = recipients.map((r: any) =>
      BigInt(Math.round(parseFloat(r.amount) * 1e6)).toString()
    ); // USDC has 6 decimals

    trackRequest("batch_execute");

    return res.json({
      status: "prepared",
      contract: SPRAAY_CONTRACT,
      network: "base",
      chainId: 8453,
      token: token || "USDC",
      recipients: recipients.length,
      totalAmount: totalAmount.toFixed(6),
      memo: memo || null,
      // The encoded transaction data the agent would submit
      transaction: {
        to: SPRAAY_CONTRACT,
        data: encodeBatchPaymentData(addresses, amounts),
        value: "0",
        chainId: 8453,
      },
      // Human-readable breakdown
      breakdown: recipients.map((r: any) => ({
        to: r.address,
        amount: `${r.amount} USDC`,
      })),
      _gateway: {
        provider: "spraay-x402",
        protocol: "spraay-batch-v1",
      },
    });
  } catch (error: any) {
    console.error("Batch payment error:", error.message);
    return res.status(500).json({ error: "Batch payment preparation failed" });
  }
}

/**
 * POST /api/v1/batch/estimate
 * 
 * Estimate the gas cost for a batch payment before execution.
 * Agents use this to budget their operations.
 * 
 * Body: Same as /batch/execute
 */
export async function batchEstimateHandler(req: Request, res: Response) {
  try {
    const { recipients } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "Missing recipients array" });
    }

    const recipientCount = recipients.length;
    const totalAmount = recipients.reduce(
      (sum: number, r: any) => sum + parseFloat(r.amount || 0),
      0
    );

    // Gas estimation based on Spraay contract benchmarks
    // Base gas + per-recipient overhead
    const baseGas = 50000;
    const perRecipientGas = 35000;
    const estimatedGas = baseGas + perRecipientGas * recipientCount;

    // Approximate gas price on Base (very low)
    const gasPriceGwei = 0.01; // Base has extremely low gas
    const estimatedCostETH = (estimatedGas * gasPriceGwei * 1e-9).toFixed(8);
    const estimatedCostUSD = (parseFloat(estimatedCostETH) * 2500).toFixed(4); // ~ETH price

    // Cost comparison vs individual transfers
    const individualGas = recipientCount * 65000; // ERC20 transfer gas
    const individualCostETH = (individualGas * gasPriceGwei * 1e-9).toFixed(8);
    const savingsPercent = (
      ((individualGas - estimatedGas) / individualGas) *
      100
    ).toFixed(1);

    trackRequest("batch_estimate");

    return res.json({
      recipients: recipientCount,
      totalPaymentAmount: `${totalAmount.toFixed(6)} USDC`,
      gasEstimate: {
        estimatedGas,
        estimatedCostETH,
        estimatedCostUSD: `$${estimatedCostUSD}`,
      },
      savings: {
        vsIndividualTransfers: {
          gasWithoutBatch: individualGas,
          gasWithBatch: estimatedGas,
          savingsPercent: `${savingsPercent}%`,
        },
      },
      contract: SPRAAY_CONTRACT,
      _gateway: { provider: "spraay-x402" },
    });
  } catch (error: any) {
    console.error("Batch estimate error:", error.message);
    return res.status(500).json({ error: "Estimation failed" });
  }
}

/**
 * Encode batch payment calldata for the Spraay contract.
 * This would match your actual Spraay contract's ABI.
 */
function encodeBatchPaymentData(
  addresses: string[],
  amounts: string[]
): string {
  // Function selector for batchTransfer(address[],uint256[])
  // This is a placeholder - replace with your actual Spraay contract function selector
  const selector = "0xc23ef031";

  // In production, use ethers.js or viem to properly ABI-encode
  // For now, return a descriptive placeholder
  return `${selector}__batch_${addresses.length}_recipients`;
}
