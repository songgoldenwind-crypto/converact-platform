# Model Provider Pool R1 implementation plan

> Date: 2026-09-01
>
> Scope: bounded Rust admission and endpoint selection for understanding models

## Goal

Provide one transport-neutral runtime boundary for Fast Intent, Contextual Intent, Text Emotion and
Acoustic Emotion adapters so model saturation or queueing cannot create unbounded tasks or delay a
live-call control path.

## Frozen contract

- A pool contains 1–64 immutable opaque Provider handles selected by atomic O(1) round robin.
- In-flight capacity is 1–4,096 and waiter capacity is 0–8,192. The sum is allocated once during
  construction; acquire performs no task spawn and stores no customer input.
- Admission is immediate: when active plus waiting capacity is full, return `saturated` without
  queueing. An admitted waiter has a 1–30,000 ms queue deadline.
- Cancellation, timeout or lease drop releases both permits. The pool does not retry a model call,
  change artifacts or silently select a different Release.
- One adapter type implements the existing Fast/Contextual/Text/Acoustic Provider ports while
  preserving their request, artifact echo, output validation and outer inference deadlines.
- Pool diagnostics expose only capacity and endpoint count, never endpoint configuration, secret,
  transcript, PCM, label or model output.
- This pool has no Telephony, Media, Tool, Handoff or durable-state authority.

## Minimal TDD proof

1. Sequential leases select endpoints `A → B → A` and a zero-waiter saturated call fails fast.
2. One bounded waiter expires and releases admission without background work.
3. Empty/oversized configurations fail before runtime.
4. Existing text-emotion Provider tests run through the pooled adapter unchanged.
5. Run only the pool/text-emotion tests and scoped Worker Clippy.

## Explicit exclusions

- concrete HTTP/gRPC/UDS/native inference transport, authentication and health probing;
- model weights, artifact loader, HF/ONNX/Candle implementation or accuracy/calibration evidence;
- retry/failover policy, circuit breaking, fleet placement and physical process tests;
- performance, capacity and production qualification.
