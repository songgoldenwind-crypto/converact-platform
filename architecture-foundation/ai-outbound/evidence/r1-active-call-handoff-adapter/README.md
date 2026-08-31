# AI outbound R1 Active Call Handoff Adapter evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_loopback_contract`
>
> Production eligibility: `false`

This record proves the bounded `ChannelAgentHandoffPort` implementation at Converact commit
`a20d51a6f11cad0e9441f140208a6f99b9a86d41`. The adapter targets pinned Active Call `0.3.83`
commit `6224d948cc0941ac48b4a5426477aeaf639c2e98`; the real process was not started.

## Observed scope

- replacement AI preparation and reconcile query use only the exact session ID and `GET /list`;
- an active replacement session is accepted as present, while a missing session is deterministically
  `NotApplied` without creating or resuming another session;
- `GenerationCommit` carries the exact Handoff-bound AI session;
- a committed human generation sends one non-graceful interrupt command to the previous AI
  session in the controlled invocation;
- a committed AI generation does not send Resume to a fresh, unpaused playback track;
- the replacement session is queried again at AI generation commit, so a prepare-to-commit
  disappearance becomes reconcile-required rather than a false success;
- the existing Handoff generation/replay/abort/unknown-query tests remain green;
- provider errors remain bounded codes and the concrete port contains no Hangup, REFER, Bridge or
  direct Tool operation.

The loopback `/command` acknowledgement proves command acceptance only. It is not an Active Call
execution receipt and is not evidence that RustPBX changed the audible media owner.

## Fresh verification

- Active Call Handoff adapter loopback tests: 5 passed, 0 failed;
- existing Handoff runtime compatibility tests: 4 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- real Active Call process and command execution acknowledgement;
- RustPBX human/AI media-owner switch and observation;
- real human seat, SIP/PSTN, RTP/SRTP, audio, VAD, ASR, TTS, LLM or recording;
- physical PostgreSQL, deployed runtime, performance, capacity, long-run, fault campaign,
  independent review and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
