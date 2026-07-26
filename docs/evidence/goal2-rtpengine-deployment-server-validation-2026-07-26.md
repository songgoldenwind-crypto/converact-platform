# Goal 2 RTPengine Deployment Server Validation

## Scope

- Date: 2026-07-26
- Server: `64.225.122.227`
- Final source commit: `754ae01`
- Isolated source: `/opt/opc-ivekit-goal2/task8-754ae01/source`
- Existing OPC production deployment: not modified
- LED deployment: not modified

This run validates Goal 2 Task 8 deployment and restart behavior. It does not
claim real RTP, RTCP, SRTP, recording, transcoding, or kernel-mode acceptance;
those remain Task 9 checks.

## Initial Failure And Root Cause

The first server image from commit `0ad9ee9` exited with code `13` and:

```text
Warning: Detected unsettled top-level await
```

Runtime socket evidence showed TCP port `8080` only, while `22222` existed only
in `/proc/net/udp`. The media-control client uses persistent TCP NG, but the
RTPengine template configured only `listen-ng`, which is UDP. Connection
refusal then entered an unreferenced retry delay, allowing Node to exit before
the request deadline.

Commit `754ae01` fixes both causes:

- adds `listen-tcp-ng` and `IVEKIT_RTPENGINE_LISTEN_TCP_NG`;
- keeps active request, connect-deadline, and reconnect timers referenced;
- corrects C-fork capacity environment names to
  `IVEKIT_RTPENGINE_MAX_ACTIVE_CALLS` and
  `IVEKIT_RTPENGINE_GUARD_MAX_ENTRIES`;
- bounds replay SDP state with
  `IVEKIT_RTPENGINE_REPLAY_SDP_MAX_BYTES`.

The child-process regression now waits for and reports a classified NG
connection failure instead of exiting with code `13`.

## Immutable Artifacts

| Artifact | Identity |
| --- | --- |
| RTPengine verified parent | `sha256:13c3eb5e17b63dea05a33b2628de9a43e8b18cc495ce2fc148db6c9c852c017a` |
| RTPengine Task 8 runtime | `sha256:b8191d67229aec34bdb698afc71b87d60f27ff2c7103ba20713ff3e71606821c` |
| media-control Task 8 runtime | `sha256:6ee480204e5edccd939dded4760a2fca9856a58638012e8c047ca190ecf30c82` |
| Helm runtime | `alpine/helm@sha256:e7ecbf4a200dea73d64bfb8cb0936829164945f2b4d02a0274093073ee8d264f` |

The Task 8 RTPengine image reuses the previously compiled and protocol-tested
binary and replaces only the committed entrypoint and configuration template.
Task 10 will produce the final full-build provenance and signatures.

## Results

### Helm

The userspace and kernel values profiles both passed real Helm `3.18.4` lint
with digest-pinned images. The only informational output was the optional
Chart icon recommendation.

### RTPengine Runtime

`/proc/net/tcp` showed listeners on:

- `0.0.0.0:22222` for persistent TCP NG;
- `0.0.0.0:8080` for metrics.

The daemon log confirmed the exact configured bounds:

```text
runtime-mode=userspace
active-call-limit=1000
guard-entry-limit=16000
replay-sdp-byte-limit=16777216
```

The real `ivekit drain` command completed successfully through the TCP NG
client.

### media-control And WAL

media-control started with:

```text
transport=rtpengine production=false mtls=false
```

`GET /livez` returned HTTP `200`. `GET /readyz` returned HTTP `503` because
the isolated run deliberately used an unreachable admission endpoint. This is
the expected fail-closed readiness result.

The dedicated WAL volume contained:

```text
/wal                         1000:1000 0700
/wal/media-command.wal       1000:1000 0600
/wal/media-command.wal.lock  1000:1000 0600
```

Before and after restarting only media-control:

- WAL inode remained `13449437`;
- RTPengine container ID remained
  `6811a74541967e1f617d2b562394f964d1f38807a4ecf564a2df50d9a82bc9ae`;
- RTPengine PID remained `212881`;
- RTPengine `StartedAt` remained
  `2026-07-26T03:02:27.288171617Z`;
- media-control logged a graceful `SIGTERM` stop and restarted successfully;
- `/livez` remained HTTP `200`.

This proves media-control recreation does not recreate the RTPengine process
and the durable WAL survives the control-container lifecycle. Task 9 will
repeat the restart while real RTP packets are flowing.

## Cleanup And Isolation

The two isolated containers, isolated Docker network, and temporary WAL volume
were removed after evidence collection. The seven `led-platform-*` containers
remained running and healthy throughout and after the run.
