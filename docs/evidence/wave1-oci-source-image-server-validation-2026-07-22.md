# Wave 1 OCI Source Image Server Validation

## Scope

- Date: 2026-07-22 (Asia/Shanghai)
- Host: `pmt-web-test-sfo2`, Linux x86_64
- Isolated source: `/opt/opc-wave123-validation-20260722/source`
- Source commit recorded by the standalone manifest:
  `578a78bf42e3703a9d78fc0766be6a3b3cd5c35e`
- LED containers, networks, ports, volumes and `/opt/led-platform` were not used.
- Build containers were limited to 1 CPU and 3 GiB memory. Runtime checks used
  no network and at most 0.5 CPU / 512 MiB memory.

This evidence validates source-context generation and local Linux amd64 image
construction. It is not a GHCR publication, SBOM, signature, provenance,
multi-architecture or Kubernetes rollout result.

## Results

| Check | Result | Evidence |
| --- | --- | --- |
| Supply-chain contract | passed | `test/ivekit-image-supply-chain.test.ts`: 7/7 |
| Workflow validation | passed | Actionlint `1.7.12` on source-image and core-image workflows |
| Capacity image build | passed | image ID `sha256:d20f5641c5ac9d64a84cd39ef7d466dd305ccf99ea4eb923d84d58db64c98e78`, 83,573,268 bytes |
| Standalone context | passed | 363 source files, 459 payload files; manifest SHA-256 `eb4d6450641c90cae8342da98843822c2a1c40c8da12ee022e136d1d969b4078` |
| Standalone checksums | passed | `SHA256SUMS` SHA-256 `eb00a5881b01c767d1abe05ba8e10ff1b07cbfdd1c4b85c2a4a8071d8ef6c512` |
| iveKit service build | passed | image ID `sha256:797c0893e116ec8fee77775321fa6fde234a78116a047afb25078aec989a2143`, 275,467,090 bytes |
| Runtime identity | passed | both images configured as `node`; runtime UID is `1000` |
| Capacity runtime | passed | dispatcher source present; Node `v24.18.0` starts without network |
| Service runtime | passed | server/worker entrypoints present; Node `v24.18.0`, FFmpeg `5.1.9`, PostgreSQL client `15.18` |

## Defect Found And Closed

The initial server build used `services/ivekit-service` directly and failed at
`COPY src ./src`: authoritative service source lives in the root source graph,
not in that directory. The release workflow would have failed the same way.

The common source-image workflow now accepts only `none` or
`ivekit-standalone` preparation. The iveKit matrix entry selects the latter and
builds the generated `.tmp/ivekit-standalone-context`. No arbitrary workflow
shell command or duplicate service source tree was introduced.

## Remaining `not_run`

- GitHub-hosted multi-architecture build and cache behavior;
- GHCR immutable manifest publication;
- Trivy HIGH/CRITICAL policy against the published digest;
- Cosign keyless signature and verification;
- GitHub provenance and SPDX attestations;
- custom LiveKit Egress and Tinode workflow onboarding;
- target Registry admission and Kubernetes rollout.
