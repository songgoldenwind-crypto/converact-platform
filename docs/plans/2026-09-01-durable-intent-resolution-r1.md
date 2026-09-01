# Durable Intent resolution R1 implementation plan

> **Status:** `local_contract_passed / physical_postgresql_not_run / runtime_composition_not_run /
> production_not_run`

**Goal:** Preserve every same-turn Intent Provider contribution and the Router's selected result in
the same caller-owned transaction as the four authoritative understanding heads.

## Authority and rolling-compatibility decision

- `intent_provider_observation` stores each validated Safety, Fast or Contextual observation. It is
  immutable record-only evidence and cannot advance an Intent head.
- `intent_resolution_evidence` stores the Router revision, exact decision thresholds, ordered
  contributor identities and hashes, selected source, selected checkpoint and resolution hash. It
  is also record-only.
- The existing `intent_observation` head kind continues to contain the selected `IntentCheckpoint`
  during rolling migration. This keeps old readers and recovery compatible while making the new
  writer auditable.
- A new batch may contain one to three Provider observations followed by exactly one resolution,
  then the existing fixed Intent, Emotion, Customer State and Dialogue heads.
- Empty evidence remains accepted only for the pre-existing writer during drain. New resolved-turn
  code must use `prepare_resolved_turn`.
- Evidence and heads execute inside the same tenant transaction. Any error is returned before the
  transaction owner may commit.

## Bounded invariants

1. Provider and resolution records are always record-only and can never become a head.
2. One non-empty evidence sequence is bounded to four records and ends in exactly one resolution.
3. Every evidence item shares the selected Intent checkpoint's exact authority and turn.
4. Provider observations cannot be newer than the selected checkpoint.
5. Evidence record identities are unique inside the batch.
6. Raw observation serialization is versioned, closed-field and revalidates its canonical hash.
7. The resolution binds model/prompt-independent Provider output to the actual Router policy and
   selected checkpoint; logs and `Debug` output continue to omit transcript and Slot contents.
8. PostgreSQL migration 135 changes only the immutable-record allow-list. Authoritative head kinds
   are deliberately unchanged.

## Minimal TDD sequence

1. Prove raw Intent observation wire round-trip and hash-drift rejection.
2. Prove the two new record kinds are Intent-domain record-only evidence.
3. Prove valid evidence order and reject missing resolution, reversed order and authority drift.
4. Prove the Router emits two contributor records plus one resolution for a Fast→Contextual turn.
5. Prove old four-head construction and recovery remain compatible.
6. Run only Intent Core, Understanding Store, Router and recovery tests plus scoped formatting and
   Clippy.

## Completion boundary

This slice proves the local types, codecs, rolling schema text and caller-owned atomic write path.
It does not apply migration 135 to a physical PostgreSQL instance, start a real classifier/LLM,
compose the final-transcript consumer with the Router, or prove restart/two-node/production
behavior. Those remain `not_run`.
