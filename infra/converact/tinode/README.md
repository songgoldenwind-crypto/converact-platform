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
IVEKIT_TINODE_IMAGE=registry.example.com/ivekit/tinode:v0.25.3-ivekit.3 \
IVEKIT_TINODE_BUILDER_IMAGE=docker.io/library/golang:1.26-alpine@sha256:<digest> \
IVEKIT_TINODE_RUNTIME_IMAGE=docker.io/library/bash:5.3-alpine3.23@sha256:<digest> \
IVEKIT_TINODE_TARGETARCH=amd64 \
bash infra/converact/tinode/build.sh
```

The upstream release requires Go 1.26. The script rejects mutable build inputs,
vendors dependencies before image construction and performs the final build
with `--network=none`. The generated Dockerfile copies only `pbx/`, `server/`
and `tinode-db/`, removes compiler cache in the same layer and runs as dedicated
UID/GID `10001:10001` instead of root.

The `ivekit.3` runtime also keeps generated config, static assets, initialization
output, logs and local compact-mode media outside the read-only image layer.
Cluster member names and addresses are environment-parameterized for stable
StatefulSet DNS, and `TINODE_INIT_ONLY=1` gives Helm one deterministic database
bootstrap owner before the three server Pods start with `NO_DB_INIT=true`.

On 2026-07-22 the exact source overlay was applied twice on the isolated Linux
amd64 validation server. The offline build produced
`ivekit/tinode:v0.25.3-ivekit.2-22a7c18e-amd64`, image ID
`sha256:d87632a4b964cb260019c6bbd032b938d3c7d1fefb0c02248666b4d963e1dbc9`,
size `46,877,689` bytes. Architecture, labels, executable, runtime user and the
iveKit component-node marker passed inspection. The earlier local arm64 build
remains historical controlled evidence. An immutable registry digest,
SBOM/signature/provenance, multi-node reconnect, native-client convergence and
node/Cell capacity remain `not_run`.

The Apple M5 operation-level benchmark for ordinary local-group message
preparation changed from `41.19-42.81 ns/op`, `240 B/op`, `2 allocs/op` to
`1.580-1.586 ns/op`, `0 B/op`, `0 allocs/op`. This is not a server throughput or
capacity claim.

On 2026-07-23 the final `ivekit.3` candidate was rebuilt on the isolated Linux
amd64 validation server as
`ivekit/tinode:v0.25.3-ivekit.3-22a7c18e-amd64`, image ID
`sha256:6c83d13fc244b000b5bd0b2489a918b3fd4ac90bbab46039fea6656fa41b6650`,
size `46,880,001` bytes. The exact overlay applied idempotently, Go 1.26 tests
covered both `server` and `server/db/postgres`, and the final image was built
with networking disabled after dependency vendoring.

Disposable server acceptance then covered both database entry paths: a missing
`tinode` database was created through the `postgres` maintenance database, and
a precreated empty database was initialized twice without recreation. Both
reached schema version `116`. A separate run used MinIO with path-style S3 and
started three read-only-root Tinode nodes; all three health endpoints reported
`v0.25.3-ivekit.3`, and the ring logged all three members. Target Kubernetes,
reconnect and failure injection, native-client convergence, capacity, registry
digest, SBOM, signature and provenance remain `not_run`.
