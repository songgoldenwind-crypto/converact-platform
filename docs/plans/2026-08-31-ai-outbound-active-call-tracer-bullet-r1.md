# AI Outbound Active Call Tracer Bullet R1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `executing-plans` and
> `test-driven-development` task-by-task. Every implementation step follows a witnessed
> red-green cycle and every commit stages exact files or hunks only.

**Goal:** Deliver the first Rust-owned, industry-neutral AI outbound vertical slice from immutable
Agent Release and Campaign Attempt through compliance, controlled RustPBX/Active Call execution,
AI disclosure, final transcript and durable outcome.

**Architecture:** Converact Rust owns Agent, Campaign, Attempt and outcome state. RustPBX remains
Call/Leg authority, while pinned Active Call runs as a private, replaceable telephone Channel Agent
behind a Rust adapter. The first slice uses controlled ports before enabling real network transport,
then proves the same orchestration against the exact Active Call wire format.

**Tech Stack:** Rust 1.94.1 workspace, Tokio, Serde/JSON, Axum, PostgreSQL, existing Converact
idempotency/event/tenant/mTLS crates, RustPBX RWI/SIP adapter, Active Call 0.3.83 pinned at
`6224d948cc0941ac48b4a5426477aeaf639c2e98`.

---

## 1. Scope and execution boundary

This plan implements the first complete tracer bullet from the accepted design. It does not claim
production capacity, long-run stability, real-provider quality or performance. Those states remain
`not_run`.

Included:

- bounded identifiers and versioned wire contracts;
- immutable Agent Release;
- Campaign and one-physical-dial-per-Attempt state machines;
- pre-dial compliance and Agent capacity ordering;
- Active Call upstream event normalization and command serialization;
- durable Attempt lease, event receipt and reconciliation schema;
- controlled RustPBX and Active Call ports proving the end-to-end orchestration;
- disclosure-before-business-conversation enforcement;
- final transcript and outcome convergence;
- minimum internal HTTP resources for release, attempt and worker inspection;
- exact-source build/test gate and real transport skeleton, without server deployment.

Deferred to follow-on plans:

- Tool Broker/Action Receipt implementation beyond the proposal contract;
- AI -> Human -> AI bridge execution beyond the handoff contract;
- Knowledge/Memory provider implementations;
- Dashboard UI and automatic quality model;
- HF SpeechRuntime replacement;
- real carrier/provider tests, performance, capacity and long stability.

No command in this plan changes the current test server or any running server process. Local Docker
is not used.

## 2. Existing work protection

The canonical worktree already contains unrelated user changes in internal mTLS files and
`server-rs/Cargo.lock`. Before every commit:

```bash
git status --short
git diff --cached --name-only
git diff --cached --check
```

Never stage the existing internal mTLS files. `server-rs/Cargo.lock` contains an existing user hunk
for `converact-internal-mtls-runtime`; new local-package blocks must be reviewed and staged as
separate hunks with `git add -p server-rs/Cargo.lock`. If Cargo rewrites the existing hunk, restore
that hunk to its pre-command working-tree content with `apply_patch`; do not reset or checkout the
file.

## 3. File map

### New Rust crates and app

```text
server-rs/crates/voice-agent-contracts/
  Cargo.toml
  src/lib.rs
  src/id.rs
  src/state.rs
  src/command.rs
  src/event.rs
  tests/identifiers.rs
  tests/wire_contract.rs

server-rs/crates/ai-outbound-core/
  Cargo.toml
  src/lib.rs
  src/agent_release.rs
  src/campaign.rs
  src/call_attempt.rs
  src/compliance.rs
  src/orchestrator.rs
  src/ports.rs
  tests/agent_release.rs
  tests/campaign.rs
  tests/call_attempt.rs
  tests/orchestrator.rs
  tests/support/mod.rs

server-rs/crates/active-call-adapter/
  Cargo.toml
  src/lib.rs
  src/upstream.rs
  src/mapper.rs
  src/command.rs
  src/client.rs
  tests/fixtures/media-ready.json
  tests/fixtures/asr-final.json
  tests/fixtures/function-call.json
  tests/fixtures/hangup.json
  tests/mapping.rs
  tests/command.rs
  tests/support/mod.rs

server-rs/crates/ai-outbound-store/
  Cargo.toml
  src/lib.rs
  src/postgres.rs
  tests/schema.rs
  tests/postgres.rs
  tests/support/mod.rs

server-rs/crates/rustpbx-rwi-adapter/
  Cargo.toml
  src/lib.rs
  src/envelope.rs
  src/client.rs
  tests/envelope.rs
  tests/client.rs
  tests/support/mod.rs

server-rs/apps/converact-voice-agent-worker/
  Cargo.toml
  src/lib.rs
  src/main.rs
  src/http.rs
  tests/tracer_bullet.rs
  tests/http.rs
  tests/support/mod.rs
```

### Modified files

```text
server-rs/Cargo.toml
server-rs/Cargo.lock
src/migrations/124_converact_ai_outbound.sql
src/postgres-migrations.ts
docs/design/README.md
goals/manifest.json
```

No existing TypeScript writer is changed in this tracer bullet. Writer migration begins only after
the Rust controlled slice and compatibility tests pass.

## 4. Canonical types frozen by this plan

```rust
pub struct AgentDefinitionId;
pub struct AgentReleaseId;
pub struct CampaignId;
pub struct CampaignContactId;
pub struct CallAttemptId;
pub struct InteractionId;
pub struct CallId;
pub struct ChannelAgentSessionId;
pub struct EventId;
pub struct IdempotencyKey;

pub struct ExecutionGeneration(u64);

pub enum AgentReleaseState {
    Draft,
    Validating,
    Published,
    Rejected,
    Retired,
}

pub enum CampaignState {
    Draft,
    Scheduled,
    Running,
    Paused,
    Draining,
    Completed,
    Cancelled,
    Archived,
}

pub enum CallAttemptState {
    Planned,
    Claimed,
    ComplianceApproved,
    ComplianceBlocked,
    AgentCapacityReserved,
    Dialing,
    Ringing,
    Answered,
    AgentConnecting,
    DisclosurePending,
    Conversing,
    HandoffPending,
    HumanActive,
    AiResuming,
    Finalizing,
    Completed,
    Cancelled,
    Busy,
    NoAnswer,
    Rejected,
    FailedBeforeAnswer,
    FailedAfterAnswer,
    OutcomeUnknown,
    ReconcileRequired,
}

pub enum AttemptCommand {
    Claim,
    ApproveCompliance,
    BlockCompliance,
    ReserveAgentCapacity,
    Dial,
    ObserveRinging,
    ObserveAnswered,
    AttachAgent,
    AwaitDisclosure,
    CompleteDisclosure,
    StartConversation,
    RequestHandoff,
    CommitHumanHandoff,
    ResumeAi,
    Finalize,
    Complete,
    Cancel,
    MarkBusy,
    MarkNoAnswer,
    MarkRejected,
    MarkFailedBeforeAnswer,
    MarkFailedAfterAnswer,
    MarkOutcomeUnknown,
    RequireReconcile,
    Retry,
}
```

The exact serialized values are lower snake case. Unknown wire enum values fail closed.

## 5. Task plan

### Task 1: Freeze bounded voice-agent identifiers and wire vocabulary

**Files:**

- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create: `server-rs/crates/voice-agent-contracts/Cargo.toml`
- Create: `server-rs/crates/voice-agent-contracts/src/lib.rs`
- Create: `server-rs/crates/voice-agent-contracts/src/id.rs`
- Create: `server-rs/crates/voice-agent-contracts/src/state.rs`
- Create: `server-rs/crates/voice-agent-contracts/src/command.rs`
- Create: `server-rs/crates/voice-agent-contracts/src/event.rs`
- Test: `server-rs/crates/voice-agent-contracts/tests/identifiers.rs`
- Test: `server-rs/crates/voice-agent-contracts/tests/wire_contract.rs`

- [ ] **Step 1: Add failing identifier tests**

```rust
use converact_voice_agent_contracts::{
    CallAttemptId, ExecutionGeneration, IdentityError, InteractionId,
};

#[test]
fn identifiers_accept_only_the_frozen_ascii_grammar() {
    let interaction = InteractionId::parse("interaction-001").unwrap();
    let attempt = CallAttemptId::parse("attempt:001").unwrap();
    assert_eq!(interaction.as_str(), "interaction-001");
    assert_eq!(attempt.as_str(), "attempt:001");
    assert_eq!(InteractionId::parse(""), Err(IdentityError::InvalidIdentifier));
    assert_eq!(CallAttemptId::parse("客户-001"), Err(IdentityError::InvalidIdentifier));
    assert_eq!(CallAttemptId::parse("x".repeat(256)), Err(IdentityError::InvalidIdentifier));
}

#[test]
fn execution_generation_is_positive_and_never_wraps() {
    assert_eq!(ExecutionGeneration::new(0), Err(IdentityError::InvalidGeneration));
    let first = ExecutionGeneration::new(1).unwrap();
    assert_eq!(first.get(), 1);
    assert_eq!(first.next().unwrap().get(), 2);
    assert_eq!(
        ExecutionGeneration::new(u64::MAX).unwrap().next(),
        Err(IdentityError::GenerationExhausted),
    );
}
```

- [ ] **Step 2: Run the test and witness RED**

Run:

```bash
cd server-rs
cargo test -p converact-voice-agent-contracts --test identifiers
```

Expected: Cargo reports that package `converact-voice-agent-contracts` does not exist.

- [ ] **Step 3: Add the crate and minimal identifier implementation**

`Cargo.toml`:

```toml
[package]
name = "converact-voice-agent-contracts"
version.workspace = true
edition.workspace = true
rust-version.workspace = true
license.workspace = true
publish.workspace = true

[dependencies]
serde.workspace = true

[dev-dependencies]
serde_json.workspace = true

[lints]
workspace = true
```

`src/id.rs` must use one private bounded representation, implement the public ID types with a
macro, and expose no unchecked constructor. The accepted grammar is 1-255 bytes,
`[A-Za-z0-9][A-Za-z0-9._:-]*`. `ExecutionGeneration::new` rejects zero and `next` uses
`checked_add`.

- [ ] **Step 4: Add failing wire tests**

```rust
use converact_voice_agent_contracts::{CallAttemptState, CampaignState};

#[test]
fn states_use_closed_lower_snake_case_values() {
    assert_eq!(serde_json::to_string(&CampaignState::Running).unwrap(), "\"running\"");
    assert_eq!(
        serde_json::to_string(&CallAttemptState::DisclosurePending).unwrap(),
        "\"disclosure_pending\"",
    );
    assert!(serde_json::from_str::<CallAttemptState>("\"future_state\"").is_err());
}
```

- [ ] **Step 5: Implement closed state, command and event contracts**

`src/state.rs` defines the enums in section 4 with:

```rust
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CampaignState {
    Draft,
    Scheduled,
    Running,
    Paused,
    Draining,
    Completed,
    Cancelled,
    Archived,
}
```

`src/command.rs` defines the versioned command envelope:

```rust
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommandEnvelope<T> {
    pub schema_version: u16,
    pub tenant_id: String,
    pub interaction_id: InteractionId,
    pub call_attempt_id: CallAttemptId,
    pub agent_release_id: AgentReleaseId,
    pub execution_generation: ExecutionGeneration,
    pub idempotency_key: IdempotencyKey,
    pub trace_id: String,
    pub command: T,
}
```

`src/event.rs` defines `EventEnvelope<T>` with `event_id`, `occurred_at_ms`, `received_at_ms` and
the same authority identifiers. Constructors validate `schema_version == 1`, timestamp ordering,
bounded `trace_id` and all identifiers before returning a value.

- [ ] **Step 6: Run focused tests and workspace lint**

```bash
cd server-rs
cargo test -p converact-voice-agent-contracts
cargo clippy -p converact-voice-agent-contracts --all-targets -- -D warnings
cargo fmt --check
```

Expected: all contract tests pass, Clippy reports no warnings, formatter reports no diff.

- [ ] **Step 7: Commit the isolated contract slice**

Stage the new crate, workspace member and only the new `converact-voice-agent-contracts` lockfile
block. Verify that the existing internal mTLS lock hunk remains unstaged.

```bash
git add server-rs/Cargo.toml server-rs/crates/voice-agent-contracts
git add -p server-rs/Cargo.lock
git diff --cached --check
git diff --cached --name-only
git commit -m "feat(voice): add agent wire contracts"
```

### Task 2: Implement immutable Agent Release

**Files:**

- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create: `server-rs/crates/ai-outbound-core/Cargo.toml`
- Create: `server-rs/crates/ai-outbound-core/src/lib.rs`
- Create: `server-rs/crates/ai-outbound-core/src/agent_release.rs`
- Test: `server-rs/crates/ai-outbound-core/tests/agent_release.rs`

- [ ] **Step 1: Write the Agent Release failing tests**

```rust
mod support;

use converact_ai_outbound_core::{AgentReleaseError, publish_agent};
use support::{agent_draft, release_digests};

#[test]
fn published_release_is_bound_to_every_component_digest() {
    let release = publish_agent(agent_draft(), release_digests()).unwrap();
    assert_eq!(release.state().as_str(), "published");
    assert_eq!(release.content_hash().len(), 64);
    assert_eq!(release.components().tool_schema_hash.len(), 64);
}

#[test]
fn publish_rejects_mutable_or_incomplete_refs() {
    let mut digests = release_digests();
    digests.knowledge_revision_hash.clear();
    assert_eq!(
        publish_agent(agent_draft(), digests),
        Err(AgentReleaseError::InvalidComponentDigest),
    );
}
```

- [ ] **Step 2: Run and witness RED**

```bash
cd server-rs
cargo test -p converact-ai-outbound-core --test agent_release
```

Expected: package or symbols are missing.

- [ ] **Step 3: Implement the minimal publish boundary**

`AgentDraft` contains bounded name, language and exact component revision IDs. The publish function
serializes a private `ReleaseHashInput<'_>` through `converact_contracts::canonical_sha256` and
returns:

```rust
pub struct AgentRelease {
    id: AgentReleaseId,
    definition_id: AgentDefinitionId,
    state: AgentReleaseState,
    content_hash: Box<str>,
    components: ReleaseComponentDigests,
}
```

Only `AgentReleaseState::Published` can be constructed by `publish_agent`. No setter exists. A new
draft creates a new release ID rather than modifying this value.

`tests/support/mod.rs` defines `agent_draft()` and `release_digests()` with fixed IDs and lowercase
SHA-256 values. Later core tests reuse free helper functions rather than adding test-only
constructors to production types.

- [ ] **Step 4: Run focused tests and lint**

```bash
cd server-rs
cargo test -p converact-ai-outbound-core --test agent_release
cargo clippy -p converact-ai-outbound-core --all-targets -- -D warnings
cargo fmt --check
```

- [ ] **Step 5: Commit**

```bash
git add server-rs/Cargo.toml server-rs/crates/ai-outbound-core
git add -p server-rs/Cargo.lock
git diff --cached --check
git commit -m "feat(voice): publish immutable agents"
```

### Task 3: Implement Campaign and physical Call Attempt state machines

**Files:**

- Create: `server-rs/crates/ai-outbound-core/src/campaign.rs`
- Create: `server-rs/crates/ai-outbound-core/src/call_attempt.rs`
- Modify: `server-rs/crates/ai-outbound-core/src/lib.rs`
- Test: `server-rs/crates/ai-outbound-core/tests/campaign.rs`
- Test: `server-rs/crates/ai-outbound-core/tests/call_attempt.rs`

- [ ] **Step 1: Write failing Campaign transition tests**

```rust
mod support;

use converact_ai_outbound_core::{CampaignCommand, DomainError};
use support::{completed_campaign, running_campaign};

#[test]
fn pause_stops_new_claims_but_does_not_cancel_active_attempts() {
    let running = running_campaign();
    let paused = running.apply(CampaignCommand::Pause).unwrap();
    assert!(!paused.accepts_new_attempts());
    assert_eq!(paused.active_attempts(), running.active_attempts());
}

#[test]
fn completed_campaign_cannot_restart() {
    let completed = completed_campaign();
    assert_eq!(completed.apply(CampaignCommand::Start), Err(DomainError::InvalidTransition));
}
```

- [ ] **Step 2: Write failing Attempt tests**

```rust
mod support;

use converact_ai_outbound_core::{AttemptCommand, DomainError};
use support::{no_answer_attempt, outcome_unknown_attempt, planned_attempt};

#[test]
fn attempt_requires_compliance_and_agent_capacity_before_dialing() {
    let planned = planned_attempt();
    assert_eq!(planned.apply(AttemptCommand::Dial), Err(DomainError::InvalidTransition));
    let ready = planned
        .apply(AttemptCommand::Claim).unwrap()
        .apply(AttemptCommand::ApproveCompliance).unwrap()
        .apply(AttemptCommand::ReserveAgentCapacity).unwrap();
    assert!(ready.apply(AttemptCommand::Dial).is_ok());
}

#[test]
fn unknown_outcome_must_reconcile_before_retry() {
    let unknown = outcome_unknown_attempt();
    assert_eq!(unknown.apply(AttemptCommand::Retry), Err(DomainError::ReconcileRequired));
}

#[test]
fn retry_creates_a_new_attempt_identity() {
    let completed = no_answer_attempt();
    let retry = completed.plan_retry("attempt-002").unwrap();
    assert_ne!(retry.id(), completed.id());
    assert_eq!(retry.previous_attempt_id(), Some(completed.id()));
}
```

- [ ] **Step 3: Run and witness RED**

```bash
cd server-rs
cargo test -p converact-ai-outbound-core --test campaign --test call_attempt
```

- [ ] **Step 4: Implement table-driven transitions**

Use exhaustive `match (state, command)` functions. Do not use strings, dynamic maps or a generic
workflow engine for these authority states. Transition methods return new values and increment a
checked domain revision. `CallAttempt::plan_retry` accepts a parsed new ID and preserves the prior
attempt ID only as lineage.

- [ ] **Step 5: Run focused and full core tests**

```bash
cd server-rs
cargo test -p converact-ai-outbound-core
cargo clippy -p converact-ai-outbound-core --all-targets -- -D warnings
cargo fmt --check
```

- [ ] **Step 6: Commit**

```bash
git add server-rs/crates/ai-outbound-core/src server-rs/crates/ai-outbound-core/tests
git diff --cached --check
git commit -m "feat(voice): model campaign attempts"
```

### Task 4: Enforce outbound compliance and disclosure ordering

**Files:**

- Create: `server-rs/crates/ai-outbound-core/src/compliance.rs`
- Modify: `server-rs/crates/ai-outbound-core/src/call_attempt.rs`
- Modify: `server-rs/crates/ai-outbound-core/src/lib.rs`
- Test: `server-rs/crates/ai-outbound-core/tests/compliance.rs`

- [ ] **Step 1: Write failing pre-dial policy tests**

```rust
mod support;

use converact_ai_outbound_core::{
    AttemptCommand, ComplianceDecision, ComplianceReason, DomainError, evaluate_compliance,
};
use support::{compliance_input, disclosure_pending_attempt};

#[test]
fn dnc_and_out_of_window_fail_closed() {
    let mut input = compliance_input();
    input.on_do_not_call_list = true;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::DoNotCall),
    );
    input.on_do_not_call_list = false;
    input.inside_dial_window = false;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::OutsideDialWindow),
    );
}

#[test]
fn all_required_facts_must_be_present() {
    let mut input = compliance_input();
    input.consent_basis = None;
    assert_eq!(
        evaluate_compliance(&input),
        ComplianceDecision::Blocked(ComplianceReason::ConsentUnknown),
    );
}
```

- [ ] **Step 2: Write failing disclosure tests**

```rust
#[test]
fn business_conversation_cannot_start_before_disclosure_completion() {
    let pending = disclosure_pending_attempt();
    assert_eq!(pending.apply(AttemptCommand::StartConversation), Err(DomainError::DisclosureRequired));
    let disclosed = pending.apply(AttemptCommand::CompleteDisclosure).unwrap();
    assert!(disclosed.apply(AttemptCommand::StartConversation).is_ok());
}
```

- [ ] **Step 3: Run RED, implement pure policy, run GREEN**

```bash
cd server-rs
cargo test -p converact-ai-outbound-core --test compliance
cargo test -p converact-ai-outbound-core
```

`ComplianceInput` is a closed struct of already-resolved facts. It does not query the network or
database. Missing consent, timezone, dial window, DNC, frequency or release status fails closed with
a stable reason.

- [ ] **Step 4: Commit**

```bash
git add server-rs/crates/ai-outbound-core/src server-rs/crates/ai-outbound-core/tests/compliance.rs
git diff --cached --check
git commit -m "feat(voice): gate outbound disclosure"
```

### Task 5: Normalize the exact Active Call 0.3.83 protocol

**Files:**

- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create: `server-rs/crates/active-call-adapter/Cargo.toml`
- Create: `server-rs/crates/active-call-adapter/src/lib.rs`
- Create: `server-rs/crates/active-call-adapter/src/upstream.rs`
- Create: `server-rs/crates/active-call-adapter/src/mapper.rs`
- Create: `server-rs/crates/active-call-adapter/src/command.rs`
- Create fixtures and tests listed in section 3.

- [ ] **Step 1: Copy exact wire fixtures as data, not upstream source**

`media-ready.json`:

```json
{"event":"mediaReady","trackId":"track-001","timestamp":1000}
```

`asr-final.json`:

```json
{"event":"asrFinal","trackId":"track-001","timestamp":1100,"index":1,"text":"你好","confidence":0.98}
```

`function-call.json`:

```json
{"event":"functionCall","trackId":"track-001","callId":"tool-call-001","name":"lookup_customer","arguments":"{\"customer_id\":\"c-1\"}","timestamp":1200}
```

`hangup.json`:

```json
{"event":"hangup","trackId":"track-001","timestamp":1300,"startTime":"2026-08-31T00:00:00Z","hangupTime":"2026-08-31T00:01:00Z"}
```

- [ ] **Step 2: Write failing mapping tests**

```rust
mod support;

use converact_active_call_adapter::{NormalizedEvent, normalize_event};
use support::adapter_context;

#[test]
fn final_asr_is_durable_but_delta_is_ephemeral() {
    let event = normalize_event(
        &adapter_context(3),
        include_str!("fixtures/asr-final.json"),
    ).unwrap();
    assert!(matches!(event, NormalizedEvent::TranscriptFinal { index: 1, .. }));
    assert_eq!(event.execution_generation().get(), 3);
}

#[test]
fn function_call_becomes_a_proposal_not_an_executed_effect() {
    let event = normalize_event(
        &adapter_context(3),
        include_str!("fixtures/function-call.json"),
    ).unwrap();
    assert!(matches!(event, NormalizedEvent::ToolProposed { .. }));
}

#[test]
fn unknown_upstream_event_fails_closed() {
    let result = normalize_event(
        &adapter_context(3),
        r#"{"event":"newDangerousEvent","timestamp":1}"#,
    );
    assert_eq!(result.unwrap_err().code(), "active_call_event_unknown");
}
```

- [ ] **Step 3: Run and witness RED**

```bash
cd server-rs
cargo test -p converact-active-call-adapter --test mapping
```

- [ ] **Step 4: Implement a private upstream enum and explicit mapper**

`upstream.rs` deserializes only the events used by the first slice using
`#[serde(tag = "event", rename_all = "camelCase")]`. `mapper.rs` exhaustively maps them to the
canonical contract and validates track IDs, tool name, JSON argument byte limit, transcript byte
limit and timestamps. No upstream Rust type escapes the crate.

`tests/support/mod.rs` builds a fully parsed `AdapterContext` with fixed tenant, interaction,
attempt, release, session and generation values. It contains no production-only constructor.

- [ ] **Step 5: Write command serialization tests**

```rust
use converact_active_call_adapter::{AdapterCommand, encode_command};

#[test]
fn disclosure_is_encoded_as_one_bounded_tts_command() {
    let json = encode_command(AdapterCommand::PlayDisclosure {
        text: "您好，我是 AI 助手，本次通话可能会被录音。".to_owned(),
        play_id: "disclosure-001".to_owned(),
    }).unwrap();
    assert_eq!(json["command"], "tts");
    assert_eq!(json["playId"], "disclosure-001");
    assert_eq!(json["autoHangup"], false);
}
```

- [ ] **Step 6: Run focused tests, Clippy and source comparison**

```bash
cd server-rs
cargo test -p converact-active-call-adapter
cargo clippy -p converact-active-call-adapter --all-targets -- -D warnings
cargo fmt --check
git -C /Users/songjinfeng/Projects/converact-sources/active-call rev-parse HEAD
git -C /Users/songjinfeng/Projects/converact-sources/active-call rev-parse HEAD^{tree}
```

Expected commit/tree are exactly the values in `infra/converact/active-call/source-lock.json`.

- [ ] **Step 7: Commit**

```bash
git add server-rs/Cargo.toml server-rs/crates/active-call-adapter
git add -p server-rs/Cargo.lock
git diff --cached --check
git commit -m "feat(voice): normalize Active Call events"
```

### Task 6: Add durable AI outbound schema and store

**Files:**

- Create: `src/migrations/124_converact_ai_outbound.sql`
- Modify: `src/postgres-migrations.ts`
- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create: `server-rs/crates/ai-outbound-store/Cargo.toml`
- Create: `server-rs/crates/ai-outbound-store/src/lib.rs`
- Create: `server-rs/crates/ai-outbound-store/src/postgres.rs`
- Test: `server-rs/crates/ai-outbound-store/tests/schema.rs`
- Test: `server-rs/crates/ai-outbound-store/tests/postgres.rs`

- [ ] **Step 1: Write the failing schema contract test**

```rust
#[test]
fn migration_has_attempt_identity_lease_fence_and_event_receipts() {
    let sql = include_str!("../../../../src/migrations/124_converact_ai_outbound.sql");
    for required in [
        "converact_agent_releases",
        "converact_outbound_campaigns",
        "converact_outbound_call_attempts",
        "converact_outbound_attempt_events",
        "execution_generation",
        "lease_owner",
        "lease_expires_at",
        "idempotency_key",
        "payload_hash",
        "ENABLE ROW LEVEL SECURITY",
        "FORCE ROW LEVEL SECURITY",
    ] {
        assert!(sql.contains(required), "missing {required}");
    }
}
```

- [ ] **Step 2: Run and witness RED**

```bash
cd server-rs
cargo test -p converact-ai-outbound-store --test schema
```

- [ ] **Step 3: Add additive rolling schema**

The SQL creates release, campaign, contact, attempt and event tables. Attempt has distinct
`id`, `previous_attempt_id`, `interaction_id`, optional `call_id`, `execution_generation`, state,
lease owner/token digest/expiry, revision and timestamps. Unique constraints cover tenant-scoped ID,
event ID, attempt idempotency key and `(tenant_id, campaign_contact_id, attempt_number)`. Claim index
is partial on `planned` and ordered by `scheduled_for, id`.

RLS policies use the existing `opc_current_tenant()`/`opc_rls_bypass()` contract. The migration is
additive and does not alter legacy tables.

- [ ] **Step 4: Write failing PostgreSQL behavior tests**

```rust
mod support;

use support::{TestDatabase, tenant};

#[ignore = "requires an isolated PostgreSQL database"]
#[tokio::test]
async fn claim_uses_database_clock_and_skip_locked() {
    let database = TestDatabase::required().await;
    let store = database.ai_outbound_store();
    let first = store.claim_planned(&tenant("tenant-a"), "worker-a", 30_000, 10).await.unwrap();
    let second = store.claim_planned(&tenant("tenant-a"), "worker-b", 30_000, 10).await.unwrap();
    assert!(first.iter().all(|item| !second.contains(item)));
}

#[ignore = "requires an isolated PostgreSQL database"]
#[tokio::test]
async fn stale_fence_cannot_advance_attempt() {
    let database = TestDatabase::required().await;
    let store = database.ai_outbound_store();
    let lease = store.claim_one_fixture("worker-a").await.unwrap();
    store.expire_and_reclaim_fixture(&lease, "worker-b").await.unwrap();
    assert_eq!(
        store.advance_with_lease(&lease, "dialing").await.unwrap_err().code(),
        "ai_outbound_lease_stale",
    );
}
```

- [ ] **Step 5: Implement atomic store statements**

Claim uses one transaction with `FOR UPDATE SKIP LOCKED`, database-clock expiry and bounded limit.
Every state mutation predicates tenant, attempt ID, revision, generation, owner and unexpired lease.
Event insert uses event ID plus payload hash; same ID/same hash replays, same ID/different hash
conflicts.

`tests/support/mod.rs` wraps the existing PostgreSQL testkit and requires
`CONVERACT_TEST_DATABASE_URL` to point at an isolated disposable database. It never defaults to the
application or server database.

- [ ] **Step 6: Run schema test locally and PostgreSQL test only when configured**

```bash
cd server-rs
cargo test -p converact-ai-outbound-store --test schema
CONVERACT_TEST_DATABASE_URL="$ISOLATED_TEST_DATABASE_URL" \
  cargo test -p converact-ai-outbound-store --test postgres -- --ignored
```

If no isolated PostgreSQL URL is provided, the PostgreSQL result is recorded `not_run`; do not point
the test at the running shared server.

- [ ] **Step 7: Commit**

```bash
git add src/migrations/124_converact_ai_outbound.sql src/postgres-migrations.ts
git add server-rs/Cargo.toml server-rs/crates/ai-outbound-store
git add -p server-rs/Cargo.lock
git diff --cached --check
git commit -m "feat(voice): persist outbound attempts"
```

### Task 7: Build the controlled end-to-end orchestration

**Files:**

- Create: `server-rs/crates/ai-outbound-core/src/ports.rs`
- Create: `server-rs/crates/ai-outbound-core/src/orchestrator.rs`
- Modify: `server-rs/crates/ai-outbound-core/src/lib.rs`
- Test: `server-rs/crates/ai-outbound-core/tests/orchestrator.rs`

- [ ] **Step 1: Write the failing happy-path ordering test**

```rust
mod support;

use support::Harness;

#[tokio::test]
async fn reserve_precedes_dial_and_disclosure_precedes_conversation() {
    let harness = Harness::new();
    harness.run_one_attempt().await.unwrap();
    assert_eq!(
        harness.operations(),
        [
            "compliance.check",
            "agent.reserve",
            "rustpbx.originate",
            "rustpbx.answered",
            "agent.attach",
            "agent.media_ready",
            "agent.disclosure",
            "agent.disclosure_completed",
            "agent.start_conversation",
            "rustpbx.terminal",
            "outcome.finalize",
        ],
    );
}
```

- [ ] **Step 2: Write failing fault tests**

```rust
#[tokio::test]
async fn unavailable_agent_prevents_customer_dial() {
    let harness = Harness::with_agent_reservation_failure();
    let result = harness.run_one_attempt().await;
    assert_eq!(result.unwrap_err().code(), "agent_capacity_unavailable");
    assert_eq!(harness.rustpbx_originate_count(), 0);
}

#[tokio::test]
async fn crash_after_originate_reconciles_before_retry() {
    let harness = Harness::crash_after_originate();
    assert_eq!(harness.run_one_attempt().await.unwrap_err().code(), "outcome_unknown");
    assert_eq!(harness.retry_count(), 0);
    harness.reconcile().await.unwrap();
    assert_eq!(harness.retry_count(), 0);
}
```

- [ ] **Step 3: Define narrow ports**

```rust
use std::future::Future;

pub trait CompliancePort {
    fn evaluate(&self, attempt: &CallAttempt) -> Result<ComplianceDecision, PortError>;
}

pub trait ChannelAgentPort {
    fn reserve(&self, request: ReserveAgent)
        -> impl Future<Output = Result<AgentReservation, PortError>> + Send;
    fn confirm_attachment(&self, request: AgentLegBinding)
        -> impl Future<Output = Result<(), PortError>> + Send;
    fn play_disclosure(&self, request: PlayDisclosure)
        -> impl Future<Output = Result<(), PortError>> + Send;
    fn start_conversation(&self, request: StartConversation)
        -> impl Future<Output = Result<(), PortError>> + Send;
    fn query(&self, session: &ChannelAgentSessionId)
        -> impl Future<Output = Result<AgentObservation, PortError>> + Send;
}

pub trait TelephonyPort {
    fn originate(&self, request: OriginateCall)
        -> impl Future<Output = Result<CallObservation, PortError>> + Send;
    fn add_agent_leg(&self, request: AgentLegBinding)
        -> impl Future<Output = Result<(), PortError>> + Send;
    fn query(&self, call_id: &CallId)
        -> impl Future<Output = Result<CallObservation, PortError>> + Send;
    fn terminate(&self, request: TerminateCall)
        -> impl Future<Output = Result<(), PortError>> + Send;
}

pub trait AttemptStorePort {
    fn load(&self, attempt_id: &CallAttemptId)
        -> impl Future<Output = Result<CallAttempt, PortError>> + Send;
    fn load_dial_binding(&self, attempt_id: &CallAttemptId)
        -> impl Future<Output = Result<OutboundDialBinding, PortError>> + Send;
    fn persist_intent(&self, attempt: &CallAttempt)
        -> impl Future<Output = Result<(), PortError>> + Send;
    fn persist_observation(&self, attempt: &CallAttempt)
        -> impl Future<Output = Result<(), PortError>> + Send;
}
```

The actual Rust code uses stable futures accepted by the workspace Rust version; it must not add a
runtime-wide event bus or spawn one task per event.

- [ ] **Step 4: Implement the smallest orchestrator**

The orchestrator advances one leased Attempt through explicit steps and persists each intent before
issuing the corresponding effect. A timeout returns `OutcomeUnknown` and schedules reconciliation;
it never equates timeout with failure.

`tests/support/mod.rs` defines `Harness` from in-memory implementations of the four narrow ports.
Each implementation records a fixed operation enum in a bounded vector and exposes counters used by
the tests; it does not sleep, use the network or share global state.

- [ ] **Step 5: Run all core tests**

```bash
cd server-rs
cargo test -p converact-ai-outbound-core
cargo clippy -p converact-ai-outbound-core --all-targets -- -D warnings
cargo fmt --check
```

- [ ] **Step 6: Commit**

```bash
git add server-rs/crates/ai-outbound-core/src server-rs/crates/ai-outbound-core/tests/orchestrator.rs
git diff --cached --check
git commit -m "feat(voice): orchestrate outbound calls"
```

### Task 8: Add the private Active Call client and exact-source gate

**Files:**

- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create: `server-rs/crates/active-call-adapter/src/client.rs`
- Modify: `server-rs/crates/active-call-adapter/src/lib.rs`
- Test: `server-rs/crates/active-call-adapter/tests/client.rs`
- Create: `scripts/verify-active-call-source.sh`

- [ ] **Step 1: Write a failing source gate test command**

```bash
bash scripts/verify-active-call-source.sh \
  /Users/songjinfeng/Projects/converact-sources/active-call \
  /Users/songjinfeng/Projects/converact-sources/active-call-archives/active-call-6224d948cc0941ac48b4a5426477aeaf639c2e98.tar.gz
```

Expected before the script exists: shell reports no such file.

- [ ] **Step 2: Implement the source gate without printing secrets**

The script reads `infra/converact/active-call/source-lock.json` and verifies repository commit, tree,
clean detached HEAD, archive SHA-256 and expected size. It exits nonzero on mismatch and prints only
component ID plus pass/fail fields.

- [ ] **Step 3: Write private-client tests against an in-process fake**

```rust
mod support;

use converact_active_call_adapter::{ActiveCallClient, ClientConfig, ClientFailureKind};
use support::{CommandFixture, FakeActiveCall};

#[tokio::test]
async fn client_rejects_non_loopback_plaintext_endpoint() {
    let error = ActiveCallClient::connect(
        ClientConfig::new("http://10.0.0.8:8080", 2_000, 64).unwrap(),
    ).await.unwrap_err();
    assert_eq!(error.code(), "active_call_plaintext_not_loopback");
}

#[tokio::test]
async fn command_timeout_returns_unknown_not_failed() {
    let fake = FakeActiveCall::timeout_commands().await;
    let client = ActiveCallClient::connect(fake.config()).await.unwrap();
    assert_eq!(
        client.send_command(CommandFixture::disclosure()).await.unwrap_err().kind(),
        ClientFailureKind::OutcomeUnknown,
    );
}
```

- [ ] **Step 4: Implement bounded client transport**

The first client uses the upstream `/command/{id}`, `/events/{id}` and `/list` surfaces, with
loopback HTTP allowed and TLS required otherwise. Connection, request and event sizes are bounded.
Retries apply only to status queries; mutation timeouts become unknown and reconcile. No raw Active
Call response crosses the adapter.

- [ ] **Step 5: Run adapter and source tests**

```bash
cd server-rs
cargo test -p converact-active-call-adapter
cargo clippy -p converact-active-call-adapter --all-targets -- -D warnings
cd ..
bash scripts/verify-active-call-source.sh \
  /Users/songjinfeng/Projects/converact-sources/active-call \
  /Users/songjinfeng/Projects/converact-sources/active-call-archives/active-call-6224d948cc0941ac48b4a5426477aeaf639c2e98.tar.gz
```

- [ ] **Step 6: Build and test exact upstream locally**

```bash
ACTIVE_CALL_BUILD_DIR="$(mktemp -d)"
tar -xf \
  /Users/songjinfeng/Projects/converact-sources/active-call-archives/active-call-6224d948cc0941ac48b4a5426477aeaf639c2e98.tar.gz \
  -C "$ACTIVE_CALL_BUILD_DIR" --strip-components=1
cd "$ACTIVE_CALL_BUILD_DIR"
cargo generate-lockfile
shasum -a 256 Cargo.lock
cargo test --locked
```

Because upstream currently has no lockfile, generate and test inside the temporary exact-archive
tree, record the lockfile SHA-256 in local evidence and review dependency/license output. Do not
copy or commit the upstream source into Converact, and keep the pinned development checkout clean.
If upstream tests require unavailable native/model dependencies,
record the precise result and keep the affected gate `not_run` or `blocked_external`.

- [ ] **Step 7: Commit Converact adapter only**

```bash
git add scripts/verify-active-call-source.sh server-rs/crates/active-call-adapter
git add server-rs/Cargo.toml
git add -p server-rs/Cargo.lock
git diff --cached --check
git commit -m "feat(voice): connect private Active Call"
```

### Task 9: Port the bounded RustPBX RWI client to Rust

**Files:**

- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create: `server-rs/crates/rustpbx-rwi-adapter/Cargo.toml`
- Create: `server-rs/crates/rustpbx-rwi-adapter/src/lib.rs`
- Create: `server-rs/crates/rustpbx-rwi-adapter/src/envelope.rs`
- Create: `server-rs/crates/rustpbx-rwi-adapter/src/client.rs`
- Create: `server-rs/crates/rustpbx-rwi-adapter/tests/envelope.rs`
- Create: `server-rs/crates/rustpbx-rwi-adapter/tests/client.rs`
- Create: `server-rs/crates/rustpbx-rwi-adapter/tests/support/mod.rs`

- [ ] **Step 1: Write failing RWI envelope tests**

```rust
use converact_rustpbx_rwi_adapter::{
    BridgeRequest, OriginateRequest, RwiCommand, encode_command,
};

#[test]
fn originate_and_bridge_use_the_frozen_rwi_v1_actions() {
    let originate = encode_command(RwiCommand::Originate(OriginateRequest {
        action_id: "attempt-001:originate".to_owned(),
        to: "+8613800138000".to_owned(),
        from: Some("+8610000000000".to_owned()),
        timeout_seconds: 30,
        interaction_id: "interaction-001".to_owned(),
    })).unwrap();
    assert_eq!(originate["action"], "call.originate");
    assert_eq!(originate["action_id"], "attempt-001:originate");
    assert_eq!(originate["params"]["to"], "+8613800138000");

    let bridge = encode_command(RwiCommand::Bridge(BridgeRequest {
        action_id: "attempt-001:bridge".to_owned(),
        leg_a: "leg-customer".to_owned(),
        leg_b: "leg-active-call".to_owned(),
    })).unwrap();
    assert_eq!(bridge["action"], "call.bridge");
    assert_eq!(bridge["params"]["leg_a"], "leg-customer");
    assert_eq!(bridge["params"]["leg_b"], "leg-active-call");
}

#[test]
fn bridge_rejects_the_same_leg_twice() {
    let result = encode_command(RwiCommand::Bridge(BridgeRequest {
        action_id: "attempt-001:bridge".to_owned(),
        leg_a: "leg-a".to_owned(),
        leg_b: "leg-a".to_owned(),
    }));
    assert_eq!(result.unwrap_err().code(), "rustpbx_bridge_legs_invalid");
}
```

- [ ] **Step 2: Run and witness RED**

```bash
cd server-rs
cargo test -p converact-rustpbx-rwi-adapter --test envelope
```

- [ ] **Step 3: Implement the closed RWI subset**

The first Rust adapter supports only `session.subscribe`, `session.list_calls`, `call.originate`,
`call.hangup` and `call.bridge`. It validates identifier length, E.164/SIP destination, timeout,
distinct bridge legs, maximum payload bytes and forbidden secret-key names. Unsupported commands
return `capability_unavailable`; they never fall through to arbitrary action strings.

- [ ] **Step 4: Write failing WebSocket outcome tests**

```rust
mod support;

use converact_rustpbx_rwi_adapter::{ClientConfig, CommandOutcome, RustPbxRwiClient};
use support::FakeRwiServer;

#[tokio::test]
async fn matching_action_receipt_completes_the_command() {
    let server = FakeRwiServer::success().await;
    let client = RustPbxRwiClient::connect(server.config()).await.unwrap();
    let outcome = client.originate(server.originate_request()).await.unwrap();
    assert!(matches!(outcome, CommandOutcome::Succeeded { .. }));
}

#[tokio::test]
async fn timeout_is_uncertain_and_not_safe_to_replay() {
    let server = FakeRwiServer::without_receipt().await;
    let client = RustPbxRwiClient::connect(ClientConfig {
        command_timeout_ms: 25,
        ..server.config()
    }).await.unwrap();
    let outcome = client.originate(server.originate_request()).await.unwrap();
    assert!(matches!(outcome, CommandOutcome::Uncertain { .. }));
}
```

- [ ] **Step 5: Implement bounded RWI transport**

Pin `tokio-tungstenite = 0.30.0`, require `/rwi/v1`, reject credentials in URLs, allow plaintext
`ws` only on loopback/private internal-service configuration, and require `wss` otherwise. Use
bounded message size, bounded pending actions, connect/command/heartbeat deadlines and one reader
task owned by the client lifecycle. A response matches exactly one action ID; a timeout or disconnect
after send returns `Uncertain` and requires query/reconcile.

Bearer material is resolved from an existing Secret Ref abstraction and is never stored in the
command envelope, Debug output, metric or error.

- [ ] **Step 6: Run focused tests and lint**

```bash
cd server-rs
cargo test -p converact-rustpbx-rwi-adapter
cargo clippy -p converact-rustpbx-rwi-adapter --all-targets -- -D warnings
cargo fmt --check
```

- [ ] **Step 7: Commit**

```bash
git add server-rs/Cargo.toml server-rs/crates/rustpbx-rwi-adapter
git add -p server-rs/Cargo.lock
git diff --cached --check
git commit -m "feat(voice): add RustPBX RWI adapter"
```

### Task 10: Add the voice-agent worker and internal inspection API

**Files:**

- Modify: `server-rs/Cargo.toml`
- Modify exact hunk: `server-rs/Cargo.lock`
- Create all files under `server-rs/apps/converact-voice-agent-worker/` from section 3.

- [ ] **Step 1: Write the failing controlled tracer-bullet test**

```rust
mod support;

use support::TestWorker;

#[tokio::test]
async fn one_attempt_reaches_completed_with_disclosure_and_final_transcript() {
    let app = TestWorker::controlled().await;
    let release = app.publish_fixture_agent().await;
    let campaign = app.create_fixture_campaign(release.id()).await;
    let attempt = app.run_one_contact(campaign.id()).await.unwrap();
    assert_eq!(attempt.state().as_str(), "completed");
    assert!(attempt.disclosure_completed());
    assert_eq!(attempt.final_transcript_segments(), 2);
    assert_eq!(attempt.outcome().unwrap().code(), "customer_interested");
    assert_eq!(app.telephony().originate_count(), 1);
}
```

- [ ] **Step 2: Write failing inspection API tests**

```rust
mod support;

use support::TestWorker;

#[tokio::test]
async fn attempt_resource_is_tenant_scoped_and_no_store() {
    let app = TestWorker::controlled().await;
    let response = app.get_attempt("tenant-a", "attempt-001").await;
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(app.get_attempt("tenant-b", "attempt-001").await.status(), 404);
}
```

- [ ] **Step 3: Run and witness RED**

```bash
cd server-rs
cargo test -p converact-voice-agent-worker --test tracer_bullet --test http
```

- [ ] **Step 4: Implement bounded worker lifecycle**

The app owns a fixed worker count, bounded claim size, shutdown token and readiness dependencies.
It reuses `converact-runtime-health`, `converact-internal-mtls-runtime`, tenant authentication and
observability. Readiness is false when the durable store or Agent reservation path cannot accept new
work, but established RustPBX/Active Call media is not terminated by readiness changes.

Internal routes:

```text
GET /internal/v1/voice-agent/releases/{id}
GET /internal/v1/voice-agent/campaigns/{id}
GET /internal/v1/voice-agent/attempts/{id}
POST /internal/v1/voice-agent/attempts/{id}/reconcile
GET /internal/v1/voice-agent/workers
GET /livez
GET /readyz
```

Mutation routes require an idempotency key and tenant context. Raw phone number, audio, Prompt,
provider key and complete transcript are excluded from logs and health responses.

`tests/support/mod.rs` assembles the worker with an in-memory store and controlled Telephony and
Channel Agent ports. It exposes only deterministic fixture creation, HTTP requests and operation
counters used by `tracer_bullet.rs` and `http.rs`.

- [ ] **Step 5: Run worker and relevant workspace tests**

```bash
cd server-rs
cargo test -p converact-voice-agent-worker
cargo test -p converact-ai-outbound-core
cargo test -p converact-active-call-adapter
cargo test -p converact-rustpbx-rwi-adapter
cargo clippy -p converact-voice-agent-worker --all-targets -- -D warnings
cargo fmt --check
```

- [ ] **Step 6: Commit**

```bash
git add server-rs/Cargo.toml server-rs/apps/converact-voice-agent-worker
git add -p server-rs/Cargo.lock
git diff --cached --check
git commit -m "feat(voice): run outbound agent worker"
```

### Task 11: Freeze compatibility and functional evidence

**Files:**

- Create: `test/ai-outbound-rust-contract.test.ts`
- Create: `src/agent-runtime/converact/contact-center/ai-outbound-compat.ts`
- Modify: `src/agent-runtime/converact/contact-center/index.ts`
- Create: `architecture-foundation/ai-outbound/evidence/r1-tracer-bullet/README.md`
- Create: `architecture-foundation/ai-outbound/evidence/r1-tracer-bullet/verification.json`
- Modify: `docs/design/2026-08-31-ai-outbound-active-call-platform-r1.md`
- Modify: `docs/design/README.md`
- Modify: `goals/manifest.json`

- [ ] **Step 1: Write the failing legacy compatibility test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { mapLegacyOutboundTask } from
  '../src/agent-runtime/converact/contact-center/ai-outbound-compat.js';

const legacy = {
  tenant_id: 'tenant-a',
  agent_spec_id: 'agent-a',
  campaign_id: 'campaign-a',
  campaign_contact_id: 'contact-a',
  language: 'zh-CN',
  max_attempts: 3,
  status: 'pending' as const,
};

test('legacy retry maps to a new physical attempt identity', () => {
  const first = mapLegacyOutboundTask(legacy, {
    attempt_id: 'attempt-001',
    attempt_number: 1,
    previous_attempt_id: null,
  });
  const retry = mapLegacyOutboundTask(legacy, {
    attempt_id: 'attempt-002',
    attempt_number: 2,
    previous_attempt_id: first.call_attempt_id,
  });
  assert.equal(first.tenant_id, legacy.tenant_id);
  assert.equal(first.agent_definition_id, legacy.agent_spec_id);
  assert.equal(first.language, legacy.language);
  assert.equal(first.max_attempts, legacy.max_attempts);
  assert.equal(first.state, 'planned');
  assert.notEqual(retry.call_attempt_id, first.call_attempt_id);
  assert.equal(retry.previous_attempt_id, first.call_attempt_id);
});
```

- [ ] **Step 2: Run and witness RED**

```bash
node --import ./test/explicit-dev-auth.mjs --import tsx --test \
  test/ai-outbound-rust-contract.test.ts
```

- [ ] **Step 3: Add the compatibility mapper at the existing boundary**

`ai-outbound-compat.ts` exports closed `LegacyOutboundMappingInput`, `AttemptLineageInput` and
`RustOutboundAttemptProjection` interfaces plus `mapLegacyOutboundTask`. The function validates the
same bounded identifier grammar as the Rust wire contract, converts only legacy `pending` to Rust
`planned`, copies exact tenant/Agent/Campaign/contact/language/retry fields and requires a distinct
attempt ID for `attempt_number > 1`. It throws `legacy_outbound_attempt_lineage_invalid` when a retry
has no predecessor or reuses its predecessor ID. Do not switch the production writer in this task.

- [ ] **Step 4: Run the complete functional verification set**

```bash
cd server-rs
cargo test -p converact-voice-agent-contracts
cargo test -p converact-ai-outbound-core
cargo test -p converact-active-call-adapter
cargo test -p converact-ai-outbound-store --test schema
cargo test -p converact-rustpbx-rwi-adapter
cargo test -p converact-voice-agent-worker
cargo clippy -p converact-voice-agent-contracts -p converact-ai-outbound-core -p converact-active-call-adapter -p converact-ai-outbound-store -p converact-rustpbx-rwi-adapter -p converact-voice-agent-worker --all-targets -- -D warnings
cargo fmt --check
cd ..
node --import ./test/explicit-dev-auth.mjs --import tsx --test \
  test/ai-outbound-rust-contract.test.ts
bash scripts/verify-active-call-source.sh \
  /Users/songjinfeng/Projects/converact-sources/active-call \
  /Users/songjinfeng/Projects/converact-sources/active-call-archives/active-call-6224d948cc0941ac48b4a5426477aeaf639c2e98.tar.gz
```

- [ ] **Step 5: Write evidence from actual outputs**

`verification.json` records exact Converact commit, Active Call commit/tree/archive hash, command,
exit status, test counts and explicit `not_run` values for PostgreSQL, real RustPBX, real Active Call,
PSTN, provider, performance, capacity and production deployment when absent. Never write expected
results as observed evidence.

- [ ] **Step 6: Update design implementation status and manifest hashes**

Mark only the implemented and freshly verified rows. Keep real integration and production rows
`not_run`. Recompute every modified source-artifact SHA-256 referenced by `goals/manifest.json` and
validate all manifest paths/hashes.

- [ ] **Step 7: Request independent code review and fix findings**

Review Authority boundaries, state transitions, failure semantics, tenant isolation, secret
handling, bounded work, test evidence and staged-file scope. Re-run the full verification set after
any change.

- [ ] **Step 8: Commit evidence and compatibility separately**

```bash
git add test/ai-outbound-rust-contract.test.ts \
  src/agent-runtime/converact/contact-center/ai-outbound-compat.ts \
  src/agent-runtime/converact/contact-center/index.ts
git commit -m "test(voice): freeze outbound compatibility"
git add architecture-foundation/ai-outbound/evidence/r1-tracer-bullet
git add docs/design/2026-08-31-ai-outbound-active-call-platform-r1.md docs/design/README.md goals/manifest.json
git diff --cached --check
git commit -m "docs(voice): record outbound tracer bullet"
```

## 6. Completion gate

The tracer bullet is complete only when:

- every Task 1-11 checkbox is supported by fresh command output;
- the controlled end-to-end Attempt reaches one durable terminal state;
- pre-dial Agent reservation and disclosure ordering tests pass;
- duplicate, stale-generation and unknown-outcome tests pass;
- Active Call wire fixtures match the pinned upstream serialization;
- source identity is still exact and upstream claims are not borrowed;
- unrelated user files remain unstaged and unchanged by this work;
- server deployment and performance states remain `not_run` unless separately authorized and run.

After this gate, create follow-on plans in this order:

1. Tool Broker, approval and Action Receipt;
2. AI -> Human -> AI durable handoff;
3. Knowledge, Memory, outcome evaluation and Dashboard;
4. real RustPBX/Active Call/provider functional qualification;
5. HF SpeechRuntime overlap replacement;
6. performance, capacity and long-run qualification.
