# AI outbound R1 durable Attempt runtime evidence

Date: 2026-09-01

Scope: local Rust domain/store/runtime contracts plus additive schema inspection

Production eligibility: `false`

## Source identity

- Converact parent commit: `b1a424402462ae1d5059cc5ff851e3bb8b078c4a`.

## Proven

- `CallAttempt` restores a complete durable snapshot without replaying `Claim`; zero revisions,
  impossible disclosure/state combinations and self-linked retry lineage fail closed.
- The orchestrator accepts only a database-preclaimed Attempt. It no longer performs a second
  in-memory claim or a duplicate same-revision reconcile write.
- External effect intents are canonical, deterministic and appended before reserve, dial, attach,
  disclosure and conversation-start mutations.
- Every load, immutable dial-snapshot read, effect-intent append and state advance is fenced by
  tenant, physical Attempt ID, revision where applicable, execution generation, lease owner,
  redacted token hash and the PostgreSQL clock's unexpired lease.
- `disclosure_completed` is durable. Rolling legacy rows in states that can only follow disclosure
  are derived as disclosed until their next fenced write materializes the field.
- `PostgresAiOutboundAttemptStore` atomically claims a bounded batch and creates one
  `PostgresLeasedAttemptStore` per physical Attempt; that adapter implements the Core
  `AttemptStorePort` without exposing raw PostgreSQL transactions.
- PostgreSQL commit/rollback uncertainty on mutations becomes `OutcomeUnknown`; deterministic
  stale authority is rejected and ordinary dependency failures remain unavailable.
- Lease token hashes are omitted from the new command/lease debug surfaces.
- Migration `132` is additive and `NOT VALID`; the SQLite development schema enforces the same
  disclosure/state relation for new databases.

## Fresh focused verification

Rust 1.94.1 and the workspace lockfile produced:

```text
cargo test --locked -p converact-ai-outbound-core
42 passed

cargo test --locked -p converact-ai-outbound-store
19 passed; 3 physical PostgreSQL tests ignored

cargo test --locked -p converact-postgres-store --test ai_outbound_attempt_store
3 passed

cargo test --locked -p converact-postgres-store ai_outbound
2 passed

cargo test --locked -p converact-voice-agent-worker --test tracer_bullet
5 passed

cargo clippy --locked -p converact-ai-outbound-core -p converact-ai-outbound-store \
  -p converact-postgres-store --lib --tests -- -D warnings
passed

sqlite3 :memory: < src/schema.sql
passed

git diff --check
passed
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- physical PostgreSQL migration/application, RLS, lease contention, restart and commit-unknown
  fault injection: `not_run`;
- lease renewal and recovery claim for a process that dies after leaving `claimed`: `not_run`;
- waiting for a real long-lived Active Call to terminate; the current tracer-bullet terminal
  observation is controlled and immediate: `not_run`;
- atomic final Attempt completion together with the post-call job in a concrete PostgreSQL
  repository: `not_run`;
- real Active Call/RustPBX/SIP/PSTN/media, server deployment, production, performance, capacity and
  long-run qualification: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work remains outside this evidence and must not be
staged with the checkpoint.
