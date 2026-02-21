import { Request, Response } from "express";
import { ethers } from "ethers";

const BASE_RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(BASE_RPC);

const QUOTER_ADDRESS = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

const TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH" },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, symbol: "cbBTC" },
  cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, symbol: "cbETH" },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, symbol: "DAI" },
  USDbC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, symbol: "USDbC" },
  AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, symbol: "AERO" },
  DEGEN: { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18, symbol: "DEGEN" },
};

const FEE_TIERS = [500, 3000, 10000];

async function getPrice(tokenAddress: string, decimals: number): Promise<number | null> {
  const quoter = new ethers.Contract(QUOTER_ADDRESS, QUOTER_ABI, provider);
  const usdcAddress = TOKENS.USDC.address;
  if (tokenAddress.toLowerCase() === usdcAddress.toLowerCase()) return 1.0;

  const amountIn = ethers.parseUnits("1", decimals);

  for (const fee of FEE_TIERS) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: tokenAddress, tokenOut: usdcAddress, amountIn, fee, sqrtPriceLimitX96: 0,
      });
      const amountOut = Number(ethers.formatUnits(result.amountOut, 6));
      if (amountOut > 0) return amountOut;
    } catch { continue; }
  }

  // Multi-hop through WETH
  if (tokenAddress.toLowerCase() !== TOKENS.WETH.address.toLowerCase()) {
    for (const fee1 of FEE_TIERS) {
      try {
        const r1 = await quoter.quoteExactInputSingle.staticCall({
          tokenIn: tokenAddress, tokenOut: TOKENS.WETH.address, amountIn, fee: fee1, sqrtPriceLimitX96: 0,
        });
        for (const fee2 of FEE_TIERS) {
          try {
            const r2 = await quoter.quoteExactInputSingle.staticCall({
              tokenIn: TOKENS.WETH.address, tokenOut: usdcAddress, amountIn: r1.amountOut, fee: fee2, sqrtPriceLimitX96: 0,
            });
            const out = Number(ethers.formatUnits(r2.amountOut, 6));
            if (out > 0) return out;
          } catch { continue; }
        }
      } catch { continue; }
    }
  }
  return null;
}

let priceCache: { data: any; timestamp: number } | null = null;
const CACHE_TTL = 30_000;

export async function pricesHandler(req: Request, res: Response) {
  try {
    const now = Date.now();
    const tokenQuery = (req.query.token as string)?.toUpperCase();

    if (priceCache && now - priceCache.timestamp < CACHE_TTL && !tokenQuery) {
      return res.json(priceCache.data);
    }

    const tokensToQuery = tokenQuery && TOKENS[tokenQuery] ? { [tokenQuery]: TOKENS[tokenQuery] } : TOKENS;
    const prices: Record<string, any> = {};

    await Promise.all(
      Object.entries(tokensToQuery).map(async ([key, token]) => {
        const price = await getPrice(token.address, token.decimals);
        prices[key] = { symbol: token.symbol, address: token.address, decimals: token.decimals, priceUSD: price };
      })
    );

    const response = {
      prices,
      network: "base",
      chainId: 8453,
      source: "uniswap-v3-onchain",
      timestamp: new Date().toISOString(),
      tokenCount: Object.keys(prices).length,
    };

    if (!tokenQuery) priceCache = { data: response, timestamp: now };
    res.json(response);
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch prices", details: error.message });
  }
}
