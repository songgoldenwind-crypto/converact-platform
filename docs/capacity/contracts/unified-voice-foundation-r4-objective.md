# OPC/iveKit Unified Rust Voice Foundation — Revision 4 Goal

Continue the OPC/iveKit communication foundation in repository
`https://github.com/songgoldenwind-crypto/opc-platform.git`, worktree
`/Users/songjinfeng/Projects/opc-worktrees/ivekit-v3`, branch
`codex/ivekit-v5-shared-foundation`, from current local commit `4cefaa5`
(`docs(voice): lock unified authority baseline`). The remote branch currently
ends at `eac461b`; do not reset, rebase, discard, or overwrite the two local
commits. The working tree already contains user-owned changes and untracked
files. Preserve them exactly, inspect overlapping hunks before editing, stage
only files or hunks created for this goal, and never use `git add .`.

This goal supersedes the old executable objective in
`/private/tmp/opc-ivekit-new-goal-2026-07-29.md`, but it does not discard any
requirement from Goals 1 through 11 of
`docs/design/communication-foundation-vos5000-parity-performance-plan.md`.
Keep the old objective and plans as historical evidence. Create a machine- and
human-readable traceability matrix mapping every old goal, acceptance gate,
rvoip capability identified in the prior analysis, Revision 3 review finding,
and the Voice/SIP↔LiveKit switching requirements below to the new phases,
artifacts, tests, evidence, and status. No item may disappear silently; each
must be marked inherited, satisfied with evidence, superseded with rationale,
deferred behind an explicit prerequisite, or not_run.

## Product objective and immutable architecture direction

Build a carrier-grade, Rust-language voice communication foundation whose
functional target remains VOS5000-equivalent capability and whose measurable
performance target remains the approved VOS-EQ and 100K profiles. Performance
is the first-order design constraint, but correctness, interoperability,
durability, security, operability, evidence integrity, and feature completeness
are co-equal release gates. Upstream benchmark claims from RustPBX or rvoip may
be used to select development candidates, but never as OPC production evidence.

Freeze and implement one authoritative architecture:

- Unified RustPBX is the single product process and the sole authority for
  business Call, Leg, routing, queue/ACD, billing/CDR, recording control, AI
  control, and telephony lifecycle. SIP control and decoded-media components
  communicate through Rust traits and in-memory typed objects, not internal
  RPC. Horizontally scaled nodes are identical unified nodes.
- Selectively extract and adapt proven low-level rvoip SIP, RTP/RTCP, codec,
  jitter, resampling, and media primitives where they outperform or deepen the
  current implementation. Do not import rvoip's high-level orchestrator,
  product server, client, or a second PBX/Call authority. Do not retain two
  production authorities for parser, transaction, dialog, SDP, RTP, codec
  registry, media session, or call state after migration.
- Kamailio remains the SIP edge, registrar/SBC/routing and protection layer.
  It is not the business Call authority.
- RTPengine remains the ordinary RTP/SRTP relay fast-path baseline and
  performance floor. Its service boundary is allowed. Ordinary relay must not
  enter a decode/mix/AI path. `voice-media-rs`, embedded behind the unified
  Media Engine seam, handles media that must be decoded, transcoded, mixed,
  recorded, analyzed, or streamed to AI. A Rust-native ordinary fast path is an
  optional implementation track, not a second architecture; it may replace
  RTPengine only after identical physical tests prove a material advantage and
  complete operational/security parity.
- LiveKit remains the WebRTC/SFU/large-room authority and a separate runtime.
  Do not absorb browser WebRTC or LiveKit's SFU into rvoip or
  `voice-media-rs`. Integrate it through an explicit gateway/handoff adapter
  owned by the Unified Call Core.
- G.729 is mandatory. There is one external RTP/SDP codec identity,
  `G729/8000`; `G729A` and `G729AB` are mandatory internal processing,
  capacity, and quality modes selected through Annex B negotiation, not two
  RTP, routing, billing, or LCR codecs. Legal/patent review gates distribution
  and runtime enablement where applicable; it must not be used to omit,
  postpone, or fake the engineering implementation and offline verification.

There is one authoritative architecture and one production baseline, but
versioned adapters and shadow backends are permitted during migration. They
must be non-authoritative or selected only for new calls, have bounded lifetime,
and be removed after evidence-backed cutover. Do not promise zero loss,
network Exactly Once, seamless migration, production capacity, or feature
readiness without direct evidence.

## Mandatory first phase: Revision 4 contract freeze and commit

Do not change runtime behavior before this phase is complete. First read
`/private/tmp/opc-ivekit-handoff-2026-07-29.md`,
`/private/tmp/opc-ivekit-runtime-access-2026-07-29.md`, the two supplied
Revision 3 review attachments, root and scoped `AGENTS.md`, `CLAUDE.md`, every
canonical design/ADR/contract/source manifest named by the handoff, the current
dirty diff, and the actual source paths affected by the plan.

Produce Revision 4 by updating, at minimum:

- `docs/design/rvoip-opc-communication-foundation-integration-design.md`
- `docs/adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md`
- `docs/adr/ccaas-5-media-authority-and-rtpengine.md`
- `docs/design/communication-foundation-vos5000-parity-performance-plan.md`
- `docs/capacity/contracts/rvoip-capability-integration-v1.json`
- `docs/capacity/contracts/voice-media-goal4-v1.json`
- the relevant schemas under `docs/capacity/schemas/`
- a new requirements traceability artifact under `docs/capacity/contracts/`
- `docs/superpowers/plans/2026-07-29-unified-voice-foundation-r4.md`

Follow existing repository conventions and modify additional canonical
artifacts when validation proves they are coupled. Do not create a parallel
set of conflicting architecture documents.

Revision 4 must resolve the review findings with implementable contracts:

1. Define Protocol Effect/Receipt fact levels: durable local decision, send
   attempted, transport accepted, protocol observed, failed, and unknown.
   Explicitly reject a network Exactly Once promise. `query_effect` reports
   local WAL/transaction facts; peer receipt is proved only by SIP protocol
   events. Freeze retransmission identity, byte/hash reuse, conflicts,
   retention, reconciliation, and correct ownership of non-2xx versus 2xx ACK.
2. Define the internal preparation order: semantic intent; bounded RFC 3263,
   route, transport, local endpoint and SNI binding; Via/branch/Route/auth
   construction; immutable wire bytes/hash; durable decision; transmit.
   Define when failover reuses an existing transaction and when it creates a
   new lineage-linked protocol attempt. Committed bytes may not be silently
   rewritten.
3. Keep the strong RTPengine Binding Group generation/writer-fence/WAL/query/
   reconcile/atomic-output-gate contract as the production target. Describe
   current upstream capabilities honestly. Until userspace and kernel gates,
   zero-output revoke, crash evidence, and direct notification reconciliation
   pass, atomic active migration is unavailable and status remains not_run.
4. Add a small versioned `BackendCapabilitySet` and fail-closed compiler error
   taxonomy covering allocation, prepare, commit, revoke, fence, query,
   migration, notification, member-flow fencing, zero-output acknowledgement,
   and security termination scope. If backend scope is coarser than an Edge,
   split the Binding Group unless member-flow fencing is proven.
5. Add a recovery eligibility matrix. V1 may claim only confirmed,
   transaction-quiescent SIP dialog takeover. Early dialogs, active INVITE or
   non-INVITE transactions, UAS 2xx awaiting ACK, PRACK/RSeq/RAck, TCP/TLS
   flows, DNS/connect attempts, active timers, and unknown effects require
   explicit failure/retry/drain behavior and may not be called losslessly
   recoverable.
6. State the real single-process fault boundary: bounded overload and ordinary
   worker/shard failures may be isolated while the process survives; OOM,
   abort, undefined behavior, allocator corruption, or process kill interrupts
   all embedded edges. Do not imply address-space isolation.
7. Define durable-store authority, atomic boundaries, setup-path P99/deadline,
   capacity and outage behavior, bounded queues/retries/repair, deterministic
   SIP failure codes and `Retry-After`. Permit `100 Trying` after transaction
   admission and before business durable commit; block 18x/2xx and other
   visible business effects until their durable decision.
8. Add a versioned Edge-to-Core Acceptance Contract covering raw versus
   canonical bytes, common parser accept/reject policy, message limits,
   conflicting or duplicate critical headers, smuggling cases, URI and
   multipart handling, trusted source/transport/TLS metadata, and mandatory
   strip/reinsert rules for external metadata.
9. Add persistent schema registry and N/N+1 reader/writer, rolling upgrade,
   takeover, drain, rollback, migration, retention and GC rules for all durable
   Call/Dialog/Effect/WAL/Media/Binding/Wire/Recovery objects. Reconcile strict
   decoding with an explicit expand-contract policy; never claim arbitrary
   unknown-field compatibility.
10. Add explicit UTC, monotonic, and RTP/media clock domains, including NTP
    jumps, cross-node offsets, deadline reconstruction, RTP wrap, drift/skew,
    resampler correction, and evidence timestamps. Never persist process-local
    `Instant`.
11. Define bounded drain duration, active-zero reconciliation from Unified
    RustPBX, RTPengine and WAL, deletion safety, normal timeout behavior, and a
    separately authorized security-emergency override. Normal timeout must not
    silently force BYE or delete an active old pool.
12. Add a media demand model mapping each `MediaPlan` to decode, encode,
    resample, mix, recording, AI tap, RTP/SRTP, ports, bandwidth, memory, worker,
    CPU and NUMA demand. Extend the existing capacity vector rather than
    inventing a second model.
13. Freeze DTMF authority and transformations across RTP events, SIP INFO,
    in-band detection/generation, decoded media, LiveKit, IVR, recording and AI.
14. Add security advisory ownership/feed, triage and backport SLA, affected
    slice requalification, exact-source identity, key-memory lifecycle,
    zeroization, core-dump/log policy, rekey/ROC/replay behavior, and native/
    unsafe/FFI gates. A slice that cannot be safely requalified remains disabled.
15. Define small audio conference scope, N-1 mixing, participant/admission
    limits, complexity, per-participant jitter/encode, recording tracks and the
    boundary where large rooms stay in LiveKit. Define quality gates including
    PESQ/POLQA or approved equivalent, tandem transcoding, clipping/loudness,
    PLC, DTX/CNG transitions, and long-call clock drift.
16. Keep one architecture profile while recording a versioned runtime
    capability identity/hash for RTPengine userspace, RTPengine kernel, embedded
    processing, and any optional Rust-native fast path.

Also freeze the Voice/SIP↔LiveKit bidirectional handoff contract:

- Unified RustPBX remains the telephony Call and business authority; LiveKit
  remains room, participant, WebRTC and SFU authority.
- Support Voice/SIP/PSTN calls joining or moving to a LiveKit room, LiveKit
  participants originating or transferring to SIP/PSTN, and repeated
  in-call switching in both directions.
- Use one durable idempotent handoff state machine with explicit prepare,
  commit, abort, timeout, rollback, query and reconciliation semantics. Preserve
  the business `interaction_id` and `CallId` while creating and correlating
  `LegId`, SIP Dialog, `bridge_id`, `bridge_generation`, LiveKit room and
  participant identities. A bridge record is an execution binding/receipt, not
  a second Call, Room, CDR, billing or Recording authority. Exactly one
  coordinator owns routing, the authoritative `billing_key`/rating session,
  recording decisions and per-directed-Edge media-writer transitions.
- Define make-before-break only where the single-writer/output-gate contract
  makes it safe. Measure and report switching gap/loss; do not claim
  “seamless” or zero-loss without evidence.
- Freeze codec/transcode/resample behavior, RTP/RTCP and SRTP/DTLS boundaries,
  DTMF mapping, hold/mute/transfer/hangup causes, tenant and token isolation,
  webhook ordering/deduplication, crash recovery, orphan cleanup, recording
  continuity and evidence manifests.
- Ordinary voice must return to the RTPengine fast path after leaving LiveKit
  when no decoded feature remains. Entering or leaving LiveKit must not create
  duplicate CDRs, billing, recordings, participants, ports, or media writers.
- Model bidirectional audio as two directed Media Edges, each with one writer
  per generation. Reuse the existing RustPBX↔livekit-sip↔LiveKit route. LiveKit
  participant duration and SIP-leg duration are usage facts, not independent
  customer invoices. Add explicit participant terminate/delete and orphan
  reconciliation; do not store bridge authority in a recording repository.
- Cover LiveKit unavailable, SIP failure, duplicate/out-of-order events,
  concurrent switch commands, cancellation, Unified RustPBX restart,
  RTPengine failure, long calls and repeated round trips.

Mark the Revision 4 architecture as the accepted target while keeping every
unexecuted Production Eligibility field `false`, `not_run`, or `none`. Run all
document, JSON schema, contract, traceability, link, source-identity and focused
repository tests. Perform an independent review against every Critical,
Important and supplemental finding. Fix all substantiated D0 gaps. Then make
one clean, narrowly staged commit with subject:

`docs(voice): freeze unified foundation revision 4`

Do not stage the pre-existing user-owned dirty files or hunks. Do not push
unless the user explicitly requests it. The successful contract commit is the
authorization checkpoint: immediately continue into implementation without
asking for another confirmation.

## Implementation phases after the contract commit

Before each implementation phase, create or refine a bite-sized TDD plan with
exact files, failing tests, minimal implementation steps, verification commands
and commit boundaries. Use independent subagents only for separable work,
review their results, and keep each production slice reversible.

### U1 — Baseline adapters, semantics and capability compiler

- Freeze current rsipstack/RustPBX behavior behind a `SipFoundation` adapter.
- Implement typed Protocol Effect identity, durable decision/WAL, Receipt,
  `query_effect`, unknown reconciliation, bounded retries and metrics on the
  current adapter before replacing its parser or transaction engine.
- Implement `BackendCapabilitySet`, validation and fail-closed Media Graph/
  Binding Group compilation.
- Add deterministic crash-point, idempotency, schema N/N+1, clock, overload and
  complexity tests.

### U2 — Mandatory G.729 and decoded-media foundation

- Complete exact-source G.729 extraction and immutable source closure.
- Implement and verify G.729A and G.729AB processing under the single
  `G729/8000` wire identity, including static PT 18 and dynamic PT, Annex B,
  SID/no-data, 10–60 ms packetization, encode/decode, PLC/error handling,
  negotiation, transcoding, recording and AI-stream integration.
- Use known vectors, differential tests where legally and technically
  available, fuzz/property tests, long-run tests, quality tests and
  allocation/CPU/packet-loop benchmarks.
- Keep distribution/runtime enablement separately gated; engineering
  completion is mandatory.
- Continue the unified decoded-media graph for G.711, Opus, jitter, PLC,
  resampling and bounded worker sharding without per-packet task spawning,
  global hot-path locks, linear flow scans, or avoidable heap allocation.

U1 and offline U2 work may proceed in parallel after the Revision 4 commit when
their files and state are independent.

### U3 — RTPengine atomic lifecycle and ordinary fast path

- Implement and maintain the exact pinned RTPengine patch stack and source/
  binary/config identity required for blocked prepare, generation, atomic
  userspace and kernel output gates, commit, member-flow fence, revoke,
  zero-output acknowledgement, query, notification, WAL and reconciliation.
- Prove no pre-commit output and no post-revoke output under packet capture,
  retries, timeouts, process crashes, notification loss and restart.
- Preserve the existing ordinary RTPengine fast path and O(1) flow selection.
  Active migration remains disabled until its separate continuity matrix passes.
- Evaluate any Rust-native fast path only against the same hardware, traffic,
  security and evidence profile; do not let it block the production baseline.

### U4 — rvoip SIP foundation migration

- Run the rvoip parser/serializer first as a read-only shadow over the same
  immutable input. Build a security/differential corpus and explain every
  semantic difference.
- Replace parser/serializer independently, then transaction, dialog, SDP,
  transport, RFC 3263 and B2BUA slices through the `SipFoundation` seam.
- Cover OPTIONS/REGISTER; INVITE and non-INVITE; CANCEL; non-2xx and 2xx ACK;
  duplicate/forked 2xx; PRACK/100rel; UPDATE; REFER/Replaces; offerless and
  delayed offer; authentication; UDP/TCP/TLS; NAT/IPv6; connection loss;
  failover; long calls; malformed traffic; and confirmed-only takeover.
- Select a new implementation only when focused interoperability, durability,
  security and performance evidence beats or matches the current baseline.
  Remove the losing duplicate path after drained cutover.

### U5 — Unified media, call and processing slices

- Complete the in-process trait boundaries and one authoritative Call/Leg/
  Dialog/MediaSession/Recording model.
- Integrate selected rvoip RTP/RTCP, jitter, codec and media primitives only
  when independently justified.
- Complete AMR-NB/WB, small audio conference/mixer, T.38, transcoding, quality,
  DTMF, IVR continuity, recorder and AI PCM stream slices with per-slice gates.
- Verify co-resident SIP headroom and failure behavior; do not mistake an
  isolated microbenchmark for unified-node capacity.

### U6 — Voice/SIP↔LiveKit bidirectional switching

- Implement the contract as a Unified Call Core handoff coordinator and a
  narrow LiveKit gateway adapter; reuse the existing LiveKit integration and
  do not reimplement LiveKit, IM, browser WebRTC, or the SFU.
- Implement Voice/SIP/PSTN→LiveKit, LiveKit→Voice/SIP/PSTN, and repeated
  mid-call round trips with deterministic state transitions, idempotent
  commands/effects, rollback and reconciliation.
- Preserve one `CallId`, create explicit legs, correlate room/participant and
  SIP identities, and maintain a single routing owner, billing key/rating
  session, recording authority and writer per directed Media Edge generation.
- Test media/codec negotiation, DTMF, hold/mute/transfer, hangup causes,
  recording segment continuity, tenant isolation, token scope, event
  duplication/reordering, restarts, partial failure, orphan cleanup and return
  to the ordinary RTPengine fast path.
- Measure switch setup latency, media gap/loss, CPU, allocations, port/resource
  leakage and long-run stability. Add a distinct versioned
  `VOICE-LIVEKIT-BRIDGE-V1` workload profile; existing Cell/MIX evidence that
  excluded the optional bridge may not be reused. Enable production use only
  after physical end-to-end evidence with real RustPBX, livekit-sip, LiveKit,
  browser/SIP peers and RTP/SRTP.

### U7 — Recording and evidence plane

- Complete unified recording manifests, spool, checksum/encryption, retention/
  legal-hold controls, recovery, deduplication and evidence identity across
  RustPBX, RTPengine, embedded media, LiveKit, RustDesk and IM where already in
  scope.
- Recording/evidence failure must never create unbounded media backpressure.
- Preserve continuity and a single logical recording lineage across
  Voice↔LiveKit switches without duplicate ownership.

### U8 — Carrier performance, capacity, observability and operations

- Complete kernel/NIC/NUMA/IRQ/RPS/XPS/buffer tuning, worker affinity and
  co-resident headroom validation.
- Compile each versioned workload profile and Media Plan into a
  multidimensional demand vector and admit it against signed supply, N+1 and
  backend-mix constraints.
- Complete bounded-cardinality Prometheus/OpenTelemetry/HOMER/RTCP-XR signals,
  dashboards, alerts, runbooks and failure diagnostics.
- Every hot-path change must be reviewed for asymptotic complexity, global
  locks, per-packet allocation/task creation, cache locality, syscalls, queue
  bounds, retry bounds, label bounds and per-call state. Reject unexplained P99,
  CPU, memory, allocation, packet-loss or scaling-efficiency regressions.

### U9 — Independent load fleet and final acceptance

- Complete an independent caller/callee/SUT load fleet with real RTP/SRTP,
  recording and quality generators, physical clock discipline, fault
  injection, invalid-generator detection, immutable evidence identity and
  three-repeat acceptance.
- Execute the inherited VOS-EQ-5K/10K, 1/2/4/8-node, Cell-20K, single- and
  dual-zone 100K, MIX-100K and 24-hour endurance profiles only when all
  prerequisites and resources exist.
- Final status may be promoted only by the repository finalizer from complete,
  signed, reproducible evidence. Missing servers, carrier accounts, hardware,
  certificates, licensed tools, or other external prerequisites remain
  explicitly `not_run`; never manufacture or extrapolate a pass.

## Global execution and safety requirements

- Preserve bounded queues, bounded retries, bounded label cardinality, bounded
  per-call state, owner epochs/fencing, deterministic cleanup, near-linear
  horizontal scaling and explicit backpressure throughout.
- Use TDD for behavior changes: failing test, observed failure, minimal
  implementation, focused passing test, broader regression, review, then
  commit. Use existing code patterns and avoid speculative frameworks.
- Keep source, patch, binary, image, config, compiler, selector, hardware and
  evidence identities immutable and non-forgeable.
- Do not redesign or reimplement completed IM, LiveKit, RustDesk,
  notification, or existing IVR capabilities except for the narrow verified
  dependencies required by this goal.
- Do not use local Docker. Never touch LED source, configuration, data or
  containers. Use server access, DNS, certificates, accounts and secret-file
  locations only through the restricted runtime index; never display, copy or
  commit secret values.
- Do not delete legacy code merely to make the design look complete. First
  qualify the replacement, move only new calls, drain old calls, reconcile
  active-zero, then remove the losing implementation in a separate commit.
- Make frequent, narrow commits after verified safe slices. Do not stage
  unrelated dirty work. Do not push unless explicitly requested.
- Continue autonomously through documentation, contract commit,
  implementation, focused and broad verification, independent review, and safe
  commits. Pause only for an unavoidable external prerequisite or for new
  authority that would materially expand the scope. When blocked externally,
  complete every independent offline task first and record the remaining gate
  honestly.

The goal is complete only when the Revision 4 contract is committed, all
mapped Goals 1–11 and Voice/SIP↔LiveKit switching engineering slices are
implemented and verified, duplicate authorities are removed after safe drain,
and every production/capacity claim is either backed by signed reproducible
evidence or explicitly remains `not_run` behind a named external prerequisite.
