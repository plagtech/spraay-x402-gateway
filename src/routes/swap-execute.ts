import { Request, Response } from "express";
import {
  JsonRpcProvider,
  Contract,
  Interface,
  isAddress,
  parseUnits,
  formatUnits,
} from "ethers";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

// MangoSwap Router on Base mainnet
const MANGOSWAP_CONTRACT = "0xb81fea65B45D743AB62a1A2B351f4f92fb1d4D16";

// Uniswap V3 SwapRouter02 on Base
const UNISWAP_ROUTER = "0x2626664c2603336E57B271c5C0b26F421741e481";

// Uniswap V3 Quoter V2 on Base
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";

// WETH on Base (for ETH wrapping)
const WETH = "0x4200000000000000000000000000000000000006";

// Base chain ID
const CHAIN_ID = 8453;

// Default slippage: 0.5%
const DEFAULT_SLIPPAGE_BPS = 50;

// Quote validity window (seconds)
const DEADLINE_SECONDS = 300; // 5 minutes

// Base RPC
const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";

// ============================================
// TOKEN REGISTRY
// ============================================

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  feeTiers: number[];
}

const BASE_TOKENS: Record<string, TokenInfo> = {
  ETH: {
    address: WETH,
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    feeTiers: [500, 3000, 10000],
  },
  WETH: {
    address: WETH,
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    feeTiers: [500, 3000, 10000],
  },
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    feeTiers: [100, 500, 3000],
  },
  USDbC: {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    name: "USD Base Coin",
    decimals: 6,
    feeTiers: [100, 500, 3000],
  },
  cbBTC: {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    feeTiers: [500, 3000],
  },
  AERO: {
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    symbol: "AERO",
    name: "Aerodrome Finance",
    decimals: 18,
    feeTiers: [3000, 10000],
  },
  DEGEN: {
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    symbol: "DEGEN",
    name: "Degen",
    decimals: 18,
    feeTiers: [3000, 10000],
  },
  BRETT: {
    address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
    symbol: "BRETT",
    name: "Brett",
    decimals: 18,
    feeTiers: [3000, 10000],
  },
  TOSHI: {
    address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4",
    symbol: "TOSHI",
    name: "Toshi",
    decimals: 18,
    feeTiers: [3000, 10000],
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    feeTiers: [100, 500, 3000],
  },
};

// ============================================
// ABIs (minimal)
// ============================================

const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];

// ============================================
// HELPERS
// ============================================

function resolveToken(input: string): TokenInfo | null {
  const upper = input.toUpperCase();
  if (BASE_TOKENS[upper]) return BASE_TOKENS[upper];

  const lower = input.toLowerCase();
  for (const token of Object.values(BASE_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token;
  }
  return null;
}

/**
 * Find the best fee tier by querying QuoterV2 for each tier
 * and picking the one with the highest output.
 */
async function findBestQuote(
  provider: JsonRpcProvider,
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountInRaw: bigint
): Promise<{ amountOut: bigint; feeTier: number; gasEstimate: bigint }> {
  const quoter = new Contract(QUOTER_V2, QUOTER_V2_ABI, provider);

  const feeTiers = [...new Set([...tokenIn.feeTiers, ...tokenOut.feeTiers])];

  let bestAmountOut = 0n;
  let bestFeeTier = 3000;
  let bestGasEstimate = 200000n;

  for (const fee of feeTiers) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountInRaw,
        fee,
        sqrtPriceLimitX96: 0,
      });

      // QuoterV2 returns [amountOut, sqrtPriceX96After, initializedTicksCrossed, gasEstimate]
      const amountOut: bigint = result[0];
      const gasEst: bigint = result[3];

      if (amountOut > bestAmountOut) {
        bestAmountOut = amountOut;
        bestFeeTier = fee;
        bestGasEstimate = gasEst;
      }
    } catch {
      continue;
    }
  }

  if (bestAmountOut === 0n) {
    throw new Error(`No liquidity found for ${tokenIn.symbol} → ${tokenOut.symbol} on any fee tier`);
  }

  return { amountOut: bestAmountOut, feeTier: bestFeeTier, gasEstimate: bestGasEstimate };
}

// ============================================
// ROUTE HANDLER
// ============================================

/**
 * POST /api/v1/swap/execute
 *
 * Returns unsigned transaction data to execute a swap via Uniswap V3 SwapRouter02.
 * The caller signs and submits the transaction themselves.
 *
 * Request body:
 *   tokenIn:    string  - Symbol or address of input token
 *   tokenOut:   string  - Symbol or address of output token
 *   amountIn:   string  - Human-readable amount (e.g. "100" for 100 USDC)
 *   recipient:  string  - Address to receive output tokens
 *   slippageBps?: number - Slippage tolerance in basis points (default: 50 = 0.5%)
 */
export async function swapExecuteHandler(req: Request, res: Response) {
  try {
    const { tokenIn, tokenOut, amountIn, recipient, slippageBps } = req.body;

    // ---- Validation ----
    if (!tokenIn || !tokenOut || !amountIn || !recipient) {
      return res.status(400).json({
        error: "Missing required fields",
        required: { tokenIn: "string", tokenOut: "string", amountIn: "string", recipient: "string" },
        optional: { slippageBps: "number (default: 50 = 0.5%)" },
        example: {
          tokenIn: "USDC",
          tokenOut: "WETH",
          amountIn: "100",
          recipient: "0xYourAddress",
          slippageBps: 50,
        },
      });
    }

    const tokenInInfo = resolveToken(tokenIn);
    const tokenOutInfo = resolveToken(tokenOut);

    if (!tokenInInfo) {
      return res.status(400).json({
        error: `Unknown token: ${tokenIn}`,
        supportedTokens: Object.keys(BASE_TOKENS),
      });
    }
    if (!tokenOutInfo) {
      return res.status(400).json({
        error: `Unknown token: ${tokenOut}`,
        supportedTokens: Object.keys(BASE_TOKENS),
      });
    }

    if (tokenInInfo.address.toLowerCase() === tokenOutInfo.address.toLowerCase()) {
      return res.status(400).json({ error: "tokenIn and tokenOut cannot be the same" });
    }

    if (!isAddress(recipient)) {
      return res.status(400).json({ error: "Invalid recipient address" });
    }

    const amount = parseFloat(amountIn);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "amountIn must be a positive number" });
    }

    const slippage = slippageBps ? Number(slippageBps) : DEFAULT_SLIPPAGE_BPS;
    if (slippage < 1 || slippage > 5000) {
      return res.status(400).json({ error: "slippageBps must be between 1 and 5000 (0.01% to 50%)" });
    }

    // ---- Get quote ----
    const provider = new JsonRpcProvider(RPC_URL);
    const amountInRaw = parseUnits(amountIn, tokenInInfo.decimals);

    const { amountOut, feeTier, gasEstimate } = await findBestQuote(
      provider,
      tokenInInfo,
      tokenOutInfo,
      amountInRaw
    );

    // Calculate minimum output with slippage
    const amountOutMinimum = (amountOut * BigInt(10000 - slippage)) / 10000n;

    // Deadline: current time + 5 minutes
    const deadline = Math.floor(Date.now() / 1000) + DEADLINE_SECONDS;

    // ---- Build swap transaction ----
    const swapIface = new Interface(SWAP_ROUTER_ABI);
    const swapCalldata = swapIface.encodeFunctionData("exactInputSingle", [
      {
        tokenIn: tokenInInfo.address,
        tokenOut: tokenOutInfo.address,
        fee: feeTier,
        recipient: recipient,
        amountIn: amountInRaw,
        amountOutMinimum: amountOutMinimum,
        sqrtPriceLimitX96: 0,
      },
    ]);

    // If tokenIn is ETH (not WETH), send native value
    const isNativeETH = tokenIn.toUpperCase() === "ETH";
    const txValue = isNativeETH ? amountInRaw : 0n;

    // ---- Build approval transaction (if ERC20, not native ETH) ----
    let approvalTx = null;
    if (!isNativeETH) {
      const erc20Iface = new Interface(ERC20_ABI);
      const approveCalldata = erc20Iface.encodeFunctionData("approve", [
        UNISWAP_ROUTER,
        amountInRaw,
      ]);

      approvalTx = {
        to: tokenInInfo.address,
        data: approveCalldata,
        value: "0x0",
        chainId: CHAIN_ID,
        note: `Approve ${UNISWAP_ROUTER} to spend ${amountIn} ${tokenInInfo.symbol}. Skip if already approved.`,
      };
    }

    // ---- Format human-readable amounts ----
    const amountOutFormatted = formatUnits(amountOut, tokenOutInfo.decimals);
    const amountOutMinFormatted = formatUnits(amountOutMinimum, tokenOutInfo.decimals);
    const executionPrice =
      tokenOutInfo.decimals >= tokenInInfo.decimals
        ? (parseFloat(amountOutFormatted) / amount).toFixed(8)
        : (amount / parseFloat(amountOutFormatted)).toFixed(8);

    // Gas limit with buffer
    const gasLimitWithBuffer = gasEstimate + 50000n;

    trackRequest("swap_execute");

    // ---- Response ----
    return res.json({
      status: "ready",
      quote: {
        tokenIn: {
          symbol: tokenInInfo.symbol,
          address: tokenInInfo.address,
          amount: amountIn,
          amountRaw: amountInRaw.toString(),
          decimals: tokenInInfo.decimals,
        },
        tokenOut: {
          symbol: tokenOutInfo.symbol,
          address: tokenOutInfo.address,
          estimatedAmount: amountOutFormatted,
          estimatedAmountRaw: amountOut.toString(),
          minimumAmount: amountOutMinFormatted,
          minimumAmountRaw: amountOutMinimum.toString(),
          decimals: tokenOutInfo.decimals,
        },
        executionPrice,
        feeTier,
        feeTierPercent: `${feeTier / 10000}%`,
        slippageBps: slippage,
        slippagePercent: `${slippage / 100}%`,
      },
      transactions: {
        approval: approvalTx,
        swap: {
          to: UNISWAP_ROUTER,
          data: swapCalldata,
          value: "0x" + txValue.toString(16),
          chainId: CHAIN_ID,
          gasLimit: "0x" + gasLimitWithBuffer.toString(16),
        },
      },
      execution: {
        router: UNISWAP_ROUTER,
        protocol: "Uniswap V3",
        chain: "Base",
        chainId: CHAIN_ID,
        recipient,
        deadline,
        deadlineISO: new Date(deadline * 1000).toISOString(),
      },
      instructions: [
        approvalTx ? `1. Sign and submit the approval tx (${tokenInInfo.symbol} → SwapRouter02)` : null,
        `${approvalTx ? "2" : "1"}. Sign and submit the swap tx`,
        "Transaction data is pre-encoded and ready to submit to Base mainnet",
      ].filter(Boolean),
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        router: "mangoswap",
        source: "uniswap-v3-quoter-v2",
        contract: MANGOSWAP_CONTRACT,
        endpoint: "POST /api/v1/swap/execute",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Swap execute error:", error.message);

    if (error.message.includes("No liquidity")) {
      return res.status(422).json({
        error: error.message,
        suggestion: "Try a different token pair or smaller amount",
      });
    }

    return res.status(500).json({
      error: "Failed to build swap transaction",
      details: error.message,
    });
  }
}
