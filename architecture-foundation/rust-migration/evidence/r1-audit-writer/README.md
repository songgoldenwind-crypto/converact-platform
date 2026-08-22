# RM01 R1 — writer-fenced Rust Audit Store evidence

Status: `implemented_offline_default_disabled`. This slice is not production
eligible and is not wired into an application route, worker, container or
running service. The TypeScript Audit service remains the only active Audit
Authority.

This slice adds the durable Rust append/query kernel for the fixed Authority
route `audit / tenant-chain / new / <tenant>`. It does not add dual-write, a
second chain or a second active writer.

## Database-owned chain and atomic append

- Migration 121 adds nullable route provenance and `append_position` to the
  existing Audit table. Legacy rows remain the exact all-NULL shape; target
  rows must carry the exact Audit route and one unsigned-64-bit position.
- `converact_audit_chain_heads` is the durable per-tenant head. PostgreSQL,
  rather than caller-provided `occurred_at`, owns append order. Out-of-order
  business timestamps therefore cannot fork the chain.
- A zero head is created only for a tenant with no Audit history. Existing
  legacy history without an offline-qualified anchor fails closed with
  `ChainUnqualified`.
- The head stores the event identifier and hash without a foreign key to a
  retention-managed event row. Migration 122 creates and validates a
  concurrent partial unique index on `(tenant_id, append_position)` for target
  rows.
- One target transaction takes the tenant Audit barrier, validates the exact
  generation/owner/lease fence, locks the head, inserts the event and advances
  the head. The final unsigned-64-bit position is usable; the following append
  fails closed as `ChainPositionExhausted`.
- Exact idempotency replay revalidates the persisted event and writer fence.
  Changed input conflicts. Commit-unknown has a separate exact query/reconcile
  method and is never blindly retried.

## Rolling writer and route fencing

- The only capability granted to `opc_runtime` is the narrow legacy-allowed
  helper. It checks the exact tenant GUC before any lock or read, takes the
  tenant Audit barrier, locks the route and generation, and requires the
  current TypeScript generation to be accepting work with an unexpired lease.
- The invoker-rights insert trigger gates every legacy all-NULL row. Direct,
  inherited and `SET ROLE opc_runtime` callers cannot supply target
  provenance. Cross-tenant helper calls fail before acquiring another
  tenant's barrier.
- Rust Audit route transitions take the same tenant barrier before the route
  row lock. A deterministic two-connection physical test proves that a route
  commit waits for an already admitted legacy insert and rejects every new
  legacy insert after commit.
- Once a target head exists, the old NULL-provenance writer remains fenced even
  if the generic route is later pointed back at TypeScript. This prevents a
  Rust-to-TypeScript-to-Rust chain fork. A formal reverse handoff requires a
  future head-aware writer and remains `not_run`.

## Least privilege and rolling safety

- All five migration functions and the trigger use collision-failing `CREATE`.
  The migration validates exact owner, invoker/definer mode, fixed
  `search_path`, function ACLs, head-table ACLs, RLS and absence of column
  grants.
- Runtime-role initializer replay preserves the exact legacy helper grant and
  revokes head-table and target-function access from `PUBLIC` and
  `opc_runtime`; it cannot reintroduce its earlier broad table grants.
- The Rust adapter calls only the Audit fence, head and append capabilities. It
  has no raw table insert, generic Authority writer function, route mutation,
  background task, in-process/global lock, queue or runtime caller. Its only
  serialization point is the bounded per-tenant PostgreSQL transaction barrier
  described above.
- Timestamps are sent as epoch milliseconds and read back through the shared
  canonical formatter. The physical Rust test includes exact year `+010000`
  round-trip rather than relying on PostgreSQL `to_char` year formatting.
- Errors expose stable value-free categories, not SQL, topology, tenant IDs,
  hashes or lease capabilities.

## Fresh direct verification

- Node 24.15.0 affected tests: 58 passed, 1 explicitly skipped physical test,
  0 failed. TypeScript typecheck passed.
- Pinned Rust 1.94.1 workspace all-target tests, doctests, strict Clippy and
  formatting passed. Ordinary all-targets retained 20 explicitly isolated
  PostgreSQL tests as ignored.
- A clean disposable local PostgreSQL 14.18 database migrated through 122.
  The TypeScript physical test passed 1/1 and covered expired leases,
  direct/inherited/`SET ROLE` callers, cross-tenant helper rejection, exact
  ACLs, initializer replay, unqualified history, route-transition ordering and
  reverse-handoff fail-closed behavior.
- The Rust physical test passed 1/1 and covered target insert, exact replay,
  changed-input conflict, stale writer, query/reconcile, out-of-order business
  timestamps and `+010000` timestamp round-trip.
- The existing Platform Event role fresh-install/through-119 upgrade physical
  regression passed 1/1 on two separately hardened disposable PostgreSQL
  14.18 clusters after the migration corpus was updated through 122.
- Independent exact-tree review found and drove closure of the chain-tail,
  lease, role-identity, ACL-collision, retention-FK, route-race,
  cross-tenant-helper, timestamp and reverse-handoff defects. Final evidence
  review is recorded separately.

Intermediate RED runs included missing-role harness setup, a duplicate test
hash, a pre-existing test role, a test-pool self-deadlock, a stale signature
assertion and raw PostgreSQL extended-year input. They were corrected and
rerun; none is counted as successful product evidence. One Clippy invocation
accidentally used the host Rust 1.87 toolchain, was treated as invalid evidence,
and was rerun with the pinned Rust 1.94.1 toolchain.

No remote host, server, running service, container, Docker daemon, load test or
performance campaign was used or changed.

## Remaining gates (`not_run`)

- dedicated Audit runtime/function-owner roles, pool identity and runtime route
  activation;
- HMAC key loading/custody/rotation, memory-clear policy and raw request/header
  byte limits at the future runtime boundary;
- offline qualification and anchor seeding for tenants with legacy Audit
  history;
- retention/checkpoint, list cursor, JSONL export and tenant-deletion behavior
  against the durable head/append-position model;
- the exact production storage timestamp domain, including the JavaScript
  time-clip range below PostgreSQL's minimum timestamp;
- shadow comparison, prepare/commit, new-work cutover, drain, reconcile,
  active-zero and deletion of the TypeScript writer/source/deployment;
- a head-aware formal reverse handoff to a non-Rust writer;
- production image, fleet, multi-node/AZ fault, capacity, performance and
  production qualification.
