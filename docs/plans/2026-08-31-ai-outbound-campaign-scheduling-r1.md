# AI Outbound Campaign Scheduling and Retry R1 Implementation Plan

> **For agentic workers:** Execute inline with the repository TDD rules. Do not use subagents,
> servers, Docker, broad regression suites or performance tests.

**Goal:** Add the missing Rust authority that plans one physical Attempt per eligible Campaign
contact and creates a separate, delayed Attempt only after a definitive retryable terminal result.

**Architecture:** `ai-outbound-core` owns the closed retry policy and pure planning decision;
`ai-outbound-store` owns tenant-scoped bounded claim and the atomic PostgreSQL insert of a new
Attempt linked to its predecessor. The Voice Agent Worker consumes planned Attempts but cannot
invent retry policy, reuse an Attempt identity, redial an unknown outcome or modify Active Call's
VAD/ASR/LLM/TTS/barge-in behavior.

**Tech stack:** Rust 1.94.1, Tokio, `tokio-postgres`, existing Converact identifiers and PostgreSQL
migration 124.

---

## 1. Frozen behavior

1. Only `busy`, `no_answer`, `rejected`, `failed_before_answer` and policy-approved
   `failed_after_answer` may create a retry candidate.
2. `outcome_unknown` and `reconcile_required` return a stable reconcile-required error and never
   create another physical Attempt.
3. `completed`, `compliance_blocked` and `cancelled` are definitive no-retry outcomes.
4. Every retry has a caller-supplied new `CallAttemptId`, links `previous_attempt_id`, preserves
   `InteractionId`, Campaign Contact, Agent Release and compliance/retention bindings, and starts at
   `execution_generation=1`.
5. Policy bounds: `max_attempts` is 1–20, delay is 1 second–7 days, and attempt arithmetic uses
   checked operations.
6. A retry is inserted only while Campaign is `running` and Contact is not completed, suppressed or
   cancelled.
7. The Store uses one tenant transaction, locks only the previous Attempt and Contact, and returns
   created/replayed/exhausted/not-retryable without scanning a Campaign.
8. Exact replay of the same retry command returns the existing Attempt; identity or payload mismatch
   fails closed.
9. Destination, transcript, prompt, model payload and credentials never enter the retry command,
   logs or metrics.

## 2. File map

- Create `server-rs/crates/ai-outbound-core/src/retry.rs`: bounded policy and pure decision.
- Create `server-rs/crates/ai-outbound-core/tests/retry.rs`: policy, identity and unknown-outcome
  behavior.
- Modify `server-rs/crates/ai-outbound-core/src/lib.rs`: export retry types and stable errors.
- Modify `server-rs/crates/ai-outbound-store/src/postgres.rs`: tenant-transaction retry insert.
- Modify `server-rs/crates/ai-outbound-store/src/lib.rs`: export Store command/result.
- Create `server-rs/crates/ai-outbound-store/tests/retry_contract.rs`: SQL and input contract.
- Modify `server-rs/crates/ai-outbound-store/tests/postgres.rs`: ignored physical PostgreSQL behavior;
  it remains `not_run` without an explicitly isolated database.
- Create `architecture-foundation/ai-outbound/evidence/r1-campaign-scheduling/`: exact local evidence
  and `not_run` matrix after implementation.

## 3. Task 1 — pure retry authority

- [ ] Write a failing `retry.rs` test for a `no_answer` Attempt producing a new planned Attempt with
  a different identity, predecessor link and checked delay.
- [ ] Run only `cargo test -p converact-ai-outbound-core --test retry` and observe the missing API.
- [ ] Implement `RetryPolicy`, `RetryCandidate`, `RetryDecision` and `plan_retry` with the closed
  result classification above.
- [ ] Add focused failures for unknown outcome, exhausted attempts, invalid bounds and
  `failed_after_answer` when policy disables it.
- [ ] Run only the new Core test and commit the Core files.

## 4. Task 2 — durable retry insert

- [ ] Write a failing Store contract test requiring tenant binding, stable idempotency, new Attempt
  identity, predecessor lock, Campaign/Contact gates and no destination input.
- [ ] Implement `PlanRetryAttempt` and `plan_retry` on `AiOutboundStore`; the caller owns the
  tenant transaction and deadline.
- [ ] Use one bounded SQL statement/transaction path to validate the predecessor and insert or
  exactly replay the new `planned` Attempt.
- [ ] Keep the physical PostgreSQL test ignored unless `CONVERACT_TEST_DATABASE_URL` is explicitly
  supplied for an isolated migrated database.
- [ ] Run only `retry_contract` plus compile of the ignored PostgreSQL test, then commit Store files.

## 5. Task 3 — Worker boundary and evidence

- [ ] Add a narrow Worker port that consumes a definitive terminal Attempt and the frozen policy;
  it must not call Telephony when the plan is no-retry, exhausted or reconcile-required.
- [ ] Prove one deterministic retry creates exactly one new Attempt and exact replay creates none.
- [ ] Expose only bounded retry state/reason from the internal Attempt inspection resource.
- [ ] Run the new Worker test, scoped formatting and scoped Clippy only.
- [ ] Record exact commit/toolchain/test counts. Physical PostgreSQL, real Campaign import, real
  RustPBX/Active Call/SIP/PSTN, browser UI, performance and production remain `not_run`.

## 6. Completion boundary

R1 is locally complete only when Core, Store and Worker tests prove all nine frozen behaviors. It is
not production eligible until a physical PostgreSQL transaction, real Campaign/Contact writer,
authorization router, live RustPBX/Active Call call and crash recovery have direct evidence. This
plan does not reimplement any Active Call real-time speech capability.
