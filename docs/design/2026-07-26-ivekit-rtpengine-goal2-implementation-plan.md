# iveKit RTPengine Goal 2 Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-driven development. Do not use `using-superpowers`. Keep every runtime claim tied to immutable source, image, configuration, host-kernel, and evidence identities.

**Goal:** Replace the Goal 1 simulator with an exact-source, fenced, durable, observable RTPengine media executor that can relay real RTP/RTCP and SRTP without coupling established media to the OPC control plane.

**Architecture:** RustPBX remains authoritative for Call, Leg, Dialog, routing policy, and the logical media graph. The cell-local media-control agent remains the only iveKit caller of RTPengine and enforces reservation, owner epoch, sequence, idempotency, and uncertainty reconciliation. The maintained RTPengine fork owns effective wire SDP, ports, ICE/DTLS/SRTP state, packet forwarding, drain state, and low-cardinality transport counters. A bounded local WAL preserves command outcomes and effective SDP across media-control restarts; PostgreSQL, Redis, object storage, OCR, ASR, and AI are not on the RTP packet path.

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
| `src/agent-runtime/ivekit/media-control/bencode.ts` | Bounded deterministic bencode encoder and streaming decoder |
| `src/agent-runtime/ivekit/media-control/rtpengine-ng.ts` | Persistent TCP NG connection pool and stable-cookie request matching |
| `src/agent-runtime/ivekit/media-control/journal.ts` | Checksummed bounded local command/session WAL |
| `src/agent-runtime/ivekit/media-control/rtpengine.ts` | `MediaTransportPort` implementation and action mapping |
| `scripts/ivekit-media-control-agent.ts` | Explicit `simulator` or `rtpengine` runtime selection |
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

- [ ] Write a failing test that verifies the exact tag, commit, archive URL, SHA-256, size, GPL notice, patch order, and refusal of an unpinned source tree.
- [ ] Make the test create a temporary Git tree from the exact archive, run the overlay twice, and require the second result to report `already_applied` for every patch.
- [ ] Run the test and verify it fails because the source tooling is absent.
- [ ] Implement `fetch-source.sh` so it:
  - accepts a new empty output directory;
  - downloads only the locked archive;
  - verifies `6987926` bytes and the locked SHA-256 before extraction;
  - verifies the tag resolves to the locked commit;
  - initializes a temporary Git repository solely to support deterministic patch application;
  - writes `ivekit-source-identity.json` with no credentials.
- [ ] Implement `apply-overlay.mjs` using `git apply --check`, `git apply --whitespace=error-all`, and reverse-check idempotency.
- [ ] Reject partial overlays, dirty source before first application, unknown patch files, and source identity mismatches.
- [ ] Run the source test twice and verify identical patch-set hashes.
- [ ] Commit as `build(rtpengine): pin source and overlay`.

### Task 3: Bounded TCP NG And Owner Fence Fork

**Files:**
- Create: `infra/ivekit/rtpengine/patches/0001-tcp-ng-bounded-frame.patch`
- Create: `infra/ivekit/rtpengine/patches/0002-ivekit-owner-fence.patch`
- Create: `infra/ivekit/rtpengine/patches/0003-ivekit-drain-capacity.patch`
- Create: `infra/ivekit/rtpengine/patches/0004-ivekit-metrics.patch`
- Create: `infra/ivekit/rtpengine/overlay-tests/ivekit_owner_guard_test.c`
- Modify: `test/ivekit-rtpengine-source-overlay.test.ts`

- [ ] First add assertions that fail against unpatched upstream source.
- [ ] Patch TCP NG to accept a complete bencoded frame up to a configured `ivekit-ng-max-frame-bytes`, default `262144`, while closing connections that exceed the bound before a complete frame.
- [ ] Add required NG keys for iveKit mutations:

```text
ivekit-owner-epoch
ivekit-command-sequence
ivekit-command-id
ivekit-command-hash
ivekit-reservation-id
```

- [ ] Store a bounded call guard keyed by call ID. Compare owner epochs as unsigned 64-bit integers, require sequence one for a higher epoch, reject lower epochs before dispatch, and retain terminal tombstones for the configured retention period.
- [ ] Keep query and statistics read-only. They may inspect a fenced call but cannot advance its epoch or sequence.
- [ ] Add `ivekit drain` and `ivekit undrain` control commands. Drain rejects new call IDs with `ivekit node draining` while allowing existing-call mutations and delete.
- [ ] Add a hard active-call admission ceiling and counters for accepted, replayed, stale-epoch, sequence-gap, draining, and capacity rejections.
- [ ] Export only fixed-label metrics by command/result/runtime mode; never export call or endpoint identifiers as labels.
- [ ] Run overlay tests, upstream unit tests for affected files, and ASAN/UBSAN unit binaries.
- [ ] Commit as `feat(rtpengine): add fenced media admission`.

### Task 4: Offline Userspace And Kernel Artifacts

**Files:**
- Create: `infra/ivekit/rtpengine/Dockerfile.toolchain`
- Create: `infra/ivekit/rtpengine/Dockerfile.runtime`
- Create: `infra/ivekit/rtpengine/build.sh`
- Create: `infra/ivekit/rtpengine/entrypoint.sh`
- Create: `infra/ivekit/rtpengine/rtpengine.conf.template`
- Create: `infra/ivekit/rtpengine/README.md`
- Create: `test/ivekit-rtpengine-build-contract.test.ts`

- [ ] Write a failing static build-contract test for pinned `FROM` digests, non-root userspace runtime, read-only root filesystem compatibility, exact labels, architecture handling, offline final build, and separate kernel/userspace artifacts.
- [ ] Build the dependency-complete toolchain from the locked Debian snapshot and record its immutable digest.
- [ ] Make `build.sh` fetch and patch before build, then run the source compile with `docker build --network=none`.
- [ ] Build `rtpengine`, `rtpengine-recording`, and the nftables kernel module as separate artifacts.
- [ ] Label artifacts with upstream commit, archive SHA-256, patch-set SHA-256, target architecture, and `io.ivekit.runtime-mode`.
- [ ] Support native `amd64` and native `arm64` userspace builds. Refuse silent cross-compilation and record unexecuted architecture builds as `not_run`.
- [ ] Make entrypoint refuse `kernel` mode unless the loaded module identity matches the image metadata. Make `auto` mode emit an explicit userspace-fallback metric and runtime identity.
- [ ] Verify the userspace runtime runs without package-manager or compiler tools.
- [ ] Commit as `build(rtpengine): add reproducible runtime artifacts`.

### Task 5: Deterministic Bencode And Persistent TCP NG Client

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/bencode.ts`
- Create: `src/agent-runtime/ivekit/media-control/rtpengine-ng.ts`
- Create: `test/ivekit-rtpengine-ng.test.ts`

- [ ] Write failing tests for deterministic dictionary ordering, arbitrary byte strings, nested lists, integer bounds, duplicate keys, malformed lengths, depth/node/byte limits, and fragmented TCP frames.
- [ ] Write a real TCP test server that returns responses out of order and sends a frame in one-byte fragments.
- [ ] Use a stable cookie derived from `command_id` and `command_hash`; never generate a new cookie on retry.
- [ ] Implement one bounded connection pool per RTPengine endpoint with:
  - maximum in-flight requests;
  - absolute request deadlines;
  - cookie-to-request matching;
  - bounded response bytes;
  - reconnect with jittered backoff;
  - `unknown` for disconnect after write;
  - deterministic failure for rejection before write.
- [ ] Parse unsolicited DTMF notifications separately so they cannot satisfy a command promise.
- [ ] Run the focused test and the Goal 1 protocol/agent tests.
- [ ] Commit as `feat(media): add RTPengine NG client`.

### Task 6: Checksummed Local Command WAL

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/journal.ts`
- Create: `test/ivekit-media-control-journal.test.ts`

- [ ] Write failing tests for append/replay, process reopen, truncated tail, checksum mismatch, symlink refusal, file permissions, terminal retention, byte bound, and atomic compaction.
- [ ] Store only command identity, command hash, owner epoch, sequence, transport call ID, result class, effective SDP, session state, and timestamps.
- [ ] Prefix every record with length and SHA-256. Ignore only an incomplete final record; reject corruption in any committed record.
- [ ] Open files with no-follow semantics where supported, require mode `0600`, fsync successful command outcomes before returning them, and fsync the parent directory after atomic rename.
- [ ] Compact only terminal records outside retention. Never discard an unknown or active session.
- [ ] Enforce both record-count and byte bounds; fail readiness before unbounded growth.
- [ ] Commit as `feat(media): persist transport command journal`.

### Task 7: RTPengine `MediaTransportPort`

**Files:**
- Create: `src/agent-runtime/ivekit/media-control/rtpengine.ts`
- Modify: `src/agent-runtime/ivekit/media-control/index.ts`
- Create: `test/ivekit-rtpengine-media-transport.test.ts`

- [ ] Write failing tests using a real TCP NG fixture for offer, answer, update, delete, query, block/unblock, start/stop forwarding, start/stop recording, play/stop media, DTMF, quality query, and drain.
- [ ] Require offer payload fields `offer_sdp`, `from_tag`, and `media_profile_id`; require answer/update tags according to the SIP dialog state.
- [ ] Map iveKit actions exactly:

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

- [ ] Send all owner/fencing keys on every mutating request and keep logical SDP separate from returned effective SDP.
- [ ] On startup, load active WAL sessions, query RTPengine by call ID, and mark missing calls closed. Do not claim active recovery without both WAL and RTPengine facts.
- [ ] On unknown outcome, query WAL first, then RTPengine. Replay only with the same cookie after RTPengine proves the command was not observed.
- [ ] Keep delete idempotent and retain the owner tombstone.
- [ ] Commit as `feat(media): execute commands through RTPengine`.

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
- Create: `test/ivekit-rtpengine-deployment.test.ts`

- [ ] Write a failing deployment test that rejects production simulator mode, mutable image tags, public NG control ports, missing WAL volume, missing UDP media range, unbounded resources, and kernel mode without the required host mounts/capabilities.
- [ ] Add `IVEKIT_MEDIA_CONTROL_TRANSPORT=rtpengine` and require endpoint, WAL directory, runtime mode, request pool, and byte bounds.
- [ ] Keep the NG control service private. Publish only the declared RTP/RTCP UDP range on media nodes.
- [ ] Mount the WAL on a dedicated bounded volume. Keep the media-control root filesystem read-only.
- [ ] Separate Helm values for privileged kernel nodes and unprivileged userspace nodes with explicit node selectors, taints, PDB, drain hook, and ServiceMonitor.
- [ ] Preserve established RTPengine sessions when media-control is recreated.
- [ ] Commit as `feat(deploy): add RTPengine media nodes`.

### Task 9: Real RTP, RTCP, SRTP, And Restart Acceptance

**Files:**
- Create: `scripts/ivekit-rtpengine-acceptance.ts`
- Create: `scripts/capacity/generators/rtpengine-media.ts`
- Create: `test/ivekit-rtpengine-acceptance.test.ts`
- Modify: `package.json`

- [ ] Write a failing acceptance test that requires immutable deployment identity and bounded evidence.
- [ ] Generate two endpoint SDPs, execute offer/answer through media-control, and send timestamped G.711 RTP plus RTCP in both directions without requiring a sound card.
- [ ] Verify packet count, sequence continuity, SSRC, payload integrity, relay address, first-packet time, packet loss, jitter, and RTCP receipt.
- [ ] Repeat with SDES SRTP and verify that plaintext is not observable on the relay-facing capture.
- [ ] Stop media-control and Cell admission during an established stream; require RTP to continue.
- [ ] Recreate media-control with the same WAL; require query and idempotent delete to succeed without a second allocation.
- [ ] Exercise drain, hard capacity, stale epoch, higher-epoch takeover, before-write failure, after-write disconnect, and RTPengine process failure.
- [ ] Mark kernel, recording, and transcoding checks independently; never infer them from plain userspace RTP.
- [ ] Commit as `test(media): add real RTPengine acceptance`.

### Task 10: Supply-Chain Evidence

**Files:**
- Create: `scripts/ivekit-rtpengine-supply-chain.ts`
- Create: `test/ivekit-rtpengine-supply-chain.test.ts`
- Modify: `infra/ivekit/rtpengine/build.sh`

- [ ] Write a failing test for CycloneDX and SPDX SBOMs, Trivy JSON, OCI digest, provenance, signature reference, source identity, patch-set identity, and secret scanning.
- [ ] Generate SBOMs from the exact runtime image and retain vulnerability severity plus database timestamp.
- [ ] Produce an in-toto/SLSA-style provenance statement binding source archive, patch set, builder digest, build arguments, architecture, and output digest.
- [ ] Sign by digest when `IVEKIT_COSIGN_KEY` or keyless CI identity is available. Otherwise emit `signature.status=not_run`; never create a false pass.
- [ ] Reject release on critical vulnerabilities without a recorded exception and expiry.
- [ ] Commit as `build(rtpengine): attest media artifacts`.

### Task 11: Goal 2 Finalizer And Documentation

**Files:**
- Create: `scripts/ivekit-voice-media-goal2-finalize.ts`
- Modify: `docs/capacity/forks/ivekit-forks-v1.json`
- Modify: `docs/capacity/README.md`
- Modify: `infra/ivekit/media-control/README.md`
- Modify: `docs/design/communication-foundation-vos5000-parity-performance-plan.md`
- Create: `test/ivekit-voice-media-goal2-finalizer.test.ts`

- [ ] Write failing finalizer tests for missing identity, missing repetition, reconciliation delta, generator overload, clock invalidity, incomplete failure evidence, and mixed kernel/userspace results.
- [ ] Require every acceptance attempt to be retained, including invalid attempts.
- [ ] Promote `patch_apply`, `compile`, `unit`, `integration`, and `real_environment` only from evidence generated by the exact artifact.
- [ ] Keep `benchmark=not_run` and `capacity_claim=none` until the later physical capacity campaign completes at least three valid repetitions.
- [ ] Document exact deployment, rollback, drain, WAL recovery, userspace fallback, kernel module compatibility, and evidence collection commands.
- [ ] Run:

```bash
npm run typecheck
npm run test:ivekit:voice-media-goal1
npm run test:ivekit:voice-media-goal2
git diff --check
```

- [ ] Commit as `docs(media): complete RTPengine Goal 2 evidence`.

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

## Goal 2 Completion Gate

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
