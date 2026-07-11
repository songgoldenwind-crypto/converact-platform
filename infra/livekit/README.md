# Standalone iveKit Media Core

This package deploys the reusable LiveKit media plane on one Linux VM. It follows the LiveKit production generator topology:

- Caddy L4 terminates TLS and routes WSS and TURN/TLS by SNI on `443/tcp`.
- LiveKit runs with host networking, direct ICE/TCP, ICE/UDP, and embedded TURN.
- Redis is bound to loopback and shared by LiveKit and Egress.
- Egress writes to external S3-compatible object storage.
- OPC and LED consume the same public WSS endpoint and API credentials.

It does not contain OPC source code and can be deployed as an independent service.

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

Generated files are written under `.runtime/livekit-edge` by default and are excluded from Git. `livekit.yaml` and `egress.yaml` are written with mode `0600` because they contain credentials.

## Static validation

```bash
docker compose \
  --env-file infra/livekit/.env \
  -f infra/livekit/docker-compose.yml \
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
