import { Request, Response } from "express";
import { ethers } from "ethers";

// Use Ethereum mainnet for ENS, Base for Basenames
const ETH_RPC = "https://eth.llamarpc.com";
const BASE_RPC = "https://mainnet.base.org";
const ethProvider = new ethers.JsonRpcProvider(ETH_RPC);
const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);

// Base L2 Resolver for Basenames
const BASE_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
const RESOLVER_ABI = [
  "function addr(bytes32 node) view returns (address)",
];

function namehash(name: string): string {
  let node = "0x" + "00".repeat(32);
  if (name === "") return node;
  const labels = name.split(".");
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = ethers.keccak256(ethers.toUtf8Bytes(labels[i]));
    node = ethers.keccak256(ethers.concat([node, labelHash]));
  }
  return node;
}

export async function resolveHandler(req: Request, res: Response) {
  try {
    const name = req.query.name as string;
    if (!name) {
      return res.status(400).json({ error: "'name' query parameter required (e.g. vitalik.eth or jesse.base.eth)" });
    }

    let address: string | null = null;
    let source: string = "unknown";

    if (name.endsWith(".base.eth")) {
      // Basename resolution on Base
      try {
        const node = namehash(name);
        const resolver = new ethers.Contract(BASE_RESOLVER, RESOLVER_ABI, baseProvider);
        const resolved = await resolver.addr(node);
        if (resolved && resolved !== ethers.ZeroAddress) {
          address = resolved;
          source = "basename";
        }
      } catch {
        // Fall through
      }
    }

    if (!address && name.endsWith(".eth")) {
      // ENS resolution on Ethereum mainnet
      try {
        const resolved = await ethProvider.resolveName(name);
        if (resolved) {
          address = resolved;
          source = "ens";
        }
      } catch {
        // Fall through
      }
    }

    // Also try reverse: if input is an address, get ENS name
    if (!address && ethers.isAddress(name)) {
      try {
        const ensName = await ethProvider.lookupAddress(name);
        return res.json({
          input: name,
          address: name,
          name: ensName,
          source: ensName ? "ens-reverse" : "address",
          network: "base",
          timestamp: new Date().toISOString(),
        });
      } catch {
        return res.json({
          input: name,
          address: name,
          name: null,
          source: "address",
          network: "base",
          timestamp: new Date().toISOString(),
        });
      }
    }

    if (address) {
      res.json({
        input: name,
        address,
        source,
        network: "base",
        timestamp: new Date().toISOString(),
      });
    } else {
      res.status(404).json({
        input: name,
        address: null,
        error: "Could not resolve name",
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error: any) {
    res.status(500).json({ error: "Resolution failed", details: error.message });
  }
}
