# AI outbound R1 Intent Confidence Router evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `4c2e062e0ba95f710c49d0f78798523eef586781`.
- Branch: `codex/converact-platform-rename`.

## Proven

- Rust `IntentConfidenceRouter` evaluates one validated final customer segment in a fixed
  Safety-first sequence. A Safety match closes the turn and never invokes Fast inference.
- When Safety misses, Fast output is previewed against the immutable previous state. Only
  `confirmed` or `changed` closes immediately; unknown, provisional and insufficient-margin output
  creates a pending resolution and does not mutate the authoritative state.
- A pending resolution owns the original state, exact Catalog, policy and Fast observation. A
  Contextual LLM observation must match Release, Catalog, complete authority, turn and the exact
  current transcript anchor, may add prior context evidence, and cannot predate Fast evidence.
- Contextual resolution advances from the original state exactly once. It does not first apply Fast
  and does not fabricate a second turn index to bypass stale-observation checks.
- Explicit fallback closes the original Fast observation when Layer 2 is unavailable, preserving
  Core `unknown/provisional/clarification_required` semantics.
- Resolution content-hashes the complete selected checkpoint, actual basis-point policy and
  normalized unique contributor hashes. Debug output omits transcripts, candidate labels and Slots.
- Router, pending and resolution types have no Tool, DNC, Handoff, Telephony or Media port.

## Fresh focused verification

```text
cargo test --locked -p converact-voice-agent-worker --test intent_confidence_router
4 passed, 0 failed

cargo test --locked -p converact-voice-agent-worker --test fast_intent_classifier
5 passed, 0 failed

cargo test --locked -p converact-voice-agent-worker --test safety_intent_provider
3 passed, 0 failed

rustfmt --edition 2024 --check <6 changed Rust files>
passed

cargo clippy --locked -p converact-conversation-understanding-core \
  -p converact-voice-agent-worker --lib --test intent_confidence_router -- -D warnings
passed

python3 -m json.tool \
  architecture-foundation/ai-outbound/evidence/r1-intent-confidence-router/verification.json
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- a real Contextual LLM provider, prompt/schema artifact and inference call: `not_run`;
- durable raw Intent contributor and resolution record schema/codec/transaction: `not_run`;
- real Fast classifier runtime, accuracy, calibration and fallback quality: `not_run`;
- transcript-to-Provider worker composition and complete four-domain turn commit: `not_run`;
- Active Call live SSE/gap recovery or physical PostgreSQL: `not_run`;
- real SIP/PSTN/media/recording, performance, capacity and long-run: `not_run`;
- independent review and production deployment: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
