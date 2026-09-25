# Follow-ups

Known issues that are deliberately NOT fixed in the change that found them. Pick one up as its own task.

## MPP: any `Authorization: Payment …` request returns HTTP 500 (all chains)

- **Found:** 2026-09-09, while verifying the Robinhood USDG rail deploy. **Predates that work** — reproduced locally on the untouched tempo-only branch of `src/middleware/mppMiddleware.ts` with the rail key removed.
- **Symptom:** production answers `500 {"error":"MPP payment processing failed","protocol":"mpp"}` for any credential-bearing MPP request; gateway log shows `TypeError: mppResponse.json is not a function` (tempo-only path) or `Cannot read properties of undefined (reading 'forEach')` (tempo + evm compose path).
- **Root cause:** the middleware treats the value returned by `mppx.charge(...)(req)` / `mppx.compose(...)(req)` as a Fetch `Response`, but mppx 0.6.14 returns `{ status: 402, challenge: Response } | { status: 200, withReceipt }` (see `node_modules/mppx/dist/server/Mppx.d.ts`, `MethodFn.Response`). Every MPP method is affected (tempo/pathUSD and the new evm/USDG alike); x402 on Base, Solana and Robinhood Chain is unaffected.
- **Fix outline:** in `handleMppPayment`, on `status === 402` forward `result.challenge`'s status, `WWW-Authenticate` header(s) and body; on `status === 200` obtain the receipt via `result.withReceipt(...)` and set `Payment-Receipt`; apply to both branches; add an offline test with a stub mppx instance. Consider bumping `mppx` (latest 0.9.2) in the same task and re-checking `compose()`.
- **Guard:** MPP is not on the nine frozen NVIDIA paths, but run `node scripts/rtp-ext-proof.mjs` anyway (middleware chain).

## Discovery: the frozen `/api/v1/batch/execute` 402 still advertises a stale `transactions[]` output example

- **Found:** 2026-09-11, during the discovery-accuracy pass that corrected every *other* surface (commit `docs(discovery): correct /api/v1/batch/execute output example`).
- **Symptom:** an unpaid `POST /api/v1/batch/execute` returns a 402 challenge advertising an output shape the handler has never produced, in two independent places:
  - `.extensions.bazaar.info.output.example.transactions` (+ its mirror under `.extensions.bazaar.schema.properties.output.properties.example.properties.transactions`) — from the `paidRoutes` entry in `src/index.ts`.
  - `._spraay.example_response` = `{ transactions: [{ hash, status, gasUsed }], totalSent }` — from `src/middleware/enrich402.ts`. This one is wholly invented; no field of it exists in any response.
  The real shape is `{ success, contract, token{...}, batch{...}, transaction{...}, approvalRequired{...} }` — see `src/routes/batch-payments.ts`.
- **Why it was left:** `/api/v1/batch/execute` is one of the nine frozen NVIDIA paths (CLAUDE.md). Correcting the example **removes** key paths from its 402 body, so it is a *non-additive* change to a frozen response. CLAUDE.md permits re-baselining only for intentional **additive** changes, and the 402 body is byte-stable today (two consecutive prod fetches are byte-identical), so consumers may be matching on it.
- **Fix outline — needs a deliberate decision, not a drive-by:** either
  1. **additive:** keep the `transactions` key alongside the real fields so no key path is removed — the guard's additive rule holds, but the served example keeps advertising a field the handler never returns; or
  2. **clean break:** correct both places and re-baseline. Regenerate **both** `scripts/rtp-proof/baseline.json` and `scripts/rtp-proof/baseline-prod.json` in the same commit — `baseline-prod.json` records the same stale key paths, so updating only one leaves the pair disagreeing.
  Before either, check what NeMo-Agent-Toolkit-Examples PRs #20 and #27 actually parse out of the 402 body; if neither reads `example_response` or `extensions.bazaar`, option 2 is safe and is the right fix.
- **Guard:** `node scripts/rtp-ext-proof.mjs` will fail Block A until re-baselined. Do not re-baseline without doing the above.

## Corrections ledger — `..\spraay-peaq-deploy\DEPLOY-REPORT.md` (do not edit ad hoc; one deliberate pass)

Opened 2026-09-15 during the peaq gateway-wiring session. Both items are corrections to a
report that is otherwise the provenance record for the peaq deployment, so they get one
careful pass together rather than drive-by edits.

### §11 anomaly 1 — "peaq receipts omit `effectiveGasPrice`" is not reproducible

- **Reported:** DEPLOY-REPORT §11.1 and §5 (Phase 1b) record that peaq receipts omit
  `effectiveGasPrice`, calling it a Frontier divergence, and note it caused a dust-script bug
  where `rcpt.effectiveGasPrice ?? 0n` made an excess-refund assertion pass vacuously.
- **Observed 2026-09-15**, on the Phase 3 peaq spray `0xdf98b169…3d21` (block 11,622,572):
  the field is **present** — `effectiveGasPrice: 0x174876e800` (100 gwei). Checked by raw
  `eth_getTransactionReceipt` against **all four** peaq RPCs — `peaq-rpc.publicnode.com`,
  `quicknode1/2/3.peaq.xyz` — which return it with **identical key sets**.
- **Two hypotheses, neither confirmed:**
  1. peaq node upgrade between the deploy campaign (2026-09-14/15) and now, restoring the field.
  2. The original observation was narrower than recorded — e.g. one RPC, one tx type, or a
     client-library shape rather than the raw JSON-RPC body — and was generalised too far.
  Distinguishing them means re-reading a receipt from the campaign's own block range
  (11,620,455–11,620,562) and comparing; the field is chain-state, so this is decidable.
- **Not urgent:** the gateway reads no receipts on any path peaq traffic reaches (audited in
  this session's Phase 0 — the only `effectiveGasPrice` reads are in `src/rails/robinhoodUsdg.ts`,
  network-gated to 4663, and they already carry the `?? r.gasPrice` fallback). The defensive
  fallback is correct regardless of which hypothesis holds — **keep it either way.**

### §13 close-out — the deployer key is still on this machine under another name

- **Claimed:** DEPLOY-REPORT §13 states the canonical deployer `0x75F3F4C27BB8DB5d72E82a5359674084025Fc82b`
  — which is the peaq contract's `owner` *and* `feeRecipient`, holding `updateFee`,
  `updateFeeRecipient`, `pause`/`unpause`, `emergencyWithdraw` and `transferOwnership` —
  "is no longer reachable from this machine", verified by removing `PEAQ_DEPLOYER_PRIVATE_KEY`
  from `..\spraay-peaq-deploy\.env`.
- **Observed 2026-09-15:** the same key is present in the **gateway** repo's `.env` as
  `DEPLOYER_PRIVATE_KEY`. Derived read-only, address only, no key material printed or logged.
  The removal narrowed one filename; it did not achieve the stated property.
- **Follow-up task (own session, after this one):**
  1. Audit every reference to `DEPLOYER_PRIVATE_KEY` in the gateway repo.
  2. Determine whether `npm run test:gas` depends on that wallet's standing Base USDC allowance
     to the Spray contract — `test/batch-gas.test.ts` pins `ESTIMABLE_SENDER` to this address and
     comments that the allowance (granted 2026-09-03) is what makes `sprayToken` simulate; if so
     the test needs a non-privileged replacement before the key can move.
  3. Propose migration to a non-privileged test wallet.
  4. LP removes the line by hand; Claude Code verifies it is gone.
  5. Machine-wide sweep for any other residence of that key.
  6. Write the correction note into DEPLOY-REPORT §13.
- **Do not** rotate the contract owner or move funds as part of this — that is a separate decision.

## Discovery: `gen-discovery.mjs` cannot reproduce two hand-edits that lived in the synced llms files

- **Found:** 2026-09-15, doing the first wholesale llms regen since Robinhood Chain shipped.
- **Symptom:** the regen silently *removed* content from `spraay-docs`:
  - `llms.txt` — the paragraph "Batch payments (BPA 1.0) span 16 chains, including Robinhood
    Chain … USDG is also an x402 payment rail …".
  - `llms-full.txt` — `Robinhood Chain, USDG, Global Dollar` appended to the `batch/execute`
    searchTerms, and `Robinhood Chain` appended to `chain-status`.
- **Root cause:** both were hand-written into the docs repo in `c4f6598`. `gen-discovery.mjs`
  has no template line for the paragraph, and those searchTerms were never in the gateway
  source — `git log -S"Global Dollar" -- src/index.ts` is empty across all history, so
  production never served them. Any wholesale sync was always going to erase them; this is the
  MANIFEST_META trap pointing the other way.
- **Fix outline:** decide what that copy should say now that Base and peaq are the only
  gateway-settled chains, then emit it from `gen-discovery.mjs` (a `chainsLine` beside the
  existing `rhLine`) and/or from `MANIFEST_META` searchTerms in `src/index.ts` — gateway-side,
  so the next sync reproduces it. Never re-add it to the docs repo by hand.

## Docs: `index.html` claims 192 primitives / 160 paid; the gateway manifest carries 190 / 158

- **Found:** 2026-09-15. Pre-existing, and **not** introduced or resolved by the llms regen —
  `llms.txt` already carried 190/158 before it, so the two numbers have been disagreeing on the
  same site.
- **Where:** `spraay-docs/index.html` hero `hero-stat` (192 / 160 / 32 / 44) and both the
  `<meta name="description">` and `og:description` ("192 … (160 paid + 32 free)").
  `/.well-known/x402.json` resolves to 190 resources, 158 paid, 32 free, 33 categories.
- **Note:** free (32) agrees; only the paid count differs, by exactly 2. The site has 195
  `endpoint-card` elements, two of which are chain/contract cards and one a payment-rail card,
  which lands at 192 — so the hero is counting cards, not manifest resources. The 44 vs 33
  category figure is a *different* definition (docs sidebar groupings vs manifest category
  slugs) and is not necessarily wrong.
- **Fix outline:** identify the 2 endpoints documented as paid cards but absent from the paid
  manifest (or vice versa), then decide per endpoint whether the card or the manifest is wrong.
  Do not simply retype the hero to 190/158 — that hides whichever of the two is a real gap.

## Inference upstream — left over from the `fix/inference-upstream` session (2026-09-25)

That session fixed three things: the dead Bittensor example model, upstream provider failures
coming back as 402, and the missing credits marker. The items below are related but were kept
out of scope on purpose. Live model list used as evidence: `GET /bittensor/v1/models` paid
2026-09-25, tx `0x20459545e60467d5655fa7c636268a429df0b2aa6f552bbfdf4c15ef04a74e48`
(14 Chutes models; saved at `..\oracle-spraay-verify\captures\f2_gw0_bittensor_models.json`).

### No alerting path for exhausted provider credits — only a log marker

- **Found:** 2026-09-25, Oracle notebook verify (F2): paid `/api/v1/chat/completions` failed with
  OpenRouter "Insufficient credits", and nothing told anyone.
- **Now:** every upstream "out of credit" failure logs at error level with the marker
  **`[SPRAAY_UPSTREAM_CREDITS_EXHAUSTED]`** (`src/lib/upstream-errors.ts`). It fires on OpenRouter
  402, Chutes 402, and BlockRun `PaymentError`. The gateway has no operator alerting path
  (`/api/v1/notify/*` and `/api/v1/webhook/*` are paid customer features; `gateway-events` is
  Supabase analytics), so the marker is the whole deliverable.
- **Fix outline:** add a Railway log alert (or any log drain) matching the marker. If the gateway
  gets an ops channel later, call it from `logCreditsExhausted()`. That is the single choke point.

### `/health` reports the AI gateway "configured" even when the OpenRouter account has no credit

- **Where:** `src/routes/health.ts:33`: `aiGateway: process.env.OPENROUTER_API_KEY ? "configured" : "needs_api_key"`.
  It only checks that the key is present. During the F2 outage `/health` showed nothing wrong.
- **Fix outline:** add a cached (e.g. 5 min) credit check against OpenRouter's key-info
  endpoint. Confirm the current path and response fields in OpenRouter's docs first; it reports
  the key's usage and limit. Surface it as a new additive field (e.g.
  `aiGatewayCredits: "ok" | "low" | "exhausted" | "unknown"`). Don't change the existing
  `aiGateway` value; `/health` consumers may match on it.

### Flat-price margin exposure on caller-chosen models

- **Where:** `POST /bittensor/v1/chat/completions` charges a flat **$0.03** whatever `model` or
  `max_tokens` the caller sends (`src/index.ts` paidRoutes). The handler forwards the body
  unchanged (`src/routes/bittensor-dropin.ts`).
- **Exposure:** the live list's `pricing` runs from `prompt 0.0245 / completion 0.0978`
  (`unsloth/Mistral-Nemo-Instruct-2407-TEE`) to `prompt 3 / completion 15`
  (`moonshotai/Kimi-K3-TEE`, 1M context). If those are USD per million tokens (Chutes'
  usual unit, not verified here), a Kimi-K3 call with about 2,000 output tokens already costs
  the full $0.03, and a long-context or large-`max_tokens` call costs many times the price.
  `POST /api/v1/chat/completions` has the same shape at a flat **$0.005** across 200+
  OpenRouter models.
- **Why it was left:** pricing changes were out of scope for that session.
- **Fix outline — needs a pricing decision:** one of (a) cap `max_tokens` per model tier,
  (b) an allowlist of models the flat price covers, (c) per-model or dynamic pricing. Any
  of these changes what a 402 quotes, so check the frozen-path rules even though these two
  routes are not frozen.

### `/compute/*` catalog: every Chutes chat model id is gone from the live list

- **Where:** `src/config/compute-models.ts`. None of the 11 Chutes chat ids (the
  `deepseek-ai/DeepSeek-*`, `meta-llama/*`, `mistralai/*`, `Qwen/Qwen3-*` entries, including
  `deepseek-ai/DeepSeek-V3-0324` at `:41`) is in the 2026-09-25 live list. The nearest match is
  `Qwen/Qwen3-32B`, which is listed only as `Qwen/Qwen3-32B-TEE`. `/api/v1/compute/text-inference`
  and `/api/v1/compute-futures/execute` therefore most likely fail upstream for every Chutes model.
  On `text-inference` those failures surface as 502 (`src/routes/compute.ts:61`), so x402
  callers are not charged. The `compute-futures` error path was not checked.
- **Fix outline:** re-map the catalog to live ids. Then consider validating it at startup the
  way `src/lib/bittensor-model.ts` does, so a retired id is logged instead of silently
  failing. Check `compute-futures` too: it bills from the prepaid balance, not x402, so
  confirm a failed job does not debit it.

### `seed-bazaar.mjs:185` still seeds the dead `deepseek-ai/DeepSeek-V3-0324`

- Not runtime code. It's a one-off script that seeds an external bazaar. Update the example body
  (to `deepseek-ai/DeepSeek-V3.2-TEE`) before the next time it is run. Whatever an earlier run
  already seeded externally is not fixed by any gateway deploy.

### Upstream 403 still passes through; a rejected gateway key logs no marker

- **Done in that session:** an upstream **401** from OpenRouter, Chutes or BlockRun (the
  gateway's own key or wallet auth was rejected) now returns 503, tagged as an upstream error
  (`upstreamFailureStatus()` in `src/lib/upstream-errors.ts`).
- **Left:** an upstream **403** still passes through from OpenRouter
  (`src/routes/ai-gateway.ts`), and still maps to 502 on Bittensor. A 401 logs only the
  generic handler error line, with no distinct marker, so a revoked key is not grep-able the
  way exhausted credits are.
- **Fix outline:** decide whether 403 means "the gateway's key lacks access" for each provider
  (then 503) or a content/policy refusal of the caller's request (then pass through). Add a
  revoked-key marker next to `UPSTREAM_CREDITS_MARKER`.
