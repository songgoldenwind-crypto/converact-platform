# iveKit Production Bootstrap Design

> Date: 2026-07-11
> Status: approved (Option A)
> Scope: local code and production Compose readiness only; no server upload or runtime acceptance in this phase

## 1. Problem

The production Compose file parses successfully but does not yet prove that a fresh persistent volume can start the iveKit core:

1. PostgreSQL creates only the `opc` database. Keycloak requires `keycloak`, while the self-hosted Tinode overlay requires `tinode`.
2. MinIO starts without creating the configured recordings bucket. LiveKit Egress can therefore start before its target bucket exists.
3. PgBouncer has no health gate, so OPC can start after the container starts but before PostgreSQL traffic can pass through it.
4. Keycloak, Tinode, LiveKit Egress, RustPBX, and OPC mostly use start-order dependencies rather than readiness or successful-bootstrap dependencies.
5. Chatwoot is present in the production Compose but is not part of the current iveKit completion target. Its full production setup also requires its own database preparation, background worker, version pinning, and current PostgreSQL extension requirements.

Static YAML validation is therefore weaker than the production-start claim it is intended to support.

## 2. Decision

Use idempotent one-shot bootstrap services. Do not rely only on `/docker-entrypoint-initdb.d`, because entrypoint scripts run only for a new PostgreSQL data directory and cannot repair an existing volume.

The production base will bootstrap the databases required by the base stack. The self-hosted Tinode overlay will extend the required database set with `tinode`. MinIO will have a separate one-shot initializer that waits for the S3 endpoint, creates the configured bucket if missing, confirms it is private, and verifies it is readable by the configured credentials.

Chatwoot will not be counted as iveKit-ready. It will be placed behind an explicit optional deployment boundary so a known-incomplete omnichannel service cannot prevent the Media/IM/Remote core from starting. Full Chatwoot productionization remains a separate design and acceptance task; this does not remove its code or future capability.

## 3. Components

### 3.1 PostgreSQL Bootstrap Script

Create `infra/scripts/bootstrap-postgres-databases.sh` with these properties:

- uses `psql` against the existing `postgres` service and the configured `opc` owner;
- accepts a comma-separated database list from `OPC_POSTGRES_BOOTSTRAP_DATABASES`;
- permits only a fixed allowlist: `opc`, `keycloak`, `tinode`, `chatwoot`;
- creates a database only when it does not already exist;
- never logs the PostgreSQL password or a connection URL;
- exits non-zero for an empty list, unsupported name, connection failure, or create failure;
- verifies every requested database after creation;
- is safe to run repeatedly against both a fresh and an existing volume.

The base Compose requests `keycloak`; PostgreSQL already creates `opc` through `POSTGRES_DB`. The Tinode overlay requests `keycloak,tinode`.

### 3.2 PostgreSQL Bootstrap Service

Add a one-shot `postgres-bootstrap` service based on the same pinned PostgreSQL major version. It mounts the bootstrap script read-only and waits for the PostgreSQL health check.

Dependency rules:

- `pgbouncer` and `keycloak` wait for `postgres-bootstrap: service_completed_successfully`;
- the Tinode overlay makes `tinode` wait for the same completed bootstrap;
- restart policy is `no`; failure must remain visible and block dependent services.

The bootstrap service does not run OPC migrations. OPC remains responsible for its existing PostgreSQL schema and RLS migrations after the database connection becomes available.

### 3.3 PgBouncer Readiness

Add a PgBouncer health check using `pg_isready` against port 6432 so it proves a real PostgreSQL connection through the pooler, not merely that the container process exists. OPC waits for `pgbouncer: service_healthy`.

The check must use the configured `opc` user and `opc` database without printing the password. A failed pooler prevents OPC startup instead of producing delayed connection errors.

### 3.4 MinIO Bucket Bootstrap

Create `infra/scripts/bootstrap-minio-bucket.sh` and a one-shot `minio-init` service using a pinned MinIO Client image.

The initializer:

1. validates endpoint, bucket, access key, and secret key inputs;
2. retries `mc alias set`/readiness until the configured timeout;
3. executes idempotent bucket creation;
4. explicitly disables anonymous access;
5. verifies the bucket with `mc stat`;
6. never prints credentials;
7. exits non-zero when readiness, creation, privacy, or verification fails.

`livekit-egress`, `rustpbx`, and `opc` wait for `minio-init: service_completed_successfully`. The configured bucket name remains the same `MINIO_BUCKET` value used by media config rendering and recording object resolution.

### 3.5 Chatwoot Boundary

Chatwoot is not an iveKit provider and is excluded from this phase's readiness claim. Its current service must not start in the default iveKit production path.

The implementation will place the existing Chatwoot service behind the explicit Compose profile `omnichannel`. Documentation must state that enabling this profile still requires a separate Chatwoot production design covering:

- pinned Chatwoot image;
- supported PostgreSQL/pgvector image and extensions;
- `db:chatwoot_prepare` lifecycle;
- Rails and Sidekiq services;
- health checks, persistence, upgrades, and rollback.

No Chatwoot feature code is removed.

## 4. Deployment Modes

### 4.1 External Tinode

Run only `infra/docker-compose.production.yml`. The base stack bootstraps `keycloak` and the recordings bucket. External Tinode URLs and credentials remain mandatory through the existing deployment preflight. Production browser clients still require a public WSS URL.

### 4.2 Self-Hosted Tinode

Run the production base plus `infra/docker-compose.tinode.yml`. The merged stack bootstraps `keycloak,tinode`, starts PostgreSQL-backed Tinode only after database bootstrap succeeds, and retains the existing DSN/runtime-key/public-WSS fail-closed gates.

### 4.3 Existing Volumes

One-shot bootstrap services run on every Compose deployment and are idempotent. They repair missing databases or buckets without deleting data. They must never reset PostgreSQL, MinIO, Tinode, or OPC state.

## 5. Failure Semantics

| Failure | Required behavior |
| --- | --- |
| PostgreSQL unavailable | bootstrap retries only through Compose health; dependent services remain blocked |
| Unsupported database name | bootstrap exits non-zero before executing SQL |
| Database already exists | report configured state and succeed without mutation |
| Database create fails | exit non-zero; do not start Keycloak/Tinode/PgBouncer dependents |
| MinIO unavailable | bounded retry, then non-zero exit |
| Bucket already exists | succeed idempotently after privacy/stat verification |
| Bucket credentials invalid | exit non-zero without echoing credentials |
| Chatwoot profile disabled | no Chatwoot container, database preparation, or readiness claim |

## 6. Security And Data Rules

1. Production application data remains PostgreSQL-only. No SQLite path is introduced.
2. Bootstrap scripts use fixed database names and reject arbitrary identifiers.
3. Secrets are passed through environment variables and never rendered into generated reports or command output.
4. The recordings bucket is private; public anonymous download is not enabled.
5. Initializers never delete databases, buckets, objects, schemas, or volumes.
6. OPC migrations continue to enforce PostgreSQL tenant context and FORCE RLS independently of infrastructure bootstrap.

## 7. Verification Design

Implementation follows TDD and adds focused tests before production changes.

### 7.1 Static Contract Tests

Extend `test/video-readiness-compose.test.ts` to prove:

- bootstrap services, scripts, mounts, and dependency conditions exist;
- base and Tinode overlay request the correct database sets;
- OPC waits for healthy PgBouncer and completed MinIO initialization;
- Egress and RustPBX wait for completed MinIO initialization;
- Chatwoot does not run in the default iveKit production path;
- no SQLite environment or volume is introduced.

### 7.2 Script Behavior Tests

Add tests that execute each shell script with fake `psql` or `mc` binaries placed first in `PATH`. Cover:

- first-run creation;
- repeated idempotent success;
- unsupported database rejection;
- connection/readiness timeout;
- secret non-disclosure;
- bucket creation, private access command, and final verification.

These tests validate orchestration logic without claiming a real PostgreSQL or MinIO runtime.

### 7.3 Compose Gates

Run and record:

```bash
docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml config --quiet

docker compose --env-file infra/env.example \
  -f infra/docker-compose.production.yml \
  -f infra/docker-compose.tinode.yml config --quiet
```

The self-hosted command must still fail when Tinode runtime secrets are missing and pass with valid temporary test values.

### 7.4 Regression Gates

- focused bootstrap/Compose tests;
- full Node test suite;
- root TypeScript check;
- frontend build;
- AI Python tests;
- Go/Python/Rust sidecar checks;
- `git diff --check`;
- strict credential and large-file scan.

## 8. Documentation And Evidence

Update:

- `docs/审核文档.md` with findings, fixes, local evidence, and unverified runtime items;
- `docs/ivekit-led-integration-guide.md` with external/self-hosted startup commands and dependency ordering;
- `docs/livekit-im-full-capability-plan.md` with the production-bootstrap phase status;
- `docs/ivekit-openapi.md` only if runtime capability or readiness responses change;
- a deployment acceptance record after real server execution.

Local tests and Compose rendering must continue to be described as configuration evidence only. Real database creation, bucket persistence, Egress writes, restart persistence, and failure recovery remain unverified until the server deployment restriction is lifted.

## 9. Non-Goals

- no server upload or Docker runtime launch in this phase;
- no Chatwoot production completion;
- no Kubernetes bootstrap implementation in this slice;
- no TURN/TLS/reverse-proxy implementation in this slice;
- no changes to OCR/ASR/AI provider selection;
- no deletion or reset of existing user data.

## 10. Acceptance Criteria

The design implementation is locally complete when:

1. fresh and existing-volume initialization behavior is represented by executable tests;
2. production base and Tinode overlay have explicit successful-bootstrap dependencies;
3. missing required database/bucket initialization fails closed;
4. Chatwoot cannot block the default iveKit stack and is not called production-ready;
5. all local regression and security gates pass;
6. documentation distinguishes local configuration evidence from pending real-server evidence.

The overall persistent goal remains active after this slice because real server deployment and end-to-end acceptance are intentionally not performed yet.
