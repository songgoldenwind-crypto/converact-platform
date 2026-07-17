# iveKit LiveKit Fork Build

The fork target is exactly:

```text
tag: v1.13.3
commit: 8f6a9cb8b735549f0c5770df8ea70ac51f860ecb
```

`apply-overlay.mjs` verifies both identities before copying the shared Go
component hook and the LiveKit room-owner registry into the source tree. It
then patches `cmd/server/main.go` and `pkg/service/roommanager.go` at exact
anchors and fails if the upstream source has drifted. Before Prometheus,
SignalClient and Router initialization, the server's internal
`currentNode.NodeID()` is set to `IVEKIT_COMPONENT_NODE_ID`; the LiveKit Redis
router, iveKit placement metadata and local component-node sidecar therefore
share one stable identity.

The same overlay applies
`patches/livekit-ivekit-small-room-hot-path.patch`. The patch publishes the
copy-on-write downtrack snapshot through an atomic pointer and uses a serial,
non-atomic RTP fanout below LiveKit's existing parallel threshold. Ordinary
media and Opus RED forwarding share the same helper; large rooms retain the
upstream parallel path. Patch application is idempotent and fails when neither
the forward nor reverse check matches the pinned source.

```bash
LIVEKIT_SOURCE_DIR=/path/to/livekit-v1.13.3 \
IVEKIT_LIVEKIT_IMAGE=registry.example.com/ivekit/livekit-server:v1.13.3-ivekit.2 \
bash infra/ivekit/livekit/build.sh
```

The build requires the upstream Go 1.26 toolchain and Docker. On 2026-07-17 the
overlay and hot-path patch were applied twice to a clean
`v1.13.3@8f6a9cb...` worktree. `cmd/server`, `pkg/sfu`, `pkg/sfu/utils` and both
nested iveKit modules passed their Go tests; SFU packages also passed under the
race detector. The custom image build, real RTP/TURN traffic, multi-node
recovery and physical capacity remain `not_run`.

The controlled Apple M5 microbenchmark reduced one-subscriber snapshot reads
from 3.62-3.66 ns/op to 0.49-0.52 ns/op with zero allocations on both sides.
That result is scoped to the snapshot operation and is not a server or Cell
capacity claim.
