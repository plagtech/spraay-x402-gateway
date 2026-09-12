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
