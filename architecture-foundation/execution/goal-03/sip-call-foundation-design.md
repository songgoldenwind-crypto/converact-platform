# SIP and Durable Call Foundation Design

Version: 1.0.0
Status: target contract frozen; implementation/evidence tracked separately
Production eligibility: `false`

## 1. Outcome

G03 establishes one stable anti-corruption boundary around the current
rsipstack-backed RustPBX runtime. It does not build a second PBX and does not
replace the SIP stack. Unified RustPBX remains the only Native Call, Leg,
Business Dialog, route, CDR and business-effect authority. The selected
`SipFoundation` Adapter owns Protocol Transaction/Dialog mechanics only.

```text
Kamailio SIP Edge
        |
        | edge-core-sip-v1 raw bytes + trusted metadata
        v
Unified RustPBX Call Core ----- durable Call/Leg/Business facts
        |
        | Converact-owned types only
        v
SipFoundation ----------------- prepared wire/effect/transaction/dialog
        |
        +-- live native runtime: pinned rsipstack inside RustPBX
        +-- later: gated low-level rvoip Adapter (G06)

TypeScript control plane ------ Call intent/rebuildable projections and
                                conformance/migration harnesses only
```

No rsipstack, rvoip, rustrtc or audio-codec type may cross upward into Call,
Queue, Routing, Billing, API or Addon interfaces.

## 2. Authority and Object Relationships

- `CallId` identifies one business Call; a SIP `Call-ID` never substitutes for it.
- A Call owns a bounded set of `LegId` values.
- A Leg owns bounded Protocol Dialog history and at most one active
  `ProtocolDialogId` at a time.
- Fork, queue and transfer create additional Legs; re-INVITE/UPDATE changes the
  negotiation generation of the same Leg/Dialog.
- `TransactionId` identifies protocol mechanics and cannot write business state.
- `MediaSessionId` correlates media execution and cannot decide Call state.
- `InteractionId` is the durable cross-channel continuity key. It may equal the
  current Call's string during compatibility migration, but is a distinct type
  and may span more than one Call.

New deterministic identifiers use SHA-256 over length-prefixed tenant,
namespace and components, truncated to 128 bits and prefixed by type. This
avoids delimiter ambiguity and does not force a ULID migration. Existing UUID
and `vcall_*` values enter only through the module-issued
`VoiceCallProjectionIdAdapter` (with a compatibility export under the former
name), bound at composition time to the exact concrete
`PostgresVoiceCallStore`. Construction records a module-private WeakSet brand,
the repository keeps its `PgQueryable` in a native private field, and the
attestation lookup invokes the captured original prototype method rather than a caller
override. The store must return an exact tenant/ID match. The module exposes
neither a caller-supplied lookup nor an import record. A raw string, SIP header,
look-alike prototype object, proxy or genuine instance with an own `get`
override cannot derive a candidate even when the value has valid UUID syntax.
This check attests an existing control-plane projection; only the native
RustPBX Call Core can adopt that candidate and open the authoritative Call.
`provider_call_id` remains an opaque native-runtime reference and is never a
`CallId`.

## 3. Call and Leg Mutation

The existing TypeScript `VoiceCall` state machine is the durable product Call
intent and rebuildable control-plane projection. It is not the authority for
an active native Call or Leg. The TypeScript `CallLegRegistry` freezes and
tests required transition semantics as a conformance reference; the live
implementation must reside in the Unified RustPBX process. Native activation
is tracked separately as `G03-E16-NATIVE-AUTHORITY` and remains `not_run` until
the exact Rust binding and effect writer are proved.

Opening or restoring an authoritative Call requires its durable positive
generation. Every Leg, mailbox and timer mutation carries
tenant, Call, owner epoch, generation and expected revision. A mutation either
advances the revision exactly once, returns the original receipt for the same
event ID/hash, or fails closed.

Race decisions are explicit:

- Direction is part of every transition key. `outbound` means local UAC and
  `inbound` means local UAS; it is not display metadata. Once the Native Leg is
  bound, compatibility updates cannot relabel it. Only outbound Legs may
  register fork branches or select a fork winner.
- An outbound INVITE 2xx requires the local idempotent ACK effect. An inbound
  final 2xx enters `awaiting_ack` with no local ACK effect and becomes
  `confirmed` only after the remote INVITE-2xx ACK is observed. If local
  termination is requested first, `awaiting_ack_terminate` durably records the
  deferred intent and sends BYE only after that ACK.
- An inbound CANCEL before final response requires separately registered
  durable 200-to-CANCEL and 487-to-INVITE effects. A CANCEL after the INVITE
  2xx receives its 200 but cannot reverse `awaiting_ack`. A remote BYE requires
  its durable 2xx response before terminal observation.
- CANCEL before final response sends CANCEL and closes 487 with a non-2xx ACK.
- A racing 2xx after CANCEL is ACKed and then terminated with BYE.
- Every fork branch is registered under one explicit bounded attempt before its
  INVITE starts. The selection input accepts only an integer SIP status from 200
  through 299. The first durably selected fork 2xx is the winner; its receipt
  contains one bounded per-Leg CANCEL effect for every remaining early branch.
  A late unacknowledged 2xx is ACKed then BYE'd, while an already acknowledged
  loser receives only BYE. A new or retransmitted 2xx for a winner whose BYE
  has already been requested cannot revive the Leg: it remains `terminating`
  and emits the idempotent ACK-then-BYE effect.
- Re-INVITE glare returns 491 and uses bounded retry; it does not create a Leg.
- Transfer keeps the old selected Leg until one dedicated atomic selection
  operation durably selects the confirmed replacement and marks the old Leg
  terminating. A generic per-Leg `transfer_commit` event is forbidden. Abort
  restores the exact pre-transfer stable state (`confirmed` or `held`).
- Duplicate BYE/CANCEL/effect identities do not create duplicate CDR or effects.

The conformance Call projection never invokes caller-provided callbacks. The
native implementation must expose only fenced enqueue/dequeue operations on a
bounded per-Call mailbox. A supervised
worker owns execution outside the registry and may re-enter only through the
same tenant/Call/owner/generation/revision fences. Async work therefore cannot
escape from a callback after the registry has reported failure.

Per-Call work is bounded. Call/Leg/Dialog lookup is expected O(1); reconciliation
may be O(number of Legs) but the number of Legs has a hard ceiling. No global
active-Call scan belongs to request, timer or RTP hot paths.

## 4. SipFoundation Deep Interface

The public contract is frozen as the closed Draft 2020-12 JSON Schema
`sip-foundation-control-message-v1`. Every field is required; optional values
use explicit `null`; unknown root, request, result, error and event-payload
fields fail validation. The schema closes the following semantic interface:

- `originate` accepts only Converact-owned tenant/Call/Leg/Interaction IDs,
  owner/generation fence, route reference, request URI and immutable SDP offer.
- `answer` binds one Call/Leg/Protocol Dialog and an immutable SDP answer.
- `terminate` carries a normalized hangup cause; a raw backend error is never a
  business cause.
- ingress and egress use one bounded, ordered-per-Protocol-Session envelope
  with event ID/hash dedupe. `event_hash` is lowercase SHA-256 over RFC 8785 JCS
  UTF-8 bytes of the complete closed event envelope with only `event_hash`
  omitted. They cannot mutate Call state before the Call authority commits its
  durable decision.
- SDP crosses the seam only as immutable exact bytes plus SHA-256, role and
  negotiation generation. No parser-owned SDP type crosses the seam.
- runtime timers use a monotonic clock. Snapshots persist semantic timer kind,
  bounded remaining duration and a separate wall-clock audit timestamp, never
  a process-local monotonic instant.
- stable error and hangup categories carry optional SIP/Q.850 codes,
  retryability and bounded Retry-After; secrets, raw wire and backend exception
  strings are forbidden.

The schema also freezes request/result/error envelopes, each event-type payload,
identifier patterns, maximum lengths, SDP/wire hash fields and timer clock
units. Its separately listed semantic invariants require byte length and SHA-256
to match the exact immutable bytes and require decimal epoch/generation strings
to fit unsigned 64-bit range; syntax validation alone is not sufficient.

The control port is frozen in G03. The current RustPBX control binding remains
outside that target port until its separately gated Adapter activation; this is
recorded as `not_run`, not described as completed wiring.

1. `prepare_effect` freezes canonical bytes, Adapter/runtime identity, route,
   DNS candidate, transport/local endpoint, Via branch lineage, owner fence and
   hashes. It performs no visible send.
2. The Call Core commits the corresponding durable business decision.
3. `commit_send` validates the owner/generation/sequence fence and uses the
   prepared effect identity idempotently.
4. Transport acceptance records only local acceptance. Protocol completion is
   distinct from later state observation after an unknown result.
5. `query_effect` is read-only. `reconcile_effect` requires a repair lease and
   fence; unknown never causes a blind new identity.
   The current `.72` component accepts only an opaque/sealed crate-private,
   non-cloneable grant intended for the durable Call/session Authority; the live
   issuer remains `not_run`. It binds one exact tenant, Protocol Session,
   generation, successor repair epoch and 1..100 strictly ordered unique
   targets. Every target binds its effect ID, expected revision and effect
   identity hash. The fixed-worker/bounded-queue reconciler cannot enumerate
   or scan effects, mint/reuse an epoch or send SIP. Its PostgreSQL claim uses
   the existing `(tenant_id, protocol_effect_id)` primary key for bounded exact
   lookup, returns exact claimed/exhausted IDs and rolls the whole claim back
   as `FenceLost` if any target is missing, stale or concurrently locked. A
   monotonic expiry is frozen when the grant is minted, so queue dwell reduces
   its window. Dequeue freezes one whole-millisecond execution lease used for
   the claim. Configured timeout has a usable maximum of 29 s and remaining
   lease must be strictly greater than timeout + 500 ms. Submission after
   parent cancellation fails stopped; a caught store/oracle panic cancels the
   reconciler child domain, stops every repair worker and rejects new grants so
   no worker reuses shared dependencies. The parent Call process and established
   Human Communication remain outside that child cancellation. Process-local progress counters advance after each
   confirmed durable reconcile or exhaustion and retain that fact if later
   batch work fails transiently, with `Terminal`, permanently, by panic,
   timeout or cancellation. Normal `FenceLost`/`Terminal` races are superseded
   and keep healthy workers available. In-memory and PostgreSQL claim paths use
   the same maximum 512-byte `SipEffectRepairFence` validator.
6. `.73` binds a real matched CANCEL on a Trying/Proceeding INVITE to two
   distinct one-use effects inside the Rust transaction: `200 CANCEL` completes
   only under transport-terminal policy, while `487 INVITE` remains
   non-terminal until the matching peer ACK. A late CANCEL after an existing
   final receives only `200 CANCEL` and cannot authorize a second final.
   Native Call authority reserves both identities before a transaction-local
   gate is installed. The runtime is `None` by default; Endpoint-global gating,
   self-issued capabilities and partial-pair activation are forbidden.
   `.75` provides successor-safe cleanup fencing. `.76`–`.78` require one
   atomic PostgreSQL predecessor fence plus `NoVisibleEffect` before rebuilding
   unconsumed capabilities and compose that Oracle into the one default-disabled
   Rust runtime. `.79` admits the owner only from an authenticated closed
   `fresh`/`recovered` proof, snapshots identity/proof/guard in one owner `Arc`,
   invokes the Oracle only for the exact recovered predecessor, and rechecks
   that same snapshot across the async boundary. Missing proof fails closed
   when the durable runtime is enabled; stale cleanup can remove only the same
   owner pointer and exact Native Call identity/cell pointer. `.80` closes the
   issuer component without moving Authority into TypeScript: the compatibility
   coordinator rejects legacy, missing or split v2 bindings before claim, while
   Rust opens the reciprocal A256GCM pair, preserves the exact predecessor,
   derives the successor and registers `Recovered` owner proof for resume and
   finalization. No request body or ordinary placement replay may declare
   recovery. `.81` registers the recovered projection in the sole existing
   Active Call registry, reconstructs one confirmed inbound Native Leg through
   the ordinary inbound transition sequence, and publishes exactly the
   reciprocal Dialog pair or rolls the whole slot back. Its bounded recovered
   handle accepts only whole-Call Hangup; an exact identity/native-cell lease
   fences teardown. Confirmed-dialog recovery has no original server-INVITE
   transaction key or Via lineage and therefore must not fabricate or invoke
   the matched-CANCEL Oracle. Real process restart through the issuer and
   registry, and separate original-INVITE recovery through the durable Oracle,
   remain explicit activation blockers.
7. Transaction retransmission replays the exact committed bytes/hash.
8. `snapshot` carries protocol state only. `restore` accepts only a confirmed,
   transaction-quiescent, same-Adapter/runtime snapshot after outer Call-owner
   authority is granted.
9. `drain` stops new Protocol Sessions, preserves existing runtime identity and
   reaches active-zero naturally. A session-opening reservation is installed
   before any Adapter identity getter or create callback and counts toward both
   capacity and active-zero; failed opens revoke their lease and release that
   reservation. Reentrant same-ID opens fail closed. A deadline does not
   authorize forced BYE or deletion.

Automatic ACK, CANCEL, retransmission and error responses remain declared
effect policies. An Adapter cannot emit an unregistered visible effect.

## 5. Ingress and Wire Contract

`edge-core-sip-v1` transports original bytes plus only six trusted metadata
fields. Publicly supplied look-alike metadata is stripped and rebuilt by the
trusted Edge. The message, URI, headers, body and multipart limits in
`sip-foundation-contract-v1.json` are hard ceilings.

Conflicting `Content-Length`, singleton headers, URI escape ambiguities,
obsolete folding and malformed multipart fail closed. Ordered repeatable
headers retain wire order. Authentication material, numbers, SDP keys and raw
provider payloads are excluded from ordinary logs, metrics and evidence.

The 22 raw fixtures under `wire-corpus/` freeze required G03 inputs and SHA-256
identities. Controlled dual-binary replay verifies the exact `.53` candidate
against the `.40` pre-wire-guard baseline: all 18 accepted semantics are
unchanged, the four malformed inputs are rejected under
`G03-WIRE-SECURITY-001`, and there are zero unexplained differences. Future
rvoip differential replay remains separate `not_run` evidence.

## 6. Initial INVITE and Durable Store

After bounded SIP transaction admission, the current RustPBX owner may emit one
initial `100 Trying` before a business durable decision. It must not emit 18x or
2xx, activate media, billing, recording or webhook facts before their declared
durable gates.

Budgets are inherited exactly from Revision 4:

| Boundary | Budget/ceiling |
| --- | ---: |
| `100 Trying` p99 | 100 ms |
| `100 Trying` hard deadline | 200 ms |
| one durable transaction p99 | 20 ms |
| cumulative setup-store p99 | 60 ms |
| write/pool acquisition timeout | 250 ms |
| one-time startup contract hard deadline | 2,000 ms |
| pool size | 256 |
| queue depth | 1,024 |
| retry attempts | 3 |

The 2 s startup ceiling is used only once before SIP service begins, for the
cold schema/writer/RLS/trigger/privilege scan. It is never available to a Call
transaction; every Call-path pool acquisition and write remains capped at
250 ms.

Store timeout, exhaustion, unavailability or schema incompatibility rejects new
Call work as 503 with deterministic `Retry-After`. Established ordinary media
does not synchronously depend on this store. Repair is bounded and
operator-visible after exhaustion.

## 7. Receipt Semantics

The current v1 durable schema distinguishes three user-facing meanings through
the receipt tuple, not a network exactly-once claim:

- accepted: `transport_accepted` from `send_attempted`; local transport only;
- completed: `protocol_observed` from `send_attempted` or
  `transport_accepted` on the primary transaction path;
- state-observed: `protocol_observed` from `unknown` under a fenced
  query/reconcile worker.

The `from_state` stored with each receipt makes completion and reconciliation
observation distinguishable even though both converge the effect record to
`protocol_observed`.

## 8. Current, Target and Production State

| State | Meaning |
| --- | --- |
| current | RustPBX/rsipstack is the native runtime; TypeScript contains bounded conformance/reference models and a physical PostgreSQL reference ledger, but these are not a second live SIP/Call authority |
| target | The complete interface and corpus are frozen; `.73`–`.78` supply the matched-CANCEL/ordinary-response authority, exact teardown, conservative recovery seam, session-fenced PostgreSQL Oracle and one default-disabled Rust product composition root. `.79` adds trusted invocation through one authenticated closed admission proof and one atomic owner snapshot; durable mode rejects missing proof, recovered mode invokes the exact PostgreSQL Oracle only when original transaction facts exist, and pre/post-async owner checks plus separate owner and Native Call identity/cell pointer fences preserve any replacement. Each refresh loop is bound to its original owner pointer and exits on replacement. `.80` derives recovered proof only from one reciprocal v2 capsule pair. `.81` publishes the confirmed recovered Call through the sole existing Active Call registry with one confirmed inbound Native Leg, two exact Dialogs, an all-or-nothing registration, bounded whole-Call Hangup and exact cleanup; it does not invent original-INVITE facts for confirmed-dialog recovery. `.82` catches unwind inside that existing recovered controller child, attempts exact-Call teardown behind a separately caught 8 s deadline, and caps each media close at 2 s; the exact cleanup lease still fences replacement teardown when the child returns. Disabled mode performs no database work; partial/unknown/non-PostgreSQL config, contract drift, duplicate injection and live reload fail closed with no memory or TypeScript runtime fallback. The cold startup contract has a separate 2 s hard deadline and does not widen the 250 ms Call-store ceiling. Exact-source SipEffect passes `135/135` with 11 physical tests ignored, native SIP effect passes `40/40` with one physical case ignored, recovered control passes `1/1`, Dialog shadow passes `11/11`, Active Call registry passes `25/25`, and the full RustPBX library passes `2113/2113` with 12 external prerequisites ignored. The historical `.78` exact physical adapter separately passed `1/1` against isolated PostgreSQL 16 through migration 116; `.82` used no server. Real task/process panic, orphan-media reconciliation, real process restart/two-node, original-INVITE Oracle activation, live Endpoint, remaining transports, Linux process execution, all performance work and Native Authority remain `not_run` |
| production eligible | `false` until long-run, fault/OOM, Native Authority, allocation and multi-core scaling evidence pass independent review |

The target row includes the historical `.79` substrate and `.80` proof issuer.
The `.81` delta adds the local recovered Active Call composition; current
`.82` adds only its local child-unwind and bounded-cleanup boundary. It does not
prove actual live-task panic cleanup, external media orphan reconciliation,
real restart wiring, a live peer, original-INVITE Oracle activation, Endpoint
activation or Native Authority, so none of those states is promoted.

No rvoip benchmark, old server result or historical Wave result is inherited.
