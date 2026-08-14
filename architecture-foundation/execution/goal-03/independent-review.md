# G03 Independent Review

Review status: `interim_code_and_controlled_postgres_reviews_accepted_final_g03_review_pending`
Production eligibility: `false`

## Accepted implementation review

The independent reviewer examined exact implementation commit
`a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb` against accepted baseline
`9fbfbdab1c127e28373fb475cddc2cb3f021172f`. The reviewed diff has SHA-256
`3b68acfccde992669800d6246967b3f193aadf9b03fbec7eaa8f575a928839b0`.
The result was **ACCEPT** with
`Critical 0 / High 0 / Important 0 / Minor 0`.

That review closed the restart-probe races previously found at `6cbe1a3`:

1. the timeout is now a hard process watchdog and cannot leave the probe alive;
2. PostgreSQL identity is sampled only after the accepted write and therefore
   cannot predate the durable boundary being claimed;
3. runtime-role initialization uses one checked-out PostgreSQL client, so the
   transaction and `set_config` scope cannot move across pooled connections.

## Accepted controlled PostgreSQL evidence review

The independent evidence reviewer examined campaign
`converact-g03-pg-restart-a18229cd-02` and the retained, non-sensitive raw
artifacts. The result was **ACCEPT** with
`Critical 0 / High 0 / Important 0 / Minor 0`.

The accepted scope is only `G03-E05-POSTGRES = verified_controlled`: physical
role ACL, outage behavior, an actual restart of the same PostgreSQL system,
separate-process replay without a duplicate Effect/Receipt, exact-source
identity, campaign cleanup and preservation of the nine pre-existing stopped
containers. Full Docker inspect documents were deliberately excluded because
they can contain unrelated environment values; equal normalized digests and
unchanged container IDs are retained instead.

Neither accepted review proves that the TypeScript `VoiceCall`, Call/Leg model,
`RsipstackFoundationAdapter` or PostgreSQL reference ledger is a live native
authority. Unified RustPBX remains the sole active Call/Leg authority;
`G03-E16-NATIVE-AUTHORITY` and the `.72` current patchset, including its
default-disabled native durable egress adapter, are outside those old reviewed
diffs and remain pending exact-source review.

## Current `.72` interim review boundary

The `.59` protocol-observation slice received iterative code review while it
was developed. Findings around cancellation ownership, queue loss, receipt
semantics, v1/v2 schema closure, PostgreSQL round trips, database clock
ownership and ingress provenance were either implemented in the current
candidate or retained as explicit activation blockers. Fresh patch-chain replay
and exact-source tests then passed; the controlled Linux bundle
`evidence/raw/native-protocol-observation-fe4c38b-05/` records the full RustPBX
library result and six physical PostgreSQL cases.

The `.60` slice then added one parent-bound automatic non-2xx ACK path. Review
findings around cancellation before `prepare_derived`, retransmitted finals
creating a second child identity and derivation from a parent already in
`unknown` were each converted into a failing test before the implementation was
tightened. Exact local and isolated-Linux suites pass, as does one explicit
physical PostgreSQL atomic-derived-ACK case. The evidence bundle is
`evidence/raw/derived-non-2xx-ack-9fc99ee-06/`.

The incremental `.61` slice closes the specific provenance gap in which an
ordinary internal sender could construct a synthetic network `Received` event.
The production proof constructor and Endpoint ingress function are private,
the transaction receiver cannot be replaced externally, and client/server
tests now enter through Endpoint ingress. Compile-fail tests were observed RED
before the boundary and GREEN after it; exact incremental replay, rsipstack
`303/303`, doctest `67/67` and RustPBX `2,002/0/8` pass on the authorized
server. The component-only raw bundle is
`evidence/raw/peer-ingress-proof-701475a-07/`.

The `.62` slice adds one matched server-INVITE CANCEL response without granting
the transaction layer business-intent authority. Review findings around
pre-authorization, exact trigger/response matching, stable To-tag lineage,
duplicate replay and ambiguity after durable commit became tests before the
implementation was accepted. The final server sources pass exact incremental
replay, rsipstack `306/306`, doctest `67/67` and RustPBX `2,006/0/8`. The
component-only raw bundle is
`evidence/raw/peer-derived-cancel-56e0d42-08/`.

The incremental `.63` slice removes the immediate-Unknown UAS-2xx gap. One
explicit `ServerInvite2xxOwner` retains the initial application-authorized
permit and immutable response bytes. UDP retransmission is T1→T2 on the shared
timer heap; reliable transports never retransmit. Exact Call-ID/tag/CSeq ACK
matching is accepted only from Endpoint-proven ingress, while 64*T1, owner drop
or retransmission failure resolves Unknown once. Local exact-source tests pass
rsipstack `309/309` and the RustPBX durable-gate module `32/32`. The authorized
server passed rsipstack `309/309` plus doctest `67/67`, then rejected `.63`
because full RustPBX compilation exposed an uncovered
`Uas2xxDeadlineExpired` outcome.

The `.64` correction adds the missing product-owner retention and typed outcome
classification. It also makes an initial successful-response transport failure
terminate with `TransportError` instead of leaving an ambiguous Trying state.
Both behaviors were observed RED against `.63`; local exact-source suites are
GREEN at rsipstack `311/311`, doctest `67/67`, and RustPBX `2,008/0/8`. The
same exact-source counts pass on the authorized server and are retained under
`evidence/raw/uas-2xx-retention-a85d249-09/`. This is controlled component
evidence, not an independent acceptance, release-image qualification or live
Native Authority result.

That work is not a final independent acceptance. Live Endpoint composition and
transport-flow-generation binding, the live Call Core holder for the matched
CANCEL capability/UAS-2xx owner composition, reconciliation resumption,
parent-Unknown reconciliation, stale nonterminal and in-flight UAS-owner crash recovery,
mixed-binary activation, fault/OOM and capacity evidence remain open. The
candidate therefore remains default-disabled and `G03-E15-REVIEW`,
`G03-E16-NATIVE-AUTHORITY` and production eligibility remain
`not_run`/false.

The incremental `.65` candidate closes one prerequisite to that crash work:
HA dialog recovery no longer reconstructs a standalone or second Native Call.
Both dialog legs carry one authenticated closed binding for the stable tenant,
canonical `CallId`, canonical `InteractionId` and provider reference; takeover
increments the owner epoch, generation and revision exactly once. Rust and
TypeScript share a 16 KiB ceiling and one fixed binding hash. Local static gates
pass `191/191`, TypeScript capsule tests pass `9/9`, and RustPBX passes
`2,015/0/8`; the dialog-shadow integration contract passes `20/20`.
Authorized-server candidate `1d05333…` exits zero with the same RustPBX and
integration results plus rsipstack `311/311` and doctests `67/67`. Its
component bundle is `evidence/raw/native-call-recovery-1d05333-10/`; it records
external old-service restarts and therefore makes no performance claim. Real
crash/two-node takeover and final independent acceptance remain `not_run`;
this paragraph does not promote `G03-E15` or `G03-E16`.

The later exact `.70` source passes the focused physical PostgreSQL recovery
case `2/2`, the complete RustPBX library suite `2,016/0/9`, rsipstack
`311/311`, and its compile-fail/doctest target `67/67` on the authorized
server. The full-suite bundle is
`evidence/raw/full-linux-suites-6abf714-12/`. This closes the exact `.70`
component-suite execution gap only. It is not an independent acceptance and
does not prove live Native Authority, a real process crash, a two-node
takeover, fault/OOM isolation, performance or production eligibility.

The incremental `.71` slice adds only the fixed observation supervisor and its
tests. Exactly one task owns each configured shard; transient persistence
failure retains the same armed work under bounded exponential backoff, an
unwind panic releases the old lease before atomic restart, permanent failure
stays quarantined, and cancellation leaves work for explicit restart. Focused
Rust tests pass `38/38`, patch gates `189/189`, the machine contract `9/9`, and
typecheck. Controlled Linux requalification at exact source `1ebbd765…` passes
RustPBX `2,022/0/9`, three focused regressions, dialog-shadow `20/20`,
rsipstack `311/311` and doctests `67/67`; the bundle is
`evidence/raw/full-linux-suites-1ebbd76-13/`. It does not touch product
configuration, `SipServerBuilder` or live Endpoint composition. At `.71`,
reconciler supervision, live intent registration and every production gate
remained `not_run`; this was not final independent acceptance.

The incremental `.72` slice adds the separately default-disabled exact-target
reconciler component. Its grant and target specifications now have an
opaque/sealed crate-private minting surface, are non-cloneable at the worker
boundary, and bind one tenant, Protocol Session, generation, successor repair
epoch and 1..100 strictly ordered unique targets with exact revision and
identity hash. The live durable Authority issuer remains `not_run`. The worker
has a fixed configured count and bounded queue; it cannot enumerate, scan,
mint/reuse an epoch or send SIP. PostgreSQL uses the existing
`(tenant_id, protocol_effect_id)` primary key for bounded exact lookup, and the
claim reports exact claimed/exhausted IDs rather than trusting counts. Minting
freezes a real monotonic expiry, queue dwell reduces it, and dequeue freezes
one whole-millisecond execution lease. Usable timeout is capped at 29 s and
remaining lease must be strictly greater than timeout + 500 ms. Parent-cancelled
submission fails stopped; a caught store/oracle panic cancels the reconciler
child token, stops every repair worker and rejects future grants instead of
reusing shared dependencies. The parent Call process remains outside that
child cancellation. Process-local progress counters advance per
confirmed durable reconcile/exhaustion even if later batch work fails
transiently, with `Terminal`, permanently, by panic, timeout or cancellation.
Ordinary `FenceLost`/`Terminal` races are superseded and keep healthy workers
available.

The initial `.72` review rejected five defects: grant self-minting, no true
deadline, reuse after worker panic, partial progress missing from metrics, and
submission accepted after parent cancellation. Each finding was first captured
as a failing test and is closed in the current candidate by the sealed minting
surface, monotonic expiry/lease rules, panic quarantine, per-effect durable
progress accounting and cancelled-submit rejection. A later final review then
rejected shared dependency reuse after panic, a weak privacy regression guard
and the in-memory 200-byte/ PostgreSQL 512-byte fence mismatch. The current
candidate closes those findings by child-domain cancellation, two real sibling
compile-fail probes (`E0603` and `E0451`) and the shared 512-byte
`SipEffectRepairFence` validator. Isolated exact-source tests now pass `28/28`,
the affected SipEffect suite passes `87 passed / 0 failed / 8 ignored`, and
locked library check plus Rust formatting pass. Final independent re-review
accepted the exact candidate with no blocker or important finding after the
canonical contract/static tests passed `12/12`, all related TypeScript patch
tests passed `192/192`, and typecheck passed. Its one minor hardening suggestion
is also closed: both whole-child panic tests now explicitly prove that stopping
the reconciler child before and during supervisor shutdown never cancels the
parent Call token. This accepts only the default-disabled `.72` component
slice; it is not a `G03-E15` evidence promotion.

The exact committed source was then rerun offline on the authorized Linux host:
the reconciler passed `28/28`, the affected SipEffect suite passed
`87 passed / 0 failed / 8 ignored`, and the container exited `0` without OOM.
The raw bundle is
`evidence/raw/focused-linux-sip-effect-b3c9da0-14/`; this focused rerun does not
replace `.72` full-suite or physical PostgreSQL evidence. The authoritative
issuer, durable completion sink, physical
PostgreSQL exact-target/rollback and 10K/100K distractor plans, live Endpoint,
process-crash/two-node, Linux full, fault/performance and production gates
remain `not_run`.

The incremental `.73` candidate is a feature-only, default-disabled Rust
component slice. It fixes the pending-INVITE matched-CANCEL effect boundary by
deriving two separate one-use capabilities from one sealed peer ingress proof:
the `200` response to CANCEL is transport-terminal, while the distinct `487`
response to the original INVITE remains pending until its exact matching ACK.
A late CANCEL after an existing final receives only 200 and cannot authorize a
second final. Unified
RustPBX Native Call authority reserves the pair before one transaction-local
gate is installed; duplicate, mismatched, partially registered or conflicting
installation paths fail closed and remove the affected active Call in the
covered non-concurrent paths. `.75` later closes concurrent successor cleanup
with an exact cell/identity fence; process restart still needs capability
reconstruction and remains an activation blocker. No
Endpoint-global gate and no product activation are introduced.

The exact local source passes full rsipstack `314/314`, full RustPBX
`2063 passed / 0 failed / 9 ignored`, rsipstack server transactions `32/32`,
the durable gate `39/39`, Native capability composition `8/8`, Active Call
registry `24/24`, the default-disabled builder check `1/1`, and both locked
Rust library checks. The 9 external-prerequisite cases remain `not_run`. This
patch's one-line `test_auth.rs` constructor update is compiled and covered by
the full library suite but excluded from rustfmt scope because the pinned
upstream file has three unrelated pre-existing formatting drifts; every other
new Rust file in the slice passes the pinned rustfmt check. This
is not final `G03-E15` review or evidence promotion. At this `.73` checkpoint,
activation was still ineligible because only the matched-CANCEL pair was
authorized; `.74` closes that specific ordinary-response implementation gap
but does not close the remaining activation gates below. Restart capability reconstruction,
physical PostgreSQL, RustPBX host functional verification, TCP, WS, TLS and
WSS, crash/restart, live product activation and all deferred performance gates
remain `not_run`.

The subsequent zero-impact isolated Linux campaign passes the exact rsipstack
server-transaction target `32/32`. Compilation of the RustPBX lib-test binary
then received SIGKILL at the deliberately unchanged 2,560 MiB isolation
ceiling, before any RustPBX test ran; that is recorded as `not_run`, not a test
failure. The existing service stayed running/healthy, service/listener/unit
snapshots and retained lower-source hashes are byte-identical before and after,
and the test container and mounts are absent after cleanup. The bundle is
`evidence/raw/isolated-server-matched-cancel-4431270-15/`. No performance
command ran and no running validation-server service or deployed code was
changed.

The incremental `.74` candidate closes the ordinary-response functional gap
inside the same default-disabled Rust transaction-local gate. Native Call
authority freezes Call-ID, INVITE CSeq, From, top Via, To base and one stable
locally generated To tag at installation. Each exact response capability binds
the transaction key and canonical wire image; 101..199 may repeat with distinct
wire identities, followed by exactly one 200..699 final. Authority reservation
precedes intent registration and durable preparation; Call state is committed
before transport is permitted. Dialog drift and duplicates fail before store
work, cancellation/panic after durable work begins retains the identity for
reconcile, and a Call-revision race after durable prepare records
`TransportUnknown`.

Focused local checks pass response capability `17/17`, Native Call `13/13`,
registry `24/24`, durable gate `39/39`, locked library check and scoped
rustfmt. This is an implementation self-review checkpoint, not final G03
independent acceptance. Full RustPBX, physical PostgreSQL, live Endpoint and
isolated-server `.74` verification remain `not_run`. It inherits no `.73`
server evidence and performs no performance/load/capacity/soak work.

The later isolated `9775a79` Linux attempt applied the exact `.73`/`.74`
patch chain but executed no RustPBX test: `rustc` reached the test container's
3,584 MiB memory cgroup while producing the lib-test binary and received
`SIGKILL`. The ceiling was not raised. Pre/post service and lower-source
snapshots are byte-identical, the existing PostgreSQL container remained
healthy with restart count zero, and the test container and overlays are
absent. This failed attempt is retained in
`isolated-server-native-response-9775a79-16/`; it does not promote server
functional verification or any Evidence status.

The incremental `.75` candidate addresses the rejected successor-cleanup gap
without changing the default-disabled activation state. A cleanup fence can be
obtained only from the exact admitted reservation, cannot be cloned, is
consumed exactly once by value, and binds both the full
`NativeCallIdentity` and the original Native Call cell. Failure teardown uses
one provider-slot entry guard through provider/native/dialog secondary-index
cleanup. The two RED/GREEN regressions prove that a stale fence preserves a
same-ID successor and all its indexes, while an exact fence removes the
original Call and every owned index. Exact-source focused tests pass Native SIP
capability `19/19`, Active Call registry `24/24`, full local RustPBX
`2076/2076` with 9 external-prerequisite cases ignored, locked library check
and scoped rustfmt. This is an implementation self-review checkpoint; final
independent review, restart capability reconstruction, physical
PostgreSQL, live Endpoint, server functional verification and all deferred
performance work remain `not_run`.

The incremental `.76` candidate addresses only the next component boundary; it
does not claim live restart recovery. Six RED/GREEN cases prove that RustPBX
can reconstruct an unconsumed matched-CANCEL capability pair only after an
Oracle atomically fences the predecessor and proves `NoVisibleEffect` for the
exact recovery binding and server-INVITE transaction. `VisibleOrAmbiguous`, a
stale binding, successor replacement during the Oracle wait, or an invalid
fence receipt all fail closed before intent installation. The recovered gate
also retains the exact successor identity: a later Call reusing the provider
Call-ID is rejected before every prepare path and cannot be mutated or receive
a new effect from the stale gate. Exact-source focused tests pass Native SIP
capability `25/25`, Active Call registry `24/24`, full local RustPBX `2082/2082`
with 9 external-prerequisite cases ignored, locked
library check and scoped rustfmt. This remains an implementation self-review
checkpoint. At that `.76` checkpoint the PostgreSQL implementation had not
yet landed; live recovery holder, physical restart/ambiguity verification,
isolated-server Rust verification, final independent review and all deferred
performance work remained `not_run`.

The incremental `.77` candidate replaces the `.76` placeholder Oracle with a
default-disabled Rust/PostgreSQL implementation. Self-review confirms that the
recovery transaction advances one exact tenant/session owner-generation fence,
probes only the deterministic 200-CANCEL and 487-INVITE effect IDs, returns
`VisibleOrAmbiguous` for any visible predecessor, and persists an immutable
idempotent receipt. Migration 116 independently rejects stale effect inserts
and prevents an effect prepared by the old owner from making its first
`send_attempted` transition after takeover, while preserving later evidence
transitions for an already-attempted effect. The transaction key is hashed and
is not stored.

Local exact-source SipEffect tests pass `121 passed / 0 failed / 10 physical
tests ignored`. The isolated PostgreSQL 16 migration/SQL harness passes exact
fencing, visibility, replay/immutability, both stale-binary bypass shapes and
tenant RLS.
The `.77` temporary server container used `network=none`, no host ports and
tmpfs; the pre-existing service remained healthy and only the exact test
resources were removed. That historical bundle remains SQL-only evidence.

The incremental `.78` candidate closes the next composition gap without
activating production traffic. Review of the exact patch confirms that the Rust
app constructs the durable runtime before SIP service startup, verifies the
elected PostgreSQL writer plus recovery tables/functions/triggers, forced RLS,
tenant policies and required privileges, and injects the runtime exactly once
into either custom or default `SipServerBuilder`. One
`Arc<PostgresSipEffectStore>` is used by the egress Gate, observation supervisor
and capability-recovery Oracle; the runtime owns the supervisor lifetime.
Disabled mode does no database work, while malformed or partial configuration,
an already-cancelled lifecycle, duplicate injection and live reload fail closed.
No in-memory or TypeScript server fallback is introduced.

The first real `.78` adapter execution failed closed with `PoolTimeout`. Review
traced this to reusing the 250 ms per-Call store deadline for a one-time cold
catalog scan. The correction leaves every Call/store operation at 250 ms and
adds a separate hard 2 s startup-contract deadline. It also checks `SELECT` and
`INSERT` independently because PostgreSQL comma-separated privilege inquiry is
an any-of check, not an all-of check.

Exact-source SipEffect tests pass `133 passed / 0 failed / 11 physical tests
ignored`; the native composition filter passes `38 / 0 / 1 ignored`, and the
exact ignored PostgreSQL adapter case separately passes `1 / 0` against a fresh
PostgreSQL 16 migration chain through 116. The test database used tmpfs, bounded
CPU/memory, no host-published port and a local SSH tunnel to its private address;
cleanup destroyed it. The pre-existing container retained its exact ID,
healthy state and zero restart count. Locked library check, scoped rustfmt,
exact patch replay, targeted static contracts and the G03 machine-contract
suite pass. This is still an implementation review checkpoint. Recovered-Call
invocation, live Endpoint, Linux product-process execution, real process
restart/two-node recovery, final G03 review, production and all performance work
remain `not_run`.

The incremental `.79` candidate closes the trusted invocation seam without
claiming an end-to-end restart producer. Review confirms that the authenticated
admission payload is a closed tagged union: `fresh` has no predecessor and
`recovered` requires the exact closed recovery binding. With the durable SIP
runtime enabled, a legacy or absent proof is rejected rather than silently
downgraded. One `Arc<OwnerEntry>` atomically snapshots Native Call identity,
proof and guard; the same snapshot supplies active-call registration and
recovery-Oracle selection and is checked before and after the asynchronous
Oracle. Separate conditional owner and Native Call identity/cell pointer fences
preserve replacement owner and Active Call state.
Recovered admission cannot fall back to ordinary installation when the runtime
is absent. The control-plane producer emits `fresh` only after a newly prepared
reservation and contains no `recovered` emitter.

Exact-source verification passes SipEffect `135/135` with 11 physical tests
ignored, native SIP effect `40/40` with one physical test ignored, owner
`11/11`, admission snapshot `3/3`, recovered filters `15/15`, and full RustPBX
`2109/2109` with 12 external prerequisites ignored. Locked library check,
scoped rustfmt, exact patch replay, repository typecheck, canonical focused
TypeScript admission tests and G03 machine contracts pass. The first aggregate
TypeScript attempt omitted the required explicit development-auth preload; the
canonical rerun passed without an implementation change. This is an
implementation self-review checkpoint, not final independent acceptance. The
server was not contacted, no performance command ran, and the trusted
recovered-proof producer, real process restart, live Endpoint, production and
`G03-E15/G03-E16` remain `not_run`.

The incremental `.80` candidate closes that intentionally open issuer component
without promoting TypeScript to recovery Authority. Review confirms the
compatibility coordinator refuses legacy v1, missing and split-binding capsule
pairs before claim. Rust then opens the authoritative reciprocal A256GCM pair,
returns the exact predecessor together with the derived higher-epoch successor,
and calls `ensure_recovered_owner_with_identity` on both restored-call and
finalization-only paths. No request body, placement replay, legacy capsule or
one-leg value can mint the recovered proof.

The RED test first accepted legacy/split takeover input and the Rust RED build
failed because the trusted-authority helper did not exist. The GREEN candidate
passes takeover `10/10`, Rust dialog-shadow `9/9`, the focused proof regression
`1/1`, full RustPBX `2109/2109` with 12 external prerequisites ignored, locked
check, scoped rustfmt, exact patch replay, repository typecheck, affected static
tests and G03 machine contracts. This is an interim implementation review, not
final G03 acceptance. Real process restart-to-issuer/Oracle execution,
two-node ambiguity recovery, live Endpoint, Linux product process,
`G03-E15/G03-E16`, production and performance remain `not_run`.

The incremental `.81` candidate closes the local recovered Active Call
composition gap left by `.80`. Review confirms that it reuses the existing
`ActiveProxyCallRegistry`, installs exactly one confirmed inbound Native Leg
and two distinct reciprocal Dialog IDs, and rolls the complete slot back if the
pair cannot be published atomically. The Leg reaches `Confirmed` through the
ordinary inbound Native Leg state machine and every reconstructed transition is
required to emit no effect. The recovered session command channel remains
bounded and rejects every operation except whole-Call cascade-all Hangup before
enqueue. An exact identity/native-cell lease owns registry teardown, so a stale
controller cannot delete a replacement.

Review also confirms the negative boundary: this is confirmed-dialog recovery,
not original server-INVITE recovery. The capsule has no transaction key or Via
lineage, and `.81` neither fabricates them nor calls the matched-CANCEL Oracle.
That Oracle remains a separate activation path requiring exact durable facts.
RED first exposed the missing registry/handle/projection APIs and then caught a
Leg left in `Planned`; GREEN passes the recovered handle `1/1`, dialog shadow
`10/10`, Active Call registry `25/25`, and full RustPBX `2112/2112` with 12
external prerequisites ignored. Exact patch replay, locked check, scoped
rustfmt, affected static contracts and G03 machine contracts pass. This is an
implementation self-review checkpoint, not final independent acceptance. Real
restart/live peer execution, controller-panic async media cleanup, two-node
recovery, original-INVITE Oracle activation, live Endpoint,
`G03-E15/G03-E16`, production and performance remain `not_run`.

## Rejection history and remaining gate

The earlier `6cbe1a3` evidence review was rejected with
`Critical 0 / High 0 / Important 3 / Minor 0`; all three findings above were
closed and independently accepted at `a18229c`. Earlier implementation review
rejections at `3559afc` and `32a2128` also remain in history; their findings
were closed before the accepted implementation baseline.

This is not the final G03 review. Exact `.53` 100 Trying, wire differential,
SIPp/Asterisk interoperability, one 7,201,279-ms SIP-control call and a 2-vCPU
capacity regression now have raw controlled evidence. `G03-E15-REVIEW` remains `not_run`
until fault/OOM, Native Authority, allocation and multi-core
gaps are honestly retained, and a reviewer examines the final exact
commit/diff. Production eligibility remains false.
