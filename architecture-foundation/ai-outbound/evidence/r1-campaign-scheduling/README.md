# AI outbound R1 Campaign scheduling and retry evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the bounded local Rust retry-planning slice at Converact commit
`1a6ff24602ce2dfee30e2e4a92e7d9347010c85e`. It proves that a definitive retryable terminal
Attempt can produce one separately identified delayed Attempt, while exact replay creates no
second durable Attempt. It does not prove a physical PostgreSQL transaction, a Campaign import or
a real telephone call.

## Observed scope

- policy bounds maximum attempts to 1–20 and delay to one second–seven days;
- only definitive busy/no-answer/rejected/pre-answer failure, plus explicitly enabled
  post-answer failure, can plan a retry;
- completed, compliance-blocked and cancelled outcomes do not retry;
- unknown or reconcile-required outcomes fail closed and never reach persistence;
- every retry has a new `CallAttemptId`, predecessor link, checked sequence and checked schedule;
- the tenant transaction contract locks predecessor Attempt, Campaign and Contact, preserves
  Interaction/Agent Release/compliance/recording/retention bindings and starts generation 1;
- Campaign must still be running and Contact queued/active at the atomic insert boundary;
- exact identity/idempotency replay returns the existing Attempt; mismatches fail closed;
- the Worker has no real-time call or media authority and invokes durability only for `Planned`;
- authorized Attempt inspection exposes only optional retry state and stable reason code;
- destination, transcript, prompt, model payload and credentials are absent from retry commands,
  inspection and controlled evidence.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- AI Outbound retry Core: 4 passed, 0 failed;
- retry Store contract: 3 passed, 0 failed;
- ignored physical PostgreSQL harness: compiled, execution not run;
- Campaign retry Worker and bounded inspection: 4 passed, 0 failed;
- existing Worker HTTP safety/tenant behavior: 5 passed, 0 failed;
- scoped Rust Clippy with warnings denied: passed;
- scoped Rust formatting check: passed.

## Explicitly not run

- physical PostgreSQL retry insert/replay, RLS, transaction races and crash recovery;
- real Campaign/Contact import, writer, scheduler claim and authorization router;
- real RustPBX, Active Call, Speech, SIP/PSTN, media, recording or CDR;
- deployed API/dashboard and legacy TypeScript shadow/writer migration;
- performance, capacity, long-run, fault campaign and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
