# Wave 3 RustPBX RTP media capacity server validation

> Date: 2026-07-24
> Result: controlled RTP regression passes through 800 same-host calls; production capacity remains unclaimed

## Scope

This validation covers the `ivekit.19` RustPBX candidate with the pinned
`rustrtc` UDP socket-capacity patch. It proves build identity, effective socket
configuration, low-load packet-sequence integrity and a controlled same-host
RTP throughput line. It does not prove an independent-generator node limit,
PSTN, SRTP, transcoding, recording, IVR, conferencing, multi-node scaling or
superiority over FreeSWITCH or Asterisk.

The SUT, SIPp UAC/UAS, Kamailio, Router fixture and PostgreSQL shared one
4-vCPU, 8-GB Linux host. Every machine report therefore declares
`capacity_claim=none`.

## Runtime identity

| Item | Value |
| --- | --- |
| RustPBX source | `6c49ee76baa54fdbf8f98020cc9bee158c7c15de` |
| rsipstack source | `8318e97b1170de4e5245b120afec1cdf53e3d716` |
| rustrtc source | `166c6d22984429eb6b509920c14fcd69f974f0b3` |
| Patch set | `ivekit.19` |
| Local image | `ivekit/rustpbx:0.4.11-ivekit.19-6c49ee76` |
| Image ID | `sha256:da8407a298fe782d082c1d1f0f63609e1958f6f3f04b98d70324b7ff68a288cb` |
| Builder | pinned Rust `1.94.1` image |
| Build result | `cargo build --locked --release`, passed in 20m43s |

The image is local controlled evidence. It has not been published under an
immutable registry digest and has no attached SBOM, signature or provenance.

## Implemented change

- Cargo globally patches crates.io `rustrtc` to the separately pinned local
  source, so RustPBX and indirect dependencies cannot silently select a second
  runtime implementation.
- RTP and direct RTCP sockets are created with `socket2` and optional bounded
  receive/send buffer requests.
- `RUSTRTC_UDP_RECEIVE_BUFFER_BYTES` and
  `RUSTRTC_UDP_SEND_BUFFER_BYTES` accept `65,536..16,777,216`; unset values
  preserve operating-system defaults.
- The controlled baseline, production Compose surfaces and both Helm surfaces
  expose the same settings. The selected baseline is 1 MiB receive and 512 KiB
  send.
- The throughput evaluator no longer labels every inbound under-rate as a
  generator failure. Simultaneous generator and SUT/protocol signals produce
  `mixed_or_inconclusive`.

During ten active calls, `ss -u -a -m` showed RTP/RTCP sockets with
`rb=2,097,152` and `tb=1,048,576`. Linux reports twice the requested 1-MiB and
512-KiB values. An unrelated default socket retained
`rb=tb=212,992`, which confirms that the observed increase came from the new
socket construction rather than a host-global sysctl change.

## Results

| Scenario | Result | Key evidence |
| --- | --- | --- |
| Strict sequence, 10 calls, 20s | `controlled_pass` | SIP 10/10 both sides, zero retransmissions, zero durable loss, gaps, duplicates or reorder; packet coverage `0.9989` |
| Strict sequence, 150 calls, 20s | `invalid_generator_capacity` | UAC 149/150, UAS 150/150; generators reached about 96% CPU; established media still had zero durable loss, gaps, duplicates or reorder |
| Throughput, 600 calls, 20s | `controlled_pass` | SIP 600/600 both sides, zero retransmissions and UDP errors; inbound/outbound coverage `1.00036/1.02031` |
| Throughput, 800 calls, 20s | `controlled_pass` | SIP 800/800 both sides, zero retransmissions and UDP errors; inbound/outbound coverage `0.99582/1.01538` |
| Throughput, 900 calls, 1-MiB receive | `mixed_or_inconclusive` | UAC 900/900, UAS 878/900, 117 retransmissions, 75 `RcvbufErrors`; same-host generator and SUT/protocol signals both present |
| Throughput, 900 calls, 2-MiB receive diagnostic | `mixed_or_inconclusive` | UAC 894/900, UAS 826/900, 136 retransmissions, 242 `RcvbufErrors`; increasing the ceiling did not produce a stable gain |

At the 800-call pass, RustPBX averaged `150.881%` CPU, peaked at `204.58%`
and used at most `441,869,926.4` bytes. The comparable `ivekit.18` run averaged
`151.502%`, peaked at `218.86%` and used about 444 MB. This single controlled
pair suggests no regression and a lower observed peak, but it is not enough to
claim a statistically significant performance improvement.

The 2-MiB diagnostic is intentionally retained as negative evidence. Per-socket
buffer growth does not solve sustained scheduler or packet-processing
contention, and its worst-case queue-memory ceiling scales poorly with call
count. The production default therefore remains 1 MiB/512 KiB.

## Decision

The `ivekit.19` socket patch is accepted as a bounded burst-tolerance and
observability improvement. The current repeatable same-host RTP throughput line
is 800 calls. The 900-call point is not accepted, and no single-node RustPBX
capacity is inferred from it.

The next media optimization gate requires:

1. independent generator and SUT hosts with separate boot-domain witnesses;
2. identical G.711/RTP packet rate and duration for before/after profiles;
3. CPU flamegraphs and scheduler/UDP-drop evidence before changing worker or
   socket ownership;
4. only then, a rustrtc shared-receive or worker-sharding change if attribution
   remains inside the SUT;
5. same-hardware FreeSWITCH and Asterisk A/B for signaling, RTP pass-through,
   SRTP, transcoding, recording, IVR and conference workloads.

## Evidence hashes

| File | SHA-256 |
| --- | --- |
| `wave3-rustpbx-ivekit19-image-inspect-2026-07-24.json` | `69e5f4313510731ce8c6e19f4aed4ec00a89d272b76c4bde8642600a39bf1bbc` |
| `wave3-rustpbx-udp-socket-host-observation-2026-07-24.txt` | `fb9ae3b15c8f9301277f7d277fb6f1f80aeaf3f9ff6ed6f7e314dfc105179342` |
| `wave3-rustpbx-rtp-strict-10-ivekit19-2026-07-24.json` | `5df7494e139c180eb621b27073cb056a8289fbb913e0aebf10995646d1f38cc8` |
| `wave3-rustpbx-rtp-strict-150-generator-bound-ivekit19-2026-07-24.json` | `c46237db150406ff7eeeb71e7afb4b77c775ee72863cdd85a6d7f01b6702ab3d` |
| `wave3-rustpbx-rtp-throughput-600-800-ivekit18-2026-07-24.json` | `09f85b9c53a5190e1204d00cef9a07d4ded828cb8a720ce1104e0649d25bbd0c` |
| `wave3-rustpbx-rtp-throughput-600-800-ivekit19-2026-07-24.json` | `4949eeb3cd6131388355205289e2ff141ceb0ba4e23ca79853f33f33ea24b429` |
| `wave3-rustpbx-rtp-throughput-900-mixed-ivekit19-2026-07-24.json` | `082e827ba84d3cf7a4b395b299628efbf1aa74a31d08f13e70b59262d6faebe3` |
| `wave3-rustpbx-rtp-throughput-900-rbuf2m-mixed-ivekit19-2026-07-24.json` | `0826ada8fb7b0355b07b375f17e05d69b9e9b0b22a9278109cfc60801532a869` |
