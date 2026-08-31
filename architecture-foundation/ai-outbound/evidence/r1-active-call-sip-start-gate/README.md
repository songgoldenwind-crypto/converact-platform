# R1 Active Call SIP binding and conversation-start gate evidence

Date: 2026-09-01
Scope: local exact-source overlay and Rust loopback contracts only

## Proven

- The overlay applies only to Active Call commit
  `6224d948cc0941ac48b4a5426477aeaf639c2e98`, tree
  `9521ad341fb992ba6d491eb217983df8cf85d2cf`, and is idempotent.
- `X-Converact-Agent-Session` is bounded and duplicate/invalid values fail closed.
- A header identity must match an existing platform Playbook reservation. The first matching SIP
  leg claims it; a second claim is rejected.
- The control header is removed before SIP extras can reach Playbook rendering or the dialogue LLM.
- A reserved Playbook is authoritative for that SIP session instead of a static routing Playbook.
- The Runner observes Answer/MediaReady while armed but does not call `on_start` until the explicit
  idempotent start endpoint changes `attached -> started`.
- The Rust adapter parses `pending`, `attached`, `started`, legacy `active`, and `not_found`, and
  treats ambiguous start mutation results as unknown rather than retryable failure.

## Precise local verification

| Check | Result |
|---|---:|
| Node overlay behavior/idempotence tests | 3 passed |
| transformed exact-source Rust reservation tests | 3 passed, 255 filtered |
| `converact-active-call-adapter` client tests | 11 passed |
| worker Active Call reservation adapter tests | 2 passed |
| adapter + worker scoped Clippy with warnings denied | passed |
| transformed source `rustfmt` and `git diff --check` | passed |

The transformed source also received a `cargo clippy --lib -- -D warnings` attempt. It failed on
266 pre-existing upstream lint findings across unrelated Active Call modules, so no clean-clippy
claim is made for the upstream crate. The changed sources compile without rustc warnings in the
focused Rust test build.

## Not proven

- RustPBX header injection and a real originated SIP leg: `not_run`.
- A running Active Call process, real provider ASR/TTS/LLM, RTP/media, disclosure audio, barge-in,
  intent output, terminal transcript, or post-call outcome: `not_run`.
- Authentication of the private RustPBX-to-Active-Call control header: `not_run`.
- Crash durability or multi-node reservation recovery: `not_run`; reservation/gate state is
  process-local memory.
- Production eligibility and performance/capacity: `not_run`.

Active Call does not certify disclosure completion. Converact remains responsible for observing the
exact disclosure `playId` terminal event before invoking the start mutation.
