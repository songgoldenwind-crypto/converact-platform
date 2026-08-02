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
        +-- current: pinned rsipstack Adapter
        +-- later: gated low-level rvoip Adapter (G06)
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
and `vcall_*` values enter only after the existing durable `VoiceCall`
repository returns an exact tenant/ID match and the foundation module issues a
non-forgeable in-process authority record. A raw string, SIP header or
look-alike plain object is rejected even when it has valid UUID syntax.

## 3. Call and Leg Mutation

The existing `VoiceCall` state machine remains the only business Call state
machine. G03 adds a Leg state projection used by Call Core; it is not a new
database authority. Opening or restoring a Call projection requires its
durable positive generation. Every Leg, mailbox and timer mutation carries
tenant, Call, owner epoch, generation and expected revision. A mutation either
advances the revision exactly once, returns the original receipt for the same
event ID/hash, or fails closed.

Race decisions are explicit:

- CANCEL before final response sends CANCEL and closes 487 with a non-2xx ACK.
- A racing 2xx after CANCEL is ACKed and then terminated with BYE.
- Every fork attempt has an explicit bounded identity, and the selection input
  accepts only an integer SIP status from 200 through 299. The first durably
  selected fork 2xx is the winner; a late unacknowledged 2xx is ACKed then
  BYE'd, an already acknowledged loser receives only BYE, and remaining early
  branches receive CANCEL.
- Re-INVITE glare returns 491 and uses bounded retry; it does not create a Leg.
- Transfer keeps the old selected Leg until one dedicated atomic selection
  operation durably selects the confirmed replacement and marks the old Leg
  terminating. A generic per-Leg `transfer_commit` event is forbidden. Abort
  restores the exact pre-transfer stable state (`confirmed` or `held`).
- Duplicate BYE/CANCEL/effect identities do not create duplicate CDR or effects.

Per-Call callbacks are synchronous-only at this projection boundary. A thrown
handler or accidentally returned Promise is classified as failed, its
rejection is consumed, and no unrelated Call entry is mutated. Async protocol
work must be represented as durable/bounded work rather than hidden behind a
callback return value.

Per-Call work is bounded. Call/Leg/Dialog lookup is expected O(1); reconciliation
may be O(number of Legs) but the number of Legs has a hard ceiling. No global
active-Call scan belongs to request, timer or RTP hot paths.

## 4. SipFoundation Deep Interface

The public contract is semantic, not an immediate Rust signature freeze:

- `originate` accepts only Converact-owned tenant/Call/Leg/Interaction IDs,
  owner/generation fence, route reference, request URI and immutable SDP offer.
- `answer` binds one Call/Leg/Protocol Dialog and an immutable SDP answer.
- `terminate` carries a normalized hangup cause; a raw backend error is never a
  business cause.
- ingress and egress use one bounded, ordered-per-Protocol-Session envelope
  with event ID/hash dedupe. They cannot mutate Call state before the Call
  authority commits its durable decision.
- SDP crosses the seam only as immutable exact bytes plus SHA-256, role and
  negotiation generation. No parser-owned SDP type crosses the seam.
- runtime timers use a monotonic clock. Snapshots persist semantic timer kind,
  bounded remaining duration and a separate wall-clock audit timestamp, never
  a process-local monotonic instant.
- stable error and hangup categories carry optional SIP/Q.850 codes,
  retryability and bounded Retry-After; secrets, raw wire and backend exception
  strings are forbidden.

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
6. Transaction retransmission replays the exact committed bytes/hash.
7. `snapshot` carries protocol state only. `restore` accepts only a confirmed,
   transaction-quiescent, same-Adapter/runtime snapshot after outer Call-owner
   authority is granted.
8. `drain` stops new Protocol Sessions, preserves existing runtime identity and
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
identities. The corpus existing as bytes is verified locally; rsipstack baseline
semantic capture and future differential rvoip replay are separate evidence
and remain `not_run` until run.

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
| pool size | 256 |
| queue depth | 1,024 |
| retry attempts | 3 |

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
| current | Source contains a bounded seam, exact rsipstack Adapter, ledger and recovery eligibility; live writer activation and complete runtime wiring are not proved |
| target | The complete interface and corpus are frozen; ID/Leg, receipt and drain slices have local implementation, while control-port Adapter activation remains `not_run` |
| production eligible | `false` until physical store, real peers, latency distribution, long-run, fault/OOM, native safety and host performance evidence pass independent review |

No rvoip benchmark, old server result or historical Wave result is inherited.
