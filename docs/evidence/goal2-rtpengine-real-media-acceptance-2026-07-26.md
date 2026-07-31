# Goal 2 RTPengine Real Media Acceptance

## Scope

- Date: 2026-07-26
- Server: `64.225.122.227`
- Source commit:
  `3f2391d1f7e38359d0c5354517f8b364d29f6dc9`
- Isolated source:
  `/opt/opc-ivekit-goal2/task9-3f2391d/source`
- Runtime mode: `userspace`
- Capacity claim: `none`
- OPC production deployment: not modified
- LED deployment: not modified

This run validates Goal 2 Task 9 with real UDP media. It executes
offer/answer/delete through media-control and the iveKit RTPengine fork, sends
real timestamped PCMU RTP and RTCP without a sound device, repeats the media
path with SDES-SRTP, and exercises control-plane and RTPengine failures.

The raw machine-readable result is
`goal2-rtpengine-real-media-acceptance-2026-07-26.json`. Its SHA-256 is:

```text
834c9337f13c7207396bc8777c300631f5ee9fc6626e057f2994b3de609a9f9f
```

## Immutable Runtime Identity

| Artifact | Identity |
| --- | --- |
| OPC source | `3f2391d1f7e38359d0c5354517f8b364d29f6dc9` |
| RTPengine image | `sha256:6ded6283bcb553eb96e728c23048ec28aed12bc277c90db8daffd1ba22b1ecad` |
| media-control image | `sha256:a577170d319477daee1c90db90f1e11f55dbaf7ff1523a43744feee77f9cadc3` |
| Rendered RTPengine config | `sha256:cd571cbaa882ebb0d0ed8b611b80e206ece174e42704fb057ced2cefc744c54e` |
| RTPengine mode | `userspace` |

Both final images carry
`org.opencontainers.image.revision=3f2391d1f7e38359d0c5354517f8b364d29f6dc9`.
The RTPengine image retains the pinned upstream source and iveKit patch
identity from the Task 8 parent and replaces only files committed in the
recorded OPC revision.

## Acceptance Result

All 20 required checks passed:

- plaintext offer/answer and relay endpoint;
- bidirectional RTP packet count and payload integrity;
- sequence, SSRC, loss, jitter, first-packet time, and RTCP;
- SDES-SRTP negotiation and bidirectional encrypted media;
- absence of plaintext payload on the SRTP-facing wire;
- established-media continuity while media-control and admission were down;
- WAL-backed media-control restart recovery;
- idempotent delete;
- drain and hard-capacity rejection;
- stale-epoch rejection and higher-epoch takeover;
- before-write and after-write failure classification;
- RTPengine process failure classification.

### Plain PCMU And RTCP

| Metric | Endpoint A | Endpoint B |
| --- | ---: | ---: |
| Sent RTP packets | 500 | 500 |
| Unique received RTP packets | 500 | 500 |
| Lost packets | 0 | 0 |
| Duplicate packets | 0 | 0 |
| Out-of-order packets | 0 | 0 |
| Invalid packets | 0 | 0 |
| First packet | 121 ms | 120 ms |
| RFC 3550 jitter | 0.798 ms | 0.736 ms |
| RTCP sender reports received | 1 | 1 |
| Sent media octets | 80,000 | 80,000 |

The relay allocated ports inside the declared `36000-36100/udp` range. The
test uses 20 ms PCMU packets with monotonically advancing RTP timestamps and
does not require a server sound card.

### SDES-SRTP

| Metric | Endpoint A | Endpoint B |
| --- | ---: | ---: |
| Sent SRTP packets | 100 | 100 |
| Unique received packets | 100 | 100 |
| Lost packets | 0 | 0 |
| Duplicate packets | 0 | 0 |
| Out-of-order packets | 0 | 0 |
| Invalid/authentication failures | 0 | 0 |
| First packet | 54 ms | 53 ms |
| Jitter | 1.122 ms | 1.076 ms |
| Plaintext payload matches on wire | 0 | 0 |

The negotiated suite was `AES_CM_128_HMAC_SHA1_80`. The acceptance generator
derives RFC 3711 session material, authenticates every packet, decrypts at the
receiving endpoint, and separately verifies that the plaintext payload is not
present in the protected datagram.

## Failure And Recovery Matrix

### Control-Plane Outage

While the 500-packet plaintext stream was active, the acceptance runner
stopped both isolated admission and media-control containers for one second.
RTPengine remained running:

- packets received before the outage callback: `2`;
- packets received after the callback: `352`;
- relay port preserved after control-plane restart: `true`;
- WAL inode before restart: `13449420`;
- WAL inode after restart: `13449420`;
- query after restart: committed;
- delete: committed;
- exact delete replay: replayed.

This proves that an established userspace RTP flow does not depend on
media-control, admission, PostgreSQL, or the media-command WAL remaining
available on the packet path.

### Admission, Fencing, And Transport Failure

| Scenario | Result |
| --- | --- |
| New offer while drained | `terminal_error / transport_node_draining`, retryable |
| Offer beyond hard active-call limit | `rejected_capacity / transport_capacity_exhausted`, retryable |
| Query with stale owner epoch | `rejected_epoch / stale_owner_epoch`, not retryable |
| Query with higher owner epoch | committed |
| NG connection failure before write | classified retryable |
| NG disconnect after write | reconciled without blind duplicate mutation |
| RTPengine process stopped | `terminal_error / rtpengine_ng_connect_failed`, retryable |

The acceptance CLI now restarts only the explicitly prefixed isolated
RTPengine container before a run, clears drain, and requires
`ivekit-active-calls=0`. This prevents stale test state from being mistaken for
a capacity failure. Container names outside the configured
`ivekit-goal2-task9-` prefix are rejected before any lifecycle action.

## Local Regression

The source revision passed:

```text
Goal 2 tests: 109/109
Goal 1 tests: 68/68
TypeScript typecheck: passed
git diff --check: passed
```

The server-side acceptance runner also executes the exact focused regressions
for NG failure before write, excess work rejected before write, and disconnect
after write before it starts real media.

## Explicitly Not Run

The following capabilities are not inferred from this userspace relay result:

| Capability | Status | Reason |
| --- | --- | --- |
| Kernel forwarding | `not_run` | Task 9 selected userspace mode; host-specific module acceptance is separate |
| Recording | `not_run` | Independent recording and storage-failure acceptance remains later work |
| Transcoding | `not_run` | Independent codec/transcoding acceptance remains later work |
| Capacity benchmark | `not_run` | This is bounded functional acceptance, not a concurrency or throughput campaign |

## Isolation

The acceptance runner controlled only:

- `ivekit-goal2-task9-admission`;
- `ivekit-goal2-task9-media-control`;
- `ivekit-goal2-task9-rtpengine`.

All seven `led-platform-*` containers remained running and healthy after the
final run. No LED container, volume, image, configuration, or source file was
modified.
