/**
 * 💧 Spraay x402 Gateway — Robinhood USDG rail, MPP adapter
 * src/rails/robinhoodUsdgMpp.ts
 *
 * Registers the SAME settlement engine (src/rails/robinhoodUsdg.ts) under the
 * Machine Payments Protocol as the spec-defined `evm` / `charge` method
 * (tempoxyz/mpp-specs: specs/methods/evm/draft-evm-charge-00.md), credential
 * type "authorization" (EIP-3009 transferWithAuthorization).
 *
 * Wire format (from the draft):
 *   challenge.request = { amount (base units), currency (ERC-20), recipient,
 *                         chainId, decimals?, credentialTypes?, description?, externalId? }
 *   credential.payload = { type: "authorization", from, to, value, validAfter,
 *                          validBefore, nonce, signature }
 *   nonce MUST equal keccak256(abi.encodePacked(challenge.id, challenge.realm))
 *   receipt = { method: "evm", reference: <tx hash>, status: "success", timestamp }
 *
 * MPP semantics: the charge settles inside verify() (before the resource is
 * served), which is what the draft prescribes for `authorization`.
 *
 * Only loaded when MPP is enabled AND the rail is enabled (see mppMiddleware);
 * `mppx` is imported dynamically, mirroring the existing lazy-load pattern.
 */

import { ethers } from "ethers";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_NETWORK, USDG, type RobinhoodUsdgRail } from "./robinhoodUsdg.js";

export const MPP_EVM_METHOD = "evm";
export const MPP_EVM_INTENT = "charge";
export const MPP_EVM_CREDENTIAL_TYPES = ["authorization"] as const;

export interface MppEvmAuthorizationCredential {
  type: "authorization";
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  signature: string;
}

export interface MppEvmChargeRequest {
  amount: string;
  currency: string;
  recipient: string;
  chainId: number;
  decimals?: number;
  credentialTypes?: string[];
  description?: string;
  externalId?: string;
}

/** draft-evm-charge-00: nonce = keccak256(abi.encodePacked(challenge.id, challenge.realm)). */
export function mppChallengeNonce(challengeId: string, realm: string): string {
  return ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(challengeId), ethers.toUtf8Bytes(realm)]));
}

/** Pure mapping MPP → x402 exact/EIP-3009 (so one engine verifies + settles both). */
export function mppToX402(
  rail: RobinhoodUsdgRail,
  request: MppEvmChargeRequest,
  cred: MppEvmAuthorizationCredential,
  resourceUrl: string,
): { payload: PaymentPayload; requirements: PaymentRequirements } {
  const requirements: PaymentRequirements = {
    scheme: "exact",
    network: ROBINHOOD_NETWORK,
    asset: USDG.address,
    amount: request.amount,
    payTo: rail.payTo,
    maxTimeoutSeconds: 300,
    extra: { name: USDG.name, version: USDG.version },
  };
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: { url: resourceUrl, description: request.description ?? "", mimeType: "application/json" },
    accepted: requirements,
    payload: {
      signature: cred.signature,
      authorization: {
        from: cred.from, to: cred.to, value: cred.value,
        validAfter: cred.validAfter, validBefore: cred.validBefore, nonce: cred.nonce,
      },
    },
  };
  return { payload, requirements };
}

/**
 * Pre-flight checks that are MPP-specific (the engine enforces the rest).
 * Returns a reason string on failure, null when fine.
 */
export function mppPrecheck(
  request: MppEvmChargeRequest,
  cred: MppEvmAuthorizationCredential,
  challengeId: string,
  realm: string,
): string | null {
  if (cred.type !== "authorization") return `unsupported credential type "${(cred as any).type}"; use "authorization"`;
  if (Number(request.chainId) !== ROBINHOOD_CHAIN_ID) return `chainId ${request.chainId} is not ${ROBINHOOD_CHAIN_ID}`;
  if (!isSame(request.currency, USDG.address)) return `currency ${request.currency} is not USDG ${USDG.address}`;
  if (!isSame(cred.to, request.recipient)) return "credential.to does not match challenge recipient";
  let v: bigint, a: bigint;
  try { v = BigInt(cred.value); a = BigInt(request.amount); } catch { return "value/amount must be integer strings"; }
  if (v !== a) return `credential.value ${cred.value} must equal challenge amount ${request.amount}`;
  const expected = mppChallengeNonce(challengeId, realm);
  if ((cred.nonce || "").toLowerCase() !== expected) return "nonce must equal keccak256(challenge.id || challenge.realm)";
  return null;
}

/**
 * Builds the mppx server-side method. Async because `mppx` is loaded lazily.
 * Shape: Method.toServer(Method.from({ name:"evm", intent:"charge", schema }), { defaults, verify }).
 */
// Return type is `any` on purpose: mppx's Method.Server generic drags in a
// nested zod/mini type path that tsc cannot name portably in a declaration.
export async function createRobinhoodUsdgMppMethod(rail: RobinhoodUsdgRail, opts: { realm?: string } = {}): Promise<any> {
  const { Method, Receipt, Errors, z } = await import("mppx");

  const evmCharge = Method.from({
    name: MPP_EVM_METHOD,
    intent: MPP_EVM_INTENT,
    schema: {
      credential: {
        payload: z.object({
          type: z.literal("authorization"),
          from: z.string(),
          to: z.string(),
          value: z.string(),
          validAfter: z.string(),
          validBefore: z.string(),
          nonce: z.string(),
          signature: z.string(),
        }),
      },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        recipient: z.string(),
        chainId: z.number(),
        decimals: z.optional(z.number()),
        credentialTypes: z.optional(z.array(z.string())),
        description: z.optional(z.string()),
        externalId: z.optional(z.string()),
      }),
    },
  });

  return Method.toServer(evmCharge, {
    defaults: {
      currency: USDG.address,
      recipient: rail.payTo,
      chainId: ROBINHOOD_CHAIN_ID,
      decimals: USDG.decimals,
      credentialTypes: [...MPP_EVM_CREDENTIAL_TYPES],
    },
    async verify({ credential, envelope }: any) {
      const challenge = credential.challenge;
      const request = challenge.request as MppEvmChargeRequest;
      const cred = credential.payload as MppEvmAuthorizationCredential;
      const realm = challenge.realm ?? opts.realm ?? "";

      if (!rail.enabled) {
        throw new Errors.VerificationFailedError({ reason: "rail_not_enabled: FACILITATOR_PRIVATE_KEY_ROBINHOOD is not set" });
      }
      const pre = mppPrecheck(request, cred, challenge.id, realm);
      if (pre) throw new Errors.InvalidPayloadError({ reason: pre });

      const url = envelope?.capturedRequest?.url?.toString?.() ?? `mpp://${realm}${challenge.id}`;
      const { payload, requirements } = mppToX402(rail, request, cred, url);
      // MPP charges before serving: verify + settle now.
      const settled = await rail.settle(payload, requirements);
      if (!settled.success) {
        throw new Errors.VerificationFailedError({
          reason: `${settled.errorReason}${settled.errorMessage ? `: ${settled.errorMessage}` : ""}`,
        });
      }
      return Receipt.from({
        method: MPP_EVM_METHOD,
        reference: settled.transaction,
        status: "success",
        timestamp: new Date().toISOString(),
        ...(request.externalId ? { externalId: request.externalId } : {}),
      });
    },
  });
}

function isSame(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try { return ethers.getAddress(a) === ethers.getAddress(b); } catch { return false; }
}
