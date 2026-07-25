# iveKit Capacity Runtime Deployment

This directory deploys the low-rate capacity command dispatcher, Cell admission/projector, and
restart-safe generator worker control process. It never carries SIP, RTP, WebRTC, Tinode messages,
or RustDesk frames; each generator binary connects directly to the SUT.

## Build the capacity tools image

From the repository root, or from the delivery bundle's `capacity-runtime/` directory:

```bash
docker build \
  -f infra/capacity/Dockerfile \
  -t ivekit/capacity-tools:source-candidate \
  .
```

The image build installs the dedicated pinned `infra/capacity/package-lock.json`,
runs the `infra/capacity/tsconfig.json` compile, and prunes build-only TypeScript
and type packages before switching to the non-root user.
The delivery bundle contains this complete build context and identifies it as
`manifest.json.contents.capacity_runtime`; no OPC business-domain source is required.

## Controlled local deployment

`docker-compose.yml` starts one authenticated NATS JetStream node and one dispatcher by default.
Set a random `OPC_IVEKIT_CAPACITY_NATS_PASSWORD`; this controlled topology deliberately uses one
stream replica and must never support a production HA claim. Supply an already migrated PostgreSQL
database through `OPC_DATABASE_URL`. The optional `worker` profile starts one
generator worker; the optional `controller` profile creates or resumes the immutable run and
advances all manifest phases:

```bash
docker compose \
  --profile controller \
  --profile worker \
  --env-file infra/capacity/env.example \
  -f infra/capacity/docker-compose.yml \
  up capacity-nats capacity-dispatcher capacity-controller capacity-worker
```

`OPC_IVEKIT_CAPACITY_WORKER_BUNDLE_HOST_PATH` must point to an immutable read-only directory that
contains `driver-spec.json`, the SHA-pinned generator binary, and protected bundle files referenced
by the spec. Generator results use the named writable volume; evidence is uploaded to S3-compatible
object storage. This topology is for code and restart validation, not for a capacity claim.

Example driver spec:

```json
{
  "schema_version": "1.0.0",
  "executable": "/opt/ivekit-capacity-worker/bin/tinode-loadgen",
  "binary_version": "tinode-loadgen@replace-with-commit",
  "binary_sha256": "replace-with-64-lowercase-hex",
  "result_directory": "/var/lib/ivekit-capacity/results",
  "timeout_ms": 600000,
  "args": ["--profile", "cell-10k-v1"],
  "static_input": {
    "credential_bundle_path": "/opt/ivekit-capacity-worker/secrets/legacy.json",
    "composite_credential_bundles": [
      {
        "run_id": "replace-with-run-id",
        "phase_id": "steady",
        "shard_id": "connection/tinode_websocket/3000-6000",
        "path": "/opt/ivekit-capacity-worker/secrets/steady-3000-6000.json",
        "sha256": "replace-with-64-lowercase-hex"
      }
    ]
  }
}
```

The external process receives the fenced shard command on stdin and must write a bounded
`CapacityShardExecutionResult` JSON object. Secrets should be referenced by mounted paths, not
embedded in the spec or result. Tinode composite workers require one unique binding for every
covered shard. Every worker mounts the same immutable bundle directory and binding table; selection
uses the exact run, phase, and shard identity, and execution fails before opening sockets when the
bundle SHA-256 does not match.

When the controller reaches `finalizing`, create the evidence submission from generator, SUT, and
independent observation outputs. It must include one record for every
`<phase_id>/<shard_id>`. Then run the one-shot finalizer:

```bash
docker compose \
  --profile finalizer \
  --env-file infra/capacity/env.example \
  -f infra/capacity/docker-compose.yml \
  run --rm capacity-finalizer
```

The finalizer derives expected phases, shards, fleets, and external dependencies from the immutable
run manifest. It does not trust caller-provided expected totals. It writes and verifies a run-scoped
evidence manifest before PostgreSQL can transition the run to `completed`, `failed`, or `not_run`.

## Strict Tinode single-node staircase

Run the host-side staircase only on an isolated validation machine with Docker available. It creates
one disposable PostgreSQL/Tinode network per point, generates point-scoped credentials in `0600`
files, samples Tinode expvar plus container and generator resources, and removes every secret and
Docker resource before advancing:

```bash
node --import tsx scripts/ivekit-capacity-tinode-staircase.ts \
  --output-file /absolute/path/tinode-strict-staircase.json \
  --tinode-image ivekit/tinode:v0.25.3-ivekit.3-22a7c18e-amd64 \
  --postgres-image postgres:16@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20 \
  --points 100,250,500,1000
```

The output binds source hashes, exact image IDs, hardware, strict connection/interaction start
windows, client/SUT reconciliation and time-series resource samples. A passing result always keeps
`capacity_claim=none`: it is a controlled ceiling check, not a failure frontier, scaling curve or
production capacity claim.

After all point runs are terminal, `ivekit:capacity:scaling-finalizer` or
`kubernetes/scaling-finalizer-job.yaml` reloads their verified S3 objects and replays the complete
frontier history. After nine component-role curves, the Cell curve, and the shared-data curve are
terminal, `ivekit:capacity:platform-finalizer` or `kubernetes/platform-finalizer-job.yaml` applies
the final MIX-100K gate. Migrations 091 and 092 persist these two evidence levels. See
`docs/capacity/campaign-finalization-runbook.md` for the immutable submission contracts.

## Kubernetes deployment

`kubernetes/dispatcher-deployment.yaml` expects:

- an immutable capacity-tools image digest;
- Secret `ivekit-capacity-runtime` with `database-url`, multi-node TLS `nats-url`, `nats-user`, and
  `nats-password`;
- Secret `ivekit-capacity-nats-tls` with `ca.crt`, `tls.crt`, and `tls.key` for client mTLS;
- a three-node JetStream quorum; the dispatcher refuses an existing command stream that is not
  configured with three replicas;
- migration `077_ivekit_capacity_orchestrator.sql` applied first;
- PostgreSQL and NATS deployed in independent failure domains.

`kubernetes/worker-statefulset.yaml` is copied once per fleet and requires:

- a fleet-specific immutable worker image digest containing the generator binary;
- stable pod identity for worker fencing;
- ConfigMap `ivekit-capacity-worker` and driver spec ConfigMap;
- S3 evidence configuration and optional credentials;
- one in-flight shard per worker process;
- resource requests derived from generator qualification, not from target marketing numbers.

The worker stores a generator result checkpoint in PostgreSQL before object-storage side effects.
JetStream redelivery resumes evidence publication and shard completion without starting the traffic
generator twice. Migration `082_ivekit_capacity_worker_checkpoints.sql` upgrades databases that
already ran migration 077.

The worker runtime and templates have controlled code coverage. RTP, LiveKit, RustDesk, SIPp, and
large Tinode/WS worker binaries and all physical capacity results remain `not_run` until immutable
binaries are built, hashed, qualified, and executed.

`kubernetes/controller-deployment.yaml` runs two fenced controller replicas against an immutable
manifest volume. `kubernetes/finalizer-job.yaml` is a retryable one-shot Job for the reviewed
evidence submission. The finalizer waits for the prior controller lease to expire instead of
bypassing fencing.

The scaling and platform finalizer Jobs mount their reviewed contract/submission volume read-only
and use the same bounded S3 reader. Controlled results never produce capacity claims. Production
`platform_pass` additionally requires all required role curves, Cell/shared-data curves, and the
exact 100,000-interaction endpoint; those physical executions remain `not_run` until run.
