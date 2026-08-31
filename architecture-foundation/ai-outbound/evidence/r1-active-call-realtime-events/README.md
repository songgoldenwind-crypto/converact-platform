# AI outbound R1 Active Call realtime event parity evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract`
>
> Production eligibility: `false`

This record proves the fail-closed event boundary at Converact commit
`89f198828dc287cdf37054aaaaa058dd17b3da34`. The wire shapes were taken from the pinned Active Call
`0.3.83` source at `6224d948cc0941ac48b4a5426477aeaf639c2e98`; source identity remains governed
by `infra/converact/active-call/source-lock.json`. It does not prove that a live runtime produced
these events from real audio.

## Observed scope

- `speaking` maps a bounded speech-start observation, optional confidence and filler flag without
  running a second VAD;
- `eou` maps the turn boundary while deliberately dropping optional utterance and interruption text;
- `interruption` maps validated elapsed/total timing while dropping subtitle and `playId`, which may
  contain prompt content, file URLs or credentials;
- DTMF accepts only one `0-9`, `*`, `#` or `A-D` symbol, is redacted from `Debug` and remains
  transient rather than entering a durable projection accidentally;
- Hold and inactivity remain observations; neither can take RustPBX Call/Leg authority;
- transient speech/EOU/DTMF signals and durable content-free interruption/hold/inactivity
  observations all retain the Converact execution-generation fence;
- malformed confidence, event time, playback timing and DTMF fail with stable content-free codes;
- unknown upstream event tags continue to fail closed;
- existing command and private-client contracts remain green.

## Fresh verification

The machine-readable ledger is [verification.json](./verification.json). Fresh scoped results were:

- Active Call private client: 4 passed, 0 failed;
- Active Call command encoding: 2 passed, 0 failed;
- Active Call exact-wire mapping: 7 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- a live pinned Active Call process or dependency/runtime qualification;
- real microphone/RTP audio, VAD accuracy, endpointing quality or false-interruption behavior;
- measured barge-in stop latency, lost audio or TTS playback behavior;
- live DTMF collection, Hold/Resume, transfer or inactivity policy action;
- RustPBX, SIP/PSTN, RTP/SRTP, recording, CDR or Campaign call;
- performance, capacity, long-run, fault campaign, independent review and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
