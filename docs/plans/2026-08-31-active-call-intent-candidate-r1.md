# Active Call intent-candidate parity R1 implementation plan

> **Status:** `controlled_adapter_contract_passed / schema_projection_not_run /
> live_runtime_not_run / production_not_run`

**Goal:** Preserve the pinned Active Call Playbook's existing intent variable as bounded candidate
evidence, without adding a second classifier or letting an arbitrary runtime variable become the
Converact business result.

## Source and authority boundary

Pinned Active Call `0.3.83` stores Playbook variables through `set_extra` and includes its `extra`
map in the terminal `hangup` event. Its own tests use the `intent` variable. The current Converact
mirror ignores the whole map.

Converact will ingest only `extra.intent`:

- it is a candidate emitted by the Channel Agent, not authoritative classification;
- `OutcomeSchema` remains the versioned allow-list for the final durable intent;
- every other `extra` key is discarded, including headers, customer fields, provider data and
  arbitrary Playbook variables;
- the candidate is bounded, rejects controls and is redacted from `Debug` output;
- absent intent stays `None`; a present non-string or invalid value fails closed.

## Minimal TDD sequence

1. Extend the exact hangup fixture with an intent plus unrelated secret-bearing extras.
2. First prove that the candidate is accessible, other extras are absent from the normalized event
   and `Debug` redacts the intent.
3. Prove oversized, control-bearing and non-string intent values fail closed.
4. Extend only the private upstream mirror and normalized terminal event.
5. Run only the Active Call mapper test, its command/client compatibility tests, scoped format and
   scoped Clippy.

## Completion boundary

This slice proves local wire/mapping parity only. It does not prove the quality of Active Call's
intent inference, map a candidate to a published `OutcomeSchema`, run a model or place a real call.
Those remain separate functional evidence gates.

The controlled mapping result is recorded in
[R1 Active Call intent-candidate evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-intent-candidate/README.md).
