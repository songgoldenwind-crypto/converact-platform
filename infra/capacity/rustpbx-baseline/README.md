# RustPBX single-node baseline

This topology isolates PostgreSQL, the controlled Router/CDR fixture and the
iveKit-patched RustPBX process on `172.30.44.0/24`. It exposes no host ports.
SIPp uses the reserved `172.30.44.20` address through the same Docker network.

Prepare private runtime files:

```bash
RUSTPBX_IMAGE=ivekit/rustpbx:0.4.11-ivekit.12-6c49ee76 \
POSTGRES_IMAGE=postgres@sha256:029660641a0cfc575b14f336ba448fb8a75fd595d42e1fa316b9fb4378742297 \
PYTHON_IMAGE=python@sha256:399babc8b49529dabfd9c922f2b5eea81d611e4512e3ed250d75bd2e7683f4b0 \
CAPACITY_TOOLS_IMAGE=ivekit/capacity-tools:0.1.0-rustpbx-router-v1 \
python3 infra/capacity/rustpbx-baseline/prepare.py \
  /opt/ivekit-capacity-benchmark/runtime/rustpbx-baseline
```

Start the SUT and create the authenticated inbound trunk:

```bash
docker compose \
  --env-file /opt/ivekit-capacity-benchmark/runtime/rustpbx-baseline/.env \
  -f infra/capacity/rustpbx-baseline/docker-compose.yml \
  up -d --wait postgres router rustpbx

docker compose \
  --env-file /opt/ivekit-capacity-benchmark/runtime/rustpbx-baseline/.env \
  -f infra/capacity/rustpbx-baseline/docker-compose.yml \
  run --rm bootstrap
```

The route-reject workload sends an unknown DID and expects the controlled HTTP
router to return `486`. This is a SIP signaling baseline. It does not prove RTP,
PSTN, recording, media continuity, or Cell capacity.

Run one isolated signaling baseline after preparing the runtime files and
installing the pinned SIPp binary at `/opt/ivekit-capacity-benchmark/bin/sipp-3.7.7`:

```bash
infra/capacity/rustpbx-baseline/run.sh 1400 30
```

The runner resets the tmpfs database, bootstraps the trunk idempotently, applies
a wall-clock timeout, samples host and container resources, and passes only when
SIPp successes, Router requests and CDR requests all exactly match the expected
call count. Generator and SUT share one host, so this remains controlled baseline
evidence rather than a production capacity claim.
