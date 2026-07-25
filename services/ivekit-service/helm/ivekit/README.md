# iveKit Standalone Helm Chart

This Chart deploys the standalone iveKit API, optional RustPBX workload, and optional bundled Tinode server. PostgreSQL remains an external dependency so the same application image can be embedded in OPC, LED, or another product without importing the OPC monolith.

## Deployment profiles

`values.yaml` is the minimal `core` profile. It starts the iveKit API but does not silently start bundled voice, IM, file-security, AI, observability, or benchmark workloads. The authoritative profile overlays are under `profiles/`:

- `core.values.yaml` is the mandatory production base.
- `ai.values.yaml` enables bounded OCR, ASR, translation and quality-processing loops; provider endpoints and credentials still come from the runtime Secret.
- `observability.values.yaml` enables ServiceMonitor, PrometheusRule and Grafana resources. The privileged eBPF observer still needs a separate explicit opt-in.
- `benchmark.values.yaml` is non-production and removes unrelated workers. POC systems are deployed only by isolated benchmark harnesses, not this Chart.

Apply `values.yaml` first, then one or more explicit overlays. The Chart rejects AI workers without `deploymentProfiles.ai=true`, monitoring or SIP tracing without `deploymentProfiles.observability=true`, and any deployment with `deploymentProfiles.core=false`. The machine-readable component authority is `docs/architecture/component-authority-matrix-v1.json`.

## Realtime LiveKit audio tap

`realtimeAudioTap.enabled` is false in the core profile and true in
`profiles/ai.values.yaml`. It enables the auxiliary PCM path used by realtime
captions and translation; it does not change LiveKit's primary media path.
The existing Secret must contain the canonical-base64 32-to-128-byte key named
by `secrets.realtimeAudioTapHmacSecretKey` (default
`realtime-audio-tap-hmac-secret-b64`).

Each API Pod receives its own Pod name as
`OPC_IVEKIT_LIVEKIT_AUDIO_TAP_INSTANCE_ID`. The authorization endpoint signs a
short-lived one-time token with a key derived for that Pod and returns the same
Pod's address through the headless `*-audio-tap` Service. This keeps the nonce
store local without allowing a token to be replayed against another replica.
Do not replace `OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_URL` with the regular
load-balanced Service.

Port 3010 is an internal PCM WebSocket. The generated NetworkPolicy permits
that port only from `realtimeAudioTap.networkPolicy.aiAgentPodSelector` in the
same namespace unless an explicit namespace selector is configured. The
regular HTTP port remains reachable under the release's existing policy. Do
not expose 3010 through Ingress, a public LoadBalancer, or a node port.

The two media inputs use different Pod-local boundaries. The LiveKit WebSocket
gateway remains in each API Pod and has
`OPC_IVEKIT_RUSTPBX_AUDIO_TAP_GATEWAY_ENABLED=0`. Every enabled RustPBX Pod
co-locates a dedicated `realtime-audio-tap-gateway` sidecar with
`OPC_IVEKIT_LIVEKIT_AUDIO_TAP_GATEWAY_ENABLED=0`; both containers share the
same memory-backed `/run/ivekit/realtime-audio-tap.sock`. RustPBX never sends
decoded PCM across a cluster Service before the bounded gateway. Tune
`realtimeAudioTap.rustPbxChannelCapacity` and `rustPbxSendTimeoutMs` only
within their validated bounds; a full queue or failed sidecar drops the
auxiliary tap and must not stall RTP forwarding.

The AI Agent captures each subscribed remote LiveKit audio track as mono
PCM16LE at 16 kHz and uses a bounded per-track queue. Slow or failed ASR and
translation Providers lose auxiliary frames instead of applying backpressure
to LiveKit. Persistent drops must be fixed by scaling or repairing the
Provider/gateway, not by making the buffer unbounded. Monitor
`opc_ivekit_voice_audio_tap_events_total`,
`opc_ivekit_voice_audio_tap_dropped_seconds_total`, and the three
`IveKitRealtimeAudioTap*` alerts.

## Tinode deployment modes

`tinode.enabled=false` keeps Tinode external. When enabled, the maintained iveKit Tinode image and an immutable digest are mandatory. `tinode.publicWsUrl` must be the production `wss://.../v0/channels` endpoint.

`tinode.mode=compact` is the small-footprint option. Compact mode supports exactly one replica, uses `Recreate`, persists `/botdata`, stores local media under `/botdata/uploads`, and mounts generated configuration, static files, logs, and temporary files on writable volumes while retaining a read-only root filesystem.

`tinode.mode=cluster` deploys the bundled Tinode three-node cluster. It creates a stable StatefulSet, a client Service, a headless ring Service, required host anti-affinity, dual-Zone topology spreading, and a PDB that preserves two nodes. Every node receives the same three ordinal/DNS members and derives `CLUSTER_SELF` from its Pod name. Cluster replicas skip database initialization; a blocking `pre-install,pre-upgrade` Job owns initialization and schema upgrade so three Pods cannot race. Shared S3 media is mandatory because Pod-local media is not coherent across nodes.

The existing Secret must provide `tinode-postgres-dsn`, `tinode-api-key-salt`, `tinode-api-key`, `tinode-auth-token-key`, `tinode-uid-encryption-key`, `tinode-basic-user`, `tinode-basic-password`, and `tinode-user-password-secret`. Cluster mode additionally reads `tinode-s3-access-key-id` and `tinode-s3-secret-access-key`; values may rename keys but never contain secret values. Set `tinode.cluster.media.region`, `bucket`, optional S3-compatible `endpoint`, and CORS origins as non-secret values. Set `forcePathStyle=true` for MinIO or SeaweedFS deployments which do not provide virtual-host bucket DNS; leave it `false` for AWS S3.

Every iveKit API Pod runs an idempotent Tinode service account bootstrap init container. It creates the configured basic account or proves the existing credentials can log in before the API process starts. A Tinode outage, invalid API key, or credential drift keeps the Pod in init failure instead of starting a partially configured chat runtime. Bundled mode explicitly enables inbound and delivery workers; leases and outboxes in PostgreSQL allow all API replicas to share those workers without fixed worker IDs. Set either worker value to `"0"` only for a deliberate maintenance window.

The Tinode database bootstrap supports both an absent target database and a precreated empty target database. Grant the bootstrap role `CREATEDB` only when it must create the target database; a precreated database can be initialized without recreating it. Install and upgrade values must never enable `RESET_DB` or `TINODE_RESET_DB`; schema changes run through the single blocking hook before cluster Pods start.

When network policy is enabled, iveKit API pods are allowed automatically. In cluster mode, port 12000 accepts traffic only from Tinode Pods. Add the ingress controller selector to `tinode.networkPolicy.additionalIngressFrom` before exposing browser WebSocket traffic. The browser-facing URL is rendered from `tinode.publicWsUrl`; credentials remain Secret references.

Both `image.repository` and `image.digest` are required. When `clamav.enabled=true`, `clamav.image.repository` and an immutable `clamav.image.digest` are also required. The migration hook runs `ivekit-init-runtime-role` and the advisory-locked forward migration before each install or upgrade. The application Deployment is not changed when that hook fails.

The secure-file scan and FFmpeg derivative workers remain configured, but both workers and bundled ClamAV are disabled in the minimal core profile. Enable them explicitly when file processing belongs to this release. Bundled ClamAV is a minimum two-replica StatefulSet: each Pod owns an independent RWO signature volume, stale signatures remove only that Pod from the client Service, a PDB and required host anti-affinity preserve the scanner pool, and the clamd port is private behind NetworkPolicy. It uses the official `/init-unprivileged` entrypoint and has a 4 GiB memory limit to tolerate signature reloads. Multiple API replicas safely share file jobs through PostgreSQL claim leases and `FOR UPDATE SKIP LOCKED`; do not set fixed worker IDs across replicas.

A ClamAV outage must not gate API readiness or active communication. The API Deployment has no scanner init dependency; unscanned files remain quarantined, scan claims retry durably, and scanner readiness is monitored separately from the communication control plane.

See `docs/deployment/clamav-ha-scanner-pool.md` for signature, EICAR, outage, scaling and recovery acceptance. Repository rendering is controlled evidence only; target-cluster tests remain `not_run` until archived from the deployment environment.

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

`monitoring.sipExporter.enabled=true` adds an optional off-path eBPF SIP/RTP observer. It is not a SIP proxy and never participates in call admission or media forwarding. Enabling it requires an immutable `monitoring.sipExporter.image.digest`, the exact host interface that carries visible voice traffic, and a `nodeSelector` that limits the DaemonSet to voice nodes. Host labels and upstream telemetry stay disabled by default. Validate CNI/hostNetwork visibility, encrypted SIP limitations, kernel/seccomp support for `BPF`, `NET_ADMIN`, and `NET_RAW`, and CPU/packet-loss overhead before enabling it in production. Do not grant unrestricted privileged mode or `SYS_ADMIN` merely to make an old node kernel work.

```yaml
monitoring:
  sipExporter:
    enabled: true
    image:
      repository: frzq/sip-exporter
      digest: sha256:<64-hex-digest>
    interface: eth0
    hostLabels: false
    telemetry: false
    nodeSelector:
      ivekit.io/voice-node: "true"
```

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
