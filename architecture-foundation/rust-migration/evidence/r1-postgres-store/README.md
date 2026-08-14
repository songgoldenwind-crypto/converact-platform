# RM01 R1 — bounded PostgreSQL Store foundation evidence

Status: `implemented_offline`, not production eligible.

This slice adds the shared Rust PostgreSQL pool and tenant-transaction kernel.
It does not expose a domain Store, route traffic, change a running server or
claim production PostgreSQL composition. The first Event/Outbox/Idempotency
adapters will consume this private kernel in the next R1 slice.

## Frozen current contract

- `postgres-tenant-transaction-v1.json` is bound to the exact active
  TypeScript `withPgTenant` and `withPgTransaction` source hashes at commit
  `3114ea8ca6ab473d7eea44fc69a0da83108b6a11`.
- The current TypeScript replay proves one transaction, transaction-local
  `app.current_tenant`, one commit after success, one rollback after work
  failure, connection release and rejection of an empty tenant.
- Rust preserves those shared semantics and adds bounded pool admission,
  monotonic transaction, statement, lock and rollback deadlines, stable
  redacted errors and explicit unknown outcomes. There is no automatic retry.

## Authority and security boundary

- Raw `deadpool_postgres::Transaction` never appears in a public interface.
  The runner is a private method inside the private `tenant_transaction` deep
  module; its compile-fail contract proves an external caller cannot obtain or
  commit it. Future public persistence APIs must be domain-specific Stores and
  vendor-free domain ports.
- A non-superuser, non-`BYPASSRLS` runtime role was physically tested with
  forced RLS. Tenant A and Tenant B reads remained isolated and a cross-tenant
  insert failed.
- PostgreSQL custom GUCs are not an independent identity authority: trusted
  adapter source selects the verified `TenantId`. Keeping the raw transaction
  in the private adapter kernel is therefore a security boundary, and every
  future domain Store remains subject to source and RLS review.
- The search path is transaction-local and fixed to
  `pg_catalog, public, pg_temp`. Database, topology, tenant and work values are
  absent from stable error and Debug output.

## Cancellation, uncertainty and boundedness

- At most `max_connections + max_waiters` operations can enter the pool path;
  excess work fails immediately. Pool wait, connect and recycle deadlines are
  explicit, and all limits fail closed before pool construction.
- Every checked-out connection starts in discard-on-drop state. Only a known
  successful commit or rollback returns it to the Clean recycler. BEGIN,
  rollback or commit uncertainty, plus external task cancellation during work
  or commit, physically closes that connection.
- A cancelled pool waiter releases its admission permit. Clean recycle resets
  session GUCs before a known-good connection is reused.
- Commit cancellation is explicitly an unknown effect: the physical test
  accepts only the reconciled zero-or-one result for its unique operation and
  proves the uncertain connection is not reused. The future domain caller must
  use its durable idempotency key and query/reconcile; blind retry is forbidden.
- Pool admission and status are O(1); transaction bootstrap uses a fixed
  number of queries. There is no global scan, unbounded queue, retry fan-out or
  task-per-query design.

## Direct verification

The current exact source passed four ordinary crate tests, one compile-fail
doctest, focused Clippy with warnings denied and formatting. Twelve tests then
passed against an isolated temporary PostgreSQL 14.18 cluster over a local
Unix socket: RLS, normal rollback, monotonic and database deadlines, bounded
wait/admission, cancelled waiter, external work and commit cancellation,
commit error, rollback failure, connection replacement and Clean session
reset. Each cluster was stopped and deleted at the end of its run.

The full Rust workspace passed 76 tests with 18 physical tests explicitly
ignored in the ordinary run; workspace Clippy and formatting passed. The
affected TypeScript corpus and tenant suite passed 19 tests, and repository
TypeScript typecheck passed.

No Docker, network service, running server, remote host, load test or
performance campaign was used. Production TLS/CA/hostname and secret
composition, deployment wiring, real fleet cancellation, failover, rolling
schema, server validation, capacity and production eligibility remain
`not_run`.
