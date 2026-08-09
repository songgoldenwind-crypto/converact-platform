# Native PostgreSQL SipEffect repair batch — controlled Linux evidence

- Status: `verified_controlled`
- Captured: `2026-08-03T04:26:36Z`
- Validation host: `ubuntu@101.42.7.139`
- Canonical parent commit: `9688027e5b72011f38f6b375c1ba59c47375998c`
- Candidate source commit: `32955cb43a974d751fc2546ec38d0cad278853e2`
- Candidate source tree: `387240d4b95c3580c038267e967b2495fe06829e`
- Candidate patch SHA-256: `18b7b9ca1248eb63a0c75d83ac231efcb3db4ed9c8c52ec255fd303dbea10f1f`
- Rust builder: `rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55`
- PostgreSQL: `postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb`
- Rust test limit: 2 CPUs, 6 GiB memory, 2 Cargo jobs
- PostgreSQL limit: 1 CPU, 512 MiB memory

The successful server source matched the formatted local candidate exactly:

- `src/call/adapters/postgres_sip_effect.rs`: `40cabf1dc5290220e6c4345ce3b02a3f463dd31a5a6d4851f00e083fae7c085b`
- `src/call/domain/sip_effect.rs`: `fc0bf2870cc34e4c2a29a2e55709a476541cf381afb356a3b69aa6d92576e772`

Four isolated physical PostgreSQL tests ran serially with one test thread:

1. `postgres_prepare_replay_and_query_survive_pool_recreation`
2. `postgres_receipt_transition_is_atomic_replayable_and_recoverable`
3. `postgres_repair_batch_exhausts_after_eight_bounded_attempts`
4. `postgres_unknown_claim_is_fenced_and_reconciles_after_pool_recovery`

All four passed. PostgreSQL was then restarted before a separate read-only
query. The exhaustion fixture remained `unknown` at revision 21 with 11
immutable receipts, repair-attempt count 8 and epoch high-watermark 9. Its due
time, owner and claim token remained cleared; `repair_exhausted_at` remained set,
operator attention remained true, and the deterministic exhaustion hash was
`659d9d0a4688a94bba6ca51d6755180e92be32819b7b3f800cba232a76509872`.
An independent local canonical-JSON calculation produced the same hash.
The PostgreSQL container returned healthy after restart. The temporary Rust
test container was removed automatically.

## Attempt history

Every attempt before the final result is retained:

1. `attempt-1-missing-dependency.log` exited 101 before compilation because the
   first source-only mount omitted the pinned sibling `rustrtc` dependency.
   The server layout was corrected; candidate Rust code did not change.
2. `attempt-2-wrong-session-role.log` exited 101 with all four physical tests
   rejected by the schema compatibility guard. The isolated database URL used
   the PostgreSQL administration session role instead of the elected runtime
   writer role. The test connection identity was corrected without weakening
   the guard.
3. `attempt-3-decode-diagnostic.log` exited 101 for the same session-role cause
   while temporary test-only diagnostics confirmed it. Those diagnostics were
   removed before the final candidate.
4. `attempt-4-ambiguous-candidate.log` exited 101 after three tests passed. The
   new batch test exposed an ambiguous `protocol_effect_id` reference in the
   static array update. The array candidate column was explicitly aliased as
   `candidate_effect_id`; no fence or validation was relaxed.
5. `attempt-5-pre-clippy-success.log` passed all four tests on the preceding
   source. Clippy then identified one collapsible exhaustion guard in a touched
   file. The exact successful source, restart state, host manifest and patch are
   retained, but are not presented as final-source evidence.
6. `attempt-6-cargo-cache-shadow.log` exited 127 before compilation because a
   whole-directory Cargo cache mount hid the image's `cargo` executable. Only
   the registry subdirectory was mounted on the following attempt.
7. `attempt-7-missing-tenants.log` exited 101 after the final Linux build. All
   four inserts correctly failed the foreign key because the new run's four
   isolated tenant fixtures had not been created. The fixtures were inserted
   into the isolated validation database; production code was unchanged.
8. The final `postgres-tests.log` exited 0 with all four tests passing on the
   exact source and patch named above.

The first post-restart receipt-count query used a nonexistent table name. Its
raw error and exit code are retained as `post-run-query-1-wrong-table.*`; the
correct table was then queried read-only and produced the 11-receipt result.

`remote-artifacts.sha256` covers every retained server artifact and the
canonical patch. Local verification of every copied artifact and the canonical
patch hash succeeded. A
value-only secret scan found no credential, token, authorization header,
password-bearing database URL or API key in the retained files. No Docker
command ran on the development machine.

This evidence proves only the bounded native PostgreSQL repair-batch,
attempt-exhaustion and post-restart durability slice. It does not start a live
repair dispatcher or activate live SIP transitions. Raw `100 Trying` latency,
wire differential replay, real-peer interoperability, long-call, fault/OOM and
capacity gates remain `not_run`. `G03-E16-NATIVE-AUTHORITY` and production
eligibility are not promoted.
