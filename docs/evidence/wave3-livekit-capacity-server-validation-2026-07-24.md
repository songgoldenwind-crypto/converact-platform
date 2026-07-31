# LiveKit controlled QoE and native capacity validation

Date: 2026-07-24 (Asia/Shanghai)
Evidence level: controlled same-host endpoint QoE and native SFU load
Production capacity claim: none

## Scope

This validation closes two different evidence paths:

1. a real Chromium/WebRTC endpoint collector measures join, first media,
   visual-marker glass-to-glass, packet loss, jitter, freeze and A/V sync;
2. the official LiveKit `lk load-test` role produces efficient pre-encoded
   media and subscriber fan-out while independent process observers record
   generator and LiveKit resource use.

The two paths are complementary. Native load cannot prove endpoint playback
quality, and one browser cannot establish SFU capacity.

## Fixed environment

| Item | Value |
| --- | --- |
| Host | DigitalOcean controlled validation VM |
| CPU | 4 vCPU, `DO-Regular`, x86_64, one NUMA node |
| Memory | 8,326,946,816 bytes; no swap |
| Kernel | Linux 6.8.0-124-generic |
| Network | same host, loopback `lo`, declared 1 Gbit/s |
| LiveKit | custom v1.13.4 ivekit.1 |
| LiveKit image | `ivekit/livekit-server:v1.13.4-ivekit.1-0b3fd288` |
| Image ID | `sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963` |
| Container network | host |
| Browser | Playwright 1.61.1, Chromium 149 |
| Native generator | official LiveKit CLI 2.18.1 |
| Native generator SHA-256 | `c58eee7eccf59348a2510e38af0771c4ce7286021b7bc02a25e7e69d0da07464` |
| Duration | 60 seconds per recorded point |

The browser collector SHA-256 is
`d5c693fb760a245d23efdc2f607e6889a9fefe44e0b661d545c9548f954291e5`.
That hash binds the first run below. The distribution-contract rerun uses
collector SHA-256
`8e5082333f8b6827d08753c59898c86f25966ed8fa3030e5f7e09e7fceebc49a`.
The independent-screen-track rerun uses collector SHA-256
`41f76e0c28c63c30f1efea9f8993556cc01c5932a63dc10634c19e9193392425`.
The CDP reconnect rerun uses collector SHA-256
`200534736360803c901a60d24334d9a68ebeb193d1e62e9424ba6992e796b39d`.
The forced-TURN rerun uses collector SHA-256
`8dc6d1efa4e13dcdda75d4a47ea651b743bb781f3b1906538a07c4e867827524`.
The Linux process-tree observer SHA-256 is
`9116d7d59bbbfc225a392eb5c560389b9365d818635142c836208424b9fc4408`.
The native parser and CLI SHA-256 values are respectively
`942f7246d76e23a2a3d1b218accec7a0536156ab380f064e26cf15a4dd9f5ee6`
and
`4ff2414583ea461f23f0409dac749aa0b914b28f4fad545eadee88a0149c839d`.

## Qualification rules

Native evidence is invalid as a capacity point when any generator gate fails:

- generator process CPU P95 exceeds 60 percent;
- generator-host CPU P95 exceeds 85 percent;
- generator NIC P95 exceeds 70 percent;
- the host reports packet drops;
- the generator exits nonzero or by signal.

After generator qualification, track reconciliation, CLI errors, packet loss,
LiveKit process CPU, SUT host CPU/NIC and SUT host drops are protocol/SUT gates.
The current same-host setup observes `lo` at host scope, so generator and SUT
NIC evidence is shared rather than independent.

The Linux observer now hashes `/proc/sys/kernel/random/boot_id` with SHA-256 and
stores only `host_witness_source=linux_boot_id_sha256` and the digest. It does
not retain the raw boot ID, hostname, machine ID or IP address. Native evidence
schema `1.1.0` adds `host_scope` and `distinct_hosts_required`. With
`--require-distinct-hosts true`, missing witnesses or equal generator/SUT
digests fail as `invalid_generator_capacity`; different digests produce
`host_scope=distinct_boot_domain`. Both observers must run at their respective
host level. Separate containers on one physical host are not an accepted
substitute, and this witness is topology evidence rather than hardware
attestation.

Historical schema `1.0.0` observations remain readable in non-strict mode and
are reported as `host_scope=unverified`. They retain their controlled low-load
value but cannot satisfy an independent-generator capacity claim.

All generated result files use exclusive creation, mode `0600`, and include
`capacity_claim=none`. The browser evidence predates that explicit field but
is documented here with the same no-claim boundary.

## Browser endpoint result

Input:

- one room and two participants;
- one 1280x720, 30 fps, 1.5 Mbit/s simulcast camera publisher;
- one 32 kbit/s Opus audio publisher;
- no screen, TURN, reconnect or Egress workload.

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Connected rooms / participants | 1 / 2 | 1 / 2 | pass |
| Join P95 / P99 | 341 / 341 ms | 3000 / 5000 ms | pass |
| First audio P99 | 936.9 ms | 1500 ms | pass |
| First video P99 | 1117 ms | 2000 ms | pass |
| Glass-to-glass P95 / P99 | 179 / 202.8 ms | 250 / 400 ms | pass |
| Endpoint packet loss P95 | 0 | 1 percent | pass |
| Jitter P95 / P99 | 6 / 6 ms | 20 / 30 ms | pass |
| Video freeze ratio / freezes per minute | 0 / 0 | 1 percent / 1 | pass |
| A/V sync absolute P95 | 111.7 ms | 80 ms | fail |
| Audio endpoint scope | decoded frame | media-element playout | fail |
| Generator / host CPU P95 | 47.29 / 47.03 percent | 60 / 85 percent | pass |
| NIC P95 / host drops | 0.43 percent / 0 | 70 percent / 0 | pass |

Formal result: `controlled_failed`, `failure_class=sut_or_protocol`.

The server has no usable speaker endpoint. Decoded-frame timing is retained as
diagnostic evidence but cannot satisfy the mouth-to-ear or first-audio playout
contract. The 111.7 ms A/V result remains a real failed gate; the threshold was
not relaxed.

### Distribution-contract rerun

The collector was then extended to emit a versioned distribution contract,
positive sample counts and P50/P95/P99 for every latency or quality family it
currently measures. The evaluator rejects a missing schema, missing samples in
required baseline families and internally unordered percentiles.

| Family | Samples | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: |
| Join | 2 | 329.3 ms | 329.5 ms | 329.5 ms |
| First audio decoded frame | 1 | 890.8 ms | 890.8 ms | 890.8 ms |
| First video frame | 1 | 1079.8 ms | 1079.8 ms | 1079.8 ms |
| Glass-to-glass | 60 | 77.2 ms | 161.3 ms | 213.5 ms |
| Endpoint packet loss | 2 | 0 | 0 | 0 |
| Jitter | 2 | 1 ms | 8 ms | 8 ms |
| A/V sync absolute | 60 | 19.7 ms | 84.5 ms | 120.6 ms |

This fresh 60-second run again completed one room and two participants with
zero packet loss, zero freezes and zero host drops. Generator/host CPU P95 was
`45.09%/46.60%`. Its formal result remains `controlled_failed`: A/V sync P95
`84.5 ms` exceeds the unchanged `80 ms` gate and audio scope remains
`decoded_frame`. One first-audio and one first-video sample are structurally
valid for this one-room smoke run but are not a statistically meaningful
production sample population.

### Independent screen-share rerun

The browser collector was then extended to publish and subscribe a real,
independent 1920x1080, 15 fps screen-share WebRTC track. A visual marker on a
dedicated screen canvas supplies first-screen-frame and screen
glass-to-glass distributions; camera and screen sender bitrate are measured
separately.

Input:

- one room and two participants;
- one 1280x720, 30 fps, 1.5 Mbit/s simulcast camera publisher;
- one 1920x1080, 15 fps, 2 Mbit/s screen publisher;
- one 32 kbit/s Opus audio publisher;
- no TURN, reconnect or Egress workload.

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Published audio / camera / screen tracks | 1 / 1 / 1 | 1 / 1 / 1 | pass |
| Subscribed tracks | 3 | 3 | pass |
| First audio P99 | 1484 ms | 1500 ms | pass |
| First video P99 | 1881.2 ms | 2000 ms | pass |
| First screen frame P99 | 1697.9 ms | 2000 ms | pass |
| Camera glass-to-glass P95 / P99 | 239.3 / 396.2 ms | 250 / 400 ms | pass |
| Screen glass-to-glass P95 / P99 | 223.2 / 315.4 ms | 300 ms / diagnostic | pass |
| Camera / screen average bitrate | 1.269 / 1.867 Mbit/s | 1.5 / 2 Mbit/s, +/-10% | fail / pass |
| Endpoint packet loss P95 | 0 | 1 percent | pass |
| Jitter P95 / P99 | 10 / 10 ms | 20 / 30 ms | pass |
| Video freeze ratio / freezes per minute | 0 / 0 | 1 percent / 1 | pass |
| A/V sync absolute P95 | 141.8 ms | 80 ms | fail |
| Audio endpoint scope | decoded frame | speaker playout | fail |
| Generator / host CPU P95 | 76.63 / 77.30 percent | 60 / 85 percent | fail / pass |
| NIC P95 / host drops | 0.86 percent / 0 | 70 percent / 0 | pass |

Formal result: `invalid_generator_capacity`, `failure_class=generator`.

The screen-specific first-frame, bitrate and P95 glass-to-glass gates passed,
and the run completed without endpoint loss, freezes or host drops. It is not
a valid capacity point because the browser generator CPU gate failed. Camera
bitrate, A/V sync and speaker playout also remain failed protocol/QoE gates.
This result closes the missing controlled screen instrumentation and baseline;
it does not establish screen-share capacity, weak-network quality or
production sample floors.

### Controlled endpoint reconnect rerun

Evidence schema `1.2.0` adds immutable reconnect provenance: injection scope,
planned and observed blackout duration, SDK attempt/success counts, recovery
endpoint scope and the recovery latency distribution. The browser waits for
decoded media before Chrome DevTools Protocol places the complete room page
offline; cleanup restores the network even when injection fails.

Input:

- one room and two participants;
- one 1280x720, 30 fps, 1.5 Mbit/s simulcast camera publisher;
- one 32 kbit/s Opus audio publisher;
- a 3000 ms room-correlated CDP endpoint blackout after media warmup;
- no screen, TURN or Egress workload.

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Connected rooms / participants | 1 / 2 | 1 / 2 | pass |
| Reconnect attempts / successes | 2 / 2 | 2 / 2 | pass |
| Reconnect success ratio | 1.0 | 0.999 | pass |
| Planned / observed blackout | 3000 / 3018.5 ms | exact plan / >=90% | pass |
| Recovery samples / endpoint | 1 / decoded audio+video | positive / decoded audio+video | pass |
| Reconnect recovery P99 | 2215.4 ms | 5000 ms | pass |
| Join P95 / P99 | 402.5 / 402.5 ms | 3000 / 5000 ms | pass |
| First audio / video P99 | 1017.8 / 1192.6 ms | 1500 / 2000 ms | pass |
| Glass-to-glass P95 / P99 | 181.9 / 265.2 ms | 250 / 400 ms | pass |
| Camera average bitrate | 1.460 Mbit/s | 1.5 Mbit/s, +/-10% | pass |
| Endpoint packet loss P95 | 0.0925 percent | 1 percent | pass |
| Jitter P95 / P99 | 6 / 6 ms | 20 / 30 ms | pass |
| Video freeze ratio / freezes per minute | 0 / 0 | 1 percent / 1 | pass |
| A/V sync absolute P95 | 119 ms | 80 ms | fail |
| Audio endpoint scope | decoded frame | speaker playout | fail |
| Generator / host CPU P95 | 52.12 / 54.96 percent | 60 / 85 percent | pass |
| NIC P95 / host drops | 0.43 percent / 0 | 70 percent / 0 | pass |

Formal result: `controlled_failed`, `failure_class=sut_or_protocol`.

The reconnect-specific gates passed: both clients re-established signaling and
new decoded audio and video markers arrived after the blackout. The first
diagnostic run counted zero attempts and two successes because LiveKit Client
2.20.1 emits `SignalReconnecting` when signaling is interrupted while media
remains viable; `Reconnecting` is additional only when media also fails. The
collector now de-duplicates both start events by room participant, and the
second run produced the result above. This is a controlled single-room
signal-reconnect baseline, not evidence for reconnect storms, media restart,
owner failover, network handoff or multi-node recovery.

### Controlled multi-room reconnect-storm rerun

Evidence schema `1.5.0` separates an ordinary reconnect from a reconnect
storm. It adds affected-room count, aggregate injection-start spread,
peak attempts in a sliding one-second window and an explicit
`multi_room_correlated_cdp_offline` scope. Individual room timestamps,
identities, room names and tokens are not retained. The packaged evaluator CLI
derives all expected counts and limits from the private process input and
writes evaluated evidence with mode `0600`.

Input:

- two rooms and four participants;
- one 1280x720 camera and one Opus publisher in each room;
- all four endpoints scheduled into a 1000 ms start window;
- a 3000 ms room-correlated CDP blackout;
- no screen, TURN or Egress workload.

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Connected rooms / participants | 2 / 4 | 2 / 4 | pass |
| Reconnect rooms / attempts / successes | 2 / 4 / 4 | 2 / 4 / 4 | pass |
| Injection start spread | 43.1 ms | at most 1000 ms | pass |
| Peak reconnect attempts per second | 4 | 4 | pass |
| Reconnect recovery P99 | 2263 ms | 5000 ms | pass |
| Endpoint loss P95 / jitter P95 | 0 / 12 ms | 1 percent / 20 ms | pass |
| Video freeze ratio | 0 | 1 percent | pass |
| A/V sync absolute P95 | 107 ms | 80 ms | fail |
| Generator / host CPU P95 | 86.90 / 91.18 percent | 60 / 85 percent | invalid generator |

Formal result: `invalid_generator_capacity`, `failure_class=generator`,
`capacity_claim=none`.

The storm-specific contract passed: all four clients entered the blackout
within 43.1 ms and recovered decoded audio and video. The shared 4-vCPU
generator/SUT host exceeded both CPU qualification gates, and A/V sync also
failed. This run proves the new collector/evaluator path, not qualified
reconnect-storm capacity. A separate browser-generator host is required for a
valid rerun.

### Controlled forced TURN/UDP rerun

Evidence schema `1.3.0` adds relay-only configuration count, selected candidate
pair count, selected relay pair count, transport scope and current round-trip
samples. The evaluator rejects a declared forced-TURN participant count unless
the browser both used `iceTransportPolicy=relay` and selected a local
`relay` candidate for every counted participant. Candidate addresses, TURN
URLs and credentials are not retained.

An isolated LiveKit v1.13.4 instance ran on the same controlled server with
embedded TURN/UDP on `13478`, relay ports `30000-30100`, signaling on `17880`,
and host networking. This avoids changing the earlier baseline container.

Input:

- one room and two participants, both configured relay-only;
- one 1280x720, 30 fps, 1.5 Mbit/s simulcast camera publisher;
- one 32 kbit/s Opus audio publisher;
- no screen, reconnect or Egress workload.

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Connected rooms / participants | 1 / 2 | 1 / 2 | pass |
| Relay-only configured / proven participants | 2 / 2 | 2 / 2 | pass |
| Selected / selected relay candidate pairs | 2 / 2 | exact equality | pass |
| Selected relay transport | UDP | known relay transport | pass |
| Candidate-pair RTT samples / P95 | 2 / 1 ms | positive samples | pass |
| Server connection type | TURN for both participants | TURN | pass |
| Join P95 / P99 | 490.8 / 490.8 ms | 3000 / 5000 ms | pass |
| First audio / video P99 | 1094 / 1270 ms | 1500 / 2000 ms | pass |
| Glass-to-glass P95 / P99 | 174.3 / 259.5 ms | 250 / 400 ms | pass |
| Camera average bitrate | 1.484 Mbit/s | 1.5 Mbit/s, +/-10% | pass |
| Endpoint packet loss P95 | 0 | 1 percent | pass |
| Jitter P95 / P99 | 6 / 6 ms | 20 / 30 ms | pass |
| Video freeze ratio / freezes per minute | 0 / 0 | 1 percent / 1 | pass |
| A/V sync absolute P95 | 81.5 ms | 80 ms | fail |
| Audio endpoint scope | decoded frame | speaker playout | fail |
| Generator / host CPU P95 | 43.04 / 44.39 percent | 60 / 85 percent | pass |
| NIC P95 / host drops | 0.86 percent / 0 | 70 percent / 0 | pass |

Initial formal result: `controlled_failed`, `failure_class=sut_or_protocol`.

All TURN-specific gates passed and the server independently logged
`connectionType=turn` for both participants. This is a same-host embedded
TURN/UDP correctness and QoE baseline. It does not prove TURN/TLS on 443,
external-network traversal, multi-room TURN capacity, weak-network relay
quality or a production failure frontier.

#### Media-element playout correction and 60-second rerun

The initial A/V metric mixed decoded audio frames with rendered video frames.
That comparison was diagnostic but not a valid playout A/V gate. A direct
`MediaElementAudioSourceNode` also yielded silence in headless Chromium even
though the element clock advanced. The collector now keeps
`MediaStreamTrackProcessor` solely for decoded-audio integrity and reconnect
proof, captures the remote audio element with `captureStream()`, analyzes that
captured playout stream through Web Audio, and compares its pulse marker with
the video element's `requestVideoFrameCallback` marker. Both A/V timestamps
therefore come from browser media-element playback/rendering timelines. This
does not claim physical speaker or mouth-to-ear measurement.

The same two-participant, relay-only, embedded TURN/UDP scenario was rerun for
60 seconds with the corrected collector:

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Connected rooms / participants | 1 / 2 | 1 / 2 | pass |
| Relay-only configured / proven participants | 2 / 2 | 2 / 2 | pass |
| Selected / selected relay candidate pairs | 2 / 2 | exact equality | pass |
| Selected relay transport / candidate RTT P95 | UDP / 1 ms | known / positive | pass |
| Join P95 / P99 | 615.2 / 615.2 ms | 3000 / 5000 ms | pass |
| First audio / video P99 | 1481.8 / 1505.9 ms | 1500 / 2000 ms | pass |
| Glass-to-glass P50 / P95 / P99 | 82.8 / 127.9 / 340.5 ms | - / 250 / 400 ms | pass |
| Endpoint packet loss P95 | 0 | 1 percent | pass |
| Jitter P95 / P99 | 5 / 5 ms | 20 / 30 ms | pass |
| Video freeze ratio / freezes per minute | 0 / 0 | 1 percent / 1 | pass |
| A/V sync absolute P50 / P95 / P99 | 23.9 / 56.9 / 126.5 ms | - / 80 / - | pass |
| Audio endpoint scope | media-element playout stream | playout | pass |
| Generator / host CPU P95 | 42.39 / 43.40 percent | 60 / 85 percent | pass |
| NIC P95 / host drops | 0.087 percent / 0 | 70 percent / 0 | pass |

Formal result: `controlled_pass`, `failure_class=none`, `reasons=[]`,
`capacity_claim=none`. The result closes the controlled browser A/V and
media-element playout gates. Hardware speaker, mouth-to-ear, external network
and capacity-frontier gates remain open.

## Many-small-room fairness result

Browser evidence schema `1.4.0` adds low-cardinality room-distribution gates.
It stores the room sample count, Jain camera-bitrate fairness, the weakest-room
to median-room bitrate ratio, and worst-room join, first media,
glass-to-glass, loss, jitter, freeze and A/V-sync values. It does not persist
room names or per-room records. Multi-room evidence using an older schema
fails closed rather than allowing one degraded room to hide inside an
aggregate percentile.

A 60-second same-host run used four rooms, two participants per room, one
camera and one microphone publisher per room, and eight real Chromium/LiveKit
participants. Collector and evaluator SHA-256 values were
`252983180f0d0a58af6de4bc1ec4cd85e0885eba6e12758b4b0976d04ba79fd9`
and
`0fe94c1754133fe5d100ae4b181e0862c209e155847594784a095eccaa4a53da`.

| Metric | Result | Gate | Outcome |
| --- | ---: | ---: | --- |
| Connected rooms / participants | 4 / 8 | 4 / 8 | pass |
| Published camera / audio / subscribed tracks | 4 / 4 / 8 | 4 / 4 / 8 | pass |
| Room quality samples | 4 | 4 | pass |
| Camera-bitrate Jain fairness | 0.9403 | at least 0.95 | fail |
| Weakest-room / median-room bitrate | 0.9445 | at least 0.8 | pass |
| Worst-room join P95 | 736.4 ms | 3000 ms | pass |
| Worst-room first audio / video P99 | 2127.4 / 1891.4 ms | 1500 / 2000 ms | audio fail |
| Worst-room glass-to-glass P95 | 554.2 ms | 250 ms | fail |
| Worst-room packet loss P95 | 0 | 1 percent | pass |
| Worst-room jitter P95 | 46 ms | 20 ms | fail |
| Worst-room freeze ratio | 3.078 percent | 1 percent | fail |
| Worst-room A/V sync absolute P95 | 465.8 ms | 80 ms | fail |
| Generator / host CPU P95 | 96.76 / 98.23 percent | 60 / 85 percent | invalid generator |

Formal result: `invalid_generator_capacity`, `failure_class=generator`,
`capacity_claim=none`. All rooms and tracks reconciled and host packet drops
were zero, but the shared generator/SUT host was saturated. The run proves the
new fairness and worst-room evidence path, not a four-room production capacity
point. A separate generator host is required for a qualified rerun.

## Native capacity staircase

All three points use one room, 20 participants admitted per second and a `3x3`
layout. Publishers and subscribers vary per step.

| Video + audio publishers | Subscribers | Tracks | Aggregate bitrate | Packet loss | Generator CPU P95 | LiveKit CPU P95 | Host CPU P95 | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 3 + 3 | 15 | 90/90 | 25.7 Mbit/s | 0 | 29.97% | 21.39% | 59.95% | `controlled_pass` |
| 4 + 4 | 20 | 160/160 | 77.7 Mbit/s | 0 | 43.92% | 43.72% | 98.50% | `invalid_generator_capacity` |
| 5 + 5 | 25 | 250/250 | 80.3 Mbit/s | 113, 0.011% | 46.38% | 42.68% | 99.00% | `invalid_generator_capacity` |

All points reported zero CLI errors and zero host packet drops. The 90-track
point is the highest valid point in this limited same-host staircase. The
160- and 250-track points demonstrate that subscriptions completed under host
saturation, but they do not locate the LiveKit failure frontier. A separate
load-generator host is required before increasing the load. The strict
boot-domain witness gate was implemented after these historical runs, so no
90/160/250 file is relabelled as an independent-host result.

## Workload-bound large-room rerun

The 90-track point was rerun after closing an evidence-integrity gap in the
native collector. Native evidence schema `1.2.0` now binds the evaluated result
to the exact `lk` executable SHA-256 and the SHA-256/count of its complete
argument vector. A separate schema `1.0.0` workload manifest parses that vector
fail-closed and records only low-cardinality load shape plus hashed room and
identity labels; URL, API key, API secret, room name, identity prefix and raw
arguments are not retained.

| Item | Observed |
| --- | ---: |
| Topology | one large room |
| Video + audio publishers | 3 + 3 |
| Subscribers / total participants | 15 / 21 |
| Subscribed tracks | 90/90 |
| Duration / start rate | 60 s / 20 participants/s |
| Aggregate / average subscriber bitrate | 25.9 / 1.7 Mbit/s |
| Packet loss / CLI errors / host drops | 0 / 0 / 0 |
| Generator / LiveKit / host CPU P95 | 12.56 / 16.41 / 48.45 percent |
| Generator / LiveKit loopback NIC P95 | 0.634 / 0.541 percent of 10 Gbit/s |
| Workload scope | `verified` |
| Formal result | `controlled_pass`, `capacity_claim=none` |

The executable and argument witnesses match across the command observer,
workload manifest and evaluator. Generator and SUT intentionally share one
Linux boot domain in this controlled baseline, so the result proves a
reproducible 90-track large-room path but not an independent-generator capacity
point or a failure frontier.

## Weak-network matrix

The Linux loopback impairment sidecar was executed on the validation server
with real Chromium/LiveKit media. Each run used one room, two participants, one
camera publisher and one audio publisher for 60 seconds. Evidence binds the
media result SHA-256 to the exact impairment lease, profile, apply timestamp,
measurement window and successful release timestamp. The sidecar restored
`lo` to `noqueue` and removed `ifbiv0` after every run.

| Metric | 2 Mbit/s, 40 ms RTT, 5 ms jitter | 3 Mbit/s, 120 ms RTT, 40 ms jitter, 5% loss | Gate |
| --- | ---: | ---: | ---: |
| Camera average bitrate | 0.727 Mbit/s | 0.469 Mbit/s | within 10% of 1.5 Mbit/s |
| Join P95 | 939.6 ms | 4525.7 ms | 3000 ms |
| First audio P99 | 2313.7 ms | 8650.2 ms | 1500 ms |
| First video P99 | 2088.1 ms | 8740.6 ms | 2000 ms |
| Glass-to-glass P95 / P99 | 378.5 / 1944.6 ms | 1919.1 / 3197.3 ms | 250 / 400 ms |
| Endpoint packet loss P95 | 0 | 14.37% | 1% |
| Jitter P95 / P99 | 34 / 34 ms | 47 / 47 ms | 20 / 30 ms |
| Video freeze ratio | 2.75% | 62.98% | 1% |
| Freezes per minute | 1.001 | 38.76 | 1 |
| A/V sync absolute P95 | 179.9 ms | 1357.2 ms | 80 ms |
| Generator / host CPU P95 | 27.02 / 31.03% | 29.17 / 37.50% | 60 / 85% |
| Host packet drops | 0 | 0 | 0 |
| Formal result | `controlled_failed` | `controlled_failed` | `controlled_pass` |

Both failures are classified as `sut_or_protocol`, not generator saturation.
The constrained-bandwidth run maintained zero observed packet loss but did not
meet startup, bitrate adaptation, tail latency, jitter, freeze or A/V-sync
gates. Bidirectional 5% `netem` loss produced 14.37% endpoint P95 loss and
severe media degradation. These runs close the execution/evidence gap but open
a real optimization gap around audio-priority adaptation, congestion-control
settling, NACK/FEC/RED behavior, jitter buffering, keyframe recovery and
fail-fast admission under unusable network conditions.

### Loss/jitter recovery rerun

The original loss/jitter failure remains immutable. A later 60-second rerun
kept the same one-room/two-browser topology and symmetric `3 Mbps`, `120 ms`
RTT, `40 ms` jitter and `5%` loss profile. It changed the receiver policy to a
`400 ms` jitter-buffer target, used signal prewarming, and ran LiveKit with
`100/100/100 ms` low/mid/high PLI throttles. The collector also fixed two
measurement defects: first video now means the first rendered frame rather
than the first recognized visual marker, and the playout-audio probe starts
before video decoder setup.

| Metric | Recovery rerun | Profile gate | Outcome |
| --- | ---: | ---: | --- |
| Join P95 / P99 | 1508.4 / 1508.4 ms | 3000 / 5000 ms | pass |
| First audio P99 | 2093.6 ms | 3000 ms | pass |
| First rendered video P99 | 2343.5 ms | 3000 ms | pass |
| Glass-to-glass P95 / P99 | 656.8 / 791.3 ms | 800 / 1200 ms | pass |
| Endpoint packet loss P95 | 5.003% | 7.5% | pass |
| Jitter P95 / P99 | 23 / 23 ms | 60 / 80 ms | pass |
| Video freeze ratio / freezes per minute | 4.205% / 7.999 | 10% / 10 | pass |
| Video frame gap P95 / P99 | 50.1 / 83.3 ms | 250 / 600 ms | pass |
| Maximum frame gap (diagnostic) | 583.2 ms | no independent gate | recorded |
| A/V sync absolute P95 | 95.6 ms | 300 ms | pass |
| Receiver FPS | 29.946 | at least 12 | pass |
| Generator / host CPU P95 | 26.41 / 36.64% | 60 / 85% | pass |

Formal result: `controlled_pass`, `failure_class=none`,
`capacity_claim=none`. This is a profile-specific weak-network diagnostic, not
a capacity point or a claim that the baseline SLO was relaxed. Cold-start,
browser-default buffering, multiple repetitions, independent generator/SUT
hosts and the capacity frontier remain open. Unrelated LED containers were
still running on the validation host, which is another reason not to infer
capacity from this result.

## Startup and receiver-buffer calibration

After the LED services were stopped, the same four-vCPU validation server ran
a controlled four-cell calibration. Every cell used one room, two real
Chromium/LiveKit participants, one camera and one microphone publisher for 60
seconds under symmetric 3 Mbit/s, 120 ms RTT, 40 ms jitter and 5 percent
packet loss. LiveKit retained the 100/100/100 ms low/mid/high PLI throttle.
Only connection preparation and the receiver jitter-buffer target changed.

| Preparation / buffer | Join P99 | First audio / video P99 | G2G P95 / P99 | Freeze ratio / per minute | A/V sync P95 | Generator / host CPU P95 | Result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| cold / 0 ms | 2411.8 ms | 3123.7 / 3796.6 ms | 690.7 / 923.5 ms | 49.01% / 62.99 | 390.8 ms | 22.03% / 26.40% | `controlled_failed` |
| cold / 400 ms | 1384.3 ms | 2212.1 / 2386.8 ms | 701.3 / 1355.7 ms | 9.71% / 7.00 | 69.4 ms | 25.35% / 32.16% | `controlled_failed` |
| signal-prewarmed / 0 ms | 1338.4 ms | 2062.1 / 2217.6 ms | 738.9 / 972.5 ms | 41.11% / 88.00 | 441.7 ms | 23.00% / 24.61% | `controlled_failed` |
| signal-prewarmed / 400 ms | 2284.3 ms | 2828.0 / 2993.0 ms | 620.1 / 685.6 ms | 3.74% / 8.00 | 64.9 ms | 24.30% / 26.46% | `controlled_pass` |

The phase fields explain the separation of concerns. Signal prewarming keeps
connection and media-publication setup inside the profile's startup budget,
while the 400 ms receiver target is what controls freeze and A/V-sync under
this impairment. Prewarming without the receiver buffer still froze 41.11
percent of the observation window. The combined profile is therefore the only
passing cell, but one repetition per cell is calibration evidence, not a
repeatability or production-default claim. The cold/0 ms baseline remains
deliberately preserved and failed.

## LED-off same-host staircase

The pressure window then used the otherwise idle server with only the baseline
LiveKit and TURN containers running. Browser and native generators still
shared the same Linux boot domain as LiveKit, so every result remains
controlled evidence with `capacity_claim=none`.

### Browser many-small-room boundary

The browser staircase used signal prewarming, a 400 ms receiver target,
720p30 camera sources, two participants per room and the strict clean-network
contract inherited from the earlier many-room run.

| Rooms / participants / subscribed tracks | Generator CPU P95 | Host CPU P95 | Loss / freezes | Result |
| ---: | ---: | ---: | ---: | --- |
| 1 / 2 / 2 | 44.95% | 47.10% | 0 / 0 | `controlled_failed` |
| 2 / 4 / 4 | 84.81% | 86.58% | 0 / 0 | `invalid_generator_capacity` |

The one-room point failed the old 250/400 ms G2G gates at 467.6/505.5 ms and
missed the 80 ms A/V gate by 2.5 ms; those gates conflict with an explicit
400 ms receiver-buffer profile and are not treated as a server-capacity
failure. At two rooms all tracks connected and endpoint loss and freezes
remained zero, but generator and host CPU exceeded the 60/85 percent
qualification limits. The planned four- and six-room browser points were
therefore not run. A separate browser-generator host is required.

### Native SFU track boundary

The checksum-pinned official `lk` role then used one large room, high
resolution, mixed codecs, simulcast, speaker simulation and 20 participants/s.
The secret-free workload manifest verified the executable and complete
argument vector for both points.

| Video + audio publishers | Subscribers / tracks | Aggregate bitrate | Loss / errors | Generator / LiveKit / host CPU P95 | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 3 + 3 | 15 / 90 | 26.0 Mbit/s | 0 / 0 | 30.53% / 12.44% / 62.63% | `controlled_pass` |
| 4 + 4 | 20 / 160 | 48.7 Mbit/s | 0 / 0 | 43.72% / 20.83% / 90.00% | `invalid_generator_capacity` |

The 160-track point delivered 160/160 subscriptions without packet loss,
CLI errors or host packet drops, but same-host CPU crossed the 85 percent
qualification limit. The 250-track point was intentionally not run. Thus 90
tracks is the highest qualified same-host point in this window; 160 tracks is
only a successful transport observation, not a qualified capacity point or
the LiveKit failure frontier.

## Official Helm production profile

The official `livekit/livekit-helm` server chart was vendored from exact commit
`8f0ad0809c2be8cbed375a6f8bef10625e5e8a2b`. The iveKit delta adds external
Valkey password/TLS Secret mounts, zone spreading and a PodDisruptionBudget.
The production profile requires a manifest-digest image, host networking,
eight requested CPUs with no CPU limit, a 2-to-32 HPA, 10,001 RTC UDP ports,
the validated 100/100/100 ms PLI policy, hard hostname anti-affinity and hard
zone spreading.

On the validation server, checksum-pinned Helm `v4.2.1` passed profile
validation, `helm lint` and `helm template`. Structured inspection found eight
rendered objects, digest-bound image use, API/Valkey credentials sourced from
Secrets, Valkey TLS mounted from a Secret, no password in the ConfigMap, no CPU
limit, a zone spread constraint, PDB `minAvailable: 1`, and HPA bounds 2 to 32.
The resolved digest was an explicit fixture used only for static rendering.
No Kubernetes runtime was executed, so install, rollout, autoscaling,
multi-zone placement and node-failure behavior remain `not_run` and
`capacity_claim=none`.

## Machine evidence

| File | SHA-256 |
| --- | --- |
| `wave3-livekit-browser-qoe-controlled-2026-07-24.json` | `a5489933f4ac4673846c8d72e77a684b1bcedc9eda776bd0aedc3a6d512172a1` |
| `wave3-livekit-browser-qoe-distributions-controlled-2026-07-24.json` | `b5b6d4b52dca661792d172bc57bec31731ca83c2efdaf19d1ac06d7c00574476` |
| `wave3-livekit-browser-screen-controlled-2026-07-24.json` | `3ced1553622cfaaf7c4f6b6da8c812c227dad683443087ebbd33019fdf0a0713` |
| `wave3-livekit-browser-reconnect-controlled-2026-07-24.json` | `bd937ee1737acdf4740ae0fc70fd7ef1abbb264f42a3107652fbe94b699d6b07` |
| `wave3-livekit-browser-reconnect-storm-controlled-2026-07-24.json` | `149b78aa89feee8350c166e3af839df62c0a1be124171ef572bfd6a512238c68` |
| `wave3-livekit-browser-forced-turn-controlled-2026-07-24.json` | `6273e6c90aeac351e7bddfff9d94eb5b447f663541fbf9c10d24b2ae79191c47` |
| `wave3-livekit-browser-forced-turn-playout-controlled-pass-2026-07-24.json` | `21107ce8da24159665d7a15c2e0d92ff3c23bb3486a552928ba25cd4e3d00106` |
| `wave3-livekit-browser-manyrooms-fairness-controlled-2026-07-24.json` | `64ecd11375b563628ac61f3b126a20eb4e329d84e3bc64cb468c70472d028641` |
| `wave3-livekit-native-capacity-90-tracks-2026-07-24.json` | `85ca150ac977f0b65bf34641f536217e5d90739fac1b5a8a2e4c88a8e88c2998` |
| `wave3-livekit-native-capacity-160-tracks-2026-07-24.json` | `32d9ffbdd9e935ec6f521db91c0dc84d489dc1b13fa07f392435c2762c81db8f` |
| `wave3-livekit-native-capacity-250-tracks-2026-07-24.json` | `f61f3327a8dc340d4a853094cb085ea51d3355e8161cf0e16672ca785bdf924a` |
| `wave3-livekit-native-large-room-bound-controlled-2026-07-24.json` | `5f61961004d61f35b5e04faf8a27cd20c4b0333f72ec8e86e71118ab221428fa` |
| `wave3-livekit-network-bandwidth-controlled-2026-07-24.json` | `0ff9c532eacf51aa46476b91a78cf54ae1fd5f4c8164b4fdd1111a42d9ec0e10` |
| `wave3-livekit-network-loss-jitter-controlled-2026-07-24.json` | `a04d9c1e6091f9aa8cdac4397a61889ce7b81141cc0c18fdb91c6fd4b4b39ead` |
| `wave3-livekit-network-loss-jitter-first-frame-controlled-pass-2026-07-24.json` | `0398f6e128ec3d9c9ef0458a3abfdc69360059dac4d8e48400b0f40b2ceb5912` |
| `wave3-livekit-calibration-cold-buffer0-network-controlled-2026-07-24.json` | `e49f3b1ca952fc32c7ab92f84e5d4979b968d89c17c453b751d062ae5228d009` |
| `wave3-livekit-calibration-cold-buffer400-network-controlled-2026-07-24.json` | `cc3f33065b76f506d314da9fde4d3a01b2d3e0317d6b06c07401a6ca0abd0211` |
| `wave3-livekit-calibration-prewarmed-buffer0-network-controlled-2026-07-24.json` | `07793448da2f2328fadef69fee1845f80930e00637c2b6a276560fa049e38163` |
| `wave3-livekit-calibration-prewarmed-buffer400-network-controlled-2026-07-24.json` | `7e97a7b8fb4fd71947318ec7ea0fd44598b12a93138319a793635a9c0f83e0e1` |
| `wave3-livekit-browser-staircase-r1-led-off-controlled-2026-07-24.json` | `050beb889c6e47b7d6c4a2a6eb0f10128f0ac8ed664ddc736c76ee3caf517a98` |
| `wave3-livekit-browser-staircase-r2-led-off-controlled-2026-07-24.json` | `03af59d5644fe67dd9ad17e4772bf9da54d07bb0e862992f5e0ba7450a07f6fb` |
| `wave3-livekit-native-capacity-90-tracks-led-off-2026-07-24.json` | `5301c08632473aba0521aaff898350259a4036606af03f57419b211cb0a567ee` |
| `wave3-livekit-native-capacity-160-tracks-led-off-2026-07-24.json` | `2f8716bc85581b050d64d536033e0e0dc990c8dec6642dd0113f500e2541b85a` |
| `wave3-livekit-official-helm-profile-server-validation-2026-07-24.json` | `88b0d043172cea3593573f9a7ab504002630f07e1ddce97071f790940fd6e5bf` |

The complete raw run directories remain on the validation server under:

```text
/opt/opc-wave123-validation-20260722/runtime/
  livekit-browser-observed-hostcpu-60s-20260724/
  livekit-browser-distributions-60s-20260724/
  livekit-browser-screen-60s-20260724/
  livekit-browser-reconnect-60s-20260724/
  livekit-browser-reconnect-60s-r2-20260724/
  livekit-browser-reconnect-storm-r2-p4-60s-20260724-r1/
  livekit-browser-turn-60s-r1-20260724/
  livekit-browser-turn-captured-playout-60s-r9-20260724/
  livekit-browser-manyrooms-fairness-r4-60s-r2-20260724/
  livekit-native-v3-a3-s15-3x3-60s-20260724/
  livekit-native-v4-a4-s20-3x3-60s-20260724/
  livekit-native-v5-a5-s25-3x3-60s-r2-20260724/
  livekit-native-large-room-bound-3v3a15s-60s-20260724-r1/
  livekit-browser-weak-bandwidth-r2-60s-20260724/
  livekit-browser-weak-loss-jitter-r1-60s-20260724/
  livekit-browser-netns-loss-jitter-r35-first-frame-audio-priority-400ms-replica1-60s-20260724/
  livekit-browser-calibration-cold-buffer0-r1-20260724/
  livekit-browser-calibration-cold-buffer400-r1-20260724/
  livekit-browser-calibration-prewarmed-buffer0-r1-20260724/
  livekit-browser-calibration-prewarmed-buffer400-r1-20260724/
  livekit-browser-staircase-r1-prewarm400-60s-20260724/
  livekit-browser-staircase-r2-prewarm400-60s-20260724/
  livekit-native-staircase-90tracks-led-off-60s-20260724-r1/
  livekit-native-staircase-160tracks-led-off-60s-20260724-r1/
```

## Verification

- media evaluator, browser/native collector, CLI, process observer, strict
  host-witness and pinned dependency tests on Linux: `53/53`;
- strict native workload parser, secret-free manifest, command binding,
  tamper rejection and real Linux observer focused regression: `22/22`;
- browser schema `1.5.0` reconnect-storm aggregation, fail-closed evaluator
  and private non-overwriting CLI focused regression: `32/32`;
- network impairment plan, fenced controller, loopback HTTP sidecar, decimal
  lease epoch, release timestamp and LiveKit evidence binding: `10/10`;
- repository TypeScript: `tsc --noEmit`, exit code 0;
- every server `evaluated.json`: mode `0600`;
- no local Docker execution was used for this validation.

## Remaining gates

The following remain `not_run` and prevent any production capacity claim:

- execute strict evidence collection on separate generator and SUT hosts, then
  run the 160/250+ failure-frontier search; the code gate is implemented but
  the real two-host campaign is `not_run`;
- qualified independent-generator many-small-room rerun and large-room
  distribution campaigns; the same-host four-room evidence path is exercised
  but invalidated by generator saturation;
- hardware speaker/mouth-to-ear endpoint evidence and production minimum
  sample floors; browser media-element playout is controlled-pass only;
- multi-room screen-share and TURN capacity/weak-network evidence, external
  TURN/TLS on 443, Egress and recording failure;
- qualified independent-generator reconnect-storm capacity, full media
  failure, network handoff, media/node restart, owner failover and multi-node
  recovery; the same-host two-room storm path is exercised but invalidated by
  generator saturation;
- weak-network handoff and cross-region; constrained bandwidth remains failed,
  while the profile-specific loss+jitter recovery rerun passed once and still
  requires cold/default-buffer comparison, repetitions and qualified
  independent-host reruns;
- long soak, overload/recovery, fairness and noisy-tenant isolation;
- 1/2/4/8-node scaling efficiency and Cell-10K/MIX-100K campaigns.
