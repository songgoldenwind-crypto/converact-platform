# RM01 R1 — atomic outbox finalization contract evidence

Status: `implemented_offline_default_disabled`. This slice tightens the pure
Rust outbox contract from commit `a0e0b68`; it still has no database, provider,
transport, task, queue or runtime route.

## Atomic completion boundary

One definitive provider observation now yields one private-field
`DeliveryFinalizationPlan`. The future PostgreSQL adapter must execute its
three ordered mutations in one transaction:

1. append the `completed` effect receipt;
2. apply the exact complete/retry/dead-letter outbox transition;
3. append the `state_observed` effect receipt.

The contract no longer exposes those as three independently committable worker
actions. This removes the crash window in which a completed receipt would be
durable while its non-reversible digest could not recover the provider result.
No new resolution table is required when the adapter preserves this atomic
boundary.

The durable recovery projection contains only data the current schema can
actually read: receipt stage plus durable outbox transition. It never invents
a `DeliveryResolution` from a digest. A partial `completed` stage fails closed;
only `state_observed` with a valid applied transition is done.

Additional invariants:

- provider observations are accepted only after the one-shot dispatch marker
  has advanced to recovered-accepted and while the outbox remains claimed;
- unknown remains a delayed reconciliation action and creates no finalization;
- a retry transition is invalid at the maximum attempt count;
- a persisted retry is replayed from durable state without recomputing current
  policy;
- plan fields are private and the resolution/transition pair is constructed
  only by the bounded reducer.

## Fresh direct verification

- the atomic-finalization RED failed because observations could only produce a
  standalone completed action and had no attempt snapshot;
- the durable-projection RED failed because completed/state-observed required a
  resolution that the receipt schema cannot recover;
- the terminal-retry RED proved that a durable retry at the attempt limit was
  initially accepted, then closed at snapshot validation;
- pinned Rust 1.94.1 focused tests passed 13/13;
- pinned Rust workspace all-target tests exited zero with 20 isolated
  PostgreSQL tests explicitly ignored;
- pinned workspace Clippy with `-D warnings`, formatting and documentation
  generation passed;
- Node 24.15.0 repository typecheck and `git diff --check` passed;
- the crate retains zero dependencies and no unsafe/native/runtime surface.

No remote host, running service, database process, Docker, load test or
performance campaign was used or changed. The historical dirty G03 evidence
README remained untouched by this slice and unstaged.

## Remaining gates (`not_run`)

- the same-transaction PostgreSQL receipt-plus-transition adapter and exact
  commit-unknown query/reconcile API;
- physical atomicity, rollback, cancellation, crash/restart, stale owner,
  duplicate/reorder, lease expiry and two-node tests;
- provider idempotency/query contracts, NATS/JetStream and a bounded runner;
- TypeScript/provider golden corpora for each concrete migrated worker;
- runtime process/health/readiness, shadow, cutover, drain, active-zero and
  legacy deletion;
- independent review, PostgreSQL 16, rolling/fleet/fault/capacity/performance
  and production qualification.
