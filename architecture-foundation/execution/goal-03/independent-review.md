# G03 Independent Review

Review status: `interim_code_and_controlled_postgres_reviews_accepted_final_g03_review_pending`
Production eligibility: `false`

## Accepted implementation review

The independent reviewer examined exact implementation commit
`a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb` against accepted baseline
`9fbfbdab1c127e28373fb475cddc2cb3f021172f`. The reviewed diff has SHA-256
`3b68acfccde992669800d6246967b3f193aadf9b03fbec7eaa8f575a928839b0`.
The result was **ACCEPT** with
`Critical 0 / High 0 / Important 0 / Minor 0`.

That review closed the restart-probe races previously found at `6cbe1a3`:

1. the timeout is now a hard process watchdog and cannot leave the probe alive;
2. PostgreSQL identity is sampled only after the accepted write and therefore
   cannot predate the durable boundary being claimed;
3. runtime-role initialization uses one checked-out PostgreSQL client, so the
   transaction and `set_config` scope cannot move across pooled connections.

## Accepted controlled PostgreSQL evidence review

The independent evidence reviewer examined campaign
`converact-g03-pg-restart-a18229cd-02` and the retained, non-sensitive raw
artifacts. The result was **ACCEPT** with
`Critical 0 / High 0 / Important 0 / Minor 0`.

The accepted scope is only `G03-E05-POSTGRES = verified_controlled`: physical
role ACL, outage behavior, an actual restart of the same PostgreSQL system,
separate-process replay without a duplicate Effect/Receipt, exact-source
identity, campaign cleanup and preservation of the nine pre-existing stopped
containers. Full Docker inspect documents were deliberately excluded because
they can contain unrelated environment values; equal normalized digests and
unchanged container IDs are retained instead.

Neither accepted review proves that the TypeScript `VoiceCall`, Call/Leg model,
`RsipstackFoundationAdapter` or PostgreSQL reference ledger is a live native
authority. Unified RustPBX remains the sole active Call/Leg authority;
`G03-E16-NATIVE-AUTHORITY` and the `.43` mailbox patchset are outside those old
reviewed diffs and remain pending exact-source review.

## Rejection history and remaining gate

The earlier `6cbe1a3` evidence review was rejected with
`Critical 0 / High 0 / Important 3 / Minor 0`; all three findings above were
closed and independently accepted at `a18229c`. Earlier implementation review
rejections at `3559afc` and `32a2128` also remain in history; their findings
were closed before the accepted implementation baseline.

This is not the final G03 review. `G03-E15-REVIEW` remains `not_run` until the
100 Trying, wire differential, fault isolation, peer interoperability,
long-call, native authority activation and performance campaigns are either
proved or honestly retained as open external gates, and a reviewer examines
the final exact commit/diff.
Those remaining campaign entries are currently `not_run`; production
eligibility remains false.
