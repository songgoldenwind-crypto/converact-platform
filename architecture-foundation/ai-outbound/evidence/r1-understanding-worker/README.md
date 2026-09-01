# AI outbound R1 Conversation Understanding Worker evidence

Date: 2026-09-01

Evidence class: `local_contract` + `controlled_test_double`

Production eligibility: `false`

## Source identity

- Converact parent commit: `5e65b8c39a9bcb7333bbe28c0eaebf7c9b251223`.
- Branch: `codex/converact-platform-rename`.

## Proven

- Voice Agent Worker depends on one narrow `UnderstandingDurabilityPort`; it does not receive a
  PostgreSQL pool, client, transaction or SQL string.
- One port call returns the current Intent, Emotion, Customer State and Dialogue heads from one
  consistent snapshot. All-empty is a valid initial state; partial, duplicate, cross-authority or
  corrupt head/record graphs fail closed.
- Recovery restores Intent first, Emotion second, recomputes Customer State from those exact source
  states, and recomputes Dialogue from the exact Release-owned Policy.
- A typed write validates all four objects against one authority, the exact source states, the exact
  Dialogue Policy and bounded retention inputs before creating SQL commands.
- Every domain append carries an absent-head or exact revision + record ID + payload-hash fence.
- The concrete PostgreSQL adapter reads all four domains with one bounded SQL statement inside one
  tenant transaction and commits the four-domain batch in fixed Intent -> Emotion -> Customer State
  -> Dialogue order.
- Whole-turn classification happens before commit. Advanced plus current replay is valid; any
  superseded head mixed with a write returns a stale-fence error so the caller transaction rolls
  back. All replay and no-write superseded results remain distinguishable.
- Stored head and record domain, authority, kind, identity, hash, turn and clock are revalidated at
  the adapter boundary.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-store
32 passed, 0 failed

cargo test --locked -p converact-voice-agent-worker \
  --test understanding_recovery --test postgres_understanding_port
5 passed, 0 failed

rustfmt --edition 2024 --check <14 changed Rust files>
passed

cargo clippy --locked -p converact-conversation-understanding-store \
  -p converact-postgres-store -p converact-voice-agent-worker \
  --lib --tests -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- physical PostgreSQL transaction, RLS and crash-boundary behavior: `not_run`;
- real Voice Agent Worker process composition and writer switch: `not_run`;
- restart and two-node recovery/reconciliation: `not_run`;
- real Rule/Fast Classifier/Contextual LLM/Acoustic/Text/Active Call Provider: `not_run`;
- Active Call per-turn event ingestion and Prompt/Scene consumption: `not_run`;
- real RustPBX, SIP/PSTN, RTP/SRTP, audio, recording or Campaign outcome: `not_run`;
- performance, capacity, long-run and fault campaign: `not_run`;
- independent code review and production deployment: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
