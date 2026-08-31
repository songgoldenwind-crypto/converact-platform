# AI outbound R1 Conversation Understanding Store schema evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `5b14cfaa`.
- Additive PostgreSQL migration: `133_converact_conversation_understanding.sql`.

## Proven

- Immutable records cover Intent observation, Emotion observation/fusion, Customer State snapshot
  and Dialogue recommendation without changing any existing writer.
- Every record binds tenant, Interaction, Attempt, optional Call/Agent session, Agent Release,
  execution generation, turn/time, retention policy, bounded object payload and lowercase canonical
  hash.
- The latest head is partitioned by tenant/Interaction/Attempt/generation/domain. Its composite
  foreign key must resolve to the exact immutable record identity, kind, turn, time and hash.
- A database trigger permits only consecutive head revision, non-decreasing turn/time and unchanged
  authority key. Immutable records cannot be updated.
- Recovery indexes begin with tenant, Attempt, generation and domain; no global scan is required to
  find the current record or bounded history.
- RLS is enabled and forced on both tables. Runtime receives no table-level DELETE permission.
- Expired evidence can be removed only through a tenant-bound security-definer function whose
  cutoff cannot be in the future and whose batch is bounded to 1–1000 locked records.
- The SQLite development schema mirrors the two authority tables and closed record/domain values.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-store --test schema
3 passed

git diff --check
passed
```

No broad regression suite was run for this schema-only slice.

## Explicitly not proved

- PostgreSQL migration execution, RLS behavior, triggers or retention function: `not_run`;
- Rust SQL Adapter, atomic record/head append, replay/conflict/fence behavior: `not_run`;
- durable restore/replay, Worker integration and writer switch: `not_run`;
- real Active Call/providers/audio/SIP/PSTN, server deployment, performance and production:
  `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
