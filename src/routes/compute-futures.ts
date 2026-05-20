// ============================================
// src/routes/compute-futures.ts
// Spraay Compute Futures — On-Chain Escrow
// ============================================
// Contract: SpraayComputeFutures on Base mainnet
// - Agent deposits USDC via approve() + deposit() on the contract
// - Gateway calls drawdown() after each inference
// - Agent calls refund() directly on the contract — Spraay can't block it
// - Spraay NEVER holds agent funds
//
// 6 endpoints:
//   POST /api/v1/compute-futures/deposit    — build approve+deposit tx ($0.01 x402 fee)
//   GET  /api/v1/compute-futures/balance    — read on-chain balance ($0.001)
//   POST /api/v1/compute-futures/execute    — run compute, drawdown from contract ($0.001)
//   GET  /api/v1/compute-futures/history    — usage ledger from Supabase ($0.002)
//   POST /api/v1/compute-futures/refund     — instructions to refund directly on-chain ($0.01)
//   GET  /api/v1/compute-futures/pricing    — tier discounts and per-model costs ($0.001)

import { Request, Response } from "express";
import { ethers, isAddress, parseUnits, formatUnits, Contract, JsonRpcProvider, Wallet } from "ethers";
import { trackRequest } from "./health.js";
import { computeFuturesDb } from "../db.js";
import {
  COMPUTE_JOBS, BATCH_DISCOUNT,
  isValidJobType, resolveModel,
  ComputeJobType,
} from "../config/compute-models.js";
import {
  chatCompletion,
  generateEmbeddings,
  imageGeneration,
  videoGeneration,
  textToSpeech,
  speechToText,
} from "../services/compute-router.js";

// ── Contract Config ───────────────────────────────────────────────

const FUTURES_CONTRACT = process.env.COMPUTE_FUTURES_CONTRACT || "0xaf4e43d512c73c6731769620ca6b73f0fcff9118";
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const OPERATOR_KEY = process.env.FACILITATOR_PRIVATE_KEY || process.env.AGENT_WALLET_DEPLOYER_KEY || "";
const GATEWAY_ADDRESS = process.env.PAY_TO_ADDRESS || "0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8";

const FUTURES_ABI = [
  "function deposit(uint256 amount) external",
  "function drawdown(address depositor, uint256 amount) external",
  "function refund() external",
  "function refundPartial(uint256 amount) external",
  "function getAccount(address depositor) external view returns (uint256 balance, uint256 deposited, uint256 totalDrawn, uint256 totalRefunded, uint256 jobCount, uint8 tier, uint256 discountBps)",
  "function balanceOf(address depositor) external view returns (uint256)",
  "function getDiscount(uint8 tier) external pure returns (uint256)",
  "function totalDeposits() external view returns (uint256)",
  "function depositorCount() external view returns (uint256)",
  "function operator() external view returns (address)",
];

const USDC_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// Tier labels
const TIER_NAMES: Record<number, string> = { 0: "starter", 1: "builder", 2: "scale", 3: "enterprise" };
const TIER_LABELS: Record<number, string> = { 0: "No discount", 1: "5% discount", 2: "10% discount", 3: "15% discount" };

// Lazy init
let _provider: JsonRpcProvider | null = null;
let _signer: Wallet | null = null;
let _contract: Contract | null = null;
let _readContract: Contract | null = null;

function getProvider() {
  if (!_provider) _provider = new JsonRpcProvider(BASE_RPC);
  return _provider;
}

function getSigner() {
  if (!_signer) {
    if (!OPERATOR_KEY) throw new Error("FACILITATOR_PRIVATE_KEY or AGENT_WALLET_DEPLOYER_KEY not set");
    _signer = new Wallet(OPERATOR_KEY, getProvider());
  }
  return _signer;
}

function getContract() {
  if (!_contract) _contract = new Contract(FUTURES_CONTRACT, FUTURES_ABI, getSigner());
  return _contract;
}

function getReadContract() {
  if (!_readContract) _readContract = new Contract(FUTURES_CONTRACT, FUTURES_ABI, getProvider());
  return _readContract;
}

// ── 1. POST /api/v1/compute-futures/deposit ───────────────────────

export async function computeFuturesDepositHandler(req: Request, res: Response) {
  try {
    const { depositor, amount } = req.body;

    if (!depositor || !amount) {
      return res.status(400).json({
        error: "Missing required fields",
        required: { depositor: "0x... (your wallet address)", amount: "USDC amount to deposit (e.g. '50')" },
        howItWorks: [
          "1. You call approve() on USDC to allow the contract to spend your tokens",
          "2. You call deposit() on the SpraayComputeFutures contract",
          "3. The contract holds your USDC — Spraay never touches it",
          "4. Use /compute-futures/execute to run inference, cost is deducted on-chain",
          "5. Call refund() on the contract anytime to withdraw your remaining balance",
        ],
        contract: FUTURES_CONTRACT,
        usdc: USDC_ADDRESS,
        basescan: `https://basescan.org/address/${FUTURES_CONTRACT}`,
        example: { depositor: "0xYourAddress", amount: "50" },
      });
    }

    if (!isAddress(depositor)) {
      return res.status(400).json({ error: "Invalid depositor address" });
    }

    const depositFloat = parseFloat(amount);
    if (isNaN(depositFloat) || depositFloat < 1) {
      return res.status(400).json({ error: "Minimum deposit is $1 USDC" });
    }

    const amountRaw = parseUnits(amount, USDC_DECIMALS);

    // Build the two transactions the agent needs to sign and submit:
    // 1. approve() on USDC
    // 2. deposit() on SpraayComputeFutures
    const usdcInterface = new ethers.Interface(USDC_ABI);
    const futuresInterface = new ethers.Interface(FUTURES_ABI);

    const approveTx = {
      to: USDC_ADDRESS,
      data: usdcInterface.encodeFunctionData("approve", [FUTURES_CONTRACT, amountRaw]),
      value: "0x0",
      chainId: 8453,
      description: `Approve SpraayComputeFutures to spend ${amount} USDC`,
    };

    const depositTx = {
      to: FUTURES_CONTRACT,
      data: futuresInterface.encodeFunctionData("deposit", [amountRaw]),
      value: "0x0",
      chainId: 8453,
      description: `Deposit ${amount} USDC into compute futures escrow`,
    };

    trackRequest("compute_futures_deposit");

    return res.json({
      status: "sign_required",
      message: `Sign and submit these 2 transactions to deposit ${amount} USDC into the on-chain escrow.`,
      transactions: [approveTx, depositTx],
      contract: {
        address: FUTURES_CONTRACT,
        basescan: `https://basescan.org/address/${FUTURES_CONTRACT}`,
        note: "The contract holds your USDC. Spraay never touches it. You can call refund() directly on the contract at any time.",
      },
      tiers: [
        { name: "starter",    minDeposit: "$1",   discount: "0%" },
        { name: "builder",    minDeposit: "$10",  discount: "5%" },
        { name: "scale",      minDeposit: "$50",  discount: "10%" },
        { name: "enterprise", minDeposit: "$200", discount: "15%" },
      ],
      afterDeposit: {
        execute: "POST /api/v1/compute-futures/execute",
        balance: `GET /api/v1/compute-futures/balance?address=${depositor}`,
        refund: `Call refund() directly on ${FUTURES_CONTRACT}`,
      },
      _gateway: { provider: "spraay-x402", version: "3.8.1", endpoint: "POST /api/v1/compute-futures/deposit" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[compute-futures/deposit]", error.message);
    return res.status(500).json({ error: "Failed to build deposit transactions", details: error.message });
  }
}

// ── 2. GET /api/v1/compute-futures/balance ────────────────────────

export async function computeFuturesBalanceHandler(req: Request, res: Response) {
  try {
    const address = (req.query.address || req.query.id) as string;
    if (!address || !isAddress(address)) {
      return res.status(400).json({
        error: "address query param required",
        example: "/api/v1/compute-futures/balance?address=0xYourAddress",
      });
    }

    const contract = getReadContract();
    const [balance, deposited, totalDrawn, totalRefunded, jobCount, tier, discountBps] =
      await contract.getAccount(address);

    const balanceFormatted = formatUnits(balance, USDC_DECIMALS);
    const depositedFormatted = formatUnits(deposited, USDC_DECIMALS);
    const drawnFormatted = formatUnits(totalDrawn, USDC_DECIMALS);
    const refundedFormatted = formatUnits(totalRefunded, USDC_DECIMALS);

    trackRequest("compute_futures_balance");

    return res.json({
      address,
      balance: `${balanceFormatted} USDC`,
      deposited: `${depositedFormatted} USDC`,
      totalDrawn: `${drawnFormatted} USDC`,
      totalRefunded: `${refundedFormatted} USDC`,
      jobCount: Number(jobCount),
      tier: TIER_NAMES[Number(tier)] || "starter",
      discount: TIER_LABELS[Number(tier)] || "No discount",
      discountBps: Number(discountBps),
      contract: FUTURES_CONTRACT,
      source: "on-chain",
      _gateway: { provider: "spraay-x402", version: "3.8.1" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to read on-chain balance", details: error.message });
  }
}

// ── 3. POST /api/v1/compute-futures/execute ───────────────────────

export async function computeFuturesExecuteHandler(req: Request, res: Response) {
  try {
    const { depositor, type, model: requestedModel, ...jobParams } = req.body;

    if (!depositor || !type) {
      return res.status(400).json({
        error: "depositor (address) and type are required",
        types: ["text-inference", "image-generation", "video-generation", "text-to-speech", "speech-to-text", "embeddings"],
        example: { depositor: "0xYourAddress", type: "text-inference", messages: [{ role: "user", content: "Hello" }] },
      });
    }

    if (!isAddress(depositor)) return res.status(400).json({ error: "Invalid depositor address" });
    if (!isValidJobType(type)) {
      return res.status(400).json({ error: `Invalid compute type: ${type}`, valid: ["text-inference", "image-generation", "video-generation", "text-to-speech", "speech-to-text", "embeddings"] });
    }

    // Read on-chain balance
    const readContract = getReadContract();
    const [balance, , , , , tier, discountBps] = await readContract.getAccount(depositor);
    const balanceFloat = parseFloat(formatUnits(balance, USDC_DECIMALS));

    if (balanceFloat <= 0) {
      return res.status(402).json({ error: "No compute credits. Deposit USDC first.", contract: FUTURES_CONTRACT });
    }

    // Resolve model and price
    const modelDef = resolveModel(type as ComputeJobType, requestedModel);
    if (!modelDef) {
      return res.status(400).json({ error: `Model '${requestedModel}' not available for ${type}. Use /compute/models to see options.` });
    }

    // Apply tier discount
    const discountRate = Number(discountBps) / 10000;
    const effectivePrice = modelDef.price * (1 - discountRate);

    if (effectivePrice > balanceFloat) {
      return res.status(402).json({
        error: "Insufficient compute credits",
        required: `$${effectivePrice.toFixed(4)} USDC`,
        balanceRemaining: `$${balanceFloat.toFixed(4)} USDC`,
        suggestion: "Deposit more credits or choose a cheaper model.",
      });
    }

    // Execute the compute job
    let result: any;
    try {
      switch (type) {
        case "text-inference":
          if (!jobParams.messages || !Array.isArray(jobParams.messages))
            return res.status(400).json({ error: "messages array required for text-inference" });
          result = await chatCompletion({ model: modelDef, messages: jobParams.messages, max_tokens: jobParams.max_tokens || 1024, temperature: jobParams.temperature ?? 0.7, stream: false });
          break;
        case "image-generation":
          if (!jobParams.prompt) return res.status(400).json({ error: "prompt required" });
          result = await imageGeneration({ model: modelDef, prompt: jobParams.prompt, width: jobParams.width || 1024, height: jobParams.height || 1024, num_outputs: jobParams.num_outputs || 1 });
          break;
        case "video-generation":
          if (!jobParams.prompt) return res.status(400).json({ error: "prompt required" });
          result = await videoGeneration({ model: modelDef, prompt: jobParams.prompt, duration_seconds: jobParams.duration_seconds || 4 });
          break;
        case "text-to-speech":
          if (!jobParams.text) return res.status(400).json({ error: "text required" });
          result = await textToSpeech({ model: modelDef, text: jobParams.text, language: jobParams.language || "en" });
          break;
        case "speech-to-text":
          if (!jobParams.audio_url) return res.status(400).json({ error: "audio_url required" });
          result = await speechToText({ model: modelDef, audio_url: jobParams.audio_url });
          break;
        case "embeddings":
          if (!jobParams.input) return res.status(400).json({ error: "input required" });
          result = await generateEmbeddings({ model: modelDef, input: jobParams.input });
          break;
        default:
          return res.status(400).json({ error: `Unsupported type: ${type}` });
      }
    } catch (computeErr: any) {
      return res.status(502).json({
        error: "Compute failed (balance NOT charged)",
        details: computeErr.message,
        balanceRemaining: `${balanceFloat.toFixed(4)} USDC`,
      });
    }

    // Drawdown on-chain (operator calls contract)
    const drawdownAmount = parseUnits(effectivePrice.toFixed(USDC_DECIMALS), USDC_DECIMALS);
    let txHash: string;
    try {
      const contract = getContract();
      const tx = await contract.drawdown(depositor, drawdownAmount);
      await tx.wait();
      txHash = tx.hash;
    } catch (drawdownErr: any) {
      // Compute succeeded but drawdown failed — log for manual reconciliation
      console.error("[compute-futures/execute] DRAWDOWN FAILED — compute delivered but not charged:", drawdownErr.message);
      return res.status(500).json({
        error: "Compute succeeded but on-chain drawdown failed. You were NOT charged. Please retry.",
        details: drawdownErr.message,
        compute: { type, model: modelDef.id, result },
      });
    }

    // Read updated balance
    const [newBalance] = await readContract.getAccount(depositor);
    const newBalanceFormatted = formatUnits(newBalance, USDC_DECIMALS);

    // Log to Supabase for history
    await computeFuturesDb.logUsage({
      futuresId: depositor,
      jobType: type,
      model: modelDef.id,
      modelLabel: modelDef.label,
      basePrice: modelDef.price.toFixed(6),
      discount: discountRate.toFixed(4),
      effectivePrice: effectivePrice.toFixed(6),
      balanceBefore: balanceFloat.toFixed(6),
      balanceAfter: newBalanceFormatted,
      timestamp: new Date().toISOString(),
    }).catch((err: any) => console.error("[compute-futures] usage log failed:", err.message));

    trackRequest("compute_futures_execute");

    return res.json({
      status: "completed",
      billing: {
        basePrice: `$${modelDef.price.toFixed(4)}`,
        discount: discountRate > 0 ? `${(discountRate * 100).toFixed(0)}%` : "none",
        charged: `$${effectivePrice.toFixed(4)} USDC`,
        balanceRemaining: `$${newBalanceFormatted} USDC`,
        drawdownTx: txHash,
        settlement: "on-chain",
      },
      compute: {
        type,
        model: modelDef.id,
        modelLabel: modelDef.label,
        provider: result.provider || modelDef.provider,
        result,
      },
      contract: FUTURES_CONTRACT,
      _gateway: { provider: "spraay-x402", version: "3.8.1", endpoint: "POST /api/v1/compute-futures/execute" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[compute-futures/execute]", error.message);
    return res.status(500).json({ error: "Compute futures execution failed", details: error.message });
  }
}

// ── 4. GET /api/v1/compute-futures/history ────────────────────────

export async function computeFuturesHistoryHandler(req: Request, res: Response) {
  try {
    const address = (req.query.address || req.query.id) as string;
    const limit = parseInt(req.query.limit as string) || 50;
    if (!address) return res.status(400).json({ error: "address query param required" });

    // On-chain summary
    const readContract = getReadContract();
    const [balance, deposited, totalDrawn, totalRefunded, jobCount, tier] =
      await readContract.getAccount(address);

    // Off-chain usage ledger
    const usage = await computeFuturesDb.getUsage(address, limit);

    trackRequest("compute_futures_history");

    return res.json({
      address,
      onChain: {
        balance: `${formatUnits(balance, USDC_DECIMALS)} USDC`,
        deposited: `${formatUnits(deposited, USDC_DECIMALS)} USDC`,
        totalDrawn: `${formatUnits(totalDrawn, USDC_DECIMALS)} USDC`,
        totalRefunded: `${formatUnits(totalRefunded, USDC_DECIMALS)} USDC`,
        jobCount: Number(jobCount),
        tier: TIER_NAMES[Number(tier)] || "starter",
      },
      usage,
      contract: FUTURES_CONTRACT,
      _gateway: { provider: "spraay-x402", version: "3.8.1" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch history", details: error.message });
  }
}

// ── 5. POST /api/v1/compute-futures/refund ────────────────────────

export async function computeFuturesRefundHandler(req: Request, res: Response) {
  try {
    const { depositor } = req.body;

    if (!depositor || !isAddress(depositor)) {
      return res.status(400).json({
        error: "depositor address required",
        example: { depositor: "0xYourAddress" },
      });
    }

    // Read on-chain balance
    const readContract = getReadContract();
    const [balance] = await readContract.getAccount(depositor);
    const balanceFormatted = formatUnits(balance, USDC_DECIMALS);

    if (Number(balance) === 0) {
      return res.status(400).json({ error: "No balance to refund" });
    }

    // Build the refund transaction for the agent to sign directly
    const futuresInterface = new ethers.Interface(FUTURES_ABI);
    const refundTx = {
      to: FUTURES_CONTRACT,
      data: futuresInterface.encodeFunctionData("refund"),
      value: "0x0",
      chainId: 8453,
      description: `Refund ${balanceFormatted} USDC from compute futures escrow`,
    };

    trackRequest("compute_futures_refund");

    return res.json({
      status: "sign_required",
      message: `Sign and submit this transaction to refund ${balanceFormatted} USDC. Only you (the depositor) can execute this — Spraay cannot block your refund.`,
      refundAmount: `${balanceFormatted} USDC`,
      transaction: refundTx,
      contract: {
        address: FUTURES_CONTRACT,
        basescan: `https://basescan.org/address/${FUTURES_CONTRACT}`,
        note: "You can also call refund() directly on the contract via Basescan or any wallet. No gateway permission needed.",
      },
      _gateway: { provider: "spraay-x402", version: "3.8.1", endpoint: "POST /api/v1/compute-futures/refund" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("[compute-futures/refund]", error.message);
    return res.status(500).json({ error: "Failed to build refund transaction", details: error.message });
  }
}

// ── 6. GET /api/v1/compute-futures/pricing ────────────────────────

export async function computeFuturesPricingHandler(req: Request, res: Response) {
  try {
    // Read contract stats
    let totalDeposits = "N/A";
    let depositorCount = "N/A";
    try {
      const readContract = getReadContract();
      const total = await readContract.totalDeposits();
      const count = await readContract.depositorCount();
      totalDeposits = `${formatUnits(total, USDC_DECIMALS)} USDC`;
      depositorCount = count.toString();
    } catch (_) {}

    // Build pricing table from compute models
    const pricing: Record<string, any[]> = {};
    for (const [jobType, def] of Object.entries(COMPUTE_JOBS)) {
      pricing[jobType] = def.models.map((m: any) => ({
        model: m.id,
        label: m.label,
        provider: m.provider,
        basePrice: `$${m.price.toFixed(3)}`,
        tierPrices: {
          starter: `$${m.price.toFixed(4)} (0% off)`,
          builder: `$${(m.price * 0.95).toFixed(4)} (5% off)`,
          scale: `$${(m.price * 0.90).toFixed(4)} (10% off)`,
          enterprise: `$${(m.price * 0.85).toFixed(4)} (15% off)`,
        },
      }));
    }

    trackRequest("compute_futures_pricing");

    return res.json({
      tiers: [
        { name: "starter",    minDeposit: "$1 USDC",   discount: "0%" },
        { name: "builder",    minDeposit: "$10 USDC",  discount: "5%" },
        { name: "scale",      minDeposit: "$50 USDC",  discount: "10%" },
        { name: "enterprise", minDeposit: "$200 USDC", discount: "15%" },
      ],
      pricing,
      batchDiscount: `${(BATCH_DISCOUNT * 100).toFixed(0)}% (via /compute/batch)`,
      contract: {
        address: FUTURES_CONTRACT,
        totalDeposits,
        depositorCount,
        basescan: `https://basescan.org/address/${FUTURES_CONTRACT}`,
      },
      howItWorks: [
        "1. POST /compute-futures/deposit → get approve+deposit transactions to sign",
        "2. Sign and submit both transactions → USDC is held by the contract",
        "3. POST /compute-futures/execute → run inference, cost deducted on-chain",
        "4. Call refund() on the contract anytime to withdraw unused balance",
      ],
      _gateway: { provider: "spraay-x402", version: "3.8.1", endpoint: "GET /api/v1/compute-futures/pricing" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "Failed to fetch pricing", details: error.message });
  }
}
