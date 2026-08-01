# Converact Fabric HOMER 11 PostgreSQL Catalog Fork

This build targets exactly HOMER `11.0.297` at commit
`ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b`. The overlay adds DuckLake's
PostgreSQL catalog backend to the writer and reader paths, escapes ATTACH
values, loads the `postgres` DuckDB extension, and prevents a PostgreSQL DSN
from being rewritten as a local multi-shard filename.

Converact Fabric deployments are PostgreSQL-only. They do not deploy an SQLite catalog,
do not install the SQLite CLI or bundle `sqlite_scanner`, and never run
SQLite-only WAL, repair, GC or file-lock operations against the catalog DSN.
The coordinator settings store remains a local DuckDB file on the persistent
state volume; DuckDB is not SQLite and is not a second business authority.

The image build requires immutable Go, Node and runtime base image references:

```bash
HOMER_SOURCE_DIR=/path/to/homer-11.0.297 \
CONVERACT_FABRIC_HOMER_IMAGE=registry.example.com/converact/homer:11.0.297-ivekit.2 \
HOMER_BUILDER_IMAGE=golang:<version>@sha256:<digest> \
HOMER_NODE_IMAGE=node:22-bookworm-slim@sha256:<digest> \
HOMER_RUNTIME_IMAGE=debian:bookworm-slim@sha256:<digest> \
HOMER_TARGETARCH=amd64 \
bash infra/converact/homer/build.sh
```

The overlay verifies both the exact tag and commit before changing source.
The Node toolchain comes from the pinned image instead of an online installer.
Go modules use `go mod download` plus `go mod verify`, and the UI uses the
committed lockfile through `npm ci`.
The generated image runs as UID/GID 10001, contains the DuckLake/PostgreSQL/S3
extensions for offline startup, and does not contain database credentials.
The maintenance CLI propagates the configured DuckDB thread, memory and spill
directory settings. Its fallback spill resolver rejects PostgreSQL DSNs, so a
connection string can never be interpreted or logged as a filesystem path.
The container uses a read-only root filesystem and writes its PID only to
`/tmp/homer-core.pid`; the Chart provides a bounded memory-backed `/tmp`.
The HOMER image workflow delegates its published digest to the shared Converact Fabric OCI
release gate for an SPDX SBOM, vulnerability gate, Cosign signature and GitHub
provenance/SBOM attestations. That workflow is implemented but has not run in
the current evidence set, so no immutable production artifact is claimed.

The Chart under `helm/converact-homer` deploys one release per Cell. One Pod owns
one PostgreSQL DuckLake catalog and its Parquet root. Capacity is increased by
deploying independent Cell collectors and catalogs, not by making two writers
share one catalog or by setting `replicaCount` above one. The PostgreSQL DSN,
node token, coordinator JWT and admin password hash come only from an existing
Secret.

HEPv3/UDP is an observability copy. A collector outage or PostgreSQL outage
must not affect calls: Kamailio export remains fail-open, HOMER is excluded
from Kamailio/RustPBX readiness, and no synchronous acknowledgement returns to
the SIP transaction. Lost HEP packets during an outage are acceptable and are
measured; the system must never queue them without a hard bound in a call
worker.

Controlled Linux server evidence now covers exact-source overlay replay,
PostgreSQL catalog Go tests, Go 1.26.5 compilation, Linux amd64 candidate-image
identity, PostgreSQL DuckLake catalog attach, complete HEP call search,
OPTIONS/KDMQ exclusions, collector outage, PostgreSQL outage, and a fresh HEP
write after PostgreSQL recovery. The collector-outage sample completed 5/5
PCMU calls with 99.36% RTP packet coverage; the PostgreSQL-outage sample
completed 3/3 calls with 99.20% coverage. Neither sample observed durable RTP
loss, sequence gaps, duplicates, reordering, SIP failure, or SIP
retransmission. Full evidence and limits are recorded in
`docs/evidence/wave1-homer-postgres-hep-server-validation-2026-07-24.md`.

Balanced same-host HEP enabled/disabled A/B completed exact calls and HEP rows
through 700 CPS; 900 CPS was rejected and is not a capacity claim. An isolated
maintenance campaign on `11.0.297-ivekit.2` deleted all 200 rows older than the
30-day policy, preserved all 200 current rows, compacted snapshots and files,
repeated idempotently, passed artifact secret scanning and removed all test
resources. The reports are
`docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.md` and
`docs/evidence/wave1-homer-retention-compaction-server-validation-2026-07-25.md`.

This is a local candidate image, not a production Registry artifact. HEP
loss/high-water shedding, live trace disable, production-volume retention
throughput, long soak, target Kubernetes and PostgreSQL failover, Cell-10K,
MIX-100K, multi-architecture Registry publication, final vulnerability scan,
SBOM, Cosign and provenance remain `not_run`. The exact upstream frontend
lockfile reports nine build-time dependency advisories; Node and its package
artifacts are absent from the final runtime image, but release supply-chain
triage is still required.
