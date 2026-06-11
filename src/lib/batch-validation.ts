// src/lib/batch-validation.ts
// BPA 1.0 payload schema validation — pure local compute

import { validateAddress } from "./address-validation.js";

const SUPPORTED_CHAINS = [
  "base", "ethereum", "arbitrum", "polygon", "bnb",
  "avalanche", "unichain", "plasma", "bob",
  "solana", "bittensor", "xrp", "stellar", "stacks", "bitcoin",
];
const MAX_RECIPIENTS = 200;

export function validateBatchPayload(payload: any) {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { valid: false, errors: ["Payload must be a JSON object"], warnings, summary: null };
  }

  if (!payload.chain || typeof payload.chain !== "string") {
    errors.push('Missing or invalid "chain" (string required)');
  } else if (!SUPPORTED_CHAINS.includes(payload.chain.toLowerCase())) {
    errors.push(`Unsupported chain "${payload.chain}". Supported: ${SUPPORTED_CHAINS.join(", ")}`);
  }

  if (!payload.token || typeof payload.token !== "string") {
    errors.push('Missing or invalid "token" (string required — contract address or native symbol)');
  }

  if (!Array.isArray(payload.recipients) || payload.recipients.length === 0) {
    errors.push('Missing or empty "recipients" array');
  } else {
    if (payload.recipients.length > MAX_RECIPIENTS) {
      errors.push(`Too many recipients: ${payload.recipients.length} (max ${MAX_RECIPIENTS})`);
    }
    const seen = new Set<string>();
    const chain = payload.chain?.toLowerCase();

    payload.recipients.forEach((r: any, i: number) => {
      const pfx = `recipients[${i}]`;
      if (!r || typeof r !== "object") { errors.push(`${pfx}: must be an object with "to" and "amount"`); return; }
      if (!r.to || typeof r.to !== "string") {
        errors.push(`${pfx}.to: missing or invalid address`);
      } else {
        if (!validateAddress(r.to, chain).valid) errors.push(`${pfx}.to: invalid address for chain "${chain}"`);
        if (seen.has(r.to.toLowerCase())) warnings.push(`${pfx}.to: duplicate address "${r.to}" — intentional?`);
        seen.add(r.to.toLowerCase());
      }
      if (r.amount === undefined || r.amount === null) {
        errors.push(`${pfx}.amount: required`);
      } else {
        const amt = typeof r.amount === "string" ? parseFloat(r.amount) : r.amount;
        if (isNaN(amt) || amt <= 0) errors.push(`${pfx}.amount: must be a positive number`);
      }
    });
  }

  if (payload.sender && typeof payload.sender === "string") {
    if (!validateAddress(payload.sender, payload.chain?.toLowerCase()).valid) {
      warnings.push(`sender: address "${payload.sender}" may be invalid for chain "${payload.chain}"`);
    }
  }

  const totalAmount = Array.isArray(payload.recipients)
    ? payload.recipients.reduce((sum: number, r: any) => {
        const amt = typeof r?.amount === "string" ? parseFloat(r.amount) : (r?.amount || 0);
        return sum + (isNaN(amt) ? 0 : amt);
      }, 0) : 0;

  return {
    valid: errors.length === 0, errors, warnings,
    summary: {
      chain: payload.chain || null, token: payload.token || null,
      recipientCount: Array.isArray(payload.recipients) ? payload.recipients.length : 0,
      uniqueAddresses: new Set((payload.recipients || []).map((r: any) => r?.to?.toLowerCase()).filter(Boolean)).size,
      totalAmount, bpaVersion: "1.0",
    },
  };
}
