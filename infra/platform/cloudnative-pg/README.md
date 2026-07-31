# CloudNativePG external platform profile

This directory defines the iveKit PostgreSQL HA consumer profile. It does not install the CloudNativePG operator, its CRDs, cert-manager, or the Barman Cloud Plugin. Platform operators install and lifecycle those cluster-scoped dependencies independently from the OPC/iveKit application Chart.

## Fixed upstreams

- CloudNativePG v1.30.0: `https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.0/cnpg-1.30.0.yaml`
- Barman Cloud Plugin v0.13.0: `https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.13.0/manifest.yaml`
- PostgreSQL 18.4 standard Trixie image: `ghcr.io/cloudnative-pg/postgresql:18.4-standard-trixie@sha256:4e4ac3fb2c914cfb44f80f0b8be8aa550e83b80bf5220df49c3a8780c1f79bc8`

The image digest is the multi-architecture OCI index resolved on 2026-07-23. Mirror all three artifacts into the production registry and verify signatures/SBOMs before rollout. Do not fetch release manifests implicitly from an application deployment.

## Required namespace and Secrets

Create the `opc-data` namespace through the platform repository. Create these Secrets through the production secret manager; this directory deliberately contains no credentials:

| Secret | Keys | Consumer |
| --- | --- | --- |
| `opc-postgres-bootstrap` | `username`, `password` | CNPG `initdb`; username must be `opc_app` |
| `opc-postgres-backup-credentials` | `ACCESS_KEY_ID`, `ACCESS_SECRET_KEY` | Barman Cloud Plugin sidecar |
| `opc-database-runtime` | `database-url` | OPC/iveKit application Chart |

`opc-database-runtime.database-url` should point to `opc-postgres-rw-pooler.opc-data.svc:5432` for ordinary request/worker traffic. Schema migrations, PostgreSQL `LISTEN/NOTIFY`, session advisory locks, temporary tables spanning transactions, and other session-bound operations must use a separately scoped Secret pointing to `opc-postgres-rw.opc-data.svc:5432`.

## Availability and connection budget

- Three PostgreSQL instances are spread across hostname and Zone fault domains.
- Quorum synchronous replication acknowledges a commit after one standby has persisted WAL. With `dataDurability: required`, writes pause when no synchronous standby is available; already established SIP/RTP/SFU/IM/remote-control forwarding continues because those hot paths do not synchronously depend on PostgreSQL.
- Three PgBouncer instances accept 4,000 clients each in transaction mode. Each process is capped at 120 server connections, reserving PostgreSQL headroom for direct migrations, operators, replicas and incident access.
- The Cluster's operator-managed PodDisruptionBudget remains enabled. The explicit pooler budget requires two PgBouncer pods during voluntary disruption.

These are admission limits, not measured throughput claims. Update them only with database connection and query evidence from the target workload profile.

## Backup and recovery

The profile uses the CNPG-I Barman Cloud Plugin. The deprecated in-tree `barmanObjectStore` field is intentionally absent. WAL is archived continuously and the six-field cron schedule starts a base backup at 02:15 UTC each day, preferring a standby.

The base `ObjectStore` uses `s3://opc-postgres-backups/cluster`. For AWS-compatible private storage, patch `spec.configuration.endpointURL` and optional `endpointCA`; do not change the Secret names or expose object-store credentials in Git.

PITR is a create-and-cut-over operation:

1. Copy `recovery-example.yaml` outside this base and set a verified recovery target.
2. Give the recovered cluster a unique name and unique WAL archive server name.
3. Apply it without modifying the running cluster.
4. Verify schema, tenant isolation, outbox continuity and application queries against the recovered rw Service.
5. Create a new runtime Secret pointing to the recovered service and roll application consumers.
6. Keep the previous cluster read-only until the rollback window closes.

`recovery-example.yaml` is deliberately excluded from `kustomization.yaml` so it can never be created by a routine platform apply.

## Rollout and rollback

1. Install the fixed operator and plugin versions in their platform namespaces.
2. Apply external Secrets and validate backup bucket permissions.
3. Apply this Kustomize base and wait for three healthy instances, synchronous state, WAL archive health and three Pooler pods.
4. Restore the most recent backup into a disposable cluster and run the acceptance suite.
5. Set the application Chart to `postgres.mode=external` and point `postgres.external` at `opc-database-runtime`.
6. Drain old application pods; do not dual-write databases.

Rollback changes only the application Secret reference to the previous PostgreSQL endpoint. Do not roll a schema backward and do not reuse one WAL archive server name for two writable clusters.

## Evidence boundary

Static manifests and server-side Helm tests prove configuration shape only. Node loss, Zone loss, WAL archive, standby backup, PITR, connection saturation and major upgrade remain `not_run_target_kubernetes` until executed on the target Kubernetes/storage environment.
