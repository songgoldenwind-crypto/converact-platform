# Conversation Result & Quality R1 evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the local Rust D7 result and quality slice at Converact commit
`e488544bc44bc105c9605143222a5ea2b61822e7`. It proves bounded final transcript models,
terminal snapshots, immutable result/evaluation/Bad Case projections, durable effect reconciliation,
tenant-scoped PostgreSQL adapters and fail-closed Rust read APIs. It does not prove a physical
database, real speech or telephony input, a real evaluator, deployed authorization or production.

## Observed scope

- final transcript segments have stable source, sequence and execution-generation identities;
- historical generations remain evidence and cannot become the current execution owner;
- snapshots freeze only explicit terminal evidence and are content addressed;
- result revisions bind Agent Release, outcome schema and transcript snapshot digest;
- the platform recomputes rubric scores and deterministically derives Bad Case identity;
- projection commands are prepared before an effect and an unknown result is queried rather than
  generated a second time;
- result, evaluation and Bad Case persistence completes in tenant transactions with immutable
  receipts and explicit generation/revision fences;
- Rust query limits are 1–100, cursors are grammar checked and revalidated inside the tenant scope;
- result and quality lists exclude transcript text; transcript text requires a separate explicit
  capability and all responses are `no-store`;
- missing authentication fails with 401, missing capability with 403, invalid cursor/limit with 400
  and cross-tenant resource lookup does not return another tenant's data.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- Conversation Result Core model, hashing, snapshot and rubric behavior: 4 passed, 0 failed;
- Conversation Result Store command/schema/projection/query contracts: 8 passed, 0 failed;
- inert PostgreSQL runtime and tenant-transaction adapter contracts: 3 passed, 0 failed;
- projection reconciliation, query HTTP and PostgreSQL Worker port binding: 8 passed, 0 failed;
- scoped Rust Clippy across all targets with warnings denied: passed;
- scoped Rust formatting check: passed.

## Explicitly not run

- physical PostgreSQL migration, RLS, trigger, transaction and lease integration;
- real Active Call, Speech Runtime or RustPBX final transcript/CDR ingestion;
- real LLM/result/evaluation Provider behavior, accuracy and recovery;
- production HTTP router composition and real authorization-policy injection;
- legacy TypeScript read shadow parity, writer switch, drain, active-zero and deletion;
- real SIP/PSTN/RTP/SRTP, recording, DTMF, hold, transfer or LiveKit paths;
- browser/Dashboard UI and human quality-review workflow;
- performance, capacity, long-run, fault campaign and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
