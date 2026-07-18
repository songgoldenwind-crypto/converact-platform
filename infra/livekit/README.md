# Standalone iveKit Media Core

This package deploys the reusable LiveKit media plane on one Linux VM. It follows the LiveKit production generator topology:

- Caddy L4 terminates TLS and routes WSS and TURN/TLS by SNI on `443/tcp`.
- LiveKit runs with host networking, direct ICE/TCP, ICE/UDP, and embedded TURN.
- Redis is bound to loopback and shared by LiveKit and Egress.
- Egress writes to external S3-compatible object storage.
- OPC and LED consume the same public WSS endpoint and API credentials.

It does not contain OPC source code and can be deployed as an independent service.

When external S3 is unavailable, apply `docker-compose.storage.yml` as an optional overlay. It runs a pinned MinIO release, exposes its API and console on loopback only, initializes a private bucket and bucket-scoped service account, and prevents Egress from starting until that initialization succeeds. `MINIO_ROOT_*` is bootstrap-only; OPC and Egress receive only `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`.

## Storage failure isolation

LiveKit Server is the real-time media plane and depends only on its shared Redis
state, never on Egress, MinIO or S3. Egress is a downstream consumer of LiveKit;
the optional storage overlay adds a dependency only to Egress. If Egress or
object storage is unavailable, rooms, published tracks, subscriptions and screen
sharing must continue. Automatic recording start is fail-open for an already
accepted call: iveKit broadcasts `call.answered`, returns `call_status=active`
and the room/token with `recording_status=scheduled`, then resolves recording
consent and starts Egress in the background. A later failure is reduced to an
allowlisted code and emitted as `call.recording_failed`; provider text is never
copied into the response or event. SDK requests use the
bounded `LIVEKIT_EGRESS_REQUEST_TIMEOUT_SECONDS` value (default 3 seconds), but
that timeout runs outside the accept path. The recording may be absent or
incomplete, but the live media session must not be terminated.

The same Caddy L4 edge can optionally terminate TLS for the application plane. Set `IVEKIT_API_DOMAIN` and/or `TINODE_PUBLIC_DOMAIN`; their upstreams default to loopback ports `8300` and `6060`. Leave both blank for a Media-Core-only deployment.

## Requirements

- Linux host with Docker Compose and a public IP.
- `livekit.example.com` and `turn.example.com` DNS records pointing to that IP.
- Public inbound access for `80/tcp`, `443/tcp`, `7881/tcp`, `3478/udp`, and the configured RTC UDP range.
- S3-compatible storage reachable from the media host.
- OPC LiveKit webhook URL reachable from the media host.

## Render

Create `infra/livekit/.env` from `env.example`, replace every placeholder, then run from the repository root:

```bash
set -a
source infra/livekit/.env
set +a
npm run render:livekit-edge
```

Generated files are written under `.runtime/livekit-edge` by default and are excluded from Git. `livekit.yaml` is written with mode `0600`; `egress.yaml` uses `0640` so the official non-root Egress process can read it through its root group without making credentials world-readable.

## Static validation

```bash
docker compose \
  --env-file infra/livekit/.env \
  -f infra/livekit/docker-compose.yml \
  config
```

For the optional private MinIO overlay:

```bash
docker compose \
  --env-file infra/livekit/.env \
  -f infra/livekit/docker-compose.yml \
  -f infra/livekit/docker-compose.storage.yml \
  config
```

This command validates the standalone Compose structure only. It does not prove DNS, TLS, firewall, ICE, TURN, Egress, or object storage connectivity.

`npm run livekit:deployment-preflight` is the full OPC/LED integration preflight. Run it from the application deployment environment after loading both the standalone Media Core values and the OPC smoke/auth/storage values; the edge `.env` alone intentionally does not contain application API tokens or smoke identities.

## Start on Linux

```bash
docker compose \
  --env-file infra/livekit/.env \
  -f infra/livekit/docker-compose.yml \
  up -d
```

Add `-f infra/livekit/docker-compose.storage.yml` before `up -d` when using the private MinIO overlay. In that mode set `MINIO_ENDPOINT=http://127.0.0.1:9000`; do not expose ports `9000` or `9001` publicly.

The OPC runtime then uses separate addresses:

```text
LIVEKIT_URL=ws://<private-media-ip>:7880
LIVEKIT_PUBLIC_URL=wss://livekit.example.com
```

Never return the internal address to a browser.

## Required real acceptance

The deployment is not production-accepted until all of the following have captured evidence:

1. Both DNS records resolve to the intended media host.
2. Caddy obtains trusted certificates for both domains.
3. Two browsers on different networks complete audio, video, and screen sharing.
4. Direct UDP, ICE/TCP fallback, and forced TURN relay each succeed.
5. Egress creates a recording and the object is readable from storage.
6. Restart, reconnect, and failure recovery behavior matches the acceptance runbook.

## Acceptance evidence bundle

From the application repository, initialize one deterministic, secret-safe evidence directory:

```bash
OPC_LIVEKIT_ACCEPTANCE_BUNDLE_DIR=/var/lib/opc-evidence/livekit/<release> \
  npm run livekit:acceptance-bundle
```

The command writes the environment checklist, preflight report, server/client runbooks, an unfilled client template, manifest and an initially `incomplete` evidence pack. It deliberately does not create `server-evidence.json`, `readiness.json`, or `client-acceptance-result.json`; those files must come from the deployed server and real clients using the commands in `manifest.json`.

Set `OPC_LIVEKIT_ACCEPTANCE_ENVIRONMENT_ID`, `OPC_LIVEKIT_ACCEPTANCE_DEPLOYED_COMMIT`, the trusted QA Ed25519 public key path and its SHA-256 fingerprint before initialization. The bundle creates or accepts one safe run ID/start time and computes a deployment fingerprint. It refuses a directory that already contains real evidence. Every passed client check must use a distinct readable JSON artifact with a full matching SHA-256, one matching check ID, run metadata, timestamp, capture tool and the required check-specific details. An independent QA approver signs a distinct approval manifest containing the preflight, server, readiness and all client evidence hashes.

After every real run, regenerate the index with `npm run livekit:evidence-pack`. Only `ready_for_customer_review` is eligible for delivery review. DNS/TLS/TCP/UDP-send server checks do not replace selected ICE candidate-pair, forced TURN, real media, Egress, isolation, recovery, performance or SIP evidence.
