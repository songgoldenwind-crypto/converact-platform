# AI outbound R1 Active Call final-transcript ingest evidence

Date: 2026-09-01

Evidence class: `local_contract`

Production eligibility: `false`

## Source identity

- Converact parent commit: `e5ba03695855d33738fe8706b01ee6a7f08a0f9f`.
- Branch: `codex/converact-platform-rename`.
- Pinned Active Call: `0.3.83`, commit
  `6224d948cc0941ac48b4a5426477aeaf639c2e98`.

## Proven

- The private Active Call mirror preserves exact final/delta timing, filler and referred-leg
  fields while discarding provider `taskId`; customer text uses a redacted bounded value.
- Missing paired timing, reversed/future timing, empty/control-bearing text and invalid confidence
  fail closed at the adapter boundary.
- A final reaches a draft only for the exact bound Channel Agent session and customer-input track.
  Filler, referred-leg, other-track and non-final events do not call the durability port.
- Source Event and Transcript Segment IDs are replay-stable across trace changes and are independent
  of text. Changed text for the same source therefore retains the same IDs but produces a different
  payload hash for Store conflict detection.
- Absolute Active Call speech times become call-relative offsets. Providers without speech timing
  produce a point segment at the final event time.
- Repeated SenseVoice `index = 0` finals at different timestamps have distinct identities. Tests
  close their drafts with Store-selected sequences `41` and `42`; upstream index never becomes the
  durable sequence.
- The generic Rust durability port is bound to `PostgresConversationResultStore` and calls its
  atomic `append_sequenced_final_segment` path. A controlled port proves one eligible final causes
  exactly one append and ignored audio causes none.
- Focused adapter and worker tests, scoped formatting, scoped Clippy and diff checks passed.

## Fresh focused verification

```text
cargo test --locked -p converact-active-call-adapter --test mapping
9 passed, 0 failed

cargo test --locked -p converact-voice-agent-worker --test active_call_transcript
5 passed, 0 failed

rustfmt --edition 2024 --check <8 changed Rust files>
passed

cargo clippy --locked -p converact-active-call-adapter --lib --test mapping -- -D warnings
passed

cargo clippy --locked -p converact-voice-agent-worker --lib \
  --test active_call_transcript -- -D warnings
passed

git diff --check
passed
```

No broad regression suite was run for this bounded slice.

## Explicitly not proved

- long-lived Active Call SSE pump, reconnect, gap detection, `/list` reconciliation and replay:
  `not_run`;
- runtime derivation and durable recovery of customer-track and call-start binding: `not_run`;
- physical PostgreSQL migration, transaction, RLS, concurrency or row write: `not_run`;
- transcript-to-Safety-Intent turn invocation and four-domain atomic understanding commit:
  `not_run`;
- Fast Classifier, Contextual LLM, cross-Provider arbitration and Emotion Providers: `not_run`;
- real Active Call/RustPBX/SIP/PSTN/media/recording call: `not_run`;
- recognition accuracy, latency, performance, capacity, long-run and production deployment:
  `not_run`;
- independent code review: `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
