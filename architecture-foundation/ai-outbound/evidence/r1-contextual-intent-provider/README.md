# AI outbound R1 Contextual Intent Provider evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `948c08b0cc15dc9d09adcb2edc12df31ac643192`.
- Branch: `codex/converact-platform-rename`.

## Proven

- Rust `ContextualIntentClassifierProvider` consumes one bounded, durable-sequence-ordered final
  transcript window whose current segment is customer speech.
- Every segment must share tenant, Interaction, Campaign, Contact, Attempt, Call, Agent Release,
  Channel Agent session and execution generation. Trace/span identity may differ. System segments,
  reordered sequences and cross-authority history are rejected before inference.
- The immutable artifact binds exact model profile, prompt template, label map, structured output
  schema and confidence calibration SHA-256 identities to one Agent Release and Intent Catalog.
  Languages, segment count, total text bytes, top-k, Slots and deadline all have hard bounds.
- The model port receives only artifact revision and bounded speaker/language/text turns plus output
  limits. Tenant, campaign, call and telephone identifiers are not exposed through the request.
- The serving adapter must echo the artifact revision. Drift, timeout, adapter failure, invalid
  labels/order/scores, candidate overflow and forbidden Slots fail closed through the shared Core.
- The resulting `ContextualLlm` observation references every ordered transcript segment and uses a
  stable identity over artifact revision, evidence payload hashes and turn.
- The Confidence Router accepts the prior history only when the final evidence ID remains the exact
  Fast current-turn anchor. State still advances once from the original previous state.
- Provider/request/output diagnostics omit transcript, candidate and Slot content. The Provider
  owns no Tool, DNC, Handoff, Telephony or Media port.

## Fresh focused verification

```text
cargo test --locked -p converact-voice-agent-worker --test contextual_intent_provider
4 passed, 0 failed

cargo test --locked -p converact-voice-agent-worker --test intent_confidence_router
4 passed, 0 failed

rustfmt --edition 2024 --check <5 changed Rust files>
passed

cargo clippy --locked -p converact-voice-agent-worker \
  --lib --test contextual_intent_provider --test intent_confidence_router -- -D warnings
passed

python3 -m json.tool \
  architecture-foundation/ai-outbound/evidence/r1-contextual-intent-provider/verification.json
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- a real LLM/provider-pool HTTP or native adapter and rendered prompt artifact: `not_run`;
- real Intent/Slot accuracy, calibration, fallback rate, latency or provider failover: `not_run`;
- durable raw contributor and resolution record schema/codec/transaction: `not_run`;
- transcript-to-Provider worker composition and complete four-domain turn commit: `not_run`;
- Active Call live SSE/gap recovery or physical PostgreSQL: `not_run`;
- real SIP/PSTN/media/recording, performance, capacity and long-run: `not_run`;
- independent review and production deployment: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
