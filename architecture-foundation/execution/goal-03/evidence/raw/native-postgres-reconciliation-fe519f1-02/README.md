# Native PostgreSQL SipEffect reconciliation — controlled Linux evidence

- Status: `verified_controlled`
- Successful execution: `2026-08-03T10:52:41+08:00`
- Validation host: `ubuntu@101.42.7.139`
- Converact parent commit: `fe519f184a5b0bf1b92d536c8b31ed26b27c9fd4`
- RustPBX source: `6c49ee76baa54fdbf8f98020cc9bee158c7c15de`
- Candidate patch SHA-256: `f62a5eb59106cd7860b7b0f41d3d1615d4cb79a4e984fd491ee805e8089df8b7`
- Rust builder: `rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55`
- PostgreSQL: `postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb`
- Rust test limit: 2 CPUs, 6 GiB memory
- PostgreSQL limit: 1 CPU, 512 MiB memory

The successful source matched the local candidate exactly:

- `src/call/adapters/postgres_sip_effect.rs`: `66c04248a2106a6e870a4570b3c6ed9b3d06cce19054b0414b17c24fa21960d6`
- `src/call/domain/sip_effect.rs`: `66a89f8b20df5e1de5e5f06107da9651ec5c99fb7697fa947c4376243782e5bb`

Three isolated physical tests ran serially with one test thread:

1. `postgres_prepare_replay_and_query_survive_pool_recreation`
2. `postgres_receipt_transition_is_atomic_replayable_and_recoverable`
3. `postgres_unknown_claim_is_fenced_and_reconciles_after_pool_recovery`

All passed. PostgreSQL was then restarted before separate read-only queries.
The repair fixture remained `protocol_observed` at revision 6 with four
immutable receipts. It retained one repair attempt and epoch high-watermark 11,
while repair owner and claim token were cleared by the fenced atomic receipt.
The PostgreSQL container returned healthy; the temporary Rust container was
removed automatically. The retained successful log is byte-identical to the
server artifact (`c32a82641dbea419a9b6f8819847d91cec4656cb6860ba2ff3c91a53f122471d`).

## Attempt history

The two preceding attempts are retained rather than hidden:

1. `attempt-1-missing-tenant.log` exited 101 before repair execution. The
   PostgreSQL server log identified a missing isolated fixture tenant foreign
   key. Three fixture tenant IDs were then inserted; candidate Rust code was
   unchanged.
2. `attempt-2-semantic-expectation.log` passed prepare and atomic transition,
   then reached the repair assertion. The durable result was correct, but the
   physical test expected `Completed`; both shared TypeScript and Rust contracts
   require `StateObserved` for `Unknown -> ProtocolObserved`. Only that test
   expectation changed before the clean r3 run; production logic did not.

A value-only secret scan found no credential, token, authorization header or
database URL in any retained log. No Docker command ran on the development
machine.

This evidence covers one explicitly addressed effect. It does not implement or
prove a repair batch scanner, terminal attempt-exhaustion/operator workflow,
live SIP dispatch, 100 Trying latency, real peer interoperability, long-call,
fault or capacity gates. Those items and `G03-E16-NATIVE-AUTHORITY` remain
`not_run`; production eligibility is not promoted.
