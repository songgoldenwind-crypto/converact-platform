# AI outbound R1 Fast Intent Classifier Provider evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `d4b829dd4722afe0afd2a971dafa8a6a2212b4cd`.
- Branch: `codex/converact-platform-rename`.

## Proven

- One Rust `FastIntentClassifierProvider` consumes only an already validated immutable final
  customer `TranscriptSegment`; non-customer segments do not invoke the inference port.
- Its immutable artifact is bound to one exact Agent Release and Intent Catalog revision. Model,
  tokenizer, label-map and confidence-calibration artifacts each require a lowercase SHA-256
  digest; supported languages, text bytes, top-k and inference deadline have hard bounds.
- Canonical artifact content derives a stable provider revision independent of input language
  ordering. The inference request contains only revision, language, transcript text and top-k;
  tenant, campaign, telephone and call identifiers are not exposed to the model port.
- The serving adapter must echo the selected artifact revision. Drift, timeout, adapter failure,
  unsupported input and candidate count overflow fail closed.
- The shared Intent Core validates closed-Catalog labels, unique score-sorted top-k and basis-point
  confidence. Layer 1 creates no Slots. Empty output becomes explicit `unknown`; insufficient
  Top1/Top2 margin becomes `clarification_required`; qualifying output becomes `confirmed`.
- Observation identity is replay-stable over artifact revision, transcript payload hash and turn.
  Provider and observation diagnostics omit transcript text and candidate labels.
- The Provider has no Tool, DNC, Handoff, Telephony or Media port. Classification is evidence and
  cannot execute a business or call-side action.

## Fresh focused verification

```text
cargo test --locked -p converact-voice-agent-worker --test fast_intent_classifier
5 passed, 0 failed

rustfmt --edition 2024 --check <3 changed Rust files>
passed

cargo clippy --locked -p converact-voice-agent-worker \
  --lib --test fast_intent_classifier -- -D warnings
passed

python3 -m json.tool \
  architecture-foundation/ai-outbound/evidence/r1-fast-intent-classifier-provider/verification.json
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- a trained ONNX/Hugging Face/local or remote classifier adapter and artifact resolver: `not_run`;
- real classification accuracy, Macro F1, OOS/high-risk recall, calibration or fallback rate:
  `not_run`;
- Active Call live SSE pump, gap recovery and transcript-to-provider runtime composition:
  `not_run`;
- Contextual LLM fallback, cross-provider arbitration and Slot extraction: `not_run`;
- Emotion providers and complete Intent/Emotion/Customer State/Dialogue turn commit: `not_run`;
- physical PostgreSQL, restart/two-node recovery, real SIP/PSTN/media/recording: `not_run`;
- performance, capacity, long-run, independent review and production deployment: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
