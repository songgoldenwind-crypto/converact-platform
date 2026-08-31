# AI outbound R1 Active Call output-control evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract`
>
> Production eligibility: `false`

This record proves the bounded output-control command subset at Converact commit
`21858b3705a9d1d365d138ba255853169b9d365e`. The wire shape is derived from pinned Active Call
`0.3.83` commit `6224d948cc0941ac48b4a5426477aeaf639c2e98`. No live command was delivered.

## Observed scope

- Pause encodes exactly `{ "command": "pause" }`;
- Resume encodes exactly `{ "command": "resume" }`;
- Interrupt always encodes `graceful=false`, may omit fade entirely and bounds any fade to
  0–2,000 ms;
- an excessive fade fails with the stable content-free playback-timing code;
- the adapter command enum exposes no Hangup, REFER or Bridge variant, preserving RustPBX Call/Leg
  and media-plan authority;
- existing disclosure, event mapping and private client contracts remain green.

## Fresh verification

- Active Call private client: 4 passed, 0 failed;
- Active Call output/disclosure command encoding: 4 passed, 0 failed;
- Active Call event mapping compatibility: 7 passed, 0 failed;
- scoped Rust formatting: passed;
- scoped Rust Clippy with warnings denied: passed.

## Explicitly not run

- live Pause, Resume or Interrupt command delivery;
- real AI-to-human-to-AI ownership change or generation switch;
- Active Call process, RustPBX, SIP/PSTN, RTP/SRTP, audio/TTS or recording;
- barge-in latency, quality, performance, capacity, long-run, fault campaign, independent review
  and production deployment.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
