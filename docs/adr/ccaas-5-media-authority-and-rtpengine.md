# ADR-CCAAS-5: Media Plan Authority and RTPengine Default Fast Path

- Status: Accepted for implementation
- Date: 2026-07-25
- Amended: 2026-07-30, Revision 4
- Decision ID: `rvoip-rustpbx-unified-authority-r2`
- Revision 4 amendment: `unified-voice-foundation-r4`
- Scope: Converact Fabric voice media plane, Cell placement, recording and capacity evidence
- Supersedes: the recording executor statement in ADR-CCAAS-3
- Runtime verification: Not run
- Normative model:
  [`rvoip-converact-communication-foundation-integration-design.md`](../design/rvoip-converact-communication-foundation-integration-design.md)
- Normative Revision 4 contract:
  [`unified-voice-foundation-r4-v1.json`](../capacity/contracts/unified-voice-foundation-r4-v1.json)

## Context

The existing communication foundation lets RustPBX own SIP dialogs, route
decisions and media behavior. That shape is useful for call control, IVR and
media processing, but it makes one process responsible for both high-level call
semantics and high-PPS packet forwarding. The VOS-EQ target requires these
responsibilities to scale independently.

rtpengine `mr26.0.1.13` supports the NG offer/answer/delete/query control
surface, RTP/RTCP relay, kernel forwarding, userspace fallback, ICE bridging,
SRTP, DTLS-SRTP, transcoding and media forking. Its source is pinned in
`docs/capacity/forks/ivekit-forks-v1.json`. Source confirmation is not evidence
that the integration compiles, runs, or reaches a capacity target.

The system therefore needs explicit authority boundaries at directed Media Edge
granularity. Without them, RustPBX, rtpengine and a decode-required Backend
could rewrite SDP, allocate transport endpoints or report conflicting state.
Recording also needs an authority outside the packet hot path so an
object-storage outage cannot stop established media.

## Decision

### Revision 4 execution contract

Revision 4 preserves the authority and packet-path decisions below and makes
their rollout and eligibility semantics explicit. Four facts must never be
collapsed:

| Fact | Meaning |
| --- | --- |
| `current` | Behavior that is present in the exact current source/config and can be located |
| `target` | The only accepted design, which may still be unimplemented or unverified |
| `verification` | Evidence bound to exact source, binary/image, config, workload, hardware and clocks; an unexecuted result is `not_run` |
| `production_eligible` | Every applicable functional, failure, security, quality, capacity, supply-chain and external-environment gate has passed |

Source presence, compilation, a unit test, mock/controlled result, upstream
claim or local microbenchmark does not imply production eligibility. In
particular, the RTPengine atomic lifecycle, active media migration, G.729
interop/quality/capacity, co-resident processing capacity and Voice↔LiveKit
physical profile are targets whose corresponding results remain `not_run`.

Media admission consumes SIP/SDP only after `edge-core-sip-v1` accepts the raw
message and trusted metadata. That contract caps message/header-section/header-
count/header-line/body at 65,535/32,768/128/8,192/32,768, start line/URI at
4,096/2,048, URI parameter/header-component counts at 32/16, and multipart
boundary/depth/parts/part-header/part-body at 70/2/16/8,192/32,768. Conflicting
critical-header duplicates, invalid or ambiguous URI percent/userinfo/host/IPv6
forms, and malformed/ambiguous multipart boundaries fail closed; no parser may
choose an arbitrary first or last value. External internal-metadata headers are
stripped and recreated from the trusted source/transport/TLS/raw-length/raw-
hash/parser-policy allowlist.

Every selectable SIP or media Backend must publish a closed
`BackendCapabilitySet` bound to its source, binary/image and config digest. It
must state the verified granularity of allocation, prepare-blocked, commit,
abort, revoke-zero-output, fence, query, reconcile, migration, security
termination and member-flow isolation. Selection fails closed when any required
capability is false, absent, unknown, `not_run`, stale, bound to a different
runtime identity or coarser than the target Edge/Binding Group. The current
RTPengine atomic binding lifecycle remains `not_present/not_run`; architecture
acceptance does not authorize active migration.

The exact schema is `backend-capability-set-v1@1.0.0`. Each record binds source,
binary/image, config and capability-set digests and closes these required IDs:

| Backend | Allocation/fence scope | Required capability IDs |
| --- | --- | --- |
| `embedded_voice_media` | directed Edge generation | `bounded_processing_session`, `codec_chain`, `rfc4733_dtmf`, `recording_tap`, `ai_tap`, `n_minus_one_mix`, `owner_fence`, `zero_output_revoke` |
| `livekit_sip_bridge` | bridge generation | `bidirectional_bridge`, `participant_lifecycle`, `prepare_blocked`, `zero_output_revoke`, `query_reconcile`, `terminal_tombstone`, `ice_dtls_srtp_bundle_mid` |
| `rtpengine_ordinary` | Binding Group generation | `ordinary_rtp_rtcp`, `srtp`, `wire_sdp`, `prepare_blocked`, `commit`, `revoke_zero_output`, `query_reconcile`, `member_flow_binding`, `dtmf_event_notification` |
| `rust_native_fast_path` | Binding Group generation | `rtp_rtcp_srtp_parity`, `kernel_nic_numa_profile`, `same_hardware_rtpengine_floor`, `failure_isolation`, `endurance_24h` |

The graph compiler accepts a required capability only when
`support=supported && verified=passed` under the exact runtime identity. If
allocation, lifecycle or fence scope is coarser than one directed Edge
generation, the compiler must prove an immutable member set and exact
member-flow fence, split the Binding Group, or fail before any Backend
allocation. It may never silently weaken the required set.

This is an operation-level gate, not an aggregate lifecycle claim. Every
selectable Backend independently publishes `operation_contracts` for exactly
`allocation`, `prepare`, `commit`, `abort`, `revoke`, `fence`, `query`,
`reconcile`, `migration`, `notification`, `member_flow_fence`,
`zero_output_ack` and `security_termination_scope`. For each operation the
compiler requires `support=supported`, `verified=passed`, exact operation
granularity and every declared prerequisite passed. Failure is
`fail_closed_without_side_effect_and_freeze_exact_generation`, with a stable
compiler error of `lifecycle_operation_missing`,
`lifecycle_operation_not_supported`,
`lifecycle_operation_not_verified`,
`lifecycle_operation_granularity_mismatch` or
`lifecycle_operation_prerequisite_unmet`. One passing operation or summary
flag never authorizes another.

Default rollout and rollback change selection for **new Calls only**. Existing
Calls, Protocol Sessions, Edge generations and Binding Groups remain pinned to
their original runtime identity and drain to protocol terminal state. A normal
drain deadline expiring records `drain_timed_out`, keeps new admission disabled
and raises an operator-visible repair condition; it does not force a BYE,
CANCEL or media teardown and does not authorize deleting the old
implementation. Forced termination is a separately authorized emergency action
with explicit scope, cause and receipt. A superseded runtime or schema may be
removed only after Calls, Protocol Sessions, active Edge/group references,
unknown effects and cleanup deltas reconcile to zero and the declared rollback
window has expired.

That zero is a three-authority checked-u64 predicate, not one coordinator's
summary. `unified_rustpbx` must report zero `call_count`,
`protocol_session_count`, `edge_count` and `binding_group_count`; `rtpengine`
must report zero `session_count`, `port_count`, `allocation_count` and
`generation_count`; `effect_wal` must report zero `pending_effect_count`,
`unknown_effect_count`, `repair_delta_count` and `cleanup_delta_count`. Their
receipts must match the exact tenant, drain scope, generation and observation
epoch and carry counter-vector and receipt digests. Missing, stale or mismatched
receipts continue drain. Deletion additionally requires zero retention and
rollback references. A normal timeout never authorizes BYE or deletion;
emergency termination/deletion requires a separate authorization containing
`actor/reason_code/incident_id/scope/expires_at/decision_hash` and an audit
receipt.

G.729 has one external SDP/RTP identity, `G729/8000`. G729A
(`annexb=no`) and G729AB (`annexb=yes`) are two mandatory internal
processing, quality and capacity modes, not two externally negotiable codecs.
Mode-specific codec-pair permits and evidence remain separate without creating
another wire identity. Packetization includes 10/20/30/40/50/60 ms; the 50 ms
case must prove five consecutive 10 ms, 10-octet speech frames and correct RTP
timestamp/sequence behavior.

The Unified RustPBX process reduces RPC and duplicate state, but it is one real
address-space failure domain. Fixed workers/shards, CPU budgets and bounded
queues/pools isolate healthy-process overload; OOM, process abort, undefined
behavior, allocator corruption or an uncaught native failure can interrupt all
embedded decode-required Edges. Ordinary RTPengine continuity after control
process loss is a separate measured fact, not an architectural assumption.

Additional production gates are mandatory:

- UTC wall clock is for durable/audit correlation, monotonic time is for local
  timers/deadlines, and RTP media clocks are for sequence/timestamp/jitter;
  runtime `Instant` is never persisted or reconstructed across processes.
- Any SRTP-terminating Backend must prove key-memory lifetime/zeroization,
  rekey, ROC/replay, core-dump and log-redaction behavior. Every native/unsafe
  slice separately proves ABI, allocator ownership, thread safety, CPU
  features, sanitizer coverage and abort behavior.
- Small audio conference support is a bounded N-1 mixer with an explicit
  participant ceiling and O(N²) admission cost. Large rooms remain on the
  LiveKit SFU.
- `MediaPlanDemand` freezes codec/mode/ptime/direction/security, PPS,
  transcoding, jitter/PLC, conference fan-in/out, recording/tap, AI,
  Voice↔LiveKit, CPU/NUMA/NIC and durable-spool demand before admission.
  Independent codec microbenchmarks cannot authorize a co-resident production
  capacity.

`media-plan-capacity-demand-v1` makes the last rule executable. It compiles
RTP/RTCP flows, SRTP contexts, port pairs, decode/encode/resample/transcode
Edges, mix outputs, recording/AI Edges, packetization, bitrate and NUMA affinity into
RTP/RTCP socket count, SRTP context count, port-pair count, PPS, bps, memory
bytes, CPU microseconds/second, NUMA node and
decode/encode/resample/transcode/mix/record/AI slots. Shared transport is counted once;
all other demand is summed by exact directed Edge and Binding Group generation.
`rtpengine_ordinary` and `rust_native_fast_path` supply only a Wire Transport
Bundle; `embedded_voice_media` supplies the Bundle plus all seven processing
slot classes; `livekit_sip_bridge` supplies the Bundle plus
decode/encode/resample/transcode. Admission atomically reserves all required demand
before Backend prepare and reserves for the declared failure domain. N+1
capacity is peak demand plus the largest failure-domain demand. Missing, stale
or cross-profile supply fails closed.

The admission evaluator also binds `worker_count`, `shard_count`,
`queue_depth`, `service_time_micros` and `backpressure_limit`. Supply is usable
only after its signed identity verifies
`capacity_profile_id/profile_revision/role/backend_source_digest/binary_digest/
config_digest/hardware_profile_id/cell_id/failure_domain_id/issued_at/
expires_at/signature_key_id`, is unexpired and matches the requested units and
runtime identity. For every dimension, checked unsigned arithmetic must prove
`deduplicated_demand <= signed_unexpired_identity_bound_supply -
active_reservations - failure_reserve`; overflow, underflow, negative or
saturating arithmetic rejects admission. Shared transport is deduplicated only
by exact `binding_group_id/binding_group_generation/wire_transport_bundle_id`.
The same dedupe key carrying a different demand vector is
`conflict_fail_closed`; it is never double-counted, overwritten or resolved by
choosing an arbitrary vector.
The reservation CAS binds `capacity_profile_id`, `profile_revision`,
`reservation_epoch` and `available_vector_digest`; its durable receipt binds
tenant, interaction, Media Plan generation, reservation/profile/revision,
demand/failure-reserve vector digests and decision hash before Backend
`prepare`. N+1 separately proves `supply - active reservations - largest
failure domain >= peak admitted demand`; a missing failure-domain identity
rejects admission.

The bounded conference is exactly an eight-participant, per-participant N-1
mixer: `N*(N-1)` directed contributions, `N` participant jitter buffers and
`N` encode outputs. A ninth participant is rejected without disturbing the
active mix or routed to LiveKit. Recording is a separate Edge from the
authoritative mix output, and a membership change creates a new Binding Group
generation. Quality qualification separately measures clipping, loudness,
level normalization, jitter/PLC and the rest of the Revision 4 quality vector;
all unexecuted results remain `not_run`.

Each quality result is independently bound to its declared method: MOS-LQO to
ITU-T P.863 or an explicitly equivalent score; PESQ/POLQA to licensed
P.862/P.863 scoring; packet loss to RTP sequence-gap packet capture; jitter to
RFC 3550 interarrival calculation; PLC to reference/degraded comparison;
clipping to PCM full-scale ratio; loudness to ITU-R BS.1770 LUFS; level
normalization to input/output LUFS delta; tandem quality to codec-chain A/B;
clock drift to RTP-versus-monotonic capture PPM; DTX/CNG to state-transition
continuity; and switch gap to last-old/first-new packet capture. The method
source and digest, quality profile identity, workload source/digest, signed
per-metric threshold binding, and independent-witness evidence digest are all
mandatory. Missing or unsigned input leaves that metric `not_run` and
production-ineligible; no metric inherits another metric's evidence.

Ordinary RFC 4733 acquisition has exactly one no-decode path:
`rtpengine_rfc4733_event_notification` to the RustPBX per-Leg canonical DTMF
Authority. It requires
`rtpengine_ordinary.dtmf_event_notification` with
`support=supported && verified=passed`. The notification binds tenant,
interaction, Leg, SSRC, RTP
timestamp, event, duration, end bit and provider event sequence; those fields
form the dedupe identity and its P99 report budget is 50 ms. A parallel
read-only fork and decode-all of ordinary media are forbidden. Loss or
ambiguity fails closed for business effects and uses query/reconcile.

The notification transport is an authenticated RTPengine event channel using
mutual TLS plus an HMAC-bound payload. It binds Backend instance, Binding Group
generation, tenant, interaction and Leg; authentication failure produces no
business effect. Ordering and a monotonic `event_sequence` are per
tenant/interaction/Leg, with a durable sequence CAS before any business
effect. The queue is bounded to 1,024 entries, each event to 4,096 bytes, and
delivery to a 50 ms deadline. Overflow, sequence gaps or ambiguity freeze the
exact Leg effect and require query/reconcile. An exact duplicate returns the
same receipt without a second effect; the same event identity with a different
payload hash is a conflict. The receipt records event ID/sequence, payload
hash, Backend identity digest and receipt time. Business-effect eligibility
also requires the exact Backend `query` operation to be supported and
verified. This contract is currently `not_run`, so it authorizes no production
DTMF effect.

For WebRTC-bound Bundles, negotiated DTLS setup role and exact fingerprint are
generation-bound and verified before SRTP; changing either creates a new Wire
Transport Bundle generation. ICE ufrag/password and consent freshness are
generation-bound; consent expiry stops output and restart uses new credentials
and a new generation. BUNDLE requires negotiated RTCP mux. Unknown or duplicate
MID demultiplexing is rejected. Payload type is scoped to Leg/binding revision,
and the security context is scoped to Bundle transport/generation.

Security response continuously ingests signed, digest-bound RustSec, OSV,
GitHub Security Advisory and vendor snapshots. Critical/high/medium/low triage
SLAs are 4/24/72/168 hours and remediation SLAs are 24/168/720/2160 hours.
Patches prefer upstream backport followed by cherry-pick. A necessary local
fork is bounded and records owner, expiry and rebase. An overdue issue disables
the affected capability or carries a time-bounded exception, and every affected
slice is requalified. Production core dumps are disabled. The only permitted
crash artifact is a redacted minidump without keys, SDP or media; unredacted
crash upload is forbidden.

LiveKit remains the separate Room/WebRTC Participant/Track,
ICE/DTLS/SRTP/SFU Authority. A Voice↔LiveKit bridge uses the existing
`RustPBX ↔ livekit-sip ↔ LiveKit` path and a pair of directed Media Edges; it
does not transfer Call, Business Dialog, Media Plan, CDR, billing or
RecordingManifest Authority. Its functional, failure and capacity evidence is
signed only under the distinct `VOICE-LIVEKIT-BRIDGE-V1` profile. Ordinary RTP,
LiveKit-only or `optional_bridge_excluded` Cell/MIX results cannot be inherited
by that profile.

The durable schema authority is PostgreSQL-backed
`opc-persistent-schema-registry-v1`, keyed by
`artifact_type/schema_id/schema_version/schema_sha256`; registry outage
forbids a new writer version. Voice↔LiveKit registers five separate durable
artifacts: bridge generation, attempt, command, receipt and tombstone. The
1.0.0/1.1.0 expand-contract proof must show the old reader rejects the new
writer, the new reader accepts the old producer, and the new writer remains
disabled until all live readers support it.
The same registry versions Call Session, Business/Protocol Dialog, Protocol
Effect, Effect WAL, Media Plan, directed Media Edge, Binding Group, Wire
Bundle, Recovery Capsule, root RecordingManifest, recording source chain and
Capacity Vector.

Those thirteen artifacts plus the five Voice↔LiveKit bridge artifacts are
eighteen independent per-artifact contracts, never one aggregate schema gate.
Each records its own `schema_id`, target N=`1.0.0`, target N+1=`1.1.0`, N/N+1
schema hashes, current writer version/identity, reader matrix, takeover matrix,
migration receipt, rollback and garbage-collection references. Until generated
and verified, both hashes and current writer version/identity are `null` and
status is `not_run`. A writer may advance only after a durable registry receipt,
both hashes verify and every live reader is compatible. Rollout is
expand → dual-read/single-write → contract; each object migration is
idempotent with a durable receipt, rollback writes N until N readers drain, and
schema evidence is retained until rollback closure. Garbage collection waits
until no reader, writer, recovery or rollback reference remains.

The same Call must qualify 32 complete alternating
`V2L_ACTIVE -> L2V_ACTIVE` round trips. Every switch creates a new generation.
Concurrent opposite commands have exactly one bridge-head CAS winner; each
loser fails closed and only queries/reconciles the winner. The scenario must
show no monotonic growth in Call/CDR/rating/recording identities or active
participants/ports/allocations and terminal zero participants, port pairs,
Backend allocations, writers, pending commands and unreconciled receipts.

Bridge commands use an asymmetrically signed, pinned-issuer token bound to
tenant, interaction, bridge/generation, operation, idempotency key, issue/
expiry and key identity. Scope matches exactly and checked time requires
`now < expires_at`; pre-prepare expiry creates no command or resource, while
expiry during an active generation only blocks new commands. Cancellation is
generation-ordered, binds command/key/hash, durably writes its tombstone before
ACK, releases without a writer before prepare ACK, and queries/reconciles the
exact generation after apply. Terminal cancel defeats late success and prevents
recreation. Webhooks require a verified signature and pinned provider identity,
bind tenant/interaction/bridge/generation/provider/event/sequence/type/receipt/
payload, persist receipt before effect, and use a maximum reorder window of
128. Exact duplicates replay the same receipt without another effect; identity
or hash conflicts, forged input and out-of-window reorder fail closed and
query/reconcile. All three contracts remain `not_run` and
production-ineligible.

The deterministic 32-round-trip qualification model has exactly one active
generation resource vector: participant/port-pair/Backend-allocation/writer
`1/1/1/1`, with pending-command/unreconciled-receipt `0/0`. Every superseded
generation is explicitly terminal with all six values zero, while the
Call/CDR/billing-session/root-manifest counters remain `1/1/1/1`. CAS losers,
cancellation, invalid/expired tokens and forged webhooks allocate no writer or
resource; repeated final cleanup remains all-zero. This is a target model, not
current physical evidence.

### Call and media ownership

RustPBX is authoritative for Call, Leg and Business Dialog lifecycle, the
Logical Media Graph, routing policy, feature policy and recording intent. Its
Media Engine Facade is the unique Authority that compiles that graph into a
versioned Media Plan, classifies directed Media Edges, selects each Edge
Backend, and commits each Backend binding.

Every Media Edge has a stable Edge ID, source and destination endpoint, plan
revision, binding revision, Backend identity and writer fence. Bidirectional
media is represented as two Edges. Forks, taps and processing chains create
additional Edges. During one binding revision, exactly one Backend instance may
write an Edge. A Backend may aggregate several Edges into a native session for
efficiency, but that does not change the Edge-scoped Authority.

That aggregation is explicit, not an implementation detail. A
`BackendBindingGroup` is the physical Backend lifecycle unit and owns one
`WireTransportBundle`. It records group ID/generation/revision, Backend
instance/native-session key, an immutable member set and digest, admission
receipt, output gate, prepared lease and live-member count. Each member retains
its Edge ID/generation, binding revision, `flow_selector` and writer fence.
RTPengine call/tag/media-section identity and shared bidirectional ports,
effective SDP views, ICE, DTLS, SRTP, SSRC/key-reference state and reservation
live once in the bundle. Raw SRTP keys are not persisted. Each Edge
`WireMediaBinding` references exactly one group generation and flow selector.
The packet path uses a precompiled O(1) selector lookup rather than scanning
members. Releasing an Edge detaches membership; shared resources are deleted
atomically only when live-member count reaches zero. Replacing a complete group
creates a new generation; the old generation remains until its own live-member
count reaches zero.

RTPengine is the long-lived default production Backend for ordinary
RTP/RTCP/SRTP Edges. For each assigned Binding Group, it owns the runtime
RTP/RTCP ports, ICE/DTLS/SRTP state, packet-forwarding counters and effective
network endpoints. It does not own the Call-wide logical SDP or choose the
Media Plan. RustPBX persists the committed Edge-to-group mappings, Wire Media
Bindings, Wire Transport Bundle and RTPengine reservation identity returned by
the NG Adapter.

Phase-one `voice-media-rs` is embedded as a library and fixed worker shards in
the Unified RustPBX Process. It owns only packet/codec/DSP state for
decode-required Edges assigned to it, including SSRC, sequence, timestamp,
DTMF and codec state it originates. It is called through a direct Rust Adapter,
not HTTP/gRPC, and does not become the Call, Business Dialog or Media Plan
owner.

The regional recording service is authoritative for the final
`RecordingManifest`, retention state and immutable evidence identity. A Cell
spool owns pending segments only. An uploaded object is not authoritative until
the regional service durably commits its checksum and manifest transition.

This decision supersedes the ADR-CCAAS-3 statement that RustPBX encoded fork is the terminal SIP recording executor.

### Cell and Zone boundary

Normal media is pinned to one Cell and one Zone for the lifetime of a call.
Normal media must not cross Zone merely to balance load. SIP ingress, RustPBX
call control, the complete Media Plan, RTPengine transport and all mandatory
embedded processing Edge budgets are validated as one placement decision.
Within the Unified RustPBX Process, SIP control and `voice-media-rs` use
separate fixed worker/shard, queue, CPU and memory budgets.

Region cross-Zone state is limited to durable ownership, metadata, recording
manifests, capacity summaries and recovery coordination. A peer Zone may accept
new calls after health and capacity gates pass. It must not take over an active
RTP session by silently changing the transport owner.

If an rtpengine node disappears, affected media may be interrupted. The system
must account for those sessions explicitly; it must not relabel packet loss as
a successful migration. Fast reroute and active-session reconstruction are
separate future capabilities requiring their own evidence.

### Control and fencing

The Media Engine Facade controls RTPengine through a private
`RtpengineBackend` NG Adapter. Every allocation command and receipt must carry a
stable call identity, Media Plan revision, directed Media Edge ID/generation,
Edge binding revision, Binding Group ID/generation, flow selector, Backend
native session identity, Backend identity/instance, member-fence digest, writer
epoch/fence and idempotency identity.
A stale owner or Backend instance may query state but may not mutate or emit
media after its fence is revoked.

Offer and answer processing follows this order:

1. RustPBX validates policy and produces the intended draft Logical Media Graph.
2. The Facade compiles a candidate Media Plan and directed Edges in `O(E)`,
   then forms immutable-generation Binding Groups; Edge/group/member counts
   have hard limits.
3. RustPBX obtains Backend-specific signaling, RTP, processing and recording
   reservations for that candidate plan; each receipt binds the exact
   Backend/source/config and group demand.
4. The Facade atomically prepares every Binding Group as
   `prepared_blocked`; it may reserve/receive/count/drop but cannot emit.
5. Each Backend returns a group-scoped Wire Transport Bundle; Edge receipts
   reference that group instead of duplicating SDP, ports or security state.
6. RustPBX persists the candidate bindings/bundles and attempt/handoff intent.
7. For initial admission, one durable transaction freezes the immutable final
   plan, mappings, reservations/bundles, unique `commit_decision` and
   `commit_pending`; every required group ACKs commit before the plan becomes
   `committed` and initial SDP is exposed.
8. For active migration only, candidate SDP may be exposed while old remains
   the sole writer and new remains `prepared_blocked`. After remote acceptance,
   one durable transaction records the final plan and handoff commit decision;
   old is revoked to a zero-output ACK before new is committed.
9. Before a commit decision, failure aborts prepared groups in reverse order
   then cancels reservations. After a commit decision, it is immutable:
   query/reconcile the exact decision or execute the predeclared compensation
   and finish `compensated_failed`, never relabel it aborted.
10. Edge release detaches membership idempotently. Physical delete is
   group-scoped and atomic only at zero live member references. Whole-group
   replacement creates a new generation and does not waive the old
   generation's zero-reference release precondition.
   Reconciliation resolves partial failure by Edge, group, revisions and
   owner epoch.

For RTPengine, `prepare`, `commit`, `abort`, `revoke`, `query` and `reconcile`
are a required Backend protocol, not labels around ordinary offer/answer:

- `prepare` creates the group already blocked; `offer` followed by
  `block media` is forbidden as a substitute;
- `commit` enables output only after the durable decision and exact
  group/member-fence digest match;
- `abort` releases only a never-committed `prepared_blocked` group;
- `revoke` closes userspace and kernel output gates, drains in-flight sends,
  then ACKs and leaves the group `revoked_receive_only`;
- `query` read-only returns lifecycle, output gate, bundle digest, last command
  identity/hash/receipt and TX watermark;
- `reconcile` is a Facade algorithm that replays the existing durable decision
  without creating a second allocation.

The state machine is:

```text
absent -> prepared_blocked -> active -> revoked_receive_only -> released
prepared_blocked --abort before commit--> released
mutation timeout/disconnect -> unknown -> query/reconcile exact decision
```

Group membership is immutable inside one generation. Changing port, Backend,
membership or writer creates a new generation. `active -> abort`,
`prepared_blocked -> emit`, `unknown -> new allocation` and reactivating a
revoked generation are forbidden.

The current source-locked five-patch fork, including durable replay, does not
implement or prove this atomic lifecycle. If stock NG commands cannot express
it atomically, Goal 2 must add and source-lock the future patch
`rtpengine-ivekit-atomic-binding-lifecycle-v1`; its current status is
`not_present` and verification is `not_run`. The current guard is still
call-id-scoped; the future patch must key commands by
`(binding_group_id, binding_group_generation)` and bind native call/tag/flow
identity plus the member-fence digest. Production evidence must show zero
output before commit, permanent zero old-writer output after revoke ACK, no
abort leak, equivalent userspace/kernel gates and no duplicate allocation after
unknown outcomes.

Active Backend migration is never an in-place flag flip. It creates a new Edge
generation, Binding Group and Binding, performs any required re-INVITE/new
media session, commits the new outbound writer only after fencing the old
writer, and releases the old group atomically. SIP and a remote UA cannot
switch RTP tuples atomically. Before revoke, old remains the sole active writer
while new is prepared/receive-only. After revoke, old may enter a
profile-bounded receive-only grace with source/SSRC/sequence duplicate
suppression, but it may only authenticate/count/drop and cannot forward or
cause DTMF, recording or AI side effects.
Outbound writer overlap and duplicate business side effects remain forbidden.
No zero-loss claim is made: interruption, packet loss/reorder/duplicate and
re-INVITE RTO are measured. New-call selection plus old-call drain is the
default rollout; active migration is exceptional. Signed migration profiles
must bound inbound grace, handoff RTO, writer gap and loss ratio.

The capacity ledger must distinguish RTP fast-path packets, userspace
processing, transcoding slots, recording spool and durable spool. A fast-path
capacity result cannot be used to claim transcoding or recording capacity.

### Recording failure isolation

Recording capture is represented by a separate directed Media Edge. RTPengine
may own an encoded packet-fork Edge; embedded `voice-media-rs` may own a decoded
capture Edge; the Region recording service alone owns the final
`RecordingManifest`, retention and evidence identity. These are distinct facts
and must not be collapsed into one “recording authority”.

Upload, OCR, ASR and quality inspection are outside the established media
forwarding hot path. Loss of object storage must not block RTP forwarding for
calls that are already established.

For mandatory recording, admission fails closed when the recording service or
durable path is unavailable. Existing calls continue media and retain any
already captured pending segments in the bounded Cell spool. Optional recording
may be degraded according to tenant policy. No unbounded queue is allowed in
the RTP path.

rtpengine `recording-method=pcap` and `recording-method=proc` are different
capacity profiles. The pcap method forces userspace forwarding for the recorded
call. The proc method can retain kernel forwarding but has bounded recorder
backlog and packet-loss behavior. Neither result may be merged into the plain
kernel fast-path claim.

## Capacity and evidence rules

`vos-eq-v1-rtp-10k-v1` is a target profile, not a benchmark result. Its 10,000
active calls, 1,000,000 RX PPS and 1,000,000 TX PPS describe the intended test
load. It becomes a capacity claim only after at least three valid repetitions
on the exact declared hardware and exact source identity.

RTPengine userspace forwarding and kernel forwarding are two independent
execution profiles. Each carries its own source, binary, config and
capability-set digests plus hardware profile, NIC driver, kernel-module and
Cell identities. Userspace evidence must include the userspace packet path and
its exact source/binary/config/capability/hardware identity. Kernel evidence
must include the kernel packet path and its exact
source/binary/config/capability/kernel-module/NIC/hardware identity. Both
profiles remain `not_run` and production-ineligible until their own evidence
passes; a userspace result cannot authorize the kernel path, and a kernel
result cannot authorize userspace.

Every attempt, including an invalid attempt, is retained. The finalizer must
reconcile attempted, connected, failed, active and completed counts. Generator
CPU exhaustion, generator packet loss, invalid clocks, incomplete evidence or a
non-zero reconciliation delta produces `invalid_generator_capacity`; it cannot
produce a SUT pass or fail.

P50, P95 and P99 latency, packet loss, jitter, queue depth, CPU, memory, NUMA,
NIC, conntrack and process restart evidence must use the metric contract in
`docs/capacity/contracts/voice-media-metrics-v1.json`. Per-call, tenant, phone
number and IP labels are forbidden in metrics.

## Failure behavior

The machine-readable matrix in
`docs/capacity/contracts/voice-media-goal0-v1.json` is normative. In particular:

- a Kamailio node failure leaves established media untouched and routes new
  calls through a healthy peer;
- a Unified RustPBX process failure leaves ordinary RTPengine Edges forwarding
  established packets in `continue_degraded`, but fences mutations until
  ownership is reconciled;
- the same process failure interrupts embedded decode-required Edges; a mixed
  Call is `interrupt_visible` whenever an interrupted embedded Edge is
  mandatory to its end-to-end chain;
- an embedded worker panic/restart does not stop unrelated ordinary RTPengine
  Edges, but affected processing is `interrupt_visible` and requires bounded
  rebuild/re-INVITE evidence;
- an rtpengine node failure is visible as affected media interruption, never as
  a transparent success;
- recorder or object-storage failure does not stop established media;
- new mandatory-recording calls are rejected while the durable recording path
  is unavailable;
- load-generator exhaustion invalidates the capacity attempt.

## Compatibility and rollout

The first accepted source is rtpengine `mr26.0.1.13` at commit
`506cfa74386a5373e40fca139a932917f22f0524`. Runtime images must record that
commit, archive hash, patch-set hash, kernel module identity and host kernel
identity.

Rollout applies only to new calls:

1. shadow-query rtpengine without returning its SDP;
2. canary new calls in one Cell;
3. all new calls in the Cell;
4. new calls in the Region.

Existing Media Edges retain their original Backend identity until release.
Mixed old and new Backend identities are supported only across different Edges
or Edge generations while both exact runtime identities remain available and
independently observable. They may never write the same Edge generation.

## Rollback

RTPengine is the ordinary-media production baseline, so rollback does not
restore a hidden RustPBX direct-media architecture. A failing candidate Backend
is removed from eligibility for new Edges; existing Edges remain pinned and
drain. New Edges may select another Backend only if that exact implementation
has already passed the same production gates. If no eligible Backend has
capacity, admission fails explicitly.

Rollback is complete only when active sessions reconcile to zero, all attempt
and packet evidence is retained, and the exact RustPBX and rtpengine identities
are recorded. Deleting an rtpengine deployment before its active sessions drain
is not an accepted rollback.

## Consequences

- Call semantics remain concentrated in RustPBX while packet forwarding scales
  independently.
- The architecture can add userspace processing and transcoding nodes without
  weakening the kernel fast-path capacity claim.
- A Region can survive Zone loss for new admissions without making normal
  media cross Zone.
- More identities and counters must be reconciled across RustPBX, rtpengine,
  recording and the load fleet.
- The current implementation is not production eligible until build,
  integration, failure and capacity evidence replace the `not_run` and
  `skeleton` states in the Goal 0 contract.

## Change log

| Revision | Date | Change |
| --- | --- | --- |
| 1 | 2026-07-25 | Established RTPengine fast path, Cell/Zone placement, recording isolation and evidence rules |
| 2 | 2026-07-29 | Made RTPengine the long-lived default ordinary Backend; introduced Media Plan and directed Edge Authority, per-edge fencing, in-process phase-one `voice-media-rs`, and removed rollback to hidden RustPBX direct media |
| 3 | 2026-07-29 | Added Binding Group generation/Wire Transport Bundle physical authority, executable atomic lifecycle, two SDP visibility rules, immutable post-decision reconciliation and co-resident failure/capacity semantics |
| 4 | 2026-07-30 | Bound current/target/verification/production eligibility, fail-closed capability selection, new-call-only drain and active-zero removal, the real single-process fault domain, one G.729 wire identity/two internal modes, clock/security/native/conference/capacity gates, and the separate Voice↔LiveKit authority/profile |
