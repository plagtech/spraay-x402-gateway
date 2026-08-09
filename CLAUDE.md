## NVIDIA BACKWARD-COMPAT GUARD (non-negotiable)

The following endpoints are consumed by MERGED NVIDIA NeMo-Agent-Toolkit-Examples
PRs #20 and #27. They must stay green and unchanged forever:

- POST /free/validate-batch
- GET  /free/estimate-batch
- GET  /free/prices
- GET  /free/chain-status
- GET  /api/v1/tokens
- POST /api/v1/batch/execute
- POST /api/v1/escrow/create
- GET  /api/v1/robots/list   (default response, no sim param)
- GET  /api/v1/balances

Rules: never rename, remove, reprice via breaking change, or alter the
request/response shape of these routes. New fields are allowed (additive only).
Middleware changes that affect their handler chain count as changes.
Before ANY commit touching index.ts, batch, escrow, or robots routes:

    node scripts/rtp-ext-proof.mjs

Confirm it prints "NVIDIA COMPAT BLOCK: PASSED" and exits 0. It compiles
src/, boots the gateway against a mock Supabase and a mock x402 facilitator
(scripts/rtp-proof/), and needs no network, no database and no real funds.
Add --no-build to reuse an existing dist/, --verbose to stream gateway logs.

It asserts three things:
  A. The nine paths above still match scripts/rtp-proof/baseline.json on
     status, content type, top-level key set and every nested key path.
     Values are ignored; version values are reported, not asserted.
  B. POST /api/v1/robots/task validates before it charges — unpaid requests
     still get the unchanged 402, and a paid request with an invalid payload
     is rejected with ZERO facilitator calls.
  C. The payment gate still runs for paid routes other than robots/task.

If a shape change to a frozen path is intentional AND additive, re-baseline
with `node scripts/rtp-ext-proof.mjs --update-baseline` and commit the
regenerated baseline.json in the same commit as the change that caused it.
Never re-baseline to silence a failure you did not intend.

If a task seems to require modifying these routes, STOP and ask LP first.