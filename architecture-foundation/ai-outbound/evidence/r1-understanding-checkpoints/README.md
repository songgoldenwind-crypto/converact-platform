# AI outbound R1 Conversation Understanding checkpoint evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `61e969a2`.
- Checkpoint payload version: `1`.

## Proven

- An Intent checkpoint binds the complete validated observation to its resulting monotonic
  `IntentState`, including candidates, Slots, transcript evidence, catalog, source/provider
  revision, status, confirmed/previous Intent, turn, clock and evidence hash.
- A fused Emotion checkpoint binds contributor hashes and fused candidates to the resulting
  `EmotionState`, including confirmed intensity, distress score/trend and consecutive distress
  turns. Raw acoustic/text observations remain record-only evidence and cannot become a head.
- Both checkpoint decoders reject unknown fields/versions and revalidate typed IDs, exact catalog
  and Agent Release, complete Envelope authority, candidate bounds, evidence hashes, record kind,
  record ID, turn and clock.
- Intent and Emotion canonical evidence hashes now include schema version and Campaign/Contact
  authority in addition to Attempt, Call, Agent Release, session and execution generation.
- The latest Intent or Emotion head can restore its current state from one joined immutable record;
  no ordered conversation-history scan is required.
- `Debug` output remains redacted: Intent labels, Slot values and Emotion labels are not emitted.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-core
15 passed

cargo test --locked -p converact-conversation-understanding-store
19 passed

cargo clippy --locked -p converact-conversation-understanding-core \
  -p converact-conversation-understanding-store --lib --tests -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- Customer State and Dialogue Recommendation checkpoint codecs: `not_run`;
- Worker append/head orchestration, restart recovery and writer switch: `not_run`;
- execution against a physical PostgreSQL instance, RLS, trigger and concurrent transaction
  behavior: `not_run`;
- real classifier/LLM/acoustic providers, calibration, Active Call audio, SIP/PSTN, deployment,
  performance and production: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
