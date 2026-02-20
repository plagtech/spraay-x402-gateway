import { Request, Response } from "express";
import { ethers } from "ethers";
import { trackRequest } from "./health.js";

// MangoSwap contract on Base
const MANGOSWAP_CONTRACT = "0xb81fea65B45D743AB62a1A2B351f4f92fb1d4D16";

// Uniswap V3 Quoter V2 on Base
const UNISWAP_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
// Uniswap V3 Factory on Base
const UNISWAP_FACTORY = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

const BASE_RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(BASE_RPC);

// Quoter V2 ABI (quoteExactInputSingle)
const QUOTER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
        name: "params",
        type: "tuple",
      },
    ],
    name: "quoteExactInputSingle",
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
];

// Popular Base tokens
const BASE_TOKENS: Record<string, TokenInfo> = {
  USDC: {
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    pools: ["uniswap-v3", "aerodrome"],
  },
  WETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    pools: ["uniswap-v3", "aerodrome"],
  },
  ETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Ether (wrapped)",
    decimals: 18,
    pools: ["uniswap-v3", "aerodrome"],
  },
  cbBTC: {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    pools: ["uniswap-v3", "aerodrome"],
  },
  AERO: {
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    symbol: "AERO",
    name: "Aerodrome Finance",
    decimals: 18,
    pools: ["aerodrome"],
  },
  DEGEN: {
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    symbol: "DEGEN",
    name: "Degen",
    decimals: 18,
    pools: ["uniswap-v3", "aerodrome"],
  },
  BRETT: {
    address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
    symbol: "BRETT",
    name: "Brett",
    decimals: 18,
    pools: ["uniswap-v3"],
  },
  TOSHI: {
    address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4",
    symbol: "TOSHI",
    name: "Toshi",
    decimals: 18,
    pools: ["uniswap-v3"],
  },
  USDbC: {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    name: "USD Base Coin",
    decimals: 6,
    pools: ["uniswap-v3", "aerodrome"],
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    pools: ["uniswap-v3", "aerodrome"],
  },
};

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pools: string[];
}

// Common Uniswap V3 fee tiers
const FEE_TIERS = [500, 3000, 10000]; // 0.05%, 0.3%, 1%

/**
 * GET /api/v1/swap/quote
 *
 * Get a live swap quote from Uniswap V3 on Base.
 *
 * Query params:
 *   tokenIn=USDC (symbol or 0x address)
 *   tokenOut=WETH (symbol or 0x address)
 *   amountIn=100 (human readable amount)
 *
 * Example: /api/v1/swap/quote?tokenIn=USDC&tokenOut=WETH&amountIn=100
 */
export async function swapQuoteHandler(req: Request, res: Response) {
  try {
    const { tokenIn, tokenOut, amountIn } = req.query;

    if (!tokenIn || !tokenOut || !amountIn) {
      return res.status(400).json({
        error: "Missing required query params: tokenIn, tokenOut, amountIn",
        example: "/api/v1/swap/quote?tokenIn=USDC&tokenOut=WETH&amountIn=100",
        supportedTokens: Object.keys(BASE_TOKENS),
      });
    }

    const tokenInInfo = resolveToken(tokenIn as string);
    const tokenOutInfo = resolveToken(tokenOut as string);

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

    const amount = parseFloat(amountIn as string);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amountIn" });
    }

    // Query Uniswap V3 Quoter for live price
    const quote = await getUniswapQuote(tokenInInfo, tokenOutInfo, amount);

    trackRequest("swap_quote");

    return res.json({
      tokenIn: {
        symbol: tokenInInfo.symbol,
        address: tokenInInfo.address,
        amount: amount.toString(),
        decimals: tokenInInfo.decimals,
      },
      tokenOut: {
        symbol: tokenOutInfo.symbol,
        address: tokenOutInfo.address,
        estimatedAmount: quote.amountOut,
        decimals: tokenOutInfo.decimals,
      },
      route: quote.route,
      dex: quote.dex,
      feeTier: quote.feeTier,
      priceImpact: quote.priceImpact,
      executionPrice: quote.executionPrice,
      gasEstimate: quote.gasEstimate,
      transaction: {
        to: MANGOSWAP_CONTRACT,
        chainId: 8453,
        note: "Use MangoSwap router or submit directly to Uniswap V3 SwapRouter",
      },
      validFor: "30 seconds",
      timestamp: new Date().toISOString(),
      _gateway: {
        provider: "spraay-x402",
        router: "mangoswap",
        source: "uniswap-v3-quoter",
        contract: MANGOSWAP_CONTRACT,
      },
    });
  } catch (error: any) {
    console.error("Swap quote error:", error.message);
    return res.status(500).json({ error: "Failed to get swap quote", details: error.message });
  }
}

/**
 * GET /api/v1/swap/tokens
 *
 * List all supported tokens with metadata.
 */
export async function swapTokensHandler(_req: Request, res: Response) {
  try {
    const tokens = Object.entries(BASE_TOKENS)
      .filter(([key]) => key !== "ETH") // Exclude ETH alias
      .map(([_, t]) => ({
        symbol: t.symbol,
        name: t.name,
        address: t.address,
        decimals: t.decimals,
        availablePools: t.pools,
        network: "base",
        chainId: 8453,
      }));

    trackRequest("swap_tokens");

    return res.json({
      tokens,
      total: tokens.length,
      network: "base",
      router: MANGOSWAP_CONTRACT,
      supportedDexes: ["uniswap-v3", "aerodrome"],
      _gateway: { provider: "spraay-x402" },
    });
  } catch (error: any) {
    console.error("Tokens list error:", error.message);
    return res.status(500).json({ error: "Failed to list tokens" });
  }
}

// ============================================
// HELPERS
// ============================================

function resolveToken(input: string): TokenInfo | null {
  const upper = input.toUpperCase();
  if (BASE_TOKENS[upper]) return BASE_TOKENS[upper];

  const found = Object.values(BASE_TOKENS).find(
    (t) => t.address.toLowerCase() === input.toLowerCase()
  );
  return found || null;
}

/**
 * Query Uniswap V3 Quoter for a live swap quote on Base.
 * Tries all fee tiers and returns the best quote.
 */
async function getUniswapQuote(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: number
) {
  const quoter = new ethers.Contract(UNISWAP_QUOTER, QUOTER_ABI, provider);
  const amountInWei = ethers.parseUnits(amountIn.toString(), tokenIn.decimals);

  let bestQuote: any = null;
  let bestAmountOut = 0n;
  let bestFee = 0;

  // Try each fee tier, keep the best
  for (const fee of FEE_TIERS) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: amountInWei,
        fee,
        sqrtPriceLimitX96: 0,
      });

      const amountOut = result[0];
      if (amountOut > bestAmountOut) {
        bestAmountOut = amountOut;
        bestFee = fee;
        bestQuote = {
          amountOut,
          gasEstimate: result[3],
        };
      }
    } catch {
      // This fee tier doesn't have a pool for this pair, skip
      continue;
    }
  }

  if (!bestQuote) {
    // No direct pool found, try routing through WETH
    const WETH = BASE_TOKENS.WETH.address;
    if (
      tokenIn.address.toLowerCase() !== WETH.toLowerCase() &&
      tokenOut.address.toLowerCase() !== WETH.toLowerCase()
    ) {
      // Try tokenIn -> WETH -> tokenOut
      for (const fee1 of FEE_TIERS) {
        for (const fee2 of FEE_TIERS) {
          try {
            const midResult = await quoter.quoteExactInputSingle.staticCall({
              tokenIn: tokenIn.address,
              tokenOut: WETH,
              amountIn: amountInWei,
              fee: fee1,
              sqrtPriceLimitX96: 0,
            });

            const finalResult = await quoter.quoteExactInputSingle.staticCall({
              tokenIn: WETH,
              tokenOut: tokenOut.address,
              amountIn: midResult[0],
              fee: fee2,
              sqrtPriceLimitX96: 0,
            });

            if (finalResult[0] > bestAmountOut) {
              bestAmountOut = finalResult[0];
              bestFee = fee1; // Primary fee tier
              bestQuote = {
                amountOut: finalResult[0],
                gasEstimate: midResult[3] + finalResult[3],
                isMultihop: true,
                path: `${tokenIn.symbol} → WETH → ${tokenOut.symbol}`,
              };
            }
          } catch {
            continue;
          }
        }
      }
    }
  }

  if (!bestQuote) {
    throw new Error(
      `No liquidity found for ${tokenIn.symbol} → ${tokenOut.symbol} on Uniswap V3`
    );
  }

  const amountOutFormatted = ethers.formatUnits(
    bestQuote.amountOut,
    tokenOut.decimals
  );

  const executionPrice =
    amountIn > 0
      ? (parseFloat(amountOutFormatted) / amountIn).toFixed(8)
      : "0";

  const route = bestQuote.isMultihop
    ? bestQuote.path
    : `${tokenIn.symbol} → ${tokenOut.symbol}`;

  const feeTierLabel =
    bestFee === 500 ? "0.05%" : bestFee === 3000 ? "0.3%" : "1%";

  return {
    amountOut: amountOutFormatted,
    route,
    dex: "uniswap-v3",
    feeTier: feeTierLabel,
    priceImpact: "live", // Would need pool reserves to calculate precisely
    executionPrice: `1 ${tokenIn.symbol} = ${executionPrice} ${tokenOut.symbol}`,
    gasEstimate: bestQuote.gasEstimate?.toString() || "150000",
  };
}
