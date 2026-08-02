# G03 controlled host campaign — historical `.42` candidate

Status: retained historical evidence; **not** `.43` qualification and not
production eligibility.

This directory contains non-production evidence captured on the authorized
validation host. The tested native source pins were RustPBX
`6c49ee76baa54fdbf8f98020cc9bee158c7c15de`, rsipstack
`8318e97b1170de4e5245b120afec1cdf53e3d716` and rustrtc
`166c6d22984429eb6b509920c14fcd69f974f0b3`. The runtime candidate was
patchset `ivekit.42`; the latency and wire reports bind their exact source,
binary, patch-set and host fingerprints.

## Retained results

| Evidence | Result | Exact boundary |
| --- | --- | --- |
| `sipp-short-6655675-v2` | pass | 10 scenarios / 19 calls, UDP and TCP including reconnect, early CANCEL, non-2xx, timeout and one intentional retransmission; zero failed calls |
| `real-asterisk-peer-6655675-v1` | pass | one SIPp → RustPBX → Asterisk call; `183`, `200`, ACK and BYE completed; one router event and one CDR; zero active channels afterward |
| `sip-latency-29aa363-v4` | pass | 100 samples each: Trying p99/max `2/2 ms`, final p99/max `3/4 ms`, overload p99/max `1/1 ms`; one Trying per INVITE and Retry-After observed |
| `wire-differential-225b328-v4` | pass | all 22 frozen cases matched the contract: 18 unchanged accepted semantics, four explicit `G03-WIRE-SECURITY-001` tightenings, zero unexplained differences |
| `long-call-route-limit-preflight-fa4fd69-v1` | pass | corrected scenario verified for 66.258 seconds before the soak |
| `long-call-2h-fa4fd69-v2` | pass | one 7,201.346-second UDP call; UAC/UAS each report one success, zero failure and zero retransmission; one router event and one CDR |
| `long-call-225b328-v1` | failed attempt retained | the first scenario stopped after 34.048 seconds because of the test route duration ceiling; it is not counted as a product pass |

Raw logs, CSV distributions, JUnit reports and SHA-256 manifests are retained
alongside each result. The full container inspect was retained only for the
isolated Asterisk peer and exposes only the image `PATH`; repository secret
patterns were scanned before admission.

The two compiled wire-replay ELF files named by `BUILD-SHA256SUMS` are
deliberately excluded from Git. Their hashes, build logs, `file`/`ldd` output
and exact source inputs remain. `wire-replay/Cargo.toml`,
`wire-replay/Cargo.lock` and the canonical
`scripts/g03/rsipstack-wire-replay.rs` match the hashes in the retained input
manifests.

## Qualification boundary

These artifacts prove only the exact `.42` candidate. Patchset `.43` changes
protocol and Call-control mailbox behavior and therefore must repeat the
Linux build, frozen-wire, latency, interop, overload/fault and long-call gates.
Until that exact-source campaign is complete, `G03-E06`, `G03-E07`,
`G03-E10`–`G03-E13` remain `not_run` and production eligibility remains
`false`.
