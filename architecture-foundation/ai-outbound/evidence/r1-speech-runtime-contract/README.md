# AI outbound R1 Speech Runtime contract evidence

> Recorded: 2026-09-01
>
> Evidence class: `local_contract` + `pure_state_machine`
>
> Production eligibility: `false`

This record proves the first provider-neutral Rust Speech Runtime authority boundary at Converact
commit `cd99527b8bb04ad982d400d8f4df2fe220f84782`. It does not prove a real speech Provider,
telephone media path or audible AI call.

## Observed scope

- bounded identities distinguish Agent run, channel binding, speech session and response;
- separate positive control and response fences prevent authority-type interchange;
- canonical PCM accepts only 8/16/24/48 kHz, one or two channels, aligned signed 16-bit
  little-endian payloads and at most 60 milliseconds per frame;
- deserialization stops at the absolute frame bound, and `Debug` reports only payload length;
- the pure session aggregate enforces blocked prepare, explicit commit, active response, cancel,
  reconcile-required and terminal close states;
- stale control or response fences fail closed;
- audio sequence and monotonic capture time cannot move backwards; bounded queue pressure is
  reported as `dropped_overflow` without retaining or copying PCM in the aggregate;
- response context, lease, generation and fence authority cannot move backwards;
- the aggregate owns no socket, database, task, lock, queue, global registry or Provider type.

## Fresh verification

The exact command ledger is [verification.json](./verification.json). Fresh scoped results were:

- Speech Runtime wire contract tests: 3 passed, 0 failed;
- pure Speech session aggregate tests: 3 passed, 0 failed;
- scoped contract/core Clippy with warnings denied: passed;
- exact changed-file Rust format check and repository diff check: passed.

## Explicitly not run

- durable Speech session/effect store and multi-worker recovery;
- a real Active Call, HF Speech Runtime, ASR, LLM or TTS Provider;
- real RustPBX, SIP/PSTN, RTP/SRTP, media tap or audible conversation;
- response-plan signature verification, Provider events and Tool-result injection;
- deployed runtime, latency, quality, capacity, long-run and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed source was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
