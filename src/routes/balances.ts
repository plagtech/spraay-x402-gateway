import { Request, Response } from "express";
import { ethers } from "ethers";

const BASE_RPC = "https://mainnet.base.org";
const provider = new ethers.JsonRpcProvider(BASE_RPC);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

// Popular tokens on Base
const DEFAULT_TOKENS: Record<string, { address: string; decimals: number; symbol: string }> = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18, symbol: "WETH" },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8, symbol: "cbBTC" },
  cbETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", decimals: 18, symbol: "cbETH" },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, symbol: "DAI" },
  USDbC: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, symbol: "USDbC" },
  AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", decimals: 18, symbol: "AERO" },
  DEGEN: { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", decimals: 18, symbol: "DEGEN" },
};

export async function balancesHandler(req: Request, res: Response) {
  try {
    const address = req.query.address as string;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ error: "Valid 'address' query parameter required" });
    }

    // Optional: comma-separated token addresses to check
    const customTokens = req.query.tokens as string;

    // Get ETH balance
    const ethBalance = await provider.getBalance(address);

    // Get token balances
    const balances: any[] = [];

    // ETH first
    balances.push({
      symbol: "ETH",
      address: "native",
      decimals: 18,
      balance: ethers.formatEther(ethBalance),
      balanceRaw: ethBalance.toString(),
    });

    if (customTokens) {
      // User specified custom token addresses
      const tokenAddresses = customTokens.split(",").map((t) => t.trim());
      await Promise.all(
        tokenAddresses.map(async (tokenAddr) => {
          try {
            const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
            const [bal, symbol, decimals] = await Promise.all([
              contract.balanceOf(address),
              contract.symbol(),
              contract.decimals(),
            ]);
            balances.push({
              symbol,
              address: tokenAddr,
              decimals: Number(decimals),
              balance: ethers.formatUnits(bal, decimals),
              balanceRaw: bal.toString(),
            });
          } catch {
            balances.push({ address: tokenAddr, error: "Failed to query token" });
          }
        })
      );
    } else {
      // Default popular tokens
      await Promise.all(
        Object.entries(DEFAULT_TOKENS).map(async ([_, token]) => {
          try {
            const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
            const bal = await contract.balanceOf(address);
            balances.push({
              symbol: token.symbol,
              address: token.address,
              decimals: token.decimals,
              balance: ethers.formatUnits(bal, token.decimals),
              balanceRaw: bal.toString(),
            });
          } catch {
            // Skip failed tokens
          }
        })
      );
    }

    // Filter out zero balances unless specifically requested
    const showAll = req.query.showAll === "true";
    const filtered = showAll ? balances : balances.filter((b) => b.balanceRaw !== "0" || b.symbol === "ETH");

    res.json({
      address,
      network: "base",
      chainId: 8453,
      balances: filtered,
      tokenCount: filtered.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    res.status(500).json({ error: "Failed to fetch balances", details: error.message });
  }
}
