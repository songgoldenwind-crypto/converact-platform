# AI outbound R1 Active Call Understanding Coordinator evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / live_sse_models_not_run / production_not_run`

## Proven scope

- one eligible normalized customer final passes the exact Active Call binding, durable sequence
  append, bounded history source and one understanding processor invocation;
- non-customer/filler/referred/non-final events stop before transcript append and model work;
- replay/current and historical dispositions never query transcript history and retain the existing
  processor skip-before-Store/model behavior;
- the PostgreSQL append receipt implements the generic exact-segment/disposition contract;
- a concrete Rust text-emotion processor freezes Release/Catalog/policies and composes the existing
  layered Intent plus complete four-head turn;
- the coordinator creates no retry/background task and owns no Telephony/Media/Tool/Handoff action.

## Focused verification

Rust `1.94.1` with `--locked`:

```text
converact-voice-agent-worker / active_call_transcript: 7 passed
converact-voice-agent-worker / active_call_understanding_postgres: 3 passed
converact-voice-agent-worker / understanding_recovery: 9 passed
scoped Clippy: passed with -D warnings
```

The coordinator test first failed because receipt, processor and orchestration APIs did not exist.

## Explicitly not proved

- a running Active Call SSE consumer, reconnect/gap recovery or runtime lifecycle;
- physical PostgreSQL, real Intent/Emotion models or model quality;
- real audio-window/media tap, SIP/PSTN/media, performance, capacity or production.

No server, container, deployed service or remote repository was changed.
