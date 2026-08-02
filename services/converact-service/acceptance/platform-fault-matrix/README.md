# G02 platform fault matrix acceptance

This directory is the fenced, isolated entrypoint for controlled G02 dependency-fault campaigns. It is not a
production deploy path and it must never target the frozen production host or reuse a production Compose project,
volume, network, database, credential, port, or evidence directory.

## Current implementation status

- The evidence contract covers all 12 dependencies and every failure mode in the G02 machine fault matrix.
- The database executable slice runs an isolated PostgreSQL campaign: all migrations through 112, the real
  `opc_runtime` role, cross-tenant RLS negative checks, Inbox/EffectReceipt/Usage persistence, an actual PostgreSQL
  container stop/start, a fresh recovery process, replay/conflict/writer-fence checks and append-only enforcement.
- A bounded synthetic UDP stream runs across the database outage to diagnose causal isolation without making a
  Human Communication claim.
- The control-plane executable slice runs the production `BoundedWorkGate` on a fixed host, saturates active and
  pending admission, proves retry/fanout rejection before capacity consumption, and records bounded latency,
  event-loop and RSS measurements. It starts no container and makes no SIP/media/fleet capacity claim.
- The restore executable slice runs the production backup and restore functions against two project-scoped,
  digest-pinned PostgreSQL containers. The source is removed before a distinct empty target is created; a fresh
  process verifies exact database/object digests, RLS and append-only history. One parent process measures restore,
  runtime-role initialization and fresh-process verification through a single monotonic timing boundary.
- The drain executable slice runs the production Cell/component admission controllers, platform drain coordinator
  and event compatibility decisions across separate Node processes. It observes an actual `SIGKILL`, stale-owner
  rejection, the seven-phase monotonic drain sequence and an independent fresh-process verification of seven
  Ed25519-bound zero receipts. It performs no container action and makes no real-media or region claim. Until an
  exact-source fixed-host result is retained and reviewed, `G02-E11-DRAIN` remains `not_run`.
- Event system, object store, PKI/KMS, DNS, configuration, wall-clock, AI/GPU, recording upload, provider,
  observability and host/node adapters are not yet executed by this slice.
- Every unexecuted dependency remains `not_run`.
- `production_eligible` is always `false`; controlled evidence cannot change it.
- A synthetic packet or transport probe is useful for causal-isolation diagnostics, but synthetic transport is not
  real long human media and cannot satisfy the Human Communication acceptance gate.

## Safety boundary

The runner requires all of the following before any Compose action:

1. `CONVERACT_G02_FAULT_CONFIRM=G02_PLATFORM_FAULT_MATRIX`;
2. a bounded run ID, producing a dedicated `converact-g02-*` Compose project;
3. every container image by immutable `name@sha256:digest` reference;
4. randomly generated campaign-only admin/runtime database passwords that are never written to evidence;
5. no published database port and a private internal bridge reachable only from the validation host;
6. source commit, config hash, image digests, host/hardware/clock/workload/seed/time and raw-output hashes in the
   final evidence identity;
7. project-scoped cleanup only. The runner must not prune Docker or stop unrelated containers.

Validation plan example (no container is started):

```bash
CONVERACT_G02_FAULT_CONFIRM=G02_PLATFORM_FAULT_MATRIX \
CONVERACT_G02_FAULT_RUN_ID=contract-check \
CONVERACT_G02_SOURCE_COMMIT='<40 hex exact commit>' \
POSTGRES_IMAGE='postgres@sha256:<64 hex digest>' \
CONVERACT_G02_NODE_IMAGE='node@sha256:<64 hex digest>' \
NODE_BIN='/absolute/path/to/node-v24' \
./accept.sh plan
```

Controlled database campaign:

```bash
CONVERACT_G02_FAULT_CONFIRM=G02_PLATFORM_FAULT_MATRIX \
CONVERACT_G02_FAULT_RUN_ID='db-<unique suffix>' \
CONVERACT_G02_SOURCE_COMMIT='<40 hex exact commit>' \
POSTGRES_IMAGE='postgres@sha256:<64 hex digest>' \
CONVERACT_G02_NODE_IMAGE='node@sha256:<64 hex digest>' \
NODE_BIN='/absolute/path/to/node-v24' \
CONVERACT_G02_MEDIA_DURATION_MS=30000 \
./accept.sh database
```

The source tree must already contain `npm ci` dependencies and must run with Node v24. The runner records the exact
Node image and binary SHA-256, resolves the database's unpublished private bridge address, creates a unique
Compose project and evidence directory, generates both database passwords in memory, and removes only its own
container/network/volume. It refuses to overwrite an existing run. Evidence is written under
`.runtime/platform-fault-matrix/<run-id>/` with raw-file hashes, exact source/config/image/host/hardware/clock/workload
identity and a final `database-controlled-evidence.json`.

An accepted database result is only `verified_controlled` for that database restart scenario. An accepted control
result is only `verified_controlled` for the bounded platform control primitive on the exact measured host. The
aggregate matrix, real long media, SIP/media/mixed-cell/fleet capacity, multi-node drain, region recovery, DR and
production eligibility remain `not_run`.

Controlled fixed-host capacity campaign:

```bash
CONVERACT_G02_CONTROL_CONFIRM=G02_PLATFORM_CONTROL_EVIDENCE \
CONVERACT_G02_FAULT_RUN_ID='capacity-<unique suffix>' \
CONVERACT_G02_SOURCE_COMMIT='<40 hex exact commit>' \
CONVERACT_G02_NODE_IMAGE='node@sha256:<64 hex digest>' \
CONVERACT_G02_CAPACITY_OPERATIONS=2000000 \
NODE_BIN='/absolute/path/to/node-v24' \
./control-accept.sh
```

The control runner refuses a dirty or mismatched source checkout, records the exact Node binary, fixed hardware,
clock, workload and seed, scans every retained artifact, compares all pre-existing container state byte-for-byte,
and cannot start, stop or delete a container.

Controlled backup/restore campaign:

```bash
CONVERACT_G02_RESTORE_CONFIRM=G02_PLATFORM_RESTORE_EVIDENCE \
CONVERACT_G02_FAULT_RUN_ID='restore-<unique suffix>' \
CONVERACT_G02_SOURCE_COMMIT='<40 hex exact commit>' \
CONVERACT_G02_NODE_IMAGE='node:24-bookworm-slim@sha256:<64 hex digest>' \
POSTGRES_IMAGE='postgres@sha256:<64 hex digest>' \
NODE_BIN='/absolute/path/to/node-v24' \
./restore-accept.sh
```

The restore runner can act only on containers carrying its exact source/target
Compose project labels. It publishes no database port, removes its source and
target containers/networks/volumes, verifies pre-existing container snapshots,
and retains only secret-scanned textual evidence. RTO excludes target-container
boot and uses a process-local monotonic clock. Its frozen-checkpoint result does
not prove continuous-write PITR, regional DR or production eligibility.

Controlled rolling drain/node-loss campaign:

```bash
CONVERACT_G02_DRAIN_CONFIRM=G02_PLATFORM_DRAIN_EVIDENCE \
CONVERACT_G02_FAULT_RUN_ID='drain-<unique suffix>' \
CONVERACT_G02_SOURCE_COMMIT='<40 hex exact commit>' \
CONVERACT_G02_NODE_IMAGE='node:24-bookworm-slim@sha256:<64 hex digest>' \
NODE_BIN='/absolute/path/to/node-v24' \
./drain-accept.sh
```

The drain runner requires a clean exact-source checkout and Node v24. It also requires every pre-existing container
to be stopped, snapshots all of them before and after, and fails unless both snapshots are byte-identical. The
runner cannot start, stop or remove a container. Per-Authority public keys and signed receipts are retained and
secret-scanned; private signing material exists only in one bounded child-process lifetime. This controlled slice
does not prove independent production trust bootstrap, real SIP/media continuity, embedded-edge survival, region
recovery, DR or production eligibility.

Secrets, tokens, passwords, cookies, private keys and credentials are forbidden in evidence. Missing prerequisites,
partial campaigns, mock services, loopback media, upstream benchmarks and historical results never promote a real
dependency, long-media, capacity, DR or production claim.

Before finalization, every regular raw artifact in the bounded run directory is scanned for credential-shaped keys
and values. The scanner fails closed on private keys, bearer/JWT/provider tokens, password or API-key assignments,
binary data, symlinks, oversized files, or oversized campaigns. Its sorted SHA-256 manifest binds every scanned
artifact to `raw_output_sha256`; a hand-maintained artifact allowlist cannot silently omit a raw log.
