# RTC Performance Contract v1

> Status: contract and finalizer implemented; controlled Tinode, SIP signaling and LiveKit evidence exists; production capacity remains `not_run`
> Updated: 2026-07-24

## 1. Decision

`Cell-10K` and `MIX-100K` use the same endpoint quality gates. A run passes only when load reconciliation, generator qualification, RTC quality, weak-network recovery, fairness, security overhead and required resource evidence pass together.

The canonical contract is `performance_contract` inside:

- `profiles/cell-10k-v1.json`
- `profiles/mix-100k-v1.json`

The profile SHA-256 and run manifest bind the complete contract. Editing a threshold, scenario, measurement scope or degradation order creates a different run identity.

## 2. Measurement Semantics

The hard-gate scope is `same_region_controlled_endpoint_to_endpoint`. Endpoint clocks use monotonic duration measurement and record observed NTP offset; P99 offset must remain within the contract.

| Metric | Start | End |
| --- | --- | --- |
| IM send-to-ack | client submits a unique message ID | sender receives authoritative ACK for that ID |
| SIP route | Kamailio accepts an initial request | selected upstream branch is emitted |
| SIP post-dial delay | caller sends INVITE | caller receives first 180/183/200 response permitted by the scenario |
| Voice mouth-to-ear | encoded source marker enters the sender audio path | decoded marker leaves the receiver playout path |
| LiveKit join | client starts authenticated room connect | participant is connected and subscribed transport is usable |
| First audio | room connect begins | first decoded remote audio frame reaches playout |
| First video frame | room connect begins | first complete decoded remote video frame is rendered |
| Glass-to-glass | visual source marker is captured | corresponding decoded marker is rendered remotely |
| Screen glass-to-glass | screen source marker is captured | corresponding shared-screen marker is rendered remotely |
| RustDesk input-to-photon | authorized input event is emitted | resulting visual marker is rendered by the controller |

Every latency family must submit P50, P95 and P99. Averages may be recorded but cannot satisfy a gate.

### 2.1 LiveKit startup phases and recovery controls

Browser evidence schema `1.7.0` separates connection setup into:

1. room connect start;
2. primary media publication complete;
3. required remote tracks ready;
4. first playout audio after remote-track readiness;
5. first rendered video frame after remote-track readiness.

`first_video_frame` is the first frame delivered by
`requestVideoFrameCallback`; visual-marker recognition remains the
glass-to-glass measurement and cannot delay or substitute the first-frame
timestamp. The playout-audio probe starts before video decoder setup so the
collector does not add an artificial audio startup delay.

Every LiveKit plan binds these controls:

| Field | Meaning | Capacity baseline |
| --- | --- | --- |
| `connection_preparation_mode` | `cold` opens signaling during connect; `signal_prewarmed` calls `prepareConnection` before the measured connect | `cold` |
| `receiver_jitter_buffer_target_ms` | Requested browser receiver jitter-buffer target; `0` preserves browser control | `0` |
| `subscriber_video_quality` | Requested subscription quality used to interpret received resolution and bitrate | `auto` |

Cold and signal-prewarmed results are separate profiles. A prewarmed diagnostic
cannot satisfy a cold-start capacity gate. A nonzero receiver buffer is valid
for a named weak-network profile, but its extra latency must remain visible in
the same evidence.

LiveKit server PLI recovery is an explicit deployment input:

```yaml
rtc:
  pli_throttle:
    low_quality: 100ms
    mid_quality: 100ms
    high_quality: 100ms
```

The renderer accepts
`CONVERACT_MEDIA_CONFIG_RTC_PLI_THROTTLE_{LOW,MID,HIGH}_MS`, bounds each value to
`50..5000`, and records the result in the standalone deployment summary.
The `100/100/100 ms` Converact Fabric profile is intentionally more aggressive than the
LiveKit sample configuration (`500/1000/1000 ms`). It must be evaluated with
keyframe traffic, egress bitrate, PLI/NACK counters, freeze ratio and
glass-to-glass tails; lowering the values is not independently considered an
optimization. Upstream reference:
<https://github.com/livekit/livekit/blob/master/config-sample.yaml>.

## 3. Quality And Reliability

The baseline contract covers:

- server-induced and endpoint packet loss;
- RTP/WebRTC jitter;
- video freeze ratio and freezes per minute;
- absolute audio/video synchronization error;
- voice MOS;
- connection, SIP setup and reconnect success;
- durable loss, duplicate delivery and out-of-order delivery after client deduplication;
- reconnect, bandwidth-step, network-handoff and node-failure admission recovery.

Counts whose target is zero are strict. A run cannot average away one durable loss, one unauthorized admission, one unbounded queue event or one established media termination.

## 4. Weak-Network Matrix

The five required profiles are:

| ID | Purpose |
| --- | --- |
| `baseline` | Controlled same-region reference |
| `constrained_bandwidth` | Verify bitrate adaptation and audio priority |
| `lossy_jitter` | Exercise loss concealment, NACK/FEC and jitter-buffer behavior |
| `network_handoff` | Inject a bounded blackout and verify reconnect/state convergence |
| `cross_region` | Record long-RTT behavior separately from the same-region latency gate |

Evidence must repeat the exact injected RTT, jitter, packet-loss, bandwidth and blackout values from the manifest. Each profile needs a positive sample count, reconnect ratio and P99 recovery time. Client crashes, unbounded queues and termination of established media fail the run.

## 5. Overload And Fairness

Queues are bounded and slow consumers are disconnected or degraded. The required degradation order is:

1. preserve audio;
2. reduce video layers;
3. reduce video frame rate;
4. drop auxiliary realtime copies such as translation or evidence taps;
5. reject new admission.

The run also reports Jain fairness and the P99 degradation caused by a noisy tenant or large room. Capacity from one hotspot cannot hide starvation elsewhere.

## 6. Security And Resource Cost

Authorization, rate-limit decisions and overload rejection have P99 budgets. New admission fails closed, while established media avoids synchronous remote authorization.

Every run records server CPU, memory per 1,000 connections, server egress, client CPU/memory, generator CPU/NIC and cost per 1,000 active interactions. These metrics are mandatory evidence; safe-density and scaling campaigns decide the final capacity and cost envelope.

## 7. Finalization

`scripts/capacity/performance-evaluator.ts` evaluates raw run-level evidence against the manifest contract. `scripts/capacity/evidence-validator.ts` combines that result with shard reconciliation and generator qualification. `scripts/capacity/orchestrator/run-finalizer.ts` stores the evidence and computed outcome in the immutable run evidence document.

A shard may still report its legacy `slo_passed` field for compatibility, but `true` cannot override any raw endpoint failure.

### Weak-network execution

`scripts/converact-capacity-network-impairment.ts` is a loopback-only sidecar. It applies the contracted profile bidirectionally with Linux `tc/netem`: the load-generator interface shapes upload and an IFB interface shapes download. RTT and jitter are split across both directions; loss and bandwidth are applied independently to each direction. The main capacity worker remains non-root with all capabilities dropped; only this sidecar receives `NET_ADMIN`.

The generator must call `POST /v1/apply` with its fenced run/shard/worker/lease identity, establish active sessions, then call `POST /v1/blackout` for a profile with `blackout_ms > 0`. Calling blackout before the measured sessions are established is invalid evidence. It must call `POST /v1/release` during cleanup. The sidecar rejects stale lease operations and rolls back partial qdisc changes.

The impairment evidence must record the sidecar receipt, profile values, active-session count immediately before injection, blackout start/end timestamps and post-impairment recovery samples. A successful `tc` command alone is not QoE evidence and cannot satisfy the finalizer.

## 8. Remaining Implementation

The contract and deterministic evaluator are implemented. The following remain before a real pass:

1. the Playwright WebRTC collector now measures real room join, decoded audio/video integrity,
   media-element playout audio, visual-marker glass-to-glass, loss, jitter, freeze and A/V sync.
   It emits a versioned distribution schema, sample counts and P50/P95/P99 for every currently
   collected family. The corrected 60-second TURN rerun captured remote audio with
   `HTMLMediaElement.captureStream()` and compared that playout timeline with rendered video;
   A/V-sync P95 was `56.9 ms`, `audio_endpoint_scope=playout`, and the formal result was
   `controlled_pass`. This is browser media-element playout, not a physical speaker or
   mouth-to-ear claim. Production sample floors, hardware playout, Egress and the weak-network
   matrix remain. Controlled independent screen sharing, a 3000 ms room-correlated CDP reconnect
   baseline, and a two-participant embedded TURN/UDP relay-only baseline now exist. Browser evidence
   schema `1.5.0` additionally distinguishes a multi-room reconnect storm from an ordinary
   reconnect by requiring exact affected-room count, aggregate injection-start spread, peak
   attempts in a sliding one-second window and multi-room CDP scope. A real two-room/four-client
   run started all reconnect attempts within `43.1 ms` and recovered `4/4`, but generator/host CPU
   P95 reached `86.90/91.18%`, so it is `invalid_generator_capacity` and not a capacity claim.
   TURN evidence
   schema `1.3.0` requires both the client
   `iceTransportPolicy=relay` configuration and WebRTC selected-candidate-pair stats proving a
   local `relay` candidate; declared participant counts alone fail closed. Multi-room screen/TURN
   capacity, TURN/TLS on 443 from an external network, a qualified independent-generator
   reconnect-storm rerun, full media failure,
   handoff, node restart and multi-node recovery remain. A subsequent one-room,
   two-browser 60-second diagnostic under symmetric `3 Mbps`, `5%` loss,
   `120 ms` RTT and `40 ms` jitter used signal prewarming, a `400 ms` receiver
   jitter-buffer target and `100/100/100 ms` PLI throttles. After correcting the
   first-frame and audio-probe measurement order, it produced join P99
   `1508.4 ms`, first-audio P99 `2093.6 ms`, first-rendered-video P99
   `2343.5 ms`, glass-to-glass P95/P99 `656.8/791.3 ms`, freeze ratio
   `4.2045%`, and `7.999` freezes/minute, with a formal `controlled_pass`.
   This is a weak-network diagnostic, not a capacity point: it used one room,
   did not prove independent generator/SUT hosts, and shared the server with
   unrelated LED containers. After those containers were stopped, a four-cell
   calibration compared cold/prewarmed setup and 0/400 ms receiver targets
   under the same impairment. Only signal-prewarmed + 400 ms passed; prewarming
   without buffering still froze 41.11 percent of the observation window,
   while cold + 400 ms missed only the profile G2G P99 gate. The matrix has one
   repetition per cell and therefore does not close repeatability;
2. the checksum-pinned official `lk load-test` capacity role, Linux process-tree observer and
   machine evaluator are implemented. The current same-host loopback staircase has a valid
   90-subscribed-track point; 160 and 250 tracks are invalid because shared-host CPU P95 exceeded
   98 percent. The observer now emits only a SHA-256 Linux boot-domain witness, and native evidence
   schema `1.2.0` can require different generator/SUT boot domains. Missing or equal witnesses are
   `invalid_generator_capacity`; legacy observations remain readable as topology-unverified.
   Schema `1.2.0` can also require an exact workload binding: a secret-free manifest reconciles the
   room topology, publishers, subscribers, participants and expected tracks against the observed
   `lk` executable and full argument-vector hashes. A same-host 3-video + 3-audio publisher,
   15-subscriber, 90-track large-room rerun passed with `workload_scope=verified`, zero loss and
   zero errors; it remains controlled evidence with no capacity claim.
   Browser schema `1.4.0` additionally fails multi-room evidence closed unless it includes
   low-cardinality Jain bitrate fairness, weakest-to-median bitrate and worst-room QoE gates. A
   four-room/eight-participant same-host run exercised that path, but generator/host CPU P95 reached
   `96.76/98.23%`, so it is `invalid_generator_capacity`. An LED-off rerun located the same-host
   boundary earlier: one browser room kept generator/host CPU P95 at `44.95/47.10%`, while two rooms
   reached `84.81/86.58%` and invalidated the generator. The workload-bound native staircase passed
   90/90 tracks at generator/LiveKit/host CPU P95 `30.53/12.44/62.63%`; 160/160 tracks transported
   without loss or errors but host CPU P95 reached `90%`, so the 250-track point was not run.
   Actual separate-host execution, qualified many-small-room and large-room campaigns, LiveKit
   failure frontier and 1/2/4/8-node scaling remain;
3. SIPp RTP sequence and throughput collectors are implemented and now
   reconcile calls, bidirectional packets, sequence gaps, duplicates, reorder
   and Linux UDP errors. The current `ivekit.19` same-host line passes through
   800 calls and fails closed at 900 as `mixed_or_inconclusive`. A physical
   endpoint marker collector for mouth-to-ear, jitter and MOS inputs remains;
4. RustDesk visual marker and authorized input-to-photon collector on two Windows endpoints;
5. Tinode collector is implemented and passed a real-process low-load protocol run plus a
   current-source controlled 100/250/500/1000 physical-connection staircase with strict connection
   and interaction start-rate gates; the failure frontier above 1000, node failure, reconnect storm,
   long soak and multi-node recovery remain;
6. real cross-region load fleet and server execution of the implemented network impairment sidecar;
7. resource/cost aggregator and low-cardinality dashboards;
8. real Provider latency and failure evidence for realtime ASR, translation, TTS and model calls.

The controlled LiveKit browser and native-capacity evidence is recorded in
`../evidence/wave3-livekit-capacity-server-validation-2026-07-24.md`. The machine-readable files are
`../evidence/wave3-livekit-browser-qoe-controlled-2026-07-24.json`, its distribution-contract rerun,
the independent-screen-track rerun, the CDP reconnect rerun, the initial forced-TURN run, its
corrected media-element playout rerun, the reconnect-storm rerun, and the 90/160/250-track native
results beside it. The
machine-readable set also includes the schema `1.4.0` four-room fairness run and the schema `1.2.0`
strict workload-bound native large-room rerun, four startup/buffer calibration runs, the LED-off
one/two-room browser staircase and the LED-off 90/160-track native staircase. The
camera-only, reconnect and initial forced-TURN browser results are `controlled_failed`; the
corrected forced-TURN playout result, historical 90-track native point and strict workload-bound
90-track native point are `controlled_pass`; the signal-prewarmed + 400 ms calibration and LED-off
90-track native point also pass their controlled contracts. The screen, reconnect-storm and LED-off
two-room browser results are `invalid_generator_capacity`; the historical 160/250-track and LED-off
160-track points are `invalid_generator_capacity`. The historical native files predate strict boot-domain witness collection and
therefore do not prove independent generator/SUT hosts; the new bound rerun supplies the missing
command/workload witness but intentionally remains in the same boot domain. Every file keeps
production capacity unclaimed. These complementary collectors cannot substitute for one another:
the browser runs supply endpoint camera/screen QoE, while the native role supplies efficient SFU
traffic and subscription accounting. The screen run passed its first-frame, bitrate and P95
glass-to-glass gates, but exceeded the browser-generator CPU qualification gate and still failed
camera bitrate, A/V sync and speaker-playout requirements. The reconnect run recorded 2/2 SDK
recoveries and restored new decoded audio/video in 2215.4 ms after a measured 3018.5 ms blackout;
its reconnect gates passed, while A/V sync and speaker playout kept the overall result failed. The
forced-TURN run proved 2/2 relay-only participants and 2/2 selected UDP relay candidate pairs from
browser stats, corroborated by LiveKit `connectionType=turn`; its initial run retained the mixed
decoded-audio/rendered-video failure for audit. The corrected rerun used captured media-element
playout audio, produced A/V-sync P50/P95/P99 `23.9/56.9/126.5 ms`, and passed every controlled
quality gate with `capacity_claim=none`. Physical speaker/mouth-to-ear, external TURN/TLS,
qualified independent-host weak-network repetitions and the LiveKit capacity
frontier remain open.

The Tinode protocol result is recorded in
`../evidence/wave3-tinode-capacity-collector-server-validation-2026-07-23.md`. The controlled
single-node staircase is recorded in
`../evidence/wave3-tinode-composite-frontier-2026-07-23.json` for the historical generator and
`../evidence/wave3-tinode-composite-strict-staircase-2026-07-23.json` for the current strict
generator. All keep
`capacity_claim=none`. The distributed manifest now represents one `tinode_websocket` physical shard
with `tinode_im` in `covered_workloads`; migration 100, command dispatch, PostgreSQL lease/outbox
persistence, the formal Tinode worker, per-workload reconciliation and the run finalizer preserve
that relation. The worker routes a covered connection shard through the composite runner and emits
separate connection and interaction evidence without opening an extra IM socket pool. A shared
immutable binding table selects each private bundle by exact `run_id + phase_id + shard_id` and
verifies its SHA-256; the provisioner supports the global connection and interaction ordinal ranges
needed by nonzero shards and derives account identities from global connection ordinals so campaign
namespaces cannot collide across shards. Production capacity remains `not_run` until those shard-specific bundles
are provisioned and exercised in an actual distributed campaign, independent observation is present,
the failure frontier is found, and every required collector/campaign executes on the target
environment.

The historical staircase remains immutable and bound to its recorded `tinode-composite.ts` SHA-256.
The current source prevents catch-up bursts, rechecks early timers before admission and records
connection/interaction start-window conformance. Its server capacity suite passed `191/191` with one
environment-gated PostgreSQL case skipped, and the separate real PostgreSQL migration/runtime test
passed `1/1`. The strict server staircase then passed all four configured points. At 1000 physical
connections it reconciled 1000 attempted/accepted/active/closed clients with Tinode
`LiveSessions=1000`, delivered all 1332 messages with zero loss/duplicate/out-of-order/error, held
100 connections/s and 33 interactions/s below their rolling-window ceilings, and recorded
connection-open P99 `9.603 ms`, delivery P99 `5.689 ms`, Tinode peak CPU `29.85%` and peak memory
`92,620,718.08` bytes on the recorded 4-vCPU/8-GB host. This proves the configured controlled ceiling,
not the failure frontier, independent-generator qualification, multi-node scaling or production
capacity.

## 9. Controlled RustPBX RTP Evidence

The pinned `ivekit.19` RustPBX image includes a separately pinned
`rustrtc@166c6d2...` patch. RTP and direct RTCP sockets accept bounded
per-socket receive/send buffer requests; the selected baseline is 1 MiB/512
KiB. An active-call `ss -m` observation recorded `rb=2 MiB` and `tb=1 MiB`,
which is Linux's doubled accounting for those requests, while an unrelated
default socket remained at 212,992 bytes.

On the shared 4-vCPU host:

- strict 10-call PCMU sequence evidence passed with zero durable loss, sequence
  gaps, duplicates or reorder;
- strict 150-call evidence was invalid because UAC completed 149/150 while both
  generators approached one full CPU; the established media still had zero
  sequence errors;
- controlled throughput passed at 600 and 800 calls with exact SIP
  reconciliation, zero retransmissions and zero UDP receive/send errors;
- 900 calls produced both generator and SUT/protocol signals, including 75
  receive-buffer errors, and is `mixed_or_inconclusive`;
- a 2-MiB receive-buffer diagnostic still failed and produced 242
  receive-buffer errors, so buffer growth is not accepted as the next scaling
  strategy.

The machine evidence and full interpretation are in
`../evidence/wave3-rustpbx-rtp-media-capacity-server-validation-2026-07-24.md`.
All files retain `capacity_claim=none`. An independent generator, boot-domain
witnesses and identical before/after profiles are required before worker or
socket sharding is implemented or a RustPBX node limit is stated.
