/**
 * Spraay Agent Wallet Routes (Category 17)
 * 
 * Smart contract wallet provisioning for AI agents on Base.
 * Factory: 0xe483F189af41FB5479cd8695DbbA16cc5CF1071D (Base Sepolia)
 * Implementation: 0xb6843955D914aD61dc6A4C819E0734d96467a391 (Base Sepolia)
 */

import { Request, Response } from "express";
import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";

// ─── Config ──────────────────────────────────────────

const BASE_RPC = process.env.BASE_RPC_URL || "https://sepolia.base.org";
const FACTORY_ADDRESS = process.env.AGENT_WALLET_FACTORY || "0xe483F189af41FB5479cd8695DbbA16cc5CF1071D";
const FACILITATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY || process.env.AGENT_WALLET_DEPLOYER_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const CHAIN_ID = parseInt(process.env.AGENT_WALLET_CHAIN_ID || "84532");

// ─── Contracts ───────────────────────────────────────

const FACTORY_ABI = [
  "function createWallet(address owner, string agentId, string agentType, bytes32 salt) external returns (address)",
  "function predictWalletAddress(address owner, bytes32 salt) external view returns (address)",
  "function totalWallets() external view returns (uint256)",
  "function walletAt(uint256 index) external view returns (address)",
  "function isSpraayWallet(address addr) external view returns (bool)",
  "event WalletCreated(address indexed wallet, address indexed owner, string agentId, string agentType)",
];

const WALLET_ABI = [
  "function addSessionKey(address sessionKey, uint256 spendLimitWei, uint256 validUntil, address[] allowedTargets) external",
  "function revokeSessionKey(address sessionKey) external",
  "function getSessionKeyInfo(address sessionKey) external view returns (bool valid, uint256 remainingSpend, uint256 expiry)",
  "function getAgentMetadata() external view returns (string agentId, string agentType)",
  "function owner() external view returns (address)",
  "function getSessionKeys() external view returns (address[])",
];

// ─── Lazy init (only connect when first request comes in) ───

let _provider: ethers.JsonRpcProvider | null = null;
let _signer: ethers.Wallet | null = null;
let _factory: ethers.Contract | null = null;
let _supabase: ReturnType<typeof createClient> | null = null;

function getProvider() {
  if (!_provider) _provider = new ethers.JsonRpcProvider(BASE_RPC);
  return _provider;
}

function getSigner() {
  if (!_signer) {
    if (!FACILITATOR_KEY) throw new Error("AGENT_WALLET_DEPLOYER_KEY not set");
    _signer = new ethers.Wallet(FACILITATOR_KEY, getProvider());
  }
  return _signer;
}

function getFactory() {
  if (!_factory) _factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, getSigner());
  return _factory;
}

function getSupabase() {
  if (!_supabase) _supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  return _supabase;
}

// ─── POST /api/v1/agent-wallet/provision ─────────────
// Creates a new smart contract wallet for an AI agent.

export async function agentWalletProvisionHandler(req: Request, res: Response) {
  try {
    const { agentId, agentType = "custom", mode = "managed", ownerAddress } = req.body;

    if (!agentId) return res.status(400).json({ error: "agentId is required" });
    if (!agentType) return res.status(400).json({ error: "agentType is required" });

    let owner: string;
    let encryptedKey: string | undefined;

    if (mode === "self-custody") {
      if (!ownerAddress) return res.status(400).json({ error: "ownerAddress required for self-custody mode" });
      owner = ownerAddress;
    } else {
      // Managed mode: generate a new keypair
      const agentWallet = ethers.Wallet.createRandom();
      owner = agentWallet.address;
      // In production: use KMS. For now, base64 encode.
      encryptedKey = Buffer.from(JSON.stringify({
        key: agentWallet.privateKey,
        agent: agentId,
        ts: Date.now(),
      })).toString("base64");
    }

    // Generate deterministic salt
    const salt = ethers.keccak256(ethers.toUtf8Bytes(`spraay-agent-${agentId}-${Date.now()}`));

    // Deploy via factory
    const factory = getFactory();
    const tx = await factory.createWallet(owner, agentId, agentType, salt);
    const receipt = await tx.wait();

    // Parse WalletCreated event
    let walletAddress = "";
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed?.name === "WalletCreated") {
          walletAddress = parsed.args[0];
          break;
        }
      } catch { /* skip non-matching logs */ }
    }

    // If we couldn't parse the event, check internal txs
    if (!walletAddress) {
      // Fallback: get from factory registry
      const total = await factory.totalWallets();
      if (total > 0n) {
        walletAddress = await factory.walletAt(Number(total) - 1);
      }
    }

    // Store in Supabase
    try {
      const sb = getSupabase();
      await sb.from("agent_wallets").insert({
        wallet_address: walletAddress,
        owner_address: owner,
        agent_id: agentId,
        agent_type: agentType,
        mode,
        chain_id: CHAIN_ID,
        deploy_tx: tx.hash,
      });

      if (mode === "managed" && encryptedKey) {
        await sb.from("managed_keys").insert({
          wallet_address: walletAddress,
          encrypted_key: encryptedKey,
        });
      }
    } catch (dbErr: any) {
      console.warn("Supabase insert warning:", dbErr.message);
    }

    return res.json({
      status: "created",
      wallet: {
        walletAddress,
        ownerAddress: owner,
        encryptedKey: mode === "managed" ? encryptedKey : undefined,
        txHash: tx.hash,
        chainId: CHAIN_ID,
        agentId,
        agentType,
        mode,
      },
    });
  } catch (err: any) {
    console.error("agent-wallet/provision error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/v1/agent-wallet/session-key ───────────
// Adds a session key with spending limits to an agent wallet.

export async function agentWalletSessionKeyHandler(req: Request, res: Response) {
  try {
    const { walletAddress, sessionKeyAddress, spendLimitEth, durationHours, allowedTargets = [] } = req.body;

    if (!walletAddress || !sessionKeyAddress || !spendLimitEth || !durationHours) {
      return res.status(400).json({ error: "walletAddress, sessionKeyAddress, spendLimitEth, durationHours required" });
    }

    const wallet = new ethers.Contract(walletAddress, WALLET_ABI, getSigner());
    const spendLimitWei = ethers.parseEther(spendLimitEth.toString());
    const validUntil = Math.floor(Date.now() / 1000) + (durationHours * 3600);

    const tx = await wallet.addSessionKey(sessionKeyAddress, spendLimitWei, validUntil, allowedTargets);
    await tx.wait();

    const expiresAt = new Date(validUntil * 1000).toISOString();

    // Log in Supabase
    try {
      const sb = getSupabase();
      await sb.from("session_keys").insert({
        wallet_address: walletAddress,
        session_key: sessionKeyAddress,
        spend_limit_wei: spendLimitWei.toString(),
        valid_until: validUntil,
        allowed_targets: allowedTargets,
        tx_hash: tx.hash,
      });
    } catch (dbErr: any) {
      console.warn("Supabase session_keys insert warning:", dbErr.message);
    }

    return res.json({
      status: "created",
      session: {
        txHash: tx.hash,
        sessionKey: sessionKeyAddress,
        spendLimit: spendLimitEth,
        expiresAt,
        allowedTargets,
      },
    });
  } catch (err: any) {
    console.error("agent-wallet/session-key error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/v1/agent-wallet/info ───────────────────
// Returns wallet info including balance, metadata, session keys.

export async function agentWalletInfoHandler(req: Request, res: Response) {
  try {
    const address = req.query.address as string;
    if (!address) return res.status(400).json({ error: "address query param required" });

    const provider = getProvider();
    const wallet = new ethers.Contract(address, WALLET_ABI, provider);

    const [ownerAddr, metadata, balance, sessionKeyAddrs] = await Promise.all([
      wallet.owner(),
      wallet.getAgentMetadata(),
      provider.getBalance(address),
      wallet.getSessionKeys(),
    ]);

    const sessionKeys = await Promise.all(
      sessionKeyAddrs.map(async (skAddr: string) => {
        const [valid, remainingSpend, expiry] = await wallet.getSessionKeyInfo(skAddr);
        return {
          address: skAddr,
          valid,
          remainingSpend: ethers.formatEther(remainingSpend),
          expiry: new Date(Number(expiry) * 1000).toISOString(),
        };
      })
    );

    return res.json({
      status: "ok",
      wallet: {
        address,
        owner: ownerAddr,
        agentId: metadata.agentId,
        agentType: metadata.agentType,
        balanceEth: ethers.formatEther(balance),
        sessionKeys,
        chainId: CHAIN_ID,
      },
    });
  } catch (err: any) {
    console.error("agent-wallet/info error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/v1/agent-wallet/revoke-key ────────────
// Revokes a session key immediately.

export async function agentWalletRevokeKeyHandler(req: Request, res: Response) {
  try {
    const { walletAddress, sessionKeyAddress } = req.body;
    if (!walletAddress || !sessionKeyAddress) {
      return res.status(400).json({ error: "walletAddress and sessionKeyAddress required" });
    }

    const wallet = new ethers.Contract(walletAddress, WALLET_ABI, getSigner());
    const tx = await wallet.revokeSessionKey(sessionKeyAddress);
    await tx.wait();

    // Update Supabase
    try {
      const sb = getSupabase();
      await sb.from("session_keys")
        .update({ revoked: true, revoked_at: new Date().toISOString() })
        .eq("wallet_address", walletAddress)
        .eq("session_key", sessionKeyAddress);
    } catch (dbErr: any) {
      console.warn("Supabase revoke update warning:", dbErr.message);
    }

    return res.json({ status: "revoked", txHash: tx.hash });
  } catch (err: any) {
    console.error("agent-wallet/revoke-key error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/v1/agent-wallet/predict ────────────────
// Predict wallet address before deploying (free endpoint).

export async function agentWalletPredictHandler(req: Request, res: Response) {
  try {
    const ownerAddress = req.query.ownerAddress as string;
    const agentId = req.query.agentId as string;
    if (!ownerAddress || !agentId) {
      return res.status(400).json({ error: "ownerAddress and agentId query params required" });
    }

    const salt = ethers.keccak256(ethers.toUtf8Bytes(`spraay-agent-${agentId}-${Date.now()}`));
    const factory = getFactory();
    const predicted = await factory.predictWalletAddress(ownerAddress, salt);

    return res.json({ status: "ok", predictedAddress: predicted, note: "Address is deterministic based on salt + owner" });
  } catch (err: any) {
    console.error("agent-wallet/predict error:", err.message);
    return res.status(500).json({ error: err.message });
  }
}
