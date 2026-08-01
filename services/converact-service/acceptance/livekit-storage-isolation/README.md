# LiveKit Storage Isolation Acceptance

This package runs a controlled destructive fault drill against an isolated Docker Compose project. It opens two
Chromium peers, publishes microphone and camera tracks, starts RoomComposite Egress, stops the configured object
storage service, verifies media continuity before and after the recording failure, and restores storage before
closing the peers.

Do not point it at a shared or production Compose project. A controlled result never promotes the V6 LiveKit or
Object Storage production evidence groups.

## Install

```bash
npm ci --ignore-scripts
npm run install:chromium
```

## Source checkout

Run from the repository root against the local call-center Compose project:

```bash
export LIVEKIT_URL=ws://127.0.0.1:7880
export LIVEKIT_API_KEY="$LOCAL_LIVEKIT_API_KEY"
export LIVEKIT_API_SECRET="$LOCAL_LIVEKIT_API_SECRET"
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT=converact-storage-drill
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILE=docker-compose.callcenter.yml
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_OUTPUT_FILE=/secure/evidence/storage-isolation.json
npm run livekit:storage-isolation-acceptance
```

## Delivery bundle

Run from this package directory after rendering and starting the bundled standalone Media Core. Compose paths are
relative to the current directory, and the JSON array preserves base/overlay order.

```bash
export LIVEKIT_URL=ws://127.0.0.1:7880
export LIVEKIT_API_KEY="$LOCAL_LIVEKIT_API_KEY"
export LIVEKIT_API_SECRET="$LOCAL_LIVEKIT_API_SECRET"
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_COMPOSE_PROJECT=converact-storage-drill
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_COMPOSE_FILES='["../../deploy/livekit/docker-compose.yml","../../deploy/livekit/docker-compose.storage.yml"]'
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_COMPOSE_ENV_FILE=../../deploy/livekit/.env
export CONVERACT_LIVEKIT_STORAGE_ISOLATION_OUTPUT_FILE=/secure/evidence/storage-isolation.json
npm run accept
```

The command passes only when all four two-peer snapshots remain connected with the expected publications and both
peers' inbound/outbound audio bytes, video bytes, RTP packets, and decoded video frames strictly increase at every
stage. The first Egress must end as `failed` with `storage_upload_failed`; after storage bootstrap recovers, a second
Egress must finish as `complete` while media continues. The output reports
`status=passed_controlled_runtime`, `media_transport_progress_verified=true`, and `storage_recovered=true`.
The evidence file is forced to mode `0600` and omits tokens, secrets, object-store URLs, and raw Egress errors.
