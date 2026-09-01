# Contextual Intent Provider R1 implementation plan

> **Status:** `local_contract_passed / real_llm_not_run / production_not_run`

**Goal:** Add a bounded Rust Layer-2 Provider that turns exact multi-turn transcript evidence into
closed-Catalog Intent and Slot evidence for `PendingIntentTurn` resolution.

## Contract boundary

- The Provider is bound to one Agent Release, Intent Catalog, model profile, prompt template,
  label map, output schema and confidence calibration artifact.
- Input is a bounded, strictly ordered set of immutable transcript segments from one authority.
  The final segment is the current customer turn; prior AI/customer/human segments provide context.
- The model request exposes only artifact revision, speaker/language/text turns and output bounds.
  Call, tenant, campaign and telephone identifiers do not cross the inference port.
- Serving revision, response deadline, top-k, Slot count, closed labels and per-Intent Slot allow-list
  fail closed. Unknown remains an empty candidate set.
- Observation identity is stable over artifact, exact ordered evidence payloads and turn. Ordinary
  diagnostics omit transcript, candidate and Slot content.
- Contextual output is evidence only. It owns no Tool, DNC, Handoff, Telephony or Media port.

## Minimal TDD sequence

1. Prove an ordered multi-turn request produces one `ContextualLlm` observation with allowed Slots.
2. Prove mixed authority, reordered sequence, unsupported language and non-customer current input do
   not reach the model.
3. Prove served-artifact drift, invalid label/Slot/output and timeout fail closed.
4. Prove the Confidence Router accepts prior history only when the current transcript anchor is the
   same Fast evidence.
5. Run only Contextual/Router contracts, scoped formatting, scoped Clippy and diff checks.

## Completion boundary

This slice closes the provider-neutral LLM contract; its test port is not a real LLM. Provider-pool
HTTP/native inference, prompt rendering, durable contributor resolution, quality evaluation,
physical runtime and production remain `not_run`.
