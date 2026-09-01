# Fast Intent Classifier Provider R1 implementation plan

> **Status:** `local_contract_passed / real_model_runtime_not_run / production_not_run`

**Goal:** Add the honest Rust Layer-1 boundary between one immutable final customer transcript and
one Release/Catalog-bound fast intent classifier, without disguising phrase rules or the existing
Active Call dialogue LLM as a semantic classifier.

## Contract boundary

- An immutable classifier artifact is bound to one exact Agent Release and Intent Catalog.
- Model, tokenizer, label-map and confidence-calibration artifacts are each identified by a
  lowercase SHA-256 digest. Supported languages, input bytes, top-k and inference deadline are
  bounded Release inputs.
- The inference port receives only the minimum semantic input: artifact revision, language,
  transcript text and top-k limit. Tenant, campaign, telephone and call identifiers do not cross
  this model boundary.
- The serving adapter must echo the exact artifact revision. Drift fails closed.
- Layer 1 may return an empty candidate list for out-of-scope/unknown. It does not extract Slots;
  Slot extraction and contextual interpretation remain a separate Layer-2 concern.
- Candidate labels, ordering and calibrated basis-point scores are validated by the shared Intent
  Core against the closed Catalog. No candidate can authorize a Tool, call, DNC or handoff action.
- Observation identity is stable over classifier artifact, transcript payload and turn. Changed
  inference for the same source therefore collides as content drift instead of becoming duplicate
  evidence.
- Provider diagnostics omit transcript text and candidate labels.

## Minimal TDD sequence

1. Prove high-confidence top-k output closes a `FastClassifier` checkpoint.
2. Prove low margin routes to `clarification_required` and empty output remains `unknown`.
3. Prove artifact, served-revision, Catalog, score/order, top-k and language drift fail closed.
4. Prove non-customer evidence never invokes the classifier and inference has a hard deadline.
5. Run only the new provider contract, scoped formatting, scoped Clippy and diff checks.

## Completion boundary

This slice closes the provider-neutral inference contract and Intent checkpoint transition. The
test port is not a trained classifier and creates no accuracy evidence. ONNX/Hugging Face or remote
inference adapter, model artifact storage/resolution, Contextual LLM fallback, cross-provider
arbitration, physical persistence, online evaluation and production deployment remain `not_run`.
