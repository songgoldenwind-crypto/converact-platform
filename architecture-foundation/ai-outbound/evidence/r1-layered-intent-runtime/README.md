# AI outbound R1 layered Intent Runtime evidence

> Date: 2026-09-01
>
> Status: `passed_local_contract / real_models_not_run / process_composition_not_run /
> production_not_run`

## Proven scope

- `LayeredIntentRuntime` consumes a bounded, caller-owned durable-sequence transcript window and
  always routes its last segment through the existing Safety/Fast Router;
- high-confidence and Safety paths return without Contextual inference, while ambiguous Fast
  evidence invokes the Contextual Provider over the same exact current evidence anchor;
- Contextual selection advances the original Intent state once and retains both Provider
  contributions;
- Router revision v2 and resolution wire schema v2 canonically bind one closed path:
  `safety_short_circuit`, `fast_confirmed`,
  `contextual_selected` or `fast_fallback`;
- Fast fallback canonically binds an explicit reason. Only Contextual unavailability and timeout are
  eligible under `FallbackFastOnTransient`; all artifact/input/output/catalog drift fails closed;
- raw Provider records and the resolution record preserve the selected path and fallback reason for
  the existing atomic understanding-turn writer;
- the runtime has no transcript sequence, durable head, business action, Tool, Telephony, Handoff
  or media authority.

## Focused verification

Rust `1.94.1` with `--locked` ran the affected integration contract:

```text
converact-voice-agent-worker / intent_confidence_router: 6 passed
```

The new test first failed because the resolution-path types and layered coordinator did not exist.

## Explicitly not proved

- real Fast classifier or Contextual model artifact, inference quality, calibration or latency;
- Active Call SSE consumer → transcript append → bounded history load → runtime process wiring;
- Emotion Provider and complete Intent/Emotion/Customer State/Dialogue construction and atomic
  commit from one live turn;
- physical PostgreSQL, crash/restart, two-node race, fleet, production or performance behavior.

No server, container, deployed service or remote repository was changed.
