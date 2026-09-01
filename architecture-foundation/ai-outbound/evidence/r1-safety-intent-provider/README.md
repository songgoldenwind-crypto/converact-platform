# AI outbound R1 Safety Intent Provider evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `434ecd2138fa88abb8b02adc033f9ec1ee927255`.
- Branch: `codex/converact-platform-rename`.

## Proven

- A concrete Rust `SafetyIntentProvider` consumes only an already validated immutable final
  `TranscriptSegment`; AI, human and system speaker segments are ignored.
- Every rule set is bound to one exact Agent Release and Intent Catalog revision. Rule targets must
  be catalog members explicitly marked safety-critical.
- Exact and phrase matching are explicit Release choices. Priorities and normalized phrases are
  unique, so an input cannot depend on map order or configuration insertion order.
- Rule, phrase-count, phrase-length, confidence and identifier bounds fail closed. Matching uses no
  tenant regex and normalizes the transcript once; the remaining scan is bounded by at most 64
  rules and 128 total phrases.
- The Provider revision is the canonical content hash of the normalized complete rule set. The
  observation ID is replay-stable over Provider revision, transcript payload hash and turn.
- A match creates a Core-validated `SafetyRule` observation referencing the exact transcript
  segment ID, advances the prior same-authority Intent state through the Release policy and closes
  an `IntentCheckpoint`.
- Provider and observation diagnostics omit configured phrases, transcript text, candidate labels
  and Slot values.
- The Provider type has no Tool, DNC, Handoff, Telephony or Media port. A confirmed safety intent is
  evidence only and cannot execute an external or call-side effect.

## Fresh focused verification

```text
cargo test --locked -p converact-voice-agent-worker --test safety_intent_provider
3 passed, 0 failed

cargo test --locked -p converact-conversation-understanding-core --test intent_state
5 passed, 0 failed

rustfmt --edition 2024 --check <4 changed Rust files>
passed

cargo clippy --locked -p converact-conversation-understanding-core \
  -p converact-voice-agent-worker --lib --test safety_intent_provider -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- Active Call SSE ingestion, gap recovery and durable transcript/turn sequence allocation:
  `not_run`;
- physical transcript Store or PostgreSQL transaction: `not_run`;
- real tenant Rule artifact resolution, phrase coverage and false-positive calibration: `not_run`;
- Fast Classifier, Contextual LLM and cross-Provider fusion: `not_run`;
- Emotion Provider and complete Intent/Emotion/Customer State/Dialogue turn commit: `not_run`;
- DNC, Handoff, Tool, Workflow or Prompt/Scene action wiring: `not_run`;
- real Active Call/RustPBX/SIP/PSTN/media/recording interaction: `not_run`;
- accuracy, recall, performance, capacity, long-run and production deployment: `not_run`;
- independent code review: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
