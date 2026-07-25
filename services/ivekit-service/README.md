# iveKit Standalone Service

This package owns the build and runtime dependencies of the reusable iveKit HTTP and WebSocket service.

Do not build this directory directly inside the OPC monorepo because its `src/` tree is generated from the audited dependency graph. Generate and verify an isolated context from the repository root:

```bash
npm run verify:ivekit:standalone-context
```

The generated context contains only the iveKit source graph, this package manifest and lockfile, the standalone Dockerfile, and explicitly selected communication migrations. The boundary verifier rejects OPC call-center, legacy OPC IVR, frontend, unresolved imports, undeclared runtime packages, symlinks, extra files, and lockfile drift while retaining standalone `agent-runtime/ivekit/ivr`.

The generated `migrations/` directory includes the minimal fresh-database foundation, communication schema, forced tenant RLS, and standalone runtime security hardening. Apply migrations with the one-shot compiled entrypoint before starting the long-running service:

```bash
npm run migrate
```

The standalone Helm Chart source is under `helm/ivekit/`. It requires an immutable application image digest and an externally managed Secret, runs runtime-role initialization plus advisory-locked forward migrations as a `pre-install,pre-upgrade` hook, and deploys the API only after that hook succeeds. PostgreSQL and communication providers remain external dependencies; optional RustPBX is enabled separately with its own digest and database.

Helm also requires shared S3-compatible object storage through the runtime environment Secret. Its multi-replica workload sets `OPC_OBJECT_STORAGE_REQUIRED=1`, so a missing `S3_BUCKET`, `OPC_S3_BUCKET`, or `MINIO_BUCKET` fails startup instead of writing to a pod-local directory.

The included Compose file runs the compiled `init:runtime-role` entrypoint before `migrate`. It creates or rotates `opc_runtime`, applies default and existing-object grants, and revokes schema creation and migration-ledger access. The long-running service uses `opc_runtime` with `NOSUPERUSER NOBYPASSRLS`; only the one-shot role and migration jobs receive `opc_admin` credentials.

For an isolated foundation deployment, generate the context, replace both passwords in `env.example`, and run Compose from the generated directory:

```bash
docker compose --env-file env.example up --build
```

The default intelligence, Tinode, and Voice workers are disabled. The production Compose and Helm surfaces enable the secure-file scan and local FFmpeg derivative workers, run ClamAV only on the private workload network, and keep destructive cleanup disabled until both cleanup flags are explicitly set. Source and delivery Compose both require immutable `IVEKIT_POSTGRES_IMAGE` and `CLAMAV_IMAGE` references; `env.example` supplies reviewed `tag@sha256` values.

Notification delivery and active health workers are disabled by default. Configure distinct notification encryption/HMAC keys, Provider credentials and their environment-name allowlists before enabling them. Endpoint health checks are lease-safe across replicas, reject unsafe HTTP destinations, and use SMTP `verify()` without sending mail. The API/SDK provide template, endpoint, delivery, test, archive and guarded retry operations; see `docs/ivekit-notification-operations-runbook.md`.

The integration-event Webhook bridge is also disabled by default. Migration `073_ivekit_integration_webhooks.sql` owns product-neutral subscriptions, cursors and leases in PostgreSQL. Enable `OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED=1` only after notification delivery is running and the receiving service has a durable inbox. The bridge reuses notification Webhook signing, destination protection, retries and dead letters; it never delivers directly from request handlers. See `docs/ivekit-integration-event-webhook-runbook.md`.

ClamAV persists signatures under `/var/lib/clamav`, runs through the official unprivileged entrypoint, and needs substantial memory while signatures reload. The supplied limits reserve 2 GiB and allow 4 GiB. The API replicas use PostgreSQL claim leases and `FOR UPDATE SKIP LOCKED`, so scan, derivative, and cleanup jobs remain single-owner when more than one API replica runs. `clamd` port 3310 must never be published outside the Compose network or Kubernetes ClusterIP because it has no transport authentication.

A ClamAV outage must not gate API readiness or active communication. Compose and Helm start the API without waiting for `clamd`; pending files remain quarantined and the bounded scan worker retries through its durable PostgreSQL state. Scanner health is observed independently, and recovery resumes file processing without restarting SIP, WebRTC, IM, or remote-control sessions.

Run the compiled V3 configuration gate before enabling OCR, ASR, quality, or translation workers:

```bash
npm run preflight:intelligence
```

For the optional Voice profile, render the RustPBX configuration and run the Voice gate with compiled entrypoints that are included in the production image:

```bash
npm run render:rustpbx
npm run render:kamailio-compose
npm run render:kamailio
npm run route:kamailio
npm run preflight:voice
npm run project:rustpbx-routes
```

The Voice deployment also runs the compiled `upload:rustpbx-recordings`
sidecar. It uploads bounded local segments outside the media path, resumes
multipart state after restart, publishes local spool watermarks, and submits
the final owner-bound completion marker only after every local segment has been
confirmed. PostgreSQL advances the parent recording only when the expected
sequence is contiguous and fully uploaded.

The route projector is a long-running RustPBX sidecar, not a one-shot operator
command. Compose and Helm provide a shared route-snapshot volume. It reads only
active DID HMACs and applied published route versions from the iveKit PostgreSQL
database, signs a short-lived canonical snapshot, and replaces the file
atomically. The patched RustPBX image consumes that file without a per-INVITE
HTTP/database lookup. Configure a tenant ID, profile ID, a distinct 32-byte
base64 snapshot signing key, and the same voice-address HMAC root used by the
iveKit API.

Both Compose Voice profiles put Kamailio in front of RustPBX and enable
owner-epoch enforcement. `--profile voice` starts one RustPBX owner while the
predeclared second destination remains unavailable; `--profile voice-capacity`
starts two owners with separate RTP ranges, storage, recording spool state and
component-node sidecars. RustPBX never publishes SIP 5060 on the host. Only
Kamailio publishes UDP/TCP 5060, TLS 5061 and WSS 7443; route-agent metrics are
bound to host loopback. Neither profile is HA because Compose has one Edge.

Configure the exact Region, Zone, Cell epoch, profile, two stable owner IDs,
advertised SIP/WSS host and explicit trusted source CIDRs from `env.example`.
The Kamailio image must be digest-pinned. Route HMAC, topoh, JSON-RPC and TLS
material use file-backed Compose secrets. The value in
`KAMAILIO_COMPONENT_NODE_TOKEN_FILE` must exactly match
`OPC_IVEKIT_COMPONENT_NODE_TOKEN`, because route-agent and patched RustPBX
consume the same component-node authority through different process contracts.
Every node starts draining and `/readyz` remains unhealthy until the Cell
admission synchronizer acquires its lease and completes checkpoint replay; do
not hand-edit dispatcher state to bypass that fail-closed startup.

WebPhone access additionally requires an exact HTTPS Origin allowlist and the
file-backed WebPhone JWT secret shared by iveKit, Kamailio and RustPBX. The Edge
verifies the browser token only at WSS handshake, binds its subject to SIP From,
and sends RustPBX a new 30-second internal assertion for each SIP request.
RustPBX remains authoritative for REGISTER; Kamailio saves the location only
after a 2xx response. Compose has one Edge and deliberately disables DMQ, so it
can verify REGISTER/refresh/unregister but cannot prove cross-Edge delivery or
WebPhone HA. The Helm StatefulSet uses private UDP 5066 DMQ for that production
contract.

The browser handshake carries its short-lived token in the WSS query string.
Configure every LoadBalancer, Ingress, WAF and CDN in front of Kamailio to omit
the query string or irreversibly redact `token`; never place the complete WSS
URL in access logs, error pages, metrics, tickets or packet-capture evidence.

Voice trunk and extension objects store only `env://NAME` references. For Compose, put any additional credential values in `voice-runtime.env`, set `OPC_IVEKIT_VOICE_SECRET_ENV_NAMES` to the complete comma-separated allowlist, and keep the file mode at `0600`. The optional file is injected only into the iveKit API service; it is not mounted into RustPBX, PostgreSQL, migration, or recovery containers. `RUSTPBX_MANAGEMENT_TOKEN` and `RUSTPBX_RWI_TOKEN` remain separate required variables and must stay in the allowlist.

```dotenv
OPC_IVEKIT_VOICE_SECRET_ENV_NAMES=RUSTPBX_MANAGEMENT_TOKEN,RUSTPBX_RWI_TOKEN,ACME_SIP_TRUNK_PASSWORD,AGENT_8199_PASSWORD
ACME_SIP_TRUNK_PASSWORD=replace-with-provider-secret
AGENT_8199_PASSWORD=replace-with-extension-secret
```

For Helm, place the same named keys in `secrets.runtimeEnvironmentSecret` and set the same allowlist under `config.env.OPC_IVEKIT_VOICE_SECRET_ENV_NAMES`. Secret values must never be put in Provider profile JSON, API payload metadata, Helm `config.env`, or committed environment examples.

Real Voice acceptance is an operator-run release gate, not a long-running service or a controlled Compose profile. Generate the source-bound 45-check template and runbook from the repository with `npm run ivekit:voice-acceptance`, or use `acceptance/voice-real-template.json`, `acceptance/voice-real-runbook.md`, and `acceptance/tools/ivekit-voice-acceptance.ts` from the delivery bundle. Validation requires distinct SHA-256-bound observations from real RustPBX, SIP/PSTN, browser RTP, IVR, recording, bridge, Contact Center, recovery, isolation, and performance runs. A successful result is `ready_for_review`; real RustPBX remains `not_run` until independent QA approves those artifacts.

Provider profile metadata is supplied through `OPC_IVEKIT_PROVIDER_PROFILES_JSON`; secrets stay in dedicated environment variables or an external secret manager. The generated delivery bundle carries `operations/release-contract.json` and `operations/upgrade-runbook.md`. Migrations are forward-only; application rollback selects a compatible prior immutable image, while schema recovery restores a verified pre-upgrade backup.
