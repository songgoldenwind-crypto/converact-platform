# AI Outbound durable post-call finalization R1

> Status: `physical_atomic_transaction_passed / runnable_composition_not_run / production_not_run`
>
> Date: 2026-08-31
>
> Server implementation language: Rust

**Goal:** Atomically preserve a successfully terminated outbound Call and enqueue its asynchronous
transcript/result/evaluation work, so Speech, model, quality or recording failures cannot turn a
completed telephone interaction into a failed or repeated dial.

## 1. Current defect and target boundary

The initial controlled `VoiceAgentWorker` waited for a simplified `ConversationEvidencePort`
before saving the completed Attempt. That was sufficient for the first tracer bullet, but was not
the target architecture: if evidence retrieval failed after hangup, the Worker returned an error
and the completed Attempt projection was not saved. A later scheduler could misclassify the work
and retry a physical dial.

R1 replaces that coupling with this durable sequence:

```text
CallAttempt reaches terminal state
  -> one PostgreSQL tenant transaction
       update terminal Attempt
       insert/replay PostCallFinalizationJob
       append immutable enqueue receipt
  -> return terminal Call status immediately
  -> independent Finalization Worker claims job
       collect final-only evidence
       freeze snapshot
       project result
       project evaluation/Bad Case
       settle job or mark reconcile_required
```

The transaction is the settlement point. A job is only a durable wake-up and progress record; D7
Conversation Result Store remains the authority for transcript, result, evaluation and Bad Case.

## 2. Authority and invariants

| Domain | Authority | Invariant |
| --- | --- | --- |
| Call/Leg terminal fact | RustPBX plus durable Call Attempt observation | post-call code cannot redial or rewrite Call facts |
| Attempt business terminal state | AI Outbound Store | completion and finalization enqueue commit atomically |
| final transcript/result/evaluation | D7 Conversation Result Store | immutable projection commands and receipts remain authoritative |
| finalization scheduling | PostCallFinalizationJob Store | bounded claim, lease, fence, query and reconcile only |
| Campaign retry | future Retry Planner | no retry while Call outcome or finalization settlement is unknown |

Required invariants:

1. one stable job identity per `(tenant, call_attempt_id)` and exact payload hash;
2. exact enqueue replay returns the existing receipt; same identity/different payload conflicts;
3. job contains IDs, generation and retention policy references, never transcript text, audio,
   prompt, Provider payload, destination or credentials;
4. claim uses database time, bounded batch, `FOR UPDATE SKIP LOCKED`, owner/token/expiry and
   revision fences;
5. stale workers may query but cannot settle or renew another owner's lease;
6. unknown Provider outcome becomes `reconcile_required`; mutation is queried, never blindly run
   again;
7. terminal Attempt save succeeds or fails together with enqueue; no in-memory best-effort gap;
8. finalization failure changes only post-call progress and must not alter Call state, originate,
   terminate, bridge or media;
9. recording remains an independent artifact path; missing recording can degrade evidence without
   deleting transcript or result;
10. no TypeScript service becomes a new writer and no current server process is changed.

## 3. Domain contract

```text
PostCallFinalizationJob
  job_id
  tenant_id
  interaction_id
  call_attempt_id
  agent_release_id
  execution_generation
  retention_policy_ref
  payload_hash
  state: pending | claimed | reconcile_required | completed
  resolution: projected | incomplete | null
  revision
  lease_owner / lease_token_hash / lease_expires_at
  enqueued_at / updated_at / completed_at
```

State transitions:

```text
pending -> claimed
claimed -> completed(projected|incomplete)
claimed -> reconcile_required
reconcile_required -> claimed
expired claimed -> claimed by a new fenced owner
```

`completed(projected)` means every required D7 effect has a state-observed receipt.
`completed(incomplete)` means policy accepted a definitive missing-evidence or Provider-not-applied
outcome. It does not mean the call failed. There is no generic `failed` terminal state that hides
whether reconciliation is still required.

## 4. Worker and API behavior

- `VoiceAgentWorker` constructs a terminal `AttemptResource` with `post_call_state=pending` and no
  invented transcript count or outcome;
- repository persistence changes to one atomic `complete_attempt_and_enqueue` boundary;
- a separate `ConversationFinalizationWorker` owns evidence collection and invokes the existing D7
  `ConversationProjectionRuntime` methods;
- queue/admission failure before the atomic commit returns a durable-store failure, not success;
  after a successful commit, downstream failures never roll back or repeat the call;
- Attempt inspection exposes only bounded progress and stable error code; transcript text remains
  available only from the separately authorized D7 transcript endpoint;
- reconciliation scans only bounded due jobs and terminal attempts missing an enqueue receipt.

## 5. TDD implementation slices

### Slice 1 — Core and wire IDs

1. Add failing tests for bounded job identity, exact payload hash, generation and state transitions.
2. Add `ConversationFinalizationJobId` and pure Core types.
3. Prove invalid transitions, lease-less settlement and revision overflow fail closed.

### Slice 2 — additive Store

1. Add failing schema tests for composite tenant keys, unique Attempt job, immutable receipts, RLS,
   bounded claim and database-clock leases.
2. Add PostgreSQL migration and SQLite development mirror.
3. Implement enqueue/replay/conflict, claim, settle, reconcile and expired-lease recovery.
4. Add a tenant-transaction adapter in `converact-postgres-store`.

### Slice 3 — atomic Call terminal boundary

1. Replace `save_completed_attempt` with `complete_attempt_and_enqueue` in the Rust repository port.
2. Add `post_call_state` to `AttemptResource`; terminal Call returns with `pending` projections.
3. Prove transaction failure creates neither terminal projection nor orphan job.
4. Keep real PostgreSQL `not_run` unless an isolated database is explicitly authorized.

### Slice 4 — Finalization Worker

1. Claim one job and obtain final-only evidence through a typed Rust port.
2. Reuse D7 snapshot/result/evaluation effect oracles; unknown calls query paths only.
3. Settle `projected` or deterministic `incomplete`; transport ambiguity becomes
   `reconcile_required`.
4. Prove failures never call Telephony or change the completed Attempt state.

### Slice 5 — controlled closure and evidence

1. Run one controlled call through terminal Attempt, atomic enqueue and D7 finalization.
2. Cover enqueue replay, crash after claim, unknown Provider, missing evidence and stale lease.
3. Expose bounded post-call progress from the Rust inspection resource.
4. Record exact commit/toolchain/test counts; physical database, real providers, real calls, UI,
   performance and production remain `not_run`.

## 6. Verification boundary

Use only focused Rust tests, formatting and Clippy for the touched packages. Do not run local Docker,
do not connect to or modify a server, do not run performance tests, and do not start a TypeScript
rewrite. The code slice is not production eligible until physical PostgreSQL, real authorization,
real Active Call/Speech/RustPBX input, fault recovery and writer migration have direct evidence.

## 7. Implementation checkpoint

The local Rust checkpoint at `09b542467f9edbc79a3a446158c24882795b1c1c` implements the bounded
job model, additive schema, SQL queue, tenant transaction adapters, independent Finalization
Worker, D7 projection reuse and bounded inspection progress. The terminal aggregate is no longer
persisted through the intermediate `AttemptStorePort`; only the repository
`complete_attempt_and_enqueue` boundary may publish terminal progress. Its controlled failure test
proves that neither a terminal projection nor an orphan job is written when that boundary rejects
the commit.

This checkpoint does **not** prove the combined terminal-Attempt update and enqueue against a
physical PostgreSQL transaction. A concrete PostgreSQL `VoiceAgentRepository`, isolated database
execution, real authorization/router wiring and real call evidence remain `not_run`. Exact local
commands and evidence limits are recorded in
[R1 Post-call Finalization evidence](../../architecture-foundation/ai-outbound/evidence/r1-post-call-finalization/README.md).

## 8. Lease-scoped atomic completion checkpoint

Commit `5d463bc5d0106a05c5564e4818b63d3068349dc5` closes the physical transaction gap without
granting the inspection repository mutation authority. `VoiceAgentWorker` now sends one validated
`TerminalAttemptCommit` to the exact lease-scoped `AttemptCompletionPort`. Its PostgreSQL adapter
updates the previously persisted `conversing` Attempt, binds the Call and channel-agent session,
clears the lease, inserts or exactly replays the deterministic post-call job and appends the
enqueue receipt inside one tenant transaction. Commit/rollback ambiguity remains
`outcome_unknown`; a stale fence cannot publish a terminal state.

A disposable local PostgreSQL 14.18 test proved successful commit, exact replay and rollback of
both the Attempt update and job insert when receipt persistence fails. The test also exposed and
fixed the post-call Store's integer-millisecond SQL parameter type mismatch. Concrete release,
Campaign and Attempt inspection/reconciliation adapters, the bounded claim loop, authenticated
HTTP composition, real Active Call/RustPBX/Speech input, process restart, server deployment and
production remain `not_run`. See
[atomic Attempt finalization evidence](../../architecture-foundation/ai-outbound/evidence/r1-atomic-attempt-finalization/README.md).

## 9. Concrete PostgreSQL Worker repository checkpoint

Commit `36d98adb2d5322014fd5a5088a6730928cacfb0e` closes the in-memory inspection gap. The Rust
Worker now adapts tenant-scoped PostgreSQL Agent Release, Campaign, Attempt and post-call progress
queries into its bounded HTTP resources. Agent Release component digests are revalidated on every
load, and a completed Attempt without its authoritative finalization job is rejected as an invalid
stored projection.

Migration 138 adds content-free, tenant-scoped reconciliation requests with exact idempotency
replay and conflict behavior. A disposable local PostgreSQL 14.18 test exercised all four reads and
writes alongside the atomic terminal-settlement cases; focused local contracts and migration
checksum tests also passed. Runnable binary composition, authenticated production middleware, the
bounded claim loop, reconciliation settlement, real communication inputs, deployment and
performance remain `not_run`. See
[PostgreSQL Worker repository evidence](../../architecture-foundation/ai-outbound/evidence/r1-postgres-worker-repository/README.md).
