import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// ============================================================================
// Swap-and-pay: ETH in, fixed USDC amounts out to many recipients, one tx.
//
// Builds UNSIGNED calls to SwapAndSprayRouter on Base. The router swaps native
// ETH on the hookless Uniswap v4 ETH/USDC 0.30% pool (exact-output, so the
// output is exactly what the payout needs) and pays it out through
// SprayContract v2. Spray's 0.3% fee is the only fee; there is no swap
// surcharge. Source of truth for the ABI: ../spraay-swap-and-spray
// (src/SwapAndSprayRouter.sol, src/libraries/PayoutSpec.sol).
//
// Scope (v1, LP rulings 2026-11-17): router path only (no hook), ETH input
// only, Base only. Fully separate from /api/v1/batch/* — shares no state.
//
// IMPORTANT: the router is bound to SprayContract v2 0x4B1d57EB…edD4c
// (skip-on-fail), NOT the 0x1646452F…5eEC contract batch/execute targets.
// A recipient that cannot receive is skipped and its amount + unused fee is
// refunded to `sender` (the spec's payer) inside the same transaction.
// ============================================================================

export const SWAP_AND_PAY_CHAIN_ID = 8453;
export const SWAP_AND_SPRAY_ROUTER = "0x8cfb5eBa99170d284120B885A47b08E28FD27379";
/** router.spray() on-chain — read 2026-11-17. */
export const SWAP_AND_PAY_SPRAY = "0x4B1d57EBFaBDF3F21F30f210a1d95f649E9edD4c";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;
const V4_QUOTER = "0x0d5e0F971ED27FBfF6c2837bf31316121532048D";
const V4_STATE_VIEW = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";

/** Hookless ETH/USDC 0.30% pool — the pool the Nov 8 mainnet proof used. */
export const ETH_USDC_POOL_KEY = {
  currency0: ethers.ZeroAddress,
  currency1: BASE_USDC,
  fee: 3000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
} as const;
export const ETH_USDC_POOL_ID = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "uint24", "int24", "address"],
    [ETH_USDC_POOL_KEY.currency0, ETH_USDC_POOL_KEY.currency1, ETH_USDC_POOL_KEY.fee, ETH_USDC_POOL_KEY.tickSpacing, ETH_USDC_POOL_KEY.hooks]
  )
);

/** TickMath.MIN_SQRT_PRICE + 1 — no price limit for a zeroForOne swap. */
const MIN_SQRT_PRICE_PLUS_ONE = 4295128739n + 1n;

export const SUPPORTED_INPUT_TOKENS = ["ETH"] as const;
export const MAX_SWAP_AND_PAY_RECIPIENTS = 200; // PayoutSpecLib.MAX_RECIPIENTS
export const DEFAULT_SLIPPAGE_BPS = 50;
export const MAX_SLIPPAGE_BPS = 500;
export const DEFAULT_DEADLINE_SECONDS = 300;
/** Highest Spray feeBps the payer accepts; the router reverts above it. */
const MAX_FEE_BPS = 30n;
const MODE_AMOUNTS = 1;

const BASE_RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// ============ ABI ============

const POOL_KEY_T = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const SPEC_T = "tuple(uint8 mode,address payer,uint256 minOutput,uint256 maxFeeBps,address[] recipients,uint256[] values)";

export const swapAndSprayRouterInterface = new ethers.Interface([
  `function swapAndSpray(${POOL_KEY_T} key, tuple(bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96) params, uint256 amountLimit, ${SPEC_T} spec, uint256 deadline) payable returns (uint256 amountIn, uint256 output)`,
  `function requiredOutput(${SPEC_T} spec) view returns (uint256)`,
]);
/** keccak256 selector of swapAndSpray(...) — 0x04846b1d. */
export const SWAP_AND_SPRAY_SELECTOR = swapAndSprayRouterInterface.getFunction("swapAndSpray")!.selector;

const quoterInterface = new ethers.Interface([
  `function quoteExactOutputSingle(tuple(${POOL_KEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountIn,uint256 gasEstimate)`,
]);
const stateViewInterface = new ethers.Interface([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
]);

// ============ Chain access (injectable for offline tests) ============

type PayoutSpecTuple = [number, string, bigint, bigint, string[], bigint[]];

export interface SwapAndPayChain {
  /** router.requiredOutput(spec): total + Spray fee at the live feeBps. */
  requiredOutput(spec: PayoutSpecTuple): Promise<bigint>;
  /** V4Quoter: wei of ETH needed for exactly `usdcOut` raw USDC. */
  quoteExactOutput(usdcOut: bigint): Promise<bigint>;
  slot0(): Promise<{ sqrtPriceX96: bigint; tick: number }>;
  estimateGas(tx: { from: string; to: string; data: string; value: string }): Promise<bigint>;
}

function rpcChain(): SwapAndPayChain {
  const provider = new ethers.JsonRpcProvider(BASE_RPC_URL, SWAP_AND_PAY_CHAIN_ID, { staticNetwork: true });
  const call = async (to: string, iface: ethers.Interface, fn: string, args: unknown[]) => {
    const data = iface.encodeFunctionData(fn, args);
    const raw = await provider.call({ to, data });
    return iface.decodeFunctionResult(fn, raw);
  };
  return {
    async requiredOutput(spec) {
      return (await call(SWAP_AND_SPRAY_ROUTER, swapAndSprayRouterInterface, "requiredOutput", [spec]))[0] as bigint;
    },
    async quoteExactOutput(usdcOut) {
      const key = [ETH_USDC_POOL_KEY.currency0, ETH_USDC_POOL_KEY.currency1, ETH_USDC_POOL_KEY.fee, ETH_USDC_POOL_KEY.tickSpacing, ETH_USDC_POOL_KEY.hooks];
      return (await call(V4_QUOTER, quoterInterface, "quoteExactOutputSingle", [[key, true, usdcOut, "0x"]]))[0] as bigint;
    },
    async slot0() {
      const r = await call(V4_STATE_VIEW, stateViewInterface, "getSlot0", [ETH_USDC_POOL_ID]);
      return { sqrtPriceX96: r[0] as bigint, tick: Number(r[1]) };
    },
    async estimateGas(tx) {
      return provider.estimateGas(tx);
    },
  };
}

let chainFactory: () => SwapAndPayChain = rpcChain;
/** Test hook: replace on-chain reads with a stub. Pass null to restore. */
export function __setSwapAndPayChainForTests(factory: (() => SwapAndPayChain) | null): void {
  chainFactory = factory ?? rpcChain;
}

// ============ Errors ============

class SwapAndPayError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}
const bad = (message: string, extra: Record<string, unknown> = {}) => new SwapAndPayError(400, message, extra);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

// ============ Validation ============

export interface SwapAndPayInput {
  sender: string;
  recipients: string[];
  amounts: bigint[];
  totalRaw: bigint;
  slippageBps: number;
}

/**
 * Validate a request body. Mirrors PayoutSpecLib.validate plus the gateway's
 * own rules, so a request the router would revert on is rejected here first.
 */
export function validateSwapAndPayBody(body: any): SwapAndPayInput {
  if (!body || typeof body !== "object") throw bad("JSON body required");
  const { sender, recipients, amounts, inputToken, slippageBps } = body;

  if (inputToken !== undefined && inputToken !== null) {
    if (typeof inputToken !== "string" || !SUPPORTED_INPUT_TOKENS.includes(inputToken.trim().toUpperCase() as any)) {
      throw bad(`Unsupported inputToken "${inputToken}". Supported input tokens: ${SUPPORTED_INPUT_TOKENS.join(", ")}.`, {
        supportedInputTokens: [...SUPPORTED_INPUT_TOKENS],
      });
    }
  }

  if (typeof sender !== "string" || !ethers.isAddress(sender) || sender.toLowerCase() === ethers.ZeroAddress) {
    throw bad("sender is required: the paying address, which also receives any refund for skipped recipients.");
  }

  if (!Array.isArray(recipients) || recipients.length === 0) throw bad("recipients array required");
  if (recipients.length > MAX_SWAP_AND_PAY_RECIPIENTS) throw bad(`Maximum ${MAX_SWAP_AND_PAY_RECIPIENTS} recipients`);
  if (!Array.isArray(amounts) || amounts.length !== recipients.length) {
    throw bad("'amounts' must be an array (raw USDC base units) the same length as 'recipients'.");
  }

  const forbidden = new Map([
    [ethers.ZeroAddress, "the zero address"],
    [SWAP_AND_PAY_SPRAY.toLowerCase(), "the Spray contract"],
    [SWAP_AND_SPRAY_ROUTER.toLowerCase(), "the SwapAndSpray router"],
  ]);
  const outRecipients: string[] = [];
  const outAmounts: bigint[] = [];
  let totalRaw = 0n;
  for (let i = 0; i < recipients.length; i++) {
    const addr = recipients[i];
    if (typeof addr !== "string" || !ethers.isAddress(addr)) throw bad(`recipients[${i}] must be a 0x address.`);
    const why = forbidden.get(addr.toLowerCase());
    if (why) throw bad(`recipients[${i}] cannot be ${why}.`);

    const v = amounts[i];
    if ((typeof v !== "string" && typeof v !== "number") || !/^[0-9]+$/.test(String(v))) {
      throw bad(`amounts[${i}]="${v}" is not a raw base-unit integer. Amounts are raw USDC units (6 decimals): "1500000" = 1.50 USDC.`);
    }
    const amount = BigInt(String(v));
    if (amount === 0n) throw bad(`amounts[${i}] must be greater than zero.`);
    outRecipients.push(ethers.getAddress(addr));
    outAmounts.push(amount);
    totalRaw += amount;
  }

  let slippage = DEFAULT_SLIPPAGE_BPS;
  if (slippageBps !== undefined && slippageBps !== null) {
    if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
      throw bad(`slippageBps must be an integer from 0 to ${MAX_SLIPPAGE_BPS}.`);
    }
    slippage = slippageBps;
  }

  return { sender: ethers.getAddress(sender), recipients: outRecipients, amounts: outAmounts, totalRaw, slippageBps: slippage };
}

/** Deadline in unix seconds. Defaults to now + 300 s; a supplied one must be in the future. */
export function resolveDeadline(input: unknown, nowSec: number): bigint {
  if (input === undefined || input === null) return BigInt(nowSec + DEFAULT_DEADLINE_SECONDS);
  if (typeof input !== "number" || !Number.isInteger(input) || input > 2 ** 40) {
    throw bad("deadline must be a unix timestamp in seconds (integer).");
  }
  if (input <= nowSec) throw bad(`deadline ${input} is not in the future (now ${nowSec}).`);
  return BigInt(input);
}

// ============ Gas ============

// The batch floor (180k + 50k/recipient) is too low here: the swap adds ~190k,
// and Spray needs 150k gas left before each transfer (spraay-swap-and-spray
// GAS.md: 10 recipients = 497k receipt gas; callers should add >=300k headroom).
export const SWAP_AND_PAY_GAS_FLOOR_BASE = 500_000;
export const SWAP_AND_PAY_GAS_FLOOR_PER_RECIPIENT = 35_000;
export function swapAndPayGasFloor(recipientCount: number): number {
  return SWAP_AND_PAY_GAS_FLOOR_BASE + SWAP_AND_PAY_GAS_FLOOR_PER_RECIPIENT * recipientCount;
}

/** eth_estimateGas × 1.5, never below the floor; floor if estimation fails. */
export async function chooseSwapAndPayGasLimit(
  chain: SwapAndPayChain,
  tx: { from: string; to: string; data: string; value: string },
  recipientCount: number
): Promise<{ gasLimit: number; source: "estimate" | "floor" }> {
  const floor = swapAndPayGasFloor(recipientCount);
  try {
    const estimated = await withTimeout(chain.estimateGas(tx), 5000, "estimateGas");
    return { gasLimit: Math.max(Number((estimated * 3n) / 2n), floor), source: "estimate" };
  } catch {
    return { gasLimit: floor, source: "floor" };
  }
}

// ============ Quote + build ============

/** Raw USDC per 1 ETH from a v4 sqrtPriceX96 (currency0 = ETH, currency1 = USDC). */
export function usdcPerEthFromSqrtPrice(sqrtPriceX96: bigint): bigint {
  return (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) >> 192n;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

interface BuiltSwapAndPay {
  input: SwapAndPayInput;
  requiredOutput: bigint;
  feeRaw: bigint;
  ethIn: bigint;
  maxEthIn: bigint;
  sqrtPriceX96: bigint;
  tick: number;
  calldata: string;
  deadline: bigint;
  gasLimit: number;
  gasLimitSource: "estimate" | "floor";
}

async function buildSwapAndPay(body: any, deadlineInput: unknown): Promise<BuiltSwapAndPay> {
  const input = validateSwapAndPayBody(body);
  const deadline = resolveDeadline(deadlineInput, Math.floor(Date.now() / 1000));
  const chain = chainFactory();

  const spec: PayoutSpecTuple = [MODE_AMOUNTS, input.sender, 0n, MAX_FEE_BPS, input.recipients, input.amounts];

  let requiredOutput: bigint;
  let slot: { sqrtPriceX96: bigint; tick: number };
  try {
    [requiredOutput, slot] = await withTimeout(Promise.all([chain.requiredOutput(spec), chain.slot0()]), 8000, "Base RPC");
  } catch (err: any) {
    throw new SwapAndPayError(502, `Could not read the router or pool on Base: ${err?.shortMessage || err?.message || err}`);
  }
  if (requiredOutput < input.totalRaw) {
    throw new SwapAndPayError(502, "Router returned a required output below the payout total.");
  }

  let ethIn: bigint;
  try {
    ethIn = await withTimeout(chain.quoteExactOutput(requiredOutput), 8000, "quote");
  } catch (err: any) {
    if (err?.code === "CALL_EXCEPTION") {
      throw bad(`The ETH/USDC pool cannot fill ${ethers.formatUnits(requiredOutput, USDC_DECIMALS)} USDC right now. Reduce the total.`);
    }
    throw new SwapAndPayError(502, `Quote failed: ${err?.shortMessage || err?.message || err}`);
  }
  if (ethIn <= 0n) throw new SwapAndPayError(502, "Quote returned zero input.");

  const maxEthIn = ceilDiv(ethIn * BigInt(10_000 + input.slippageBps), 10_000n);

  const calldata = swapAndSprayRouterInterface.encodeFunctionData("swapAndSpray", [
    [ETH_USDC_POOL_KEY.currency0, ETH_USDC_POOL_KEY.currency1, ETH_USDC_POOL_KEY.fee, ETH_USDC_POOL_KEY.tickSpacing, ETH_USDC_POOL_KEY.hooks],
    [true, requiredOutput, MIN_SQRT_PRICE_PLUS_ONE], // exact-output: amountSpecified > 0
    maxEthIn,
    spec,
    deadline,
  ]);

  const { gasLimit, source } = await chooseSwapAndPayGasLimit(
    chain,
    { from: input.sender, to: SWAP_AND_SPRAY_ROUTER, data: calldata, value: maxEthIn.toString() },
    input.recipients.length
  );

  return {
    input,
    requiredOutput,
    feeRaw: requiredOutput - input.totalRaw,
    ethIn,
    maxEthIn,
    sqrtPriceX96: slot.sqrtPriceX96,
    tick: slot.tick,
    calldata,
    deadline,
    gasLimit,
    gasLimitSource: source,
  };
}

/** Fields shared by estimate and execute. */
function summary(b: BuiltSwapAndPay) {
  const spot = usdcPerEthFromSqrtPrice(b.sqrtPriceX96);
  const effective = (b.requiredOutput * 10n ** 18n) / b.ethIn;
  // Execution vs pool spot, in bps. Includes the pool's own 0.30% LP fee.
  const priceImpactBps = spot > 0n ? Number(((spot - effective) * 10_000n) / spot) : null;
  return {
    success: true,
    chainId: SWAP_AND_PAY_CHAIN_ID,
    router: SWAP_AND_SPRAY_ROUTER,
    sprayContract: SWAP_AND_PAY_SPRAY,
    inputToken: { symbol: "ETH", address: ethers.ZeroAddress, decimals: 18, isETH: true },
    outputToken: { symbol: "USDC", address: BASE_USDC, decimals: USDC_DECIMALS },
    supportedInputTokens: [...SUPPORTED_INPUT_TOKENS],
    pool: {
      ...ETH_USDC_POOL_KEY,
      poolId: ETH_USDC_POOL_ID,
      sqrtPriceX96: b.sqrtPriceX96.toString(),
      tick: b.tick,
      usdcPerEth: ethers.formatUnits(spot, USDC_DECIMALS),
    },
    payout: {
      recipientCount: b.input.recipients.length,
      totalAmount: ethers.formatUnits(b.input.totalRaw, USDC_DECIMALS),
      fee: ethers.formatUnits(b.feeRaw, USDC_DECIMALS),
      feePercent: "0.3%",
      totalWithFee: ethers.formatUnits(b.requiredOutput, USDC_DECIMALS),
      requiredOutputRaw: b.requiredOutput.toString(),
    },
    quote: {
      ethIn: b.ethIn.toString(),
      ethInFormatted: ethers.formatEther(b.ethIn),
      maxEthIn: b.maxEthIn.toString(),
      maxEthInFormatted: ethers.formatEther(b.maxEthIn),
      slippageBps: b.input.slippageBps,
      effectiveUsdcPerEth: ethers.formatUnits(effective, USDC_DECIMALS),
      priceImpactBps,
    },
    note:
      "Exact-output swap: recipients receive exactly their amounts. Unused ETH (maxEthIn - actual input) is refunded to sender in the same transaction. " +
      "SprayContract v2 is skip-on-fail: a recipient that cannot receive is skipped and its amount plus unused fee is refunded to sender in USDC.",
  };
}

function sendError(res: Response, err: any) {
  if (err instanceof SwapAndPayError) return res.status(err.status).json({ error: err.message, ...err.extra });
  return res.status(500).json({ error: err?.message || "Internal error" });
}

// ============ Handlers ============

/**
 * POST /api/v1/swap-and-pay/estimate
 * Body: { sender, recipients[], amounts[] (raw USDC), inputToken?: "ETH", slippageBps? }
 */
export async function swapAndPayEstimateHandler(req: Request, res: Response) {
  trackRequest("/api/v1/swap-and-pay/estimate");
  try {
    const built = await buildSwapAndPay(req.body, undefined);
    return res.json({
      ...summary(built),
      suggestedGasLimit: built.gasLimit.toString(),
      gasLimitSource: built.gasLimitSource,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
}

/**
 * POST /api/v1/swap-and-pay/execute
 * Body: { sender, recipients[], amounts[] (raw USDC), inputToken?: "ETH", slippageBps?, deadline? }
 * Returns an unsigned transaction for `sender` to sign. No ERC-20 approval is
 * needed: the input is native ETH sent as `value`.
 */
export async function swapAndPayExecuteHandler(req: Request, res: Response) {
  trackRequest("/api/v1/swap-and-pay/execute");
  try {
    const built = await buildSwapAndPay(req.body, req.body?.deadline);
    return res.json({
      ...summary(built),
      deadline: Number(built.deadline),
      transaction: {
        from: built.input.sender,
        to: SWAP_AND_SPRAY_ROUTER,
        data: built.calldata,
        value: built.maxEthIn.toString(),
        chainId: SWAP_AND_PAY_CHAIN_ID,
        gasLimit: "0x" + built.gasLimit.toString(16),
      },
      gasLimitSource: built.gasLimitSource,
    });
  } catch (err: any) {
    return sendError(res, err);
  }
}
