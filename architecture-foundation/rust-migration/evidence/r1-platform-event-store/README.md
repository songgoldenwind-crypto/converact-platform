# RM01 R1 — writer-fenced Platform Event Store foundation evidence

Status: `implemented_offline_default_disabled`, not production eligible and not
wired into a running runtime.

This slice adds the Rust Platform Inbox, Effect receipt and Outbox persistence
boundary on top of the bounded PostgreSQL transaction kernel. It also adds the
rolling schema and exact immutable operation receipts required to reconcile an
unknown database commit without blind retry. It does not switch a TypeScript
writer, publish to NATS, change a server, run a load campaign or close R1.

## Authority and durability boundary

- Every target row binds one tenant, Authority route partition, route
  generation, owner epoch and object generation. Database time is authoritative
  for leases and retry eligibility.
- `converact_event_runtime` has read-only table access. Mutations cross five
  `SECURITY DEFINER` Platform Event functions; direct generation claim/release
  and raw target-table DML are denied.
- The database, not the Rust caller, derives the canonical nonterminal claim ID
  from `(effect_id, effect_generation)` or `outbox_id`. A caller cannot forge a
  different claim identity and corrupt active-zero truth.
- The rolling `opc_runtime` principal may continue writing legacy rows with NULL
  route provenance, but a trigger rejects inserting target provenance or
  modifying any target-provenance Inbox, Effect or Outbox row.
- Effect receipt stages and Outbox claim/transition receipts are immutable.
  Operation identity, route provenance, delivery capability digest, retry delay
  and revision are part of exact replay matching.

## Bounded lifecycle

- Claim batches, attempts, delivery leases and retry delays have fixed validated
  upper bounds. Claim selection uses indexed route predicates and
  `FOR UPDATE SKIP LOCKED`; no table-wide claim scan or task-per-row fan-out is
  introduced.
- A claim operation records an immutable operation row even when the result is
  empty. Ambiguous callers query the exact operation or transition receipt and
  receive `Applied`, `NotApplied` or `Conflict` instead of retrying blindly.
- Retry/reclaim retains old immutable claim receipts. Terminal delivery and
  dead-letter transitions release the exact canonical nonterminal claim once.
- Cross-generation Effect execution uses a distinct canonical claim per Effect
  generation. A completed generation does not suppress a later generation.
- Large target indexes are created concurrently outside the migration
  transaction and migration 119 validates exact definitions before acceptance.

## Direct verification

Focused Rust tests, formatting, Clippy with warnings denied, TypeScript
typecheck and 39 affected contract/packaging/migration tests passed. An isolated
temporary PostgreSQL 14.18 cluster migrated through 119 and passed the exact
physical lifecycle test, including tenant fencing, target and legacy role
permissions, cross-generation Effects, immutable claim replay, retry/reclaim,
concurrent duplicate transition convergence, stale-writer rejection and
terminal active-zero. The cluster was stopped and deleted after the run.

The repository-wide PostgreSQL shell verifier is not reported as green: its
unrelated legacy Voice HTTP fixture lacks the now-required explicit
`CONVERACT_AUTH_DISABLED=1`, and after supplying that test-only flag the later
SIP Effect fixture fails cleanup of a tenant still referenced by
`ivekit_sip_effect_session_fences`. Neither failure executes or contradicts this
Platform Event Store slice. They remain recorded as failures, not silently
converted to passes.

No Docker, remote host, running service, load test or performance campaign was
used.

## R1 gates still `not_run`

- production role bootstrap, dedicated least-privilege function owner,
  connection-pool wiring and exact role membership proof;
- expired route-owner adoption into a newly prepared and committed generation;
- aggregate mutation plus Outbox enqueue through one domain transaction;
- NATS/JetStream delivery worker and crash/restart recovery;
- new-work cutover, legacy stop-write, drain, reconcile and active-zero;
- removal or bounded sharding of the generation-level nonterminal counter
  serialization point;
- production-scale rolling index recovery, fleet validation, capacity,
  performance and production eligibility.
