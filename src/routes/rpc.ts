import { Request, Response } from "express";

// x402 RPC — POST /rpc/call ($0.001), GET /rpc/chains ($0.001)

const SUPPORTED_CHAINS: Record<string, { name: string; chainId: number; rpcHint: string }> = {
  base: { name: "Base", chainId: 8453, rpcHint: "Alchemy/Infura" },
  ethereum: { name: "Ethereum", chainId: 1, rpcHint: "Alchemy/Infura" },
  arbitrum: { name: "Arbitrum One", chainId: 42161, rpcHint: "Alchemy" },
  polygon: { name: "Polygon", chainId: 137, rpcHint: "Alchemy" },
  optimism: { name: "Optimism", chainId: 10, rpcHint: "Alchemy" },
  avalanche: { name: "Avalanche C-Chain", chainId: 43114, rpcHint: "Public" },
  bsc: { name: "BNB Chain", chainId: 56, rpcHint: "Public" },
  solana: { name: "Solana", chainId: 0, rpcHint: "Helius" },
};

const ALLOWED_METHODS = [
  "eth_blockNumber", "eth_getBalance", "eth_getTransactionReceipt", "eth_getTransactionByHash",
  "eth_call", "eth_estimateGas", "eth_gasPrice", "eth_getCode", "eth_getStorageAt",
  "eth_getLogs", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_chainId",
  "eth_getTransactionCount", "net_version",
];

export async function rpcCallHandler(req: Request, res: Response) {
  try {
    const { chain, method, params } = req.body;
    if (!chain || !method) return res.status(400).json({ error: "Missing required fields: chain, method" });
    if (!SUPPORTED_CHAINS[chain]) return res.status(400).json({ error: `Unsupported chain: ${chain}`, supported: Object.keys(SUPPORTED_CHAINS) });
    if (!ALLOWED_METHODS.includes(method)) return res.status(400).json({ error: `Method not allowed: ${method}`, allowed: ALLOWED_METHODS });

    const chainInfo = SUPPORTED_CHAINS[chain];

    // Simulated response (production: proxy to actual RPC provider)
    const mockResults: Record<string, any> = {
      eth_blockNumber: "0x" + Math.floor(Date.now() / 12000).toString(16),
      eth_chainId: "0x" + chainInfo.chainId.toString(16),
      eth_gasPrice: "0x" + (1000000000 + Math.floor(Math.random() * 500000000)).toString(16),
      net_version: chainInfo.chainId.toString(),
    };

    return res.json({
      jsonrpc: "2.0", id: 1, result: mockResults[method] || null,
      chain, method, params: params || [],
      note: `Production proxies to premium ${chainInfo.rpcHint} RPC for ${chainInfo.name}.`,
      _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    return res.status(500).json({ error: "RPC call failed", details: error.message });
  }
}

export async function rpcChainsHandler(req: Request, res: Response) {
  return res.json({
    chains: Object.entries(SUPPORTED_CHAINS).map(([key, val]) => ({ id: key, ...val })),
    total: Object.keys(SUPPORTED_CHAINS).length,
    allowedMethods: ALLOWED_METHODS,
    _gateway: { provider: "spraay-x402", version: "2.9.0" }, timestamp: new Date().toISOString(),
  });
}