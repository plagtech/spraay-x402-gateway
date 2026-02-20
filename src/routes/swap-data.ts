import { Request, Response } from "express";
import { trackRequest } from "./health";

// MangoSwap contract on Base
const MANGOSWAP_CONTRACT = "0xb81fea65B45D743AB62a1A2B351f4f92fb1d4D16";

// Popular Base tokens with pool data
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
};

interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  pools: string[];
}

/**
 * GET /api/v1/swap/quote
 * 
 * Get an optimal swap quote routed through Uniswap V3 and Aerodrome.
 * This is what agents need when they want to swap tokens on Base.
 * 
 * Query params:
 *   tokenIn=USDC (or 0x address)
 *   tokenOut=WETH (or 0x address)
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
      });
    }

    // Resolve token symbols to addresses
    const tokenInInfo = resolveToken(tokenIn as string);
    const tokenOutInfo = resolveToken(tokenOut as string);

    if (!tokenInInfo) {
      return res.status(400).json({ error: `Unknown token: ${tokenIn}` });
    }
    if (!tokenOutInfo) {
      return res.status(400).json({ error: `Unknown token: ${tokenOut}` });
    }

    const amount = parseFloat(amountIn as string);
    if (isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Invalid amountIn" });
    }

    // Determine best route
    // In production, this queries Uniswap V3 Quoter and Aerodrome router
    const quote = await getSwapQuote(tokenInInfo, tokenOutInfo, amount);

    trackRequest("swap_quote");

    return res.json({
      tokenIn: {
        symbol: tokenInInfo.symbol,
        address: tokenInInfo.address,
        amount: amount.toString(),
      },
      tokenOut: {
        symbol: tokenOutInfo.symbol,
        address: tokenOutInfo.address,
        estimatedAmount: quote.amountOut,
      },
      route: quote.route,
      dex: quote.dex,
      priceImpact: quote.priceImpact,
      executionPrice: quote.executionPrice,
      // Transaction data the agent can submit directly
      transaction: {
        to: MANGOSWAP_CONTRACT,
        data: quote.calldata,
        value: tokenInInfo.symbol === "ETH" ? quote.valueWei : "0",
        chainId: 8453,
      },
      validFor: "30 seconds",
      _gateway: {
        provider: "spraay-x402",
        router: "mangoswap",
        contract: MANGOSWAP_CONTRACT,
      },
    });
  } catch (error: any) {
    console.error("Swap quote error:", error.message);
    return res.status(500).json({ error: "Failed to get swap quote" });
  }
}

/**
 * GET /api/v1/swap/tokens
 * 
 * List all supported tokens with metadata.
 * Agents use this to discover tradeable assets.
 */
export async function swapTokensHandler(_req: Request, res: Response) {
  try {
    const tokens = Object.values(BASE_TOKENS).map((t) => ({
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
  // Check if it's a symbol
  const upper = input.toUpperCase();
  if (BASE_TOKENS[upper]) return BASE_TOKENS[upper];

  // Check if it's an address
  const found = Object.values(BASE_TOKENS).find(
    (t) => t.address.toLowerCase() === input.toLowerCase()
  );
  return found || null;
}

/**
 * Get swap quote from DEX routers.
 * 
 * In production, this would:
 * 1. Query Uniswap V3 Quoter contract for best pool/path
 * 2. Query Aerodrome Router for their quote
 * 3. Compare and return the best option
 * 4. Encode the actual swap calldata
 * 
 * For the MVP, we return simulated data to demonstrate the API structure.
 */
async function getSwapQuote(
  tokenIn: TokenInfo,
  tokenOut: TokenInfo,
  amountIn: number
) {
  // Simulated pricing - replace with actual DEX queries
  const mockPrices: Record<string, number> = {
    USDC: 1.0,
    WETH: 2500,
    cbBTC: 45000,
    AERO: 1.2,
    DEGEN: 0.008,
    BRETT: 0.05,
    TOSHI: 0.0004,
    USDbC: 1.0,
  };

  const priceIn = mockPrices[tokenIn.symbol] || 1;
  const priceOut = mockPrices[tokenOut.symbol] || 1;
  const valueUSD = amountIn * priceIn;
  const amountOut = (valueUSD / priceOut) * 0.997; // 0.3% fee

  // Determine which DEX has better routing
  const sharedPools = tokenIn.pools.filter((p) => tokenOut.pools.includes(p));
  const bestDex = sharedPools.includes("uniswap-v3")
    ? "uniswap-v3"
    : "aerodrome";

  const route =
    tokenIn.symbol === "USDC" || tokenOut.symbol === "USDC"
      ? `${tokenIn.symbol} → ${tokenOut.symbol}`
      : `${tokenIn.symbol} → USDC → ${tokenOut.symbol}`;

  return {
    amountOut: amountOut.toFixed(tokenOut.decimals > 6 ? 8 : 6),
    route,
    dex: bestDex,
    priceImpact: amountIn * priceIn > 10000 ? "0.15%" : "0.05%",
    executionPrice: `1 ${tokenIn.symbol} = ${(priceIn / priceOut).toFixed(8)} ${tokenOut.symbol}`,
    calldata: `0x__mangoswap_${tokenIn.symbol}_${tokenOut.symbol}`,
    valueWei: "0",
  };
}
