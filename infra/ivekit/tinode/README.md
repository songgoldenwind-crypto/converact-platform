# iveKit Tinode Fork Build

The source overlay is pinned to:

```text
tag: v0.25.3
commit: 22a7c18e9cd695e9a061bf1b8c84175196ef5a15
```

The overlay copies the shared Go component hook and Tinode topic-owner registry,
aligns `cluster_self` with `IVEKIT_COMPONENT_NODE_ID`, opens group-topic owners
before actor startup, fences publish and metadata mutations locally, and mounts
the authenticated owner-prepare endpoint. The maintained hot-path patch keeps
foreground sessions free of background-timer allocations and reuses immutable
messages for ordinary local-group fanout. P2P, channel and cluster delivery keep
their per-recipient copy semantics.

```bash
TINODE_SOURCE_DIR=/path/to/tinode-v0.25.3 \
IVEKIT_TINODE_IMAGE=registry.example.com/ivekit/tinode:v0.25.3-ivekit.2 \
bash infra/ivekit/tinode/build.sh
```

The upstream release requires Go 1.26. The exact source overlay was applied
twice to a clean `v0.25.3` source tree and passed `go test ./server`,
`go test -race ./server`, and both embedded iveKit module test suites. The
patched Dockerfile produced local source-built arm64 image
`ivekit/tinode:v0.25.3-ivekit.2-22a7c18e` as
`sha256:6b6f3e0cce065c9a77b1ade25af8bc7e579d9f2d447c37d29af64b82b095ea0e`;
its labels, executable and iveKit component-node marker were inspected. An
immutable registry digest, SBOM/provenance, multi-node reconnect, native-client
convergence and node/Cell capacity remain `not_run`.

The Apple M5 operation-level benchmark for ordinary local-group message
preparation changed from `41.19-42.81 ns/op`, `240 B/op`, `2 allocs/op` to
`1.580-1.586 ns/op`, `0 B/op`, `0 allocs/op`. This is not a server throughput or
capacity claim.
