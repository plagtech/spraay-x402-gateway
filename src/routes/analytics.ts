import { Request, Response } from "express";
import {
  JsonRpcProvider,
  Contract,
  isAddress,
  formatUnits,
  formatEther,
} from "ethers";
import { trackRequest } from "./health.js";

// ============================================
// CONSTANTS
// ============================================

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const CHAIN_ID = 8453;
const BASESCAN_API = "https://api.basescan.org/api";
const BASESCAN_KEY = process.env.BASESCAN_API_KEY || "";

// ============================================
// TOKEN LIST FOR BALANCE PROFILING
// ============================================

const PROFILE_TOKENS: { address: string; symbol: string; decimals: number }[] = [
  { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  { address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", symbol: "USDT", decimals: 6 },
  { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
  { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
  { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18 },
  { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN", decimals: 18 },
  { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", symbol: "BRETT", decimals: 18 },
];

const ERC20_ABI = [
  "function balanceOf(address) external view returns (uint256)",
];

// ============================================
// HELPERS
// ============================================

async function fetchBasescan(params: Record<string, string>): Promise<any> {
  if (!BASESCAN_KEY) return null;

  const url = new URL(BASESCAN_API);
  for (const [key, val] of Object.entries(params)) {
    url.searchParams.set(key, val);
  }
  url.searchParams.set("apikey", BASESCAN_KEY);

  const response = await fetch(url.toString());
  if (!response.ok) return null;

  const data = await response.json();
  if (data.status !== "1") return null;
  return data.result;
}

// ============================================
// ROUTE HANDLERS
// ============================================

/**
 * GET /api/v1/analytics/wallet
 *
 * Comprehensive wallet profile: ETH + token balances, tx count,
 * first/last activity, estimated wallet age, and portfolio breakdown.
 *
 * Query params:
 *   address - Wallet address to profile
 */
export async function analyticsWalletHandler(req: Request, res: Response) {
  try {
    const { address } = req.query;

    if (!address || !isAddress(address as string)) {
      return res.status(400).json({
        error: "Valid address query param is required",
        example: "/api/v1/analytics/wallet?address=0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      });
    }

    const addr = address as string;
    const provider = new JsonRpcProvider(RPC_URL);

    // ---- Fetch ETH balance and tx count concurrently ----
    const [ethBalance, txCount, blockNumber] = await Promise.all([
      provider.getBalance(addr),
      provider.getTransactionCount(addr),
      provider.getBlockNumber(),
    ]);

    const ethBalanceFormatted = formatEther(ethBalance);

    // ---- Fetch ERC-20 balances ----
    const tokenResults = await Promise.allSettled(
      PROFILE_TOKENS.map(async (token) => {
        const contract = new Contract(token.address, ERC20_ABI, provider);
        const balance: bigint = await contract.balanceOf(addr);
        return {
          symbol: token.symbol,
          address: token.address,
          balance: formatUnits(balance, token.decimals),
          balanceRaw: balance.toString(),
          hasBalance: balance > 0n,
        };
      })
    );

    const tokenBalances: any[] = [];
    let tokenCount = 0;

    for (const result of tokenResults) {
      if (result.status === "fulfilled") {
        tokenBalances.push(result.value);
        if (result.value.hasBalance) tokenCount++;
      }
    }

    // ---- Fetch first/last tx from Basescan if key available ----
    let activityData: any = null;

    if (BASESCAN_KEY) {
      const [firstTxs, lastTxs] = await Promise.all([
        fetchBasescan({
          module: "account",
          action: "txlist",
          address: addr,
          startblock: "0",
          endblock: "99999999",
          page: "1",
          offset: "1",
          sort: "asc",
        }),
        fetchBasescan({
          module: "account",
          action: "txlist",
          address: addr,
          startblock: "0",
          endblock: "99999999",
          page: "1",
          offset: "1",
          sort: "desc",
        }),
      ]);

      if (firstTxs && firstTxs.length > 0) {
        const firstTx = firstTxs[0];
        const lastTx = lastTxs && lastTxs.length > 0 ? lastTxs[0] : null;

        const firstTimestamp = parseInt(firstTx.timeStamp) * 1000;
        const lastTimestamp = lastTx ? parseInt(lastTx.timeStamp) * 1000 : firstTimestamp;
        const ageMs = Date.now() - firstTimestamp;
        const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

        activityData = {
          firstTransaction: {
            hash: firstTx.hash,
            timestamp: new Date(firstTimestamp).toISOString(),
            block: parseInt(firstTx.blockNumber),
          },
          lastTransaction: lastTx
            ? {
                hash: lastTx.hash,
                timestamp: new Date(lastTimestamp).toISOString(),
                block: parseInt(lastTx.blockNumber),
              }
            : null,
          walletAge: {
            days: ageDays,
            months: Math.floor(ageDays / 30),
            firstSeen: new Date(firstTimestamp).toISOString(),
          },
          isActive: lastTx
            ? Date.now() - lastTimestamp < 30 * 24 * 60 * 60 * 1000
            : false,
          activeDays: lastTx
            ? Math.floor((lastTimestamp - firstTimestamp) / (1000 * 60 * 60 * 24))
            : 0,
        };
      }
    }

    // ---- Wallet classification ----
    const ethBal = parseFloat(ethBalanceFormatted);
    const stableBalances = tokenBalances
      .filter((t) => ["USDC", "USDT", "DAI", "EURC"].includes(t.symbol) && t.hasBalance)
      .reduce((sum, t) => sum + parseFloat(t.balance), 0);

    let walletType = "unknown";
    if (txCount === 0) walletType = "virgin";
    else if (txCount < 5) walletType = "new";
    else if (txCount < 50) walletType = "casual";
    else if (txCount < 500) walletType = "active";
    else walletType = "power-user";

    let profile = "general";
    if (stableBalances > 10000) profile = "treasury";
    else if (stableBalances > 1000) profile = "stablecoin-holder";
    else if (ethBal > 10) profile = "eth-whale";
    else if (tokenCount > 5) profile = "diversified";

    trackRequest("analytics_wallet");

    return res.json({
      address: addr,
      classification: {
        walletType,
        profile,
        txCount,
        tokenCount,
      },
      balances: {
        eth: {
          balance: ethBalanceFormatted,
          balanceRaw: ethBalance.toString(),
        },
        tokens: tokenBalances,
        stablecoinsUSD: stableBalances.toFixed(2),
      },
      activity: activityData,
      chain: "Base",
      chainId: CHAIN_ID,
      currentBlock: blockNumber,
      _gateway: {
        provider: "spraay-x402",
        version: "2.6.0",
        endpoint: "GET /api/v1/analytics/wallet",
        note: activityData
          ? "Full activity data via Basescan"
          : "Activity data requires BASESCAN_API_KEY env var",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Analytics wallet error:", error.message);
    return res.status(500).json({
      error: "Failed to analyze wallet",
      details: error.message,
    });
  }
}

/**
 * GET /api/v1/analytics/txhistory
 *
 * Recent transaction history for a wallet on Base.
 * Returns last N transactions with decoded summaries.
 *
 * Query params:
 *   address - Wallet address
 *   limit   - Number of transactions (default 10, max 50)
 */
export async function analyticsTxHistoryHandler(req: Request, res: Response) {
  try {
    const { address, limit } = req.query;

    if (!address || !isAddress(address as string)) {
      return res.status(400).json({
        error: "Valid address query param is required",
        example: "/api/v1/analytics/txhistory?address=0x...&limit=10",
      });
    }

    const addr = address as string;
    const txLimit = Math.min(Math.max(parseInt(limit as string) || 10, 1), 50);

    if (!BASESCAN_KEY) {
      // Fallback: use RPC to get recent blocks
      const provider = new JsonRpcProvider(RPC_URL);
      const txCount = await provider.getTransactionCount(addr);

      return res.json({
        address: addr,
        transactions: [],
        count: 0,
        totalTxCount: txCount,
        note: "Detailed tx history requires BASESCAN_API_KEY. Only tx count available via RPC.",
        _gateway: {
          provider: "spraay-x402",
          version: "2.6.0",
          endpoint: "GET /api/v1/analytics/txhistory",
        },
        timestamp: new Date().toISOString(),
      });
    }

    // Fetch from Basescan
    const txs = await fetchBasescan({
      module: "account",
      action: "txlist",
      address: addr,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: txLimit.toString(),
      sort: "desc",
    });

    if (!txs || txs.length === 0) {
      return res.json({
        address: addr,
        transactions: [],
        count: 0,
        note: "No transactions found",
        _gateway: { provider: "spraay-x402", version: "2.6.0" },
        timestamp: new Date().toISOString(),
      });
    }

    const transactions = txs.map((tx: any) => {
      const isOutgoing = tx.from.toLowerCase() === addr.toLowerCase();
      const value = formatEther(tx.value || "0");
      const gasUsed = tx.gasUsed ? parseInt(tx.gasUsed) : 0;
      const gasPrice = tx.gasPrice ? parseInt(tx.gasPrice) : 0;
      const gasCostETH = formatEther(BigInt(gasUsed) * BigInt(gasPrice));

      let txType = "unknown";
      if (tx.input === "0x" && parseFloat(value) > 0) {
        txType = isOutgoing ? "eth-send" : "eth-receive";
      } else if (tx.input && tx.input.length > 10) {
        const methodId = tx.input.slice(0, 10);
        // Common method signatures
        if (methodId === "0xa9059cbb") txType = "erc20-transfer";
        else if (methodId === "0x095ea7b3") txType = "erc20-approve";
        else if (methodId === "0x38ed1739" || methodId === "0x414bf389") txType = "swap";
        else if (methodId === "0xe449022e") txType = "swap-1inch";
        else txType = "contract-call";
      }

      return {
        hash: tx.hash,
        block: parseInt(tx.blockNumber),
        timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
        direction: isOutgoing ? "outgoing" : "incoming",
        type: txType,
        from: tx.from,
        to: tx.to,
        value: value,
        gasCostETH,
        status: tx.txreceipt_status === "1" ? "success" : "failed",
        methodId: tx.input ? tx.input.slice(0, 10) : null,
      };
    });

    // Summary stats
    const outgoing = transactions.filter((t: any) => t.direction === "outgoing").length;
    const incoming = transactions.filter((t: any) => t.direction === "incoming").length;
    const failed = transactions.filter((t: any) => t.status === "failed").length;
    const types = transactions.reduce((acc: Record<string, number>, t: any) => {
      acc[t.type] = (acc[t.type] || 0) + 1;
      return acc;
    }, {});

    trackRequest("analytics_txhistory");

    return res.json({
      address: addr,
      transactions,
      count: transactions.length,
      summary: {
        outgoing,
        incoming,
        failed,
        successRate: `${(((transactions.length - failed) / transactions.length) * 100).toFixed(1)}%`,
        types,
      },
      _gateway: {
        provider: "spraay-x402",
        version: "2.6.0",
        endpoint: "GET /api/v1/analytics/txhistory",
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error("Analytics txhistory error:", error.message);
    return res.status(500).json({
      error: "Failed to fetch transaction history",
      details: error.message,
    });
  }
}
