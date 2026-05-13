/**
 * 💧 Spraay x402 Gateway — Solana SPL USDC Payment Verifier
 * src/solana/solanaVerifier.ts
 *
 * Verifies that an SPL USDC transfer actually landed on the Spraay
 * receive address before releasing the gated API response.
 *
 * Design principles:
 *   1. Zero impact on existing EVM / x402 / MPP flows
 *   2. Uses @solana/web3.js for on-chain tx verification
 *   3. Stateless — every verification is a fresh RPC lookup
 */

import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
} from "@solana/web3.js";

// ----- constants --------------------------------------------------------- //

/** Solana Mainnet USDC mint (Circle) */
export const USDC_MINT = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

/** SPL Token program ID */
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);

// ----- types ------------------------------------------------------------- //

export interface SolanaVerifyResult {
  verified: boolean;
  /** USDC amount transferred (human-readable, 6 decimals) */
  amount: number | null;
  /** Sender wallet address */
  sender: string | null;
  /** Slot the tx was confirmed in */
  slot: number | null;
  /** Block time (unix) */
  blockTime: number | null;
  error?: string;
}

export interface SolanaPaymentConfig {
  /** Spraay Solana USDC receive address */
  receiveAddress: string;
  /** Solana RPC endpoint (default: mainnet public) */
  rpcUrl?: string;
  /** Minimum confirmations required (default: 1 = "confirmed") */
  minConfirmations?: number;
  /** Maximum age of tx in seconds to accept (default: 300 = 5 min) */
  maxTxAgeSeconds?: number;
}

// ----- verifier ---------------------------------------------------------- //

export class SolanaVerifier {
  private connection: Connection;
  private receiveAddress: PublicKey;
  private minConfirmations: number;
  private maxTxAgeSeconds: number;

  constructor(config: SolanaPaymentConfig) {
    const rpcUrl =
      config.rpcUrl ||
      process.env.SOLANA_RPC_URL ||
      "https://api.mainnet-beta.solana.com";

    this.connection = new Connection(rpcUrl, "confirmed");
    this.receiveAddress = new PublicKey(config.receiveAddress);
    this.minConfirmations = config.minConfirmations ?? 1;
    this.maxTxAgeSeconds = config.maxTxAgeSeconds ?? 300;
  }

  /**
   * Verify that a Solana transaction:
   *   1. Exists and is confirmed
   *   2. Contains an SPL USDC transfer
   *   3. Transfers to the Spraay receive address
   *   4. Meets the minimum required amount
   *   5. Is recent enough (within maxTxAgeSeconds)
   */
  async verifyPayment(
    txSignature: string,
    requiredAmountUSDC: number
  ): Promise<SolanaVerifyResult> {
    try {
      // 1. Fetch parsed transaction
      const tx: ParsedTransactionWithMeta | null =
        await this.connection.getParsedTransaction(txSignature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });

      if (!tx) {
        return {
          verified: false,
          amount: null,
          sender: null,
          slot: null,
          blockTime: null,
          error: "Transaction not found or not yet confirmed",
        };
      }

      // 2. Check confirmation status
      if (!tx.meta || tx.meta.err) {
        return {
          verified: false,
          amount: null,
          sender: null,
          slot: tx.slot,
          blockTime: tx.blockTime,
          error: tx.meta?.err
            ? `Transaction failed: ${JSON.stringify(tx.meta.err)}`
            : "Transaction metadata unavailable",
        };
      }

      // 3. Check age
      if (tx.blockTime) {
        const ageSeconds = Math.floor(Date.now() / 1000) - tx.blockTime;
        if (ageSeconds > this.maxTxAgeSeconds) {
          return {
            verified: false,
            amount: null,
            sender: null,
            slot: tx.slot,
            blockTime: tx.blockTime,
            error: `Transaction too old: ${ageSeconds}s (max ${this.maxTxAgeSeconds}s)`,
          };
        }
      }

      // 4. Find the SPL USDC transfer to our address
      const transfer = this.extractUSDCTransfer(tx);

      if (!transfer) {
        return {
          verified: false,
          amount: null,
          sender: null,
          slot: tx.slot,
          blockTime: tx.blockTime,
          error:
            "No USDC transfer to Spraay receive address found in transaction",
        };
      }

      // 5. Check amount meets minimum
      if (transfer.amount < requiredAmountUSDC) {
        return {
          verified: false,
          amount: transfer.amount,
          sender: transfer.sender,
          slot: tx.slot,
          blockTime: tx.blockTime,
          error: `Insufficient amount: ${transfer.amount} USDC (required: ${requiredAmountUSDC})`,
        };
      }

      // ✅ All checks passed
      return {
        verified: true,
        amount: transfer.amount,
        sender: transfer.sender,
        slot: tx.slot,
        blockTime: tx.blockTime,
      };
    } catch (err: any) {
      return {
        verified: false,
        amount: null,
        sender: null,
        slot: null,
        blockTime: null,
        error: `Verification error: ${err.message}`,
      };
    }
  }

  /**
   * Walk the parsed inner instructions looking for a USDC
   * `transfer` or `transferChecked` that credits our address.
   */
  private extractUSDCTransfer(
    tx: ParsedTransactionWithMeta
  ): { amount: number; sender: string } | null {
    const allInstructions = [
      ...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions?.flatMap((ix) => ix.instructions) || []),
    ];

    for (const ix of allInstructions) {
      // Only look at parsed SPL Token instructions
      if (!("parsed" in ix) || !("program" in ix)) continue;
      if ((ix as any).program !== "spl-token") continue;

      const parsed = (ix as any).parsed;

      if (parsed.type === "transferChecked" || parsed.type === "transfer") {
        const info = parsed.info;

        // For transferChecked, verify USDC mint
        if (parsed.type === "transferChecked") {
          if (info.mint !== USDC_MINT.toBase58()) continue;
        }

        // Check destination is our receive address (token account owner)
        // SPL transfers go to token accounts, not wallet addresses directly.
        // We cross-reference postTokenBalances to confirm the owner matches.
        const destTokenAccount: string = info.destination;
        if (this.isOurTokenAccount(tx, destTokenAccount)) {
          const amount =
            parsed.type === "transferChecked"
              ? parseFloat(info.tokenAmount.uiAmountString)
              : info.amount / 1e6; // USDC has 6 decimals

          return {
            amount,
            sender: info.authority || info.source,
          };
        }
      }
    }

    return null;
  }

  /**
   * Check if a token account belongs to our receive address
   * by inspecting postTokenBalances.
   */
  private isOurTokenAccount(
    tx: ParsedTransactionWithMeta,
    tokenAccountAddress: string
  ): boolean {
    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey.toBase58()
    );
    const tokenAccountIndex = accountKeys.indexOf(tokenAccountAddress);

    if (tokenAccountIndex === -1) return false;

    // Check postTokenBalances for this index
    const postBalance = tx.meta?.postTokenBalances?.find(
      (b) =>
        b.accountIndex === tokenAccountIndex &&
        b.mint === USDC_MINT.toBase58() &&
        b.owner === this.receiveAddress.toBase58()
    );

    return !!postBalance;
  }

  /** Health check — can we reach the RPC? */
  async healthCheck(): Promise<boolean> {
    try {
      const slot = await this.connection.getSlot();
      return slot > 0;
    } catch {
      return false;
    }
  }
}
