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
`G03-E16-NATIVE-AUTHORITY` and the `.71` current patchset, including its
default-disabled native durable egress adapter, are outside those old reviewed
diffs and remain pending exact-source review.

## Current `.71` interim review boundary

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
typecheck. It does not touch product configuration, `SipServerBuilder` or live
Endpoint composition. This is not final independent review or host evidence;
reconciler supervision, live intent registration and every production gate
remain `not_run`.

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
