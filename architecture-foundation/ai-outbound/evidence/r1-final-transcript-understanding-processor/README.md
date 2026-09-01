# AI outbound R1 Final Transcript Understanding Processor evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / postgres_history_adapter_not_run /
> real_models_not_run / production_not_run`

## Proven scope

- `process_final_transcript_understanding` composes consistent recovery, layered Intent, text Emotion,
  complete-turn derivation and atomic append behind provider-neutral Rust ports;
- the next turn is derived from recovered Intent/Emotion heads and cannot wrap;
- newly appended current customer input produces one bounded complete understanding batch;
- replayed-current and historical inputs return before Store recovery, model invocation or append,
  preventing duplicate model cost and nondeterministic replay drift;
- Provider/state/prepare/persistence errors are reduced to stable redacted categories;
- no business action, Tool, Handoff, Telephony or Media port exists in this processor.

## Focused verification

Rust `1.94.1` with `--locked` ran the affected Worker contract:

```text
converact-voice-agent-worker / understanding_recovery: 6 passed
```

The new test first failed because the processor, disposition gate and outcome contract did not
exist.

## Explicitly not proved

- concrete PostgreSQL append-receipt mapping or bounded typed history query;
- real Active Call SSE/process lifecycle and real model adapters/quality;
- physical PostgreSQL transaction, crash/restart or two-node race;
- acoustic/multimodal Emotion, production, fleet, capacity or performance qualification.

No server, container, deployed service or remote repository was changed.
