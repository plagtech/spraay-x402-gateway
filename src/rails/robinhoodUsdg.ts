/**
 * 💧 Spraay x402 Gateway — Robinhood Chain (4663) USDG settlement rail
 * src/rails/robinhoodUsdg.ts
 *
 * WHAT THIS IS
 *   An in-process x402 facilitator for ONE (scheme, network) pair:
 *   `exact` on `eip155:4663`, asset USDG (Global Dollar, 6 decimals), using
 *   the spec-native EIP-3009 `transferWithAuthorization` transfer method.
 *   No Permit2, no proxy, no approval step: the payer signs an EIP-712
 *   TransferWithAuthorization and the gateway's facilitator wallet relays it.
 *
 *   Phase 0 (2026-09-08) verified on chain that USDG at
 *   0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 honours EIP-3009 with the
 *   EIP-712 domain { name: "Global Dollar", version: "1", chainId: 4663 }.
 *
 * HOW IT PLUGS IN
 *   `x402ResourceServer` accepts an array of FacilitatorClient. The CDP client
 *   stays first (Base/USDC precedence, byte-identical behaviour); this rail is
 *   appended and only ever answers for eip155:4663. Verify runs before the
 *   route handler and settle after it — the @x402/express v2 order — so a
 *   failed handler never settles.
 *
 *   The wire format is exactly the x402 v2 `exact` EVM scheme (EIP-3009
 *   variant): requirements.extra = { name, version }, payload =
 *   { signature, authorization: { from, to, value, validAfter, validBefore, nonce } }.
 *   Any x402 v2 client that pays USDC on Base can pay USDG here unchanged.
 *
 * GUARDS (from the task brief)
 *   - Key: FACILITATOR_PRIVATE_KEY_ROBINHOOD is read from env, never logged.
 *     If absent the rail stays advertised (stable discovery shape) but every
 *     verify/settle answers `rail_not_enabled` — never a crash, never a 500.
 *   - Gas: live eth_estimateGas × 1.5 with a floor (the batch gas-fix pattern).
 *   - Idempotency: a nonce ledger (pending → settled) plus the on-chain
 *     authorizationState() read, so a replayed header cannot settle twice.
 *   - Serialised sends: one facilitator wallet, one in-flight tx at a time,
 *     so account nonces never collide.
 *   - Additive only: nothing here touches Base, Solana or any existing route.
 *
 * TESTS: test/robinhood-usdg.test.ts (offline, stubbed chain).
 */

import { ethers } from "ethers";
import type {
  FacilitatorClient,
} from "@x402/core/server";
import type {
  MoneyParser,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";

// ─── Chain + asset constants (verified Phase 0; see PHASE0 report) ────────
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_NETWORK = "eip155:4663" as Network;
export const ROBINHOOD_DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const ROBINHOOD_EXPLORER = "https://robinhoodchain.blockscout.com";

export const USDG = {
  address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  symbol: "USDG",
  name: "Global Dollar",   // EIP-712 domain name (DOMAIN_SEPARATOR-verified)
  version: "1",            // EIP-712 domain version (DOMAIN_SEPARATOR-verified)
  decimals: 6,
} as const;

/** Spraay revenue wallet for USDG settlements on 4663 (LP-provided). */
export const ROBINHOOD_DEFAULT_PAY_TO = "0xdAA0fb4fb470AA8fb53A0c301EF9AADC89949F33";

/** Gas floor for transferWithAuthorization (live estimate was ~105k). */
export const SETTLE_GAS_FLOOR = 130_000n;
export const SETTLE_GAS_MULTIPLIER_NUM = 3n; // × 1.5 == × 3 / 2
export const SETTLE_GAS_MULTIPLIER_DEN = 2n;

const EIP3009_ABI = [
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];
const eip3009Iface = new ethers.Interface(EIP3009_ABI);

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export function usdgEip712Domain(): ethers.TypedDataDomain {
  return {
    name: USDG.name,
    version: USDG.version,
    chainId: ROBINHOOD_CHAIN_ID,
    verifyingContract: USDG.address,
  };
}

// ─── Wire types (x402 v2 exact/EIP-3009) ───────────────────────────────────
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}
export interface Eip3009PaymentPayload {
  signature: string;
  authorization: Eip3009Authorization;
}

// ─── Chain access (injectable so tests run offline) ───────────────────────
export interface SettleTx {
  to: string;
  data: string;
  from: string;
}
export interface TxReceiptLite {
  status: number | null;
  hash: string;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
}
export interface RobinhoodChain {
  balanceOf(owner: string): Promise<bigint>;
  authorizationState(authorizer: string, nonce: string): Promise<boolean>;
  estimateGas(tx: SettleTx): Promise<bigint>;
  send(tx: SettleTx & { gasLimit: bigint }): Promise<string>;
  wait(hash: string): Promise<TxReceiptLite>;
}

export function createEthersChain(rpcUrl: string, wallet: ethers.Wallet | null): RobinhoodChain {
  const provider = new ethers.JsonRpcProvider(rpcUrl, ROBINHOOD_CHAIN_ID, { staticNetwork: true });
  const signer = wallet ? wallet.connect(provider) : null;
  const token = new ethers.Contract(USDG.address, EIP3009_ABI, provider);
  return {
    balanceOf: async (owner) => BigInt(await token.balanceOf(owner)),
    authorizationState: async (authorizer, nonce) => Boolean(await token.authorizationState(authorizer, nonce)),
    estimateGas: async (tx) => BigInt(await provider.estimateGas(tx)),
    send: async (tx) => {
      if (!signer) throw new Error("rail_not_enabled");
      const resp = await signer.sendTransaction({ to: tx.to, data: tx.data, gasLimit: tx.gasLimit });
      return resp.hash;
    },
    wait: async (hash) => {
      const r = await provider.waitForTransaction(hash, 1, 120_000);
      if (!r) throw new Error(`receipt timeout for ${hash}`);
      return {
        status: r.status,
        hash: r.hash,
        gasUsed: BigInt(r.gasUsed),
        effectiveGasPrice: BigInt(r.gasPrice ?? 0n),
        blockNumber: r.blockNumber,
      };
    },
  };
}

// ─── Nonce ledger (idempotency) ───────────────────────────────────────────
type NonceState = { state: "pending" | "settled"; at: number; tx?: string };
const NONCE_TTL_MS = 24 * 60 * 60 * 1000;

export class NonceLedger {
  private readonly entries = new Map<string, NonceState>();
  private readonly timer: NodeJS.Timeout;
  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 10 * 60 * 1000);
    this.timer.unref?.();
  }
  private key(from: string, nonce: string): string {
    return `${from.toLowerCase()}:${nonce.toLowerCase()}`;
  }
  get(from: string, nonce: string): NonceState | undefined {
    return this.entries.get(this.key(from, nonce));
  }
  /** Claim a nonce for settlement. Returns false if it is already claimed/settled. */
  claim(from: string, nonce: string): boolean {
    const k = this.key(from, nonce);
    if (this.entries.has(k)) return false;
    this.entries.set(k, { state: "pending", at: this.now() });
    return true;
  }
  settled(from: string, nonce: string, tx: string): void {
    this.entries.set(this.key(from, nonce), { state: "settled", at: this.now(), tx });
  }
  /** A send that never landed (revert / RPC error) frees the nonce for a retry. */
  release(from: string, nonce: string): void {
    const k = this.key(from, nonce);
    if (this.entries.get(k)?.state === "pending") this.entries.delete(k);
  }
  sweep(): void {
    const cutoff = this.now() - NONCE_TTL_MS;
    for (const [k, v] of this.entries) if (v.at < cutoff) this.entries.delete(k);
  }
  get size(): number {
    return this.entries.size;
  }
}

// ─── The rail ─────────────────────────────────────────────────────────────
export interface RobinhoodUsdgRailOptions {
  /** Facilitator private key. Absent → rail advertised but disabled. */
  privateKey?: string | null;
  rpcUrl?: string;
  payTo?: string;
  /** Test seam: replaces the ethers-backed chain. */
  chain?: RobinhoodChain;
  /** Test seam: unix seconds. */
  now?: () => number;
  logger?: Pick<Console, "log" | "warn" | "error">;
}

export const RAIL_NOT_ENABLED_REASON = "rail_not_enabled";
export const RAIL_NOT_ENABLED_MESSAGE =
  "Robinhood USDG rail not enabled: FACILITATOR_PRIVATE_KEY_ROBINHOOD is not set on the gateway. " +
  "Pay with another accepts[] entry (Base USDC or Solana USDC).";

export class RobinhoodUsdgRail {
  readonly network = ROBINHOOD_NETWORK;
  readonly payTo: string;
  readonly facilitatorAddress: string | null;
  readonly enabled: boolean;
  readonly ledger: NonceLedger;
  readonly facilitatorClient: FacilitatorClient;
  private readonly chain: RobinhoodChain;
  private readonly now: () => number;
  private readonly log: Pick<Console, "log" | "warn" | "error">;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private stats = { verified: 0, rejected: 0, settled: 0, failed: 0, gasWei: 0n };

  constructor(opts: RobinhoodUsdgRailOptions = {}) {
    this.payTo = ethers.getAddress(opts.payTo || ROBINHOOD_DEFAULT_PAY_TO);
    this.now = opts.now || (() => Math.floor(Date.now() / 1000));
    this.log = opts.logger || console;
    this.ledger = new NonceLedger(() => this.now() * 1000);

    let wallet: ethers.Wallet | null = null;
    const key = (opts.privateKey || "").trim();
    if (key) {
      try {
        wallet = new ethers.Wallet(key);
      } catch {
        // Malformed key: treat as absent. Never echo the value.
        this.log.warn("[robinhood-usdg] FACILITATOR_PRIVATE_KEY_ROBINHOOD is malformed — rail disabled");
        wallet = null;
      }
    }
    this.facilitatorAddress = wallet ? wallet.address : null;
    this.enabled = wallet !== null;
    this.chain = opts.chain || createEthersChain(opts.rpcUrl || process.env.ROBINHOOD_RPC_URL || ROBINHOOD_DEFAULT_RPC, wallet);

    this.facilitatorClient = {
      verify: (p, r) => this.verify(p, r),
      settle: (p, r) => this.settle(p, r),
      getSupported: () => this.getSupported(),
    };
  }

  /** Discovery metadata (additive; used by /.well-known and /health). */
  describe() {
    return {
      enabled: this.enabled,
      chain: "robinhood",
      chainId: ROBINHOOD_CHAIN_ID,
      network: ROBINHOOD_NETWORK,
      scheme: "exact",
      assetTransferMethod: "eip3009",
      asset: USDG.address,
      assetSymbol: USDG.symbol,
      assetName: USDG.name,
      assetVersion: USDG.version,
      decimals: USDG.decimals,
      payTo: this.payTo,
      facilitator: this.facilitatorAddress,
      explorer: ROBINHOOD_EXPLORER,
      stats: { ...this.stats, gasWei: this.stats.gasWei.toString() },
    };
  }

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: ROBINHOOD_NETWORK }],
      extensions: [],
      signers: { [ROBINHOOD_NETWORK]: this.facilitatorAddress ? [this.facilitatorAddress] : [] },
    };
  }

  // ── verify ────────────────────────────────────────────────────────────
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const res = await this.check(payload, requirements);
    if (res.isValid) this.stats.verified++;
    else this.stats.rejected++;
    return res;
  }

  private async check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    const auth = (payload?.payload as Partial<Eip3009PaymentPayload> | undefined)?.authorization;
    const payer = auth?.from;
    const bad = (invalidReason: string, invalidMessage?: string): VerifyResponse => ({
      isValid: false, invalidReason, invalidMessage, payer,
    });

    if (!this.enabled) return bad(RAIL_NOT_ENABLED_REASON, RAIL_NOT_ENABLED_MESSAGE);

    if (requirements.network !== ROBINHOOD_NETWORK || payload?.accepted?.network !== ROBINHOOD_NETWORK) {
      return bad("network_mismatch");
    }
    if (requirements.scheme !== "exact" || payload.accepted.scheme !== "exact") {
      return bad("unsupported_scheme");
    }
    if (!isSameAddress(requirements.asset, USDG.address)) {
      return bad("invalid_asset", `Only USDG (${USDG.address}) is accepted on ${ROBINHOOD_NETWORK}`);
    }
    if (!isSameAddress(requirements.payTo, this.payTo)) {
      return bad("invalid_pay_to");
    }
    if (payload.payload && "permit2Authorization" in (payload.payload as object)) {
      return bad("unsupported_asset_transfer_method",
        "Permit2 is not enabled on this rail; use assetTransferMethod eip3009 (transferWithAuthorization)");
    }
    const p = payload.payload as Partial<Eip3009PaymentPayload> | undefined;
    if (!p || !auth || typeof p.signature !== "string") {
      return bad("invalid_exact_evm_payload", "payload.authorization and payload.signature are required");
    }
    for (const f of ["from", "to", "value", "validAfter", "validBefore", "nonce"] as const) {
      if (typeof auth[f] !== "string" || auth[f].length === 0) {
        return bad("invalid_exact_evm_payload", `authorization.${f} is required`);
      }
    }
    if (!ethers.isAddress(auth.from) || !ethers.isAddress(auth.to)) return bad("invalid_exact_evm_payload", "bad address");
    if (!/^0x[0-9a-fA-F]{64}$/.test(auth.nonce)) return bad("invalid_exact_evm_payload", "nonce must be bytes32");

    const name = requirements.extra?.name;
    const version = requirements.extra?.version;
    if (!name || !version) return bad("missing_eip712_domain");
    if (name !== USDG.name || version !== USDG.version) return bad("invalid_eip712_domain");

    let value: bigint, validAfter: bigint, validBefore: bigint, required: bigint;
    try {
      value = BigInt(auth.value); validAfter = BigInt(auth.validAfter); validBefore = BigInt(auth.validBefore);
      required = BigInt(requirements.amount);
    } catch {
      return bad("invalid_exact_evm_payload", "numeric fields must be base-10 integers");
    }

    // Signature: EOA/ECDSA only on this rail (65 bytes).
    const sigHex = p.signature.startsWith("0x") ? p.signature : `0x${p.signature}`;
    if (sigHex.length !== 132) {
      return bad("invalid_exact_evm_payload_signature", "only 65-byte ECDSA signatures are accepted on this rail");
    }
    let recovered: string;
    try {
      recovered = ethers.verifyTypedData(
        usdgEip712Domain(),
        TRANSFER_WITH_AUTHORIZATION_TYPES as unknown as Record<string, ethers.TypedDataField[]>,
        { from: auth.from, to: auth.to, value, validAfter, validBefore, nonce: auth.nonce },
        sigHex,
      );
    } catch {
      return bad("invalid_exact_evm_payload_signature");
    }
    if (!isSameAddress(recovered, auth.from)) return bad("invalid_exact_evm_payload_signature");

    if (!isSameAddress(auth.to, requirements.payTo)) return bad("invalid_exact_evm_payload_recipient_mismatch");

    const now = BigInt(this.now());
    if (validBefore < now + 6n) return bad("invalid_exact_evm_payload_authorization_valid_before");
    if (validAfter > now) return bad("invalid_exact_evm_payload_authorization_valid_after");
    if (value < required) return bad("invalid_exact_evm_payload_authorization_value");

    // Idempotency: gateway ledger first (cheap), then the chain.
    const seen = this.ledger.get(auth.from, auth.nonce);
    if (seen) {
      return bad("authorization_nonce_reused",
        seen.state === "settled" ? `nonce already settled in ${seen.tx}` : "nonce is already being settled");
    }
    try {
      if (await this.chain.authorizationState(auth.from, auth.nonce)) {
        return bad("authorization_already_used", "this EIP-3009 nonce was already consumed on chain");
      }
    } catch (err: any) {
      return bad("rpc_unavailable", `could not read authorizationState: ${err?.message || err}`);
    }

    try {
      const balance = await this.chain.balanceOf(auth.from);
      if (balance < required) {
        return bad("insufficient_funds",
          `Insufficient funds to complete the payment. Required: ${requirements.amount} ${requirements.asset}, ` +
          `Available: ${balance.toString()} ${requirements.asset}. Please add funds to your wallet and try again.`);
      }
    } catch (err: any) {
      return bad("rpc_unavailable", `could not read balance: ${err?.message || err}`);
    }

    return { isValid: true, invalidReason: undefined, payer: auth.from };
  }

  // ── settle ────────────────────────────────────────────────────────────
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = ROBINHOOD_NETWORK;
    const p = payload?.payload as Partial<Eip3009PaymentPayload> | undefined;
    const payer = p?.authorization?.from;
    const fail = (errorReason: string, errorMessage?: string, transaction = ""): SettleResponse => {
      this.stats.failed++;
      return { success: false, errorReason, errorMessage, transaction, network, payer };
    };

    // Same checks as verify (a payment must still be valid at settle time).
    const v = await this.check(payload, requirements);
    if (!v.isValid) return fail(v.invalidReason ?? "invalid_scheme", v.invalidMessage);

    const auth = (p as Eip3009PaymentPayload).authorization;
    const sig = ethers.Signature.from((p as Eip3009PaymentPayload).signature);
    const data = eip3009Iface.encodeFunctionData("transferWithAuthorization", [
      ethers.getAddress(auth.from), ethers.getAddress(auth.to), BigInt(auth.value),
      BigInt(auth.validAfter), BigInt(auth.validBefore), auth.nonce, sig.v, sig.r, sig.s,
    ]);
    const tx: SettleTx = { to: USDG.address, data, from: this.facilitatorAddress! };

    if (!this.ledger.claim(auth.from, auth.nonce)) {
      return fail("authorization_nonce_reused", "nonce is already being settled");
    }

    let hash = "";
    try {
      const result = await this.enqueue(async () => {
        // Gas: live estimate × 1.5, floored — never a static constant.
        const est = await this.chain.estimateGas(tx);
        const gasLimit = maxBigInt((est * SETTLE_GAS_MULTIPLIER_NUM) / SETTLE_GAS_MULTIPLIER_DEN, SETTLE_GAS_FLOOR);
        hash = await this.chain.send({ ...tx, gasLimit });
        this.log.log(`[robinhood-usdg] settle sent ${hash} (${auth.value} raw USDG ${auth.from} → ${auth.to}, est ${est}, gasLimit ${gasLimit})`);
        const receipt = await this.chain.wait(hash);
        return { est, gasLimit, receipt };
      });
      const { receipt } = result;
      if (receipt.status !== 1) {
        this.ledger.release(auth.from, auth.nonce);
        return fail("invalid_transaction_state", "transferWithAuthorization reverted", hash);
      }
      this.ledger.settled(auth.from, auth.nonce, hash);
      this.stats.settled++;
      this.stats.gasWei += receipt.gasUsed * receipt.effectiveGasPrice;
      this.log.log(`[robinhood-usdg] ✅ settled ${hash} block ${receipt.blockNumber} gasUsed ${receipt.gasUsed}`);
      return { success: true, transaction: hash, network, payer: auth.from };
    } catch (err: any) {
      this.ledger.release(auth.from, auth.nonce);
      const msg: string = err?.shortMessage || err?.message || String(err);
      this.log.error(`[robinhood-usdg] settle failed: ${msg}`);
      return fail("transaction_failed", msg, hash);
    }
  }

  /** One in-flight send at a time for the single facilitator wallet. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.sendQueue.then(fn, fn);
    this.sendQueue = run.catch(() => undefined);
    return run;
  }
}

// ─── Money parser: "$0.001" → 1000 raw USDG on eip155:4663 ─────────────────
export const robinhoodUsdgMoneyParser: MoneyParser = async (amount, network) => {
  if (network !== ROBINHOOD_NETWORK) return null;
  return {
    amount: usdToUsdgUnits(amount),
    asset: USDG.address,
    extra: { name: USDG.name, version: USDG.version },
  };
};

export function usdToUsdgUnits(amountUsd: number): string {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) throw new Error(`Invalid USD amount: ${amountUsd}`);
  return ethers.parseUnits(amountUsd.toFixed(USDG.decimals), USDG.decimals).toString();
}

// ─── Factory used by index.ts ─────────────────────────────────────────────
export function createRobinhoodUsdgRail(opts: Omit<RobinhoodUsdgRailOptions, "privateKey"> = {}): RobinhoodUsdgRail {
  const rail = new RobinhoodUsdgRail({
    ...opts,
    privateKey: process.env.FACILITATOR_PRIVATE_KEY_ROBINHOOD,
    payTo: opts.payTo || process.env.ROBINHOOD_PAY_TO_ADDRESS || ROBINHOOD_DEFAULT_PAY_TO,
  });
  if (rail.enabled) {
    console.log(`✅ Robinhood USDG rail: enabled — facilitator ${rail.facilitatorAddress} → payTo ${rail.payTo} (${ROBINHOOD_NETWORK})`);
  } else {
    console.warn("⚠️  Robinhood USDG rail: FACILITATOR_PRIVATE_KEY_ROBINHOOD not set — advertised but payments answer rail_not_enabled");
  }
  return rail;
}

/** Process-wide instance shared by index.ts and the MPP middleware. */
let _singleton: RobinhoodUsdgRail | null = null;
export function getRobinhoodUsdgRail(): RobinhoodUsdgRail {
  if (!_singleton) _singleton = createRobinhoodUsdgRail();
  return _singleton;
}

// ─── helpers ──────────────────────────────────────────────────────────────
function isSameAddress(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try { return ethers.getAddress(a) === ethers.getAddress(b); } catch { return false; }
}
function maxBigInt(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
