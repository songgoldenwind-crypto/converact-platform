# Wave 2 LiveKit Ingress v1.5.0 Server Validation

## 1. Scope and isolation

Validation ran on `64.225.122.227` under
`/opt/opc-wave123-validation-20260722/`. The existing LED Compose project was
not restarted and reported seven running containers before and after the
work. No LiveKit Ingress validation container remained running. Local Docker
was not used.

## 2. Source and immutable inputs

| Item | Identity |
| --- | --- |
| Source | `livekit/ingress` `v1.5.0` |
| Commit | `363f6090d572db8eef5b60c273c0970826fb7ca6` |
| Builder | `docker.io/livekit/gstreamer:1.26.7-dev@sha256:983e465d28ed0af3a1b8ef1d57fd24928e15aa3748bb5709ef5d67ff52be3562` |
| Runtime | `docker.io/livekit/gstreamer:1.26.7-prod@sha256:24106f36a0bd1003bdd34d3d4840f84cb88062573269fdf7640732058b58f7ab` |
| Go amd64 SumDB | `h1:wVC9wx2XOcP5gHiN8ZzfyTfjlrDLSS7Hu1wjI01n68U=` |
| Go arm64 SumDB | `h1:hHtJUQup8RrD0u1JkoREqx9fkdEMQQUusYS1dYLIUpk=` |

The exact-source overlay applied twice; the second pass preserved the same
Dockerfile checksum. Dependencies and the checksum-bound Go 1.25.0 toolchain
were materialized before Docker execution, and the final Docker build used
`--network=none`.

## 3. Candidate image

| Check | Result |
| --- | --- |
| Reference | `ivekit/livekit-ingress:v1.5.0-ivekit.1-363f6090-amd64` |
| Image ID | `sha256:639b1689dfae305b6495467c71ed7e2ce42f2c43161a512d91bfb38310ec3bf9` |
| Inspect size | `260,631,118` bytes |
| Architecture | `amd64` |
| User | `10001:10001` |
| Entrypoint | `/bin/ingress` |
| Source revision label | exact commit, passed |
| Component label | `livekit-ingress`, passed |
| Runtime version | `ingress version 1.5.0`, passed |

The server uses Docker 29 without Buildx, so this controlled build used the
legacy builder. Shared-base virtual size shown by `docker image ls` is not used
as the evidence size; the table records `docker image inspect .Size`.

## 4. Repository and deployment checks

- LiveKit Ingress foundation tests passed `2/2`.
- API/SDK lifecycle, official provider mapping and URL pull policy passed `4/4`.
- The final focused Media API regression passed `35/35` and
  `npm run typecheck` completed successfully after the final test change.
- Actionlint `1.7.12` accepted the Ingress workflow and shared OCI release gate.
- Helm `v3.18.4` rendered the Ingress resources and linted the complete
  `infra/k8s` chart with zero failures.
- The rendered worker is a stateless `Deployment` with digest-only image
  identity, rolling port-conflict protection, probes, anti-affinity, zone
  spreading, PDB, NetworkPolicy and non-root read-only security context.

The final governance, fork-manifest, supply-chain, baseline, Ingress foundation
and API group passed `42/42`. The additional official-provider mapping case
also passed in both the dedicated `4/4` and final `35/35` media suites.

## 5. Implemented application boundary

The iveKit Media facade now exposes create, list, get, update and delete for
Ingress. It enforces tenant room ownership, operator roles, provider-authority
lookup, a required create idempotency key and conflict detection. Trusted
ownership metadata is stored in LiveKit participant metadata but removed from
public responses. URL pull is HTTPS-only by default, rejects embedded
credentials and private IP literals, and requires an explicit hostname
allowlist.

## 6. Explicitly not run

The following remain `not_run`:

- GitHub Runner arm64/amd64 workflow execution and GHCR manifest publication;
- immutable registry digest, Trivy result, SPDX SBOM, Cosign signature and
  GitHub provenance/attestation;
- real RTMP publisher, WHIP publisher and URL/HLS/MP4 pull into a LiveKit room;
- transcoding, simulcast and bypass-transcoding quality checks;
- shared Redis interruption/recovery, worker drain and rolling replacement;
- DNS-rebinding and target-cluster controlled-egress enforcement;
- target Kubernetes LoadBalancer, public UDP routing and multi-zone failure;
- worker slot/frontier, media quality and Cell-10K capacity evidence.

This evidence proves exact-source Linux amd64 construction, runtime identity,
repository contracts and controlled deployment rendering only.
