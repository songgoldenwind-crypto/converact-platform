# AI outbound R1 transcript sequence authority evidence

Date: 2026-09-01

Evidence class: `local_contract`, `sqlite_development_mirror`

Production eligibility: `false`

## Source identity

- Converact parent commit: `133a8ed4fb220d1a20a9bc23a1202579d04a5b4c`.
- Branch: `codex/converact-platform-rename`.

## Proven

- Final transcript content can be validated as a redacted `TranscriptSegmentDraft` before a
  sequence transaction starts; only the Store can close it with a positive sequence.
- A PostgreSQL stream head is scoped by tenant, Interaction and execution generation and is bound
  to one Call Attempt and Agent Release.
- Existing stream heads are backfilled from stored maximum sequences without rejecting historical
  gaps. Mixed Attempt/Release authority fails migration validation.
- The runtime adapter owns one tenant transaction. It locks the stream head, checks stable
  source-event replay first and allocates `last_sequence + 1` only for a new event.
- The segment `AFTER INSERT` trigger advances the head by exactly one. Segment failure, conflict or
  transaction rollback therefore cannot commit an allocation gap.
- The caller-sequenced compatibility path uses the same stream head and rejects a new segment that
  is not the next position. The database trigger also protects rolling old writers.
- PostgreSQL RLS/forced RLS, least-privilege grants and immutable stream identity are present in the
  additive migration. The SQLite development mirror parses and its trigger accepts `1 -> 2` while
  rejecting `1 -> 3`.
- Draft and segment Debug output omit transcript text.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-result-core \
  --test transcript_draft --test result_quality
7 passed, 0 failed

cargo test --locked -p converact-conversation-result-store \
  --test schema --test postgres_contract
4 passed, 0 failed

cargo test --locked -p converact-postgres-store \
  --test conversation_result_store_contract
4 passed, 0 failed

sqlite3 :memory: ".read src/schema.sql" <focused 1 -> 2 transcript inserts/query>
last_sequence = 2

sqlite3 :memory: ".read src/schema.sql" <focused 1 -> 3 gap insert>
exit 19: transcript segment sequence is not the next stream sequence

rustfmt --edition 2024 --check <11 changed Rust files>
passed

cargo clippy --locked -p converact-conversation-result-core \
  -p converact-conversation-result-store -p converact-postgres-store \
  --lib --tests -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- physical PostgreSQL migration, trigger, transaction, RLS and concurrent-writer execution:
  `not_run`;
- Active Call SSE connection, stable final-event identity, gap detection and replay recovery:
  `not_run`;
- real tenant/Interaction/Attempt/Release resolution and worker process composition: `not_run`;
- crash/restart and two-node concurrent ingest: `not_run`;
- Fast Classifier, Contextual LLM, emotion Providers and complete four-domain turn commit:
  `not_run`;
- real RustPBX/SIP/PSTN/media/recording path: `not_run`;
- accuracy, performance, capacity, long-run and production deployment: `not_run`;
- independent code review: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
