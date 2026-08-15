# RM01 R1 Event and Idempotency Contract Evidence

## Scope and state

This slice freezes and replays the existing Converact platform event envelope,
inbox ordering decision and durable effect-receipt transition contract in
bounded Rust domain crates.

| State | Evidence-backed result |
| --- | --- |
| Current Authority | The TypeScript sources named and hashed in `platform-event-receipts-v1.json` remain the compatibility oracle. Compatibility policy revision 1 deliberately closes ambiguous cross-runtime inputs before routing. |
| Rust target | `converact-event-log` and `converact-idempotency` reproduce the frozen pure decisions. They are not routed and expose no database or transport capability. |
| Production eligible | No. PostgreSQL event adapters, atomic aggregate-plus-outbox writes, delivery lifecycle, audit persistence, runtime routing and production qualification remain `not_run`. |

The slice does not merge the SIP effect oracle into the generic event system.
SIP, media, Room, Call and Agent Authorities are unchanged.

## Directly proved

- one exact fixture is replayed by the active TypeScript source and both Rust
  crates;
- v1/v2 rolling reads normalize to writer version 2;
- unsupported major versions and unknown effect semantics quarantine;
- additive fields are retained only with explicit `effect_semantics: none`;
- payloads are canonical-hash bound and bounded by bytes, depth and nodes;
- identifiers retain JavaScript UTF-16 length and trim behavior while both
  runtimes reject lone surrogates at the Authority boundary;
- reserved `__proto__` correlation/extension keys fail closed and correlation
  negative zero normalizes to zero in both runtimes;
- timestamps replay JavaScript `Date::toISOString` canonical boundaries and
  do not order aggregate revisions;
- inbox duplicate, conflict, stale, gap and independent ordering-key decisions
  are explicit;
- effect receipts advance only through accepted, completed and state-observed,
  with exact replay, generation and owner-epoch decisions;
- malformed receipt values and raw JSON map to `invalid_transition` before the
  typed compatibility decision;
- audit projection can contain receipt identities only;
- domain types contain no PostgreSQL, NATS, HTTP or vendor SDK type.

The receipt helper is a pure replay decision, not write authorization. The
same-transaction PostgreSQL Authority writer fence and persistent adapter are
the next slice and remain `not_run` here.

## Deliberately not claimed

- PostgreSQL inbox/effect physical behavior for the Rust adapter: `not_run`;
- aggregate mutation plus Outbox atomicity: `not_run`;
- Outbox claim/complete/retry/dead-letter/query/reconcile: `not_run`;
- NATS/JetStream delivery: `not_run`;
- runtime shadow, writer routing, drain or active-zero: `not_run`;
- server, container, performance, capacity and production behavior: `not_run`.

No running server or container was read or changed, and no local Docker or
performance campaign was run.

## Dependency and safety review

The two crates add no new third-party package to `Cargo.lock`. They use only
already-pinned workspace dependencies (`serde`, `serde_json`, `sha2`, `hex`)
and the internal `converact-contracts` crate. Workspace `unsafe_code` remains
forbidden. No native library, build script, network client or runtime task is
introduced by this slice.
