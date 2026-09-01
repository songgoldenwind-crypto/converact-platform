# AI outbound R1 Conversation Understanding Store Adapter evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `c3a93f7e`.
- PostgreSQL schema migration: `133_converact_conversation_understanding.sql`.

## Proven

- A Rust record boundary accepts only bounded JSON objects whose supplied lowercase hash equals the
  canonical payload hash. Invalid retention clocks, malformed IDs, non-objects and oversized
  payloads fail closed; customer payloads are omitted from `Debug`.
- Complete Envelope authority can be persisted and restored: schema version, tenant, Interaction,
  Campaign/Contact, Attempt, optional Call/Agent session, Agent Release, generation and trace.
- Raw Emotion observations are durable evidence but cannot become the authoritative Emotion head;
  only fused Emotion evidence may advance it.
- Record-only append and record-plus-head append have explicit exact replay and record-ID conflict
  outcomes. A latest-head transition requires exact prior revision, record ID and payload hash.
- New heads start at revision one; later heads advance exactly once, reject backwards turn/time and
  never reuse the current record ID. A known older record is not promoted over a newer head.
- The SQL Adapter serializes only one tenant/Interaction/Attempt/generation/domain with a
  transaction-scoped advisory lock. It has no global process lock, task, history scan or offset.
- Record insert and Head insert/update use the caller's single transaction. SQL update predicates
  independently repeat every optimistic fence before the database trigger and composite foreign
  key apply.
- `load_current` uses the bounded latest-head key, joins exactly one immutable record, reconstructs
  validated typed IDs and rejects campaign/release/session authority drift or malformed stored rows.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-store
15 passed

cargo test --locked -p converact-conversation-understanding-core
15 passed

cargo test --locked -p converact-voice-agent-contracts
6 passed

cargo clippy --locked -p converact-conversation-understanding-store \
  -p converact-conversation-understanding-core \
  -p converact-voice-agent-contracts --lib --tests -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- execution against a physical PostgreSQL instance, RLS, trigger and concurrent transaction
  behavior: `not_run`;
- Core-to-record encoding, record-to-Core restoration and ordered history replay: `not_run`;
- Worker orchestration, restart recovery and writer switch: `not_run`;
- real Active Call/providers/audio/SIP/PSTN, server deployment, performance and production:
  `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
