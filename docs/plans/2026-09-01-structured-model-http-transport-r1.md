# Structured Model HTTP Transport R1 implementation plan

> Date: 2026-09-01
>
> Scope: production-shaped Rust HTTP transport for bounded text understanding models
>
> Status: `loopback_transport_contract_passed / real_model_not_run / production_not_run`

## Goal

Replace test-only Fast Intent, Contextual Intent and Text Emotion ports with one reusable Rust HTTP
transport that can call an independently deployed model runtime without giving that runtime Agent,
Campaign, Tool, Telephony or persistence authority.

## Frozen contract

- One injected `reqwest::Client` owns TLS, mTLS and credential material outside this module. The
  transport accepts no bearer token, secret or certificate string and its `Debug` output omits the
  endpoint and customer text.
- Plain HTTP is accepted only for loopback development. Non-loopback endpoints require HTTPS;
  endpoint credentials, query strings, fragments and non-root base paths fail closed.
- Routes are fixed by the Rust client: `/v1/inference/fast-intent`,
  `/v1/inference/contextual-intent` and `/v1/inference/text-emotion`.
- Every request uses schema version 1, carries the exact Provider artifact revision and contains
  only the bounded input already validated by the Provider. Contextual turns preserve durable
  sequence order and speaker role.
- Request and response bodies are serialized/collected under configured byte bounds. Responses
  require a successful status, JSON media type, schema version 1 and a closed output shape.
- Transport failures, HTTP 408/429 and 5xx remain transient. Request bounds, deterministic 4xx and
  response-contract failures are permanent Provider errors and can never activate a transient
  Contextual fallback.
- The serving runtime must echo the exact artifact revision. Existing Provider code remains the
  authority for catalog labels, confidence ordering, Slot allow-lists and artifact-drift rejection.
- Admission and endpoint selection remain owned by `ModelProviderPool`; Provider deadlines remain
  the outer cancellation boundary. The transport creates no task, retry loop, circuit breaker or
  second queue.

## Minimal TDD proof

1. Start a loopback model endpoint and drive a real Fast Intent Provider through the HTTP transport.
2. Assert the fixed route and exact bounded wire request, then accept the typed response.
3. Reject credential-bearing, non-loopback plaintext and path-bearing endpoint configuration.
4. Reject oversized or schema-drifted response data without leaking endpoint or customer content.
5. Run only this transport test, scoped formatting and scoped Clippy.

## Explicit exclusions

- a real Hugging Face/ONNX/Candle model process, model download or model-quality claim;
- acoustic PCM transport and the RustPBX/media audio tap;
- credential issuance, mTLS client construction, endpoint health and circuit breaking;
- deployed Active Call, SIP/PSTN, production, performance, capacity or broad regression tests.
