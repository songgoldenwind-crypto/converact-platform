# ADR-CCAAS-5: Media Authority and rtpengine Fast Path

- Status: Accepted for implementation
- Date: 2026-07-25
- Scope: iveKit voice media plane, Cell placement, recording and capacity evidence
- Supersedes: the recording executor statement in ADR-CCAAS-3
- Runtime verification: Not run

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

The system therefore needs explicit authority boundaries. Without them, both
RustPBX and rtpengine could rewrite SDP, allocate transport endpoints or report
conflicting session state. Recording also needs an authority outside the packet
hot path so an object-storage outage cannot stop established media.

## Decision

### Call and media ownership

RustPBX is authoritative for Call, Leg and Dialog lifecycle, the logical media
graph, routing policy, feature policy, recording intent and insertion of IVR,
transcoding, AI or recording processing hops. A logical media graph describes
which endpoints and processing stages should communicate; it does not allocate
the final network transport.

rtpengine is authoritative for the effective wire SDP and the runtime transport
that the peers actually use. It owns RTP/RTCP port allocation, ICE and DTLS
state, SRTP transport state, packet forwarding counters and the effective
network endpoints for sessions assigned to it. RustPBX must persist both its
logical graph revision and the rtpengine session identity returned by the NG
protocol.

A media processing or transcoding service owns only the runtime state of the
hop inserted into the logical graph, including the SSRC, sequence, timestamp,
DTMF and codec state that it originates. It does not become the Call or Dialog
owner.

The regional recording service is authoritative for the final
`RecordingManifest`, retention state and immutable evidence identity. A Cell
spool owns pending segments only. An uploaded object is not authoritative until
the regional service durably commits its checksum and manifest transition.

This decision supersedes the ADR-CCAAS-3 statement that RustPBX encoded fork is the terminal SIP recording executor.

### Cell and Zone boundary

Normal media is pinned to one Cell and one Zone for the lifetime of a call.
Normal media must not cross Zone merely to balance load. SIP ingress, RustPBX
call control, rtpengine transport and any mandatory processing hop are selected
as one placement decision.

Region cross-Zone state is limited to durable ownership, metadata, recording
manifests, capacity summaries and recovery coordination. A peer Zone may accept
new calls after health and capacity gates pass. It must not take over an active
RTP session by silently changing the transport owner.

If an rtpengine node disappears, affected media may be interrupted. The system
must account for those sessions explicitly; it must not relabel packet loss as
a successful migration. Fast reroute and active-session reconstruction are
separate future capabilities requiring their own evidence.

### Control and fencing

RustPBX controls rtpengine with the NG protocol. Every allocation command must
carry a stable call identity, logical graph revision, owner epoch and idempotency
identity. A stale RustPBX owner may query state but may not mutate a session
after its epoch is fenced.

Offer and answer processing follows this order:

1. RustPBX validates policy and produces the intended logical media graph.
2. RustPBX reserves role-specific capacity for signaling, RTP and required
   processing or recording resources.
3. rtpengine allocates transport and returns the effective wire SDP.
4. RustPBX commits the session binding and only then exposes the SDP to the SIP
   peer.
5. Delete is idempotent; reconciliation resolves partial allocation or commit
   failure by call identity and owner epoch.

The capacity ledger must distinguish RTP fast-path packets, userspace
processing, transcoding slots, recording spool and durable spool. A fast-path
capacity result cannot be used to claim transcoding or recording capacity.

### Recording failure isolation

Recording, upload, OCR, ASR and quality inspection are outside the established
media forwarding hot path. Loss of object storage must not block RTP forwarding
for calls that are already established.

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
- a RustPBX owner failure leaves rtpengine forwarding established packets, but
  fences mutations until ownership is reconciled;
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

Existing calls retain their original transport owner until BYE or timeout.
Mixed old and new sessions are supported only while both exact runtime
identities remain available and independently observable.

## Rollback

Rollback fences new rtpengine allocations and restores RustPBX direct media for
new calls. Existing rtpengine sessions remain on their pinned node until they
end. Active-session migration during rollback is forbidden.

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
