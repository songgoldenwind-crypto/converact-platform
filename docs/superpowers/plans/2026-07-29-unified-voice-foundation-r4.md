# Unified Voice Foundation Revision 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` for independent slices, `test-driven-development` before every runtime change, `requesting-code-review` before each commit, and `verification-before-completion` before reporting a gate as passed.

**Goal:** Freeze one executable Revision 4 contract, preserve every historical Goal 0–11 and rvoip capability, then build a high-performance Rust voice foundation with mandatory G.729, RTPengine as the ordinary-media production baseline, and durable bidirectional Voice/SIP/PSTN ↔ LiveKit handoff.

**Architecture:** Unified RustPBX is one Rust product process and the only telephony Call/business authority. Kamailio remains the SIP edge, RTPengine owns the ordinary RTP/SRTP fast path, embedded `voice-media-rs` owns decode-required media, and LiveKit remains the Room/WebRTC/SFU authority. Selectively absorbed rvoip protocol/media slices compete behind stable interfaces; they never create a second PBX, Call model, media writer, billing writer, recording authority, or WebRTC runtime.

**Tech Stack:** TypeScript/Node.js, Rust/Tokio, PostgreSQL, JSON Schema 2020-12, Kamailio, RTPengine, RustPBX/rsipstack, selected exact-source rvoip slices, LiveKit SIP, LiveKit, existing iveKit capacity/evidence framework.

---

## Execution invariants

- Work only in `/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3` on
  `codex/ivekit-v5-shared-foundation`.
- Preserve all pre-existing dirty and untracked files. Never use `git add .`;
  stage only files or hunks created by the current slice.
- Do not push unless the user explicitly requests it.
- Keep `current`, `target`, `not_run`, `verified`, and
  `production_eligible` separate. Upstream claims and local microbenchmarks
  cannot authorize iveKit production claims.
- A directed media edge generation has exactly one writer. A Protocol Session
  has exactly one active `SipFoundation` adapter.
- Default migrations move new Calls only and drain old Calls. Active-call
  migration is independently qualified and can promise bounded measured
  gap/loss, never unproved zero loss.
- A normal drain deadline records `drain_timed_out` and bounded repair; it
  never forces BYE/CANCEL and never authorizes deleting the old
  implementation. Removal waits for active Calls/Protocol Sessions/Edges/
  groups, unknown effects and cleanup deltas to reach zero plus rollback-window
  expiry.
- The external G.729 codec identity is only `G729/8000`. G729A and G729AB are
  mandatory internal processing, quality, and capacity modes selected through
  Annex B negotiation.
- U2 exact-source extraction, implementation, compilation, vectors and
  packetization depends only on D0. It does not wait for U1 or another manual
  approval; later runtime integration/production enablement still obeys its
  own interop, quality, security, supply-chain and capacity gates.
- Legal review blocks G.729 production distribution, runtime enablement, and
  production eligibility; it does not block engineering, source extraction,
  compilation, or tests.
- No local Docker, no LED mutations, no secret capture, and no fabricated or
  borrowed evidence.

## Phase D0: Freeze Revision 4 before runtime changes

### Task D0.1: Write the authoritative machine contract and schema

**Files:**

- Create: `docs/capacity/contracts/unified-voice-foundation-r4-v1.json`
- Create: `docs/capacity/schemas/unified-voice-foundation-r4.schema.json`
- Test: `test/ivekit-unified-voice-foundation-r4-contract.test.ts`

1. Write a failing schema test requiring a closed object with source identity,
   claim boundary, authority matrix, receipt facts, wire freeze, backend
   capability sets, recovery matrix, durable-store SLO, Edge-to-Core policy,
   rolling-schema rules, clocks, migration/drain, G.729, LiveKit handoff,
   capacity demand, security, quality, and phase gates.
2. Require every unexecuted physical or production result to equal `not_run`
   and every production eligibility field to remain false.
3. Add the closed JSON Schema and the target contract.
4. Assert one external `G729/8000` identity and exactly two mandatory internal
   modes, `G729A` and `G729AB`.
5. Assert one telephony/business owner, one Room/WebRTC owner, one recording
   authority, one billing/rating authority, and one writer per directed edge
   generation.
6. Assert RTPengine atomic prepare-blocked/commit/revoke-zero-output/query
   capability is a required target but currently `not_run` and unavailable.
7. Freeze closed `backend-capability-set-v1@1.0.0` records for
   `embedded_voice_media`, `livekit_sip_bridge`, `rtpengine_ordinary` and the
   optional `rust_native_fast_path`. Bind source/binary/config/capability-set
   identity plus lifecycle, protocol/security, transport, processing,
   observability and recovery granularity. Independently gate all 13 lifecycle
   operations (`allocation`, `prepare`, `commit`, `abort`, `revoke`, `fence`,
   `query`, `reconcile`, `migration`, `notification`, `member_flow_fence`,
   `zero_output_ack`, `security_termination_scope`) on exact
   support/verification/granularity/prerequisites. Missing, unsupported,
   unverified, wrong-granularity or unmet-prerequisite operations are distinct
   compiler errors and fail closed without side effects while freezing the
   exact generation. If allocation or fencing is coarser than one directed
   Edge generation, the compiler must prove an exact member-flow fence, split
   the Binding Group, or reject before allocation; it must never silently
   weaken the required set or infer one operation from another.
8. Freeze the exact Edge-to-Core limits: 65,535-byte message, 4,096-byte start
   line, 2,048-byte URI, 32,768-byte header section, 128 headers,
   8,192-byte header line and 32,768-byte body; URI parameter/header-component
   counts of 32/16; multipart boundary/depth/parts/part-header/part-body limits
   of 70/2/16/8,192/32,768. Also freeze the per-header duplicate policy, URI
   percent/userinfo/host/IPv6 rules, trusted metadata allowlist and
   strip-then-recreate policy. Every conflict or ambiguity fails closed; no
   parser may choose an arbitrary first/last duplicate.
9. Freeze a machine-readable MediaPlan → demand calculation for RTP and RTCP
   sockets, SRTP contexts, port pairs, PPS, bps, memory, CPU, NUMA,
   decode/encode/resample/transcode/mix/record/AI slots and each directed
   Edge/Binding Group generation without double counting shared transport.
   Include worker/shard count, queue depth, service time and backpressure
   limit. Bind each dimension to signed, unexpired, unit- and identity-matched
   Backend role supply. Evaluate with checked-u64 arithmetic:
   `deduplicated demand <= signed supply - active reservations - failure
   reserve`; overflow, underflow, absent failure domain or stale supply reject.
   Shared transport deduplicates only by exact Binding Group/generation/Wire
   Bundle; the same key with a different demand vector is a fail-closed
   conflict, never double-counted, overwritten or arbitrarily selected.
   Admission CASes profile/revision/reservation epoch/vector digest and
   durably writes the receipt before Backend prepare. N+1 independently proves
   `supply - active reservations - largest failure domain >= peak demand`.
10. Freeze the PostgreSQL-backed
    `opc-persistent-schema-registry-v1` and all 18 versioned artifacts,
    including the five Voice↔LiveKit durable artifacts
    (`bridge_generation`, `bridge_attempt`, `bridge_command`,
    `bridge_receipt`, `bridge_tombstone`). Each artifact separately carries
    N/N+1 schema IDs and hash slots, reader matrix, writer gate, takeover,
    migration, rollback, retention and GC; every schema hash, current writer
    version and writer identity remains null/`not_run` until evidence exists.
    Prove the explicit 1.0.0/1.1.0 expand/contract reader/writer gates.
    Also freeze the sole ordinary
    RFC 4733 acquisition/report path and its required
    `dtmf_event_notification` Backend capability, DTLS role/fingerprint,
    ICE credential/consent/restart, RTCP-mux/BUNDLE/MID invariants, security
    advisory/backport/bounded-fork/crash-artifact rules, the eight-participant
    N-1 conference's per-participant jitter/encode budgets and quality
    loudness gates.
11. Freeze the single-region all-or-nothing store boundaries and route/media/
    billing/recording/webhook durable gates; deterministic checked 503
    `Retry-After`; bounded RFC 3263 candidate resolution/connection and
    retention; `active_timers` as non-restorable V1 state; three-authority
    `unified_rustpbx`/`rtpengine`/`effect_wal` drain with independent zero
    counts (`call_count/protocol_session_count/edge_count/binding_group_count`,
    `session_count/port_count/allocation_count/generation_count`,
    `pending_effect_count/unknown_effect_count` and
    `repair_delta_count/cleanup_delta_count`), exact
    `tenant_id/drain_scope_id/generation/observation_epoch` receipt
    consistency, checked-u64 counters, retention/rollback-reference zero before
    deletion, and separately authorized emergency termination carrying
    `actor/reason_code/incident_id/scope/expires_at/decision_hash`;
    mTLS+HMAC authenticated bounded durable DTMF delivery; exact LiveKit
    scenario/property/fault vectors plus typed command-token/cancel/webhook
    contracts and deterministic generation-resource conservation; null-gated
    quality method/workload/threshold/evidence bindings; and non-inheritable
    RTPengine userspace and kernel execution profiles. All remain
    target/`not_run`.
12. Run:

   ```bash
   node --import tsx --test test/ivekit-unified-voice-foundation-r4-contract.test.ts
   ```

### Task D0.2: Freeze complete traceability

**Files:**

- Create byte-identical archive:
  `docs/capacity/contracts/unified-voice-foundation-baseline-review.md`
- Create byte-identical archive:
  `docs/capacity/contracts/unified-voice-foundation-blocking-review.md`
- Create byte-identical archive:
  `docs/capacity/contracts/unified-voice-foundation-historical-objective.md`
- Create: `docs/capacity/contracts/unified-voice-foundation-r4-traceability-v1.json`
- Create: `docs/capacity/schemas/unified-voice-foundation-r4-traceability.schema.json`
- Create: `test/ivekit-unified-voice-foundation-r4-traceability.test.ts`
- Modify: `test/ivekit-unified-voice-foundation-r4-contract.test.ts`

1. Archive the two user reviews and superseded objective byte-for-byte, record
   their raw SHA-256 identities, and make tests compare each archive directly
   with its source instead of trusting a self-declared digest.
2. Add a failing test requiring unique rows for historical Goals 0–11,
   optional Track R, Review C1–C6, Review I1–I12, security/conference/quality
   supplements, all ten baseline-review decisions, the superseded objective,
   all 198 rvoip capability IDs, all 14 historical replacement gates, and the
   Voice↔LiveKit functional/fault/capacity requirements.
3. Resolve each review row against a real exact heading in its archived source;
   the Revision 4 contract/design pointer is the target, never the row's source.
4. Require every row to bind one owner phase, one or more canonical artifacts,
   one or more executable tests/evidence targets, and an honest status.
5. Add a closed traceability schema and sorted contract rows.
6. Compare capability and replacement-gate IDs directly with
   `rvoip-capability-integration-v1.json`; reject omissions, duplicates, or
   additions.
7. Run the focused test.

### Task D0.3: Record the Voice↔LiveKit hard-to-reverse decision

**Files:**

- Create: `docs/adr/ccaas-8-voice-livekit-bridge-handoff.md`
- Modify: `CONTEXT.md`
- Modify: `test/ivekit-unified-voice-foundation-r4-contract.test.ts`

1. Add a failing text/contract assertion for the Authority boundary and durable
   bridge state machine.
2. Write the ADR with context, considered options, decision, consequences,
   failure modes, rollout, rollback, and evidence gates.
3. Define `Voice-LiveKit Handoff`, `Voice-LiveKit Bridge`, `Bridge Generation`,
   and `Directed Media Edge` in the ubiquitous language.
4. Freeze `prepare → commit | abort`, `query`, `reconcile`, participant
   terminate/delete, orphan cleanup, stable interaction/Call ID, bridge
   generation, owner epoch, writer fence, terminal receipt, one billing key,
   and recording continuity.
5. State that the existing
   `RustPBX ↔ livekit-sip ↔ LiveKit` path is reused and that LiveKit SIP is an
   executor, not a second PBX or CDR authority.
6. State that an implementation without a blocked output gate is measured
   break-before-make and cannot claim seamless or zero-loss switching.
7. Freeze four independent paths (`V2L_NEW`, `L2V_NEW`, `V2L_ACTIVE`,
   `L2V_ACTIVE`) whose functional/fault/capacity evidence cannot inherit from
   another path, ordinary RTP, LiveKit-only, or bridge-excluded MIX evidence.
8. Define one logical bridge, immutable generation/attempt, append-only
   command/receipt, CAS `(revision, owner_epoch, state)`, `RESTRICT` foreign
   keys, tombstones, and a no-dual-write storage migration.
9. Keep one root RecordingManifest with source segment chains across handoff,
   and require HTTPS/TLS for every production LiveKit control endpoint; an
   internal-service flag may not authorize bare HTTP.
10. Qualify one Call through 32 complete alternating
    `V2L_ACTIVE → L2V_ACTIVE` round trips. Every switch creates a new
    generation; concurrent opposite commands have exactly one CAS winner,
    while each loser fails closed then queries/reconciles the winning
    generation. Assert no monotonic growth and terminal zero leaks for
    participants, port pairs, Backend allocations, writers, pending commands
    and unreconciled receipts.

### Task D0.4: Apply Revision 4 to canonical architecture documents

**Files:**

- Modify: `docs/design/rvoip-opc-communication-foundation-integration-design.md`
- Modify: `docs/adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md`
- Modify: `docs/adr/ccaas-5-media-authority-and-rtpengine.md`
- Modify: `docs/design/communication-foundation-vos5000-parity-performance-plan.md`

1. Add a Revision 4 decision block and link the authoritative machine
   contracts.
2. Replace any external “G729A/G729AB codec identities” wording with one
   `G729/8000` wire identity and two mandatory internal modes.
3. Freeze fact levels: durable decision, send attempted, transport accepted,
   protocol observed, failed, and unknown. Explicitly reject network Exactly
   Once claims.
4. Freeze wire construction order:
   semantic intent → route/transport/local endpoint binding → wire bytes/hash
   freeze → durable decision → transmission.
5. Freeze V1 recovery to confirmed, transaction-quiescent dialogs; enumerate
   fail-closed handling for early dialogs, active transactions, pending ACK,
   PRACK/RSeq, dead TCP/TLS flows, DNS attempts, and unknown effects.
6. Freeze the durable-store latency/degradation contract and allow `100 Trying`
   only after transaction admission; forbid business-visible 18x/2xx before
   durable business decision.
7. Freeze Edge-to-Core parser/security metadata, external-header stripping,
   differential corpus, schema N/N+1 rules, UTC/monotonic/RTP clocks, bounded
   drain and emergency termination.
   The canonical documents must repeat the machine contract's exact hard
   limits/canonicalization rules, versioned capability categories and
   split-or-reject compiler rule, schema-registry compatibility artifacts,
   MediaPlan demand/supply/reservation/N+1 equation, one DTMF acquisition path,
   DTLS/ICE/BUNDLE/RTCP-mux/MID invariants, security advisory/backport/fork/
   core-dump policy, conference jitter/encode budgets and quality loudness
   gates.
   Also repeat the per-operation lifecycle gate/compiler errors, checked
   capacity predicate and signed supply identity, 18 per-artifact schema
   contracts, store atomic/business gates and deterministic Retry-After,
   RFC 3263 bounds/retention, non-restorable active timers, three-party drain,
   authenticated bounded DTMF delivery, LiveKit verification vectors,
   null-gated quality bindings and independent RTPengine userspace/kernel
   profiles.
8. State the honest single-process fault boundary: resource isolation is
   possible while the process is healthy; OOM, abort, undefined behavior, and
   allocator corruption can interrupt all embedded edges.
9. Add Voice↔LiveKit as `Goal 3L`, functionally after Goal 3 and parallel with
   Goals 4/5/6; require Goals 7–11 for production capacity evidence.
10. Add `VOICE-LIVEKIT-BRIDGE-V1` as a distinct profile whose results cannot be
    inherited from ordinary RTP or bridge-excluded MIX evidence.

### Task D0.5: Bind existing contracts without rewriting frozen history

**Files:**

- Modify: `docs/capacity/contracts/rvoip-capability-integration-v1.json`
- Modify: `docs/capacity/schemas/rvoip-capability-integration.schema.json`
- Modify: `test/ivekit-rvoip-capability-integration.test.ts`
- Modify: `docs/capacity/contracts/voice-media-goal4-v1.json`
- Modify: `docs/capacity/schemas/voice-media-goal4.schema.json`
- Modify: `docs/capacity/schemas/voice-media-processing-profile.schema.json`
- Modify: `docs/capacity/profiles/vos-eq-v3-g711-opus-1k-v1.json`
- Create: `docs/capacity/profiles/vos-eq-r4-g711-opus-1k-v1.json`
- Modify: `docs/capacity/schemas/capacity-vector.schema.json`
- Modify: `docs/architecture/component-authority-matrix-v1.json`
- Modify: `docs/capacity/README.md`
- Modify: `test/component-governance.test.ts`

1. Add a top-level Revision 4 authority-contract reference without changing
   the frozen 198 capability IDs, 14 replacement gates, or their current
   statuses.
2. Bind Goal 4 to the Revision 4 contract and correct only the G.729 external
   identity terminology; preserve all `not_run` results.
3. Retire the unmeasured Revision 3 G.711/Opus target and bind Goal 4 and the
   component authority matrix to a distinct Revision 4 replacement profile;
   neither profile authorizes a capacity claim.
4. Extend capacity dimensions for bridge generations, directed bridge edges,
   LiveKit SIP participants, bridge CPS, switching attempts, switch gap/loss,
   codec/transcode demand, recording roles, and handoff reconciliation. A
   bridge vector is schema `1.1.0`, carries all 13 canonical dimensions, and
   `target|not_run|failed` evidence structurally forces zero advertised safe
   capacity and rejection of new interactions.
5. Keep the bridge object absent for `1.0.0` producers, prove `1.1.0` readers
   accept those vectors, prove `1.0.0` readers cannot consume `1.1.0` vectors,
   and hold writers at `1.0.0` until every live reader supports `1.1.0`.
6. Run the existing rvoip and Goal 4 contract suites plus the new Revision 4
   suite.

### Task D0.6: Independent contract review and contract-only commit

1. Run:

   ```bash
   npm run typecheck
   node --import tsx --test \
     test/ivekit-unified-voice-foundation-r4-contract.test.ts \
     test/ivekit-unified-voice-foundation-r4-traceability.test.ts \
     test/ivekit-unified-voice-authority-binding.test.ts \
     test/ivekit-rvoip-capability-integration.test.ts \
     test/component-governance.test.ts
   npm run test:ivekit:voice-media-goal4
   npm run test:call-center-s12
   ```

2. Commission independent SIP/durability, runtime/media, and LiveKit handoff
   reviews. Resolve every Critical and Important item or record a fail-closed
   `not_run` gate.
3. Inspect `git diff --check`, the exact file list, and the staged diff.
4. Stage only clean D0 files/hunks.
5. Commit:

   ```text
   docs(voice): freeze unified foundation revision 4
   ```

6. A successful D0 commit immediately authorizes Phase U1; do not ask for a
   second approval.

## Phase U1: Baseline SIP semantics before rvoip migration

### Task U1.1: Freeze `SipFoundation` interfaces and fail-closed capabilities

**Files:**

- Create: `src/agent-runtime/ivekit/voice/sip-foundation/types.ts`
- Create: `src/agent-runtime/ivekit/voice/sip-foundation/capabilities.ts`
- Create: `src/agent-runtime/ivekit/voice/sip-foundation/rsipstack-adapter.ts`
- Test: `test/ivekit-sip-foundation.test.ts`

1. Write tests for one adapter per Protocol Session, closed
   `BackendCapabilitySet`, route/transport/local-endpoint binding, prepared
   wire identity, owner epoch, command sequence, and fail-closed selection.
2. Implement the minimum rsipstack baseline adapter without changing the
   current production route.
3. Reject an adapter whenever a required capability is false, unknown,
   unverified, or bound to a different runtime/config digest.
4. Keep rvoip types behind the adapter boundary.

### Task U1.2: Add durable effect oracle and receipts

**Files:**

- Create: `src/agent-runtime/ivekit/voice/sip-foundation/effect-oracle.ts`
- Create: `src/agent-runtime/ivekit/voice/sip-foundation/postgres-effect-store.ts`
- Create: `src/agent-runtime/ivekit/voice/sip-foundation/migrations/001_effect_oracle.sql`
- Test: `test/ivekit-sip-effect-oracle.test.ts`

1. Test prepare, conflicting replay, durable decision, send attempt, protocol
   observation, unknown result, query, bounded retention, and repair.
2. Persist immutable wire bytes/hash and routing binding before transmission.
3. Reuse committed bytes for transaction retransmission.
4. Never infer peer receipt from a local send result.
5. Add latency, queue-depth, unknown, and repair metrics with bounded labels.
6. Make call-admission, media-generation, bridge-head and recording writes
   all-or-nothing single-Region transactions. Gate route/media/billing/
   recording/webhook effects on their declared durable boundary. For store
   timeout, pool exhaustion, unavailability or schema incompatibility return
   SIP 503 with deterministic, no-jitter
   `clamp(1,30,1+ceil(pool_wait_ms/1000)+ceil(queue_depth/256)+retry_attempt)`
   `Retry-After`; invalid inputs fail without fabricating a value.

### Task U1.3: Implement confirmed/quiescent-only recovery

**Files:**

- Create: `src/agent-runtime/ivekit/voice/sip-foundation/recovery.ts`
- Test: `test/ivekit-sip-foundation-recovery.test.ts`

1. Test confirmed/quiescent recovery success.
2. Test early dialog, active transaction, pending ACK/PRACK, dead connection,
   active timers, schema mismatch, and unknown effect rejection.
3. Rebuild deadlines from persisted policy; never persist or restore a runtime
   monotonic `Instant`.
4. Keep cross-adapter recovery disabled.

## Phase U2: Mandatory exact-source G.729

**Dependency:** D0 only for all U2 engineering and evidence generation. U1,
U3, U4 and U5 may proceed independently; they are consumers/integration
phases, not prerequisites for exact-source codec work.

### Task U2.1: Audit and close the existing candidate slice

**Files:**

- Inspect before editing:
  `docs/capacity/forks/rvoip-g729-source-candidate-v1.json`
- Inspect before editing:
  `services/voice-media-rs/vendor/audio-codec-g711-opus/`
- Modify only after reconciling user work:
  `services/voice-media-rs/Cargo.toml`
- Test: `services/voice-media-rs/tests/g729_vectors.rs`

1. Preserve and review all pre-existing G.729 candidate changes.
2. Verify exact repository/commit/tree/archive/source-set hashes and the closed
   dependency set.
3. Write failing reference-vector tests for Annex A and Annex B before wiring
   the implementation.
4. Remove or exclude conflicting G.729 authorities.

### Task U2.2: Implement one wire codec with two mandatory modes

**Files:**

- Create: `services/voice-media-rs/src/codec/g729.rs`
- Modify: `services/voice-media-rs/src/codec.rs`
- Modify: `services/voice-media-rs/src/session.rs`
- Test: `services/voice-media-rs/tests/g729_packetization.rs`
- Test: `services/voice-media-rs/tests/g729_interop.rs`

1. Test `G729/8000`, static PT 18, dynamic remap, 10/20/30/40/50/60 ms ptime,
   10-octet speech, 2-octet SID, and no-data semantics.
   Explicitly prove 50 ms carries five 10 ms speech frames with correct RTP
   timestamp/sequence behavior.
2. Test Annex B missing-default-yes and explicit-no-wins negotiation.
3. Test G729A and G729AB as internal modes, not external codec names.
4. Add PLC, VAD/DTX/CNG, G.711/Opus pairs, allocation, latency, and
   sessions/core tests.
5. Keep runtime enablement false until legal/supply-chain, interoperability,
   quality, and capacity gates pass.

## Phase U3: RTPengine atomic lifecycle

### Task U3.1: Implement and prove the atomic binding primitive

**Files:**

- Create: `infra/ivekit/rtpengine/patches/rtpengine-ivekit-atomic-binding-lifecycle-v1.patch`
- Modify: `infra/ivekit/rtpengine/manifest.json`
- Test: `test/ivekit-rtpengine-atomic-binding-lifecycle.test.ts`

1. Write source/static tests for group ID/generation, member-flow fence digest,
   durable prepare state, blocked output, commit, abort, zero-output revoke,
   query, and replay.
2. Patch exact-source RTPengine or its bounded iveKit agent only where the
   required packet-level guarantee can be enforced.
3. Test userspace and kernel paths separately; a userspace pass cannot
   authorize kernel mode.
   Bind each profile independently to source/binary/config/capability-set,
   hardware/NIC/kernel-module/Cell identity and its own packet-path evidence;
   every identity slot/result remains null/`not_run` and results cannot be
   inherited across execution modes.
4. Keep capability false and migration disabled until real packet evidence is
   verified.

### Task U3.2: Wire RustPBX media orchestration

**Files:**

- Modify: `infra/ivekit/rustpbx/src/media_engine_facade.rs`
- Modify: `infra/ivekit/rustpbx/src/media_plan.rs`
- Test: `test/ivekit-media-binding-lifecycle.test.ts`

1. Test initial prepare/commit before SDP exposure.
2. Test unknown query/reconcile and pre/post-decision compensation.
3. Test new-call selection and old-call drain.
4. Gate active migration behind verified atomic capabilities.

## Phase U4: Selective rvoip SIP absorption

### Task U4.1: Differential shadow

**Files:**

- Create: `src/agent-runtime/ivekit/voice/sip-foundation/rvoip-shadow.ts`
- Test: `test/ivekit-rvoip-sip-shadow.test.ts`

1. Feed one immutable input to rsipstack and rvoip parsers.
2. Compare canonical semantics without allowing rvoip output, timers, state
   mutation, database access, or media control.
3. Run the Edge-to-Core security corpus and fuzz cases.

### Task U4.2: Replace one protocol layer at a time

1. Qualify message codec independently.
2. Qualify non-INVITE and INVITE transaction slices.
3. Qualify Protocol Dialog policy including ACK/CANCEL/PRACK/forking.
4. Qualify UDP, then TCP, then TLS, then RFC 3263.
   RFC 3263 qualification fixes NAPTR/SRV/address ordering, 2 s DNS query,
   3 s candidate connect, at most 8 candidates and one retry each, and a
   10 s total deadline. Exhaustion writes ordered candidate receipts; retain
   candidate attempts 1 day, transaction effects 7 days and late-response
   correlation 32 seconds before reference-safe GC.
5. Canary only new Calls in one Cell; drain old adapter sessions to zero.
6. Delete a superseded duplicate only after active-zero reconciliation and
   rollback-window expiry.

## Phase U5: Unified decoded-media slices

1. Complete G.711/Opus, jitter/reorder/PLC, resampling, RFC 4733/SIP INFO/
   in-band DTMF unification, IVR playback/gather, and recording taps. The
   ordinary fast path has exactly one no-decode acquisition path:
   `rtpengine_rfc4733_event_notification` → RustPBX per-Leg canonical
   authority, with the closed identity/dedupe fields, P99 report budget of
   50 ms and fail-closed query/reconcile on loss or ambiguity; no parallel
   read-only fork or decode-all path is allowed.
   Delivery is mTLS plus HMAC authenticated and generation-bound, with a
   1,024-event queue, 4,096-byte event ceiling and 50 ms deadline. Allocate
   per-Leg sequence by durable CAS before business effects; duplicate receipt
   replay is side-effect-free, while gaps/overflow freeze effects and query the
   exact Leg.
2. Complete mandatory G.729, then AMR-NB/WB and T.38.
3. Implement bounded small audio conference N-1 mixing with at most eight
   participants, `N*(N-1)` directed contributions, `N` per-participant jitter
   buffers and `N` encode outputs. Reject the ninth participant without
   disturbing the active mix; keep large rooms on LiveKit SFU. Quality
   qualification includes clipping, loudness and level normalization as
   independent `not_run` gates until measured.
   Every quality metric binds a declared method source/digest, exact quality
   and workload profile, signed threshold and immutable evidence identity.
   The method map is: MOS-LQO=P.863 or declared equivalent,
   PESQ/POLQA=P.862/P.863 licensed score, loss=RTP sequence-gap capture,
   jitter=RFC 3550 interarrival, PLC=reference/degraded comparison,
   clipping=PCM full-scale ratio, loudness=BS.1770 LUFS, normalization=
   input/output LUFS delta, tandem=codec-chain reference A/B, clock drift=
   RTP-versus-monotonic PPM, DTX/CNG=state-transition continuity and switch
   gap=last-old/first-new capture.
   Current method/workload/threshold sources and hashes are null, threshold
   bindings are empty, and missing or unsigned bindings remain
   `not_run`/ineligible with an independent witness required.
4. Audit every native/unsafe dependency for ABI, allocator ownership, thread
   safety, CPU features, sanitizer coverage, abort behavior, and key-memory
   handling before co-resident enablement.
5. Preserve fixed workers, bounded queues/pools, no per-packet task, no global
   hot-path lock, and no avoidable steady-state allocation.

## Phase U6: Bidirectional Voice/SIP/PSTN ↔ LiveKit

Dependencies are per slice, not one blanket phase gate:

| U6 slice | Required predecessors | Explicitly not inherited |
| --- | --- | --- |
| repository/schema/backfill only | D0 | no U1/U3/U5 runtime dependency and no behavior enablement |
| durable command/receipt coordinator and new-call bridge | U1 effect semantics + U3 Edge/generation fencing; G.711↔Opus uses only its completed U5 slice | no G.729, active-handoff, recording or capacity claim |
| `V2L_NEW` / `L2V_NEW` | previous row plus path-specific real SIP/RTP/SRTP/WebRTC evidence | one direction does not authorize the other |
| `V2L_ACTIVE` / `L2V_ACTIVE` | previous row plus path-specific revoke/query/tombstone and measured break-before-make evidence; make-before-break additionally requires verified blocked-output/zero-output capabilities | new-call evidence does not authorize active handoff |
| G.729 carrier leg | U2 plus the corresponding U5 G.729 integration slice | G.711↔Opus evidence |
| rvoip/advanced SIP transport or transfer slice | only the applicable U4-qualified module; the rsipstack baseline path does not wait for unrelated U4 modules | another transport/method/peer |
| recording/billing closure | U6 lifecycle contract; root RecordingManifest/source-chain physical evidence completes in U7 | bridge create success |
| production fault/capacity | U7 evidence/observability, then U8 physical qualification and U9 finalization | ordinary RTP, LiveKit-only, bridge-excluded MIX, or another U6 path |

### Task U6.1: Separate bridge persistence from recording

**Files:**

- Modify: `src/agent-runtime/ivekit/voice/ports.ts`
- Modify: `src/agent-runtime/ivekit/voice/types.ts`
- Create: `src/agent-runtime/ivekit/voice/postgres/media-bridge-store.ts`
- Create: `src/agent-runtime/ivekit/voice/postgres/migrations/002_media_bridge_generation.sql`
- Test: `test/ivekit-voice-media-bridge-store.test.ts`

1. Add `VoiceMediaBridgeRepository`.
2. Separate stable logical bridge, immutable generation/attempt, append-only
   command/receipt/tombstone, and the CAS bridge head. Freeze Voice-side and
   LiveKit-side identities plus both directed Edge generations.
3. Register `voice_livekit_bridge_generation`,
   `voice_livekit_bridge_attempt`, `voice_livekit_bridge_command`,
   `voice_livekit_bridge_receipt` and `voice_livekit_bridge_tombstone` in
   `opc-persistent-schema-registry-v1`, then prove the 1.0.0/1.1.0
   expand/contract reader and writer gates before enabling a new writer.
4. Advance the head only with expected `(revision, owner_epoch, state)`; stale
   updates fail closed. Link history with `ON DELETE RESTRICT`.
5. Backfill existing rows as `legacy_unverified` without inventing blocked
   gates, TX watermarks or provider receipts; query exact provider identities
   before appending observed facts.
6. Switch one writer by epoch/CAS with no old/new dual-write. Remove the legacy
   read path only after active/unknown/repair zero, reconciliation, retention
   and rollback-window gates pass.
7. Do not create, split or replace the root RecordingManifest or its source
   segment chains during bridge-store migration.

### Task U6.2: Implement durable bridge lifecycle

**Files:**

- Modify: `src/agent-runtime/ivekit/voice/adapters/livekit-sip.ts`
- Create: `src/agent-runtime/ivekit/voice/livekit-handoff.ts`
- Modify: `src/agent-runtime/ivekit/voice/runtime.ts`
- Test: `test/ivekit-livekit-handoff.test.ts`

1. Test prepare, commit, abort, query, reconcile, terminate/delete participant,
   orphan cleanup, command replay, and timeout unknown.
2. Test `V2L_NEW` (SIP/PSTN→Room) and `L2V_NEW`
   (Room→SIP/PSTN) as independent evidence slices.
3. Test `V2L_ACTIVE` (active voice→browser) and `L2V_ACTIVE`
   (browser→voice) independently under one
   interaction/Call ID and billing key.
4. Test the same Call through 1..32 complete alternating
   `Voice → LiveKit → Voice` round trips; the qualification scenario executes
   all 32. Prove a new monotonically increasing bridge/Edge/Binding Group
   generation per switch, one writer, one billing session, one root recording
   manifest per role, bounded active participants/port pairs/allocations and
   terminal zero leaks for participants, port pairs, Backend allocations,
   writers, pending commands and unreconciled receipts.
5. Test concurrent opposite-direction and duplicate switch commands against
   CAS `(revision, owner_epoch, state)`: exactly one attempt may commit; every
   loser must receive a deterministic stale/conflict receipt and clean up its
   candidate without changing the winner or creating side effects.
6. Preserve the old side if the candidate is busy, rejected, cancelled, or
   fails before commit.
7. Enforce one writer per directed edge generation and record measured gap,
   loss, reorder, and duplicate counts.
8. Never inherit pass status across the four paths or from readiness/mock,
   ordinary RTP, LiveKit-only or bridge-excluded profiles.
9. Execute every machine vector independently: the eight scenario vectors
   are `same_call_32_round_trip_v2l_l2v`,
   `concurrent_head_cas_single_winner`, `terminal_zero_resource_leak`,
   `cancel_before_prepare_ack`, `cancel_after_apply_before_receipt`,
   `token_expiry_before_prepare`, `token_expiry_during_active` and
   `webhook_duplicate_reordered_replayed_forged`; the seven properties are
   `every_switch_allocates_new_generation`, `cas_loser_never_emits_media`,
   `one_call_cdr_rating_and_root_manifest`,
   `terminal_cleanup_is_idempotent`, `cancel_terminal_prevents_recreate`,
   `token_scope_matches_exact_generation` and
   `webhook_requires_exact_identity_and_receipt_digest`; the nine faults are
   `timeout_before_apply`, `timeout_after_apply`,
   `coordinator_crash_after_decision`, `livekit_sip_unavailable`,
   `sfu_disconnect`, `webhook_loss_duplicate_and_reorder`, `token_expiry`,
   `store_head_cas_conflict` and `cleanup_retry_and_dead_letter`. All vectors
   are non-inheritable and remain `not_run`.
10. Freeze and test three typed external-event contracts:
    - asymmetric-signed, pinned-issuer command tokens bind
      tenant/interaction/bridge/generation/operation/idempotency key plus
      issued/expiry/key identity; require checked `now < expires_at`; reject
      pre-prepare expiry without command/resource, while active expiry only
      blocks new commands;
    - cancel binds tenant/interaction/bridge/generation/command/key/hash and a
      per-generation command sequence; persist the tombstone before ACK,
      release without writer before prepare ACK, query/reconcile after apply,
      let terminal cancel beat late success, and never recreate;
    - signed, pinned-provider webhook binds tenant/interaction/bridge/
      generation/provider/event/sequence/type/receipt/payload identities;
      persist receipt before effect, bound reorder to 128, replay an exact
      duplicate without a second effect, and freeze/query forged, conflicting
      or out-of-window input.
    In the deterministic 32-round-trip model, the active generation has
    participant/port-pair/Backend-allocation/writer=`1/1/1/1` and
    pending-command/unreconciled-receipt=`0/0`; every terminal generation has
    all six at zero while Call/CDR/billing/root-manifest remain `1/1/1/1`.
    CAS losers, cancel, bad/expired tokens and forged webhooks allocate nothing.
    All results remain `not_run`.

### Task U6.3: Close media, recording, billing, and security behavior

1. Test G.711↔Opus and G.729 carrier legs with one selected transcoder.
2. Test RFC 4733, SIP INFO, in-band DTMF, hold/resume, mute, blind/consultative
   transfer, reconnect, Room end, BYE, and commit races.
3. Test SRTP/DTLS boundary, tenant/token isolation, webhook reordering and
   replay, participant/SIP gateway/SFU faults, and crash recovery.
   Bind the negotiated DTLS setup role and exact fingerprint to one Wire
   Transport Bundle generation; bind ICE ufrag/password and consent freshness
   to that generation; an ICE restart or DTLS role/fingerprint change creates
   a new generation. Require negotiated RTCP mux for BUNDLE and reject unknown
   or duplicate MID demultiplexing.
4. Keep one logical capture owner per recording role and one authoritative
   rating session per billing key. Keep one root RecordingManifest and append
   source-specific segment chains across handoff.
5. Return ordinary calls to the RTPengine fast path after the LiveKit bridge is
   removed.
6. Require `https://` with certificate/hostname verification for production
   LiveKit/LiveKit SIP control endpoints. Bare HTTP is limited to
   non-production loopback fixtures; `internal_service` never bypasses this
   production gate.

## Phase U7: Recording, evidence, observability, and capacity

1. Complete RecordingManifest segment continuity, spool/uploader recovery,
   encryption, consent, retention, legal hold, and orphan reconciliation.
2. Add low-cardinality SIP receipt, media writer, bridge state, G.729 mode,
   RTPengine lifecycle, durable-store, quality, and drain metrics.
3. Define `VOICE-LIVEKIT-BRIDGE-V1` with bridge direction/mix, switch rate,
   codec/security/recording mix, LiveKit SIP/SFU/RTPengine identities,
   hardware, compiler/selector revisions, and failure schedule.
4. Never inherit ordinary RTP, `optional_bridge_excluded`, local microbench, or
   upstream benchmark evidence.

## Phase U8: Physical performance and fault qualification

1. Use independent caller, callee, generator, receiver, SUT, and clock
   witnesses.
2. Measure CPU/packet, PPS, sessions/core, P50/P95/P99, packet loss, jitter,
   writer gap, switch gap, MOS/PESQ/POLQA or approved equivalents, long-call
   clock drift, tandem transcode, DTX/CNG transitions, and recording effects.
3. Qualify 1/2/4/8 scaling, NIC/IRQ/RSS/RPS/XPS, CPU pinning, NUMA, kernel and
   userspace paths, 24-hour endurance, OOM/panic/restart, dependency outage,
   Zone loss, and rollback.
4. Invalidate generator-bound, same-host-contaminated, clock-invalid,
   identity-mismatched, unreconciled, or incomplete attempts.

## Phase U9: VOS-EQ and 100K finalization

1. Sign VOS-EQ-5K and VOS-EQ-10K only on the bound physical profile.
2. Sign Cell-20K-VOICE-V1 N+1, VOICE-100K-V1, MIX-100K-v1, and
   VOICE-LIVEKIT-BRIDGE-V1 independently.
3. Keep external PSTN/TURN/object-storage/provider/Windows requirements
   `external_not_run` until executed.
4. Permit `production_pass` only when every required immutable evidence bundle
   binds source, binary/image, config, workload, hardware, raw data, clocks,
   approval, and reconciliation.
5. Mark the long-running Goal complete only after every clause of the binding
   objective and traceability matrix is verified with no required work
   remaining.
