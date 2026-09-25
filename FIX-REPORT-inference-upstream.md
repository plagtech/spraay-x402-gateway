# FIX REPORT — Gateway inference upstream defects

**Brief:** `CLAUDE-CODE-BRIEF-gateway-inference-upstream.md` · **Date:** 2026-09-25
**Commits on `main`** (author plagtech, all pushed):
1. `a34edd2` "fix(inference): upstream provider failures return 502/503, never 402" (fast-forward `31f6ebc..a34edd2`)
2. `e368a04` "fix(inference): never forward upstream provider error bodies to callers" (added after smoke, §6)
3. The commit carrying this report, the two FOLLOWUPS entries in §7 and the **3.8.3** version bump (§9)

**Status: done. All three smoke calls are green.** The first Bittensor smoke call failed because the gateway's Chutes account had a $0.00 balance. The fix handled it correctly (503, no charge), LP funded the account, and the retry returned 200 and settled. Total spend **$0.056** of the $0.20 cap.

---

## 1. Findings (Phase 0)

| # | Finding | Evidence |
|---|---|---|
| F1 | OpenRouter key env var is **`OPENROUTER_API_KEY`** (the only name in the source). It is read at module load. No credit or balance check exists anywhere. | `src/routes/ai-gateway.ts:6`, `:200`; also `src/routes/free/chat.ts:14`, `src/routes/inference.ts:12`, `src/routes/sctp.ts:31`, `src/services/compute-router.ts:27`; `/health` only checks the key is present (`src/routes/health.ts:33`) |
| F2 | Dead model `deepseek-ai/DeepSeek-V3-0324` appeared as the 402 bazaar example (`src/index.ts:957`), in the compute catalog (`src/config/compute-models.ts:41`) and in `seed-bazaar.mjs:185`. **The Bittensor handler has no default model**; `model` is required (`src/routes/bittensor-dropin.ts:244`). | Grep across the repo excluding `node_modules`/`dist` |
| F3 | Other dead ids in the same 402s: `chutesai/Llama-3.1-Nemotron-70B-Instruct` (`src/middleware/enrich402.ts:88`, `:102`) and `deepseek-ai/DeepSeek-R1-0528` (`src/index.ts:952`). All 11 Chutes chat ids in `compute-models.ts` are missing from the live list. | Live list, §5 Phase 0 |
| F4 | OpenRouter passed the upstream status straight through (`ai-gateway.ts:237`), so "Insufficient credits" reached the caller as **402**, and `enrich402Middleware` (`index.ts:188`, `enrich402.ts:970-1038`) then dressed it up as a payment challenge. BlockRun `PaymentError` also returned 402 (`ai-gateway.ts:183`). | Source; Oracle `VERIFY-REPORT.md` F2 finding 2 (live HTTP 402) |
| F5 | Bittensor already returned 502 for upstream 402/404/5xx, but chose the status by searching the error text for "429", "401" and "not configured", including the upstream body. So a 404 whose body mentioned "429" became 429, and our own bad key reached the caller as 401. | `bittensor-dropin.ts:325-331`; Oracle F2 finding 3 (live HTTP 502) |
| F6 | No frozen NVIDIA path carries any of these ids or mappings. `scripts/rtp-proof/baseline.json` has no chat or Bittensor entries. | grep |
| F7 | x402 settles only when the handler returns <400: `@x402/express` 2.16.0, `dist/cjs/index.js:292` (`if (res.statusCode >= 400)` → cancel). | Library source; confirmed live in §5 (the Bittensor 503 charged 0) |
| F8 | The gateway has no operator alerting path. `/api/v1/notify/*` and `/api/v1/webhook/*` are paid customer features; `gateway-events` is Supabase analytics. | grep |

## 2. Decisions (LP)

1. Example model: prefer `deepseek-ai/DeepSeek-V3.2-TEE`, checked against the live list at startup. If it's missing, use the cheapest listed model.
2. If the list call fails, fall back to that same live id, never the dead one.
3. Status mapping: OpenRouter upstream 402/404/5xx → 502/503; BlockRun 402 → 502; Bittensor maps by status code, not body text; `enrich402` skips upstream errors. **Added at the diff gate:** upstream 401 → 503 for OpenRouter, Chutes and BlockRun.
4. Fix `index.ts:952` and `enrich402.ts:88/:102` only if the nine-path proof stays 19/19 (it did). `compute-models.ts` goes to FOLLOWUPS only.

## 3. Diff summary (`a34edd2`, 9 files, +624/−22)

| File | Change |
|---|---|
| `src/lib/upstream-errors.ts` (new) | `upstreamFailureStatus()`: 401/402/503 → 503, 404/other 5xx → 502, anything else → `null` (keeps existing handling). `markUpstreamError(res)` sets `res.locals.upstreamError`. `logCreditsExhausted()` logs the marker **`[SPRAAY_UPSTREAM_CREDITS_EXHAUSTED]`** at error level. |
| `src/lib/bittensor-model.ts` (new) | Picks preferred, then cheapest (prompt + completion price), then fallback. Checked once at startup with a 10 s timeout and never throws. `bindBittensorModel()` updates the example objects in place, so the x402 route config (read on every request, `@x402/core` `server/index.js:1891-1900`, `:2011`) and `enrich402` serve the resolved id without rebuilding the payment middleware. |
| `src/routes/ai-gateway.ts` | OpenRouter: mapped statuses carry the provider message plus a new additive field `upstream_status`, and are tagged. 400/other 4xx and network errors are unchanged. BlockRun: `PaymentError` 402 → 502 plus marker; `APIError` 401 → 503; both tagged. |
| `src/routes/bittensor-dropin.ts` | New typed `UpstreamHttpError` (carries the status) and `ProviderNotConfiguredError`. `bittensorChatErrorStatus()` maps on the status code; 429 still passes through. Tags and logs the marker on upstream 402. `listBittensorChatModels()` feeds the startup check. |
| `src/middleware/enrich402.ts` | Returns early when `res.locals.upstreamError` is set. Untagged 402s (x402, MPP, Solana, compute-futures credit) are enriched exactly as before. Both Bittensor example ids now follow the resolved model. |
| `src/index.ts` | The bazaar examples at `:952`/`:957` follow the resolved model. `app.listen` starts the check without blocking startup. |
| `test/inference-upstream.test.ts` (new), `package.json` | `npm run test:inference`, 27 offline tests. |
| `docs/FOLLOWUPS.md` | Six entries (§7). |

**What a caller sees now:**

| Upstream | Before | After |
|---|---|---|
| OpenRouter 402 (credits) | 402, enriched as a payment challenge | **503** + `upstream_status: 402` + marker |
| OpenRouter 401 / 503 | passed through as 401 / 503 | **503** |
| OpenRouter 404 / other 5xx | passed through | **502** |
| BlockRun `PaymentError` / `APIError` 401 | 402 / 500 | **502** + marker / **503** |
| Chutes 402 | 502 | **503** + marker |
| Chutes 401 | 401 | **503** |
| Chutes 503 | 502 | **503** |
| Chutes 404 with "429" in its body | 429 | **502** |

Every mapped status is ≥400, so settlement is cancelled and the caller is not charged.

### 3b. `e368a04`: stop forwarding upstream error bodies (4 files, +147/−44)

Prompted by the first Bittensor smoke call (§6): Chutes' 402 text reached the caller verbatim, including the gateway's Chutes deposit address and its $0 balance. Any upstream body can carry account state, and the **free** `/bittensor/v1/health` sent the same text to anyone.

| File | Change |
|---|---|
| `src/lib/upstream-errors.ts` | `providerErrorMessage(status)` gives a generic message per status. 400/422 ("rejected as invalid — check the model id and parameters") and 404 ("does not serve this model — check the models list") still tell the caller what to fix. |
| `src/routes/ai-gateway.ts` | OpenRouter: mapped failures **and** unmapped pass-throughs (400, 429, …) carry the generic `details` + `upstream_status`, and keep their status. The log line is now JSON, so nested metadata isn't elided. Network errors (no response) are unchanged. BlockRun `APIError` text is replaced, with `upstream_status` when known. |
| `src/routes/bittensor-dropin.ts` | `UpstreamHttpError(provider, status, body)` keeps the full body for the log. `publicErrorMessage()` is used by chat, images, embeddings, models `_warnings` and the free health endpoint. Each gains an additive `upstream_status`. Images and embeddings choose 503 via `ProviderNotConfiguredError` instead of searching the message text. Our own errors (not configured, network) keep their text. |
| `test/inference-upstream.test.ts` | Assertions updated for the generic bodies. New test: Chutes' 402 body (deposit address, $0 balance) never appears in the chat, images, embeddings, models or health responses, and does appear in the server log. |

Checks before pushing: **28/28** tests pass, `tsc` clean (source + tests), nine-path proof **19/19** (exit 0). Limitation: the test environment configures no image provider, so the images route fails before reaching upstream. Its no-leak assertion therefore passes trivially. Chat, embeddings, models and health do exercise the real upstream-402 path.

## 4. Tests

| Check | Result |
|---|---|
| `npm run test:inference` | **27/27 pass**, offline (axios, fetch and the BlockRun client are stubbed; no keys or network) |
| `tsc --noEmit` on source and on `test/tsconfig.json` | clean, 0 errors |
| Existing `test:guard` / `test:batch` / `test:usdg` | 6 / 14 / 14 pass |
| `node scripts/rtp-ext-proof.mjs` before the change | **19/19**, "NVIDIA COMPAT BLOCK: PASSED", exit 0 |
| Same, after the change (and again after the 401 addition) | **19/19**, PASSED, exit 0. **No re-baseline.** |
| Compiled gateway booted against the proof's mocks, unpaid Bittensor 402s | `deepseek-ai/DeepSeek-V3.2-TEE` in all six example spots (body and `payment-required` header, both routes); no dead ids left |

## 5. Deploy and smoke

**Deploys.** Neither code commit changed the version string, so each deploy was confirmed by a behavioral fingerprint instead:
- `a34edd2` was serving **101 s** after the push, detected by the unpaid `/bittensor/v1/chat/completions` 402 changing from the dead ids to `deepseek-ai/DeepSeek-V3.2-TEE`. `/health` read `healthy`, `version: "3.8.2"`.
- `e368a04` was live **106 s** after the push, detected by `/health` `uptime` resetting to 0m 8s from 30m 51s. The free `/bittensor/v1/health` then showed Chutes `ok` with 14 models.
- The **3.8.3** bump is the version change the brief's §2.1 asks for (§9).

**Frozen paths, before and after (2.4), checked for both code deploys.** Captures were taken from prod unpaid before each push (the first pre-capture twice, byte-identical) and after each deploy:

| Path | Result |
|---|---|
| `POST /api/v1/batch/execute`, `POST /api/v1/escrow/create`, `GET /api/v1/robots/list`, `GET /api/v1/balances` (unpaid 402) | Status 402 in every capture. The body and the `payment-required` header are **identical except the known Solana `feePayer` rotation** across both deploys (`BFK9TLC3…L9b4F` → `GVJJ7rdG…aGqDveb` for `a34edd2`, then back to `BFK9…` for `e368a04`). `x-spraay-meta` is identical. |
| `/free/validate-batch`, `/free/estimate-batch`, `/free/prices`, `/free/chain-status`, `/api/v1/tokens` | 200 in every capture. Identical key paths: none removed, none added. These carry live values, so key paths are the right comparison. |

**Paid calls.** Test wallet `0xf39821E30EDED6189529470e42427860Bd0a8200`, payTo `0xAd62f03C7514bb8c51f1eA70C2b75C37404695c8`, Base USDC, cap $0.20. Each call first checked for an unpaid 402, the exact expected quote and the cap (`oracle-spraay-verify/work/gw2_smoke.py`). Every transaction below was re-read on-chain: receipt status success, one USDC `Transfer` from the test wallet to payTo, gas paid by the facilitator.

| Call | HTTP | Quote | Charged | Tx | Block |
|---|---|---|---|---|---|
| Phase 0: `GET /bittensor/v1/models` | 200 | 1000 | 1000 | `0x20459545e60467d5655fa7c636268a429df0b2aa6f552bbfdf4c15ef04a74e48` | 51,792,809 |
| `POST /api/v1/chat/completions`, `openai/gpt-5.5` | **200** | 5000 | 5000 | `0xef1a971a48e24f006beb454ee711e90ffe7d776431a4130aed921c25efbcbf99` | 51,794,525 |
| `POST /bittensor/v1/chat/completions`, `deepseek-ai/DeepSeek-V3.2-TEE`, first attempt (Chutes at $0.00) | **503** | 30000 | **0** | — (settlement cancelled) | — |
| Same, retry after LP funded Chutes (on `e368a04`) | **200** | 30000 | 30000 | `0x100367ccde950660df1ad23b5621a4c29c882cecc10a5711dbc8b6faeee6ae74` | 51,795,335 |
| `POST /api/v1/search/web` (regression check) | **200** | 20000 | 20000 | `0xdc601679ff20d28d7f1fbbc6c1d72d8034b567c2c02ef160ae7f5d5a7540f28f` | 51,794,604 |

**Reconciliation, exact to the unit.** Wallet 905,875 → 849,875 atomic USDC = 56,000 spent (final balance re-read on-chain); the on-chain `Transfer` sum is 1,000 + 5,000 + 20,000 + 30,000 = 56,000. ETH unchanged at 505,675,739,624,778 wei. **Total spend $0.056** ($0.001 in Phase 0 + $0.055 in Phase 2) against the $0.20 cap. Records: `oracle-spraay-verify/captures/f2_gw0_bittensor_models.json`, `f2_gw2_{chat,bittensor,search}.json`, `gw2_ledger.json`. The ledger holds all four Phase 2 attempts, including the 503. `f2_gw2_bittensor.json` holds only the retry, because the retry overwrote the first attempt's file; the 503 body is quoted in §6.

Replies: chat (`openai/gpt-5.5`) gave a one-sentence definition of x402, confirming LP's OpenRouter credit fix in Railway. Bittensor (`DeepSeek-V3.2-TEE`) gave a one-sentence definition of Bittensor, confirming the new example model works end to end.

## 6. Bittensor: blocked on Chutes credit, then green

**First attempt (on `a34edd2`):**

```
HTTP 503
{"error":{"message":"Bittensor inference error: Chutes AI returned 402:
  {\"detail\":{\"message\":\"Quota exceeded and account balance is $0.0, please pay with fiat or send tao to 5CqrYioF…hbNiB\"}}",
  "type":"server_error","code":"provider_error"}}
```

- **The fix held in production.** Chutes' 402 became a 503, was not presented as a payment challenge, and x402 cancelled settlement (charged 0). Before `a34edd2` the same failure returned 502. The model id was no longer the problem: the request reached `DeepSeek-V3.2-TEE` and was refused only over credit.
- **Account problem, not code:** the gateway's Chutes account (`CHUTES_API_KEY`) was at $0.00, so every paid Bittensor chat call failed until LP funded it. Callers weren't charged.
- **Leak it exposed:** the body forwarded Chutes' text word for word, including the gateway's deposit address and balance. `e368a04` fixed that (§3b). The same call on `e368a04` would now return only `"Bittensor inference error: Chutes AI returned 402: The AI provider is temporarily unavailable. Retry later."` with `upstream_status: 402`, as asserted in the new leak test.

**Retry (on `e368a04`, after LP funded Chutes):** HTTP **200**, charged 30,000 = quote, tx `0x100367ccde950660df1ad23b5621a4c29c882cecc10a5711dbc8b6faeee6ae74`, block 51,795,335 (§5).

**Not verified from here:** that Railway logged `[SPRAAY_UPSTREAM_CREDITS_EXHAUSTED] Chutes AI …` for the first attempt. I have no access to Railway logs. A log search for the marker around 2026-09-25 23:21 UTC settles it.

## 7. FOLLOWUPS.md entries added

In `a34edd2`:
1. The credits alert is a log marker only, with no alerting path. Suggested fix: a Railway log alert on `[SPRAAY_UPSTREAM_CREDITS_EXHAUSTED]`.
2. `/health` reports `aiGateway: "configured"` with zero credits (`src/routes/health.ts:33`).
3. Flat-price margin exposure: $0.03 Bittensor and $0.005 OpenRouter for whatever model and `max_tokens` the caller picks.
4. All Chutes chat ids in `src/config/compute-models.ts` are dead.
5. `seed-bazaar.mjs:185` still seeds `deepseek-ai/DeepSeek-V3-0324`.
6. Upstream 403 still passes through, and a rejected gateway key logs no distinct marker.

In this report's commit:

7. **The Chutes account balance is unmonitored.** Paid Bittensor went down at $0.00, and the only signal is the marker, which fires after a paying caller hits the empty account. The free `/bittensor/v1/health` probably reads `ok` with an empty account because `/models` likely needs no credit; this was not verified.
8. **Upstream error bodies still reach callers outside the fixed handlers.**
   - `/api/v1/compute/*`: `src/services/compute-router.ts:63`, `:87`, `:128`, `:175`, `:326`, returned as `details: err.message` in `src/routes/compute.ts`.
   - **`/free/chat`** (free, open to anyone): `src/routes/free/chat.ts:106`, `:140` forward the full OpenRouter body and pass the upstream status through unchanged, including 402.

## 8. Out of scope, untouched

- Pricing.
- Error handling in `/free/chat`, `/compute/*`, `inference.ts` and `sctp.ts` (entry 8 above).
- Discovery regeneration.
- `package-lock.json`'s version field (left at 3.8.2, matching how the previous bump in `c790bd6` was done).
- The NVIDIA baselines, which record the version for reporting only and were **not** re-baselined.

## 9. Version 3.8.3

`package.json` `"version": "3.8.2"` → `"3.8.3"` and `src/lib/version.ts` `FALLBACK_VERSION` → `"3.8.3"`, in this report's commit (the same two files `c790bd6` changed for 3.8.2). `/health` `version` reads `package.json` at boot, so after deploy it should read **3.8.3**. This report ships in that same commit, so it cannot record the result: the post-deploy `/health` check is reported in the session. Frozen-path 402s and `x-spraay-meta` carry the version value, so for this deploy the before/after comparison allows exactly two differences: `feePayer` and `3.8.2` → `3.8.3`.
