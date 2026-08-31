# AI outbound R1 Customer State and Dialogue Policy evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `d980d85b`.

## Proven

- An immutable Rust `CustomerStateSnapshot` combines Intent and Emotion projections only when their
  tenant, Interaction, Attempt, Call, Agent Release, Agent session and execution generation match.
- Snapshot time cannot precede either source projection. Its canonical hash binds both Catalog
  revisions, statuses, customer classifications, last turns and source evidence hashes.
- Snapshot `Debug` output redacts customer Intent and Emotion labels. No transcript or audio payload
  is copied into Customer State.
- `DialoguePolicy` is bound to an exact Agent Release and versioned policy ID. Zero/inverted
  thresholds and cross-Release evaluation fail closed.
- The deterministic policy can recommend discovery, workflow continuation, intent clarification,
  emotion acknowledgement, acknowledgement before clarification or a proposed human handoff.
- A handoff is proposed only after the configured number of confirmed distress turns and a
  worsening trend. The returned type has no Handoff, Tool, DNC, telephony or business mutation
  capability; a real action must pass through the existing domain authority.
- Each recommendation binds the exact Customer State hash, Policy revision, authority generation,
  kind and evaluation time into a canonical hash.

## Fresh focused verification

```text
cargo test --locked -p converact-conversation-understanding-core
15 passed

cargo test --locked -p converact-voice-agent-contracts
6 passed

cargo clippy --locked -p converact-conversation-understanding-core \
  -p converact-voice-agent-contracts --lib --tests -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- durable Customer State or recommendation Store and restart/multi-node reconciliation: `not_run`;
- Worker, Active Call Prompt/Scene or realtime Provider integration: `not_run`;
- real Handoff proposal bridge, Tool execution, DNC or telephony action: `not_run`;
- policy calibration, product configuration/UI and quality evaluation: `not_run`;
- real audio/ASR, SIP/PSTN, media, server deployment, performance and production: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
