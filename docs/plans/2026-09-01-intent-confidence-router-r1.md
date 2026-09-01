# Intent Confidence Router R1 implementation plan

> **Status:** `local_contract_passed / durable_resolution_not_run / production_not_run`

**Goal:** Ensure Safety, Fast Classifier and future Contextual LLM evidence for one customer turn
advance the authoritative Intent state exactly once.

## Decision boundary

- Safety rules execute first. A match is selected as evidence and the Fast Classifier is not
  invoked; no lower layer can silently override a safety signal.
- If Safety misses, Fast Classifier runs. A confirmed/changed result closes the turn immediately.
- Unknown, provisional or low-margin Fast output creates a bounded pending resolution. It does not
  mutate or durably advance Intent state before the Contextual LLM result arrives.
- A Contextual LLM observation must use the same Release, Catalog, authority, turn and transcript
  evidence. Resolution advances from the original previous state, not from the Fast preview.
- If Layer 2 is unavailable, an explicit fallback closes the original Fast result so the call can
  clarify or remain unknown without a second same-turn state transition.
- A resolution content-hashes the selected observation plus all unique contributors. Diagnostics
  expose counts and hashes, never transcript, candidate or Slot content.
- The router owns no Tool, DNC, Handoff, Telephony or Media port.

## Minimal TDD sequence

1. Prove Safety short-circuits Fast inference and advances once.
2. Prove confirmed Fast output closes directly.
3. Prove ambiguous Fast output remains pending until a same-turn Contextual observation resolves
   from the original state with both contributors.
4. Prove fallback and mismatched Contextual evidence fail closed without a duplicate transition.
5. Run only router/provider contracts, scoped formatting, scoped Clippy and diff checks.

## Completion boundary

This slice fixes in-memory orchestration and same-turn state semantics. Contextual model inference,
durable raw contributor records/resolution schema, complete four-domain commit, real Active Call
runtime, quality and production deployment remain `not_run`.
