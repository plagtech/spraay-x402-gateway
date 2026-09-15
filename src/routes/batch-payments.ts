import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// ============ Contract ============

export const SPRAAY_FEE_BPS = 30; // 0.3% flat for everything

// ============ Settlement chains ============
//
// HARD ALLOWLIST. A chain is settleable here ONLY after its SprayContract
// runtime bytecode has been verified byte-identical to the Base deployment.
//
// The canonical address 0x08fA5D1c...E073 also exists on Unichain, Plasma,
// Robinhood Chain and BOB, and those chains appear in the *advertising*
// surfaces (validate-batch, chain-status, /api/v1/tokens, bridge). They are
// deliberately NOT here: a shared deploy address never implies shared runtime
// bytecode, and each chain gets its own verification ceremony before batches
// can settle on it.
//
// peaq (3338) qualified on 2026-09-15: Sourcify exact_match on creation and
// runtime, runtime keccak 0x7c4b82ffe3cccab5b886d57f868de66adc3aa3aaff54460f7d207ade4d942035
// — byte-identical to Base 0x1646452F...5eEC — feeBps 30, unpaused.

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

interface SettlementChain {
  key: string;
  name: string;
  chainId: number;
  contract: string;
  rpcUrl: string;
  /** Native-currency symbol, or null where native spraying is not enabled yet. */
  nativeSymbol: string | null;
  tokens: Record<string, TokenInfo>;
  /** Reverse lookup: lowercased token address → symbol. Built at module load. */
  addressToSymbol: Record<string, string>;
}

export const DEFAULT_BATCH_CHAIN = "base";

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
// peaq's quicknode*.peaq.xyz endpoints rate-limit at 15 req/s (JSON-RPC -32007),
// and this module calls eth_estimateGas once per paid request. publicnode is the
// default; set PEAQ_RPC_URL to https://quicknode3.peaq.xyz to switch.
const PEAQ_RPC_URL = process.env.PEAQ_RPC_URL || "https://peaq-rpc.publicnode.com";

const SETTLEMENT_CHAINS: Record<string, SettlementChain> = {
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    contract: "0x1646452F98E36A3c9Cfc3eDD8868221E207B5eEC",
    rpcUrl: BASE_RPC_URL,
    nativeSymbol: "ETH",
    // Convenience lookup — any ERC-20 address works, these are just shortcuts.
    tokens: {
      USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
      USDT: { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
      EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
      DAI:  { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI",  decimals: 18 },
      WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
    },
    addressToSymbol: {},
  },
  peaq: {
    key: "peaq",
    name: "peaq",
    chainId: 3338,
    contract: "0x08fA5D1c16CD6E2a16FC0E4839f262429959E073",
    rpcUrl: PEAQ_RPC_URL,
    // Native PEAQ spraying is not enabled in v1 — USDC only until each further
    // asset is dust-proven on this chain. sprayETH itself is proven on peaq.
    nativeSymbol: null,
    tokens: {
      // Circle-bridged USDC, 6 decimals — read on-chain, not from docs.
      USDC: { address: "0xbbA60da06c2c5424f03f7434542280FCAd453d10", symbol: "USDC", decimals: 6 },
      // USDT 0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949 (6dp) exists and reports
      // symbol "USDT", but no dust proof has exercised it. Deferred.
    },
    addressToSymbol: {},
  },
};

for (const chain of Object.values(SETTLEMENT_CHAINS)) {
  for (const [symbol, info] of Object.entries(chain.tokens)) {
    chain.addressToSymbol[info.address.toLowerCase()] = symbol;
  }
}

/** Settleable chain slugs, in declaration order. */
export const SETTLEMENT_CHAIN_KEYS = Object.keys(SETTLEMENT_CHAINS);

/**
 * Message for an unresolvable token symbol.
 *
 * Base's wording is pinned to the exact pre-peaq literal: /api/v1/batch/execute
 * is an NVIDIA-frozen path and a request that omits `chain` must answer
 * byte-identically to before. Other chains derive theirs from the token map.
 */
function unknownTokenError(tokenInput: string, chain: SettlementChain): string {
  if (chain.key === "base") {
    return `Unknown token "${tokenInput}". Use a symbol (USDC, USDT, DAI, EURC, ETH) or a token contract address.`;
  }
  const symbols = [...Object.keys(chain.tokens), ...(chain.nativeSymbol ? [chain.nativeSymbol] : [])];
  return `Unknown token "${tokenInput}" on ${chain.name}. Use a symbol (${symbols.join(", ")}) or a token contract address.`;
}

/** Resolve a caller-supplied chain slug against the allowlist. null = rejected. */
function resolveSettlementChain(input: unknown): SettlementChain | null {
  if (input === undefined || input === null || input === "") {
    return SETTLEMENT_CHAINS[DEFAULT_BATCH_CHAIN];
  }
  if (typeof input !== "string") return null;
  return SETTLEMENT_CHAINS[input.trim().toLowerCase()] ?? null;
}

// ============ ABI ============

const SPRAAY_ABI = [
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

const sprayInterface = new ethers.Interface(SPRAAY_ABI);

// ============ Token Resolution ============

/**
 * Resolve token input to address + decimals + symbol, within one settlement chain.
 * Accepts: symbol ("USDC"), address ("0x..."), or the chain's native symbol
 * ("ETH" on Base) for a native spray.
 */
function resolveToken(tokenInput: string, chain: SettlementChain): {
  address: string;
  decimals: number;
  symbol: string;
  isETH: boolean;
} {
  if (chain.nativeSymbol && (!tokenInput || tokenInput.toUpperCase() === chain.nativeSymbol)) {
    return {
      address: ethers.ZeroAddress,
      decimals: 18,
      symbol: chain.nativeSymbol,
      isETH: true,
    };
  }

  // Check by symbol
  const upper = tokenInput.toUpperCase();
  const known = chain.tokens[upper];
  if (known) {
    return {
      address: known.address,
      decimals: known.decimals,
      symbol: known.symbol,
      isETH: false,
    };
  }

  // Check by address
  if (tokenInput.startsWith("0x") && tokenInput.length === 42) {
    const sym = chain.addressToSymbol[tokenInput.toLowerCase()] || "ERC20";
    const knownByAddr = Object.values(chain.tokens).find(
      (t) => t.address.toLowerCase() === tokenInput.toLowerCase()
    );
    return {
      address: tokenInput,
      decimals: knownByAddr?.decimals || 18,
      symbol: sym,
      isETH: false,
    };
  }

  // Default: treat as unknown symbol, caller should provide address
  return {
    address: "",
    decimals: 18,
    symbol: tokenInput,
    isETH: false,
  };
}

// ============ Batch amount normalization ============

/** Thrown for bad batch input; handlers translate this to HTTP 400. */
class BatchInputError extends Error {
  readonly status = 400;
}

export interface NormalizedRecipient {
  recipient: string;
  amount: bigint; // raw base units
}

export interface ResolvedBatch {
  onchainRecipients: NormalizedRecipient[];
  totalRaw: bigint; // sum of all amounts, raw base units
}

/**
 * Normalize the two accepted body shapes into raw base-unit amounts.
 *
 * UNIT SEMANTICS DIFFER BY SHAPE — this is deliberate, and the shape is detected
 * from `typeof recipients[0]`:
 *
 *   • Flat format   — recipients: string[] (addresses), amounts: string[] in
 *                     RAW BASE UNITS. "310000" at 6dp = 0.31 USDC. Parsed with
 *                     BigInt directly — NO parseUnits (the client already scaled).
 *   • Legacy object — recipients: [{ address, amount }] where amount is a
 *                     HUMAN-DECIMAL string ("0.31"). Scaled with parseUnits.
 *
 * Both paths return raw base units, so every downstream calculation (totals,
 * fee, calldata, formatted response) is shape-agnostic from here on.
 */
export function resolveBatchAmounts(
  recipients: unknown,
  amounts: unknown,
  decimals: number
): ResolvedBatch {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BatchInputError("recipients array required");
  }

  const onchainRecipients: NormalizedRecipient[] = [];
  const first = recipients[0];

  if (typeof first === "string") {
    // ── Flat format: parallel amounts[] array, already in raw base units ──
    if (!Array.isArray(amounts) || amounts.length !== recipients.length) {
      throw new BatchInputError(
        "Flat format requires an 'amounts' array (raw base units) the same length as 'recipients'."
      );
    }
    for (let i = 0; i < recipients.length; i++) {
      const addr = recipients[i];
      if (typeof addr !== "string" || !addr) {
        throw new BatchInputError(`recipients[${i}] must be an address string.`);
      }
      let amount: bigint;
      try {
        amount = BigInt(String(amounts[i]));
      } catch {
        throw new BatchInputError(
          `amounts[${i}]="${amounts[i]}" is not a valid raw base-unit integer. ` +
            `Flat-format amounts are integers (e.g. "310000" = 0.31 at 6dp), not decimals.`
        );
      }
      if (amount < 0n) throw new BatchInputError(`amounts[${i}] must not be negative.`);
      onchainRecipients.push({ recipient: addr, amount });
    }
  } else if (first && typeof first === "object") {
    // ── Legacy object format: human-decimal amounts, scaled with parseUnits ──
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i] as { address?: unknown; amount?: unknown };
      if (typeof r.address !== "string" || !r.address) {
        throw new BatchInputError(`recipients[${i}].address is required.`);
      }
      if (r.amount === undefined || r.amount === null || r.amount === "") {
        throw new BatchInputError(`recipients[${i}].amount is required.`);
      }
      let amount: bigint;
      try {
        amount = ethers.parseUnits(String(r.amount), decimals);
      } catch {
        throw new BatchInputError(
          `recipients[${i}].amount="${r.amount}" is not a valid decimal amount.`
        );
      }
      onchainRecipients.push({ recipient: r.address, amount });
    }
  } else {
    throw new BatchInputError(
      "recipients must be an array of address strings (flat format) or {address, amount} objects (legacy format)."
    );
  }

  let totalRaw = 0n;
  for (const r of onchainRecipients) totalRaw += r.amount;

  return { onchainRecipients, totalRaw };
}

/** Spraay protocol fee (raw base units) for a raw total. Single source of truth. */
export function batchFee(totalRaw: bigint): bigint {
  return (totalRaw * BigInt(SPRAAY_FEE_BPS)) / BigInt(10000);
}

// ============ Gas limit selection ============

// Worst-case floor, used when live estimation is unavailable. A fresh
// (zero-balance) recipient costs ~20k more per transfer than a warm one;
// a 1-recipient sprayToken to a fresh address measures ~129k on Base.
export const BATCH_GAS_FLOOR_BASE = 180_000;
export const BATCH_GAS_FLOOR_PER_RECIPIENT = 50_000;

export function batchGasFloor(recipientCount: number): number {
  return BATCH_GAS_FLOOR_BASE + BATCH_GAS_FLOOR_PER_RECIPIENT * (recipientCount - 1);
}

/**
 * Gas limit for a batch tx: eth_estimateGas on the exact transaction × 1.5,
 * never below the floor. Static formulas go stale — the previous
 * 50k + 65k/recipient limit funded a 1-recipient batch with 115k against a
 * measured ~129k, so it reverted out of gas.
 *
 * Falls back to the floor when estimation fails: RPC error/timeout, or state
 * that cannot estimate yet (e.g. the sender's allowance is not granted at
 * quote time, so the simulated transfer reverts).
 *
 * `rpcUrl` selects the settlement chain to estimate against; it defaults to
 * Base so existing callers are unaffected.
 */
export async function chooseBatchGasLimit(
  tx: { from?: string; to: string; data: string; value?: string },
  recipientCount: number,
  rpcUrl: string = BASE_RPC_URL
): Promise<{ gasLimit: number; source: "estimate" | "floor" }> {
  const floor = batchGasFloor(recipientCount);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const estimated = await Promise.race([
      provider.estimateGas(tx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("estimateGas timeout")), 5000);
      }),
    ]);
    const padded = Number((estimated * 3n) / 2n);
    return { gasLimit: Math.max(padded, floor), source: "estimate" };
  } catch {
    return { gasLimit: floor, source: "floor" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============ Handlers ============

/**
 * POST /api/v1/batch/execute
 *
 * Batch payment via Spraay V2 — any ERC-20 token or native ETH.
 *
 * Body:
 * {
 *   "token": "USDC" | "ETH" | "0x833589..." | "USDT" | "DAI" | etc,
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" },
 *     { "address": "0x456...", "amount": "25.50" }
 *   ],
 *   "sender": "0xYour...",  // for approval encoding
 *   "chain": "base" | "peaq" // optional, defaults to "base"
 * }
 *
 * Token defaults to USDC if not provided (backward compatible).
 * Omitting "chain" reproduces the pre-peaq response exactly.
 */
export async function batchPaymentHandler(req: Request, res: Response) {
  trackRequest("/api/v1/batch/execute");
  try {
    const { token: tokenInput = "USDC", recipients, amounts, sender, chain: chainInput } = req.body;

    if (!recipients || !Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: "recipients array required" });
    }
    if (recipients.length > 200) {
      return res.status(400).json({ error: "Maximum 200 recipients" });
    }

    // Resolve settlement chain against the hard allowlist
    const chain = resolveSettlementChain(chainInput);
    if (!chain) {
      return res.status(400).json({
        error: `Unsupported settlement chain "${chainInput}". Batches can settle on: ${SETTLEMENT_CHAIN_KEYS.join(", ")}.`,
        supportedChains: SETTLEMENT_CHAIN_KEYS,
      });
    }

    // Resolve token
    const token = resolveToken(tokenInput, chain);
    if (!token.isETH && !token.address) {
      return res.status(400).json({ error: unknownTokenError(tokenInput, chain) });
    }

    // Normalize both accepted body shapes into raw base units (see resolveBatchAmounts).
    const { onchainRecipients, totalRaw } = resolveBatchAmounts(
      recipients,
      amounts,
      token.decimals
    );

    const feeRaw = batchFee(totalRaw);
    const totalWithFee = totalRaw + feeRaw;

    // Encode calldata
    let calldata: string;
    let txValue: string;

    if (token.isETH) {
      calldata = sprayInterface.encodeFunctionData("sprayETH", [
        onchainRecipients,
      ]);
      txValue = totalWithFee.toString();
    } else {
      calldata = sprayInterface.encodeFunctionData("sprayToken", [
        token.address,
        onchainRecipients,
      ]);
      txValue = "0";
    }

    const { gasLimit } = await chooseBatchGasLimit(
      {
        from: typeof sender === "string" && sender ? sender : undefined,
        to: chain.contract,
        data: calldata,
        value: txValue,
      },
      onchainRecipients.length,
      chain.rpcUrl
    );

    const response: any = {
      success: true,
      contract: chain.contract,
      token: {
        symbol: token.symbol,
        address: token.address,
        decimals: token.decimals,
        isETH: token.isETH,
      },
      batch: {
        recipientCount: recipients.length,
        totalAmount: ethers.formatUnits(totalRaw, token.decimals),
        fee: ethers.formatUnits(feeRaw, token.decimals),
        feePercent: "0.3%",
        totalWithFee: ethers.formatUnits(totalWithFee, token.decimals),
      },
      transaction: {
        to: chain.contract,
        data: calldata,
        value: txValue,
        chainId: chain.chainId,
        gasLimit: "0x" + gasLimit.toString(16),
      },
    };

    // ERC-20 tokens need approval
    if (!token.isETH) {
      response.approvalRequired = {
        token: token.address,
        spender: chain.contract,
        amount: totalWithFee.toString(),
        amountFormatted: ethers.formatUnits(totalWithFee, token.decimals),
      };
    }

    // 💧 Loop-native webhook callback
    if (req.webhookCallback) {
      const webhook = await req.webhookCallback('batch.created', {
        recipient_count: recipients.length,
        token: token.symbol,
        chain: chain.key,
        total_amount: ethers.formatUnits(totalRaw, token.decimals),
        total_with_fee: ethers.formatUnits(totalWithFee, token.decimals),
        contract: chain.contract,
      });
      response.webhook = webhook;
    }
    return res.json(response);
  } catch (err: any) {
    const status = err?.status === 400 ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
}

/**
 * POST /api/v1/batch/estimate
 *
 * Estimate batch payment cost — any token or ETH.
 *
 * Body:
 * {
 *   "token": "USDC" | "ETH" | "0x...",
 *   "recipients": [
 *     { "address": "0x123...", "amount": "10.00" }
 *   ]
 * }
 *
 * Or simple format:
 * {
 *   "recipientCount": 5,
 *   "token": "USDC"
 * }
 */
export async function batchEstimateHandler(req: Request, res: Response) {
  trackRequest("/api/v1/batch/estimate");
  try {
    const { token: tokenInput = "USDC", recipients, amounts, recipientCount, chain: chainInput } = req.body;

    // Resolve settlement chain against the same hard allowlist as execute, so a
    // quote can never be produced for a chain execute would refuse.
    const chain = resolveSettlementChain(chainInput);
    if (!chain) {
      return res.status(400).json({
        error: `Unsupported settlement chain "${chainInput}". Batches can settle on: ${SETTLEMENT_CHAIN_KEYS.join(", ")}.`,
        supportedChains: SETTLEMENT_CHAIN_KEYS,
      });
    }

    // Resolve token
    const token = resolveToken(tokenInput, chain);

    // Detailed estimate: same normalization + fee math as the execute path,
    // so a quote can never disagree with what execute will charge.
    if (recipients && Array.isArray(recipients) && recipients.length > 0) {
      const { onchainRecipients, totalRaw } = resolveBatchAmounts(recipients, amounts, token.decimals);
      const feeRaw = batchFee(totalRaw);

      // Same gas-limit selection as the execute path. Encoding can throw on
      // malformed addresses the fee quote tolerates, so fall back to the
      // floor rather than failing a previously-valid quote.
      let suggestedGasLimit = batchGasFloor(onchainRecipients.length);
      try {
        const calldata = token.isETH
          ? sprayInterface.encodeFunctionData("sprayETH", [onchainRecipients])
          : sprayInterface.encodeFunctionData("sprayToken", [token.address, onchainRecipients]);
        const chosen = await chooseBatchGasLimit(
          {
            from: typeof req.body.sender === "string" && req.body.sender ? req.body.sender : undefined,
            to: chain.contract,
            data: calldata,
            value: token.isETH ? (totalRaw + feeRaw).toString() : "0",
          },
          onchainRecipients.length,
          chain.rpcUrl
        );
        suggestedGasLimit = chosen.gasLimit;
      } catch {
        // keep the floor
      }

      return res.json({
        success: true,
        token: {
          symbol: token.symbol,
          address: token.address,
          decimals: token.decimals,
          isETH: token.isETH,
        },
        recipientCount: recipients.length,
        totalAmount: ethers.formatUnits(totalRaw, token.decimals),
        fee: ethers.formatUnits(feeRaw, token.decimals),
        feePercent: "0.3%",
        totalWithFee: ethers.formatUnits(totalRaw + feeRaw, token.decimals),
        suggestedGasLimit: suggestedGasLimit.toString(),
      });
    }

    // Simple format: recipient count only — no exact tx to estimate, so the
    // value comes from the cold-recipient worst-case floor.
    const count = recipientCount || 1;
    const estimatedGas = batchGasFloor(count);

    return res.json({
      success: true,
      token: {
        symbol: token.symbol,
        isETH: token.isETH,
      },
      recipientCount: count,
      feePercent: "0.3%",
      estimatedGas: estimatedGas.toString(),
      suggestedGasLimit: estimatedGas.toString(),
      note: "Conservative ceiling (cold-recipient worst case). Provide recipients array for exact fee calculation.",
    });
  } catch (err: any) {
    const status = err?.status === 400 ? 400 : 500;
    return res.status(status).json({ error: err.message });
  }
}