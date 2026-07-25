# Wave 1 Tinode and LiveKit Egress OCI Server Validation

## 1. Scope and isolation

This evidence was collected on 2026-07-22 on the isolated validation server
`64.225.122.227`. Source, upstream checkouts and disposable caches were kept
under `/opt/opc-wave123-validation-20260722/`. No local Docker build or runtime
regression was used for this acceptance.

The existing LED Compose project was not modified or restarted. It reported
seven running containers before and after validation. No Tinode or Egress
validation container was left running.

## 2. Exact source identities

| Component | Tag | Exact commit |
| --- | --- | --- |
| Tinode Server | `v0.25.3` | `22a7c18e9cd695e9a061bf1b8c84175196ef5a15` |
| LiveKit Egress | `v1.13.0` | `7d3572a0bf1959cbbc452f5ba390b6a90b7dc249` |

Both overlays were applied to clean exact-source trees and then applied a
second time. The second application reported `already_applied`, proving the
overlay path is idempotent for the pinned source.

## 3. Immutable build inputs

| Input | Digest-bound reference |
| --- | --- |
| Tinode builder | `docker.io/library/golang:1.26-alpine@sha256:0178a641fbb4858c5f1b48e34bdaabe0350a330a1b1149aabd498d0699ff5fb2` |
| Tinode runtime | `docker.io/library/bash:5.3-alpine3.23@sha256:0d2a1b7230ba3cae17a0fd5b29445b1729be49a8a34cb28cfd9ab0710cb98743` |
| Egress templates | `docker.io/livekit/egress-templates:sha-594b3b1@sha256:77a26654cca986df9f0eff3c1d04f9a66c425f3733ec0caf9405b20497148af8` |
| Egress builder | `docker.io/livekit/gstreamer:1.24.12-dev@sha256:208d54ac3a93953c81654a00a8f8e6a162dfb35679a6ceb41017dfb581a49166` |
| Egress runtime | `docker.io/livekit/egress:v1.13.0@sha256:980ff439431df2c773573721ab6da19e15bdc1f049ab7cb80e87470bf174c12f` |

Registry manifests were inspected before the build. Every top-level reference
listed Linux amd64 and arm64 variants. The Egress template identity
`sha-594b3b1` came from the exact upstream source's `version/version.go`.

Both component build scripts vendored Go dependencies before image
construction and ran the final Docker build with `--network=none`. Tinode copies
only its required source subtrees and produces a UID/GID `10001:10001` runtime.
Egress compiles in the digest-bound GStreamer builder and uses the official
digest-bound `v1.13.0` image as its media runtime, preserving the upstream
Chrome, GStreamer and Tini runtime contract without package downloads in the
iveKit Dockerfile.

## 4. Server results

| Check | Tinode | LiveKit Egress |
| --- | --- | --- |
| Candidate image | `ivekit/tinode:v0.25.3-ivekit.2-22a7c18e-amd64` | `ivekit/livekit-egress:v1.13.0-ivekit.1-7d3572a0-amd64` |
| Image ID | `sha256:d87632a4b964cb260019c6bbd032b938d3c7d1fefb0c02248666b4d963e1dbc9` | `sha256:e266932c428610111a417d6b38cbec7096680816eae09b23495575035456d3fe` |
| Architecture | `linux/amd64` | `linux/amd64` |
| Size | `46,877,689` bytes | `1,413,726,105` bytes |
| Runtime user | `tinode` (`10001:10001`) | `egress` |
| Offline final build | passed | passed |
| Source revision label | passed | passed |
| Component contract label | passed | passed |
| Binary/runtime marker | passed | passed |

The repository's focused Tinode, Egress and image-supply-chain tests passed
`24/24` on the validation server. Additional test-first cases covered the
offline Go-cache cleanup, Tinode legacy-builder wildcard destination, Tinode
source-copy boundary, runtime Bash compatibility and Egress idempotent rebuild.
The fork-status, communication-baseline, component-governance and release
operations suite passed `28/28`. Actionlint `1.7.12` accepted both new component
workflows and the shared OCI gate with networking disabled.

The server did not have the Docker Buildx plugin. Docker 29's legacy builder
was therefore used. Two large final-layer commits were interrupted only after
the layer had been cached and then resumed. This did not change the source or
image contract, but it exposed and led to fixes for:

- Go compiler cache persisting in an image layer;
- Tinode wildcard `COPY` compatibility in the legacy builder;
- the `bash` runtime image's executable path;
- Egress reruns seeing the previously materialized Go toolchain during
  `go mod vendor`.

## 5. Repository release workflows

The repository now contains exact-source amd64/arm64 workflows for both
components:

- `.github/workflows/ivekit-tinode-server-image.yml`;
- `.github/workflows/ivekit-livekit-egress-image.yml`.

Each workflow verifies the pinned source, builds both architectures, publishes
one GHCR manifest and passes the resolved digest to
`.github/workflows/ivekit-oci-release-gate.yml`. The gate generates an SPDX
SBOM, rejects HIGH/CRITICAL vulnerabilities, signs the digest and attaches
provenance and SBOM attestations.

## 6. Explicitly not run

The following remain `not_run` and are not implied by this evidence:

- GitHub Runner execution of either new workflow;
- GHCR multi-architecture push and immutable registry digest;
- Trivy registry scan, SPDX publication, Cosign signature and provenance;
- arm64 build execution for these new workflows;
- real Tinode three-node convergence, native-client mutation/reconnect and
  capacity tests;
- real Egress Track/Composite media, shared Redis interruption, object-storage
  outage, target Kubernetes rollout and capacity tests.

This evidence proves controlled server construction and runtime identity of
the two Linux amd64 candidates. It is not production publication, real media,
multi-node correctness or capacity evidence.
