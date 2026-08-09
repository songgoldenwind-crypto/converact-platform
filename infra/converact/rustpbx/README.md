# Converact Fabric RustPBX image

This directory builds the RustPBX image used by Converact Fabric Voice Foundation.

## Why it exists

RustPBX `0.4.11` uses rsipstack `0.5.18`. The upstream transport cache keeps a
closed outbound TCP connection and the next call to the same SIP target can fail
with `Broken pipe`. The included patch removes only the matching stale connection
and retries one failed TCP transaction send on a new connection.

The build also pins `rustrtc` to `0.3.90`. RustPBX commit `6c49ee76` was written
for that API, while an unconstrained Cargo resolution currently selects `0.3.91`.

## Initial INVITE 100 Trying ownership

The pinned RustPBX `CallModule::handle_invite` remains the early owner of the
initial `100 Trying`; it sends before routing and business admission so a slow
control path does not trigger upstream Timer A retransmissions. The later
rsipstack `ServerInviteDialog` path still invokes the same API, but ivekit.39
makes that second application-level invocation a transaction-owned no-op.

The guard is a private boolean on the exclusively borrowed `Transaction`; it
adds no global lock, scan, task, atomic operation, or allocation to the hot
path. It is committed only after the first send succeeds. SIP protocol
retransmissions remain independent through `respond(last_response)`.

Source-flow review identifies the RustPBX `CallModule` and later
`ServerInviteDialog` calls; the native channel-transport regression proves two
application-level calls on one transaction emit one outbound transport event.
The patched rsipstack library passed all 252 tests at that checkpoint. A
separate native regression proves a failed first transport send can retry on a
replacement connection. The RustPBX full suite, ivekit.42 release image, and
end-to-end durable-admission Retry-After wire propagation remain `not_run`.
Current Timer G/H/I evidence is recorded separately below. The 1,911-test
RustPBX result below remains the ivekit.38 evidence baseline.

## Non-2xx server INVITE lifecycle

ivekit.40 adds the RFC 3261 server-INVITE lifecycle only for final responses
300 through 699. On UDP, Timer G starts at T1, doubles to T2, and replays the
cached post-inspector response without running the inspector again. Timer H
runs for 64*T1 on every transport. An ACK cancels G/H and retains UDP
transactions through Timer I at T4; reliable transports terminate immediately.
Timer H expiry and transport failure have typed observable outcomes. An initial
final-response send failure commits neither the Completed state nor the cached
response: it records `TransportError`, terminates the transaction, and wakes
the transaction owner. INVITE 2xx remains outside this patch and never starts
G/H.

RustPBX retains each applicable transaction owner after module return, routing
rejection, and normal dialog completion. The ordinary path records business
latency and releases its business-concurrency slot before waiting for the SIP
protocol terminal. Max-concurrency rejection uses a separate owner task, still
bounded by rsipstack active-transaction capacity and by the connection/server
cancellation token. The endpoint's capacity-emergency 503 remains the explicit
stateless exception. Timer-H and transport failures increment one bounded
counter keyed only by the fixed cause set; per-transaction detail is debug-only.

The same patch closes the timer worker's head-publication lost-wakeup window by
using a retained Tokio Notify permit for a new or removed head and by avoiding
non-head wakeups. Native evidence on the pinned sources is 264/264 rsipstack
library tests plus two targeted RustPBX owner-retention tests. Docker verification,
the full RustPBX suite, release image, SIPp wire tests, and load/capacity gates
remain `not_run`.

## Bounded SIP wire guard

ivekit.41 adds one allocation-free O(n) validation pass before rsipstack turns
wire headers into owned strings. The scan is capped at 65,535 message bytes,
32,768 header bytes, 8,192 bytes per line, 128 headers and 32,768 body bytes.
It uses fixed counters plus a `u64` singleton-header bitset; there is no global
lock, collection, task or per-header allocation on this path.

Duplicate `Content-Length`, duplicate singleton headers, obsolete folding,
invalid request-URI percent escapes, bare line endings and framed body-length
mismatch fail closed. This deliberately tightens four malformed fixtures that
the ivekit.40 parser accepted; accepted-message semantics must remain identical
and the security change is versioned as `G03-WIRE-SECURITY-001`. The complete
ivekit.41 rsipstack queue applies cleanly and passes 270/270 local native library
tests. Controlled-host dual-binary wire replay, RustPBX image build, SIPp
latency and production eligibility remain `not_run`.

## Inbound REFER wire singleton

ivekit.42 removes an additional untyped `Max-Forwards` header from RustPBX's
inbound REFER transfer origination. rsipstack already creates the required
typed `Max-Forwards: 70`; emitting both values violates the G03 singleton wire
contract and is rejected by the bounded parser. Supplemental INVITE headers are
now absent for a blind transfer and contain only `Replaces` when an attended
transfer needs it, avoiding both the malformed wire message and an unnecessary
header-vector allocation. The focused native REFER test and the complete
RustPBX library suite pass on the controlled candidate source tree (`1913`
passed, `1` ignored); the clean commit-bound build, release image, SIPp and
capacity gates remain `not_run`.

## Bounded protocol and Call-control mailboxes

ivekit.43 replaces production transaction, Dialog, transport, Call actor,
timer, REFER, RWI, WebSocket output and local SipFlow unbounded channels with
fixed-capacity Tokio mailboxes. SIP/Call ingress uses non-blocking admission
and fixed-label rejection counters. Timer delivery may await capacity only in
its existing off-ingress timer task, so timeout semantics are retained without
blocking packet ingress. A full shared UDP transport mailbox drops the current
datagram and continues the listener; a closed mailbox terminates it. Per-
connection transport queues use the lower 256-event ceiling rather than the
8,192-event global ceiling.

Local exact-source evidence is 272/272 rsipstack library tests and 1919 passed
plus 1 ignored RustPBX library test. The `.43` release image, controlled-host
wire/latency/long-call/fault/capacity campaigns and production eligibility
remain `not_run` until requalified against the committed patchset.

ivekit.44 adds the native foundation identity boundary without replacing the
SIP stack. Canonical `CallId`, `LegId`, `ProtocolDialogId`, `TransactionId`,
`MediaSessionId` and `InteractionId` values use the same length-prefixed
SHA-256 derivation as the control plane. Snapshot admission carries an
attested VoiceCall projection reference, placement interaction reference and
the exact provider Call-ID separately; only RustPBX adopts the projection into
the canonical business `CallId`. Positive owner epoch, generation and revision
are mandatory, and a provider-ID mismatch fails admission closed. Runtime
registry and durable SipEffect activation remain separate G03 gates.

ivekit.45 binds the native identity to one bounded active-Call registry. The
provider SIP Call-ID remains a lookup key, while canonical business `CallId`
indexes at most 256 provider legs and each session retains at most 16 canonical
`ProtocolDialogId` values. New-call capacity uses a bounded atomic-counter
reservation with a hard ceiling of 1,000,000; duplicate providers, identity
conflicts and dialog overflow fail closed without replacing the existing owner.
The inbound path returns a final `503 Service Unavailable` with `Retry-After: 1`
after admission failure, and successful callee Dialogs are registered before a
caller-visible 200 response. Registry cleanup and operator listing may scan
bounded control-plane state, but SIP packet and media paths do not. Local
exact-source evidence is 11 focused registry tests and the complete RustPBX
library suite (`1932` passed, `1` ignored). Exact Linux image, SIPp capacity,
crash/restart and durable SipEffect writer gates remain `not_run` for `.45`.

ivekit.46 closes the remaining standalone outbound send-before-authority paths
used by RWI originate, parallel originate, 3PCC transfer and inbound REFER.
Each path now prepares the INVITE without a wire effect, atomically acquires a
bounded active-Call lease plus its initial Dialog index, and only then sends the
INVITE. The lease owns every registry index for its lifetime and rolls them back
on every failed or cancelled handoff. A confirmed Dialog is admitted before an
answered event or transfer bridge becomes visible. Parallel originate transfers
only the selected candidate's lease, Dialog guard, command receiver and media
peer to one owner task; losing candidates tear down through RAII. The owner has
one existing bounded command mailbox and one monotonic hard-lifetime timer, and
adds no periodic registry scan, global lock or unbounded queue.

This patch does not claim the remaining G03 gates. The native Call/Leg state
machine, durable SipEffect writer/replay, add-leg INVITE admission, non-Hangup
commands on standalone transfer owners, real peer transfer-media continuity,
crash/restart and `.46` Linux/image/capacity evidence remain `not_run` until
separately implemented and measured. Local exact-source evidence is 13 focused
registry tests and the complete RustPBX library suite (`1934` passed, `1`
ignored).

ivekit.47 compiles the frozen native Call/Leg transition model into the
RustPBX domain layer. One bounded `NativeCall` owns its canonical Legs,
Protocol Dialog history, fork attempts, selected Leg, dedupe receipts, mailbox
and timers. Every mutation carries tenant/Call/owner/generation/revision
fencing; an identical event replays its original receipt, while conflicting,
stale, invalid or over-capacity work fails without changing the existing Call.
The normal mutation path uses expected O(1) maps, fork selection inspects at
most 32 registered branches, snapshots alone sort bounded Legs, and revision
overflow is checked before mutation. The model creates no task, callback,
global lock, periodic scan or unbounded queue.

This is a compiled native model, not a claim that the live registry already
dispatches every SIP event through it. `G03-E16-NATIVE-AUTHORITY`, the durable
SipEffect writer/replay, active-registry composition, add-Leg admission and
ivekit.47 Linux/image/peer/capacity evidence therefore remain `not_run`. Local
exact-source evidence is 9 focused native-model tests and the complete RustPBX
library suite (`1943` passed, `1` ignored).

ivekit.48 composes that model into the existing `ActiveProxyCallRegistry`;
it does not introduce a second PBX or a parallel business-Call registry. Each
authoritative provider session attaches one deterministic Leg to the single
per-Call `NativeCall`, and initial Protocol Dialog admission updates the same
object before the legacy dialog handle becomes visible. The existing
`providers_by_call` map remains a bounded lookup index, not another state
authority. Same-Call mutations use one synchronous per-Call mutex that is never
held across async work; fresh Call allocation occurs outside DashMap shard
locks, publication retries are bounded to three attempts, and close/removal is
fenced by exact `Arc` identity. Capacity, authority, invalid-direction and
Dialog failures roll back the active slot and all secondary indexes. A poisoned
Call is retained for reconciliation while other Calls remain available.

This is admission and index composition only. The live SIP transition dispatch
and durable SipEffect writer remain `not_run`, so
`G03-E16-NATIVE-AUTHORITY` is not promoted. Native Dialog history is
intentionally retained until later lifecycle events are wired, and the active
counter still counts provider sessions rather than distinct business Calls.
ivekit.48 Linux/image/peer/capacity evidence also remains `not_run`. Local
exact-source evidence is 21 focused registry tests and the complete RustPBX
library suite (`1951` passed, `1` ignored).

ivekit.49 freezes the native SipEffect domain and receipt semantics without
creating another Call authority or enabling a non-durable fallback. The
production build contains no in-memory ledger; its bounded in-memory
conformance oracle is compiled for tests only. Prepared effects validate the
authoritative wire bytes, byte length, adapter/route/attempt hashes,
semantic-intent request hash and composite wire-freeze hash before admission.
Identity and receipt hashing use the same sorted canonical JSON projection as
the TypeScript contract, including decimal-string owner epoch and command
sequence, and fixed cross-language vectors guard byte-for-byte compatibility.
Receipt semantics keep transport `accepted`, protocol `completed` and
reconciliation `state-observed` distinct; stale fences, conflicting receipts,
blind unknown retries, hard capacity and repair-attempt exhaustion fail closed.

This slice is a compiled domain contract, not the durable PostgreSQL writer or
live SIP transition dispatch. Those runtime paths, crash/restart replay and
`G03-E16-NATIVE-AUTHORITY` remain `not_run`; production eligibility is not
promoted. Local exact-source evidence is 7 focused SipEffect tests, a clean
changed-module Clippy pass and the complete RustPBX library suite (`1958`
passed, `1` ignored). ivekit.49 Linux/image/peer/capacity evidence remains
`not_run` until the exact server campaign completes.

ivekit.50 adds the concrete native PostgreSQL SipEffect store's bounded
`prepare` and `query` path. It writes the exact shared schema/writer identity,
wire bytes and identity hashes under the tenant RLS context and elected
`opc_sip_effect_executor` role. Every operation passes a bounded two-stage
admission gate (at most 256 active and 1,024 queued), a 250 ms maximum wait,
bounded SQL timeouts and the database writer-election guard. Pool exhaustion,
timeout, store outage and schema/writer mismatch are typed fail-closed results;
there is no production in-memory fallback, spawned database task or unbounded
queue. SQL is compile-time static, avoiding both a dynamic trust escape and a
per-operation statement allocation.

This slice deliberately stops at durable prepare and query. Receipt transition,
repair claim/reconcile and live SIP dispatch remain `not_run`, so
`G03-E16-NATIVE-AUTHORITY` and production eligibility are not promoted. The
explicit isolated-PostgreSQL pool-recreation test also remains `not_run` until
it is executed against the exact committed server candidate. Local exact-source
evidence is 3 focused admission tests and the complete RustPBX library suite
(`1961` passed, `2` ignored); the new module emits no changed-file Clippy warning.

ivekit.51 adds the native PostgreSQL receipt transition path. One tenant-scoped
transaction locks the exact SipEffect identity, validates schema/writer and
revision fencing, inserts the immutable receipt, advances the effect state and
commits both facts atomically. Exact receipt replay is idempotent; a conflicting
receipt, stale revision, terminal mutation or missing/stale repair fence fails
closed. The SQL remains static and the existing bounded admission gate covers
the whole transaction, so this slice adds no spawned task, unbounded queue or
dynamic hot-path statement construction.

The exact Rust 1.94 Linux candidate passed both isolated PostgreSQL tests for
prepare/query recovery and atomic receipt transitions, followed by a real
PostgreSQL restart. After restart the transition fixture remained
`protocol_observed` at revision 5 with four durable receipts. The exact local
source also passes 10 focused tests plus 2 ignored physical tests and the full
RustPBX library suite (`1961` passed, `3` ignored), with no changed-file Clippy
warning. Repair claim/reconcile, live SIP dispatch, real-peer/long-call/capacity
gates and `G03-E16-NATIVE-AUTHORITY` remain `not_run`; production eligibility
is not promoted.

ivekit.52 adds the native single-effect repair claim and reconcile path. The
claim is one static conditional PostgreSQL update and advances both effect
revision and repair attempt. It requires an unknown effect whose repair time is
due, no live lease, an owner epoch above the durable high-watermark and fewer
than eight attempts. Leases are exact whole milliseconds, greater than zero and
at most 30 seconds. Reconcile first queries the durable state for its caller,
then the existing atomic `apply` transaction independently rechecks the exact
owner ID, epoch, token, claim revision and unexpired database lease before it
can clear the claim or publish a receipt. The query/apply separation therefore
cannot bypass the transactional fence.

The exact Rust 1.94 Linux candidate passed prepare/query, atomic transition and
repair/reconcile tests against isolated PostgreSQL, followed by a PostgreSQL
restart and a separate state query. The repaired effect remained
`protocol_observed` at revision 6 with four receipts; its repair owner/token
were cleared while attempt count 1 and epoch high-watermark 11 remained. Local
Rust 1.94 evidence is 11 focused tests plus 3 physical ignores and the complete
RustPBX library suite (`1962` passed, `4` ignored). The failed fixture and
initial semantic-expectation attempts are preserved with the successful
evidence.

This slice exposes only an explicitly addressed effect. A bounded batch repair
scanner, terminal attempt-exhaustion/operator workflow, live SIP dispatch,
real-peer/long-call/fault/capacity gates and `G03-E16-NATIVE-AUTHORITY` remain
`not_run`; production eligibility is not promoted.

ivekit.53 adds a bounded PostgreSQL repair batch without creating a second
Call or SIP writer. One transaction selects at most 100 due unknown effects in
durable due-time order with `FOR UPDATE SKIP LOCKED`, partitions them in
memory, and uses two static array updates for claimable and exhausted rows.
There is no unbounded scan, per-effect SQL round trip, dynamically constructed
SQL, global lock or packet-path work. Claim tokens, leases, owner epochs,
revisions and the 100-row ceiling are validated before commit.

The eighth unsuccessful repair remains queryable as unknown. The next eligible
batch atomically clears its claim and due time, raises the owner-epoch
high-watermark, records a deterministic exhaustion hash and sets operator
attention. It cannot be claimed again by the automatic path. Controlled Rust
1.94 exact-source evidence is the complete locked library suite (`1964`
passed, `5` ignored) under a 2-CPU/6-GiB limit. The committed lock hash is
`ae2fa0bd8475d2d86e810c2288c52bfa59f3cc72e8fde5433eda173652501a9c`;
the preceding stale lock fails before compilation under `--locked` and its raw
error is retained. The exact Linux candidate separately passed all four
isolated PostgreSQL tests, including batch exhaustion, followed by a real
PostgreSQL restart and separate read-only query.
The exhausted effect remained durable at revision 21 with 11 receipts, attempt
count 8, epoch high-watermark 9, operator attention set and every claim field
cleared. All preceding failed attempts and the pre-Clippy successful candidate
are retained separately; only the final exact-source run is cited as current.

This slice still does not start a repair worker or activate live SIP dispatch.
At its implementation checkpoint, real-peer, raw `100 Trying`, long-call,
fault/OOM, capacity and `G03-E16-NATIVE-AUTHORITY` remained `not_run`. The
following exact-image campaign supersedes only the listed host-evidence status;
it does not activate live Native Authority or promote production eligibility.

The exact `.53` release image was subsequently rebuilt from source commit
`b63383bda16bcd9d311c9ce5e0761877d474797b` on the authorized validation
host as image ID
`sha256:14e51e4f51388c8811e1472426a01840e061ad2ddf639caebe6b0eca4a206eaf`.
Controlled raw evidence now closes only `G03-E06-TRYING`, `G03-E07-WIRE`,
`G03-E11-INTEROP` and `G03-E12-LONG-CALL`: one hundred INVITEs produced
exactly one hundred initial Trying responses at 1 ms p99, all 22 frozen wire
cases matched the versioned contract, ten SIPp scenarios plus an Asterisk 20
peer passed, and one direct-SIP control call ran for 7,201,279 ms with one
successful UAC and UAS call, no failed call or retransmission, exact router/CDR
deltas, no process restart and no residual test container. Both SIPp error
files retain the same reviewed process-exit epoll cleanup warning; it occurred
after the scenario and is not hidden. This is a SIP control soak, not decoded
media, RTPengine, recording or audio-quality evidence.

A separate direct-SIP 2-vCPU regression passed 750, 1,500,
3,000 and 60,000 calls at 50, 100, 200 and 1,000 target CPS; the 1,000-CPS
step delivered 993.542 cumulative CPS with 10/23 ms route p95/p99 and no
failure, retransmission or queue-drop log. That capacity slice deliberately
does not promote `G03-E13-PERFORMANCE`: allocator instrumentation, 2/4/8-core
scaling, saturation, Kamailio, RTP/media and VOS/100K acceptance were not part
of it. Fault/OOM, final review and `G03-E16-NATIVE-AUTHORITY` remain
`not_run`; production eligibility remains false.

ivekit.54 makes the existing active registry the single Native Call/Leg
identity and admission entry point for both owner-attested and standalone SIP
sessions. Owner-attested Calls retain their durable tenant, Call, interaction,
epoch and generation. Compatibility Calls receive a deterministic
`standalone` identity derived from—but never equal to—the opaque provider SIP
Call-ID. Live standalone SIP Calls enter the native identity and admission
authority before their initial Dialog becomes visible. Admission or initial
Dialog failure rolls back every registry index.

This slice deliberately leaves each newly admitted Native Leg in `Planned`.
Ordinary `Ringing`/`Talking` projection updates do not dispatch `StartInvite`
or `Final2xx`: the frozen v1 transition currently models a UAC-side ACK effect
and cannot be applied to an inbound UAS leg without direction-specific intent
and a durable effect executor. Lifecycle event activation remains `not_run`,
preventing a shadow state machine from claiming an effect that the existing
SIP path actually owns.

The added admission path performs expected O(1) keyed lookup and one bounded
per-Call mutation. It starts no task, scans no registry, performs no database
or network operation and never enters the RTP/media path. The exact `.53 +
.54` source combination passes the locked local aarch64 macOS Rust library
suite (`1,967` passed, `0` failed, `5` ignored). The exact Linux build,
physical PostgreSQL cases, real-peer, restart and capacity campaigns are still
`not_run`. Directional lifecycle events, termination/transfer/fork wiring and
the durable SipEffect writer remain `not_run`; consequently
`G03-E16-NATIVE-AUTHORITY` and production eligibility are not promoted.

ivekit.55 adds an optional, application-owned durable egress-effect gate at
the existing rsipstack transaction boundary. When configured, the first
externally visible client request, CANCEL, ACK and application response must
receive a durable permit before transport send; permit failure emits no bytes
and does not advance transaction state. The gate sees the post-inspector SIP
message after canonical `Content-Length` finalization. A synchronous bounded
observer distinguishes transport acceptance from an unknown send result
without putting database work, a spawned task, an unbounded queue or a scan in
rsipstack.

Protocol retransmissions reuse the frozen post-inspector message and do not
request another permit. Initial `100 Trying`, unknown-transaction `481` and
admission-overload `503` remain protocol-emergency paths that deliberately
bypass the application store. The existing public `EndpointInner::new`
signature remains source compatible; only `EndpointBuilder` can opt into the
private gate-aware constructor. Exact canonical wire bytes are not yet carried
by the gate and remain a separate wire-freeze slice.

The exact `.53 + .55` rsipstack source passes its locked local aarch64 macOS
library suite (`279` passed, `0` failed), and the exact `.54` RustPBX plus
`.55` rsipstack combination passes the locked RustPBX library suite (`1,967`
passed, `0` failed, `5` ignored). The runtime PostgreSQL gate adapter remains
`not_run`, as do exact Linux image, physical PostgreSQL restart, crash-window,
real-peer and capacity campaigns for this patchset. No live SIP path activates
the optional gate in this slice, `G03-E16-NATIVE-AUTHORITY` remains `not_run`,
and production eligibility remains false.

ivekit.56 freezes one canonical wire image after the message inspector and
final `Content-Length` update, then gives that same byte slice to both the
durable egress gate and the network transport. UDP uses one datagram payload;
TCP and TLS write the frozen bytes directly; WebSocket validates UTF-8 and
emits the exact image as a SIP text frame. Listener-only handles now fail
closed instead of reporting a false successful send.

The transaction keeps bounded `Arc` references only for its initial request,
CANCEL, ACK and latest successfully sent response. A prepare retry reuses the
frozen CANCEL or ACK, while Timer A, duplicate INVITE and Timer G replay the
same committed bytes without another inspector call, durable decision,
serialization or wire-buffer allocation. The in-memory `Channel` transport
continues to carry a structured message for local tests and is not evidence of
a production network wire path.

The exact `.55 + .56` rsipstack source passes its locked Rust 1.94 aarch64
macOS library suite (`282` passed, `0` failed). The exact `.54` RustPBX plus
`.55 + .56` rsipstack combination passes the locked Rust 1.94 aarch64 macOS
RustPBX library suite (`1,967` passed, `0` failed, `5` ignored). The runtime
PostgreSQL gate adapter, Linux image, physical PostgreSQL restart, crash-window,
real-peer and capacity campaigns remain `not_run` for `.56`; no live SIP path
activates the optional gate, and production eligibility remains false.

ivekit.57 adds the production-compiling RustPBX adapter that can bind the
optional rsipstack egress gate to the existing PostgreSQL SipEffect store. The
adapter is default-disabled: no live endpoint installs it in this slice. A
caller must first register one bounded, owner-leased Native Call semantic intent
for the exact transaction/message binding; missing, conflicting, released or
over-capacity intent fails before store work and emits no SIP bytes. There is no
production in-memory fallback.

The gate persists the exact canonical bytes supplied by rsipstack, their length
and hash, route and attempt facts, and the semantic-intent binding. It advances
the existing ledger through its individually atomic `prepared`,
`durable_decision` and `send_attempted` transitions and returns a transport
permit only for a new, non-replayed `send_attempted` receipt. An ambiguous
post-commit result or an already observed send attempt consumes the intent and
requires query/reconcile; it never authorizes a blind second transmission.

Transport observation performs only expected O(1) keyed removal plus
non-blocking `try_send`. Pending observations are semaphore-bounded, while one
fixed set of hash-sharded bounded queues feeds explicitly supervised store
observers. Queue saturation or an observer/store failure leaves the durable
effect at `send_attempted` for reconciliation instead of blocking the transport
or claiming acceptance. The adapter creates no per-effect task, unbounded queue,
global scan or RTP/media-path database operation.

The exact `.56 + .57` Rust 1.94 aarch64 macOS source passes all ten focused
adapter tests and the complete locked RustPBX library suite (`1977 passed`, `0`
failed, `5 ignored`). The new module has no Clippy warning under Rust 1.94.1;
the pinned upstream tree still has pre-existing warnings outside this patch.
Live endpoint activation, complete registration of every automatic and
application-owned SIP direction, observer/reconcile supervision, exact Linux
image, physical PostgreSQL restart, crash-window, real-peer and capacity work
remain `not_run`. `G03-E16-NATIVE-AUTHORITY` is not promoted, and production
eligibility remains false.

ivekit.58 makes SIP Leg direction part of the Native Call transition key. An
outbound Leg is the local UAC and therefore a received INVITE 2xx requires the
durable local `ACK_2xx` effect. An inbound Leg is the local UAS: its committed
2xx enters `awaiting_ack`, emits no local ACK, and becomes confirmed only after
the remote INVITE-2xx ACK is observed. A local termination requested in that
window enters the distinct `awaiting_ack_terminate` state, defers BYE until the
ACK, and cannot be confused with CANCEL or non-2xx transaction completion.

Inbound pre-final CANCEL, post-2xx CANCEL and remote BYE have separate effect
policies. Outbound non-2xx final responses retain local ACK ownership. Fork
registration and winner selection reject inbound Legs, including mixed-branch
corruption, before mutation. The transition remains one bounded per-Call map
lookup under the existing Call cell; this slice adds no task, queue, global
lock, scan, database call or media-path work.

The v1 machine contract is explicitly revised to `1.1.0` because the former
direction-free `final_2xx -> ack_2xx` row was not valid for a UAS. The native
model and TypeScript conformance reference share the same directional cases.
On the exact local Rust 1.94.1 source, the complete locked RustPBX library suite
passes (`1,980` passed, `0` failed, `5` ignored); the focused Native Call and
registry groups pass `11/11` and `24/24`. The G03 machine-contract suite passes
`9/9`, and the TypeScript directional Call/Leg suite passes `15/15`. Live
endpoint event/effect activation, protocol-completion observation and host
requalification remain `not_run`; `G03-E16-NATIVE-AUTHORITY` and production
eligibility remain unpromoted.

ivekit.59 makes transport and protocol observations separate durable facts.
rsipstack now accepts a protocol-completion receipt only from its private
network-ingress path after exact transaction, CSeq and Dialog matching; local
timeouts have a distinct event and cannot impersonate a peer response or ACK.
The first frozen wire attempt carries the actual datagram destination or a
stable connected-flow identity/generation. Cancellation of any pending
transport future records one bounded `TransportUnknown` observation through an
RAII guard and cannot authorize a second blind send.

RustPBX writes the closed nested wire-attempt v2 facts and keeps a strict v1
reader for draining effects. `transport_completed` is an independent terminal
state for a wire whose frozen policy ends at local transport acceptance; it is
never reported as `protocol_observed`. The PostgreSQL adapter prepares the
effect, durable decision and send attempt in one transaction/one commit, and
applies each transport or protocol observation in one transaction without a
hot-path query-then-apply round trip. Fixed hash shards, separate transport and
protocol semaphores, reserved bounded queue slots and cancellation-safe retry
ownership prevent per-effect tasks, unbounded memory, global scans and dropped
receipts. Database time owns `prepared_at`, `updated_at` and terminal ordering;
caller time supplies only a bounded audit duration.

The exact local Rust 1.94.1 sources pass the rsipstack library suite (`300`
passed) and the RustPBX library suite (`1,998` passed, `7` ignored). The same
RustPBX library suite also passes on the authorized isolated validation host
with the same `1,998`/`7` result. Six physical PostgreSQL cases pass on that
host after migrations through `114`: atomic prepare/replay, receipt transition,
pool reconnect, Unknown fencing/reconcile, bounded repair exhaustion,
`TransportCompleted`, and caller clocks skewed by plus/minus 365 days. These
are exact-source component results, not an exact `.59` release-image or fleet
qualification claim. The controlled raw bundle is
`architecture-foundation/execution/goal-03/evidence/raw/native-protocol-observation-fe4c38b-05/`.

Live endpoint activation, automatic derived ACK intent, automatic
200-to-CANCEL, UAS-Core 2xx ACK ownership, stale nonterminal recovery after an
observer-process crash, rolling mixed-binary activation, exact `.59` image,
real-peer, long-call, fault/OOM and capacity campaigns remain `not_run`.
`G03-E16-NATIVE-AUTHORITY` is not promoted, and production eligibility remains
false.

ivekit.60 adds the first protocol-derived egress path without giving the
transaction layer a second business-intent authority. After an exact peer
300--699 final response completes a permitted client INVITE, rsipstack asks the
durable gate to derive the mandatory non-2xx ACK from the parent permit. The
default trait implementation rejects derivation. RustPBX verifies the parent
tenant and identity hash, INVITE method, transaction key, Via branch, CSeq,
Call-ID, From/To values, exact trigger and ACK bytes, transport binding and
closed v2 completion scope before preparing the child.

The parent INVITE owns one stable derived-child Effect identity. Retransmission
variants bind different trigger/child hashes to that same identity and therefore
conflict rather than create another wire permit. The PostgreSQL adapter locks
the parent and prepares the child decision/send attempt in one tenant-scoped
transaction. Cancellation arms a reconciliation latch before the first await;
preparation or transport ambiguity cannot fall back to ordinary `prepare` or
blindly send another ACK. A parent in `unknown` is rejected until the existing
repair/reconciliation path has established a stronger state.

On the final exact Rust 1.94.1 sources, local component suites pass rsipstack
`302/302` and RustPBX `2,002` passed, `0` failed, `8` ignored. The authorized
validation server reproduced those results in isolated current-code containers,
and the explicit physical PostgreSQL atomic-derived-ACK case passed `1/1`.
These are exact-source component results; they do not prove live SIP endpoint
composition, a release image, peer traffic, long-call stability, fault/OOM or
capacity. The retained raw bundle is
`architecture-foundation/execution/goal-03/evidence/raw/derived-non-2xx-ack-9fc99ee-06/`.

Automatic 200-to-CANCEL, UAS-Core 2xx ACK ownership, stale nonterminal recovery
after an observer-process crash, parent-Unknown reconciliation wiring, rolling
mixed-binary activation, exact `.60` image, real-peer, long-call, fault/OOM and
capacity campaigns remain `not_run`. Live endpoint activation remains
`not_run`; `G03-E15-REVIEW` and `G03-E16-NATIVE-AUTHORITY` are not promoted, and
production eligibility remains false.

ivekit.61 seals the source of a peer protocol observation. A network
`TransactionEvent::Received` carries an opaque `PeerIngressProof` minted only
inside the private Endpoint transport-ingress path. Client responses and server
ACKs cannot be injected through the public transaction sender without that
proof, and external code cannot call the Endpoint ingress function or replace
the receiver. Server-dialog forwarding consumes the proof once. The proof is a
zero-sized value; the path adds no heap allocation, global map, global lock or
per-message task.

On the final exact Rust 1.94.1 sources, the authorized validation server passed
rsipstack `303/303` library tests and `67/67` compile-fail/doctests, followed by
the complete RustPBX library suite with `2,002` passed, `0` failed and `8`
ignored. The retained raw bundle is
`architecture-foundation/execution/goal-03/evidence/raw/peer-ingress-proof-701475a-07/`.
This is component evidence only: no release image was built or deployed and no
old server service, container, database or source was deleted or changed.

The proof does not yet carry an independently verified transport flow
generation into the durable receipt, and the default-disabled gate is not wired
through a live RustPBX Endpoint. UAS-Core 2xx ACK ownership, stale nonterminal
recovery, mixed-binary activation, real-peer, long-call, fault/OOM and capacity
campaigns remain `not_run`.
`G03-E15-REVIEW`, `G03-E16-NATIVE-AUTHORITY` and production eligibility remain
unpromoted.

ivekit.62 adds the matched server-INVITE CANCEL direction without making the
transaction layer a business-intent authority. Call Core must pre-register one
bounded `ServerInviteCancelOk` capability against the exact server transaction.
Only an opaque Endpoint peer-ingress proof can trigger it. RustPBX consumes that
capability once, verifies the CANCEL transaction key, CSeq, Call-ID, From, top
Via, To URI/tag relationship, exact finalized 200 response bytes and actual
transport binding, then uses the existing atomic durable prepare-for-send path.
An absent capability or mismatched trigger emits no bytes. A commit-ACK or
transport ambiguity consumes the capability and latches reconciliation instead
of authorizing another response.

The first successful 200 response freezes both message and bytes; a duplicate
CANCEL reuses that image without another durable prepare. The response reuses
the transaction's stable To-tag or generates it once and writes it back to the
original INVITE, so a later 487 and all retransmissions retain one dialog
lineage. Transport acceptance terminates this response as
`transport_completed`; it is never reported as peer `protocol_observed`.
Cancellation-safe RAII records `TransportUnknown` exactly once. The existing
fixed-shard semaphores, reserved queues and shared intent ceiling bound all new
work; this slice adds no task, global scan, unbounded channel or media-path work.

Local Rust 1.94.1 component tests pass the complete rsipstack library suite
(`306/306`) and the full RustPBX durable-gate group (`31/31`). Current `.62`
server suites, a real Call Core capability holder, live Endpoint composition,
restart/reconcile resumption, exact release image, real-peer, long-call,
fault/OOM and capacity qualification remain `not_run`. These component tests do
not inherit older release-image or capacity evidence; production eligibility
remains false.

RustPBX `0.4.11` returns AMI dialogs without identifiers. The Converact Fabric AMI patch
adds the SIP `call_id`/`dialog_id` and active-call registry entries so a timed-out
RWI originate can be reconciled by the deterministic `call_id` supplied by the
client. The endpoint remains protected by the existing AMI authentication and
network allowlist.

The upstream RWI originate command handler only cancelled its task after
`call.hangup`; it did not terminate the established SIP dialog. The Converact Fabric RWI
hangup patch sends CANCEL before answer and BYE after answer, so a successful
hangup command also clears the downstream SIP leg.

The Converact Fabric route snapshot patch removes the per-INVITE control-plane HTTP and
PostgreSQL lookup from the configured RustPBX data path. A sidecar publishes a
signed, short-lived snapshot by atomic rename. RustPBX verifies the signature,
tenant/profile identity, sequence and expiry, derives the same tenant-scoped
voice-address lookup key as Converact Fabric, and performs one HMAC plus an in-memory map
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
The request declares the receiving RustPBX Cell and node. Converact Fabric
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

The HTTP-capacity patch keeps DNS and connection establishment from becoming a
second signaling bottleneck. Reqwest uses its asynchronous Hickory resolver,
dynamic call routing and CDR delivery use the same keepalive client policy, and
the pool retains up to 64 idle connections per host. The concurrency limit still
comes from the bounded call-record runtime; the larger pool avoids serial
connection churn but does not create unbounded HTTP work.

Converact Fabric sends owner contracts in the RWI envelope's internal `converact_owners`
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

The lookup root must equal Converact Fabric's `CONVERACT_FABRIC_VOICE_ADDRESS_HMAC_KEY`. The
snapshot signing key must be a distinct random 32-byte canonical base64 secret.

## Recording spool

Converact Fabric recording mode is enabled with
`IVEKIT_RUSTPBX_RECORDING_SPOOL_ENABLED=true`. RustPBX writes bounded local
segments under `IVEKIT_RUSTPBX_RECORDING_SPOOL_DIR`; it never uploads from the
RTP or recorder sample path. Region, Zone, Cell and owner-node identity are
required and become part of every immutable segment manifest.

The separate `converact-rustpbx-recording-spool` process validates stable regular
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
retries that marker until Converact Fabric confirms that sequences `1..N` all exist and
are uploaded, then removes the local indexes and marker. A missing segment can
therefore delay finalization but cannot be silently skipped.

## Goal 3 media orchestration and rolling rollback

Ordinary relay, T1 shadow, IVR/transcoding, recording, and AI audio tap use
separate admission profiles and capacity dimensions. Ordinary relay uses the
bounded media-control semaphore and response limit. Recording uses its own
non-blocking capture queue, lifecycle executor, spool waterline, and uploader
resources. AI tap uses a separate bounded Unix-socket channel and gateway
resources. Exhausting recording or AI tap capacity degrades only that optional
profile; it does not make the ordinary relay profile or an established RTP
session unavailable.

The component-node operational endpoint combines the current Cell lease and
recovery state with the signed route snapshot, node-local media-control
readiness, and required profile capacity, but deliberately ignores the current
admission state. Capacity projection uses that endpoint so a cold Cell can
observe the node before authorizing new calls. The readiness endpoint adds the
accepting/degraded admission requirement. Liveness remains process-local and
does not depend on object storage, recording, ASR, translation, or other
external providers. Prometheus exposes explicit route drain separately from a
temporary recovery drain and scrapes both RustPBX management and component-node
media-profile metrics. Metric labels are bounded to operational enums such as
`failure_stage` and `profile`; they never contain tenant IDs, call IDs, numbers,
SDP, tokens, or certificate material.

The Goal 3 rolling rollback contract is:

1. Set the selected RustPBX Pod to draining through component-node admission.
   Kamailio observes that state and removes the Pod's new-call weight.
2. Wait for route propagation, then block new local reservations and wait for
   reserved/active dialog checkpoints to reach zero before replacing the Pod.
   Existing RTPengine sessions remain authoritative while the owner drains.
3. Roll back one RustPBX/media-control Pod at a time under the PDB and
   cross-Zone topology constraints, using the previous immutable image digest
   and matching configuration identity.
4. A rollback must not restart the entire Cell RTPengine. RTPengine replacement,
   when independently required, is drained and rolled one media node at a time.
5. If drain times out, stop the rollout and preserve the Pod and evidence. Do
   not force a Cell-wide restart or convert an uncertain media command into a
   successful result.

RustPBX media-control requests carry a W3C `traceparent` generated without the
raw call identifier. All commands for one call share a deterministic SHA-256
trace identifier and receive distinct command span identifiers. Sampling is
deterministic and configured by
`IVEKIT_RUSTPBX_MEDIA_CONTROL_TRACE_SAMPLE_RATIO`; the deployment default is
`0.01`. The patch does not add SDP, number, authorization, token, or certificate
data to logs or trace headers and does not modify RTP packet forwarding.

The co-located media-control process can export its own bounded OpenTelemetry
spans through `CONVERACT_OTEL_*`. Export is disabled by default and, when enabled,
uses explicit queue, batch, delay, timeout, endpoint, and sample-ratio limits.
The exact ivekit.38 patch queue applies, its release-scope Rust files pass
Rustfmt, and a clean fixed-source replay passes all 1,911 RustPBX library tests
with one infrastructure-dependent IVR/queue test explicitly ignored. The
rsipstack prepared-INVITE and rejection-header tests also pass from their
pinned source. Image build, multi-Pod trace continuity, server-side real RTP,
and an enabled-versus-disabled overhead comparison remain `not_run`.

### Existing IVR application processing contract

ivekit.39 does not introduce a second IVR engine. RustPBX remains authoritative
for the existing `ivr` application's flow graph, provider calls, menu state,
timeouts, transfers, queue handoff, and Call/Leg/Dialog state. Only the
media-execution part of that existing application is delegated to the
`voice-media-rs` processing pool when the immutable per-session profile selects
processing media.

The caller answer follows an owner-fenced two-command transaction:

1. RustPBX prepares the processing session with the caller offer and the frozen
   codec, payload type, ptime, Cell, node, owner epoch, and command sequence.
2. RustPBX commits `commit_single_leg` and returns the processing pool's exact
   caller-facing SDP. No fake callee leg is created.
3. The worker consumes caller RTP for RFC 4733, SIP INFO, barge-in, gather, and
   prompt timing while permanently suppressing the unused B-leg egress and
   transcoding path.
4. Existing IVR play, gather, stop, timeout, DTMF, and terminal events use the
   same owner fence. Terminal events enter the durable event handoff before
   source acknowledgement.
5. Preparation or commit failure rejects the call rather than silently
   switching to local media or bypass relay.

Conference, voicemail, queue, WebRTC, recording, audio-tap, offerless, explicit
bypass, and non-IVR application paths retain their previous local or relay
media behavior. The clean replay regression covers the original IVR parser,
menus, TTS, DTMF, transfer, queue fallback, real playback, SIP dialog, and
dual-leg media tests in the same 1,911-test run. Real server RTP, process
restart, overload, and signed processing-capacity results remain `not_run`.

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
prefix. Compose, the Converact Platform Helm chart, and the standalone Converact Fabric Helm chart carry
the same defaults. Both charts expose `/metrics`; optional ServiceMonitor and
PrometheusRule resources alert before a hard limit and on any overload
rejection. Metrics contain no tenant, call, interaction, or phone-number labels.

## Call-record persistence isolation

Converact Fabric sends CDRs to its authenticated HTTP endpoint and disables RustPBX's
second direct database write with `persist_to_database = false`. The upstream
default remains `true`, so deployments that do not use Converact Fabric keep their
original persistence behavior. HTTP saver execution remains asynchronous and
does not block SIP or RTP processing.

`RUSTPBX_CALL_RECORD_MAX_CONCURRENT` maps to `callrecord.max_concurrent`,
defaults to 64, and accepts 1 through 4096. It bounds concurrent CDR saver
tasks. A 256-task setting exhausted the shared Router on the controlled
four-vCPU baseline, while 64 preserved exact INVITE and CDR parity at 1,400
CPS. `RUSTPBX_CALL_RECORD_CHANNEL_CAPACITY` maps to
`callrecord.channel_capacity`, defaults to 65,536, and accepts 1 through
262,144. It bounds the queued CDR backlog; increasing it consumes more memory
and cannot repair a persistently unavailable downstream endpoint.

`RUSTPBX_CALL_RECORD_WORKER_THREADS` maps to `callrecord.worker_threads`,
defaults to 1, and accepts 1 through 16. The patched runtime executes the
CallRecordManager on these dedicated threads, so CDR HTTP, database, object
storage and hook latency cannot consume SIP transaction workers. The queue
remains bounded and its producer remains non-blocking; sink failure may delay
or eventually drop CDR delivery, but it must not stall an active call.

Sink failures increment
`rustpbx_call_record_sink_failures_total{stage="save|hook"}`. The stage set is
fixed and contains no tenant, call or endpoint labels. Warning output is shared
across sinks and limited to one line every five seconds, preventing a failed
endpoint from producing one log line per CDR.

Compose and both Helm surfaces carry the same defaults. Capacity profiles may
override them only after measuring CDR endpoint latency, queue saturation,
memory growth and recovery while active media remains unaffected.

The exact rsipstack and RustPBX patch queues apply cleanly to their pinned
commits and the rsipstack tree passes Rustfmt. The exact ivekit.16 amd64 Linux
image was built on the controlled four-vCPU server. Its strict 1,400-CPS
signaling run completed 42,000 of 42,000 calls with zero failures, zero
remaining calls, zero retransmissions and exact Router/CDR parity. A CDR-sink
outage run completed the same 42,000 calls with exact Router parity, zero CDR
delivery, no queue drops and seven rate-limited warning lines over 30 seconds.
The outage runner reports failure by design because its CDR parity and drain
checks cannot pass.

The same shared-host topology did not pass the strict 1,500-CPS boundary: 20
calls remained active and Router/CDR counts exceeded the target by four. Treat
1,400 CPS as the controlled signaling baseline for this hardware. It does not
prove RTP, PSTN, WSS, sustained recovery, Cell-10K or MIX-100K capacity.

The exact ivekit.18 amd64 Linux image adds asynchronous DNS and the shared
64-idle-connection HTTP policy. On the same controlled four-vCPU host, a
60-second direct RustPBX run at 1,000 target CPS completed 60,000 of 60,000
calls with zero failures, remaining calls, retransmissions, or queue drops;
Router and CDR deltas were both exactly 60,000, with SIP route P95/P99 of
3/5 ms. The full SIPp -> Kamailio -> RustPBX run also completed 60,000 of
60,000 with exact Kamailio/Router/CDR parity, zero retransmissions, and route
P95/P99 of 8/19 ms. These are sustained signaling regression gates, not a new
maximum-CPS claim. See
`docs/evidence/wave3-rustpbx-kamailio-sip-capacity-server-validation-2026-07-24.md`.

## RTP UDP socket capacity

The ivekit.19 and later images pin `rustrtc` commit
`166c6d22984429eb6b509920c14fcd69f974f0b3` and applies the UDP socket
capacity patch before building RustPBX. RTP and direct RTCP sockets use
non-blocking `socket2` creation and may request explicit kernel buffers:

- `RUSTRTC_UDP_RECEIVE_BUFFER_BYTES`
- `RUSTRTC_UDP_SEND_BUFFER_BYTES`

Unset values preserve the operating-system default. Configured values must be
between 65,536 and 16,777,216 bytes. Linux commonly reports an effective value
larger than the request because it includes kernel accounting overhead. The
limit is not pre-allocated per socket, but it is a permitted queue ceiling:
raising it increases the amount of packet memory that a stalled media worker
can retain. Admission limits and pod memory budgets must therefore be tuned
together with the socket values.

The controlled media baseline requests a 1 MiB receive buffer and 512 KiB send
buffer. These values absorb short scheduler stalls; they do not compensate for
sustained CPU saturation or an undersized media worker topology. Every
capacity run gates Linux `RcvbufErrors`, `SndbufErrors`, `InErrors`, SIP
reconciliation and expected RTP datagram coverage.

Shared-host SIPp evidence can prove a controlled regression but cannot assign
the combined host's saturation boundary to RustPBX. A production capacity
claim requires an independent load generator, separate resource telemetry,
strict packet-sequence evidence below the throughput frontier, and a zero
kernel-drop throughput staircase at the claimed point.

## Recording media hot path

The Converact Fabric media patch removes recorder codec conversion, mixing, flushing and
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
latency and spool uploader backpressure. The complete patch queue compiles in
the exact ivekit.16 amd64 Linux image and the no-PSTN SIPp signaling suite
passes; RTP packet continuity, a real object-store outage/resume drill and
overflow recovery remain `not_run`.

The Rust unit gate `test_recording_stop_does_not_block_engine_on_busy_recorder`
holds the recorder write lock while StopRecording and PauseRecording are sent;
the pause event must still arrive within 250 ms. This proves command-loop lock
isolation, not physical RTP continuity or stalled-filesystem behavior.

## Realtime speech audio tap

The realtime audio tap is an opt-in, per-session speech fork for streaming ASR,
translation and voice-agent Providers. RustPBX accepts the
`x-ivekit-audio-tap-token` only from the trusted HTTP router result stored in
`dialplan.routed_headers`; an untrusted inbound SIP header cannot enable the
tap. Dynamic routing returns the token as an internal route header, while
snapshot routing receives it from authenticated inbound admission and injects
the same trusted header. The opaque token is sent once in the local
session-start message and must
be verified by the co-located gateway against tenant, interaction, participant,
purpose, consent, expiry and nonce.

The forwarding path shares the existing `Arc<MediaSample>` and calls only
`try_send` on a bounded per-session channel. A full or closed channel drops the
auxiliary copy and increments a low-cardinality counter; it never waits on the
gateway or a Provider. Codec decoding and resampling run in the asynchronous tap
worker after the media handoff. Negotiated caller and callee speech is emitted
as mono PCM16 at 16 kHz. Telephone-event payloads are excluded, codec profiles
are updated after re-INVITE, and enabling the tap disables the raw RTP transport
shortcut that would otherwise bypass the depacketized media track.

Configure the RustPBX TOML fields only when the local gateway is present:

| TOML field | Default | Valid range |
| --- | --- | --- |
| `realtime_audio_tap_socket_path` | unset/disabled | absolute Unix socket path, at most 100 bytes |
| `realtime_audio_tap_channel_capacity` | `256` | 1 through 65,536 |
| `realtime_audio_tap_send_timeout_ms` | `10` | 1 through 1,000 ms |

The local stream protocol prefixes every message with a four-byte big-endian
length, then uses `IATJ` JSON start/end controls or an `IAT1` 48-byte binary PCM
header. The PCM header carries protocol version, leg,
session-key digest, sequence, capture timestamp, sample rate and sample count.
No tenant identifier, phone number or authorization token appears in per-frame
payloads. Socket creation, connection, send, decode or gateway failure may
disable or degrade realtime intelligence, but it cannot terminate the SIP
dialog or block RTP forwarding.

The exact ivekit.17 source passes `cargo check --locked` and ten focused Rust
tests on the controlled amd64 Linux server. Those tests cover authorization,
snapshot token propagation and validation, envelope bounds,
PCMU-to-16-kHz normalization and both forwarding implementations under a full
tap queue. The Node gateway token, nonce replay and real Unix socket contract
tests also pass. Cross-process RustPBX RTP capture, external Provider streaming
and physical capacity remain `not_run`.

## Session teardown isolation

The Converact Fabric cleanup patch removes the last session-destruction waits from the
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
Exact patch replay, static contracts, and the ivekit.16 amd64 Linux image build
pass; real blocked-filesystem injection, RTP continuity, and process-level fault
recovery remain `not_run`.

## WebPhone pre-authentication registry

The upstream WebSocket pre-authentication registry serializes all registrations,
lookups and removals through one `Mutex<Vec<_>>`. Once 256 entries exist, every
new registration also scans the full vector and removes entries older than five
minutes, including live long-running WebPhone connections. That makes lookup
O(n), creates one global lock hot spot and can revoke an active connection.

The Converact Fabric WebPhone registry patch replaces that vector with an O(1) keyed
`RwLock<HashMap<SipAddr, _>>`. Registration returns a connection-lifetime guard;
normal completion, cancellation and panic drop the guard and remove only its
generation. A stale guard cannot delete a newer connection that reused the same
address. The embedded Rust tests cover replacement fencing, explicit removal,
guard cleanup and 10,000 simultaneous keyed entries. Patch application,
formatting, and the ivekit.16 amd64 Linux image build pass on the exact upstream
commit; runtime WSS load remains `not_run`.

## VOICE-HA-T1 dialog recovery

The ivekit.27 patch set keeps RustPBX authoritative for Call, Leg, Dialog and
the logical media graph while RTPengine remains authoritative for effective
wire SDP, ports and transport runtime. A confirmed T1 B2BUA session stores two
reciprocal, bounded AES-256-GCM recovery capsules. The shadow service commits
the caller and callee records as one hash-bound WAL and JetStream operation
before exposing a state-changing SIP success.

A replacement owner may claim a higher epoch only through the cell-local
takeover coordinator. The claim requires a complete, non-terminal T1 pair from
two RustPBX fault domains and returns a single-use token. The new owner prepares
both restored records, reconciles the existing RTPengine reservation, commits
the pair under the new epoch, consumes the token and only then becomes the
active mutation authority. Unknown token-consume outcomes are resolved through
the authoritative owner endpoint; they are never guessed or replayed as a new
mutation.

The recovered controller serializes both dialog receivers. It relays INFO,
OPTIONS, NOTIFY, REFER, MESSAGE and PUBLISH, runs re-INVITE and UPDATE through
the restored media lifecycle, atomically advances both shadow records, strips
hop, dialog, authentication and recovery identity headers, and bounds terminal
BYE, media delete and owner cleanup. Its event queue is bounded at 64 entries;
a terminal event waits at most 100 ms for queue admission. Any unknown shadow
write or required reconciliation freezes the recovered controller instead of
issuing another mutation. Normal session cleanup commits both legs as one
recoverable terminal pair and duplicate cleanup is a no-op. Successful INVITE
and UPDATE responses also refresh the rsipstack remote target from their unique
Contact before the next in-dialog request is created.

Dialog recovery is opt-in. Compose enables the complete dual-owner voice stack
and both node-local sidecars through the self-contained `voice-t1` profile; no
second profile is required to satisfy its local dependency graph. Helm requires
persistent WAL, mounted service/recovery secrets, TLS-only NATS, a three- or
five-node cross-fault-domain stream and a per-Pod CSI client identity whose URI
SAN matches the RustPBX owner. Projected secret targets may be `0400`, `0600`,
`0440` or `0640`: owner read is mandatory, group read is allowed for the
constrained Pod `fsGroup`, and group write/execute or any world permission is
rejected. Kubernetes atomic-writer symlinks are accepted only when their
canonical targets remain inside the mounted secret directory. The agent listens
only on `127.0.0.1:3212`; ordinary voice profiles do not wait for the shadow
service, NATS or PostgreSQL.

The exact clean-source ivekit.27 queue applies all 28 patches and passes locked
library compilation, 19 Rust recovery contract tests, four recovered-media
takeover tests and the complete 247-test rsipstack library suite. The standalone
source graph also builds the packaged dialog-shadow executable. This is code and
reproducibility evidence only. Physical dual-node failover, real RTP continuity,
three-node JetStream fault domains, Kubernetes CSI identity mounting and the
five-second takeover RTO remain `not_run`.

## Dual-leg CDR durable convergence

The ivekit.28 queue adds an owner-fenced dual-leg terminal CDR without changing
the RTP forwarding path. Caller and callee outcomes are derived independently;
one leg cannot copy the other leg's final SIP code, hangup cause, timing or
media result. Each leg carries a hashed dialog identity, direction, reservation
reference, owner epoch and exact route-snapshot revision. Call-level state
records the real winning branch, early media, transfer chain and media timeout.

RustPBX writes only `pending_unacknowledged` records to its per-owner persistent
spool. A dedicated writer has a hard queue limit of 4096 records and acknowledges
the terminal call path only after file sync, atomic rename and directory sync;
the normal path performs those syscalls on the dedicated thread. Startup creates
and verifies this writer before readiness can admit calls. Queue saturation
marks admission unhealthy and immediately fences future calls without marking a
working spool unhealthy or cancelling terminal persistence for existing calls.
Full-queue producers apply bounded backpressure through the same single writer,
awaiting Tokio MPSC capacity and a oneshot durability ACK as futures; they do not
occupy OS or Tokio worker threads and do not fan out synchronous fsync calls.
The writer retains a failed batch, retries it with bounded backoff, and acknowledges
only after durability is re-proven. A disconnected writer uses one globally
serialized asynchronous lock and one blocking emergency writer, retaining the
request until it is durable. Successful durability restores admission health.
Established media continues throughout. Spool
directories and records use mode `0700` and `0600`; temporary names include a
process-incarnation nonce, so startup removes abandoned records without deleting
the current process's write.

The uploader keeps a bounded directory cursor across passes, scans at most 4096
entries per pass and sends at most 64 concurrently. T1 exact Region commits use
a separate 64-slot semaphore and never hold a process-global lock across network
I/O. Slot exhaustion fences only new T1 admission. A T1 record is fsynced as an
exclusive `.t1pending` file; failure or process restart atomically releases it
as `.json` for background replay, so exact commit and the scanner cannot race
the same record. Its backlog gauge is the
larger of the last complete scan count and the current partial-cycle count, not
an instantaneous full-directory enumeration. Secret reads, directory and record
I/O, hashes, retry sidecars, quarantine and deletion run on blocking workers.
Each record has a persistent retry sidecar and independent
bounded exponential backoff with jitter. A delayed or poisoned record therefore
cannot starve healthy CDRs. A permanent protocol failure moves only that record
into `quarantine/`. The uploader rejects redirects and insecure production
endpoints, re-reads the file-backed service key on every pass for restart-free
projected-Secret rotation, and deletes a spool file only after a matching
`committed` receipt acknowledges the exact sequence and payload hash. Restart
resumes the existing spool before the node accepts a new owner-authorized call.
CDR API, PostgreSQL and object-storage failures never enter the RTP packet path.

Converact Fabric accepts a new durable receipt only from the active
`CONVERACT_FABRIC_CDR_REGION_ID` contract. RustPBX independently requires
`IVEKIT_RUSTPBX_CDR_REGION_ID` and rejects a successful response whose receipt
names any other Region. The contract must represent synchronous
quorum across at least two distinct Zones. Missing Region identity or contract
keeps the CDR pending. A higher sequence after Region takeover uses the new
Region contract, while exact historical replay returns its original receipt.
For `VOICE-HA-T1`, the PostgreSQL transaction locks the authoritative dialog
owner and accepts an unjournaled submission only from the exact Cell, RustPBX
node and owner epoch when no takeover is pending and the ownership row is
non-terminal. An exact sequence and payload hash already present in the
append-only submission journal may retrieve or finish its receipt after
takeover; it cannot introduce new data. The transaction
maintains the latest call projection, both leg projections, an append-only
submission-hash journal and an append-only receipt journal. A retained leg from
an earlier owner epoch remains recoverable after takeover, but cannot authorize
a new submission. A composite foreign key binds every receipt to the exact
submitted sequence and payload hash; unknown or changed historical payloads
fail with 409, stale unjournaled owners remain fenced, and replay cannot
duplicate the billing event.
The receipt transaction also terminally fences the exact owner and stores
`terminal_cdr_sequence`, `terminal_cdr_payload_hash` and
`terminal_shadow_pending=true`. Observing the matching terminal shadow clears
that pending repair flag. A missing terminal-shadow ACK can therefore require
repair, but can never reopen an ended call for takeover.

Both current and legacy Compose/Helm entry points mount a dedicated file-backed
CDR service key and persistent per-node spool. Both Helm charts reject
`voice.persistence.enabled=false`; an ephemeral CDR spool is not a supported
production mode. Helm projects the key group-readable for the constrained Pod
`fsGroup`; RustPBX accepts the projected symlink only when its canonical target
remains inside the configured Secret mount. Voice deployments require an
independent API CDR Region; it is not inferred from placement. Compose defaults
RustPBX to production and requires an explicit HTTPS CDR endpoint. On a non-empty
`ivekit_tenant_events` table, the migration runner validates and creates or
repairs the composite unique index concurrently before the transactional
migration revalidates and attaches it as a constraint. Contract activation,
quorum-loss handling, quarantine recovery, monitoring and rollback are defined in
`docs/converact-fabric-voice-cdr-durability-runbook.md`.

The exact ivekit.28 queue contains 29 patches. Locked Rust compilation, 64
Converact Fabric-focused Rust tests, the independent missing-callee test, 20 dialog
shadow/recovery contract tests and the TypeScript regressions are reproducibility
evidence only.
Physical cross-Zone PostgreSQL quorum, process restart, sustained spool replay,
real RTP continuity during store loss and capacity remain `not_run`.

`VOICE-HA-T1` first commits a reciprocal `terminating` shadow quorum, then
enforces local file and directory sync, an exact configured-Region cross-Zone
`committed` receipt and the database terminal fence, and only then the
reciprocal `terminated` shadow quorum. A failed Region commit leaves the shadow
in `terminating`; a higher-epoch takeover is finalization-only and does not
restore SIP dialogs, RTPengine sessions or media control. A process loss after
the receipt cannot lose the already committed CDR, and a failed final shadow
commit remains blocked by the database terminal fence. Recovered finalizers use
the same receipt-before-terminal-shadow ordering with bounded retry. The Drop
reporter is only a best-effort safety net and never marks a CDR sent before
durability.

`VOICE-ORDINARY` intentionally has no replicated shadow dependency and treats
the local durable spool as its success boundary. Loss of its sole spool while
the process is then killed is an unprotected double failure. Tenants requiring
zero terminal-CDR loss under that fault combination must use `VOICE-HA-T1`;
ordinary mode must not be described as providing it.

## Reproducibility

- RustPBX: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- rsipstack: `8318e97b1170de4e5245b120afec1cdf53e3d716`
- Rust builder: pinned by digest in `build.sh`
- Cargo dependency graph: `Cargo.lock`, built with `--locked`
- Runtime base: pinned by digest in `Dockerfile.runtime`

Run on a native amd64 or arm64 Docker host:

```bash
npm run converact:rustpbx-build
```

Run the same exact-source patch application plus fmt, check, clippy and focused
behavior gates without publishing an image:

```bash
CONVERACT_FABRIC_RUSTPBX_VERIFY_ONLY=1 bash infra/converact/rustpbx/build.sh
```

The RustPBX image workflow runs this verification before either architecture
build and also runs it for pull requests without GHCR publication.

Override the output image with `IVEKIT_RUSTPBX_IMAGE`. Cross compilation is
rejected so an image cannot be mislabeled with binaries from another architecture.

Constrained builders may set `CONVERACT_FABRIC_RUSTPBX_BUILD_CPUS`,
`CONVERACT_FABRIC_RUSTPBX_BUILD_MEMORY`, and `CONVERACT_FABRIC_RUSTPBX_BUILD_JOBS`. Set
`IVEKIT_RUSTPBX_CARGO_HOME` to a host directory to retain the Cargo registry
between clean source builds. These controls only bound the build container;
they do not change the release profile or runtime image.

## Acceptance

The delivery bundle exposes three separate engineering checks:

```bash
npm run converact:rustpbx-management-acceptance
npm run converact:rustpbx-rwi-acceptance
npm run converact:rustpbx-sipp-acceptance
```

The RWI check authenticates with the production client, runs `session.list_calls`,
originates with a deterministic call ID, finds that ID through AMI, and hangs up
the same call. Acceptance must also observe the downstream SIPp UAS receiving
BYE; the RWI command result alone is not sufficient evidence. This proves
signaling and reconciliation, not RTP media quality.

`npm run converact:rustpbx-sipp-acceptance` includes `answer-tcp` followed by
`answer-tcp-reconnect`. The downstream SIPp UAS is destroyed between the two
calls while RustPBX remains running. Both scenarios must pass with Router and CDR
evidence.
