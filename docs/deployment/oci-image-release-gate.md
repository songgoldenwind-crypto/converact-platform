# iveKit OCI Image Release Gate

## 1. Purpose

`.github/workflows/ivekit-oci-release-gate.yml` is the single post-publish gate
for iveKit-owned OCI images. Component workflows remain responsible for exact
source checkout, build, tests and publication. They pass only a digestless GHCR
repository and a resolved `sha256:` manifest digest to this gate.

Repository-owned application images use
`.github/workflows/ivekit-source-image-release.yml` as their common build stage
and `.github/workflows/ivekit-core-images.yml` as the release matrix. The build
stage publishes only the Git commit tag, returns the manifest digest and then
hands that immutable subject to the same post-publish gate.

This keeps Trivy, Cosign and GitHub attestation policy out of each component's
build implementation. The gate is not part of SIP, RTP, SFU, IM, RustDesk or
recording runtime paths and consumes no production capacity.

## 2. Enforced Contract

The reusable workflow fails closed unless:

1. the image repository is a lowercase, digestless `ghcr.io/...` name;
2. the subject digest is exactly `sha256:` plus 64 lowercase hexadecimal characters;
3. Trivy `v0.70.0` can generate an SPDX JSON SBOM for that digest;
4. no HIGH or CRITICAL vulnerability is reported, including unfixed findings;
5. Cosign keyless signing succeeds with the GitHub Actions OIDC identity;
6. SLSA build provenance and the SPDX SBOM are attached to the same digest and pushed to GHCR;
7. both the Cosign signature and GitHub artifact attestations verify before the job exits.

All third-party Actions are pinned to full commits. In particular, Trivy Action
uses the immutable `v0.36.0` commit and installs Trivy `v0.70.0`; tag references
such as `@master`, `@v4` or `@v0.36.0` are not accepted by the repository tests.

### 2.1 Build-context preparation

The common source-image workflow does not accept an arbitrary preparation
command. Its allowlist contains only:

- `none`, for a context already present in the checkout;
- `ivekit-standalone`, which runs the repository's source-graph generator and
  builds `.tmp/ivekit-standalone-context` with `GITHUB_SHA` as its source identity.

The latter is required for the iveKit service because its authoritative source
lives under the root `src/` graph. Building `services/ivekit-service` directly
would omit that source and fail at `COPY src ./src`. The generated context
contains only the policy-approved iveKit graph, independent package lock,
Dockerfile, migrations, checksum manifest and operational entrypoints.

## 3. Onboarded Images

| Image | Component workflow | Published subject |
| --- | --- | --- |
| RustPBX | `.github/workflows/ivekit-rustpbx-image.yml` | final amd64/arm64 manifest digest |
| HOMER | `.github/workflows/ivekit-homer-image.yml` | exact `11.0.297` iveKit fork digest |
| LiveKit SIP | `.github/workflows/ivekit-livekit-sip-image.yml` | exact `v1.7.0` hardened image digest |
| LiveKit Server | `.github/workflows/ivekit-livekit-server-image.yml` | exact `v1.13.4` iveKit fork manifest digest |
| LiveKit Egress | `.github/workflows/ivekit-livekit-egress-image.yml` | exact `v1.13.0` iveKit fork manifest digest |
| LiveKit Ingress | `.github/workflows/ivekit-livekit-ingress-image.yml` | exact `v1.5.0` hardened manifest digest |
| Tinode Server | `.github/workflows/ivekit-tinode-server-image.yml` | exact `v0.25.3` iveKit fork manifest digest |
| RustDesk Server | `.github/workflows/ivekit-rustdesk-server-image.yml` | exact `1.1.16` iveKit server fork manifest digest |
| OPC platform | `.github/workflows/ivekit-core-images.yml` | root application amd64/arm64 manifest digest |
| OPC frontend | `.github/workflows/ivekit-core-images.yml` | frontend amd64/arm64 manifest digest |
| iveKit service | `.github/workflows/ivekit-core-images.yml` | generated standalone-context amd64/arm64 manifest digest |
| Capacity tools | `.github/workflows/ivekit-core-images.yml` | dispatcher/controller/worker/finalizer amd64/arm64 manifest digest |
| Kamailio | `.github/workflows/ivekit-core-images.yml` | iveKit SIP Edge amd64/arm64 manifest digest |
| AI agent | `.github/workflows/ivekit-core-images.yml` | external-provider adapter runtime amd64/arm64 manifest digest |

The LiveKit Egress and Tinode exact-source workflows are now wired to the same
gate. They are not production eligible until those workflows actually publish
a registry manifest and the reusable gate passes for its digest. A local image
build or an unexecuted workflow never satisfies that requirement.

## 4. HOMER Repository Variables

HOMER's source build additionally requires these GitHub repository variables:

- `IVEKIT_HOMER_BUILDER_IMAGE`
- `IVEKIT_HOMER_RUNTIME_IMAGE`

Both values must be complete image references ending in `@sha256:<64 hex>`.
The workflow and `infra/ivekit/homer/build.sh` validate them independently.

LiveKit SIP similarly requires `IVEKIT_LIVEKIT_SIP_BUILDER_IMAGE` and
`IVEKIT_LIVEKIT_SIP_RUNTIME_IMAGE` repository variables. Both must be immutable
digest references; the component workflow and build script validate them.

Tinode additionally requires:

- `IVEKIT_TINODE_BUILDER_IMAGE`
- `IVEKIT_TINODE_RUNTIME_IMAGE`

LiveKit Egress additionally requires:

- `IVEKIT_LIVEKIT_EGRESS_TEMPLATE_IMAGE`
- `IVEKIT_LIVEKIT_EGRESS_BUILDER_IMAGE`
- `IVEKIT_LIVEKIT_EGRESS_RUNTIME_IMAGE`

LiveKit Ingress additionally requires:

- `IVEKIT_LIVEKIT_INGRESS_BUILDER_IMAGE`
- `IVEKIT_LIVEKIT_INGRESS_RUNTIME_IMAGE`

Every value must be a complete image reference ending in
`@sha256:<64 lowercase hex>`. Component workflows and build scripts validate
the values independently before source construction.

## 5. Evidence Status

Repository tests verify workflow structure, immutable Action pins, permissions,
source identity, digest handoff, allowlisted context preparation and gate policy.
On 2026-07-22 the isolated validation server passed Actionlint `1.7.12`, built
the capacity-tools image and generated then built the standalone iveKit-service
image. Both images run as UID 1000; required entrypoints and media/database tools
were checked with networking disabled. The same server also rebased and tested
the exact LiveKit Server `v1.13.4` source and produced a non-root Linux amd64
candidate with networking disabled during image construction. Detailed evidence
is in `docs/evidence/wave1-oci-source-image-server-validation-2026-07-22.md` and
`docs/evidence/wave1-livekit-server-v1.13.4-validation-2026-07-22.md`. Tinode
`v0.25.3` and LiveKit Egress `v1.13.0` were also built from exact source as
offline Linux amd64 candidates with immutable base inputs; their workflow and
server evidence is recorded in
`docs/evidence/wave1-tinode-egress-oci-server-validation-2026-07-22.md`.
LiveKit Ingress `v1.5.0` was subsequently built from exact source as an
offline, non-root Linux amd64 candidate; its image identity, Helm rendering and
remaining real-media boundaries are recorded in
`docs/evidence/wave2-livekit-ingress-v1.5.0-validation-2026-07-23.md`.

No GitHub Runner multi-architecture build, GHCR push, Trivy registry scan,
Cosign signature or GitHub attestation from these workflows has been executed
in the current evidence set. Registry evidence therefore remains `not_run`;
the controlled server images must not be cited as existing SBOMs or signed
production artifacts.

Dependency and fork update discovery is governed separately by
`docs/deployment/dependency-update-policy.md`. A Renovate PR never replaces this
release gate and never upgrades a fork's production identity by itself.
