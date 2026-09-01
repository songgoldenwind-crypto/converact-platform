# Active Call final-transcript ingest R1 implementation plan

> **Status:** `local_contract_passed / sse_pump_not_run / physical_postgresql_not_run /
> production_not_run`

**Goal:** Carry one pinned Active Call `AsrFinal` customer utterance into a sequence-free,
redacted Rust `TranscriptSegmentDraft`, then let the existing durable Store allocate the only
authoritative stream sequence atomically.

## Source and authority boundary

The source contract is Active Call `0.3.83` commit
`6224d948cc0941ac48b4a5426477aeaf639c2e98`. Its `AsrFinal` and `AsrDelta` events contain
`trackId`, `timestamp`, provider-local `index`, optional `startTime`/`endTime`, `text`, optional
`isFiller`, `confidence`, `taskId` and `refer`.

Converact applies these rules:

- only `AsrFinal` can become durable transcript evidence; deltas remain ephemeral;
- the exact `ChannelAgentSessionId` and explicitly bound customer-input `trackId` must match;
- filler finals, referred-leg finals and all other tracks are ignored;
- `taskId` and confidence are provider metadata, not stable identity or durable sequence;
- Active Call's provider-local `index` is an identity component only. It is never copied into the
  durable transcript sequence because SenseVoice can emit `index = 0` for every final;
- one source identity is the canonical digest of stable authority identifiers, execution
  generation, session, event kind, track, timestamp and provider-local index. Trace IDs and text
  are excluded so reconnect replay is stable and changed content for one source collides instead
  of becoming a second event;
- when both absolute speech timestamps exist, both must fall between call start and event time and
  are converted to call-relative offsets. When neither exists, event time becomes a point segment.
  Partial or impossible timing fails closed;
- customer text is bounded, rejects controls and is redacted from ordinary `Debug` output;
- the PostgreSQL adapter invokes only `append_sequenced_final_segment`, which allocates sequence
  and appends/replays inside the existing tenant transaction.

## Minimal TDD sequence

1. Extend the exact pinned wire fixture with timing, filler, refer and private provider metadata.
2. Prove the old adapter fails to preserve the fields and leaks transcript diagnostics.
3. Add a redacted transcript value and fail-closed timing/content validation.
4. Prove stable source identity across reconnect trace changes and changed text.
5. Prove repeated SenseVoice `index = 0` finals remain distinct while the Store owns sequences.
6. Prove non-customer, filler, referred and non-final events never reach the durability port.
7. Bind the generic Rust durability boundary to `PostgresConversationResultStore`.
8. Run only mapper, transcript-ingest, scoped formatting, scoped Clippy and diff checks.

## Completion boundary

This slice closes the normalized-final-to-atomic-Store code boundary. It does not claim that the
long-lived worker has opened `/events/{session}`, detected/recovered a gap, derived the live
customer-track/call-start binding, written a physical PostgreSQL row or fed a committed segment
into Safety/Fast/Contextual intent Providers. Those are separate functional slices and remain
`not_run`.

Evidence is recorded in
[R1 Active Call final-transcript ingest evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-final-transcript-ingest/README.md).
