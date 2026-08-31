# AI outbound R1 Dial Policy and Attempt snapshot evidence

Date: 2026-09-01
Scope: local Rust domain/API/store contracts and additive schema inspection
Production eligibility: `false`

## Source identity

- Converact parent commit: `290b539dfa9eed4cded182ac44c89948a40ccd3c`.

## Proven

- One immutable `DialPolicyRevision` binds a bounded revision ID, optional caller ID, a
  `1..=120` second timeout, optional trunk and canonical content hash.
- Caller ID and Contact destination accept only bounded E.164 or SIP/SIPS forms; policy and dial
  binding diagnostics redact caller, destination and trunk values.
- Campaign creation requires the complete policy content. Supplying only a revision string no
  longer reaches the authoring port.
- Additive migration `131` creates tenant-scoped immutable policy authority, preserves rolling
  compatibility for legacy rows and adds a complete dial snapshot to physical Attempts.
- Policy content is immutable. A composite foreign key binds every populated Attempt snapshot to
  the exact policy revision and content hash; a trigger rejects later snapshot mutation.
- Contact import copies destination plus the exact policy revision/hash/caller/timeout/trunk into
  Attempt 1 in the same caller-owned transaction.
- Retry SQL copies the predecessor Attempt's exact dial snapshot. It does not re-read current
  Campaign, Contact defaults or environment configuration.
- `load_dial_binding` performs one tenant-and-Attempt keyed read and validates the stored values
  through the Core dial contract. Missing, legacy-null, partial or malformed rows fail closed.
- The SQLite development schema mirrors policy authority, Attempt placement and composite
  referential identity; a focused test rejects accidental placement of dial fields on Contact.

## Fresh focused verification

Rust 1.94.1 and the workspace lockfile produced:

```text
cargo test --locked -p converact-ai-outbound-core --test authoring
7 passed

cargo test --locked -p converact-ai-outbound-core --test dial_binding
2 passed

cargo test --locked -p converact-ai-outbound-store
14 passed; 3 physical PostgreSQL tests ignored

cargo test --locked -p converact-voice-agent-worker --test campaign_admin_http
5 passed

cargo clippy --locked -p converact-ai-outbound-core -p converact-ai-outbound-store \
  -p converact-voice-agent-worker --lib --tests -- -D warnings
passed

sqlite3 :memory: < src/schema.sql
passed
```

No broad regression suite was run for this narrow slice.

## Explicitly not proved

- physical PostgreSQL migration syntax/execution, RLS, trigger, FK, replay and rollback behavior:
  `not_run`;
- a concrete `CampaignAdminPort`/`AttemptStorePort` composed with `PostgresRuntime`: `not_run`;
- migration/backfill decision for legacy Campaigns and Attempts: legacy Attempts intentionally
  remain non-dialable until explicitly reconciled;
- server/container deployment, real Worker, RustPBX, Active Call, SIP/PSTN or media: `not_run`;
- restart, multi-node, fault injection, performance, capacity, long-run and production:
  `not_run`.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work remains outside this evidence and must not be
staged with the checkpoint.
