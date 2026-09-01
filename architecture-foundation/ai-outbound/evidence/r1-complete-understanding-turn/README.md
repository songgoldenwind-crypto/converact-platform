# AI outbound R1 complete Understanding Turn evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / physical_postgresql_not_run /
> live_process_composition_not_run / production_not_run`

## Proven scope

- `prepare_complete_turn` accepts only same-authority, same-turn Intent and Emotion resolutions;
- Customer State and Dialogue IDs are deterministically content-addressed from their exact inputs and
  Policy revision;
- Customer State is derived from selected Intent/Emotion states and Dialogue is evaluated by the
  Release-bound deterministic Policy;
- the Store batch grammar accepts bounded raw Intent contributors, one Intent resolution and bounded
  raw Emotion contributors before exactly four authoritative heads;
- wrong evidence order, head-bearing evidence, duplicate identity, authority/turn/clock drift and
  head collisions fail before SQL;
- the caller-owned transaction order is raw Intent evidence → Intent resolution → raw Emotion
  evidence → Intent/Emotion/Customer State/Dialogue heads;
- identical resolved input produces an identical complete batch;
- understanding remains evidence/recommendation only and owns no Tool, Handoff, Telephony or Media
  action authority.

## Focused verification

Rust `1.94.1` with `--locked` ran only affected contracts:

```text
converact-conversation-understanding-store / turn_batch: 6 passed
converact-voice-agent-worker / understanding_recovery: 5 passed
```

The tests first failed because Emotion evidence was outside the batch grammar and complete-turn
assembly did not exist.

## Explicitly not proved

- physical PostgreSQL execution/rollback and process crash/restart/two-node race;
- Active Call SSE → durable transcript/history → real models → complete-turn process wiring;
- acoustic audio-window evidence or multimodal fusion;
- real intent/emotion quality, calibration, provider availability or latency;
- production, fleet, capacity or performance qualification.

No server, container, deployed service or remote repository was changed.
