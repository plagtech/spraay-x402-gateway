# Follow-ups

Known issues that are deliberately NOT fixed in the change that found them. Pick one up as its own task.

## MPP: any `Authorization: Payment …` request returns HTTP 500 (all chains)

- **Found:** 2026-09-09, while verifying the Robinhood USDG rail deploy. **Predates that work** — reproduced locally on the untouched tempo-only branch of `src/middleware/mppMiddleware.ts` with the rail key removed.
- **Symptom:** production answers `500 {"error":"MPP payment processing failed","protocol":"mpp"}` for any credential-bearing MPP request; gateway log shows `TypeError: mppResponse.json is not a function` (tempo-only path) or `Cannot read properties of undefined (reading 'forEach')` (tempo + evm compose path).
- **Root cause:** the middleware treats the value returned by `mppx.charge(...)(req)` / `mppx.compose(...)(req)` as a Fetch `Response`, but mppx 0.6.14 returns `{ status: 402, challenge: Response } | { status: 200, withReceipt }` (see `node_modules/mppx/dist/server/Mppx.d.ts`, `MethodFn.Response`). Every MPP method is affected (tempo/pathUSD and the new evm/USDG alike); x402 on Base, Solana and Robinhood Chain is unaffected.
- **Fix outline:** in `handleMppPayment`, on `status === 402` forward `result.challenge`'s status, `WWW-Authenticate` header(s) and body; on `status === 200` obtain the receipt via `result.withReceipt(...)` and set `Payment-Receipt`; apply to both branches; add an offline test with a stub mppx instance. Consider bumping `mppx` (latest 0.9.2) in the same task and re-checking `compose()`.
- **Guard:** MPP is not on the nine frozen NVIDIA paths, but run `node scripts/rtp-ext-proof.mjs` anyway (middleware chain).
