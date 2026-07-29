# ADR-CCAAS-5: Media Plan Authority and RTPengine Default Fast Path

- Status: Accepted for implementation
- Date: 2026-07-25
- Amended: 2026-07-29, Revision 3
- Decision ID: `rvoip-rustpbx-unified-authority-r2`
- Scope: iveKit voice media plane, Cell placement, recording and capacity evidence
- Supersedes: the recording executor statement in ADR-CCAAS-3
- Runtime verification: Not run
- Normative model:
  [`rvoip-opc-communication-foundation-integration-design.md`](../design/rvoip-opc-communication-foundation-integration-design.md)

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
