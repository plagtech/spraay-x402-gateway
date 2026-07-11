# scripts/

Standalone x402 batch-payment verification tooling for
[`gateway.spraay.app`](https://gateway.spraay.app). These run independently of
the gateway server — they exercise the live x402 flow as a *client*.

## Files

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
