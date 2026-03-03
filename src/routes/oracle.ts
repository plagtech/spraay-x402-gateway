import { Request, Response } from "express";
import {
  JsonRpcProvider,
  Contract,
  formatUnits,
  parseUnits,
} from "ethers";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;

// Uniswap V3 Quoter V2 on Base
const QUOTER_V2 = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";

// USDC as the base quote currency
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

// ============================================
// TOKEN REGISTRY
// ============================================

interface OracleToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  feeTiers: number[];
  category: "major" | "stablecoin" | "memecoin" | "defi";
}

const ORACLE_TOKENS: Record<string, OracleToken> = {
  ETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "ETH",
    name: "Ether",
    decimals: 18,
    feeTiers: [500, 3000],
    category: "major",
  },
  WETH: {
    address: "0x4200000000000000000000000000000000000006",
    symbol: "WETH",
    name: "Wrapped Ether",
    decimals: 18,
    feeTiers: [500, 3000],
    category: "major",
  },
  cbBTC: {
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    decimals: 8,
    feeTiers: [500, 3000],
    category: "major",
  },
  USDC: {
    address: USDC_ADDRESS,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    feeTiers: [],
    category: "stablecoin",
  },
  USDT: {
    address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    feeTiers: [100, 500],
    category: "stablecoin",
  },
  DAI: {
    address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    symbol: "DAI",
    name: "Dai Stablecoin",
    decimals: 18,
    feeTiers: [100, 500],
    category: "stablecoin",
  },
  EURC: {
    address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
    symbol: "EURC",
    name: "Euro Coin",
    decimals: 6,
    feeTiers: [500, 3000],
    category: "stablecoin",
  },
  USDbC: {
    address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
    symbol: "USDbC",
    name: "USD Base Coin",
    decimals: 6,
    feeTiers: [100, 500],
    category: "stablecoin",
  },
  AERO: {
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    symbol: "AERO",
    name: "Aerodrome Finance",
    decimals: 18,
    feeTiers: [3000, 10000],
    category: "defi",
  },
  DEGEN: {
    address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
    symbol: "DEGEN",
    name: "Degen",
    decimals: 18,
    feeTiers: [3000, 10000],
    category: "memecoin",
  },
  BRETT: {
    address: "0x532f27101965dd16442E59d40670FaF5eBB142E4",
    symbol: "BRETT",
    name: "Brett",
    decimals: 18,
    feeTiers: [3000, 10000],
    category: "memecoin",
  },
  TOSHI: {
    address: "0xAC1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4",
    symbol: "TOSHI",
    name: "Toshi",
    decimals: 18,
    feeTiers: [3000, 10000],
    category: "memecoin",
  },
};

// ============================================
// ABIs
// ============================================

const QUOTER_V2_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
];

// ============================================
// HELPERS
// ============================================

function resolveToken(input: string): OracleToken | null {
  const upper = input.toUpperCase();
  if (ORACLE_TOKENS[upper]) return ORACLE_TOKENS[upper];

  const lower = input.toLowerCase();
  for (const token of Object.values(ORACLE_TOKENS)) {
    if (token.address.toLowerCase() === lower) return token;
  }
  return null;
}

/**
 * Get the USD price of a token by quoting against USDC via Uniswap V3
 */
async function getTokenPriceUSD(
  quoter: Contract,
  token: OracleToken
): Promise<{ priceUSD: number; feeTier: number; confidence: string } | null> {
  // USDC is always $1
  if (token.address.toLowerCase() === USDC_ADDRESS.toLowerCase()) {
    return { priceUSD: 1.0, feeTier: 0, confidence: "pegged" };
  }

  // For stablecoins, quote 1000 units to get better precision
  const isStable = token.category === "stablecoin";
  const quoteAmount = isStable ? "1000" : "1";
  const amountIn = parseUnits(quoteAmount, token.decimals);

  let bestPrice = 0;
  let bestFeeTier = 0;

  for (const fee of token.feeTiers) {
    try {
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: token.address,
        tokenOut: USDC_ADDRESS,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0,
      });

      const amountOut: bigint = result[0];
      const priceRaw = parseFloat(formatUnits(amountOut, USDC_DECIMALS));
      const price = isStable ? priceRaw / 1000 : priceRaw;

      if (price > bestPrice) {
        bestPrice = price;
        bestFeeTier = fee;
      }
    } catch {
      continue;
    }
  }

  if (bestPrice === 0) return null;

  // Confidence based on category
  let confidence = "high";
  if (token.category === "memecoin") confidence = "medium";
  if (token.category === "stablecoin") {
    confidence = Math.abs(bestPrice - 1.0) < 0.005 ? "pegged" : "depeg-warning";
  }

  return { priceUSD: bestPrice, feeTier: bestFeeTier, confidence };
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * GET /api/v1/oracle/prices
 *
 * Multi-token price feed with category tagging and confidence scores.
 * Returns all tokens or a single token via ?tokens=ETH,cbBTC
 *
 * Query params:
 *   tokens (optional) - Comma-separated symbols or addresses. Omit for all.
 *   category (optional) - Filter by: major, stablecoin, memecoin, defi
 */
export async function oraclePricesHandler(req: Request, res: Response) {
  try {
    const { tokens, category } = req.query;

    const provider = new JsonRpcProvider(RPC_URL);
    const quoter = new Contract(QUOTER_V2, QUOTER_V2_ABI, provider);

    // Determine which tokens to price
    let targetTokens: OracleToken[] = [];

    if (tokens) {
      const symbols = (tokens as string).split(",").map((s) => s.trim());
      for (const sym of symbols) {
        const token = resolveToken(sym);
        if (token) targetTokens.push(token);
      }
      if (targetTokens.length === 0) {
        return res.status(400).json({
          error: "No valid tokens found",
          supportedTokens: Object.keys(ORACLE_TOKENS),
        });
      }
    } else if (category) {
      targetTokens = Object.values(ORACLE_TOKENS).filter(
        (t) => t.category === (category as string).toLowerCase()
      );
      if (targetTokens.length === 0) {
        return res.status(400).json({
          error: `No tokens in category: ${category}`,
          categories: ["major", "stablecoin", "memecoin", "defi"],
        });
      }
    } else {
      // Deduplicate ETH/WETH — only include ETH
      targetTokens = Object.values(ORACLE_TOKENS).filter((t) => t.symbol !== "WETH");
    }

    // Fetch all prices concurrently
    const priceResults = await Promise.allSettled(
      targetTokens.map(async (token) => {
        const result = await getTokenPriceUSD(quoter, token);
        return { token, result };
      })
    );

    const prices: Record<string, any> = {};
    let successCount = 0;

    for (const entry of priceResults) {
      if (entry.status === "fulfilled" && entry.value.result) {
        const { token, result } = entry.value;
        prices[token.symbol] = {
          symbol: token.symbol,
          name: token.name,
          address: token.address,
          decimals: token.decimals,
          category: token.category,
          priceUSD: result.priceUSD,
          feeTier: result.feeTier,
          confidence: result.confidence,
        };
        successCount++;
      }
    }

    trackRequest("oracle_prices");

    return res.json({
      prices,
      meta: {
        tokenCount: successCount,
        quoteCurrency: "USD",
        source: "uniswap-v3-onchain",
        chain: "Base",
        chainId: CHAIN_ID,
        blockTime: "~2s",
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/oracle/prices",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Oracle prices error:", error.message);
    return res.status(500).json({
      error: "Failed to fetch price data",
      details: error.message,
    });
  }
}

/**
 * GET /api/v1/oracle/gas
 *
 * Real-time gas price data on Base.
 * Returns current gas price, priority fee, and estimated costs for common operations.
 */
export async function oracleGasHandler(req: Request, res: Response) {
  try {
    const provider = new JsonRpcProvider(RPC_URL);

    // Fetch gas data
    const [feeData, block] = await Promise.all([
      provider.getFeeData(),
      provider.getBlock("latest"),
    ]);

    const gasPrice = feeData.gasPrice ?? 0n;
    const maxFeePerGas = feeData.maxFeePerGas ?? 0n;
    const maxPriorityFee = feeData.maxPriorityFeePerGas ?? 0n;

    // Estimate costs for common operations (in ETH)
    const estimateCost = (gasUnits: number): string => {
      const cost = gasPrice * BigInt(gasUnits);
      return formatUnits(cost, 18);
    };

    // Get ETH price for USD conversion
    const quoter = new Contract(QUOTER_V2, QUOTER_V2_ABI, provider);
    let ethPriceUSD = 0;
    try {
      const ethToken = ORACLE_TOKENS["ETH"];
      const result = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: ethToken.address,
        tokenOut: USDC_ADDRESS,
        amountIn: parseUnits("1", 18),
        fee: 500,
        sqrtPriceLimitX96: 0,
      });
      ethPriceUSD = parseFloat(formatUnits(result[0], USDC_DECIMALS));
    } catch {
      // Fall back to 0 if price fetch fails
    }

    const estimateCostUSD = (gasUnits: number): string => {
      if (ethPriceUSD === 0) return "N/A";
      const costETH = parseFloat(estimateCost(gasUnits));
      return `$${(costETH * ethPriceUSD).toFixed(6)}`;
    };

    trackRequest("oracle_gas");

    return res.json({
      gas: {
        gasPrice: {
          wei: gasPrice.toString(),
          gwei: formatUnits(gasPrice, 9),
        },
        maxFeePerGas: {
          wei: maxFeePerGas.toString(),
          gwei: formatUnits(maxFeePerGas, 9),
        },
        maxPriorityFeePerGas: {
          wei: maxPriorityFee.toString(),
          gwei: formatUnits(maxPriorityFee, 9),
        },
        baseFee: block?.baseFeePerGas
          ? {
              wei: block.baseFeePerGas.toString(),
              gwei: formatUnits(block.baseFeePerGas, 9),
            }
          : null,
      },
      estimates: {
        ethTransfer: {
          gasUnits: 21000,
          costETH: estimateCost(21000),
          costUSD: estimateCostUSD(21000),
        },
        erc20Transfer: {
          gasUnits: 65000,
          costETH: estimateCost(65000),
          costUSD: estimateCostUSD(65000),
        },
        erc20Approve: {
          gasUnits: 46000,
          costETH: estimateCost(46000),
          costUSD: estimateCostUSD(46000),
        },
        uniswapSwap: {
          gasUnits: 185000,
          costETH: estimateCost(185000),
          costUSD: estimateCostUSD(185000),
        },
        spraayBatch5: {
          gasUnits: 250000,
          costETH: estimateCost(250000),
          costUSD: estimateCostUSD(250000),
          note: "Batch payment to 5 recipients",
        },
        spraayBatch50: {
          gasUnits: 1500000,
          costETH: estimateCost(1500000),
          costUSD: estimateCostUSD(1500000),
          note: "Batch payment to 50 recipients",
        },
      },
      ethPriceUSD: ethPriceUSD > 0 ? ethPriceUSD : null,
      block: {
        number: block?.number ?? null,
        timestamp: block?.timestamp ?? null,
        gasUsed: block?.gasUsed?.toString() ?? null,
        gasLimit: block?.gasLimit?.toString() ?? null,
      },
      chain: "Base",
      chainId: CHAIN_ID,
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/oracle/gas",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Oracle gas error:", error.message);
    return res.status(500).json({
      error: "Failed to fetch gas data",
      details: error.message,
    });
  }
}

/**
 * GET /api/v1/oracle/fx
 *
 * Stablecoin FX rates — relative pricing between stablecoins on Base.
 * Useful for detecting depegs, arbitrage opportunities, and cross-stablecoin routing.
 *
 * Query params:
 *   base (optional) - Base stablecoin to quote against (default: USDC)
 */
export async function oracleFxHandler(req: Request, res: Response) {
  try {
    const baseSymbol = ((req.query.base as string) || "USDC").toUpperCase();
    const baseToken = resolveToken(baseSymbol);

    if (!baseToken || baseToken.category !== "stablecoin") {
      return res.status(400).json({
        error: `Invalid base currency: ${baseSymbol}. Must be a stablecoin.`,
        supported: Object.values(ORACLE_TOKENS)
          .filter((t) => t.category === "stablecoin")
          .map((t) => t.symbol),
      });
    }

    const provider = new JsonRpcProvider(RPC_URL);
    const quoter = new Contract(QUOTER_V2, QUOTER_V2_ABI, provider);

    // Get all stablecoins except the base
    const stablecoins = Object.values(ORACLE_TOKENS).filter(
      (t) =>
        t.category === "stablecoin" &&
        t.address.toLowerCase() !== baseToken.address.toLowerCase()
    );

    // Quote 1000 units of each stablecoin against the base for precision
    const quoteAmount = parseUnits("1000", baseToken.decimals);

    const fxResults = await Promise.allSettled(
      stablecoins.map(async (stable) => {
        // Quote: how much of `stable` do you get for 1000 base?
        const feeTiers = [...new Set([...baseToken.feeTiers, ...stable.feeTiers])];
        if (feeTiers.length === 0) feeTiers.push(100, 500);

        let bestRate = 0;
        let bestFee = 0;

        for (const fee of feeTiers) {
          try {
            const result = await quoter.quoteExactInputSingle.staticCall({
              tokenIn: baseToken.address,
              tokenOut: stable.address,
              amountIn: quoteAmount,
              fee,
              sqrtPriceLimitX96: 0,
            });

            const amountOut = parseFloat(formatUnits(result[0], stable.decimals));
            const rate = amountOut / 1000; // rate per 1 base unit

            if (rate > bestRate) {
              bestRate = rate;
              bestFee = fee;
            }
          } catch {
            continue;
          }
        }

        return { stable, rate: bestRate, feeTier: bestFee };
      })
    );

    const rates: Record<string, any> = {};

    for (const entry of fxResults) {
      if (entry.status === "fulfilled" && entry.value.rate > 0) {
        const { stable, rate, feeTier } = entry.value;
        const deviation = Math.abs(rate - 1.0);

        let status = "stable";
        if (deviation > 0.01) status = "minor-deviation";
        if (deviation > 0.05) status = "depeg-warning";

        rates[stable.symbol] = {
          symbol: stable.symbol,
          name: stable.name,
          address: stable.address,
          rate: parseFloat(rate.toFixed(6)),
          inverseRate: parseFloat((1 / rate).toFixed(6)),
          deviation: `${(deviation * 100).toFixed(3)}%`,
          status,
          feeTier,
        };
      }
    }

    // Also include EURC → USD rate if base is USDC
    if (rates["EURC"]) {
      rates["EURC"].note = "EUR/USD rate derived from on-chain EURC/USDC liquidity";
    }

    trackRequest("oracle_fx");

    return res.json({
      base: baseSymbol,
      rates,
      meta: {
        pairCount: Object.keys(rates).length,
        source: "uniswap-v3-onchain",
        chain: "Base",
        chainId: CHAIN_ID,
        note: "Rates are derived from on-chain DEX liquidity. Large trades may experience slippage.",
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.2.0",
        endpoint: "GET /api/v1/oracle/fx",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Oracle FX error:", error.message);
    return res.status(500).json({
      error: "Failed to fetch FX rates",
      details: error.message,
    });
  }
}
