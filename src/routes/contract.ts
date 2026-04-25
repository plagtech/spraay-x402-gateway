/**
 * Contract API handlers — generic EVM contract interaction for agents.
 * (ethers v6 compatible)
 *
 * Endpoints:
 *   POST /api/v1/contract/read    — call view/pure functions via eth_call ($0.002)
 *   POST /api/v1/contract/write   — encode + broadcast a tx via agent wallet ($0.015)
 *
 * Why this exists:
 *   Agents constantly need to call arbitrary contracts (balanceOf, allowance,
 *   getReserves, approve, deposit, etc.). Without this endpoint, every agent
 *   has to ship ethers/viem, manage ABIs, and handle encoding/decoding itself.
 *
 * Data path:
 *   read  → ethers v6 Contract → eth_call via Alchemy RPC
 *   write → ethers v6 Contract → tx via agent wallet
 *           (reuses the server-side signer infrastructure already in wallet.ts)
 */

import type { Request, Response } from "express";
import {
  isAddress,
  JsonRpcProvider,
  Interface,
  Contract,
  Wallet,
  type Provider,
  type TransactionRequest,
} from "ethers";

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

// Chain → Alchemy RPC URL. Mirrors the chains Spraay already supports.
const RPC_URLS: Record<string, string> = {
  "base-mainnet": `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "eth-mainnet": `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "arb-mainnet": `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "opt-mainnet": `https://opt-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "matic-mainnet": `https://polygon-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "bnb-mainnet": `https://bnb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "avax-mainnet": `https://avax-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
  "unichain-mainnet": `https://unichain-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
};

// Aliases so agents can pass chain names in the form they're used to.
const CHAIN_ALIASES: Record<string, string> = {
  base: "base-mainnet",
  ethereum: "eth-mainnet",
  eth: "eth-mainnet",
  mainnet: "eth-mainnet",
  arbitrum: "arb-mainnet",
  arb: "arb-mainnet",
  optimism: "opt-mainnet",
  op: "opt-mainnet",
  polygon: "matic-mainnet",
  matic: "matic-mainnet",
  bsc: "bnb-mainnet",
  bnb: "bnb-mainnet",
  avalanche: "avax-mainnet",
  avax: "avax-mainnet",
  unichain: "unichain-mainnet",
};

function resolveChain(raw: unknown): string | null {
  if (typeof raw !== "string") return "base-mainnet";
  const key = raw.toLowerCase().trim();
  if (RPC_URLS[key]) return key;
  const alias = CHAIN_ALIASES[key];
  return alias && RPC_URLS[alias] ? alias : null;
}

function isValidFunctionFragment(fragment: string): boolean {
  if (typeof fragment !== "string" || fragment.length < 3) return false;
  return /\(.*\)/.test(fragment);
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/contract/read
// ────────────────────────────────────────────────────────────────────────────

export async function contractReadHandler(
  req: Request,
  res: Response
): Promise<void> {
  const { chain, address, method, args, abi } = req.body || {};

  const chainId = resolveChain(chain);
  if (!chainId) {
    res.status(400).json({
      error: "invalid_chain",
      message: "Unsupported chain.",
      supported: Object.keys(RPC_URLS),
    });
    return;
  }

  if (!isAddress(String(address || ""))) {
    res.status(400).json({
      error: "invalid_address",
      message: "Field 'address' must be a valid EVM address.",
    });
    return;
  }

  if (!isValidFunctionFragment(String(method || ""))) {
    res.status(400).json({
      error: "invalid_method",
      message:
        "Field 'method' must be a function signature, e.g. 'balanceOf(address)' or a full 'function ...' fragment.",
    });
    return;
  }

  if (!ALCHEMY_API_KEY) {
    res.status(503).json({
      error: "provider_not_configured",
      message: "RPC provider is not configured on this gateway.",
    });
    return;
  }

  try {
    const provider = new JsonRpcProvider(RPC_URLS[chainId]);

    // Normalize: ensure the fragment starts with "function ". For reads, also
    // ensure it has a returns clause so ethers can decode results.
    const trimmed = String(method).trim();
    let functionFragment = trimmed.startsWith("function ")
      ? trimmed
      : `function ${trimmed}`;
    // If no `view`/`pure` and no `returns`, default to view returning bytes
    // so ethers will accept it for callStatic-equivalent decoding.
    if (!/\b(view|pure)\b/.test(functionFragment) && !/\breturns\b/.test(functionFragment)) {
      functionFragment += " view returns (bytes)";
    }

    const iface = Array.isArray(abi) && abi.length > 0
      ? new Interface(abi)
      : new Interface([functionFragment]);

    const methodName = extractMethodName(method);
    const fragment = iface.getFunction(methodName);
    if (!fragment) {
      res.status(400).json({
        error: "method_not_found_in_abi",
        message:
          "Could not resolve the method against the provided ABI. If you passed a full ABI, ensure the function exists in it.",
      });
      return;
    }

    const contract = new Contract(address, iface, provider);
    const callArgs = Array.isArray(args) ? args : [];

    const started = Date.now();
    // In ethers v6, Contract methods are called directly; for read-only calls
    // against view/pure functions this is the standard path. callStatic is
    // accessed via getFunction().staticCall but the direct call works for views.
    const fn = contract.getFunction(methodName);
    const raw = await fn.staticCall(...callArgs);
    const latencyMs = Date.now() - started;

    res.json({
      chain: chainId,
      address,
      method,
      args: callArgs,
      result: serializeResult(raw),
      raw_result: stringifyDeep(raw),
      _gateway: {
        endpoint: "contract/read",
        price_usdc: "0.002",
        upstream_latency_ms: latencyMs,
      },
    });
  } catch (err: any) {
    res.status(400).json({
      error: "contract_read_failed",
      message: err?.shortMessage || err?.reason || err?.message || "Contract call reverted.",
      code: err?.code,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// POST /api/v1/contract/write
// ────────────────────────────────────────────────────────────────────────────

export async function contractWriteHandler(
  req: Request,
  res: Response
): Promise<void> {
  const {
    chain,
    address,
    method,
    args,
    abi,
    value,
    walletId,
    privateKey, // optional: only used if explicitly provided by the agent
  } = req.body || {};

  const chainId = resolveChain(chain);
  if (!chainId) {
    res.status(400).json({
      error: "invalid_chain",
      message: "Unsupported chain.",
      supported: Object.keys(RPC_URLS),
    });
    return;
  }

  if (!isAddress(String(address || ""))) {
    res.status(400).json({
      error: "invalid_address",
      message: "Field 'address' must be a valid EVM address.",
    });
    return;
  }

  if (!isValidFunctionFragment(String(method || ""))) {
    res.status(400).json({
      error: "invalid_method",
      message:
        "Field 'method' must be a function signature, e.g. 'transfer(address,uint256)'.",
    });
    return;
  }

  // A write needs either a Spraay agent walletId OR a caller-supplied privateKey.
  // We do NOT persist or log the privateKey. It's the caller's choice to pass it.
  if (!walletId && !privateKey) {
    res.status(400).json({
      error: "missing_signer",
      message:
        "Provide either 'walletId' (from /api/v1/wallet/create) or a 'privateKey' for one-shot signing.",
    });
    return;
  }

  if (!ALCHEMY_API_KEY) {
    res.status(503).json({
      error: "provider_not_configured",
      message: "RPC provider is not configured on this gateway.",
    });
    return;
  }

  try {
    const provider = new JsonRpcProvider(RPC_URLS[chainId]);

    const trimmed = String(method).trim();
    const functionFragment = trimmed.startsWith("function ")
      ? trimmed
      : `function ${trimmed}`;

    const iface = Array.isArray(abi) && abi.length > 0
      ? new Interface(abi)
      : new Interface([functionFragment]);

    const methodName = extractMethodName(method);
    const callArgs = Array.isArray(args) ? args : [];

    // Encode calldata — this step catches ABI mismatches before we spend gas.
    const data = iface.encodeFunctionData(methodName, callArgs);

    let wallet: Wallet;
    if (privateKey) {
      wallet = new Wallet(String(privateKey), provider);
    } else {
      const signer = await resolveGatewaySigner(String(walletId), provider);
      if (!signer) {
        res.status(404).json({
          error: "wallet_not_found",
          message: `No agent wallet found for id '${walletId}'.`,
        });
        return;
      }
      wallet = signer;
    }

    const txRequest: TransactionRequest = {
      to: address,
      data,
      value: value ? BigInt(String(value)) : undefined,
    };

    // Estimate gas so we can surface failures before broadcast.
    try {
      const estimatedGas = await provider.estimateGas({
        ...txRequest,
        from: wallet.address,
      });
      // +20% buffer (BigInt arithmetic in v6)
      txRequest.gasLimit = (estimatedGas * 120n) / 100n;
    } catch (gasErr: any) {
      res.status(400).json({
        error: "gas_estimation_failed",
        message:
          gasErr?.shortMessage ||
          gasErr?.reason ||
          gasErr?.message ||
          "Transaction would revert — check args and contract state.",
      });
      return;
    }

    const started = Date.now();
    const tx = await wallet.sendTransaction(txRequest);
    const latencyMs = Date.now() - started;

    res.json({
      chain: chainId,
      address,
      method,
      args: callArgs,
      tx_hash: tx.hash,
      from: wallet.address,
      nonce: tx.nonce,
      gas_limit: tx.gasLimit?.toString(),
      explorer: explorerUrl(chainId, tx.hash),
      _gateway: {
        endpoint: "contract/write",
        price_usdc: "0.015",
        upstream_latency_ms: latencyMs,
      },
    });
  } catch (err: any) {
    res.status(400).json({
      error: "contract_write_failed",
      message: err?.shortMessage || err?.reason || err?.message || "Transaction failed.",
      code: err?.code,
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function extractMethodName(method: string): string {
  const trimmed = method.trim().replace(/^function\s+/, "");
  const parenIdx = trimmed.indexOf("(");
  return parenIdx > 0 ? trimmed.slice(0, parenIdx).trim() : trimmed;
}

function serializeResult(raw: any): any {
  if (typeof raw === "bigint") return raw.toString();
  if (Array.isArray(raw)) return raw.map(serializeResult);
  // ethers v6 Result objects are array-like; iterate them
  if (raw && typeof raw === "object" && typeof raw[Symbol.iterator] === "function") {
    const out: any[] = [];
    for (const item of raw) out.push(serializeResult(item));
    return out;
  }
  return raw;
}

function stringifyDeep(value: any): string {
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      return v;
    });
  } catch {
    return String(value);
  }
}

function explorerUrl(chainId: string, txHash: string): string {
  const explorers: Record<string, string> = {
    "base-mainnet": "https://basescan.org/tx/",
    "eth-mainnet": "https://etherscan.io/tx/",
    "arb-mainnet": "https://arbiscan.io/tx/",
    "opt-mainnet": "https://optimistic.etherscan.io/tx/",
    "matic-mainnet": "https://polygonscan.com/tx/",
    "bnb-mainnet": "https://bscscan.com/tx/",
    "avax-mainnet": "https://snowtrace.io/tx/",
    "unichain-mainnet": "https://uniscan.xyz/tx/",
  };
  return (explorers[chainId] || "") + txHash;
}

/**
 * Resolves a Spraay agent walletId to an ethers v6 Wallet.
 *
 * This lazily imports the gateway's existing wallet-signer module. If your
 * gateway exports a different function name, adjust the import target here
 * (or pass a resolver function from index.ts).
 */
async function resolveGatewaySigner(
  walletId: string,
  provider: Provider
): Promise<Wallet | null> {
  try {
    // Runtime-evaluated path so TypeScript doesn't require wallet.js to exist
    // at compile time in environments where it's resolved dynamically.
    const walletModulePath = "./wallet.js";
    const mod: any = await import(walletModulePath).catch(() => null);
    if (!mod) return null;

    const getWalletSigner =
      mod.getWalletSigner || mod.resolveSigner || mod.signerForWallet;
    if (typeof getWalletSigner !== "function") return null;

    const signer = await getWalletSigner(walletId, provider);
    if (!signer) return null;

    if (signer instanceof Wallet) return signer.connect(provider) as Wallet;
    if (typeof signer === "string") return new Wallet(signer, provider);
    return null;
  } catch {
    return null;
  }
}
