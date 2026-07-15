# iveKit RustPBX image

This directory builds the RustPBX image used by iveKit Voice Foundation.

## Why it exists

RustPBX `0.4.11` uses rsipstack `0.5.18`. The upstream transport cache keeps a
closed outbound TCP connection and the next call to the same SIP target can fail
with `Broken pipe`. The included patch removes only the matching stale connection
and retries one failed TCP transaction send on a new connection.

The build also pins `rustrtc` to `0.3.90`. RustPBX commit `6c49ee76` was written
for that API, while an unconstrained Cargo resolution currently selects `0.3.91`.

RustPBX `0.4.11` returns AMI dialogs without identifiers. The iveKit AMI patch
adds the SIP `call_id`/`dialog_id` and active-call registry entries so a timed-out
RWI originate can be reconciled by the deterministic `call_id` supplied by the
client. The endpoint remains protected by the existing AMI authentication and
network allowlist.

The upstream RWI originate command handler only cancelled its task after
`call.hangup`; it did not terminate the established SIP dialog. The iveKit RWI
hangup patch sends CANCEL before answer and BYE after answer, so a successful
hangup command also clears the downstream SIP leg.

## Reproducibility

- RustPBX: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- Rust builder: pinned by digest in `build.sh`
- Cargo dependency graph: `Cargo.lock`, built with `--locked`
- Runtime base: pinned by digest in `Dockerfile.runtime`

Run on a native amd64 or arm64 Docker host:

```bash
npm run ivekit:rustpbx-build
```

Override the output image with `IVEKIT_RUSTPBX_IMAGE`. Cross compilation is
rejected so an image cannot be mislabeled with binaries from another architecture.

## Acceptance

The delivery bundle exposes three separate engineering checks:

```bash
npm run ivekit:rustpbx-management-acceptance
npm run ivekit:rustpbx-rwi-acceptance
npm run ivekit:rustpbx-sipp-acceptance
```

The RWI check authenticates with the production client, runs `session.list_calls`,
originates with a deterministic call ID, finds that ID through AMI, and hangs up
the same call. Acceptance must also observe the downstream SIPp UAS receiving
BYE; the RWI command result alone is not sufficient evidence. This proves
signaling and reconciliation, not RTP media quality.

`npm run ivekit:rustpbx-sipp-acceptance` includes `answer-tcp` followed by
`answer-tcp-reconnect`. The downstream SIPp UAS is destroyed between the two
calls while RustPBX remains running. Both scenarios must pass with Router and CDR
evidence.
