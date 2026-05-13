/**
 * 💧 Spraay x402 Gateway — Solana Discovery Endpoint
 * src/routes/solana-discovery.ts
 *
 * Adds /.well-known/solana.json alongside existing:
 *   /.well-known/x402.json     (EVM x402)
 *   /.well-known/mpp.json      (Stripe MPP)
 *   /.well-known/agent.json    (Agent discovery)
 *
 * Register as: app.get("/.well-known/solana.json", solanaDiscoveryHandler);
 */

import type { Request, Response } from "express";

const SOLANA_ENABLED = process.env.SOLANA_PAYMENTS_ENABLED === "true";
const SOLANA_RECEIVE_ADDRESS = process.env.SOLANA_RECEIVE_ADDRESS || "";
const SOLANA_CLUSTER = process.env.SOLANA_CLUSTER || "mainnet-beta";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BASE_URL = process.env.BASE_URL || "https://gateway.spraay.app";

export function solanaDiscoveryHandler(_req: Request, res: Response): void {
  if (!SOLANA_ENABLED || !SOLANA_RECEIVE_ADDRESS) {
    res.status(404).json({ error: "Solana payments not enabled" });
    return;
  }

  res.json({
    name: "Spraay x402 Gateway",
    description: "AI agent payment gateway — Solana USDC rail",
    version: "3.7.0",
    chain: "solana",
    cluster: SOLANA_CLUSTER,
    payment: {
      receiveAddress: SOLANA_RECEIVE_ADDRESS,
      usdcMint: USDC_MINT,
      txHeader: "X-Solana-Tx",
      protocol: "spl-transfer",
    },
    verification: {
      method: "on-chain",
      commitment: "confirmed",
      maxTxAgeSeconds: parseInt(process.env.SOLANA_MAX_TX_AGE || "300", 10),
    },
    docs: "https://docs.spraay.app",
    gateway: BASE_URL,
    related: {
      x402: `${BASE_URL}/.well-known/x402.json`,
      mpp: `${BASE_URL}/.well-known/mpp.json`,
      agent: `${BASE_URL}/.well-known/agent.json`,
    },
  });
}

/**
 * Helper to add Solana rail to the existing agent.json response.
 * Use in the /.well-known/agent.json handler:
 *
 *   import { getSolanaPaymentRail } from "./solana-discovery.js";
 *   // Inside the handler:
 *   const agentJson = { ...existingFields };
 *   const solanaRail = getSolanaPaymentRail();
 *   if (solanaRail) {
 *     agentJson.payment_rails = [...(agentJson.payment_rails || []), solanaRail];
 *   }
 */
export function getSolanaPaymentRail(): object | null {
  if (!SOLANA_ENABLED || !SOLANA_RECEIVE_ADDRESS) return null;

  return {
    chain: "solana",
    cluster: SOLANA_CLUSTER,
    asset: "USDC",
    mint: USDC_MINT,
    receiveAddress: SOLANA_RECEIVE_ADDRESS,
    txHeader: "X-Solana-Tx",
  };
}
