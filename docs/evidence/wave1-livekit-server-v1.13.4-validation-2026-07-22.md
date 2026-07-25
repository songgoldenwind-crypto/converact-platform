# Wave 1 LiveKit Server v1.13.4 Validation

## Scope

- Date: 2026-07-22 (Asia/Shanghai)
- Host: `pmt-web-test-sfo2`, Linux x86_64, 4 vCPU / 7.8 GiB
- Isolated source: `/opt/opc-wave123-validation-20260722/source`
- Exact upstream checkout: `/opt/opc-wave123-validation-20260722/upstream/livekit-server`
- Upstream identity: `v1.13.4@0b3fd288e3ef3263ec475ba0d78cf3ad77459981`
- Dependency cache: `/opt/opc-wave123-validation-20260722/cache/livekit-go`

The validation used an isolated directory and bounded containers. It did not
use or modify `/opt/led-platform`, LED containers, networks, ports, databases
or volumes. Runtime and regression validation for this component is performed
on the server; local Docker is not part of the evidence path.

## Rebase Inputs

| Input | SHA-256 |
| --- | --- |
| `infra/ivekit/livekit/apply-overlay.mjs` | `47c675953cf4fe8f51be60c8b3404673dd566b88977874cfdcfb6a5e17113d47` |
| `infra/ivekit/livekit/patches/livekit-ivekit-small-room-hot-path.patch` | `d7439f99ff5dbc539c201a754d7c3fc1f700b80acd7fdec668d2b216f462eda6` |
| `infra/ivekit/livekit/build.sh` | `f534c04e41c56cffd899264d06e6a13e785915946ed98bc387c493a4e4101eb5` |

The rebase keeps iveKit room-owner fencing, immutable downtrack snapshots and
serial small-room RTP/RED fanout. It also preserves the v1.13.4 upstream dynamic
fanout threshold and its rule that out-of-order packets are excluded from
steady-state forwarding-latency statistics.

## Server Results

| Check | Result | Evidence |
| --- | --- | --- |
| Exact tag and commit | passed | Git tag and HEAD matched the identity above |
| Overlay first apply | passed | `applied` |
| Overlay second apply | passed | `already_applied` |
| Source hygiene | passed | patched upstream `git diff --check` |
| Main Go modules | passed | `cmd/server`, `pkg/sfu`, `pkg/sfu/utils` |
| Component hook module | passed | `ivekit.local/componenthook` |
| LiveKit owner module | passed | `ivekit.local/livekitowner` |
| SFU race detector | passed | Go 1.26.5 Linux amd64, `pkg/sfu` 3.685s and `pkg/sfu/utils` 1.086s; CGO, vendor and `GOPROXY=off` |
| Dependency isolation | passed | tests and build used the generated vendor tree; image build used `--network=none` |
| Linux amd64 image | passed | `sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963`, 37,554,217 bytes |
| Runtime identity | passed | configured user `livekit`; runtime UID/GID `10001:10001` |
| Binary identity | passed | LiveKit `1.13.4` and `IVEKIT_COMPONENT_NODE_ID` marker |
| OCI labels | passed | version, exact upstream revision, component and owner contract labels |

Build logs and status are retained on the server at:

- `/opt/opc-wave123-validation-20260722/livekit-v1134-build.log`
- `/opt/opc-wave123-validation-20260722/livekit-v1134-build.status`

## Defect Found And Closed

The first offline candidate inherited the upstream root runtime identity. It was
not accepted. The overlay now creates UID/GID 10001, copies the binary with the
new ownership and sets `USER livekit`. The image was rebuilt from the exact
source and the runtime identity was rechecked.

The server regression then found two integration defects. First, standalone,
production Compose and the root Kubernetes values could still select the
official `livekit/livekit-server`, bypassing iveKit owner and hot-path code.
Production and standalone now require the iveKit GHCR repository plus a
non-placeholder digest; an upstream image fails preflight. Bundled development
uses the exact local iveKit candidate tag.

Second, the isolated capacity-runtime handoff omitted
`src/infra/nats-connection-options.ts`, so its new NATS authentication/TLS
adapter could compile only while borrowing repository source. The source is now
in the explicit delivery allowlist. A prewarmed package cache followed by
`--network=none` proved offline `npm ci`, typecheck and dynamic import from the
standalone handoff.

The final server-focused Node regression passed `91/91`. Actionlint `1.7.12`
also passed the LiveKit Server, shared OCI gate, source-image, core-image,
component-hook and capacity workflows.

## Release Workflow

`.github/workflows/ivekit-livekit-server-image.yml` now performs exact double
checkout, exact-source overlay, root and nested Go tests, vendor generation,
amd64/arm64 publication and immutable digest handoff to the shared OCI release
gate. The release gate is responsible for Trivy, SBOM, Cosign and GitHub
attestations against the published digest.

## Remaining `not_run`

- GitHub-hosted amd64/arm64 build and GHCR publication;
- Registry Trivy scan, SBOM, Cosign signature and provenance verification;
- real two-client audio/video, screen share and data-channel continuity;
- forced TURN, impairment, reconnect, drain and node-loss recovery;
- multi-node Redis routing, target Kubernetes rollout and Cell capacity.

The historical Apple M5 v1.13.3 snapshot microbenchmark and v1.13.3 race result
are retained as historical evidence only. They are not a v1.13.4 node or Cell
capacity claim. `capacity_claim` remains `none`.
