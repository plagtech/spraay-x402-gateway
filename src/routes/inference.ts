import { Request, Response } from "express";
import { JsonRpcProvider, Contract, formatUnits, formatEther, Interface } from "ethers";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const BASESCAN_API = "https://api.basescan.org/api";
const BASESCAN_KEY = process.env.BASESCAN_API_KEY || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const CHAIN_ID = 8453;

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

const KNOWN_TOKENS: Record<string, { address: string; symbol: string; decimals: number }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
};

// ============================================
// AI HELPER
// ============================================

async function aiInfer(systemPrompt: string, userPrompt: string, jsonMode = true): Promise<any> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    }),
  });

  if (!res.ok) throw new Error(`AI inference error: ${res.status}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";

  if (jsonMode) {
    try {
      const cleaned = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      return JSON.parse(cleaned);
    } catch {
      return { raw: text };
    }
  }
  return text;
}

// ============================================
// ON-CHAIN DATA HELPERS
// ============================================

async function getWalletProfile(address: string) {
  const provider = new JsonRpcProvider(RPC_URL);

  const [ethBalance, nonce, code] = await Promise.all([
    provider.getBalance(address),
    provider.getTransactionCount(address),
    provider.getCode(address),
  ]);

  const isContract = code !== "0x";

  // Token balances
  const balances: Record<string, string> = { ETH: formatEther(ethBalance) };
  for (const [sym, info] of Object.entries(KNOWN_TOKENS)) {
    try {
      const erc20 = new Contract(info.address, ERC20_ABI, provider);
      const bal: bigint = await erc20.balanceOf(address);
      if (bal > 0n) balances[sym] = formatUnits(bal, info.decimals);
    } catch { /* skip */ }
  }

  return { address, isContract, ethBalance: formatEther(ethBalance), nonce, balances, codeSize: isContract ? code.length : 0 };
}

async function getRecentTxs(address: string, count = 10) {
  if (!BASESCAN_KEY) return [];
  try {
    const url = `${BASESCAN_API}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=${count}&sort=desc&apikey=${BASESCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "1" && Array.isArray(data.result)) {
      return data.result.map((tx: any) => ({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        value: formatEther(tx.value || "0"),
        gasUsed: tx.gasUsed,
        isError: tx.isError === "1",
        methodId: tx.methodId || tx.input?.substring(0, 10) || "0x",
        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        direction: tx.from.toLowerCase() === address.toLowerCase() ? "outgoing" : "incoming",
      }));
    }
  } catch { /* non-critical */ }
  return [];
}

async function getContractABI(address: string): Promise<string | null> {
  if (!BASESCAN_KEY) return null;
  try {
    const url = `${BASESCAN_API}?module=contract&action=getabi&address=${address}&apikey=${BASESCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "1" && data.result) return data.result;
  } catch { /* non-critical */ }
  return null;
}

async function getContractSource(address: string): Promise<any> {
  if (!BASESCAN_KEY) return null;
  try {
    const url = `${BASESCAN_API}?module=contract&action=getsourcecode&address=${address}&apikey=${BASESCAN_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === "1" && data.result?.[0]) {
      const src = data.result[0];
      return {
        contractName: src.ContractName || "Unknown",
        compiler: src.CompilerVersion || "Unknown",
        isProxy: src.Proxy === "1",
        implementation: src.Implementation || null,
        isVerified: src.ABI !== "Contract source code not verified",
      };
    }
  } catch { /* non-critical */ }
  return null;
}

// ============================================
// FORMAT HELPER
// ============================================

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * POST /api/v1/inference/classify-address
 *
 * Body: { address: string }
 *
 * Returns AI-powered wallet classification with risk scoring.
 */
export async function classifyAddressHandler(req: Request, res: Response) {
  try {
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({
        error: "address is required",
        example: { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
      });
    }

    // Gather on-chain data
    const [profile, recentTxs] = await Promise.all([
      getWalletProfile(address),
      getRecentTxs(address, 20),
    ]);

    const systemPrompt = `You are a blockchain intelligence analyst. Classify wallet addresses based on on-chain data.
Return ONLY a JSON object with these fields:
{
  "classification": "one of: whale, retail, exchange, defi-power-user, mev-bot, contract, fresh-wallet, dormant, airdrop-farmer, developer",
  "riskLevel": "low | medium | high | critical",
  "riskScore": 0-100 (0=safe, 100=dangerous),
  "riskFactors": ["list of risk signals found"],
  "safetyFactors": ["list of positive signals"],
  "labels": ["list of relevant labels like: high-value, active-trader, potential-scam, known-protocol, etc"],
  "summary": "1-2 sentence human-readable summary",
  "interactionSafety": "safe | caution | avoid"
}`;

    const userPrompt = `Classify this Base chain wallet:

Address: ${address}
Is Contract: ${profile.isContract}
Code Size: ${profile.codeSize} bytes
ETH Balance: ${profile.ethBalance}
Token Balances: ${JSON.stringify(profile.balances)}
Transaction Count: ${profile.nonce}
Recent Transactions (last 20): ${JSON.stringify(recentTxs.slice(0, 20))}

Analyze the wallet's behavior, holdings, transaction patterns, and classify it.`;

    const analysis = await aiInfer(systemPrompt, userPrompt);

    trackRequest("inference_classify_address");

    return res.json({
      address,
      onChainProfile: {
        isContract: profile.isContract,
        ethBalance: profile.ethBalance,
        balances: profile.balances,
        transactionCount: profile.nonce,
        recentTxCount: recentTxs.length,
      },
      classification: analysis,
      _gateway: { provider: "spraay-x402", version: "2.9.0", endpoint: "POST /api/v1/inference/classify-address", model: "gpt-4o-mini" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Classify address error:", error.message);
    return res.status(500).json({ error: "Failed to classify address", details: error.message });
  }
}

/**
 * POST /api/v1/inference/classify-tx
 *
 * Body: { hash: string }
 *
 * Returns AI-powered transaction classification with risk scoring.
 */
export async function classifyTxHandler(req: Request, res: Response) {
  try {
    const { hash } = req.body;
    if (!hash) {
      return res.status(400).json({
        error: "hash is required",
        example: { hash: "0xabc123..." },
      });
    }

    const provider = new JsonRpcProvider(RPC_URL);
    const [tx, receipt] = await Promise.all([
      provider.getTransaction(hash),
      provider.getTransactionReceipt(hash),
    ]);

    if (!tx) return res.status(404).json({ error: `Transaction not found: ${hash}` });

    // Decode basic info
    const value = formatEther(tx.value || 0n);
    const methodId = tx.data?.substring(0, 10) || "0x";
    const isContractCall = tx.data && tx.data.length > 2;
    const gasUsed = receipt ? receipt.gasUsed.toString() : "pending";
    const success = receipt ? receipt.status === 1 : null;

    // Check if destination is a contract
    let destCode = "0x";
    if (tx.to) {
      try { destCode = await provider.getCode(tx.to); } catch { /* skip */ }
    }
    const destIsContract = destCode !== "0x";

    // Decode logs
    const logSummary = (receipt?.logs || []).slice(0, 10).map((log) => ({
      address: log.address,
      topics: log.topics.slice(0, 2),
      dataLength: log.data.length,
    }));

    const systemPrompt = `You are a blockchain transaction analyst. Classify transactions based on on-chain data.
Return ONLY a JSON object with these fields:
{
  "type": "one of: eth-transfer, erc20-transfer, erc20-approve, swap, liquidity-add, liquidity-remove, nft-mint, nft-transfer, bridge, batch-payment, contract-deploy, contract-call, governance-vote, staking, unstaking, claim, wrap, unwrap, unknown",
  "riskLevel": "low | medium | high | critical",
  "riskScore": 0-100,
  "riskFactors": ["list of risk signals"],
  "description": "1-2 sentence human-readable description of what this tx does",
  "valueFlow": { "from": "address", "to": "address", "amount": "value", "token": "symbol or ETH" },
  "protocolIdentified": "protocol name if recognized, or null",
  "flags": ["list of any flags: high-gas, failed, suspicious-approval, large-value, etc"]
}`;

    const userPrompt = `Classify this Base chain transaction:

Hash: ${hash}
From: ${tx.from}
To: ${tx.to || "CONTRACT CREATION"}
Value: ${value} ETH
Method ID: ${methodId}
Is Contract Call: ${isContractCall}
Destination Is Contract: ${destIsContract}
Gas Used: ${gasUsed}
Success: ${success}
Input Data Length: ${tx.data?.length || 0} bytes
Block: ${tx.blockNumber}
Log Count: ${receipt?.logs?.length || 0}
Log Summary: ${JSON.stringify(logSummary)}

Analyze the transaction and classify it.`;

    const analysis = await aiInfer(systemPrompt, userPrompt);

    trackRequest("inference_classify_tx");

    return res.json({
      hash,
      transaction: {
        from: tx.from,
        to: tx.to || "CONTRACT CREATION",
        value: `${value} ETH`,
        methodId,
        isContractCall,
        destIsContract,
        gasUsed,
        success,
        blockNumber: tx.blockNumber,
        logCount: receipt?.logs?.length || 0,
      },
      classification: analysis,
      _gateway: { provider: "spraay-x402", version: "2.9.0", endpoint: "POST /api/v1/inference/classify-tx", model: "gpt-4o-mini" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Classify tx error:", error.message);
    return res.status(500).json({ error: "Failed to classify transaction", details: error.message });
  }
}

/**
 * POST /api/v1/inference/explain-contract
 *
 * Body: { address: string }
 *
 * Returns AI-powered smart contract analysis.
 */
export async function explainContractHandler(req: Request, res: Response) {
  try {
    const { address } = req.body;
    if (!address) {
      return res.status(400).json({
        error: "address is required",
        example: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
        note: "Must be a verified contract on Base",
      });
    }

    const provider = new JsonRpcProvider(RPC_URL);
    const code = await provider.getCode(address);
    if (code === "0x") {
      return res.status(400).json({ error: "Address is not a contract (EOA)", address });
    }

    // Fetch ABI and source info
    const [abiStr, sourceInfo] = await Promise.all([
      getContractABI(address),
      getContractSource(address),
    ]);

    if (!abiStr || abiStr === "Contract source code not verified") {
      return res.status(400).json({
        error: "Contract is not verified on Basescan",
        address,
        note: "Only verified contracts can be explained. Unverified contracts are higher risk.",
        suggestion: "Check if this contract has a proxy — try the implementation address instead.",
      });
    }

    // Parse ABI to extract function signatures
    let functions: string[] = [];
    let events: string[] = [];
    try {
      const abi = JSON.parse(abiStr);
      const iface = new Interface(abi);
      iface.forEachFunction((fn) => {
        functions.push(`${fn.name}(${fn.inputs.map((i) => `${i.type} ${i.name}`).join(", ")}) → ${fn.outputs.map((o) => o.type).join(", ") || "void"} [${fn.stateMutability}]`);
      });
      iface.forEachEvent((ev) => {
        events.push(`${ev.name}(${ev.inputs.map((i) => `${i.indexed ? "indexed " : ""}${i.type} ${i.name}`).join(", ")})`);
      });
    } catch { /* use raw ABI */ }

    const systemPrompt = `You are a smart contract security analyst. Analyze contracts and explain them clearly.
Return ONLY a JSON object with these fields:
{
  "name": "contract name",
  "type": "one of: erc20-token, nft-collection, dex-router, dex-pool, lending-protocol, bridge, multisig, proxy, governance, staking, vault, payment-splitter, custom, unknown",
  "description": "2-3 sentence plain-English description of what this contract does",
  "keyFunctions": [{"name": "functionName", "purpose": "what it does", "risk": "none|low|medium|high"}],
  "securityNotes": ["list of security observations"],
  "riskLevel": "low | medium | high | critical",
  "riskScore": 0-100,
  "isUpgradeable": true/false,
  "hasOwnerPrivileges": true/false,
  "canPauseTransfers": true/false,
  "hasMintFunction": true/false,
  "interactionSafety": "safe | caution | avoid"
}`;

    const userPrompt = `Analyze this Base chain smart contract:

Address: ${address}
Contract Name: ${sourceInfo?.contractName || "Unknown"}
Compiler: ${sourceInfo?.compiler || "Unknown"}
Is Proxy: ${sourceInfo?.isProxy || false}
Implementation: ${sourceInfo?.implementation || "N/A"}
Code Size: ${code.length} bytes

Functions (${functions.length}):
${functions.slice(0, 40).join("\n")}

Events (${events.length}):
${events.slice(0, 20).join("\n")}

Analyze the contract's purpose, security properties, and risk level.`;

    const analysis = await aiInfer(systemPrompt, userPrompt);

    trackRequest("inference_explain_contract");

    return res.json({
      address,
      contractInfo: {
        name: sourceInfo?.contractName || "Unknown",
        isVerified: true,
        isProxy: sourceInfo?.isProxy || false,
        implementation: sourceInfo?.implementation || null,
        compiler: sourceInfo?.compiler || "Unknown",
        functionCount: functions.length,
        eventCount: events.length,
        codeSize: code.length,
      },
      analysis,
      basescanUrl: `https://basescan.org/address/${address}`,
      _gateway: { provider: "spraay-x402", version: "2.9.0", endpoint: "POST /api/v1/inference/explain-contract", model: "gpt-4o-mini" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Explain contract error:", error.message);
    return res.status(500).json({ error: "Failed to explain contract", details: error.message });
  }
}

/**
 * POST /api/v1/inference/summarize
 *
 * Body: { target: string, context?: string }
 *
 * target: wallet address, token address, tx hash, or ENS name
 * context: optional additional context ("governance", "defi", "security")
 *
 * Returns AI-generated intelligence briefing.
 */
export async function summarizeHandler(req: Request, res: Response) {
  try {
    const { target, context } = req.body;
    if (!target) {
      return res.status(400).json({
        error: "target is required",
        example: { target: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", context: "defi" },
        note: "target can be a wallet address, contract address, or tx hash",
      });
    }

    const provider = new JsonRpcProvider(RPC_URL);

    // Detect target type
    let targetType: "wallet" | "contract" | "transaction" = "wallet";
    let rawData: any = {};

    if (target.length === 66 && target.startsWith("0x")) {
      // Transaction hash
      targetType = "transaction";
      const [tx, receipt] = await Promise.all([
        provider.getTransaction(target),
        provider.getTransactionReceipt(target),
      ]);
      if (!tx) return res.status(404).json({ error: `Transaction not found: ${target}` });
      rawData = {
        from: tx.from,
        to: tx.to || "CONTRACT CREATION",
        value: formatEther(tx.value || 0n),
        methodId: tx.data?.substring(0, 10) || "0x",
        gasUsed: receipt?.gasUsed?.toString() || "pending",
        success: receipt ? receipt.status === 1 : null,
        blockNumber: tx.blockNumber,
        logCount: receipt?.logs?.length || 0,
      };
    } else if (target.startsWith("0x") && target.length === 42) {
      // Address — check if contract
      const code = await provider.getCode(target);
      if (code !== "0x") {
        targetType = "contract";
        const [sourceInfo, profile] = await Promise.all([
          getContractSource(target),
          getWalletProfile(target),
        ]);
        rawData = { ...profile, sourceInfo, codeSize: code.length };
      } else {
        targetType = "wallet";
        const [profile, txs] = await Promise.all([
          getWalletProfile(target),
          getRecentTxs(target, 15),
        ]);
        rawData = { ...profile, recentTransactions: txs };
      }
    } else {
      return res.status(400).json({ error: "Invalid target. Must be a 0x address (42 chars) or tx hash (66 chars)." });
    }

    const focusContext = context || "general";

    const systemPrompt = `You are a blockchain intelligence briefing system. Generate concise, actionable intelligence briefings.
Return ONLY a JSON object with these fields:
{
  "targetType": "${targetType}",
  "headline": "1-line summary (max 15 words)",
  "briefing": "3-5 sentence intelligence briefing covering key findings",
  "keyMetrics": [{"label": "metric name", "value": "metric value", "significance": "why it matters"}],
  "actionableInsights": ["list of 2-4 actionable insights or recommendations"],
  "riskAssessment": { "level": "low|medium|high|critical", "score": 0-100, "summary": "1 sentence" },
  "relatedEntities": ["list of notable related addresses or protocols identified"]
}`;

    const userPrompt = `Generate an intelligence briefing for this ${targetType} on Base chain.

Target: ${target}
Focus: ${focusContext}
Data: ${JSON.stringify(rawData)}

Provide a concise, actionable briefing.`;

    const briefing = await aiInfer(systemPrompt, userPrompt);

    trackRequest("inference_summarize");

    return res.json({
      target,
      targetType,
      context: focusContext,
      briefing,
      _gateway: { provider: "spraay-x402", version: "2.9.0", endpoint: "POST /api/v1/inference/summarize", model: "gpt-4o-mini" },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Summarize error:", error.message);
    return res.status(500).json({ error: "Failed to generate summary", details: error.message });
  }
}
