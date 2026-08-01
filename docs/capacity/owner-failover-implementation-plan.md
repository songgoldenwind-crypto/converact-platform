# Converact Fabric Owner Failover Implementation Plan

## Scope

This plan closes the remaining Cell owner-failover correctness gaps without
reimplementing IM, media, notification, voice, or remote-assistance features.
Existing public workflows remain valid. New fields are additive and recovery
requests are conditional on the previously issued owner identity.

## 1. LiveKit room owner rebuild

**Code status:** implemented and covered by controlled tests. Real LiveKit,
TURN, Egress, multi-node failure injection, and recovery SLO evidence remain
`not_run`.

### Invariants

1. A normal token refresh does not move a room.
2. A terminal reconnect may request recovery with the previous
   `reservation_id` and `owner_epoch`.
3. Recovery is attempted only when the authoritative placement snapshot or the
   Cell admission state proves that the previous owner is no longer eligible.
4. Replacement is a PostgreSQL compare-and-swap against the previous
   reservation and epoch.
5. Concurrent reconnects converge on one placement generation.
6. The new reservation is activated before its placement is returned.
7. The previous reservation is closed through a durable, retryable handoff
   record. Failure to contact the previous Cell cannot erase the new owner.
8. Component-node authorization continues to fence stale room operations by
   reservation and owner epoch.
9. Room name and media call identity remain stable across generations.
10. Recovery does not start an Egress job. Existing active-recording
    uniqueness remains authoritative, so reconnect cannot duplicate recording
    jobs.

### Code changes

- Extend placement requests with an owner exclusion list used only during
  recovery.
- Add an authenticated Cell admission state read API client.
- Add owner recoverability inspection to the file-backed placement runtime.
- Add placement generation and durable handoff storage in migration 085.
- Add atomic replacement and handoff reconciliation to
  `InteractionPlacementCoordinator`.
- Add `recoverOwner` to the media placement port and adapter.
- Add conditional recovery fields to the SDK join input.
- Return placement generation and recovery metadata in LiveKit tokens.
- Make the reference client retain the last placement identity and submit it
  only after a terminal disconnect.
- Add the migration to readiness, standalone build context, delivery bundles,
  and source policy.

### Verification

- Unit tests for admission owner exclusion and health inspection.
- Repository/coordinator tests for CAS replacement, concurrent replay, new
  owner activation, old owner close retry, and stale preconditions.
- HTTP tests proving fresh joins stay on the current owner and terminal joins
  recover exactly once.
- Reference-client tests proving recovery metadata is submitted only for a
  terminal rejoin.
- Recording tests proving recovery does not create a second Egress record.
- Capacity, SDK, standalone, delivery, and root typecheck gates.

## 2. RustDesk Windows owner epoch fencing

**Code status:** implemented through package version 6 and native-control v2.
The server command lifecycle, device observation, evidence chain, companion
state, SDK projection, package builder, and native request all carry the exact
owner identity. Real signed artifact compilation and two-Windows execution
remain `not_run`.

### Invariants

1. Every control, clipboard, file-transfer, recording, evidence, and exact
   disconnect command carries `reservation_id`, `interaction_id`, and
   `owner_epoch`.
2. The companion persists the greatest accepted epoch for each exact session.
3. Commands below the persisted epoch fail closed before native execution.
4. A command above the bound server placement also fails closed.
5. Equal-epoch command replay preserves command idempotency.
6. Protocol negotiation permits the existing exact-disconnect protocol only
   when Cell placement is disabled; placement-enabled packages require the
   epoch-capable protocol.

### Code changes

- Version the edge command and native-control payloads.
- Add a durable per-session epoch fence to the Windows companion registry.
  The implementation uses one atomic SHA-256-named state shard per external
  session, avoiding a global O(N) document rewrite and recovering locks left by
  dead companion processes.
- Carry placement identity through edge-agent polling, native named-pipe
  requests, observation correlation, and evidence upload.
- Reject stale clipboard, file-transfer, recording, evidence, and disconnect
  operations before invoking RustDesk native APIs.
- Update packaging, deployment documentation, fixtures, and CI contracts.

### Verification

- Unit tests for stale, equal, future, and replayed epochs.
- Native overlay contract tests for every operation family.
- Windows package tests for placement-enabled protocol enforcement.
- Existing exact-session isolation and evidence correlation regressions.
- Real two-Windows-machine acceptance remains `not_run`.

### Controlled evidence

- RustDesk focused regression: 116 tests passed, 0 failed.
- Owner fence covers stale, equal, higher, replayed, dead-lock recovery, live
  lock exclusion, sharded persistence, and legacy state migration behavior.
- Placement-enabled package generation rejects v1 and requires v2.
- The delivery bundle compiles and includes the owner fence as a standalone
  edge runtime dependency.
- The reference client keeps the 334 KiB initial bundle budget unchanged:
  RustDesk now loads as a 49,775-byte capability chunk only when the remote
  workspace opens, while the initial application chunk is 311,101 bytes.

## External acceptance status

The implementation can prove protocol, persistence, concurrency, and build
contracts locally. Real LiveKit/TURN/Egress failure injection, target
PostgreSQL multi-node failover, Kubernetes Cell recovery, and two-Windows
RustDesk execution remain `not_run` until those environments are available.
