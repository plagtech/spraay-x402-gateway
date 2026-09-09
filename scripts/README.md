# scripts/

Standalone x402 batch-payment verification tooling for
[`gateway.spraay.app`](https://gateway.spraay.app). These run independently of
the gateway server — they exercise the live x402 flow as a *client*.

## Files

### `rtp-ext-proof.mjs`

The commit gate required by `CLAUDE.md` before any commit touching `index.ts`,
batch, escrow or robots routes. Unlike the scripts below it does **not** talk to
the live gateway: it compiles `src/`, boots `dist/index.js` locally against a
mock Supabase and a mock x402 facilitator (`scripts/rtp-proof/`), and exits
nonzero on any mismatch. No network, no database, no real funds.

```bash
node scripts/rtp-ext-proof.mjs                   # the gate — exits 0 or 1
node scripts/rtp-ext-proof.mjs --no-build        # reuse an existing dist/
node scripts/rtp-ext-proof.mjs --verbose         # stream gateway logs
node scripts/rtp-ext-proof.mjs --update-baseline # re-baseline (see below)
```

It asserts three blocks:

| Block | What it proves |
|-------|----------------|
| **A** | The nine frozen NVIDIA paths still match `rtp-proof/baseline.json` on status, content type, top-level key set and every nested key path. Values are ignored; `version` values are reported, not asserted. |
| **B** | `POST /api/v1/robots/task` validates *before* it charges: unpaid requests still get the unchanged 402 challenge, and a paid request with an invalid payload is rejected with **zero** facilitator calls. |
| **C** | The payment gate still runs for paid routes other than `robots/task`, so the precheck cannot have leaked onto the shared chain. |

Block B's evidence is the mock facilitator's call recording — reaching the
payment gate at all is the regression being guarded against, so "no verify, no
settle" is an assertion rather than an inference.

Re-baseline **only** for an intentional, additive shape change, and commit the
regenerated `baseline.json` in the same commit as the change that caused it.
Never re-baseline to silence a failure you did not intend.

### `spray-abi-preflight.mjs`

The permanent selector + gas gate for the Spraay contract on Base, extended
with a Robinhood Chain block: it asserts the USDG token and Permit2 addresses
on 4663 still resolve to deployed code, that USDG still reports
`Global Dollar` / `USDG` / 6 decimals with the EIP-712 domain
`{ name: "Global Dollar", version: "1", chainId: 4663 }` the rail signs
against, that its EIP-3009 surface still dispatches, and (if
`FACILITATOR_PRIVATE_KEY_ROBINHOOD` is in `.env`) how many settlements the
relay wallet can still fund. Run before any commit touching batch/payroll/sctp
calldata or the USDG rail:

```bash
node scripts/spray-abi-preflight.mjs      # prints "ABI PREFLIGHT: PASSED" and exits 0
```

### `robinhood-usdg-e2e.mjs`

An agent-style x402 v2 client for the **USDG rail on Robinhood Chain**
(`eip155:4663`). It fetches the 402, picks the `eip155:4663` `accepts[]`
entry, signs an EIP-3009 `TransferWithAuthorization` with
`TEST_PAYER_PRIVATE_KEY` from `.env` (the payer — never the facilitator or
deployer key; never printed) and resends with `PAYMENT-SIGNATURE`. On success
it decodes the `PAYMENT-RESPONSE` header, fetches the settlement receipt and
prints the facilitator's gas spend and the payer/payTo USDG balance deltas.

```bash
node scripts/robinhood-usdg-e2e.mjs --gateway http://127.0.0.1:3402 --dry-run   # 402 + signing only, nothing sent
node scripts/robinhood-usdg-e2e.mjs --gateway http://127.0.0.1:3402 --bad-sig   # expects a 402 rejection, nothing settles
node scripts/robinhood-usdg-e2e.mjs --gateway http://127.0.0.1:3402 --value 999 # under-payment → rejected
node scripts/robinhood-usdg-e2e.mjs --gateway http://127.0.0.1:3402             # REAL: moves USDG on mainnet
```

Flags: `--endpoint` (default `/api/v1/models`), `--method`, `--body` (JSON),
`--gateway` (default `$GATEWAY_URL` or `http://127.0.0.1:3402`). Every
non-dry-run invocation is a real mainnet settlement (dust-scale, ~$0.001), so
run it only with explicit approval.

### `live_batch_send_smoke.py`

A deterministic smoke test for the batch-payment (`batch_send`) x402 flow. It
drives the full two-leg protocol — **402 challenge → EIP-3009
`TransferWithAuthorization` → settlement** — against
`POST /api/v1/batch/execute`. Exactly one batch payment is attempted, so it's
the most reliable way to run a first live test.

Two modes:

| Mode | Trigger | Behaviour |
|------|---------|-----------|
| **Dry-run** | `EVM_PRIVATE_KEY` **unset** | Prints the parsed 402 payment quote. No wallet, no signing, **no funds move**. Run this first. |
| **Live** | `EVM_PRIVATE_KEY` **set** | Signs and settles the x402 gateway fee and submits the batch. **Moves real funds.** Requires typing `yes` at the prompt (or passing `--yes`). |

The private key is read only from the environment, used only to build the
in-memory signer, and is never printed.

```bash
# Dry-run the default single-recipient batch (safe)
python scripts/live_batch_send_smoke.py

# Live send 0.01 USDC on Base to one address (requires a funded wallet)
export EVM_PRIVATE_KEY=0x...        # funded Base wallet; never commit/share
python scripts/live_batch_send_smoke.py \
    --to 0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8 --amount 0.01 --yes

# Multiple recipients via the address:amount form
python scripts/live_batch_send_smoke.py \
    --to 0xAAA...:0.01 --to 0xBBB...:0.02 --yes
```

Useful flags: `--token` (default `USDC`), `--chain` (default `base`),
`--sender`, `--gateway` (default `$SPRAAY_GATEWAY_URL` or
`https://gateway.spraay.app`), `--timeout`, `--yes`. Run with `-h` for the full
list.

### `spraay_client.py`

The async HTTP client the smoke test builds on, vendored here so the script runs
standalone from this repo. `SpraayClient` wraps the gateway's free and paid
(x402) endpoints:

- **Dry-run mode** (no `EVM_PRIVATE_KEY`): a `402 Payment Required` response is
  parsed into a structured payment quote — no signing, no funds move.
- **Live mode** (`EVM_PRIVATE_KEY` set): paid requests are routed through the
  x402 SDK's payment transport, which signs an EIP-3009
  `TransferWithAuthorization` for USDC on Base (the `exact` scheme), attaches it
  as the `X-PAYMENT` header, retries, and returns the settled result plus the
  settlement transaction hash.

It also exports `to_batch_execute_payload(data)`, which converts the human-
decimal `[{to, amount}]` recipient list into the parallel `recipients` /
`amounts` (raw base-unit) arrays that `/api/v1/batch/execute` requires.

## Requirements

Python 3.10+. Dry-run mode only needs `httpx`. Live mode additionally needs the
x402 SDK and `eth-account`:

```bash
pip install httpx eth-account "x402[evm,httpx]"
```
