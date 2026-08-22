# RM01 R1 — PostgreSQL outbox finalization adapter evidence

Status: `implemented_offline_default_disabled`. This slice connects the pure
outbox finalization plan to existing PostgreSQL receipt, writer-fence and
outbox-transition capabilities. No worker process, provider transport,
background task, queue, route or production writer is activated.

## Durable boundary

`OutboxDeliveryFinalizationCommand` binds one reducer-produced plan to:

1. one exact `completed` receipt;
2. one exact complete, retry or dead-letter transition command;
3. one exact `state_observed` receipt;
4. the durable claim's attempt count and maximum attempts.

The two receipt identities and digests must differ, their tenant/effect/event/
correlation/generation/writer/owner lineage must match, and the transition
kind, error code and retry delay must match the private plan. The adapter then
locks the effect followed by the transition and performs all three mutations
inside one bounded tenant transaction. It reuses existing database writer
fences and functions; no schema or migration was added.

Before mutation, the adapter reads one locked snapshot and accepts only the
exact durable pre-state: one matching `accepted` receipt, an unapplied exact
transition and the matching claimed outbox revision/counts. Exact final state
replays only after the current writer fence passes. Partial receipt history,
changed identity/digest, a conflicting transition or a mismatched outbox is a
closed conflict.

`reconcile_outbox_delivery_finalization` is a separate read-only durable-state
query for an unknown commit. It never repeats the provider effect and reports
only `Applied`, `NotApplied` or `Conflict`. The adapter-specific commit-unknown
and cancellation fault injection remain `not_run`; only the exact reconcile
state shapes are implemented and tested here.

## Physical functional evidence

The repository's disposable PostgreSQL harness was run three times after the new
scenario was added. It used PostgreSQL 14.18, Node 24.15.0 for the event-role
prerequisite, a temporary local data directory and a non-bypass event runtime
role. The harness stops and removes its temporary cluster on exit; it does not
use Docker or a remote host.

The final run passed and directly proved:

- an invalid delivery lease fails during the second mutation and rolls the
  preceding `completed` insert back, leaving one accepted receipt and zero
  matching transition rows;
- reconcile before a valid apply returns `NotApplied`;
- the valid transaction commits exactly accepted/completed/state-observed plus
  one transition and marks the outbox delivered;
- exact repeat apply returns `Replay` without new rows;
- exact reconcile after commit returns `Applied`;
- different receipt identities/digests against the same transition return
  `Conflict` and leave row counts unchanged.

The first run failed only the pre-existing terminal aggregate assertion because
the independent scenario increased the expected transition total from four to
five. That fixture was corrected, and the physical flow was rerun from a fresh
temporary cluster.

## Scope and dependency review

- `converact-postgres-store` adds only the existing internal
  `converact-outbox-worker` path dependency;
- the lockfile resolved no new package;
- the adapter adds no unsafe/native code, transport, database table, runtime
  route, task, queue or provider dependency;
- work remains bounded by the existing pool, waiter, statement, lock,
  transaction and rollback deadlines;
- database locking is tenant/effect then tenant/transition, never a global
  in-process lock or scan;
- existing TypeScript runtime behavior remains the only active worker path.

No remote host, pre-existing product service, container, Docker daemon, load
test or performance campaign was used or changed. The pre-existing dirty G03
evidence README remained untouched by this slice and unstaged.

## Remaining gates (`not_run`)

- independent exact-tree review;
- adapter-specific commit-unknown, statement cancellation, process crash and
  two-node interleaving injection;
- composed retry and dead-letter physical adapter cases;
- provider idempotency/query contracts, NATS/JetStream and bounded worker
  runtime;
- TypeScript/provider golden corpora for each concrete migrated worker;
- runtime process health/readiness, shadow, route commit, drain, active-zero
  and legacy writer/source deletion;
- PostgreSQL 16, rolling/fleet/fault/capacity/performance and production
  qualification.
