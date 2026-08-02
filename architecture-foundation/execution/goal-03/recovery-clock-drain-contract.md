# G03 Recovery, Clock, Rolling Schema and Drain Contract

## 1. Recovery Scope

V1 restores only a confirmed Protocol Dialog that is transaction-quiescent and
uses the exact same Adapter runtime identity. The outer durable Call-owner CAS
must grant the new owner before protocol restore mutates anything.

Recovery is unavailable when any of the following is true:

- early, terminated or unknown Protocol Dialog state;
- active INVITE or non-INVITE transaction;
- pending 2xx ACK, PRACK, DNS, candidate or connect attempt;
- active protocol timer;
- unknown protocol effect;
- dead or non-restorable connection;
- schema mismatch, Adapter change or source/binary/config/capability digest drift.

Unavailable recovery is recorded as failure/repair/drain according to policy; it
is never renamed successful takeover. Socket, connection and runtime `Instant`
values are never persisted.

## 2. Owner and Replay

Every restored Call projection opens at the positive uint64 generation loaded
from durable authority; generation `1` is never assumed. Every restored
mutation validates the owner epoch, Protocol Session/Leg generation and command
sequence. A stale owner may query but cannot send, reconcile, enqueue mailbox
work, register timers or mutate. The new owner uses compare-and-swap against
the durable generation; split-brain writers fail closed.

Duplicate event ID plus identical hash returns the prior receipt. Identical ID
with a different hash is a conflict. Sequence gaps stop mutation and enter
bounded query/reconcile; they do not guess missing effects.
The hash is lowercase SHA-256 over RFC 8785 JCS UTF-8 bytes of the closed event
envelope with only its `event_hash` member omitted; it is never caller prose or
a hash of a selected payload subset.

Timer restoration uses the captured duration and elapsed monotonic evidence.
Downtime is subtracted once. Expired timers return zero remaining duration and
run the declared protocol timeout policy; wall time never recreates a runtime
deadline.

## 3. Clock Domains

| Clock | Allowed use | Forbidden use |
| --- | --- | --- |
| monotonic | timeout, retry, lease duration inside one process; captured elapsed evidence | audit timestamp, cross-process absolute instant |
| wall/UTC | immutable audit time, human operations, persisted observation time | timeout progression or lease validity without monotonic/authority evidence |
| database | durable ordering/commit observation inside one Region transaction | RTP/SIP packet timing |
| RTP/media clock | packet timestamp and quality calculations | Call ownership or durable audit order |

Wall-clock jump/skew changes audit display but cannot extend a monotonic
deadline. NTP offset is evidence, not a persisted runtime `Instant`.

## 4. Rolling Schema

Every Call Session, Leg projection, Protocol Dialog snapshot, effect/receipt and
recovery capsule carries a schema identity. A new writer version requires:

1. registered schema ID/version/hash and activation receipt;
2. N and N+1 reader compatibility proof;
3. live-reader inventory with no unknown reader;
4. idempotent per-object migration receipt;
5. rollback writer/read matrix;
6. retention of old bytes until readers, recovery and rollback references reach zero.

Unknown fields follow the version's closed-schema rule. An incompatible object
is drained by the old binary or fails closed; it is never guessed into a new
shape. The current physical v1 writer activation remains `not_run`.

## 5. Drain State Machine

```text
accepting
  -- start_drain --> draining
draining
  -- active_protocol_sessions == 0 --> active_zero
active_zero
  -- rollback_window_closed + unknown/repair == 0 --> deletion_eligible
```

Rules:

- `start_drain` is idempotent and atomically prevents new Protocol Sessions.
- A new session reserves its ID and capacity before invoking any Adapter
  getter/callback. The reservation counts as active during reentrancy, so drain
  cannot observe false active-zero; same-ID reentry fails closed.
- Existing sessions keep the Adapter source/binary/config/capability identity
  with which they started.
- Existing Call media is not forced through another Adapter.
- Session/open-failure release is O(1); active-zero is the O(1) sum of committed
  sessions and opening reservations, not a table scan.
- A drain deadline produces `drain_timed_out` evidence but does not force
  BYE/CANCEL, change authority or authorize dependency deletion.
- Rollback re-enables new placement only through an explicit generation change;
  stale placement receipts remain fenced.
- rsipstack deletion additionally requires G06 proof and rollback-window closure.

## 6. Crash-point Matrix

| Point | Durable fact | Restart action | Duplicate-effect rule |
| --- | --- | --- | --- |
| before durable decision | prepared effect may exist, no visible send allowed | discard or replay prepare using same identity | no send |
| after durable decision, before send | durable decision exists | commit same prepared bytes under current owner fence | same identity |
| send attempted, result known rejected | failure receipt | return prior terminal result | no retry with new identity |
| send attempted, result unknown | unknown receipt and repair due | query then fenced reconcile | blind resend forbidden |
| transport accepted, protocol incomplete | local accepted receipt | transaction query/timer policy | exact-byte retransmission only |
| protocol complete | terminal receipt/tombstone | replay terminal receipt | no duplicate CDR/effect |

Physical crash/restart, rolling binary and long-call evidence are separately
tracked; this document freezes behavior but does not claim those campaigns ran.
