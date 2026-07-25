# Wave 2 SeaweedFS S3 Controlled Validation

## Result

`passed_controlled_server`

SeaweedFS `4.40` passed the iveKit production `ObjectStorage` provider matrix on
the designated validation server. This is controlled single-host compatibility
evidence, not production, durability, capacity or cross-Zone evidence.

## Environment

- Validation server: `64.225.122.227`, Linux amd64
- SeaweedFS image: `chrislusf/seaweedfs:4.40@sha256:52194fba4fecd0083c842158b3a902ba6e04a63619b2b0efcd08007bdb6a4602`
- Runtime topology: one master, one volume server, one filer and one S3 gateway
- S3 endpoint exposure: server loopback only
- Machine evidence: `docs/evidence/wave2-seaweedfs-s3-runtime-2026-07-22.json`
- Compose SHA-256: `f1636cedd756c14338d98007b118b1cbb91e892b8e973fad333921cac9a53be6`
- Probe SHA-256: `40f38e41a8902792fc1e13c1d64a4b0d86e89cfc0f52bdbe121713cddf616503`
- Runner SHA-256: `d1aada7c7fb93c526ed262d756936d0baef99eb1b86c32b8c96a0910e49a7c4d`

The server source directory does not expose Git metadata. The three source
hashes above identify the acceptance implementation that produced the evidence.

## Security And Isolation

- the image is pinned by a multi-architecture OCI digest;
- temporary access and secret keys are generated for each run and omitted from
  logs and evidence;
- the S3 gateway binds only to `127.0.0.1` on the validation server;
- all services use a dedicated Compose project, network and named volumes;
- production code sees only the generic S3 contract and never calls SeaweedFS
  master, volume or filer APIs;
- storage is outside the synchronous SIP, RTP, SFU, IM and remote-control paths;
- cleanup removes all acceptance containers, volumes and network.

## Procedure

1. Verified the exact seven-container LED invariant.
2. Resolved and pulled the immutable SeaweedFS `4.40` image.
3. Started isolated master, volume, filer and S3 gateway services.
4. Passed an authenticated `ListBuckets` readiness gate with bounded connect,
   request and retry limits.
5. Created a temporary bucket and used the production iveKit provider for
   upload, HEAD, download and delete.
6. Verified a 16 MiB object and an 11 MiB three-part multipart upload.
7. Verified multipart abort, byte-range GET and two retained object versions.
8. Seeded a recovery object, stopped the S3 gateway and verified object access
   failed closed in bounded time.
9. Restarted the S3 gateway and verified the seeded object and checksum.
10. Removed the isolated topology and rechecked the LED invariant.

## Measurements

- small-object upload observation: `231 ms`
- 16 MiB upload observation: `419 ms`
- multipart completion observation: `61 ms`
- stopped-gateway failure observation: `133 ms`
- post-restart recovery object: verified
- LED running containers after cleanup: exactly 7

These are observations from one controlled run and are not throughput or latency
SLOs.

## Defects Found And Fixed

1. The first Helm S3 contract rendered legacy MinIO values because validation
   expressions polluted the helper return value. Validation is now side-effect
   free and the server Helm acceptance passes.
2. Recording reads, backup/restore and Egress rendering had separate credential
   precedence and path-style rules. They now share one brand-neutral resolver.
3. The first SeaweedFS readiness check only proved that a TCP listener existed.
   It now performs authenticated S3 `ListBuckets` with bounded timeouts.
4. A Docker `internal` network blocked the host-side production SDK from the
   loopback-published endpoint. The topology now uses a dedicated project
   network while retaining loopback-only host exposure.

## Object Lock Boundary

SeaweedFS `4.40` is accepted here for ordinary S3 object, multipart, range and
versioning workloads. It is **not** accepted as a WORM authority. Upstream
behavior does not reliably prevent deletion under Object Lock/retention, so
legal-hold or immutable-retention deployments must select an external S3
provider with independently verified Object Lock enforcement.

## Cleanup

- no acceptance container remained;
- no acceptance volume remained;
- no acceptance network remained;
- all seven pre-existing LED containers remained running.

## Not Proven

- target Kubernetes deployment or operator lifecycle;
- multi-host replication, erasure coding, node loss or cross-Zone recovery;
- real LiveKit room and Egress continuity during a storage outage;
- WORM/Object Lock enforcement;
- encryption-at-rest, KMS integration or credential rotation;
- backup/restore, soak, throughput or MIX-100K capacity.
