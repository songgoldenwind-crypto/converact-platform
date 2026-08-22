# RM01 R1 — Rust outbox recovery contract evidence

Status: `implemented_offline_default_disabled`. This slice is not production
eligible. It adds a pure Rust decision crate; it does not start a worker, claim
an outbox row, contact a provider, open a database/NATS connection or change an
Authority route. Existing TypeScript/runtime paths remain the only active
writers and workers.

## Frozen recovery order

The reducer requires one exact order for each claimed delivery attempt:

```text
persist accepted receipt
  -> deliver once in the accepting process
  -> persist definitive completed resolution
  -> apply exact outbox transition
  -> persist state-observed receipt
  -> done
```

- A newly persisted acceptance can yield `Deliver` once. An acceptance loaded
  after a crash yields only `QueryDelivery`; it can never yield blind delivery.
- An unknown provider result yields only a bounded delayed reconciliation
  action. It does not complete, retry or dead-letter the outbox row.
- Applied results complete the outbox. Definitive retryable non-application
  retries before the attempt limit and dead-letters at the limit. Definitive
  permanent non-application always dead-letters.
- A completed resolution must be durable before the outbox transition. The
  state-observed receipt follows only a matching durable transition.
- Impossible or mismatched receipt/outbox combinations fail closed as
  `Conflict`.
- A transition already persisted under an earlier valid retry policy remains
  valid after a configuration change. The current policy selects only a new
  transition; it cannot rewrite durable history.

## Bounds and dependency boundary

- attempt count is `1..=max_attempts`, and `max_attempts` is `1..=1000`;
- retry and reconcile delays are whole milliseconds and no more than 24 hours;
- reconcile delay is non-zero, preventing an unknown-outcome busy loop;
- provider failure codes exactly match the existing durable outbox grammar:
  lowercase first byte, then lowercase ASCII/digits/underscore, at most 255
  bytes;
- the crate has no dependency, async runtime, transport, storage client,
  native library, task or queue. Workspace `unsafe_code` remains forbidden.

The current generic effect receipt stores a digest but not a reversible result
document. This contract therefore requires a later adapter slice to add or
identify one versioned durable resolution document bound by that digest.
Adapters must query/reconcile when the document is unavailable; they may not
invent a resolution from the digest.

## Fresh direct verification

- the initial focused RED failed on the absent state-machine API;
- a recovery RED proved that recomputing an already-persisted retry with a new
  policy caused a false conflict and that sub-millisecond durable transitions
  were accepted; both are closed;
- a bounded-reconcile RED failed until unknown results carried a non-zero,
  policy-bounded delay;
- pinned Rust 1.94.1 focused tests passed 12/12;
- pinned workspace all-target tests exited zero; 20 isolated PostgreSQL tests
  retained their explicit ignore gates;
- pinned workspace Clippy with `-D warnings`, formatting and documentation
  generation passed;
- Node 24.15.0 repository typecheck and `git diff --check` passed;
- `cargo tree -p converact-outbox-worker --locked` contains only the workspace
  package and no dependency.

No remote host, running product service, local Docker, database process, load
test or performance campaign was used or changed. The historical dirty G03
evidence README remained untouched by this slice and unstaged.

## Remaining gates (`not_run`)

- a versioned durable delivery-resolution document and receipt-digest binding;
- a PostgreSQL adapter that joins exact receipt, outbox claim/transition and
  reconciliation state under tenant/route/owner fencing;
- atomic aggregate-plus-outbox behavior for this worker on a physical database;
- provider ports, provider idempotency/query contracts, NATS/JetStream delivery
  and a bounded runtime runner;
- cancellation, panic, lease expiry, stale owner, crash/restart,
  commit-unknown, duplicate/reorder and two-node physical fault injection;
- current TypeScript golden/differential behavior for each later concrete
  provider adapter;
- runtime process/health/readiness, shadow mode, new-work routing, old-worker
  drain, active-zero and legacy deletion;
- independent review, PostgreSQL 16, rolling upgrade, fleet, capacity,
  performance and production qualification.
