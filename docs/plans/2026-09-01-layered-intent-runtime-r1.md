# Layered Intent Runtime R1 implementation plan

> Date: 2026-09-01
>
> Scope: final-transcript Intent resolution only; no business action or production qualification

## Goal

Connect one already-durable, sequence-ordered transcript window to the existing Rust
Safety → Fast → Contextual Intent layers without creating a second transcript, turn or Intent-state
authority.

## Frozen contract

- The last segment in the caller-supplied bounded window is the exact Store-sequenced final segment
  evaluated by Safety/Fast and used as the Contextual evidence anchor.
- Safety short-circuit, confirmed Fast, selected Contextual and Fast fallback are closed resolution
  paths and are bound into the canonical resolution hash under Router revision v2.
- A Fast fallback always has one closed reason. The compatibility API records `explicit_caller`;
  runtime fallback records Contextual timeout or unavailability.
- Release policy may choose fail-closed or Fast fallback for transient Layer-2 failure. Catalog,
  artifact, input, serving-revision and output-schema drift always fail closed.
- Contextual resolution advances from the original Intent state exactly once. Provider evidence is
  not an action and owns no Tool, DNC, Handoff, Telephony or Media port.
- Runtime input is already durable evidence. Store sequence allocation, transcript history loading,
  head recovery and four-domain transaction ownership remain outside this stateless coordinator.

## Minimal TDD proof

1. Extend Router tests so every existing resolution path and fallback cause is observable.
2. Prove one ambiguous Fast result invokes Contextual with the exact durable history and selects its
   result once.
3. Prove a configured transient unavailability falls back and persists the exact cause.
4. Prove artifact drift remains fail-closed under the fallback-enabled policy.
5. Run only the affected Router/runtime test, scoped Clippy and diff checks.

## Explicit exclusions

- real Fast or Contextual model runtimes and model-quality claims;
- Active Call SSE consumer/process composition and bounded history repository;
- Emotion Provider, Customer State/Dialogue derivation and four-domain commit;
- physical PostgreSQL, restart/two-node, fleet, production, capacity or performance qualification.
