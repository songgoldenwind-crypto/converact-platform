# iveKit RTPengine Goal 2 Implementation Plan

> **Architecture status (2026-07-29): Historical execution asset, not the
> production authority model.** The exact RTPengine source, fork, build,
> packet-path, and evidence work remains reusable. The standalone media-control
> sidecar/HTTP ownership described below is superseded by
> `rvoip-rustpbx-unified-authority-r2`: RustPBX's in-process Media Engine Facade
> owns each directed Media Edge while a generation-scoped Backend Binding Group
> owns the shared RTPengine allocation and Wire Transport Bundle.
> Existing Goal 2 evidence does not qualify that new control path or authorize
> production.
>
> **Related documents:** `rvoip-opc-communication-foundation-integration-design.md`,
> `communication-foundation-vos5000-parity-performance-plan.md`, and
> `../adr/ccaas-5-media-authority-and-rtpengine.md`.

> **For agentic workers:** Execute this plan task-by-task with test-driven development. Do not use `using-superpowers`. Keep every runtime claim tied to immutable source, image, configuration, host-kernel, and evidence identities.

**Goal:** Replace the Goal 1 simulator with an exact-source, fenced, durable, observable RTPengine media executor that can relay real RTP/RTCP and SRTP without coupling established media to the OPC control plane.

**Target Architecture:** Unified RustPBX remains authoritative for Call, Leg,
Dialog, routing policy, the logical media graph, each directed Media Edge and
its writer fence. A `BackendBindingGroup` generation owns one shared RTPengine
allocation; its `WireTransportBundle` owns effective wire SDP views, transport
tuples, flow bindings, ICE/DTLS/SRTP state references and physical release.
Each Edge generation maps by `(group_id, group_generation, flow_selector)` to
exactly one member flow, and packet dispatch resolves that mapping in O(1)
without scanning group members. The historical cell-local media-control agent,
HTTP API and WAL below remain compatibility/evidence assets, not the production
authority or call path. PostgreSQL, Redis, object storage, OCR, ASR and AI are
never on the RTP packet path.

**Pinned source:** Sipwise RTPengine `mr26.0.1.13`, commit `506cfa74386a5373e40fca139a932917f22f0524`, archive SHA-256 `a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143`.

**Tech Stack:** RTPengine C/GLib, nftables kernel module, TypeScript/Node.js, bencode NG protocol over persistent TCP, Docker/OCI, Helm, Prometheus, CycloneDX/SPDX, Trivy, Cosign, SIPp, and packet-level RTP/RTCP/SRTP probes.

---

## Non-Negotiable Invariants

1. The source archive, extracted commit, patch-set hash, builder identity, runtime image digest, host kernel, and loaded module identity must reconcile.
2. New allocations require a fresh component-node reservation and the current owner epoch. A stale epoch cannot offer, answer, update, mutate, or delete a newer session.
3. A stable media command maps to a stable RTPengine cookie. A timeout is `unknown`; it is never silently converted to success.
4. Established RTP forwarding survives media-control, Cell admission, PostgreSQL, Redis, recorder, and object-storage outages.
5. The command WAL is bounded, checksummed, atomically compacted, and stores no bearer token, tenant secret, phone number, remote credential, or unredacted authorization header.
6. Kernel fast path, userspace relay, SRTP, recording, forwarding, and transcoding use separate capacity profiles and claims.
7. Drain rejects new offers before resource exhaustion while existing calls continue until delete or media timeout.
8. Metrics have fixed labels only. Tenant, call, reservation, command, SDP, IP address, port, and phone number are forbidden labels.
9. A userspace fallback is visible as a different runtime mode and capacity profile. It cannot inherit a kernel-fast-path result.
10. No source, overlay, build, integration, or benchmark status changes from `not_run` until machine-readable evidence exists.
11. A logical Edge generation never directly owns a shared RTPengine allocation.
    It has one `WireMediaBinding`; the corresponding immutable
    `BackendBindingGroup` generation owns the allocation, membership digest and
    release lifecycle.
12. Group prepare is atomic `prepared_blocked`: ports and state may be allocated,
    but user-space and kernel output gates are closed from creation. Commit opens
    output only after the durable decision; revoke acknowledges only after both
    gates are closed and in-flight sends are drained.
13. A timeout during prepare, commit or revoke is `unknown`; the caller must
    `query_binding_group` and reconcile the exact durable decision. It may not
    retry through a different Backend or silently compile a different group.
14. Raw SRTP keys are never persisted in the group, Edge binding or evidence;
    only key references, negotiation state and digests may be durable.

## File Map

| Path | Responsibility |
| --- | --- |
| `infra/ivekit/rtpengine/source-lock.json` | Exact upstream archive, commit, patch-set, builder, and runtime identities |
| `infra/ivekit/rtpengine/fetch-source.sh` | Download and verify the exact archive without mutating the repository |
| `infra/ivekit/rtpengine/apply-overlay.mjs` | Assert source identity and apply the patch queue idempotently |
| `infra/ivekit/rtpengine/patches/*.patch` | Maintained RTPengine source changes only |
| `infra/ivekit/rtpengine/Dockerfile.toolchain` | Dependency-complete pinned build toolchain |
| `infra/ivekit/rtpengine/Dockerfile.runtime` | Minimal userspace daemon and recording-daemon runtime |
| `infra/ivekit/rtpengine/build.sh` | Offline source build, image labels, SBOM input, and artifact identity |
| `infra/ivekit/rtpengine/entrypoint.sh` | Deterministic config rendering and kernel/userspace mode assertion |
| `infra/ivekit/rtpengine/rtpengine.conf.template` | Cell-local TCP NG, media ports, limits, timeouts, and metrics configuration |
| `src/agent-runtime/ivekit/media-control/bencode.ts` | Historical bounded bencode implementation; reusable protocol evidence |
| `src/agent-runtime/ivekit/media-control/rtpengine-ng.ts` | Historical persistent TCP NG client; compatibility/diagnostic only |
| `src/agent-runtime/ivekit/media-control/journal.ts` | Historical command/session WAL; not the target authority store |
| `src/agent-runtime/ivekit/media-control/rtpengine.ts` | Historical `MediaTransportPort`; target is the in-process group-aware Facade Adapter |
| `scripts/ivekit-media-control-agent.ts` | Historical simulator/RTPengine runner; diagnostic only |
| `scripts/ivekit-rtpengine-acceptance.ts` | Identity, command, restart, RTP, RTCP, SRTP, drain, and outage evidence |
| `infra/ivekit/docker-compose.voice.yml` | Cell-local RTPengine, media-control volume, health, ports, and profiles |
| `infra/ivekit/helm/rtpengine/*` | Privileged kernel pool and unprivileged userspace pool deployment templates |
| `docs/capacity/contracts/voice-media-goal2-v1.json` | Normative Goal 2 acceptance contract |
| `docs/capacity/schemas/voice-media-goal2.schema.json` | Contract and evidence validation |

### Task 1: Freeze The Goal 2 Contract

**Files:**
- Create: `docs/capacity/contracts/voice-media-goal2-v1.json`
- Create: `docs/capacity/schemas/voice-media-goal2.schema.json`
- Create: `test/ivekit-voice-media-goal2-contract.test.ts`
- Modify: `package.json`

- [x] Write a failing schema test that requires exact source identity, required patch IDs, runtime modes, command mappings, failure behavior, evidence files, and honest `not_run` statuses.
- [x] Run `node --import tsx --test test/ivekit-voice-media-goal2-contract.test.ts` and verify it fails because the contract does not exist.
- [x] Define `voice-media-goal2-v1.json` with these required patch IDs:

```json
[
  "rtpengine-tcp-ng-bounded-frame-v1",
  "rtpengine-ivekit-owner-fence-v1",
  "rtpengine-ivekit-drain-capacity-v1",
  "rtpengine-ivekit-low-cardinality-metrics-v1"
]
```

- [x] Require the contract to classify `offer`, `answer`, `update`, `delete`, `query`, media block/unblock, forwarding, recording, playback, DTMF injection, quality subscription, and drain.
- [x] Require failure assertions for stale epoch, command replay, before/after-apply timeout, media-control restart, admission outage, database outage, recorder outage, RTPengine failure, kernel fallback, and load-generator invalidation.
- [x] Add `test:ivekit:voice-media-goal2` to `package.json`.
- [x] Run the contract test and verify it passes.
- [x] Commit as `test(media): freeze RTPengine Goal 2 contract`.

### Task 2: Exact Source Fetch And Idempotent Overlay

**Files:**
- Create: `infra/ivekit/rtpengine/source-lock.json`
- Create: `infra/ivekit/rtpengine/fetch-source.sh`
- Create: `infra/ivekit/rtpengine/apply-overlay.mjs`
- Create: `test/ivekit-rtpengine-source-overlay.test.ts`

- [x] Write a failing test that verifies the exact tag, commit, archive URL, SHA-256, size, GPL notice, patch order, and refusal of an unpinned source tree.
- [x] Make the test create a temporary Git tree from the exact archive, run the overlay twice, and require the second result to report `already_applied` for every patch.
- [x] Run the test and verify it fails because the source tooling is absent.
- [x] Implement `fetch-source.sh` so it:
  - accepts a new empty output directory;
  - downloads only the locked archive;
  - verifies `6987926` bytes and the locked SHA-256 before extraction;
  - verifies the tag resolves to the locked commit;
  - initializes a temporary Git repository solely to support deterministic patch application;
  - writes `ivekit-source-identity.json` with no credentials.
- [x] Implement `apply-overlay.mjs` using `git apply --check`, `git apply --whitespace=error-all`, and reverse-check idempotency.
- [x] Reject partial overlays, dirty source before first application, unknown patch files, and source identity mismatches.
- [x] Run the source test twice and verify identical patch-set hashes.
- [x] Commit as `build(rtpengine): pin source and overlay`.

Completion evidence on 2026-07-26:

- the exact archive produced four `applied` results on the first run and four `already_applied` results on the second run;
- patch-set SHA-256: `04dc12587f53007a8fdc9d603ec07f867820af69066788dbde2e31678185c6a6`;
- patched source tree SHA-256: `832600fecee772bbc7c126ebcb60de574f243db14830b29a86db55fc38181a5b`;
- the overlay test also covers overlapping patch context, executable-mode
  changes, and symlink identity targets so reverse checks cannot hide a
  partial, mixed, or redirected patch set.

### Task 3: Bounded TCP NG And Owner Fence Fork

**Files:**
- Create: `infra/ivekit/rtpengine/patches/0001-tcp-ng-bounded-frame.patch`
- Create: `infra/ivekit/rtpengine/patches/0002-ivekit-owner-fence.patch`
- Create: `infra/ivekit/rtpengine/patches/0003-ivekit-drain-capacity.patch`
- Create: `infra/ivekit/rtpengine/patches/0004-ivekit-metrics.patch`
- Create: `infra/ivekit/rtpengine/overlay-tests/ivekit_owner_guard_test.c`
- Create: `infra/ivekit/rtpengine/overlay-tests/ivekit_replay_protocol_test.py`
- Modify: `test/ivekit-rtpengine-source-overlay.test.ts`

- [x] First add assertions that fail against unpatched upstream source.
- [x] Patch TCP NG to accept a complete bencoded frame up to a configured `ivekit-ng-max-frame-bytes`, default `262144`, while closing connections that exceed the bound before a complete frame.
- [x] Add required NG keys for iveKit mutations:

```text
ivekit-owner-epoch
ivekit-command-sequence
ivekit-command-id
ivekit-command-hash
ivekit-reservation-id
```

- [x] Store a bounded call guard keyed by call ID. Compare owner epochs as unsigned 64-bit integers, require sequence one for a higher epoch, reject lower epochs before dispatch, and retain terminal tombstones for the configured retention period.
- [x] Keep query and statistics read-only. They may inspect a fenced call but cannot advance its epoch or sequence.
- [x] Add `ivekit drain` and `ivekit undrain` control commands. Drain rejects new call IDs with `ivekit node draining` while allowing existing-call mutations and delete.
- [x] Add a hard active-call admission ceiling and counters for accepted, replayed, stale-epoch, sequence-gap, draining, and capacity rejections.
- [x] Export only fixed-label metrics by command/result/runtime mode; never export call or endpoint identifiers as labels.
- [x] Run overlay tests, upstream unit tests for affected files, and ASAN/UBSAN unit binaries.
- [x] Commit as `feat(rtpengine): add fenced media admission`.

Verification evidence on 2026-07-26:

- `npm run test:ivekit:voice-media-goal2`: 17 tests passed;
- the locked source compiled with the production `-O3` and LTO flags in the server build environment;
- upstream `test-stats` and `test-transcode` both compiled, linked, and passed with `ivekit_guard.o`;
- the owner guard boundary binary passed ASAN and UBSAN with leak detection enabled;
- real NG admission, drain, hard-capacity, tombstone expiry, invalid runtime-mode, and `/metrics` protocol checks passed on `64.225.122.227`;
- stable-cookie replay returned the native cached response, while the same
  command under a different cookie was rejected before media dispatch;
  counters remained exactly `accepted=1` and `replayed=1`;
- all exported labels are fixed command, result, and runtime-mode values; call IDs, tenant IDs, reservation IDs, SDP, addresses, ports, and phone numbers are excluded.

### Task 4: Offline Userspace And Kernel Artifacts

**Files:**
- Create: `infra/ivekit/rtpengine/Dockerfile.toolchain`
- Create: `infra/ivekit/rtpengine/Dockerfile.runtime`
- Create: `infra/ivekit/rtpengine/build.sh`
- Create: `infra/ivekit/rtpengine/entrypoint.sh`
- Create: `infra/ivekit/rtpengine/rtpengine.conf.template`
- Create: `infra/ivekit/rtpengine/README.md`
- Create: `test/ivekit-rtpengine-build-contract.test.ts`

- [x] Write a failing static build-contract test for pinned `FROM` digests, non-root userspace runtime, read-only root filesystem compatibility, exact labels, architecture handling, offline final build, and separate kernel/userspace artifacts.
- [x] Build the dependency-complete toolchain from the locked Debian snapshot and record its immutable digest.
- [x] Make `build.sh` fetch and patch before build, then run the source compile with `docker build --network=none`.
- [ ] Build `rtpengine`, `rtpengine-recording`, and the nftables kernel module as separate artifacts. Userspace and recording passed; the kernel targets are implemented but the real module remains `not_run` until matching headers are supplied.
- [x] Label artifacts with upstream commit, archive SHA-256, patch-set SHA-256, target architecture, and `io.ivekit.runtime-mode`.
- [x] Support native `amd64` and native `arm64` userspace builds. Refuse silent cross-compilation and record unexecuted architecture builds as `not_run`.
- [x] Make entrypoint refuse `kernel` mode unless the loaded module identity matches the image metadata. Make `auto` mode emit an explicit userspace-fallback metric and runtime identity.
- [x] Verify the userspace runtime runs without package-manager or compiler tools.
- [x] Commit as `build(rtpengine): add reproducible runtime artifacts`.

Verification evidence on `64.225.122.227` on 2026-07-26:

- Debian snapshot: `20260725T000000Z`;
- amd64 toolchain image:
  `sha256:1b858f21573a2a5322825ee566a204ed34d093b447392d910d4b99e5771c9752`;
- upstream commit:
  `506cfa74386a5373e40fca139a932917f22f0524`;
- source archive SHA-256:
  `a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143`;
- patch-set SHA-256:
  `74af037355d83672ac8a9c136c7ca6f4800a5a8b735f17e4b515a85430360352`;
- patched-tree SHA-256:
  `1e893d6bfb1d915f7953d34672c7005b89e0b9e26689631093877f860482e63c`;
- amd64 userspace image:
  `sha256:8af0304eeff75d2996d9ef52fc8c59a00f0c2d5f239f4e0ebbf23b6c5cdca091`;
- amd64 recording image:
  `sha256:ce4f0fa22a3fe1e38f5fe0f4471620fc27e54f2b316cc8cc2c3842ea698ba14d`;
- source preparation from the locked local archive and final artifact builds
  completed with network disabled; both images run as UID/GID `10001:10001`
  and contain no `apt`, `dpkg`, compiler, or `make`;
- relay, recording, and kernel artifact stages use independent compile chains;
  both verified runtime images carry the exact toolchain image ID label;
- the userspace daemon started with a read-only root filesystem, generated
  runtime state only in tmpfs mounts, and exported an explicit auto-fallback
  metric;
- the production entrypoint enables owner fencing by default; real UDP NG
  replay returned the native cached response for a stable cookie and rejected
  the same command under a different cookie before dispatch;
- upstream `test-stats` and `test-transcode` passed; the owner-guard boundary
  binary passed ASAN and UBSAN with leak detection enabled;
- forced kernel mode with mismatched module identity was refused with exit
  code `78`; a forged legacy environment identity could not bypass the
  image-embedded identity requirement;
- native arm64 execution and a real kernel-module build remain `not_run`
  because this host is amd64 and matching host kernel headers were not
  supplied. The build targets and refusal contracts are present; these results
  must not be represented as hardware verification.

### Task 5: Deterministic Bencode And Persistent TCP NG Client

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/bencode.ts`
- Create: `src/agent-runtime/ivekit/media-control/rtpengine-ng.ts`
- Create: `test/ivekit-rtpengine-ng.test.ts`
- Create: `scripts/ivekit-rtpengine-ng-acceptance.ts`

- [x] Write failing tests for deterministic dictionary ordering, arbitrary byte strings, nested lists, integer bounds, duplicate keys, malformed lengths, depth/node/byte limits, and fragmented TCP frames.
- [x] Write a real TCP test server that returns responses out of order and sends a frame in one-byte fragments.
- [x] Use a stable cookie derived from `command_id` and `command_hash`; never generate a new cookie on retry.
- [x] Implement one bounded connection pool per RTPengine endpoint with:
  - maximum in-flight requests;
  - maximum outstanding request bytes and TCP backpressure;
  - absolute request deadlines;
  - cookie-to-request matching;
  - bounded response bytes;
  - reconnect with jittered backoff;
  - `unknown` for disconnect after write;
  - deterministic failure for rejection before write.
- [x] Parse unsolicited DTMF notifications separately so they cannot satisfy a command promise.
- [x] Run the focused test and the Goal 1 protocol/agent tests.
- [x] Commit as `feat(media): add RTPengine NG client`.

Verification evidence on 2026-07-26:

- 16 focused tests passed against real loopback TCP sockets, including
  out-of-order responses, one-byte fragments, embedded newlines, stable-cookie
  reconnect, pool expansion, coalesced self-delimiting frames, absolute
  deadlines, overload, bounded outstanding bytes, close-during-connect,
  single-attempt backoff, cross-connection cookie isolation, oversized
  responses, and real-format unsolicited DTMF;
- bencode rejects non-canonical integers, duplicate dictionary keys, malformed
  lengths, trailing bytes, invalid Unicode dictionary keys, and configured
  depth/node/byte/string limits;
- an independent review found and the implementation fixed newline framing,
  incorrect DTMF shape, multi-connection DTMF duplication, unbounded socket
  queues, close-during-connect retention, duplicate backoff advancement,
  invalid UTF-8 key collisions, and cross-slot response matching;
- the independent re-review reported no blocking findings and confirmed all
  eight issues were resolved;
- against the locked amd64 userspace image on `64.225.122.227`, the compiled
  client sent 128 concurrent `ping` commands over real TCP-NG without newline
  framing and received 128 `pong` responses in `75.882 ms`; the isolated
  temporary RTPengine container was removed after the run;
- the full TypeScript typecheck passed;
- all 66 Goal 1 media-control protocol, authority, HTTP, deployment, capacity,
  recovery, and adapter tests passed, including the 100,000-reservation model.

### Task 6: Checksummed Local Command WAL

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/journal.ts`
- Create: `test/ivekit-media-control-journal.test.ts`

- [x] Write failing tests for append/replay, process reopen, truncated tail, checksum mismatch, symlink refusal, file permissions, terminal retention, byte bound, and atomic compaction.
- [x] Store only command identity, command hash, owner epoch, sequence, transport call ID, result class, effective SDP, session state, and timestamps.
- [x] Prefix every record with length and SHA-256. Ignore only an incomplete final record; reject corruption in any committed record.
- [x] Open files with no-follow semantics where supported, require mode `0600`, fsync successful command outcomes before returning them, and fsync the parent directory after atomic rename.
- [x] Compact only terminal records outside retention. Never discard an unknown or active session.
- [x] Enforce both record-count and byte bounds; fail readiness before unbounded growth.
- [x] Commit as `feat(media): persist transport command journal`.

Task 6 evidence:

- the WAL uses a length/complement header plus SHA-256, streams recovery
  without allocating the file size, rolls back partial writes and failed
  durability syncs, and rejects committed corruption;
- the persistent writer lock is an inode `flock` on a protected `0600`
  lock file in the WAL directory, so process pauses do not permit takeover
  and process death releases the lock in the kernel;
- the writer lock was verified across two Linux containers with separate
  network namespaces and different in-container mount paths to the same
  host directory; the second writer was rejected and could reacquire after
  the first container was removed;
- deployments must mount the complete WAL directory and use a filesystem
  with coherent `flock` semantics;
- local Task 6 tests passed `21/21`, the full Goal 2 suite passed `61/61`,
  the TypeScript typecheck passed, and the Linux isolated-container Task 6
  suite passed `21/21`;
- an independent final review reported no blocking or high-severity
  correctness, security, or durability findings.

### Task 7: RTPengine `MediaTransportPort`

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/rtpengine.ts`
- Modify: `src/agent-runtime/ivekit/media-control/index.ts`
- Create: `test/ivekit-rtpengine-media-transport.test.ts`

- [x] Write failing tests using a real TCP NG fixture for offer, answer, update, delete, query, block/unblock, start/stop forwarding, start/stop recording, play/stop media, DTMF, quality query, and drain.
- [x] Require offer payload fields `offer_sdp`, `from_tag`, and `media_profile_id`; require answer/update tags according to the SIP dialog state.
- [x] Map iveKit actions exactly:

```text
offer               -> offer
answer              -> answer
update              -> offer or answer from payload negotiation_role
delete              -> delete
query               -> query
block_media         -> block media
unblock_media       -> unblock media
start_forward       -> start forwarding
stop_forward        -> stop forwarding
start_recording_fork-> start recording
stop_recording_fork -> stop recording
play_media          -> play media
stop_media          -> stop media
inject_dtmf         -> play DTMF
subscribe_quality   -> query
drain_node          -> ivekit drain
```

- [x] Send all owner/fencing keys on every mutating request and keep logical SDP separate from returned effective SDP.
- [x] On startup, load active WAL sessions, query RTPengine by call ID, and mark missing calls closed. Do not claim active recovery without both WAL and RTPengine facts.
- [x] On unknown outcome, query WAL first, then RTPengine. Replay only with the same cookie after RTPengine proves the command was not observed.
- [x] Keep delete idempotent and retain the owner tombstone.
- [x] Commit as `feat(media): execute commands through RTPengine`.

Task 7 evidence:

- the transport maps every Goal 1 action through the RTPengine TCP NG client,
  validates dialog tags and SDP before I/O, and persists action, exact failure
  semantics, effective SDP, and dialog tags in the checksummed WAL;
- the iveKit RTPengine fork exposes an exact `ivekit command status` query with
  `applied`, `unseen`, and `conflict` results. Unknown non-idempotent commands
  such as DTMF are not replayed unless the guard proves the exact command was
  not observed;
- successful negotiation replay state is released through an acknowledged,
  bounded, exponentially retried replay-ACK queue. Fast retry exhaustion
  escalates to bounded low-frequency retry instead of abandoning cleanup.
  Startup reconciles the newest unknown negotiation before proving and
  acknowledging the newest successful negotiation for each reservation.
  Pending, failed, succeeded, escalated, and abandoned ACK counts are
  available to the runtime metrics adapter;
- effective SDP is limited to 256 KiB and rejects NUL or invalid UTF-8 in both
  the TypeScript transport and the C fork. An applied negotiation with an
  unsafe effective SDP is fenced, deleted with a stable compensating command,
  and persisted as a deterministic terminal failure. A lost cleanup response
  converges through the compensating command's exact status without repeating
  its side effect. Session lookup, command cleanup, and transport-session
  release use bounded maps and direct indexes;
- runtime WAL compaction retains a dirty marker across failures, retries with
  bounded exponential backoff, and retries again before the next append so a
  transient compaction failure cannot permanently consume WAL capacity;
- local Goal 1 regression tests passed `68/68`, the Goal 2 suite passed
  `83/83`, TypeScript typecheck passed, and `git diff --check` passed;
- the full repository suite completed `4,074` tests with `4,059` passed,
  `13` skipped, and the same two pre-existing baseline failures: the curated
  delivery bundle expects `84` files but currently contains `85`, and the
  Renovate upstream watch does not yet declare RTPengine `mr26.0.1.13`;
- independent final review reported no Critical or Important findings after
  validating cross-epoch recovery ordering, restart cleanup convergence, and
  append-before-compaction retry behavior;
- the pinned source built natively on the isolated Linux server as image
  `sha256:13c3eb5e17b63dea05a33b2628de9a43e8b18cc495ce2fc148db6c9c852c017a`
  with patch-set SHA-256
  `51f842076f044d5d914ef8f89ad0a72a9ab1e6a2d26ee5899a5e457d09efd0f3`;
- the real daemon protocol probe returned
  `command_status=applied_unseen_conflict`,
  `stable_cookie_result=cached`, `cross_cookie_result=fenced_replay_with_sdp`,
  and `replay_sdp_ack=released`. The temporary RTPengine container was removed
  after the run, and all seven LED containers remained healthy.

### Task 8: Runtime Selection And Deployment

**Files:**
- Modify: `scripts/ivekit-media-control-agent.ts`
- Modify: `infra/ivekit/media-control/Dockerfile`
- Modify: `infra/ivekit/docker-compose.voice.yml`
- Modify: `infra/ivekit/env.example`
- Create: `infra/ivekit/helm/rtpengine/Chart.yaml`
- Create: `infra/ivekit/helm/rtpengine/values.yaml`
- Create: `infra/ivekit/helm/rtpengine/templates/daemonset.yaml`
- Create: `infra/ivekit/helm/rtpengine/templates/service.yaml`
- Create: `infra/ivekit/helm/rtpengine/templates/servicemonitor.yaml`
- Create: `infra/ivekit/helm/rtpengine/templates/pdb.yaml`
- Create: `infra/ivekit/helm/rtpengine/values-userspace.yaml`
- Create: `infra/ivekit/helm/rtpengine/values-kernel.yaml`
- Create: `infra/ivekit/helm/rtpengine/README.md`
- Create: `scripts/ivekit-rtpengine-deployment-preflight.ts`
- Create: `scripts/ivekit-rtpengine-drain.ts`
- Create: `test/ivekit-rtpengine-deployment.test.ts`

- [x] Write a failing deployment test that rejects production simulator mode, mutable image tags, public NG control ports, missing WAL volume, missing UDP media range, unbounded resources, and kernel mode without the required host mounts/capabilities.
- [x] Add `IVEKIT_MEDIA_CONTROL_TRANSPORT=rtpengine` and require endpoint, WAL directory, runtime mode, request pool, and byte bounds.
- [x] Keep the NG control service private. Publish only the declared RTP/RTCP UDP range on media nodes.
- [x] Mount the WAL on a dedicated bounded volume. Keep the media-control root filesystem read-only.
- [x] Separate Helm values for privileged kernel nodes and unprivileged userspace nodes with explicit node selectors, taints, PDB, drain hook, and ServiceMonitor.
- [x] Preserve the RTPengine process and durable WAL when media-control is recreated. Task 9 validates continuity with active RTP packets.
- [x] Commit as `feat(deploy): add RTPengine media nodes`.

Task 8 completed in commits `0ad9ee9` and `754ae01`. Local Goal 2 tests pass
`90/90`, Goal 1 tests pass `68/68`, TypeScript typecheck passes, and both Helm
profiles passed real server-side lint. The isolated server run found and fixed
the missing TCP NG listener and unreferenced active-request timers, then proved
that media-control restart preserves the WAL inode and the unchanged
RTPengine process. See
`docs/evidence/goal2-rtpengine-deployment-server-validation-2026-07-26.md`.

### Task 9: Real RTP, RTCP, SRTP, And Restart Acceptance

**Files:**
- Create: `scripts/ivekit-rtpengine-acceptance.ts`
- Create: `scripts/capacity/generators/rtpengine-media.ts`
- Create: `test/ivekit-rtpengine-acceptance.test.ts`
- Modify: `package.json`

- [x] Write a failing acceptance test that requires immutable deployment identity and bounded evidence.
- [x] Generate two endpoint SDPs, execute offer/answer through media-control, and send timestamped G.711 RTP plus RTCP in both directions without requiring a sound card.
- [x] Verify packet count, sequence continuity, SSRC, payload integrity, relay address, first-packet time, packet loss, jitter, and RTCP receipt.
- [x] Repeat with SDES SRTP and verify that plaintext is not observable on the relay-facing capture.
- [x] Stop media-control and Cell admission during an established stream; require RTP to continue.
- [x] Recreate media-control with the same WAL; require query and idempotent delete to succeed without a second allocation.
- [x] Exercise drain, hard capacity, stale epoch, higher-epoch takeover, before-write failure, after-write disconnect, and RTPengine process failure.
- [x] Mark kernel, recording, and transcoding checks independently; never infer them from plain userspace RTP.
- [x] Commit as `test(media): add real RTPengine acceptance`.

Task 9 completed in commit `3f2391d`. Local Goal 2 tests pass `109/109`,
Goal 1 tests pass `68/68`, TypeScript typecheck passes, and the exact committed
artifact passed all `20/20` real-server checks. The final userspace run carried
500 PCMU RTP packets plus RTCP in each direction and 100 SDES-SRTP packets in
each direction with zero loss, duplicates, ordering errors, invalid packets,
or protected-wire plaintext matches. Established RTP continued while isolated
media-control and admission were stopped, and the same WAL inode recovered the
session for query and idempotent delete. Kernel forwarding, recording,
transcoding, and capacity remain explicit `not_run` items. See
`docs/evidence/goal2-rtpengine-real-media-acceptance-2026-07-26.md`.

### Task 10: Supply-Chain Evidence

**Files:**
- Create: `scripts/ivekit-rtpengine-supply-chain.ts`
- Create: `test/ivekit-rtpengine-supply-chain.test.ts`
- Modify: `infra/ivekit/rtpengine/build.sh`

- [x] Write a failing test for CycloneDX and SPDX SBOMs, Trivy JSON, OCI digest, provenance, signature reference, source identity, patch-set identity, and secret scanning.
- [x] Generate SBOMs from the exact runtime image and retain vulnerability severity plus database timestamp.
- [x] Produce an in-toto/SLSA-style provenance statement binding source archive, patch set, builder digest, build arguments, architecture, and output digest.
- [x] Sign by digest when `IVEKIT_COSIGN_KEY` or keyless CI identity is available. Otherwise emit `signature.status=not_run`; never create a false pass.
- [x] Reject release on critical vulnerabilities without a recorded exception and expiry.
- [x] Commit as `build(rtpengine): attest media artifacts`.

Task 10 completed on the isolated server. The final package-aware image exposed
284 Debian packages to Trivy while retaining no package-manager executable.
CycloneDX 1.7 contains 285 components and SPDX 2.3 contains 286 packages. The
fixed Trivy 0.72.0 image reported 24 vulnerabilities, including one Critical
`libxml2` finding covered by an explicit exception expiring 2026-08-09, and
zero secrets. Signing remains accurately recorded as `not_run`. The modified
runtime image also passed the real-media regression suite 20/20. This task
makes no capacity claim. See
`docs/evidence/goal2-rtpengine-supply-chain-server-validation-2026-07-26.md`.

### Task 11: Goal 2 Finalizer And Documentation

**Files:**
- Create: `scripts/ivekit-voice-media-goal2-finalize.ts`
- Modify: `docs/capacity/forks/ivekit-forks-v1.json`
- Modify: `docs/capacity/README.md`
- Modify: `infra/ivekit/media-control/README.md`
- Modify: `docs/design/communication-foundation-vos5000-parity-performance-plan.md`
- Create: `test/ivekit-voice-media-goal2-finalizer.test.ts`

- [x] Write failing finalizer tests for missing identity, missing repetition, reconciliation delta, generator overload, clock invalidity, incomplete failure evidence, and mixed kernel/userspace results.
- [x] Require every acceptance attempt to be retained, including invalid attempts.
- [x] Promote `patch_apply`, `compile`, `unit`, `integration`, and `real_environment` only from evidence generated by the exact artifact.
- [x] Keep `benchmark=not_run` and `capacity_claim=none` until the later physical capacity campaign completes at least three valid repetitions.
- [x] Document exact deployment, rollback, drain, WAL recovery, userspace fallback, kernel module compatibility, and evidence collection commands.
- [x] Run:

```bash
npm run typecheck
npm run test:ivekit:voice-media-goal1
npm run test:ivekit:voice-media-goal2
git diff --check
```

- [x] Commit as `docs(media): complete RTPengine Goal 2 evidence`.

Task 11 finalizer completed on the isolated server. It retained the original
Task 9 image as `retained_identity_mismatch` and accepted only the package-aware
runtime image as `accepted_functional`. Source identity, patch apply, compile,
unit, integration, and userspace real-environment verification are `passed`.
Benchmark remains `not_run`, capacity claim remains `none`, and production
eligibility remains false because kernel, recording, transcoding, signing, one
time-limited Critical exception, and seven failure-matrix rows are still open.
See `docs/evidence/goal2-rtpengine-final-evidence-2026-07-26.json`.

### Task 12: Migrate The Reusable Fork Into The Revision 3 Authority Model

**Status:** Target delta only; all items are `not_run`. The checked Tasks 1–11
remain historical evidence and do not satisfy this task.

- [ ] Extend the Goal 2 contract/schema/tests with
      `BackendBindingGroup`, `WireTransportBundle` and `WireMediaBinding`,
      including `group_generation`, immutable ordered members, membership
      digest, exact `flow_selector`, writer fence and zero-reference release.
- [ ] Add a new exact-source patch
      `rtpengine-ivekit-atomic-binding-lifecycle-v1`. Its present status is
      `not_present/not_run`; the current five-patch source-lock (including
      `rtpengine-ivekit-durable-replay-v1`) must not be described as containing
      this sixth patch.
- [ ] Key the RTPengine physical guard by
      `(binding_group_id, group_generation)` and validate the immutable
      member/fence digest before any mutation. Maintain an O(1) flow selector
      index; member scans are forbidden on the packet path.
- [ ] Implement atomic `prepare_binding_group` with output blocked from
      allocation, `commit_binding_group`, pre-decision
      `abort_binding_group`, `revoke_binding_group` with zero-output ACK, and
      read-only `query_binding_group` for exact reconciliation.
- [ ] Compile the complete candidate Media Plan, group membership and flow
      bindings before any Backend-specific reserve. A reserve retry creates a
      new candidate attempt/revision; it cannot switch Backend or rewrite
      membership after prepare.
- [ ] Before the immutable decision, compensate by reverse-aborting every
      prepared group and cancelling admission reservations. After a partial
      commit, preserve the decision and query/reconcile it; a terminally
      impossible decision follows the predeclared compensation plan and ends
      `compensated_failed`, never `aborted`.
- [ ] For initial setup, persist the immutable final plan, Edge mappings,
      transport bundles and decision, commit every required group, then expose
      effective SDP. For migration, expose candidate SDP while the old
      generation remains the sole writer; after remote acceptance persist the
      handoff decision, revoke old to zero-output, commit new, and retain old
      receive-only state only for a bounded authenticate/count/drop grace.
- [ ] Make new-call Backend selection and old-call drain the default rollout.
      Do not migrate active calls merely to change selector policy.
- [ ] Preserve ordinary RTPengine behavior as `continue_degraded` when Unified
      RustPBX control ownership is lost; this statement does not apply to
      embedded processing Edges.
- [ ] Produce exact patch, lifecycle, race, real RTP/SRTP and failure evidence.
      Until then production eligibility, benchmark and capacity claims remain
      `not_run/none`.

## Server Execution Order

1. Build the exact userspace artifact on `64.225.122.227` without touching LED containers.
2. Deploy RTPengine and the new media-control sidecar in the existing OPC project only.
3. Run NG protocol and real RTP/RTCP userspace acceptance.
4. Run media-control and admission outage tests.
5. Run WAL-backed media-control restart recovery.
6. Run SDES SRTP and userspace recording/forwarding checks.
7. Run kernel preflight and build the exact module for the active server kernel.
8. Load kernel mode only after module identity, nftables compatibility, rollback command, and current media-node drain are recorded.
9. Re-run the same media suite in kernel mode and preserve userspace/kernel results separately.
10. Generate SBOM, vulnerability, provenance, image, kernel, configuration, and acceptance evidence.

## Historical Goal 2 Compatibility Gate

Goal 2 is complete only when:

- the exact fork applies idempotently and compiles from the locked source;
- the userspace image and target-host kernel artifact have immutable identities;
- all 16 media-control actions have deterministic mappings or explicit unsupported rejections backed by the accepted source;
- stale owner epochs and sequence gaps are rejected before RTPengine mutation;
- real RTP/RTCP and SRTP traverse the relay;
- media continues through control-plane outages;
- media-control restart recovers from the local WAL without duplicate allocation;
- drain and capacity rejection preserve existing calls;
- Compose and Helm encode the same security and runtime boundaries;
- supply-chain and acceptance evidence is complete;
- no unexecuted benchmark is represented as a capacity pass.

These conditions close the historical compatibility asset only. Production use
under `CARRIER-CELL-V1` additionally requires every Task 12 item, the Revision 3
contract gates, real co-resident Unified RustPBX integration evidence and the
later capacity campaign. No checked item above authorizes production or capacity
by inheritance.

## Change log

| Revision | Date | Author | Change |
| --- | --- | --- | --- |
| 2 | 2026-07-29 | Codex | Preserved exact-source and packet-path evidence work while classifying the standalone control sidecar as a superseded, non-production compatibility path. |
| 3 | 2026-07-29 | Codex | Added the target Backend Binding Group/Wire Transport Bundle lifecycle, O(1) Edge-flow mapping, atomic blocked prepare/commit/revoke/query semantics, decision-aware compensation, initial/migration SDP ordering and honest Task 12 delta. |
