# Text Emotion Classifier Provider R1 implementation plan

> Date: 2026-09-01
>
> Scope: transcript-bound text emotion evidence only

## Goal

Add the first concrete Rust Emotion Provider boundary: turn one already-validated final customer
transcript into Release-bound, closed-Catalog text-emotion evidence without claiming acoustic or
multimodal emotion recognition.

## Frozen contract

- One immutable artifact binds Agent Release, Emotion Catalog, model, tokenizer, label map,
  calibration, languages, input/top-k bounds and inference deadline.
- The model port sees only artifact revision, language, text and top-k. It receives no tenant,
  campaign, call or business-action authority.
- Serving must echo the exact artifact revision. Drift, timeout, unsupported input and invalid
  labels/confidence/intensity fail closed with low-cardinality errors.
- Only final customer transcript is eligible. AI/human/system text cannot become customer-emotion
  evidence through this Provider.
- Output source is always `TextClassifier`, references exactly the durable transcript segment and
  contains no audio evidence ID.
- The Provider emits observation evidence only. It does not fuse modalities, advance Emotion State,
  recommend dialogue, execute tools, transfer or terminate a call.

## Minimal TDD proof

1. Prove stable Release-bound evidence, exact transcript anchor and redacted diagnostics.
2. Prove non-customer and unsupported-language input never reach inference.
3. Prove serving revision drift, unknown labels and invalid intensity fail closed.
4. Prove deadlines and artifact digest bounds.
5. Run only the new Provider contract, existing Emotion Core test and scoped Clippy.

## Explicit exclusions

- trained model artifacts and any accuracy/calibration/latency claim;
- acoustic audio-window Provider and multimodal fusion;
- full four-domain turn composition and physical PostgreSQL;
- live Active Call, production, fleet, capacity or performance qualification.
