// src/lib/address-validation.ts
// Multi-chain address validation — pure local compute, zero external calls

import { isAddress, getAddress } from "viem";
import { PublicKey } from "@solana/web3.js";

// Optional deps — loaded via require so they're safe to omit.
// CommonJS-compatible (no top-level await).
let isValidClassicAddress: ((addr: string) => boolean) | null = null;
let StrKey: { isValidEd25519PublicKey: (key: string) => boolean } | null = null;

try {
  const rac = require("ripple-address-codec");
  isValidClassicAddress = rac.isValidClassicAddress;
} catch { /* optional dep not installed — XRP validation disabled */ }

try {
  const stellar = require("@stellar/stellar-sdk");
  StrKey = stellar.StrKey;
} catch { /* optional dep not installed — Stellar validation disabled */ }

export interface AddressResult {
  valid: boolean;
  chain: string | null;
  checksummed: string | null;
  format?: string;
  error?: string;
}

const EVM_CHAIN_ALIASES = [
  "evm", "ethereum", "base", "arbitrum", "polygon",
  "bnb", "bsc", "avalanche", "optimism", "unichain", "plasma", "bob",
];

export function validateAddress(address: string, chain?: string): AddressResult {
  if (!address || typeof address !== "string") {
    return { valid: false, chain: null, checksummed: null, error: "Address is required" };
  }
  const trimmed = address.trim();

  if (chain) {
    const c = chain.toLowerCase();
    if (EVM_CHAIN_ALIASES.includes(c)) return validateEVM(trimmed);
    if (c === "solana" || c === "sol") return validateSolana(trimmed);
    if (c === "xrp" || c === "ripple" || c === "xrpl") return validateXRP(trimmed);
    if (c === "stellar" || c === "xlm") return validateStellar(trimmed);
    return { valid: false, chain: null, checksummed: null, error: `Unknown chain: ${chain}` };
  }

  // Auto-detect
  const evm = validateEVM(trimmed);
  if (evm.valid) return evm;
  const sol = validateSolana(trimmed);
  if (sol.valid) return sol;
  const xrp = validateXRP(trimmed);
  if (xrp.valid) return xrp;
  const stellar = validateStellar(trimmed);
  if (stellar.valid) return stellar;

  return { valid: false, chain: null, checksummed: null, error: "Address does not match any supported chain format" };
}

function validateEVM(address: string): AddressResult {
  try {
    if (!isAddress(address, { strict: false })) return { valid: false, chain: null, checksummed: null };
    return { valid: true, chain: "evm", checksummed: getAddress(address), format: "ERC-55" };
  } catch { return { valid: false, chain: null, checksummed: null }; }
}

function validateSolana(address: string): AddressResult {
  try {
    const pubkey = new PublicKey(address);
    if (pubkey.toBase58() !== address) return { valid: false, chain: null, checksummed: null };
    return { valid: true, chain: "solana", checksummed: address, format: "base58" };
  } catch { return { valid: false, chain: null, checksummed: null }; }
}

function validateXRP(address: string): AddressResult {
  try {
    if (isValidClassicAddress && isValidClassicAddress(address)) {
      return { valid: true, chain: "xrp", checksummed: address, format: "classic" };
    }
    return { valid: false, chain: null, checksummed: null };
  } catch { return { valid: false, chain: null, checksummed: null }; }
}

function validateStellar(address: string): AddressResult {
  try {
    if (StrKey && StrKey.isValidEd25519PublicKey(address)) {
      return { valid: true, chain: "stellar", checksummed: address, format: "ed25519" };
    }
    return { valid: false, chain: null, checksummed: null };
  } catch { return { valid: false, chain: null, checksummed: null }; }
}
