# Active Call intent → Outcome projection R1 implementation plan

> **Status:** `implementation_in_progress / physical_integrations_not_run / production_not_run`

**Goal:** Carry the intent already recognized by the pinned Active Call Playbook into Converact's
release-bound conversation result path without replacing Active Call's VAD, turn detection,
clarification or intent logic and without letting an upstream string bypass `OutcomeSchema`.

## Contract

```text
Active Call Playbook intent
  -> bounded/redacted IntentCandidate
  -> exact Agent Release OutcomeSchema validation
  -> immutable ValidatedIntentEvidence
  -> durable result-generation input
  -> provider result
  -> evidence/result equality check before durable finalize
```

- A matching candidate is reused; Converact does not run a second classifier for it.
- An absent or schema-mismatched candidate is not invented or silently accepted. The existing
  transcript-based result path may infer one of the same schema's closed values and records that it
  had no accepted Active Call evidence.
- The evidence is bound to the exact Agent Release, Outcome Schema revision and redacted canonical
  payload hash. The durable result command digest must include the accepted evidence or its absence.
- Provider output must match accepted intent evidence before it can be finalized, including query
  and replay paths.
- Active Call types stop at the Worker adapter seam; the result core receives only its own validated
  evidence type.

## TDD sequence

1. Add core tests for exact-match validation, release/schema binding, redacted diagnostics and
   unknown-candidate rejection; observe RED before implementation.
2. Implement the smallest `ValidatedIntentEvidence` interface inside conversation-result-core.
3. Add Worker tests that resolve a terminal Active Call candidate, forward it to result generation,
   bind it into the command digest and reject provider drift before Store finalization; observe RED.
4. Extend the result-provider and finalization interfaces minimally, keeping the existing no-evidence
   path compatible and query idempotent.
5. Run only the affected core, adapter and Worker tests plus scoped format/Clippy. Record direct
   evidence and keep real runtime, model quality, SIP/PSTN, PostgreSQL and production as `not_run`.

## Non-goals

- no new intent classifier, model prompt, VAD, EOU or interruption algorithm;
- no real Active Call process or model invocation;
- no server/container changes, local Docker, performance or broad regression suite;
- no claim that Active Call's intent quality is proven by local contract tests.
