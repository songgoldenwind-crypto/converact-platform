# RM01 R1 — Authority migration routing and PostgreSQL fence evidence

Status: `implemented_offline`, not production eligible.

This checkpoint implements the exact tenant/Authority/partition migration
route, a bounded pure Rust state machine, an atomic PostgreSQL adapter,
database-enforced generation transitions, immutable operation receipts,
database-clock leases and the same-statement object writer fence.

The migration executor is a separate `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`
capability role. It is never granted to `opc_runtime`. Ordinary runtimes
cannot select generation rows or their lease digest. Writer, renewal and work
claim functions accept the owning process's raw 256-bit token and hash it
inside PostgreSQL; the raw token is never persisted. Runtime cannot update
route, generation, claim or receipt tables.

Directly verified on 2026-08-14:

- complete root migration plan through
  `117_converact_authority_migration_routes` on an isolated local PostgreSQL
  14.18 cluster;
- SQL lifecycle fixture: shadow, prepare, commit, drain, active-zero, retire,
  stale new-work rejection, draining existing-work acceptance, current writer
  continuity after migration metadata retirement, lease renewal and immutable
  receipt;
- Rust `PostgresRouteStore`: prepare, exact receipt replay, conflicting hash
  and capability-binding rejection, commit, drain, nonzero claim rejection,
  crash claim reconciliation, active-zero, retire, query and exact-command
  reconcile using a non-superuser login that inherits only the scoped
  `opc_migration_executor` and `opc_runtime` capabilities required by those
  two test paths (never `opc_admin` or a bypass role);
- expired leases cannot be renewed, but the same fenced prepare path accepts
  a strictly higher owner epoch so a dead current writer cannot block recovery;
- raw lease capabilities are redacted in direct `Debug` output and inside the
  derived `Debug` output of generation records and writer claims;
- active-zero requires a sealed idempotent claim ledger, zero derived counters
  and no active durable-object or nonterminal-effect claims;
- concurrent claim/release transactions acquire the exact route row and then
  the exact generation row before fencing and changing O(1) counters; the
  two-client PostgreSQL test completes without a lock-upgrade deadlock;
- released claim tombstones retain at least seven days of idempotency
  protection and can only be removed after both expiry and generation
  retirement by an exact tenant/Authority/partition/generation, index-ordered,
  `SKIP LOCKED` purge capped at 256 rows per call; null/zero/oversize bounds
  fail closed and neither mutation nor candidate discovery performs a global
  aggregate/cross-generation scan;
- the bounded generation ledger independently reports every draining or
  active-zero predecessor through fixed 64-row generation-cursor pages, so a
  later migration cannot orphan an older predecessor when the route's latest
  handoff pointer advances; physical tests retire generation 1 while generation
  2 remains draining and enumerate 66 mixed active-zero/draining predecessors
  across two pages; PostgreSQL `EXPLAIN` confirms the matching partial index
  with no sort on the candidate path;
- static migration, delivery bundle, source graph, existing readiness and
  focused Rust suites.

Five successive read-only blocking reviews closed every reported issue. The
final review independently recomputed the 25-file source manifest, reran the
two core crates and reported `0 Critical / 0 Important`.

The PostgreSQL clusters and databases were created under validated `mktemp`
paths, never used Docker, never contacted a running server and were removed at
the end of each command. Server/AZ/fleet validation, migration of a real
Authority, load/performance validation and production eligibility remain
`not_run`.

The route store deliberately owns no connection pool or background task. A
Cell binary supplies a bounded pooled client and independent TLS policy. An
unknown commit outcome is reconciled by exact operation id and request hash;
the adapter contains no mutating retry loop.
