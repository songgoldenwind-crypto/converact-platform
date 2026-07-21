# iveKit Standalone Helm Chart

This Chart deploys the standalone iveKit API, optional RustPBX workload, and optional bundled Tinode server. PostgreSQL remains an external dependency so the same application image can be embedded in OPC, LED, or another product without importing the OPC monolith.

## Tinode deployment modes

`tinode.enabled=false` keeps Tinode external. This is the required mode for an external Tinode cluster and for high-availability Tinode deployments.

`tinode.enabled=true` deploys bundled Tinode for a compact production installation. The image must use an immutable digest. The existing Secret must provide `tinode-postgres-dsn`, `tinode-api-key-salt`, `tinode-api-key`, `tinode-auth-token-key`, `tinode-uid-encryption-key`, `tinode-basic-user`, `tinode-basic-password`, and `tinode-user-password-secret`; values may rename those keys but never contain secret values themselves. `tinode.publicWsUrl` is required and must be the production `wss://.../v0/channels` endpoint. The bundled workload supports exactly one replica and uses `Recreate` with persistent `/botdata`. Use an external Tinode cluster instead of increasing `tinode.replicaCount`.

Every iveKit API Pod runs an idempotent Tinode service account bootstrap init container. It creates the configured basic account or proves the existing credentials can log in before the API process starts. A Tinode outage, invalid API key, or credential drift keeps the Pod in init failure instead of starting a partially configured chat runtime. Bundled mode explicitly enables inbound and delivery workers; leases and outboxes in PostgreSQL allow all API replicas to share those workers without fixed worker IDs. Set either worker value to `"0"` only for a deliberate maintenance window.

When network policy is enabled, iveKit API pods are allowed automatically. Add the ingress controller selector to `tinode.networkPolicy.additionalIngressFrom` before exposing browser WebSocket traffic. The browser-facing URL is rendered from `tinode.publicWsUrl`; credentials remain Secret references.

Both `image.repository` and `image.digest` are required. With the default `clamav.enabled=true`, `clamav.image.repository` and an immutable `clamav.image.digest` are also required. The migration hook runs `ivekit-init-runtime-role` and the advisory-locked forward migration before each install or upgrade. The application Deployment is not changed when that hook fails.

The Chart enables the secure-file scan and FFmpeg derivative workers, keeps destructive cleanup disabled, persists ClamAV signatures, and exposes `clamd` only as a ClusterIP. ClamAV uses the official `/init-unprivileged` entrypoint and has a 4 GiB default memory limit to tolerate signature reloads. The iveKit init container waits for `clamd` before API startup. Multiple API replicas safely share file jobs through PostgreSQL claim leases and `FOR UPDATE SKIP LOCKED`; do not set fixed worker IDs across replicas.

Create `secrets.existingSecret` outside Helm. It contains only the configured admin database URL, runtime database URL, runtime database password, and optional RustPBX bootstrap keys; the API reads only the runtime URL from it. Put API/provider runtime variables in a separate Secret and set `secrets.runtimeEnvironmentSecret` when needed. This prevents the long-running API from importing the admin DSN through `envFrom`. Keep non-secret worker settings under `config.env`.

The Helm workload requires shared S3-compatible object storage because the default deployment has multiple replicas and a read-only root filesystem. Put `S3_BUCKET` or its `OPC_S3_BUCKET`/`MINIO_BUCKET` alias plus the matching endpoint and credentials in `secrets.runtimeEnvironmentSecret`. Helm sets `OPC_OBJECT_STORAGE_REQUIRED=1`; startup fails before serving traffic when no bucket is configured instead of falling back to pod-local `data/uploads`.

Notification encryption/HMAC keys and every credential named by `OPC_IVEKIT_NOTIFICATION_WEBHOOK_SECRET_ENV_NAMES` or `OPC_IVEKIT_NOTIFICATION_PROVIDER_SECRET_ENV_NAMES` belong in `secrets.runtimeEnvironmentSecret`. Keep delivery and active-health workers disabled until the endpoints and allowlists are configured. `config.env` exposes the bounded poll, lease, batch, concurrency, retry, and readiness settings but must never contain secret values.

The integration-event Webhook bridge remains disabled until `config.env.OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED` is set to `"1"`. Enable it only after the notification delivery worker and the receiver's durable inbox are operational. Migration 073 keeps subscription cursors and leases in PostgreSQL, so replicas may share the workload without fixed worker IDs; the bridge does not require another queue or SQLite database.

`notificationWorker.enabled=true` deploys a dedicated worker-only StatefulSet instead of running
delivery loops inside API Pods. Each Pod derives
`OPC_IVEKIT_NOTIFICATION_PARTITION_INDEX` from its stable StatefulSet ordinal and uses
`notificationWorker.replicaCount` as the common partition count. Migration 081 maps every delivery
to one of 1024 stable logical shards; PostgreSQL claim leases remain the duplicate-delivery fence.
Keep notification provider profiles and referenced secrets in
`secrets.runtimeEnvironmentSecret`. Scaling changes shard ownership but does not require data
rewrites. Do not also enable `config.env.OPC_IVEKIT_NOTIFICATION_WORKER_ENABLED` on API Pods.

Monitoring resources are opt-in because the Prometheus Operator CRDs and Grafana sidecar are external cluster dependencies. Enable `monitoring.serviceMonitor.enabled`, `monitoring.prometheusRule.enabled`, and `monitoring.grafanaDashboard.enabled` only after those dependencies exist. The rule and dashboard source files are under `files/` and can also be loaded directly by non-Helm Prometheus and Grafana installations. Keep the metrics endpoint private to the monitoring network; it contains bounded operational labels but is not an end-user API.

Voice is disabled by default. Enabling it additionally requires the iveKit-patched immutable RustPBX digest, the source-built immutable Kamailio digest, one exact Region/Zone/Cell identity, a tenant ID, a profile ID, and the configured RustPBX database URL/password, management API token, RWI token, webhook token, voice address HMAC root, route snapshot signing key, Kamailio route/topoh/RPC keys and TLS keypair/CA in the existing Secret. The management and RWI tokens must be distinct. The route signing key must be a distinct canonical-base64 32-byte secret; the address HMAC key must be the same root used by the iveKit API. The route projector sidecar polls one revision row, loads the bounded route set only after an authoritative routing change, renews the HMAC-only snapshot near expiry by atomic rename, and shares it with RustPBX through pod-local `emptyDir`. RustPBX fails new inbound routing closed when the snapshot is missing, invalid, or stale. The API runtime Secret must expose the same management token as `RUSTPBX_MANAGEMENT_TOKEN` and the RWI token as `RUSTPBX_RWI_TOKEN`. Set `voice.amiAllows` and `voice.kamailio.trustedSourceCidrs` to explicit networks; wildcard trust is forbidden. The RustPBX database and role must be provisioned before deployment.

One Chart release is one Cell in one Zone. The default production topology uses a two-replica Kamailio StatefulSet behind a source-preserving L4 Service and a host-networked RustPBX StatefulSet with stable ordinal owners and a headless management Service. Configure exact `voice.webphone.allowedOrigins`, project the WebPhone JWT secret named by `voice.webphone.jwtSecretKey`, and restrict `voice.kamailio.rustpbxSourceCidrs` and `voice.kamailio.dmqSourceCidrs` to real internal networks. Authenticated WebPhone locations replicate over the Kamailio headless Service on UDP 5066; that port is intentionally absent from the public SIP Service. SIP/TLS/WSS are exposed only by Kamailio; RTP remains direct to RustPBX node addresses. Deploy Zone B as a separate release with its own identity and lease epoch. Because hostNetwork NetworkPolicy behavior is CNI-specific, enforce RustPBX management/SIP and RTP ranges with node firewall/security-group rules as well. Route-agent proxies bounded loopback Kamailio metrics through the internal metrics Service; JSON-RPC and the raw xhttp endpoint never receive a Service.

`voice.recordingSpool.enabled=true` co-locates the bounded recording uploader.
The existing Secret must additionally provide the key named by
`voice.recordingSpool.leaseSecretKey`; the webhook-token key is projected as the
profile service key. RustPBX and the uploader share the durable spool while
uploader state survives process restart. When component-node admission is also
enabled, its background gate reads `metrics.json` from the state volume and
rejects only new reservations requiring `data.local_spool_bytes` after stale or
90-percent evidence; no per-INVITE disk or network call is added to RustPBX.
The uploader also persists finalization retries for the owner-bound
`recording-completed.json` marker. iveKit advances the parent manifest only
after all expected `1..N` segments are uploaded; a missing segment leaves the
manifest in `uploading` and returns a retryable conflict.

The default Voice Secret key names are `rustpbx-database-url`,
`rustpbx-database-password`, `rustpbx-management-token`, `rustpbx-rwi-token`,
`rustpbx-webhook-token`, `ivekit-voice-address-hmac-key`, and
`rustpbx-route-snapshot-hmac-key`. Values may rename these keys through
`voice.*Key` fields, but the secret values themselves must not enter
`values.yaml`.

Cell owner-epoch enforcement is required when the Kamailio Edge is enabled.
Configure the exact Region, Zone, Cell
capacity profile IDs and the qualified RustPBX capacity vector under
`voice.componentNode`; put the shared node token under
`voice.componentNode.tokenKey` in the existing Secret. The sidecar and RustPBX
share Pod networking on `127.0.0.1:3210`. The Pod remains unready until Cell
lease recovery and reservation replay complete, and stale RWI mutations fail
closed. Without a Cell admission synchronizer the deployment intentionally
stays fail-closed for new calls.

Trunk and extension credentials are referenced as `env://NAME`. Add every referenced key and value to `secrets.runtimeEnvironmentSecret`, then add each key name to the comma-separated `config.env.OPC_IVEKIT_VOICE_SECRET_ENV_NAMES` allowlist. The management and RWI token names must remain present. Do not put credential values in `values.yaml`, `config.env`, Provider profile JSON, or resource API payloads.

Application rollback may select an earlier immutable image only when it is compatible with the expanded schema. There are no automatic down migrations; database recovery uses a verified pre-upgrade backup.
