# AI outbound R1 structured model HTTP transport evidence

> Date: 2026-09-01
>
> Status: `passed_loopback_transport_contract / real_model_not_run / production_not_run`

## Proven scope

- one Rust HTTP transport implements the existing Fast Intent, Contextual Intent and Text Emotion
  Provider ports without changing their Catalog, confidence, Slot or state authority;
- the three fixed versioned routes carry the exact artifact revision and bounded Provider input;
- a loopback Axum model endpoint observed all three request shapes and returned typed responses that
  passed the existing Provider validation;
- plaintext is limited to loopback; URL credentials, queries, fragments and non-root paths are
  rejected before a request;
- request and response bodies are bounded, JSON responses use a closed schema, and schema drift
  fails without exposing endpoint, transcript or response content;
- only transport/408/429/5xx failures remain transient; request, deterministic 4xx and response
  contract failures cannot be mistaken for a fallback-eligible outage;
- TLS/mTLS and credentials stay in the injected `reqwest::Client`; this module accepts no secret
  value and creates no retry task, queue or circuit breaker.

## Precise verification

Rust `1.94.1` with `--locked`:

```text
cargo test --locked -p converact-voice-agent-worker --test structured_model_http_transport
3 passed, 0 failed

affected Provider/Router contracts:
fast_intent_classifier 5 passed; contextual_intent_provider 4 passed;
text_emotion_classifier 4 passed; intent_confidence_router 6 passed

cargo clippy --locked -p converact-voice-agent-worker --lib \
  --test structured_model_http_transport --test fast_intent_classifier \
  --test contextual_intent_provider --test text_emotion_classifier \
  --test intent_confidence_router -- -D warnings
passed

scoped rustfmt --check and git diff --check
passed
```

No broad regression, Docker, remote server, deployed service or performance test was used.

## Explicitly not proved

- a real Hugging Face, ONNX, Candle or LLM model endpoint and inference quality;
- production mTLS client construction, credential rotation, endpoint health or failover;
- acoustic PCM transport and the RustPBX/voice-media-rs media tap;
- Release artifact repository resolution and a runnable Worker composition root;
- Active Call/SIP/PSTN audio, production deployment, performance or capacity.
