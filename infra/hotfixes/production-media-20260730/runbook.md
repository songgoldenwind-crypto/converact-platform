# Production media owner hotfix — 2026-07-30

This procedure patches only the retained old OPC release and connects it to the
already deployed old LiveKit and Cell binaries. It never upgrades those three
baselines, never touches an LED container, and never writes synthetic runtime
heartbeats. The resulting server release is frozen after canary acceptance.
The bridge is valid only on the same Docker host.

The temporary component control channel is plaintext only inside one internal
Docker bridge on the same host. It is not approved across hosts. Record
`HOTFIX_NON_MTLS_EXPIRES_AT` at most 72 hours ahead, prove the host clock is
synchronized, install an expiry alert, and reserve a rollback window before
that time.

## Immutable retained baselines

Stop immediately if any value differs:

- OPC container `ivekit-goal3-0f9b063-opc-1`, image ID
  `sha256:530e6e3345c0801cfb0ed73b6356b43f78f97344696d12677d567711551484ea`,
  tag `ivekit/opc:im-final8-3f1a7d3ab2f3`.
- Cell container `ivekit-goal3-0f9b063-cell-admission-1`, image ID
  `sha256:83296c08de7b798cdb753527d216efd5b7dc1ef6ec8a05c1233f16a4f9feece3`.
- LiveKit container `opc-ivekit-media-livekit-1`, image ID
  `sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963`.
- OPC Compose working directory
  `/opt/opc-ivekit-goal3/source-im-final2-625c2f973a1d/infra/ivekit`.
- Cell Compose working directory
  `/opt/opc-ivekit-goal3/source-7edfcab-bundle/infra/ivekit`.
- LiveKit Compose working directory
  `/opt/opc-ivekit-led/source/infra/livekit`.

Use each running container's exact `com.docker.compose.project`,
`working_dir`, and `config_files` labels. OPC, Cell and LiveKit intentionally
come from three different revisions.

Every Compose `run` or `up` command below uses `--pull never`. No registry
pull, dependency upgrade, retag, or rebuild of the retained binaries is
allowed.

## Protected paths

Create a new `0700` release root and separate the evidence from the exact
Docker build context:

```sh
RELEASE_ROOT=/secure/releases/production-media-20260730-REPLACE
HOTFIX_ROOT="$RELEASE_ROOT/hotfix"
BUILD_CONTEXT="$RELEASE_ROOT/context"
EVIDENCE_ROOT="$RELEASE_ROOT/evidence"
VALIDATION_ENV=/secure/runtime/production-media-hotfix.validation.env
API_ENV=/secure/runtime/production-media-hotfix.api.env
CELL_ENV=/secure/runtime/production-media-hotfix.cell.env
MEDIA_ENV=/secure/runtime/production-media-hotfix.livekit.env
API_BASE_ENV=/secure/runtime/production-media-hotfix.api.base.env
CELL_BASE_ENV=/secure/runtime/production-media-hotfix.cell.base.env
MEDIA_BASE_ENV=/secure/runtime/production-media-hotfix.livekit.base.env
```

All environment files are `0600`. Never print them. Never put credentials,
cookies, authorization headers, raw Idempotency-Key values, room names, or
participant tokens in evidence.

`BUILD_CONTEXT` contains exactly the 13 sorted paths in `payload.paths`.
`HOTFIX_ROOT/Dockerfile.opc` is outside that context. It may also hold the
overlays, validator and runbook. No `.env`, Git metadata, `node_modules`, full
source tree, or LED file may enter `BUILD_CONTEXT`.
The old source directory remains read-only for the entire procedure.
Do not write `ivekit_runtime_heartbeats`.

## Phase 0 — freeze, inventory and restore point

Before any container mutation:

1. From two independent requests, prove the retained old API currently returns
   HTTP `503` for exactly `POST /api/ivekit/media/calls`.
2. Prove active Call = 0 (Media Call scope only), nonterminal `livekit_av`
   placement = 0,
   effective `livekit_av` admission reservation = 0, and active LiveKit room =
   0. Existing `sip_voice` and `tinode_im` placement rows are out of scope and
   must not be changed. The legacy summary marker is
   `active/reserved/call = 0`.
3. Record redacted container/image/Compose labels and image IDs.
4. Record every base Compose absolute path and SHA-256.
5. Prove port `127.0.0.1:3210` is unused and no container currently has the
   `livekit-component-node` alias.
6. Prove `timedatectl show -p NTPSynchronized --value` is `yes`; record
   `clock synchronized` evidence with UTC time and offset.
7. Create an encrypted database restore point: schema-only definitions for
   `schema_migrations`, the Media Call/placement/admission tables, plus a
   redacted `schema_migrations(version, checksum)` export. Do not dump business
   rows or secrets.
8. Back up the three protected base environment files and current placement
   topology, encrypted and read-only.

The API hotfix is first started with:

```text
OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE=1
OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE_RULE_ID=production-media-20260730
OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_TENANT_IDS=
OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_SUBJECTS=
OPC_IVEKIT_MEDIA_CALL_CREATE_REQUIRE_PLACEMENT=1
```

This is an independent API-path freeze. It does not depend on placement being
missing. Query, Join, End and cleanup routes remain available.

Record the freeze rule ID, a redacted configuration hash, two structured 503
responses, and `Retry-After`. Do not continue if a Call can be created.

## Exact 13-file payload evidence

For every path in `payload.paths`, create:

- `base-payload.sha256`: SHA-256 of the exact retained OPC source file, or the
  literal `ABSENT` for a new path.
- `hotfix-payload.sha256`: SHA-256 of every final payload file; no `ABSENT`.
- a canonical payload-only patch whose `diff --git` paths are all in
  `payload.paths`.

The manifest format is:

```text
<64 lowercase hex or ABSENT><two spaces><repository-relative path>
```

Paths are sorted and appear exactly once. Hash each manifest itself and set:

```text
IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256
IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256
IVEKIT_OPC_HOTFIX_PATCH_SHA256
IVEKIT_OPC_PAYLOAD_FILE_COUNT=13
```

Extract the same present paths from the retained OPC image and compare them to
`base-payload.sha256`; each `ABSENT` path must also be absent in that image.
After building, extract all 13 `/app/...` paths and compare them to
`hotfix-payload.sha256`.

Build exactly once, without pulling:

```sh
docker build --pull=false --no-cache \
  --file "$HOTFIX_ROOT/Dockerfile.opc" \
  --build-arg OPC_BASE_IMAGE="$IVEKIT_OPC_BASE_IMAGE" \
  --build-arg OPC_BASE_IMAGE_ID="$IVEKIT_OPC_BASE_IMAGE_ID" \
  --build-arg OPC_BASE_PAYLOAD_MANIFEST_SHA256="$IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256" \
  --build-arg OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256="$IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256" \
  --build-arg OPC_HOTFIX_PATCH_SHA256="$IVEKIT_OPC_HOTFIX_PATCH_SHA256" \
  --build-arg OPC_PAYLOAD_FILE_COUNT="$IVEKIT_OPC_PAYLOAD_FILE_COUNT" \
  --tag "$IVEKIT_OPC_HOTFIX_IMAGE" \
  "$BUILD_CONTEXT"
```

Record the immutable result as `IVEKIT_OPC_HOTFIX_IMAGE_ID`. Verify all six
`io.ivekit.hotfix.*` labels, the exact image ID, the exact 13 extracted files,
and that the image differs from the base image.

## Validation

Create the internal Cell control bridge and the one-member host-loopback
transport only after Phase 0 evidence:

```sh
docker network inspect ivekit-owner-control >/dev/null 2>&1 ||
  docker network create --internal ivekit-owner-control
docker network inspect ivekit-owner-loopback >/dev/null 2>&1 ||
  docker network create ivekit-owner-loopback
```

Do not attach any unrelated or LED container. The owner-control network remains
internal for Cell DNS. The separate non-internal network exists only so Docker
can activate a port published on the host loopback; only the component may join
it. The validator proves:

- retained LiveKit and capacity references resolve to the exact current image
  IDs and RepoDigests;
- the OPC derivative has the expected manifest/patch labels;
- all six retained Compose files match their absolute paths and SHA-256;
- running container Compose project, working directory and file ownership
  match;
- rendered critical images, `pull_policy`, volumes and networks are preserved;
- retained LiveKit remains in its exact `host` network mode and reaches the
  loopback-bound component control port at `http://127.0.0.1:3210`; Cell
  services alone use `http://livekit-component-node:3210` on the internal
  owner-control bridge;
- Cell topology stores the credential-free HTTPS provider endpoint; the media
  call path derives the corresponding public WSS client URL;
- the bridge is internal;
- after component start, exactly one component container owns the
  `livekit-component-node` alias and one IPv4 address;
- the host-loopback transport is non-internal and contains only the component;
- both the declared and active bindings contain exactly one
  `127.0.0.1:3210` mapping.

```sh
node "$HOTFIX_ROOT/validate.mjs" \
  --env-file "$VALIDATION_ENV" \
  --api-env-file "$API_ENV" \
  --cell-env-file "$CELL_ENV" \
  --livekit-env-file "$MEDIA_ENV" \
  --api-base "$API_BASE" \
  --api-voice-base "$API_VOICE_BASE" \
  --cell-base "$CELL_BASE" \
  --cell-voice-base "$CELL_VOICE_BASE" \
  --livekit-base "$LIVEKIT_BASE" \
  --livekit-storage-base "$LIVEKIT_STORAGE_BASE"
```

## Guarded migration runner

The `postgres-migrate` overlay replaces the old command with
`scripts/run-production-media-hotfix-migration.ts`. Under the canonical
`opc_schema_migrations` advisory lock, the guarded migration runner:

1. reads the exact image migration plan;
2. requires every historical plan entry to exist with the exact nonblank
   checksum;
3. requires the only missing plan entry to be
   `106_ivekit_media_call_create_commands`;
4. permits unrelated already-applied database rows, including the retained
   Tinode 106 migration;
5. runs the existing checksum-aware migration implementation while still
   holding the same lock;
6. verifies the target checksum after commit.

Any historical gap, blank checksum, drift, later image migration, or target
mismatch aborts without running SQL.

```sh
docker compose --project-name "$IVEKIT_API_PROJECT_NAME" \
  --env-file "$API_ENV" \
  -f "$API_BASE" \
  -f "$API_VOICE_BASE" \
  -f "$HOTFIX_ROOT/api-hotfix.override.yml" \
  run --pull never --rm --no-deps postgres-migrate
```

Verify the target table columns, checks, two uniqueness constraints, expiry
index, FORCE RLS policy, and `opc_runtime` grants. Keep the restore point.

## Start sequence

All steps use the exact retained Compose files and `--pull never`.
Every Cell command also uses the retained `voice-capacity` profile explicitly.

1. Recreate only OPC with the independent freeze active:

   ```sh
   docker compose --project-name "$IVEKIT_API_PROJECT_NAME" \
     --env-file "$API_ENV" \
     -f "$API_BASE" \
     -f "$API_VOICE_BASE" \
     -f "$HOTFIX_ROOT/api-hotfix.override.yml" \
     up --pull never -d --no-deps --no-build --force-recreate opc
   ```

   Require `/livez=200`, `/readyz=200`, exact hotfix image ID,
   `capabilities.calls=false`, rule ID present, two independent structured
   create 503 responses, and no new Call/placement/reservation row.

2. Start only the bounded component node:

   ```sh
   docker compose --project-name "$IVEKIT_LIVEKIT_PROJECT_NAME" \
     --env-file "$MEDIA_ENV" \
     -f "$LIVEKIT_BASE" \
     -f "$LIVEKIT_STORAGE_BASE" \
     -f "$HOTFIX_ROOT/livekit-owner.override.yml" \
     up --pull never -d --no-deps --no-build livekit-component-node
   ```

   `/livez` returns `200`; before the Cell lease, `/readyz` returns `503`.
   Verify PID limit 128, memory limit 256 MiB, the active loopback binding,
   the one-member host-loopback transport, and the unique Cell alias/IP.

3. Recreate only LiveKit with the owner guard:

   ```sh
   docker compose --project-name "$IVEKIT_LIVEKIT_PROJECT_NAME" \
     --env-file "$MEDIA_ENV" \
     -f "$LIVEKIT_BASE" \
     -f "$LIVEKIT_STORAGE_BASE" \
     -f "$HOTFIX_ROOT/livekit-owner.override.yml" \
     up --pull never -d --no-deps --no-build --force-recreate livekit
   ```

4. Atomically install the validated merged Cell environment. It adds only
   `livekit_av`, one two-participant dimension, one node and one probe. Restart:

   ```sh
   docker compose --project-name "$IVEKIT_CELL_PROJECT_NAME" \
     --profile voice-capacity \
     --env-file "$CELL_ENV" \
     -f "$CELL_BASE" \
     -f "$CELL_VOICE_BASE" \
     -f "$HOTFIX_ROOT/cell-owner.override.yml" \
     up --pull never -d --no-deps --no-build --force-recreate cell-admission

   docker compose --project-name "$IVEKIT_CELL_PROJECT_NAME" \
     --profile voice-capacity \
     --env-file "$CELL_ENV" \
     -f "$CELL_BASE" \
     -f "$CELL_VOICE_BASE" \
     -f "$HOTFIX_ROOT/cell-owner.override.yml" \
     up --pull never -d --no-deps --no-build --force-recreate rustpbx-capacity-projector

   docker compose --project-name "$IVEKIT_CELL_PROJECT_NAME" \
     --profile voice-capacity \
     --env-file "$CELL_ENV" \
     -f "$CELL_BASE" \
     -f "$CELL_VOICE_BASE" \
     -f "$HOTFIX_ROOT/cell-owner.override.yml" \
     up --pull never -d --no-deps --no-build --force-recreate rustpbx-placement-snapshot-projector
   ```

   Require Cell readiness, a fresh signed placement snapshot, exactly one
   `livekit_av` owner, `video.participants.safe_capacity=2`, and no recovery
   error. The API remains frozen for everyone.

## Phase 1 — exact retained canary only

Keep `OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE=1`. Put only the retained canary
tenant and exact authenticated subjects in the two allowlists, validate again,
then recreate only OPC. No wildcard or general unfreeze is permitted by this
hotfix.

Acceptance uses two independent authenticated browser sessions:

1. Log in separately; do not reuse cookies or a browser profile.
2. Create one two-party call and record a redacted request ID and billing key.
3. Replay the same Idempotency-Key and identical payload; require the same
   Call, placement and reservation.
4. Send a different payload with the same Idempotency-Key; require HTTP 409 and
   no side effect.
5. Query recovery with the original authenticated requester; require the same
   result. A same-tenant nonparticipant must receive not-found.
6. Join both participants. Verify audio in both directions, video in both
   directions, DTMF/hold behavior applicable to the retained flow, and browser
   WebRTC statistics with increasing `bytesSent` and `bytesReceived`.
7. Correlate both browser request IDs with OPC, Cell, component and LiveKit
   logs without exposing tokens or participant content.
8. End the call from the product flow. Require participant cleanup and final
   active Call = 0 (Media Call scope only), nonterminal `livekit_av`
   placement = 0, effective
   `livekit_av` admission reservation = 0, and active LiveKit room = 0.

Also prove the same Idempotency-Key does not create a second billing writer,
recording identity or directed media edge.

## Expiry alert and frozen observation window

Before Phase 1, record two externally monitored alerts:

- warning at least 24 hours before `HOTFIX_NON_MTLS_EXPIRES_AT`;
- critical at least 2 hours before it.

Attach evidence that the alert route is live and an owner has accepted the
planned rollback window. The non-mTLS exception is not extended in place.

After acceptance, leave the API frozen except for the retained canary cohort.
Freeze the resulting server release for several days: do not edit code,
rebuild, retag, upgrade dependencies, change topology, tune capacity, or
recreate containers. Read-only logs, metrics, health, safe database counts and
browser function evidence are allowed.

## Base-only rollback

Re-enable the all-user freeze by clearing both canary allowlists, then wait for
active Media Call, `livekit_av` placement, `livekit_av` admission reservation
and active LiveKit room counts to reach zero. Do not alter `sip_voice` or
`tinode_im` placement rows. Restore placement topology before removing the Cell node.

Restore topology and Cell base environment first. Every base-only rollback
command must omit every hotfix override:

```sh
docker compose --project-name "$IVEKIT_CELL_PROJECT_NAME" \
  --profile voice-capacity \
  --env-file "$CELL_BASE_ENV" \
  -f "$CELL_BASE" \
  -f "$CELL_VOICE_BASE" \
  up --pull never -d --no-deps --no-build --force-recreate rustpbx-placement-snapshot-projector

docker compose --project-name "$IVEKIT_CELL_PROJECT_NAME" \
  --profile voice-capacity \
  --env-file "$CELL_BASE_ENV" \
  -f "$CELL_BASE" \
  -f "$CELL_VOICE_BASE" \
  up --pull never -d --no-deps --no-build --force-recreate cell-admission rustpbx-capacity-projector
```

Prove the new signed snapshot no longer advertises `livekit_av`.

Restore LiveKit from its exact base files and image:

```sh
docker compose --project-name "$IVEKIT_LIVEKIT_PROJECT_NAME" \
  --env-file "$MEDIA_BASE_ENV" \
  -f "$LIVEKIT_BASE" \
  -f "$LIVEKIT_STORAGE_BASE" \
  up --pull never -d --no-deps --no-build --force-recreate livekit
```

Restore OPC from its exact old environment and base image:

```sh
docker compose --project-name "$IVEKIT_API_PROJECT_NAME" \
  --env-file "$API_BASE_ENV" \
  -f "$API_BASE" \
  -f "$API_VOICE_BASE" \
  up --pull never -d --no-deps --no-build --force-recreate opc
```

Verify OPC image ID
`sha256:530e6e3345c0801cfb0ed73b6356b43f78f97344696d12677d567711551484ea`,
Cell image ID
`sha256:83296c08de7b798cdb753527d216efd5b7dc1ef6ec8a05c1233f16a4f9feece3`,
and LiveKit image ID
`sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963`.
Verify hotfix owner environment is absent from those base containers.

Remove `livekit-component-node` last, after Cell no longer targets it:

```sh
docker compose --project-name "$IVEKIT_LIVEKIT_PROJECT_NAME" \
  --env-file "$MEDIA_ENV" \
  -f "$LIVEKIT_BASE" \
  -f "$LIVEKIT_STORAGE_BASE" \
  -f "$HOTFIX_ROOT/livekit-owner.override.yml" \
  rm -s -f livekit-component-node
docker network rm ivekit-owner-control
docker network rm ivekit-owner-loopback
```

Leave additive migration 106 in place; old code does not use it. Never drop a
table during emergency rollback and never repair state by writing
`ivekit_runtime_heartbeats` or admission rows manually.
