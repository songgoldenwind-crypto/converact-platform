# AI outbound R1 durable post-call finalization evidence

> Recorded: 2026-08-31
>
> Evidence class: `local_contract` + `controlled_test_double`
>
> Production eligibility: `false`

This record proves the bounded local Rust post-call finalization slice at Converact commit
`09b542467f9edbc79a3a446158c24882795b1c1c`. It proves that a controlled terminal Attempt is
published together with one post-call job, downstream result/quality work is isolated behind a
durable fenced queue, and an atomic repository rejection leaves neither a terminal projection nor
an orphan job. It does not prove the combined transaction on a physical PostgreSQL database or a
real telephone call.

## Observed scope

- terminal Call progress returns immediately with `post_call_state=pending` and no invented
  transcript count or outcome;
- the core orchestrator returns the terminal aggregate without independently persisting it through
  the intermediate Attempt Store;
- the repository boundary is the only controlled writer of both the terminal Attempt projection
  and its finalization enqueue;
- an injected repository failure leaves the pre-terminal Attempt recoverable and creates neither
  terminal projection nor finalization job;
- jobs have stable content-free identity, generation, retention reference, payload hash and closed
  state transitions;
- claim work is bounded, database-clock based and fenced by owner, token, expiry and revision;
- the Finalization Worker is sequential and bounded, has no Telephony or Media authority, and
  settles `projected`/`incomplete` or records `reconcile_required`;
- D7 final transcript/snapshot/result/evaluation/Bad Case code is reused; unknown effects are
  queried and are never generated a second time;
- authorized Attempt inspection exposes only bounded progress and a stable content-free error code.

## Fresh verification

The machine-readable command ledger is [verification.json](./verification.json). Fresh scoped
results were:

- AI Outbound terminal orchestration and failure semantics: 4 passed, 0 failed;
- Post-call Core and Store behavior/schema contracts: 8 passed, 0 failed;
- inert PostgreSQL tenant-transaction adapter contracts: 2 passed, 0 failed;
- selected Worker terminal/finalization/D7 projection/API contracts: 19 passed, 0 failed;
- scoped Rust Clippy across all touched targets with warnings denied: passed;
- scoped Rust formatting check: passed.

## Explicitly not run

- physical PostgreSQL combined terminal-Attempt update and enqueue transaction;
- physical migration, RLS, trigger, lease expiry and crash-recovery integration;
- concrete production `VoiceAgentRepository` composition and deployed authorization router;
- real Active Call, RustPBX, Speech, SIP/PSTN, media, CDR or recording input;
- real result/evaluation Provider and human review;
- legacy TypeScript writer switch, drain, active-zero and deletion;
- browser, Campaign/Agent dashboard and operations workflow;
- performance, capacity, long-run, fault campaign and production deployment;
- independent code review.

No local Docker was used. No server service, container or deployed code was read, stopped,
restarted or changed. Pre-existing unrelated work was not staged.
