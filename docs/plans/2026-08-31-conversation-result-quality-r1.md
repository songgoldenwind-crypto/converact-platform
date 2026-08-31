# Conversation Result & Quality R1 implementation plan

> Status: `controlled_rust_slices_passed / physical_and_migration_gates_not_run`

**Goal:** Complete D7 as a Rust-owned, asynchronous and tenant-safe transcript/result/evaluation
vertical slice without coupling post-call processing to established communication.

## TDD slices

### Slice 1 — contracts and pure Core

Status: `passed_local_contract` at commit `2a769272`; 4 focused tests passed.

1. Add failing tests for bounded transcript segments, stable IDs, sequence/generation evidence and
   payload mismatch.
2. Add failing tests for schema-bound result revision, integer confidence and exact replay hashes.
3. Add failing tests for rubric dimension completeness, fixed-point weighted score, mandatory
   violations and deterministic Bad Case derivation.
4. Implement `conversation-result-core` and required shared IDs; run only scoped tests/Clippy/format.

### Slice 2 — durable Store

Status: `passed_local_contract` through commits `61869150`, `03ebd686` and `5ee32700`;
physical PostgreSQL remains `not_run`.

1. Add failing schema tests for tenant composite keys, RLS, immutable payloads/receipts, unique
   segment source/sequence and bounded reconcile claim.
2. Add additive PostgreSQL migration and SQLite development mirror.
3. Implement command prepare/finalize/query with revision/generation fences and exact payload hash.
4. Add the tenant-transaction Adapter in `converact-postgres-store`; physical PostgreSQL remains
   `not_run` unless an isolated database is explicitly available.

### Slice 3 — Worker projection

Status: `passed_controlled_test_double` at commit `1639dc1c`; real Providers and call ingestion
remain `not_run`.

1. Add a failing controlled test for final segment duplicate/out-of-order/stale generation.
2. Freeze a transcript snapshot only from explicit terminal observations.
3. Prepare/query/finalize result and evaluation effects; provider unknown never repeats mutation.
4. Prove evaluation/backlog failures do not call Telephony, terminate a Call or alter Handoff owner.

### Slice 4 — Rust API and compatibility

Status: Rust tenant-bound API and PostgreSQL query adapter passed at commit `e488544b`. Production
router/auth-policy binding and legacy TypeScript shadow parity/writer migration remain `not_run`.

1. Add tenant-bound detail and bounded cursor-list tests.
2. Return transcript text only from authorized detail endpoints; list responses expose metadata.
3. Keep legacy TypeScript reads compatible through mapping; do not switch or delete the old writer
   until selected-tenant shadow parity and active-zero are separately proven.

### Slice 5 — evidence

Status: local evidence recorded under
`architecture-foundation/ai-outbound/evidence/r1-conversation-result-quality/`; every physical,
provider, migration, UI, performance and production item remains explicitly `not_run`.

1. Record exact commit/tree/toolchain and scoped command results.
2. Keep all real Provider, database, call, UI, performance and production items `not_run`.
3. Update navigation and manifest hashes in a separate docs commit.
