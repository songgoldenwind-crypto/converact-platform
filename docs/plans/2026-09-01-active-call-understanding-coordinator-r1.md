# Active Call Understanding Coordinator R1 implementation plan

> Date: 2026-09-01
>
> Scope: normalized Active Call final → durable sequence/history → understanding processor

## Goal

Close the in-process functional path from one normalized customer `asrFinal` to the existing Rust
Intent/Emotion/Customer State/Dialogue processor without trusting upstream indexes or repeating
model work for replayed/historical events.

## Frozen contract

- The existing `ActiveCallTranscriptBinding` remains the authority gate. Non-final, AI-track,
  filler and referred-leg events are ignored before any Store/model call.
- The transcript Store allocates the durable sequence and returns a typed receipt containing the
  exact stored segment and one closed understanding disposition.
- Only `AppendedCurrent` loads the configured 1–32 segment history. Replay/current and historical
  receipts pass an empty history to a processor that returns before recovery/model invocation.
- The coordinator invokes at most one processor per eligible append receipt and has no retry,
  background task or action authority.
- A concrete text-emotion processor adapter freezes all Release/Catalog/policy/durability
  dependencies once and accepts only disposition plus bounded history per event.
- Ingest, history and understanding failures are redacted categories; no transcript or model output
  enters diagnostics.
- Acoustic PCM lookup remains a separate media-tap dependency and is not fabricated from ASR text.

## Minimal TDD proof

1. One eligible current final is sequenced once, loads one exact bounded history and invokes one
   processor.
2. A replay invokes only the processor skip gate, without loading history; an AI-track event is
   ignored before append or processor work.
3. Existing PostgreSQL receipt/history mapping and complete understanding tests remain unchanged.
4. Run only Active Call transcript/source/understanding tests and scoped Worker Clippy.

## Explicit exclusions

- long-lived Active Call SSE connection, reconnect/gap reconciliation and runtime composition;
- physical PostgreSQL and real model calls;
- real PCM tap/adaptive multimodal processor binding;
- SIP/PSTN/media, server/container changes, performance, capacity and production.
