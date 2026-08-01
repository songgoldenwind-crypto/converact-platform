# Converact Fabric LiveKit Fork Build

The fork target is exactly:

```text
tag: v1.13.4
commit: 0b3fd288e3ef3263ec475ba0d78cf3ad77459981
```

`apply-overlay.mjs` verifies both identities before copying the shared Go
component hook and the LiveKit room-owner registry into the source tree. It
then patches `cmd/server/main.go` and `pkg/service/roommanager.go` at exact
anchors and fails if the upstream source has drifted. Before Prometheus,
SignalClient and Router initialization, the server's internal
`currentNode.NodeID()` is set from the embedded fork ABI
`IVEKIT_COMPONENT_NODE_ID`; deployment manifests map Converact-owned secrets and
configuration into that fixed process boundary. The LiveKit Redis router,
Converact Fabric placement metadata and local component-node sidecar therefore
share one stable identity. Product-facing configuration remains
`CONVERACT_FABRIC_*`; `IVEKIT_*` is not a public operator input.

The same overlay applies
`patches/livekit-ivekit-small-room-hot-path.patch`. The patch publishes the
copy-on-write downtrack snapshot through an atomic pointer and uses a serial,
non-atomic RTP fanout below LiveKit's existing parallel threshold. Ordinary
media and Opus RED forwarding share the same helper; large rooms retain the
upstream parallel path. The v1.13.4 rebase also preserves upstream's runtime
load-balancing threshold updates and excludes out-of-order recovery bursts from
steady-state forwarding latency. Patch application is idempotent and fails when
neither the forward nor reverse check matches the pinned source.

```bash
LIVEKIT_SOURCE_DIR=/path/to/livekit-v1.13.4 \
CONVERACT_FABRIC_LIVEKIT_IMAGE=registry.example.com/converact/livekit-server:v1.13.4-ivekit.1-0b3fd288 \
bash infra/converact/livekit/build.sh
```

The build requires the upstream Go 1.26 toolchain and Docker. Its patched
Dockerfile pins both the Go builder and Alpine runtime by digest and consumes a
host-generated vendor tree. The exact v1.13.4 overlay, tests and Linux amd64
image are validated on the isolated server; evidence is recorded in
`docs/evidence/wave1-livekit-server-v1.13.4-validation-2026-07-22.md`.
An immutable registry digest, SBOM/provenance, real RTP/TURN traffic,
multi-node recovery and physical capacity remain `not_run`.

The historical controlled Apple M5 v1.13.3 microbenchmark reduced one-subscriber snapshot reads
from 3.62-3.66 ns/op to 0.49-0.52 ns/op with zero allocations on both sides.
That result is scoped to the snapshot operation and is not a server or Cell
capacity claim.
