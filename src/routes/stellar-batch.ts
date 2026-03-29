/**
 * Spraay Stellar (XLM) Batch Payments — Chain #14
 *
 * Native multi-operation transactions on Stellar.
 * No smart contract needed — batching is a protocol-level feature.
 *
 * Flow:
 *   1. Caller sends recipients + amounts
 *   2. Gateway builds transaction with payment ops + Spraay fee op
 *   3. Gateway returns unsigned XDR for caller to sign & submit
 *   4. All payments + fee execute atomically (all-or-nothing)
 *
 * Fee address: GCEXSX7N3WVG5MRXP7IK2ARQQQX7BZ5RVMUCO2WOSS2SHV5AUB3QLX5B
 * SDK: @stellar/stellar-sdk (v14.x)
 * Network: Stellar Mainnet (Public Global Stellar Network ; September 2015)
 */

import { Request, Response } from "express";
import * as StellarSdk from "@stellar/stellar-sdk";
import { trackRequest } from "./health.js";

// ============ Config ============

const STELLAR_HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon.stellar.org";
const STELLAR_NETWORK_PASSPHRASE = StellarSdk.Networks.PUBLIC;
const SPRAAY_FEE_ADDRESS = process.env.STELLAR_FEE_ADDRESS || "GCEXSX7N3WVG5MRXP7IK2ARQQQX7BZ5RVMUCO2WOSS2SHV5AUB3QLX5B";
const SPRAAY_FEE_BPS = 30; // 0.3%
const MAX_RECIPIENTS = 99; // Stellar max 100 ops per tx, reserve 1 for fee op

const horizon = new StellarSdk.Horizon.Server(STELLAR_HORIZON_URL);

// ============ Helpers ============

/**
 * Validate a Stellar public key (G... address)
 */
function isValidStellarAddress(address: string): boolean {
  try {
    StellarSdk.Keypair.fromPublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Calculate Spraay fee (0.3%) from a total amount string.
 * Stellar amounts are strings with up to 7 decimal places.
 */
function calculateFee(totalAmount: string): string {
  const total = parseFloat(totalAmount);
  const fee = (total * SPRAAY_FEE_BPS) / 10000;
  // Stellar supports max 7 decimal places
  return fee.toFixed(7);
}

// ============ Handlers ============

/**
 * POST /api/v1/stellar/batch
 *
 * Build an unsigned Stellar transaction with multiple payment operations.
 * Caller signs with their secret key and submits to the network.
 *
 * Body:
 * {
 *   "sender": "GABC...",           // Source account (Stellar public key)
 *   "recipients": [
 *     { "address": "GXYZ...", "amount": "100.00" },
 *     { "address": "GDEF...", "amount": "50.25" }
 *   ],
 *   "memo": "payroll-march-2026"   // Optional memo (max 28 bytes for text)
 * }
 *
 * Returns unsigned XDR that the caller signs and submits.
 */
export async function stellarBatchHandler(req: Request, res: Response) {
  trackRequest("/api/v1/stellar/batch");
  try {
    const { sender, recipients, memo } = req.body;

    // ─── Validation ──────────────────────────────────

    if (!sender) {
      return res.status(400).json({ error: "sender (Stellar public key) is required" });
    }
    if (!isValidStellarAddress(sender)) {
      return res.status(400).json({ error: "Invalid sender Stellar address" });
    }
    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array is required" });
    }
    if (recipients.length > MAX_RECIPIENTS) {
      return res.status(400).json({
        error: `Maximum ${MAX_RECIPIENTS} recipients per transaction (Stellar protocol limit is 100 operations, 1 reserved for fee)`,
      });
    }

    // Validate each recipient
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      if (!r.address || !isValidStellarAddress(r.address)) {
        return res.status(400).json({ error: `Invalid Stellar address for recipient ${i}: ${r.address}` });
      }
      if (!r.amount || isNaN(parseFloat(r.amount)) || parseFloat(r.amount) <= 0) {
        return res.status(400).json({ error: `Invalid amount for recipient ${i}: ${r.amount}` });
      }
      // Check Stellar 7-decimal precision
      const parts = String(r.amount).split(".");
      if (parts[1] && parts[1].length > 7) {
        return res.status(400).json({ error: `Amount for recipient ${i} exceeds 7 decimal places (Stellar max)` });
      }
    }

    // Check sender isn't also the fee address (prevent loops)
    if (sender === SPRAAY_FEE_ADDRESS) {
      return res.status(400).json({ error: "Sender cannot be the Spraay fee address" });
    }

    // ─── Load source account from Horizon ────────────

    let sourceAccount: StellarSdk.Horizon.AccountResponse;
    try {
      sourceAccount = await horizon.loadAccount(sender);
    } catch (loadErr: any) {
      if (loadErr?.response?.status === 404) {
        return res.status(400).json({
          error: "Sender account not found on Stellar network. Account must be funded with at least 1 XLM.",
        });
      }
      throw loadErr;
    }

    // ─── Calculate totals ────────────────────────────

    let totalAmount = 0;
    for (const r of recipients) {
      totalAmount += parseFloat(r.amount);
    }

    const feeAmount = calculateFee(totalAmount.toFixed(7));
    const totalWithFee = (totalAmount + parseFloat(feeAmount)).toFixed(7);

    // ─── Build transaction ───────────────────────────

    const baseFee = await horizon.fetchBaseFee();
    // Fee per operation * (recipients + 1 fee op)
    const txFee = String(baseFee * (recipients.length + 1));

    let builder = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: txFee,
      networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
    });

    // Add payment operation for each recipient
    for (const r of recipients) {
      builder = builder.addOperation(
        StellarSdk.Operation.payment({
          destination: r.address,
          asset: StellarSdk.Asset.native(),
          amount: parseFloat(r.amount).toFixed(7),
        })
      );
    }

    // Add Spraay fee payment operation
    builder = builder.addOperation(
      StellarSdk.Operation.payment({
        destination: SPRAAY_FEE_ADDRESS,
        asset: StellarSdk.Asset.native(),
        amount: feeAmount,
      })
    );

    // Add memo if provided
    if (memo) {
      if (typeof memo === "string" && memo.length <= 28) {
        builder = builder.addMemo(StellarSdk.Memo.text(memo));
      } else if (typeof memo === "string" && memo.length > 28) {
        // Use hash memo for longer memos
        builder = builder.addMemo(StellarSdk.Memo.hash(
          Buffer.from(memo).toString("hex").padEnd(64, "0").slice(0, 64)
        ));
      }
    }

    // Set timeout (5 minutes)
    builder = builder.setTimeout(300);

    // Build the transaction (unsigned)
    const transaction = builder.build();

    // Serialize to XDR
    const unsignedXDR = transaction.toXDR();

    // ─── Response ────────────────────────────────────

    return res.json({
      success: true,
      chain: "stellar",
      chainId: 14,
      network: "mainnet",
      batch: {
        recipientCount: recipients.length,
        totalAmount: totalAmount.toFixed(7),
        fee: feeAmount,
        feePercent: "0.3%",
        totalWithFee,
        feeAddress: SPRAAY_FEE_ADDRESS,
      },
      transaction: {
        unsignedXDR,
        sourceAccount: sender,
        sequenceNumber: sourceAccount.sequenceNumber(),
        operationCount: recipients.length + 1,
        networkFee: `${txFee} stroops`,
        networkPassphrase: STELLAR_NETWORK_PASSPHRASE,
        timeout: "300 seconds",
        memo: memo || null,
      },
      instructions: {
        step1: "Sign the unsignedXDR with your Stellar secret key",
        step2: "Submit the signed transaction to the Stellar network",
        example: `
const tx = new StellarSdk.Transaction(unsignedXDR, "${STELLAR_NETWORK_PASSPHRASE}");
tx.sign(StellarSdk.Keypair.fromSecret("YOUR_SECRET_KEY"));
const result = await horizon.submitTransaction(tx);
        `.trim(),
      },
    });
  } catch (err: any) {
    console.error("stellar/batch error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/v1/stellar/estimate
 *
 * Estimate batch payment cost on Stellar.
 *
 * Body:
 * {
 *   "recipients": [
 *     { "address": "GXYZ...", "amount": "100.00" }
 *   ]
 * }
 *
 * Or simple format:
 * { "recipientCount": 5, "totalAmount": "500.00" }
 */
export async function stellarEstimateHandler(req: Request, res: Response) {
  trackRequest("/api/v1/stellar/estimate");
  try {
    const { recipients, recipientCount, totalAmount } = req.body;

    if (recipients && Array.isArray(recipients)) {
      let total = 0;
      for (const r of recipients) {
        total += parseFloat(r.amount);
      }

      const feeAmount = calculateFee(total.toFixed(7));
      const baseFee = await horizon.fetchBaseFee();
      const networkFee = baseFee * (recipients.length + 1);

      return res.json({
        success: true,
        chain: "stellar",
        recipientCount: recipients.length,
        totalAmount: total.toFixed(7),
        spraayFee: feeAmount,
        spraayFeePercent: "0.3%",
        totalWithFee: (total + parseFloat(feeAmount)).toFixed(7),
        networkFee: `${networkFee} stroops (${(networkFee / 10000000).toFixed(7)} XLM)`,
        estimatedFinality: "~5 seconds",
      });
    }

    // Simple format
    const count = recipientCount || 1;
    const amount = totalAmount ? parseFloat(totalAmount) : 0;
    const feeAmount = amount > 0 ? calculateFee(amount.toFixed(7)) : "0";
    const baseFee = 100; // Default base fee in stroops
    const networkFee = baseFee * (count + 1);

    return res.json({
      success: true,
      chain: "stellar",
      recipientCount: count,
      maxRecipientsPerTx: MAX_RECIPIENTS,
      spraayFeePercent: "0.3%",
      spraayFee: feeAmount,
      networkFee: `${networkFee} stroops (${(networkFee / 10000000).toFixed(7)} XLM)`,
      estimatedFinality: "~5 seconds",
      note: amount === 0
        ? "Provide totalAmount for exact fee calculation."
        : undefined,
    });
  } catch (err: any) {
    console.error("stellar/estimate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
