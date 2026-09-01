# R1 durable Intent resolution evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / physical_postgresql_not_run / production_not_run`

## Proven scope

- raw `IntentObservation` has a versioned closed-field wire form and rejects canonical hash drift;
- `intent_provider_observation` and `intent_resolution_evidence` are immutable Intent-domain
  record-only kinds and cannot advance a head;
- a non-empty turn batch accepts only bounded Provider contributors followed by one resolution;
- authority, turn, clock, evidence order and duplicate record identity are checked before SQL;
- the Router encodes every contributor and one resolution containing the selected checkpoint,
  selected source, policy thresholds and content hash;
- the SQL adapter appends evidence before the four fixed heads in the same caller-owned transaction;
- migration 135 additively extends only the records table; existing head kinds and recovery payload
  remain unchanged for rolling compatibility.

## Focused verification

The exact Rust `1.94.1` toolchain ran only the affected tests with `--locked`:

```text
converact-conversation-understanding-core / intent_state: 6 passed
converact-conversation-understanding-store / record_contract: 6 passed
converact-conversation-understanding-store / schema: 4 passed
converact-conversation-understanding-store / turn_batch: 5 passed
converact-conversation-understanding-store / turn_outcome: 3 passed
converact-voice-agent-worker / intent_confidence_router: 4 passed
converact-voice-agent-worker / understanding_recovery: 4 passed
```

The initial new tests failed for the expected missing codecs, kinds, batch API, migration and Router
encoder before the implementation was added.

## Explicitly not proved

- migration application or rollback on physical PostgreSQL;
- final-transcript consumer → Safety/Fast/Contextual Router → `prepare_resolved_turn` process
  composition;
- real classifier or LLM model quality, latency or availability;
- process crash, restart, two-node race or production behavior;
- fleet, capacity, long-call or performance qualification.

No server, container, deployed service or remote repository was changed.
