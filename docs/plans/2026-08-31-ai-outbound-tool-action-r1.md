# AI Outbound Tool Broker and Action Receipt Implementation Plan

> **For agentic workers:** Execute inline task-by-task with TDD. Do not dispatch subagents unless the user explicitly requests delegation.

**Goal:** Build the Rust Tool Proposal → Policy/Approval → idempotent Action → Receipt path shared by every Converact Agent channel.

**Architecture:** Add a focused `converact-tool-broker-core` domain crate behind narrow catalog, schema, policy, approval, durable store and action-adapter ports. Reuse the existing generic Effect Receipt/Outbox persistence semantics through the store adapter; Active Call remains proposal-only.

**Tech Stack:** Rust 1.94.1, Tokio, serde/serde_json, existing Converact canonical JSON, identity, idempotency, outbox and PostgreSQL boundaries.

---

## Testing rule

Use four behavior tests for the four frozen invariants in the design. Run only the new crate, directly changed shared crates and schema tests. Do not run broad regression, performance, capacity, Docker or server tests without a concrete failure signal.

### Task 1: Freeze shared Tool identities and Proposal contract

**Files:**

- Modify `server-rs/Cargo.toml`
- Modify the exact new-package hunk in `server-rs/Cargo.lock`
- Modify `server-rs/crates/voice-agent-contracts/src/id.rs`
- Modify `server-rs/crates/voice-agent-contracts/src/lib.rs`
- Modify `server-rs/crates/voice-agent-contracts/src/command.rs`
- Create `server-rs/crates/tool-broker-core/Cargo.toml`
- Create `server-rs/crates/tool-broker-core/src/lib.rs`
- Create `server-rs/crates/tool-broker-core/src/proposal.rs`
- Create `server-rs/crates/tool-broker-core/tests/proposal.rs`

- [ ] Write one failing test covering canonical argument digest mismatch, invalid deadline and the 64 KiB bound.
- [ ] Run `cargo test -p converact-tool-broker-core --test proposal` and confirm it fails because the Proposal contract is absent.
- [ ] Add `ToolRevisionId`, `ToolCallId`, `ApprovalId` and `ActionReceiptId` using the existing bounded ID macro; add read-only `EnvelopeContext` accessors needed by the Broker.
- [ ] Implement `ToolProposal::try_new`, recomputing `canonical_sha256_with_max_bytes(arguments, 65_536)` and retaining only validated bounded values.
- [ ] Run the Proposal test, `cargo test -p converact-voice-agent-contracts`, scoped Clippy and format.
- [ ] Commit only these files as `feat(agent): define tool proposals`.

### Task 2: Implement Policy, Approval and exact authority binding

**Files:**

- Create `server-rs/crates/tool-broker-core/src/definition.rs`
- Create `server-rs/crates/tool-broker-core/src/approval.rs`
- Create `server-rs/crates/tool-broker-core/src/ports.rs`
- Create `server-rs/crates/tool-broker-core/tests/policy.rs`
- Create `server-rs/crates/tool-broker-core/tests/support/mod.rs`

- [ ] Write one failing test: a high-risk mutation without an exact unexpired Approval returns `approval_required` and records zero Action calls.
- [ ] Run only `cargo test -p converact-tool-broker-core --test policy` and witness the expected failure.
- [ ] Implement closed `ToolEffectClass`, `ToolRisk`, `PolicyDecision`, `ToolDefinition` and `ApprovalGrant` types. Bind Approval to tenant, Interaction, Attempt, generation, Tool Revision, Tool Call, Schema hash, arguments hash and expiry.
- [ ] Define narrow Catalog, Schema, Policy, Approval, Store and Action ports. No port accepts an arbitrary URL or raw secret.
- [ ] Implement fail-closed pre-execution resolution and make high-risk policy impossible to downgrade when Approval is missing, expired, revoked or mismatched.
- [ ] Run the Policy test and scoped Clippy/format.
- [ ] Commit as `feat(agent): gate tool actions`.

### Task 3: Implement prepare/execute/finalize and replay

**Files:**

- Create `server-rs/crates/tool-broker-core/src/receipt.rs`
- Create `server-rs/crates/tool-broker-core/src/broker.rs`
- Create `server-rs/crates/tool-broker-core/tests/broker.rs`
- Modify `server-rs/crates/tool-broker-core/tests/support/mod.rs`

- [ ] Write one failing test asserting `store.prepare`, `action.execute`, `store.finalize` order and exactly one execute across an identical replay.
- [ ] Run only that test and witness the expected failure.
- [ ] Implement `ActionReceipt`, `PrepareDecision`, `ActionObservation`, `BrokerResult` and `ToolBroker::execute`. The Store returns the only execute permission; replay returns its immutable Receipt.
- [ ] Preserve stable low-cardinality errors and exclude Proposal arguments and Tool result values from `Debug` and errors.
- [ ] Run the Broker test and scoped Clippy/format.
- [ ] Commit as `feat(agent): execute idempotent tools`.

### Task 4: Implement unknown-outcome reconciliation and generation fence

**Files:**

- Modify `server-rs/crates/tool-broker-core/src/broker.rs`
- Modify `server-rs/crates/tool-broker-core/src/ports.rs`
- Create `server-rs/crates/tool-broker-core/tests/reconcile.rs`
- Modify `server-rs/crates/tool-broker-core/tests/support/mod.rs`

- [ ] Write one failing test where execute returns `OutcomeUnknown`, the next invocation calls query instead of execute, and a finalized old-generation result is `Historical`.
- [ ] Run only the reconciliation test and witness the expected failure.
- [ ] Implement reconcile-only recovery, atomic finalization after definitive query and current-generation result consumption.
- [ ] Run the four new behavior tests and scoped Clippy/format; do not run unrelated regression suites.
- [ ] Commit as `feat(agent): reconcile tool outcomes`.

### Task 5: Add durable schema and PostgreSQL adapter

**Files:**

- Create `src/migrations/125_converact_tool_actions.sql`
- Modify `src/schema.sql`
- Create `server-rs/crates/tool-broker-store/Cargo.toml`
- Create `server-rs/crates/tool-broker-store/src/lib.rs`
- Create `server-rs/crates/tool-broker-store/src/postgres.rs`
- Create `server-rs/crates/tool-broker-store/tests/schema.rs`

- [ ] Write one failing schema test proving tenant composite keys, Proposal/Approval binding columns, payload digest conflict protection, accepted/completed/state-observed receipts, generation fence, leases, RLS and bounded claim index.
- [ ] Run only the schema test and witness the expected failure.
- [ ] Add the migration/development schema and a tenant-transaction-owned Adapter implementing atomic prepare/finalize/reconcile without exposing SQL or credentials in errors.
- [ ] Run schema tests and compile the Store. Run physical PostgreSQL tests only if a dedicated disposable test database is explicitly available; otherwise record `not_run`.
- [ ] Commit as `feat(agent): persist tool actions`.

### Task 6: Connect normalized Active Call proposals to the Worker

**Files:**

- Modify `server-rs/apps/converact-voice-agent-worker/Cargo.toml`
- Create `server-rs/apps/converact-voice-agent-worker/src/tool_runtime.rs`
- Modify `server-rs/apps/converact-voice-agent-worker/src/lib.rs`
- Create `server-rs/apps/converact-voice-agent-worker/tests/tool_runtime.rs`

- [ ] Write one focused test mapping a normalized Active Call `ToolProposed` event into the Broker while proving the Adapter itself performs zero business effects.
- [ ] Run only the focused Worker test and witness the expected failure.
- [ ] Implement the event-to-Proposal bridge, preserve EnvelopeContext/generation and send only a `Consumable` ToolResult back to the current Agent session.
- [ ] Run the new Worker test plus the four Broker tests and scoped Clippy/format.
- [ ] Commit as `feat(voice): broker agent tool proposals`.

### Task 7: Record exact evidence

**Files:**

- Create `architecture-foundation/ai-outbound/evidence/r1-tool-action/README.md`
- Create `architecture-foundation/ai-outbound/evidence/r1-tool-action/verification.json`
- Modify `docs/design/2026-08-31-ai-outbound-tool-action-r1.md`
- Modify `docs/design/README.md`
- Modify `goals/manifest.json`

- [ ] Run only directly scoped tests, Clippy and format once after the final code change.
- [ ] Record exact commit, commands, pass/fail counts and evidence class. Keep real providers, physical PostgreSQL, real Active Call, SIP/PSTN, performance, capacity and production as `not_run` unless actually observed.
- [ ] Recompute and validate every manifest-referenced file hash.
- [ ] Commit as `docs(agent): record tool action evidence`.
