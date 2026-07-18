# iveKit RustPBX image

This directory builds the RustPBX image used by iveKit Voice Foundation.

## Why it exists

RustPBX `0.4.11` uses rsipstack `0.5.18`. The upstream transport cache keeps a
closed outbound TCP connection and the next call to the same SIP target can fail
with `Broken pipe`. The included patch removes only the matching stale connection
and retries one failed TCP transaction send on a new connection.

The build also pins `rustrtc` to `0.3.90`. RustPBX commit `6c49ee76` was written
for that API, while an unconstrained Cargo resolution currently selects `0.3.91`.

RustPBX `0.4.11` returns AMI dialogs without identifiers. The iveKit AMI patch
adds the SIP `call_id`/`dialog_id` and active-call registry entries so a timed-out
RWI originate can be reconciled by the deterministic `call_id` supplied by the
client. The endpoint remains protected by the existing AMI authentication and
network allowlist.

The upstream RWI originate command handler only cancelled its task after
`call.hangup`; it did not terminate the established SIP dialog. The iveKit RWI
hangup patch sends CANCEL before answer and BYE after answer, so a successful
hangup command also clears the downstream SIP leg.

The iveKit route snapshot patch removes the per-INVITE control-plane HTTP and
PostgreSQL lookup from the configured RustPBX data path. A sidecar publishes a
signed, short-lived snapshot by atomic rename. RustPBX verifies the signature,
tenant/profile identity, sequence and expiry, derives the same tenant-scoped
voice-address lookup key as iveKit, and performs one HMAC plus an in-memory map
lookup. Snapshot files contain only the existing `e164_hmac` values, never clear
or encrypted phone numbers. Missing, invalid or stale snapshots fail closed with
SIP 503; unknown numbers return 404.

The on-disk wire format is one fixed version/signature header followed by the
canonical JSON body. It does not wrap JSON inside another escaped JSON string,
so a normal 100,000-DID snapshot stays within the enforced 64 MiB file limit and
avoids a redundant parse/copy. The RustPBX refresh loop reads only the bounded
signature header on each poll and performs the full file read, HMAC verification
and JSON decode only after the signature changes.

Route snapshots deliberately remove dynamic routing from the INVITE hot path,
but every accepted inbound call must still acquire an authoritative Cell owner.
The inbound-admission patch sends one bounded authenticated request to the
profile `/inbound-admission` endpoint before the local route snapshot lookup.
The request declares the receiving RustPBX Cell and node. iveKit
reserves that exact owner, persists the call and placement atomically, and rejects
stale, draining, unavailable or mismatched nodes. Admission timeout, malformed
responses and non-success responses fail closed with SIP 503; RustPBX never falls
back to an unfenced local route.

The owner-epoch patch then binds the admitted provider call to the same durable
reservation through the local component-node agent. The first open and periodic
lease refresh use RustPBX's asynchronous HTTP client outside RTP processing.
Tracked RWI mutations compare the supplied epoch against the in-process guard;
bridge, transfer, ringback and supervisor commands validate every referenced
call ID. No RTP packet, codec, mixer or recording frame path calls the agent.

iveKit sends owner contracts in the RWI envelope's internal `ivekit_owners`
field, outside the public voice command payload. Parking pickup resolves both
call owners and fails before RWI execution when the legs are assigned to
different RustPBX nodes.

Migration `079_ivekit_voice_route_snapshot_revision.sql` maintains one monotonic
source revision per tenant/profile. DID, trunk, route, published version,
capability and profile changes bump it transactionally. The projector normally
reads only that one row; it reloads and recompiles the bounded route set only
when the revision changes, and otherwise rewrites the snapshot only near expiry.
This prevents a 100,000-DID profile from becoming a periodic full-table polling
load.

Snapshot mode is enabled only when `IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_FILE` is set.
It also requires:

- `IVEKIT_RUSTPBX_ROUTE_SNAPSHOT_HMAC_KEY`
- `IVEKIT_RUSTPBX_ROUTE_LOOKUP_HMAC_ROOT_KEY`
- `IVEKIT_RUSTPBX_ROUTE_TENANT_ID`
- `IVEKIT_RUSTPBX_ROUTE_PROFILE_ID`

Snapshot admission additionally requires:

- `IVEKIT_RUSTPBX_INBOUND_ADMISSION_URL`
- `IVEKIT_RUSTPBX_INBOUND_ADMISSION_SERVICE_KEY`
- `IVEKIT_RUSTPBX_CELL_ID`
- `IVEKIT_RUSTPBX_OWNER_NODE_ID`

`IVEKIT_RUSTPBX_INBOUND_ADMISSION_TIMEOUT_MS` defaults to 250 ms and is bounded
to 20-2000 ms. The service key must resolve to the same profile-scoped
`webhook_service_key` used for the RustPBX provider. Cell and node identifiers
must match the active placement topology; they are not advisory labels.

Owner-epoch enforcement is opt-in for compatibility. Set
`IVEKIT_RUSTPBX_COMPONENT_NODE_ENABLED=true` only when the local sidecar is
deployed and synchronized by the Cell admission service. It additionally
requires:

- `IVEKIT_RUSTPBX_COMPONENT_NODE_URL=http://127.0.0.1:3210`
- `IVEKIT_RUSTPBX_COMPONENT_NODE_TOKEN`
- `IVEKIT_RUSTPBX_COMPONENT_NODE_TIMEOUT_MS` (default `500`)
- `IVEKIT_RUSTPBX_COMPONENT_NODE_REFRESH_MS` (default `3000`)

Compose uses the additional `voice-capacity` profile. Helm uses
`voice.componentNode.enabled`. The agent starts draining and does not become
ready until the Cell sends a current lease and completes checkpoint replay.

The lookup root must equal iveKit's `OPC_IVEKIT_VOICE_ADDRESS_HMAC_KEY`. The
snapshot signing key must be a distinct random 32-byte canonical base64 secret.

## Recording spool

iveKit recording mode is enabled with
`IVEKIT_RUSTPBX_RECORDING_SPOOL_ENABLED=true`. RustPBX writes bounded local
segments under `IVEKIT_RUSTPBX_RECORDING_SPOOL_DIR`; it never uploads from the
RTP or recorder sample path. Region, Zone, Cell and owner-node identity are
required and become part of every immutable segment manifest.

The separate `ivekit-rustpbx-recording-spool` process validates stable regular
files and SHA-256, registers the exact owner epoch, resumes persisted multipart
parts, and removes local files only after server completion. Its service key and
lease secret are mounted as read-only files. The component-node process reads
only the sidecar's atomic `metrics.json` in the background; it does not read the
filesystem per INVITE. New reservations carrying `data.local_spool_bytes` fail
closed when the observation is stale or projected usage crosses 90 percent.
Existing reservations and cleanup remain available.

Object storage and the upload sidecar are downstream-only dependencies. An
outage can delay or lose recording evidence, but cannot stop an established SIP
dialog or its RTP forwarding. RustPBX does not depend on the uploader service;
the uploader depends on RustPBX and shares only the durable spool volume. If the
local recording writer itself fails, the first failed write opens a per-recording
circuit breaker. Later samples are counted as dropped without another disk write
or per-packet warning, while RTP forwarding continues through the independent
non-blocking path. Affected recordings must be marked incomplete and alerted;
they must never be reported as successfully recorded.

Recorder creation and finalization also run on a separate fixed four-thread,
512-entry lifecycle executor. SIP recording start is fire-and-forget;
StopRecording schedules finalization without awaiting its reply; pause/resume
update the atomic gate and use only `try_write` for optional spool events.
Session destruction and the reaper use the same deduplicated finalizer. The
Recorder destructor performs no synchronous flush or spool I/O. If lifecycle
workers or their queue are unavailable, RustPBX emits `RecordingFailed` and
preserves call/RTP progress instead of applying backpressure to signaling.
Before finalization, the lifecycle worker waits for already accepted capture
items with a bounded deadline, disables new capture if the first deadline
expires, and never falls back from `try_write` to a blocking recorder lock.
Drain or lock timeout fails only the recording and resets finalization for a
later cleanup attempt; it never waits on the signaling or RTP thread.

Channel saturation remains non-blocking: the forwarding path increments a
shared `AtomicU64` only when recorder `try_send` returns `Full`. The recorder
drains that counter at segment close and publishes an owner-fenced
`sample_dropped` event with the exact count. After the last segment is durable,
RustPBX atomically writes `recording-completed.json`. The uploader retains and
uploads the evidence, but manifest finalization sums all owner-fenced
`sample_dropped` events. Any non-zero total produces terminal
`recording_samples_dropped` failure rather than `uploaded_unverified`, even if
every segment reached object storage. The shared drop counter is registered
idempotently when the asynchronous recorder becomes available, so samples seen
before recorder creation cannot disappear from the final integrity decision.
retries that marker until iveKit confirms that sequences `1..N` all exist and
are uploaded, then removes the local indexes and marker. A missing segment can
therefore delay finalization but cannot be silently skipped.

The internal provider endpoints are:

- `POST /api/ivekit/voice/providers/:profile_id/recording-spool/segments`
- `PUT /api/ivekit/voice/providers/:profile_id/recording-spool/segments/:segment_id/parts/:part_number`
- `POST /api/ivekit/voice/providers/:profile_id/recording-spool/segments/:segment_id/complete`
- `POST /api/ivekit/voice/providers/:profile_id/recording-spool/recordings/:recording_id/complete`

All derive the tenant from the profile service key; body tenant fields are not
trusted. The recording completion route also rechecks the current placement
owner and exact Region/Zone/Cell/node identity.

Compose requires `RUSTPBX_RECORDING_SERVICE_KEY_FILE` and
`RUSTPBX_RECORDING_LEASE_SECRET_FILE`. The service-key file contains the same
profile-scoped webhook service key; the lease secret must be distinct and at
least 32 characters. Use the `voice-capacity` profile to enable the local
component-node waterline gate.

## SIP capacity and overload behavior

The rsipstack capacity patch replaces the unbounded incoming transaction
channel with a bounded queue and adds strict atomic limits for active
transactions, finished retransmission state, and reliable transport
connections. TCP, TLS, and WebSocket connections share the transport limit.
When a new server transaction cannot be admitted, rsipstack returns SIP 503
with `Retry-After: 1`; outbound transactions fail explicitly instead of being
accepted into unbounded memory. Duplicate transaction keys do not replace an
existing owner or consume/release a second capacity slot.

RustPBX validates and applies these profile-tunable values at startup:

| Environment variable | TOML field | Default |
| --- | --- | ---: |
| `RUSTPBX_SIP_MAX_ACTIVE_TRANSACTIONS` | `sip_max_active_transactions` | 65536 |
| `RUSTPBX_SIP_MAX_FINISHED_TRANSACTIONS` | `sip_max_finished_transactions` | 65536 |
| `RUSTPBX_SIP_INCOMING_TRANSACTION_QUEUE_CAPACITY` | `sip_incoming_transaction_queue_capacity` | 8192 |
| `RUSTPBX_SIP_MAX_TRANSPORT_CONNECTIONS` | `sip_max_transport_connections` | 32768 |

All values must be integers from 1 through 10,000,000. They are memory-safety
and overload-control limits, not measured capacity. Tune them only with the
same hardware, SIP profile, SLO, soak duration, and failure reserve used by the
capacity harness.

RustPBX exports current usage, configured limits, timer task count, queue depth,
finished-cache drops, and rejection counters under the `rustpbx_sip_*` metric
prefix. Compose, the OPC Helm chart, and the standalone iveKit Helm chart carry
the same defaults. Both charts expose `/metrics`; optional ServiceMonitor and
PrometheusRule resources alert before a hard limit and on any overload
rejection. Metrics contain no tenant, call, interaction, or phone-number labels.

The exact rsipstack and RustPBX patch queues apply cleanly to their pinned
commits and the rsipstack tree passes Rustfmt. The ivekit.10 source candidate
passes `cargo check --locked --features cross --bin rustpbx --bin sipflow` with
Rust 1.94.1 on macOS arm64. A Linux RustPBX image build, SIPp overload curve,
sustained timer/cache recovery, and Cell-10K result remain `not_run` until
executed on the target build and benchmark environment.

## Recording media hot path

The iveKit media patch removes recorder codec conversion, mixing, flushing and
disk writes from BridgePeer RTP forwarding loops. BridgePeer and
ForwardingTrack now publish recording copies with non-blocking `try_send` into
bounded queues backed by a fixed-size Crossbeam worker pool. A capture is
assigned to one worker shard so its samples remain serialized; no call owns a
blocking OS thread and no `spawn_blocking` backlog can grow without a limit.
Queue pressure can drop a recording copy, but it cannot block live RTP
forwarding or allocate an unbounded backlog.

`RUSTPBX_MEDIA_RECORDING_CHANNEL_CAPACITY` maps to
`media_recording_channel_capacity` and defaults to 256 entries. Valid values are
1 through 65,536. It is a per-capture burst buffer, not a throughput claim;
raising it increases memory and only delays overload when recorder workers or
storage remain slower than ingress.

`RUSTPBX_MEDIA_RECORDING_WORKER_THREADS` maps to
`media_recording_worker_threads`, defaults to 4, and accepts 1 through 64.
`RUSTPBX_MEDIA_RECORDING_WORKER_QUEUE_CAPACITY` maps to
`media_recording_worker_queue_capacity`, defaults to 4096 per worker, and
accepts 1 through 65,536. More workers increase codec parallelism and possible
storage concurrency; tune worker count before queue depth. The process rejects
incompatible reinitialization because this executor is process-global.

`rustpbx_media_recording_queue_capacity` exposes the configured size and
`rustpbx_media_recording_queue_drops_total` reports overflow without tenant,
call or interaction labels. Its bounded `reason` label distinguishes capture,
worker saturation, worker shutdown and the first writer failure. Worker count
and per-worker queue limit are exported by `rustpbx_media_recording_worker_threads` and
`rustpbx_media_recording_worker_queue_capacity`. Any drop triggers
`IveKitRustPbxRecordingQueueDrops`. Preserve the affected recording manifest
and pod metrics, drain new recording work, then investigate codec CPU, storage
latency and spool uploader backpressure. Native arm64 compilation and the
no-PSTN SIPp signaling suite passed on this host; RTP packet continuity, a real
object-store outage/resume drill and overflow recovery remain `not_run`.

The Rust unit gate `test_recording_stop_does_not_block_engine_on_busy_recorder`
holds the recorder write lock while StopRecording and PauseRecording are sent;
the pause event must still arrive within 250 ms. This proves command-loop lock
isolation, not physical RTP continuity or stalled-filesystem behavior.

## Session teardown isolation

The iveKit cleanup patch removes the last session-destruction waits from the
single MediaEngine command loop. Destroy and stale-session reap first remove the
session from active state, atomically pause recording, and submit the deduplicated
recording finalizer. Playback-track stop, MCU switch-back, and bridge release then
run in a bounded background task. `SessionDestroyed` acknowledges control-plane
removal; it no longer claims that recording persistence has completed.

`RUSTPBX_MEDIA_SESSION_CLEANUP_CONCURRENCY` maps to
`media_session_cleanup_concurrency`, defaults to 64, and accepts 1 through 4096.
`RUSTPBX_MEDIA_SESSION_CLEANUP_TIMEOUT_MS` maps to
`media_session_cleanup_timeout_ms`, defaults to 2000, and accepts 1 through
60,000. A full executor or elapsed deadline force-drops the remaining resources
instead of waiting in the media command loop. Outcomes are counted by
`rustpbx_media_session_cleanup_total{outcome="completed|timed_out|capacity_exhausted"}`;
timeout or exhaustion raises `IveKitRustPbxSessionCleanupDegraded`.

Object storage and the uploader are not dependencies of RustPBX. A local writer
or filesystem stall can consume recording workers and cause incomplete evidence,
but recording capture uses non-blocking bounded queues and session teardown has
its own deadline. The intended failure preference is explicit: preserve live RTP
and call control, then surface recording or cleanup loss for audit and recovery.
Exact patch replay, static contracts, and the Rust 1.94.1 macOS source check
pass; Linux image build, real blocked-filesystem injection, RTP continuity, and
process-level fault recovery remain `not_run`.

## WebPhone pre-authentication registry

The upstream WebSocket pre-authentication registry serializes all registrations,
lookups and removals through one `Mutex<Vec<_>>`. Once 256 entries exist, every
new registration also scans the full vector and removes entries older than five
minutes, including live long-running WebPhone connections. That makes lookup
O(n), creates one global lock hot spot and can revoke an active connection.

The iveKit WebPhone registry patch replaces that vector with an O(1) keyed
`RwLock<HashMap<SipAddr, _>>`. Registration returns a connection-lifetime guard;
normal completion, cancellation and panic drop the guard and remove only its
generation. A stale guard cannot delete a newer connection that reused the same
address. The embedded Rust tests cover replacement fencing, explicit removal,
guard cleanup and 10,000 simultaneous keyed entries. Patch application,
formatting, and the Rust 1.94.1 macOS source check pass on the exact upstream
commit; Linux image build and runtime WSS load remain `not_run` while the local
Docker runtime cannot start new containers.

## Reproducibility

- RustPBX: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- Rust builder: pinned by digest in `build.sh`
- Cargo dependency graph: `Cargo.lock`, built with `--locked`
- Runtime base: pinned by digest in `Dockerfile.runtime`

Run on a native amd64 or arm64 Docker host:

```bash
npm run ivekit:rustpbx-build
```

Override the output image with `IVEKIT_RUSTPBX_IMAGE`. Cross compilation is
rejected so an image cannot be mislabeled with binaries from another architecture.

## Acceptance

The delivery bundle exposes three separate engineering checks:

```bash
npm run ivekit:rustpbx-management-acceptance
npm run ivekit:rustpbx-rwi-acceptance
npm run ivekit:rustpbx-sipp-acceptance
```

The RWI check authenticates with the production client, runs `session.list_calls`,
originates with a deterministic call ID, finds that ID through AMI, and hangs up
the same call. Acceptance must also observe the downstream SIPp UAS receiving
BYE; the RWI command result alone is not sufficient evidence. This proves
signaling and reconciliation, not RTP media quality.

`npm run ivekit:rustpbx-sipp-acceptance` includes `answer-tcp` followed by
`answer-tcp-reconnect`. The downstream SIPp UAS is destroyed between the two
calls while RustPBX remains running. Both scenarios must pass with Router and CDR
evidence.
