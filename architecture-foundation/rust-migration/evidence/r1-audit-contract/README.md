# RM01 R1 — Rust audit pure-contract evidence

Status: `implemented_offline_default_disabled`, not production eligible and not
wired into any database writer, HTTP route, worker, container or running
service.

This slice freezes the existing TypeScript audit service/store boundary as a
bounded Rust value model. It validates already-normalized append records,
computes the tenant-local chained event hash and decides append, exact replay
or idempotency conflict. It does not become a second Audit Authority: the
existing TypeScript/PostgreSQL path remains the only active writer.

## Frozen compatibility

- The exact current TypeScript audit types, normalizer, PostgreSQL store,
  canonical serializer and migration are source-hashed in both the fixture and
  this evidence manifest.
- Four static vectors are executed through the active TypeScript PostgreSQL
  store and the Rust implementation. They cover first and linked events,
  denied/policy outcomes, Unicode values, empty IP HMAC, retention/legal hold,
  nested metadata and Node 24 `en-US` metadata-key collation.
- Rust preserves the existing replay rule: a repeated idempotency key is
  compared using the stored event's `occurred_at`; changed content conflicts.
- Raw source IPs cannot be represented by the Rust append type. The boundary
  accepts only an empty value or a lowercase 64-character HMAC digest.
- Metadata remains a bounded plain JSON object with the existing key grammar,
  depth, array, UTF-16 string and 32,768-byte limits. Secret/PII keys and direct
  email/phone values fail closed.
- ECMAScript rather than Rust Unicode trim semantics are used for normalized
  text. The PII phone detector also uses the ECMAScript whitespace set.
- The legacy serializer's locale-sensitive key order is isolated behind a
  closed `[A-Za-z0-9_.-]` comparator. General Unicode collation is deliberately
  rejected; no ICU/native dependency was added.

## TDD and direct verification

The development log records independent RED failures for the missing fixture,
missing Rust API, U+0085 trim behavior, Node 24 key ordering and non-breaking
space phone detection before each minimal implementation.

On the final exact working tree:

- the affected TypeScript audit and cross-runtime suite passed 10/10 under
  Node 24.15.0;
- TypeScript typecheck passed;
- the Rust audit and canonical-contract focused suites passed 10/10;
- the entire Rust workspace all-target test command passed; 19 tests requiring
  isolated PostgreSQL remained explicitly ignored by their existing gates;
- workspace strict Clippy, Rust formatting and `git diff --check` passed.

No Docker, remote host, server mutation, running-service change, load test or
performance campaign was used.

## Remaining gates (`not_run`)

- raw request normalization, IP HMAC key custody and a dedicated Rust service
  boundary;
- the PostgreSQL append/list implementation, tenant advisory lock, immutable
  trigger/RLS and physical hash-chain/replay tests;
- fenced writer route, shadow comparison, new-work cutover, single-writer
  proof, drain, reconcile, active-zero and TypeScript deletion;
- list cursor and JSONL export migration;
- exact production Node-image locale/ICU replay and rolling compatibility;
- server, fleet, fault, performance and production qualification.
