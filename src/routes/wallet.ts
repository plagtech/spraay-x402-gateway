// ============================================
// Spraay x402 Gateway — Wallet Provisioning
// Category 14: Agent Wallet Management
// File: src/routes/wallet.ts
// ============================================

import { Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// --------------------------------------------------
// Phantom Server SDK Setup
// Uncomment when you have org credentials from Phantom
// --------------------------------------------------
// import { ServerSDK, NetworkId } from "@phantom/server-sdk";
// const phantomSDK = new ServerSDK({
//   organizationId: process.env.PHANTOM_ORGANIZATION_ID!,
//   appId: process.env.PHANTOM_APP_ID!,
//   apiPrivateKey: process.env.PHANTOM_PRIVATE_KEY!,
// });

// ==================================================
// POST /api/v1/wallet/create — FREE
// ==================================================
export const walletCreateHandler = async (req: Request, res: Response) => {
  try {
    const { name, label } = req.body;
    const walletName = name || `spraay-agent-${Date.now()}`;

    // ----- PHANTOM SDK (uncomment when credentials ready) -----
    // const wallet = await phantomSDK.createWallet(walletName);
    // const solanaAddress = wallet.addresses.find((a: any) => a.addressType === "Solana")?.address;
    // const evmAddress = wallet.addresses.find((a: any) => a.addressType === "Ethereum")?.address;
    // const walletId = wallet.walletId;

    // ----- PLACEHOLDER (remove when SDK is wired) -----
    const walletId = `placeholder-${Date.now()}`;
    const solanaAddress: string | null = null;
    const evmAddress: string | null = null;
    // ----- END PLACEHOLDER -----

    const { error } = await supabase.from("agent_wallets").insert({
      wallet_id: walletId,
      label: label || walletName,
      solana_address: solanaAddress,
      evm_address: evmAddress,
      metadata: {
        created_by: req.headers["x-agent-id"] || "unknown",
        source: "gateway-api",
      },
    });

    if (error) {
      console.error("Supabase insert error:", error);
      return res.status(500).json({ success: false, error: "Failed to store wallet" });
    }

    res.status(201).json({
      success: true,
      walletId,
      addresses: {
        solana: solanaAddress,
        ethereum: evmAddress,
        base: evmAddress,
        polygon: evmAddress,
        arbitrum: evmAddress,
        bnb: evmAddress,
        avalanche: evmAddress,
        unichain: evmAddress,
        plasma: evmAddress,
        bob: evmAddress,
      },
      label: label || walletName,
      note: "EVM address works across all EVM chains where Spraay is deployed",
    });
  } catch (err: any) {
    console.error("Wallet create error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ==================================================
// GET /api/v1/wallet/:walletId — PAID ($0.001)
// ==================================================
export const walletGetHandler = async (req: Request, res: Response) => {
  try {
    const { walletId } = req.params;

    const { data, error } = await supabase
      .from("agent_wallets")
      .select("*")
      .eq("wallet_id", walletId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: "Wallet not found" });
    }

    await supabase
      .from("agent_wallets")
      .update({ last_active: new Date().toISOString() })
      .eq("wallet_id", walletId);

    res.json({
      success: true,
      walletId: data.wallet_id,
      label: data.label,
      addresses: {
        solana: data.solana_address,
        ethereum: data.evm_address,
        base: data.evm_address,
        polygon: data.evm_address,
        arbitrum: data.evm_address,
      },
      created_at: data.created_at,
      last_active: data.last_active,
      total_transactions: data.total_transactions,
    });
  } catch (err: any) {
    console.error("Wallet get error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ==================================================
// GET /api/v1/wallet/list — PAID ($0.002)
// ==================================================
export const walletListHandler = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const { data, error, count } = await supabase
      .from("agent_wallets")
      .select("wallet_id, label, solana_address, evm_address, created_at, last_active, total_transactions", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      return res.status(500).json({ success: false, error: "Failed to list wallets" });
    }

    res.json({
      success: true,
      wallets: data,
      pagination: { total: count, limit, offset, hasMore: offset + limit < (count || 0) },
    });
  } catch (err: any) {
    console.error("Wallet list error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ==================================================
// POST /api/v1/wallet/sign-message — PAID ($0.005)
// ==================================================
export const walletSignMessageHandler = async (req: Request, res: Response) => {
  try {
    const { walletId, message, networkId } = req.body;

    if (!walletId || !message) {
      return res.status(400).json({ success: false, error: "walletId and message required" });
    }

    // ----- PHANTOM SDK (uncomment when credentials ready) -----
    // const signature = await phantomSDK.signMessage({
    //   walletId,
    //   message,
    //   networkId: networkId || NetworkId.SOLANA_MAINNET,
    // });
    // res.json({ success: true, signature, walletId, networkId });

    // Placeholder
    res.json({
      success: true,
      _dev_note: "Sign message stubbed — waiting for Phantom Server SDK credentials",
      walletId,
      message,
      networkId: networkId || "solana-mainnet",
    });
  } catch (err: any) {
    console.error("Sign message error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ==================================================
// POST /api/v1/wallet/send-transaction — PAID ($0.02)
// ==================================================
export const walletSendTxHandler = async (req: Request, res: Response) => {
  try {
    const { walletId, transaction, networkId } = req.body;

    if (!walletId || !transaction || !networkId) {
      return res.status(400).json({ success: false, error: "walletId, transaction, and networkId required" });
    }

    // ----- PHANTOM SDK (uncomment when credentials ready) -----
    // const result = await phantomSDK.signAndSendTransaction({ walletId, transaction, networkId });
    // await supabase
    //   .from("agent_wallets")
    //   .update({ total_transactions: supabase.rpc("increment", { x: 1 }) })
    //   .eq("wallet_id", walletId);
    // res.json({ success: true, signature: result.signature, networkId });

    // Placeholder
    res.json({
      success: true,
      _dev_note: "Send transaction stubbed — waiting for Phantom Server SDK credentials",
      walletId,
      networkId,
    });
  } catch (err: any) {
    console.error("Send transaction error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ==================================================
// GET /api/v1/wallet/:walletId/addresses — PAID ($0.001)
// ==================================================
export const walletAddressesHandler = async (req: Request, res: Response) => {
  try {
    const { walletId } = req.params;

    const { data, error } = await supabase
      .from("agent_wallets")
      .select("solana_address, evm_address")
      .eq("wallet_id", walletId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: "Wallet not found" });
    }

    res.json({
      success: true,
      walletId,
      addresses: {
        solana: data.solana_address,
        ethereum: data.evm_address,
        base: data.evm_address,
        polygon: data.evm_address,
        arbitrum: data.evm_address,
        bnb: data.evm_address,
        avalanche: data.evm_address,
        unichain: data.evm_address,
        plasma: data.evm_address,
        bob: data.evm_address,
      },
    });
  } catch (err: any) {
    console.error("Get addresses error:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};
