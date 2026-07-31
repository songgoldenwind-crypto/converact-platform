# RustPBX and Kamailio sustained SIP validation

Date: 2026-07-24 (Asia/Shanghai)
Evidence level: controlled single-node signaling regression
Capacity claim: none

## Scope

This run validates the sustained SIP signaling path after the ivekit.18
RustPBX HTTP-capacity patch:

```text
SIPp -> Kamailio 6.0.7 -> RustPBX 0.4.11 ivekit.18
     -> authenticated HTTP router -> authoritative CDR sink
```

It measures call creation and completion, effective CPS, retransmissions,
Kamailio/Router/CDR count parity, route latency, queue-drop logs and coarse
container CPU. It does not carry RTP media and therefore does not measure voice
latency, jitter, packet loss, MOS, transcoding, recording continuity or media
node capacity.

## Fixed environment

| Item | Value |
| --- | --- |
| Host | DigitalOcean controlled validation VM |
| CPU | 4 vCPU, `DO-Regular`, x86_64 |
| Memory | 7.8 GiB |
| Kernel | Linux 6.8.0-124-generic |
| RustPBX source | `0.4.11@6c49ee76baa54fdbf8f98020cc9bee158c7c15de` |
| RustPBX image | `ivekit/rustpbx:0.4.11-ivekit.18-6c49ee76` |
| RustPBX image ID | `sha256:d36c5b94a1f63dfc5c1536f7bd00d6a23e5a3eecee26e6dfc7ebf3dd95c16b22` |
| RustPBX patch marker | `ivekit.18` |
| Kamailio image | `ivekit/kamailio:6.0.7-capacity-ced1eeb0` |
| SIP generator | SIPp 3.7.7 |
| Initial regression target | 1,000 new calls/s for 60 seconds |
| Frontier targets | 1,000/1,200/1,400/1,600, then 1,250/1,300/1,350 new calls/s |
| Allowed rate error | 3 percent |
| Route latency gate | P95 <= 150 ms; P99 <= 250 ms |

The SIPp non-2xx transaction uses a named INVITE transaction and an ACK whose
Via branch is copied from the original INVITE. This prevents transaction-layer
486 retransmissions caused by an invalid load scenario from being attributed to
Kamailio or RustPBX.

## Results

| Metric | Direct RustPBX | Through Kamailio |
| --- | ---: | ---: |
| Calls created | 60,000 | 60,000 |
| Successful calls | 60,000 | 60,000 |
| Failed / remaining | 0 / 0 | 0 / 0 |
| Retransmissions | 0 | 0 |
| Effective cumulative CPS | 992.129 | 990.900 |
| Router delta | 60,000 | 60,000 |
| CDR delta | 60,000 | 60,000 |
| Kamailio new INVITE delta | n/a | 60,000 |
| Route P95 | 3 ms | 8 ms |
| Route P99 | 5 ms | 19 ms |
| Queue-drop log lines | 0 | 0 |
| Kamailio error log lines | 0 | 0 |
| Result | passed | passed |

Maximum observed container CPU in the full-edge run was 101.23 percent for
Kamailio, 93.50 percent for RustPBX, 80.87 percent for the HTTP router,
51.98 percent for SIPp and 11.13 percent for PostgreSQL. Values are Docker's
multi-core percentages and are supporting diagnostics, not a utilization
release gate.

The machine-readable summaries are:

- `docs/evidence/wave3-rustpbx-direct-sip-capacity-2026-07-24.json`
  (`sha256:7212c29fae7b3f466bf4b29a74bae0cbcf283d479006bf8472d73825f093561c`)
- `docs/evidence/wave3-rustpbx-kamailio-sip-capacity-2026-07-24.json`
  (`sha256:f2258711d21cf18627e20c8e4d8363c1dc3ab1af20e06b47ff13d4543d2c2091`)

The complete raw run directories remain on the validation server:

```text
/opt/opc-wave123-validation-20260722/runs/sip-direct-control/
  sip-direct-q1000-60s-ivekit18-20260724/
/opt/opc-wave123-validation-20260722/runs/sip-kamailio-control/
  sip-kamailio-q1000-60s-ivekit18-fm-ackfixed-20260724/
```

## Frontier defect and correction

The first strict staircase passed 1,000 CPS but failed at 1,200 CPS after one
RustPBX HTTP-router send failure returned SIP 503. The Kamailio failure route
treated 503 as a hard destination-health failure. Three rapid responses crossed
the dispatcher probing threshold, removed the only RustPBX destination and
amplified the transient rejection into 3,999 failed calls. All 72,000 INVITEs
had reached Kamailio, so this was not generator or network loss.

The corrected policy distinguishes capacity rejection from node failure:

- 503 is a soft overload/dependency rejection. Kamailio tries another
  destination without changing the current destination's health state and
  returns a bounded 503 with `Retry-After` if no alternative exists.
- 408, 500, 502 and 504 remain hard health failures and mark the destination
  for active probing.
- INVITE and REGISTER use the same classification.

Focused configuration tests first reproduced the missing branch, then passed
`14/14` with the new policy.

## Corrected staircase

| Target CPS | Calls completed | Failed / remaining | Retransmissions | Route P95 / P99 | Result |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1,000 | 60,000 / 60,000 | 0 / 0 | 0 | 15 / 44.001 ms | controlled pass |
| 1,200 | 72,000 / 72,000 | 0 / 0 | 0 | 20 / 51.001 ms | controlled pass |
| 1,400 | 83,651 / 84,000 | 0 / 349 | 577 | 1,915.03 / 7,756.13 ms | controlled failure |

The 1,400-CPS run did not reproduce destination removal or 503 amplification.
Kamailio accepted all 84,000 INVITEs, but the shared four-vCPU host reached
approximately 386 percent aggregate CPU at P95 out of 400 percent, with a run
queue peak of 20. SIPp, Kamailio, RustPBX, the authenticated router and
PostgreSQL all competed in the same boot domain, so the failure class is
shared-host saturation and tail buildup. The fail-fast policy did not run
1,600 CPS.

The refinement run located the controlled shared-host boundary:

| Target CPS | Calls completed | Failed / remaining | Retransmissions | Route P95 / P99 | Host CPU P95 | Result |
| ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1,250 | 75,000 / 75,000 | 0 / 0 | 0 | 29 / 90.002 ms | 92% | controlled pass |
| 1,300 | 77,862 / 78,000 | 0 / 138 | 171 | 1,758.03 / 7,624.13 ms | 98% | controlled failure |

At 1,300 CPS all 78,000 INVITEs reached Kamailio and 78,007 Router/CDR events
were observed while delayed transactions drained. There were no Kamailio error
lines or queue-drop logs. The 1,350-CPS point was skipped by fail-fast.

Machine-readable evidence:

- `docs/evidence/wave3-sip-kamailio-frontier-led-off-2026-07-24.json`
  (`sha256:ff2a01b0e940802b5e76f086a70b8e5a3f2108bb3c58b7b5c6d8e54b54c9ac0b`)
- `docs/evidence/wave3-sip-kamailio-frontier-soft503-fix-led-off-2026-07-24.json`
  (`sha256:d62a56ab5491c8f6722bb000eb531302b35c4d444a41a732a6725f6b957b7fed`)
- `docs/evidence/wave3-sip-kamailio-frontier-refine-soft503-fix-led-off-2026-07-24.json`
  (`sha256:ecdb0866029422bc4dc91be5b0c4566961102649c4ea83a7812183c7d4634089`)

## Interpretation

This evidence accepts the ivekit.18 asynchronous-DNS and HTTP connection-pool
change for the sustained 1,000-CPS signaling regression gate. It also confirms
that inserting Kamailio preserves exact request and persistence accounting
without violating the route-tail-latency gate.

The corrected 1,250-CPS point is the highest sustained pass for this exact
shared-host setup. It is not a RustPBX-only maximum or a production release
capacity: the generator and every SUT component shared four vCPUs, the passing
point already used 92 percent host CPU at P95, and the scenario terminates with
486 without RTP media.

An independent generator/SUT run is required before comparing RustPBX with
FreeSWITCH or Asterisk. A fair comparison must keep the SIP transaction,
Kamailio edge, HTTP/CDR side effects, duration and host class identical, then
add separate G.711/SRTP, recording, transcoding, IVR and conference campaigns.
Long soak, overload/recovery, 1/2/4-node marginal scaling, RTP/PSTN/WSS,
recording failure injection, LiveKit/TURN, Tinode, RustDesk and
Cell-10K/MIX-100K remain separate gates. `capacity_claim` remains `none`.
