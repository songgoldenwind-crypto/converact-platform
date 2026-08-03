# Native PostgreSQL SipEffect transition — controlled Linux evidence

- Status: `verified_controlled`
- Executed: `2026-08-03T10:29:48+08:00`
- Validation host: `ubuntu@101.42.7.139`
- Converact parent commit: `a0ade99558299b11af51cf65a8074f2559a55eed`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- Candidate patch: `rustpbx-converact-postgres-sip-effect-transitions.patch`
- Candidate patch SHA-256: `1e63b0a12f87700707916a8a1856c15dbfd53d1e779a834ddb9606a9ef45d366`
- Rust builder: `rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55`
- PostgreSQL: `postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb`
- Rust test limit: 2 CPUs, 6 GiB memory
- PostgreSQL limit: 1 CPU, 512 MiB memory

The source under test matched the local formatted candidate exactly:

- `src/call/adapters/postgres_sip_effect.rs`: `4c6bb8936236499ea45ccc6466ac57fee8556ba61a71d87179f857a7eb15b709`
- `src/call/domain/sip_effect.rs`: `1f292c63410459ea038783ecf6a2647a9b961777df743848b1db67b9de068bc3`

The isolated database was migrated through migration 107, the frozen writer
identity was activated, and the following ignored physical tests were executed
serially with one test thread:

1. `postgres_prepare_replay_and_query_survive_pool_recreation`
2. `postgres_receipt_transition_is_atomic_replayable_and_recoverable`

Both tests passed. PostgreSQL was then restarted before a separate read-only
verification. The transition fixture remained `protocol_observed` at revision
5, its last receipt was `receipt-server027fb727-observed`, and the tenant had
four immutable receipts. The PostgreSQL container returned healthy after the
restart; the temporary Rust test container was removed automatically.

The retained [postgres-tests.log](postgres-tests.log) is byte-identical to the
server artifact (`d0ae89f2e87c77a4e692cb393a9609ae9e4e2f6b9da66186c0f32f28904441cf`).
A value-only secret scan found no credential, token, authorization header or
database URL. The dependency name `password-hash` is ordinary compiler output.
No Docker command ran on the development machine.

This evidence proves only the native PostgreSQL prepare/query and atomic
transition/restart slice. Repair claim/reconcile, live SIP dispatch, 100 Trying
latency, real peer interoperability, long-call, fault and capacity gates remain
`not_run`. It does not promote `G03-E16-NATIVE-AUTHORITY` or production
eligibility.
