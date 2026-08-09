# G10–G16 AI Interaction/Speech/Action program amendment V1

## Decision

The user authorized completion of the architecture and Goal documentation derived from the reviewed
2026 IPPBX/contact-center AI article before G03 development resumes. The article is a research input,
not Evidence. Its useful directions are converted into binding future requirements; its vendor numbers,
unsupported generalizations and product matrices remain `not_run` or rejected.

Machine contract:

- Amendment:
  `goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.json`
- Amendment SHA-256:
  `bf261120ed3d70fbdf78926bb59abfb3c86c1e00dea6bfd637654475e3b5c6ea`
- Schema: `goals/amendments/future-goal-amendment-v1.schema.json`
- Resolver: `goals/resolve-future-goal.mjs`
- Test: `goals/future-goal-amendment.test.mjs`
- Frozen base manifest SHA-256:
  `11b026b5014dc344d4e5b2459aafc0b251190075a212fc68f40dce62fbbda912`

## Why this is an overlay

The base `goals/manifest.json` exact bytes are already frozen by the G02→G03 Gate amendment. Rewriting
the future Goal Markdown files or manifest would invalidate the active G03 authorization chain. This
amendment therefore binds additive clauses to the exact G10/G12/G13/G14/G15/G16 hashes without
changing any base Goal.

It does not change:

- G03 objective or SHA-256;
- G03–G08 scope, order or execution;
- any Authority;
- base Goal dependency, status or hash;
- Evidence state or production eligibility;
- the frozen manifest bytes.

## Binding additions

### G10 — Human/AI collaboration

- Separate versioned `DisclosureReceipt` from purpose-scoped `ConsentLease`; neither substitutes for
  the other.
- Add policy-driven proactive Handoff triggers, but require the existing durable
  prepare/commit/abort/query/reconcile flow before ownership or output changes.
- Add versioned Human/AI collaboration roles and explicit permission/lease/receipt semantics for
  approval, supervision, temporary voice takeover, bounded AI tool continuation and resume.
- Test stale policies, withdrawal, region mismatch, every trigger, prepare failure and Human-only
  continuity.

### G12 — SpeechRuntime

- Add `SpeechModePolicy` with `human_only_bypass`, `controlled_cascade`, `half_cascade`,
  `native_realtime` and `fused_asr_cascade`.
- HF `speech-to-speech` exact-source engineering remains mandatory only for overlapping
  VAD/STT/LLM/TTS/streaming-loop functions. Production selection remains evidence-driven.
- Persist immutable `SpeechModeSelectionReceipt`; mode/runtime changes create a new generation.
- Add `ConversationPerception` as a bounded SpeechRuntime submodule. Its provenance-bound speech,
  turn, confidence, quality, prosody and fraud outputs are observations, never automatic facts or
  Action/Handoff Authority.
- Run same-input end-to-end A/B and independent codec/language/dialect/noise/VAD/fault/cost/capacity/
  provider-exit qualification. Component TTFS and vendor claims are not E2E Evidence.

### G13 — Agent orchestration and handoff

- Add `InteractionExecutionPolicy` inside the existing Agent Runtime Policy Authority. It selects
  Speech, reasoning, deterministic workflow, Human collaboration and delivery paths only at an
  explicit task-stage or committed-turn boundary; each change creates a new receipt, generation,
  lease and fence.
- Consume the proactive Handoff policy while preserving stable Engagement/Task/Interaction,
  ContextRevision, disclosure/consent references and Action Unknown state.
- Unknown never blocks Human communication or owner handoff. Preserve the stable Attempt/reconcile
  handle; forbid retry, replacement, effect reuse or success claims until query/reconcile converges.
- Measure human-ready, first-human-response, context completeness, re-ask, media gap, stale output,
  duplicate/unknown action, abandonment and reconcile time.

### G14 — Action and MCP

- MCP/REST/SDK are versioned Tool Broker adapters only; Converact Engage Action Authority remains the
  sole ActionIntent/Authorization/Attempt/Receipt/query/reconcile writer.
- Add explicit version/capability negotiation, bounded compatibility windows, server/catalog/schema
  digest pinning, issuer/audience/scope controls and defenses for poisoning, confused deputy, token
  passthrough and SSRF.
- Timeout/disconnect stays Unknown until the frozen query/reconcile strategy converges.

### G15 — Evaluation and governance

- Version candidate facts as observed, inferred, user-confirmed, system-confirmed or action-confirmed;
  transcript and summary are projections, and promotion requires provenance plus a confirmation or
  Action receipt.
- Add cross-layer Perception/Agent/Action/Outcome replay, simulation, regression, shadow/canary,
  A/B, rollback, drift, policy, safety and cost evaluation without making Eval a fact Authority.
- Add RAG source/chunk/index poisoning, unsupported citations, tool-description injection and complex
  multi-step instruction tests.
- Split language/dialect evidence by provenance, codec, noise, region, Speech mode and runtime; vendor
  language counts are not qualification.

### G16 — Commercial production

- Measure all-in cost per connected minute and per successfully resolved task, including failures,
  retries, human handoff and support.
- Prove provider exit, portable verified exports, rollback and deletion confirmation.
- Version regional disclosure and separate consent policies.
- Prove AI↔human and cross-media handoff success, recovery, Call/Interaction continuity and context
  loss using real Pilot Evidence.
- Freeze task completion, verified resolution, action success/correctness, policy violation,
  escalation precision, Human rework, repeat-contact and cost-per-verified-resolution definitions.

The complete clauses, required artifacts, TDD items, acceptance Gates, non-goals and create_goal
addenda are in the JSON machine contract. This Markdown summary cannot narrow them.

## Future Goal start procedure

For G10, G12, G13, G14, G15 or G16:

1. Read `goals/PROGRAM-RULES.md` and the base Goal Markdown in full.
2. Verify the base Goal path and SHA-256 against frozen `goals/manifest.json`.
3. Read this Markdown, the JSON amendment and ADR-CCAAS-12 in full.
4. Run:

   ```bash
   node --test goals/future-goal-amendment.test.mjs
   ```

5. Read the exact base Goal bytes and pass them with the frozen manifest and amendment bytes to
   `buildFutureGoalObjective`; it rejects a missing or drifted Goal and returns the base summary plus
   the exact base Goal path/SHA-256, amendment path/SHA-256 and `create_goal_addendum`.
6. Use that complete builder output as the create_goal objective; do not hand-copy or omit a binding
   identity.
7. Execute every base clause and every additive clause. Anything unproved remains `not_run`.

## Non-authorization

This amendment does not authorize server/container changes, production rollout, external actions,
legal conclusions, vendor selection, inherited benchmark claims, a second Call/Room/Agent/Action
Authority or AI/tool work on the ordinary RTP hot path.
