# G02 Platform Foundation Implementation Plan

> 执行约束：每个 runtime 行为先写一条会因缺少该行为而失败的测试，确认失败原因，再写最小实现。
> 每个提交只包含本任务列出的精确文件；不启动 G03，不修改生产环境，不推送。

**Goal:** 建立 Tenant/Identity/Consent/Event/Audit/Effect/Billing/Key/Observability/Clock/Resilience
横向基础，并把未执行的真实故障、长稳、容量和 DR 证据保持为 `not_run`。

**Architecture:** 新建小型 `platform-foundation` deep module，提供纯判定、不可变状态迁移和窄
repository contract；复用现有 RLS、audit、retention、worker、recording、readiness 与 backup primitive。
普通 RTP/SRTP 不导入该模块，不创建共享大事务或第二业务 Authority。

**Tech stack:** TypeScript ESM、Node test runner、AJV 2020、PostgreSQL/RLS migration、现有
`PgQueryable`/`withPgTenant`、Prometheus/OpenTelemetry。

---

## 1. Exact file map

### Create

- `src/agent-runtime/converact/platform-foundation/clock.ts` — wall/monotonic deadline contract。
- `src/agent-runtime/converact/platform-foundation/identity.ts` — identity claims 与 fail-closed access decision。
- `src/agent-runtime/converact/platform-foundation/policy.ts` — consent evidence/lease/purpose/region decision。
- `src/agent-runtime/converact/platform-foundation/event-envelope.ts` — v2 envelope、N/N-1、unknown/replay decision。
- `src/agent-runtime/converact/platform-foundation/effect-receipt.ts` — accepted/completed/state-observed transition。
- `src/agent-runtime/converact/platform-foundation/billing-ledger.ts` — deterministic billing key 与 immutable append decision。
- `src/agent-runtime/converact/platform-foundation/key-lifecycle.ts` — key/cert lifecycle、rotation 与 secret sink policy。
- `src/agent-runtime/converact/platform-foundation/correlation.ts` — correlation、metric label allowlist、redaction。
- `src/agent-runtime/converact/platform-foundation/resilience.ts` — O(1) bounded admission/bulkhead state。
- `src/agent-runtime/converact/platform-foundation/fault-policy.ts` — dependency→media/degradation/recovery policy。
- `src/agent-runtime/converact/platform-foundation/index.ts` — only public exports。
- `src/agent-runtime/converact/platform-foundation/postgres-event-receipt-store.ts` — tenant-scoped outbox/inbox/receipt adapter。
- `src/agent-runtime/converact/platform-foundation/postgres-billing-ledger-store.ts` — tenant-scoped immutable usage adapter。
- `src/migrations/108_converact_platform_identity_consent.sql`
- `src/migrations/109_converact_platform_event_receipts.sql`
- `src/migrations/110_converact_platform_usage_ledger.sql`
- `src/migrations/111_converact_platform_key_lifecycle.sql`
- focused tests named in Tasks 2–10。
- `services/converact-service/acceptance/platform-fault-matrix/README.md` — reproducible acceptance contract only；
  executable harness is added only after local fault policy passes。

### Modify narrowly

- `src/middleware/auth.ts` — production cannot implicitly fall back to dev Header identity。
- `src/recording-policy.ts` — consent unknown/store failure denies new recording without terminating call。
- `src/agent-runtime/converact/placement/component-node-sync.ts` — default monotonic clock uses the platform monotonic port。
- `src/metrics.ts` — remove new high-cardinality usage; existing legacy series remain compatibility-only and documented。
- `src/agent-runtime/converact/operations/readiness.ts` — expose capability-specific foundation readiness without
  making optional dependency failure a liveness failure。
- `src/agent-runtime/converact/standalone-source-policy.ts` or the exact standalone migration policy file resolved
  by `rg "107_ivekit_sip_effect_oracle"` — append migrations 108–111 after 107。

### Explicitly not modified

- SIP/RTPengine/LiveKit/codec/Engagement/Profile/Agent business implementations。
- frozen production worktree or either legacy source worktree。
- ordinary media packet path。

## 2. Task D0 — Contract and trace freeze

**Files:** all files under `architecture-foundation/execution/goal-02/`.

- [x] Write `goal-02-contract.test.mjs` first and run it with machine contracts absent.
- [x] Verify expected RED: one binding test passed and eight tests failed because required artifacts were absent.
- [x] Generate strict contracts/schemas and exact 543-row G00 trace through `generate-goal-02.mjs`.
- [x] Run `node architecture-foundation/execution/goal-02/generate-goal-02.mjs` twice and verify the second run
  leaves no diff.
- [x] Run `node --test architecture-foundation/execution/goal-02/goal-02-contract.test.mjs`; expected 9/9 pass
  after the plan and initial review record exist.
- [x] Commit only this directory as `docs(platform): freeze G02 foundation contracts` after review of the diff.

## 3. Task T1 — Wall/monotonic clock

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/clock.ts`.
- Create `test/converact-platform-clock.test.ts`.
- Modify `src/agent-runtime/converact/placement/component-node-sync.ts` only after focused tests prove its current
  default can move backward.

Desired API:

```ts
export interface PlatformClock {
  wallNow(): Date;
  monotonicNowMs(): number;
}

export interface PlatformDeadline {
  started_wall_at: string;
  expires_wall_at: string;
  monotonic_started_ms: number;
  duration_ms: number;
}

export function createPlatformDeadline(
  clock: PlatformClock,
  durationMs: number,
  maxDurationMs: number
): PlatformDeadline;

export function platformDeadlineState(
  clock: PlatformClock,
  deadline: PlatformDeadline
): 'active' | 'expired' | 'restart_reauthorization_required' | 'clock_invalid';
```

- [x] RED: backward/forward wall jumps do not change a 5-second monotonic deadline; monotonic reversal returns
  `restart_reauthorization_required`; NaN/negative clocks return `clock_invalid`; duration above max is rejected.
- [x] Run `node --import tsx --test test/converact-platform-clock.test.ts`; expected failure because module is absent.
- [x] GREEN: implement using `performance.now()` for system monotonic time and `Date` only for durable UTC fields.
- [x] Re-run the focused test; expected pass with no timers or sleeps.
- [x] Add a regression test showing `ComponentNodeSynchronizer` timeout is unaffected by injected wall jump, then
  change only its default monotonic source.
- [x] Run `test/converact-component-node-sync.test.ts` plus the new clock test.

## 4. Task T2 — Identity and tenant fail-closed decision

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/identity.ts`.
- Create `test/converact-platform-identity-isolation.test.ts`.
- Modify `src/middleware/auth.ts`.

Desired decision input:

```ts
export type IdentityKind = 'human' | 'service' | 'workload' | 'edge' | 'provider';

export interface PlatformIdentityClaims {
  tenant_id: string;
  identity_id: string;
  identity_kind: IdentityKind;
  session_id: string;
  token_id: string;
  issuer: string;
  audience: string[];
  key_id: string;
  issued_at: string;
  not_before: string;
  expires_at: string;
  policy_version: number;
  revocation_epoch: number;
  role: string;
  capabilities: string[];
  purpose: string[];
  credential_strength: 'signed_token' | 'mtls';
}

export function evaluatePlatformAccess(input: {
  claims: PlatformIdentityClaims;
  resource_tenant_id: string;
  required_audience: string;
  required_capability: string;
  required_purpose: string;
  current_policy_version: number;
  current_revocation_epoch: number;
  wall_now: Date;
}): { allowed: true } | { allowed: false; reason: string };
```

- [x] RED one behavior per test: tenant mismatch; missing/blank required claim; wrong audience; unknown capability;
  wrong purpose; before `not_before`; expired; stale policy; stale revocation; service request without mTLS-equivalent
  strength. Every case returns deny and never throws raw claim content.
- [x] RED compatibility test: with `NODE_ENV=production`, no issuer/JWT secret and no explicit valid auth must throw
  401 instead of accepting `X-Tenant-Id`.
- [x] Run the two focused auth tests and confirm failure occurs at the expected assertions.
- [x] GREEN implement the pure O(1) evaluator with bounded identifier/array limits and no I/O.
- [x] GREEN change `resolveAuthContext` so production never enters implicit dev context; retain explicit non-production
  compatibility only under the documented rollout gate.
- [x] Run `test/auth-middleware.test.ts`, `test/db-pg-tenant.test.ts`, and the new identity test.
- [x] Verify no new authority is added to `auth-http.ts` or RBAC store; they remain adapters/projections.

## 5. Task T3 — Consent lease and recording fail-closed adapter

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/policy.ts`.
- Create `test/converact-platform-consent-policy.test.ts`.
- Modify `src/recording-policy.ts` and `test/recording-policy.test.ts`.

Desired API:

```ts
export type ConsentScope =
  | 'phone_audio' | 'video' | 'recording' | 'transcription'
  | 'translation' | 'ai_processing' | 'tool_action' | 'remote_control';

export function issueConsentLease(input: {
  evidence: ConsentEvidence;
  request: ConsentLeaseRequest;
  clock: PlatformClock;
  max_ttl_ms: number;
}): ConsentLease;

export function evaluateConsentLease(input: {
  lease: ConsentLease;
  clock: PlatformClock;
  current_policy_version: number;
  current_revocation_epoch: number;
}): 'active' | 'expired' | 'revoked' | 'stale_policy' | 'restart_reauthorization_required';
```

- [x] RED: `pending`, absent, denied, expired, wrong tenant/subject/scope/purpose/region, stale policy/revocation and
  overlong TTL cannot issue/continue a lease.
- [x] RED: recording consent cannot authorize transcription/translation/AI/tool action.
- [x] RED: consent store exception in `shouldRecordCall` returns `false`; missing tenant or Postgres for a requested
  governed recording returns `false`; explicit valid granted consent returns `true`.
- [x] Verify RED with the consent and recording focused tests.
- [x] GREEN implement pure lease issuance/evaluation; persist no monotonic instant across restart.
- [x] GREEN adapt recording policy so only new capture is denied; do not invoke call termination or media teardown.
- [x] Run voice compliance, retention, recording policy and new consent tests.

## 6. Task T4 — Versioned event envelope and inbox/outbox decisions

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/event-envelope.ts`.
- Create `test/converact-platform-event-compatibility.test.ts`.

Desired public functions:

```ts
export function decodePlatformEvent(
  value: unknown,
  policy: { current_version: 2; read_versions: readonly [2, 1] }
): PlatformEventV2 | { quarantine: true; reason: string };

export function decideInboxWrite(
  existing: { payload_digest: string; aggregate_revision: number } | null,
  incoming: PlatformEventV2
): 'insert' | 'replay' | 'stale' | 'conflict' | 'gap_requires_reconcile';
```

- [x] RED: valid v2 and declared v1 normalize deterministically; unknown major quarantines; unknown effect semantics
  fail closed; missing ordering/authority/producer/correlation/purpose/region is rejected.
- [x] RED: duplicate same digest is replay; same event id different digest is conflict; lower revision stale; revision gap
  freezes effect and requests reconcile; reorder across distinct ordering keys is allowed.
- [x] RED property loop over payload sizes 0, 65,536 and 65,537 bytes proves upper bound.
- [x] GREEN implement pure canonicalization/digest/decision without importing event bus, DB or HTTP.
- [x] Run new tests plus existing tenant-event and integration-event catalog/store/worker tests.

## 7. Task T5 — EffectReceipt lifecycle and Audit link

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/effect-receipt.ts`.
- Create `test/converact-platform-audit-effect.test.ts`.

Desired API:

```ts
export type EffectReceiptStage = 'accepted' | 'completed' | 'state_observed';

export function decideEffectReceiptAppend(
  history: readonly EffectReceipt[],
  candidate: EffectReceipt
): 'append' | 'replay' | 'conflict' | 'stale_writer' | 'invalid_transition';

export function effectNeedsReconcile(history: readonly EffectReceipt[]): boolean;
```

- [x] RED: accepted→completed→state_observed is the only forward sequence; same key/digest replays; same key
  different digest conflicts; lower generation/owner epoch is stale; accepted-only and completed-only unknown states
  require query/reconcile and never authorize blind execution.
- [x] RED: audit link requires tenant/effect/event/receipt/correlation IDs but never raw request/secret/payload.
- [x] GREEN implement O(number of stages), bounded at three receipts per effect generation.
- [x] Run new tests and existing canonical audit/SIP effect oracle tests; verify the SIP oracle remains a domain adapter.

## 8. Task T6 — Immutable usage/billing ledger

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/billing-ledger.ts`.
- Create `test/converact-platform-billing-ledger.test.ts`.

Desired API:

```ts
export type BillableSource =
  | DirectedMediaEdgeUsage | AiRunUsage | RecordingSegmentUsage | ExternalActionUsage;

export function platformBillingKey(source: BillableSource): string;

export function decideUsageAppend(
  existing: UsageEntry | null,
  candidate: UsageEntry
): 'append' | 'replay' | 'conflict' | 'stale_writer';
```

- [x] RED exact keys for four source types include tenant and generation/epoch/direction where required.
- [x] RED duplicate same receipt digest does not charge; different digest, writer or writer epoch conflicts and freezes
  rating; stale takeover is rejected; negative/non-finite unit values rejected; corrections require reversal/credit entry.
- [x] RED reconstruction folds immutable entries/reversals to the expected balance without reading mutable counters.
- [x] GREEN implement deterministic bounded validation; never call Stripe/CDR/recording/provider directly.
- [x] Run new billing tests and existing quota/BillingStore/CDR convergence tests; document legacy stores as projection only.

## 9. Task T7 — Key/certificate lifecycle and secret sinks

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/key-lifecycle.ts`.
- Create `test/converact-platform-key-rotation.test.ts`.

Desired API:

```ts
export type KeyState =
  | 'generated' | 'staged' | 'active' | 'retiring'
  | 'revoked' | 'expired' | 'destroyed';

export function decideKeyTransition(
  current: KeyVersion,
  command: KeyTransitionCommand
): 'apply' | 'replay' | 'conflict' | 'invalid_transition';

export function assertSafeSecretSink(input: {
  sink: 'kms' | 'locked_memory' | 'database' | 'event' | 'log' | 'metric' | 'prompt' | 'evidence' | 'core_dump';
  contains_raw_material: boolean;
}): void;
```

- [x] RED lifecycle graph, dual-read/single-write bounded overlap, revoke/expiry, stale writer, KMS/PKI unavailable,
  no plaintext downgrade, and raw material forbidden sinks.
- [x] RED cert binding requires SAN/service/audience/key version/expiry/revocation; CA trust alone is insufficient.
- [x] RED source policy requires exact source/ABI/bounds/zeroize/core dump/fuzz/fault isolation before enabling native slice.
- [x] GREEN implement pure lifecycle policy and immutable references only.
- [x] Run internal TLS/config/protector tests with the new focused tests.
- [x] Keep the current plaintext SSO secret path explicitly non-eligible until a separately tested secret-ref migration is
  implemented; do not silently encrypt with an unversioned ad-hoc key.

## 10. Task T8 — Correlation, redaction and cardinality

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/correlation.ts`.
- Create `test/converact-platform-observability-correlation.test.ts`.
- Modify `src/metrics.ts` only for new foundation metrics; retain legacy names for compatibility without claiming them
  compliant.

- [x] RED: all required correlation IDs validate length/character bounds; high-cardinality IDs are allowed in controlled
  trace/log context but rejected as metric labels; `profile_type`, Tenant/Call/Room/Engagement IDs are prohibited.
- [x] RED: recursive key and value redaction removes token/password/cookie/private-key/PII-shaped data; cyclic, deep,
  huge array/string inputs are rejected or truncated within fixed budgets.
- [x] RED: exporter queue-full/down/timeout returns drop decision and never blocks or changes business result.
- [x] GREEN implement bounded pure functions; do not add global mutable correlation state.
- [x] Run OTEL, metrics, runtime acceptance unit contracts and the new focused test; real collector outage remains `not_run`.

## 11. Task T9 — Bounded admission and fault policy

**Files:**

- Create `src/agent-runtime/converact/platform-foundation/resilience.ts`.
- Create `src/agent-runtime/converact/platform-foundation/fault-policy.ts`.
- Create `test/converact-platform-resilience.test.ts`.
- Create `test/converact-platform-fault-matrix-contract.test.ts`.

Desired admission API:

```ts
export class BoundedAdmissionGate {
  constructor(limits: { active: number; pending: number });
  tryAcquire(kind: 'active' | 'pending'): { accepted: true; lease: AdmissionLease }
    | { accepted: false; reason: 'overloaded' };
  release(lease: AdmissionLease): void;
  snapshot(): { active: number; pending: number };
}
```

- [x] RED: exact active/pending bounds, double release, forged/stale lease, checked counter overflow, O(1) snapshot and
  independent gates for AI/recording/event/telemetry.
- [x] RED: every machine fault dependency maps to expected media/new-work/attachment/recovery behavior; optional
  fault never emits a call-termination action; ordinary media dependency set is empty.
- [x] GREEN implement counters with instance-local state and opaque generation; no queue, scan, timer or task is created.
- [x] Run placement/readiness/worker tests and both focused tests.

## 12. Task T10 — Tenant-scoped persistence and migrations

**Files:** migrations 108–111, two Postgres stores, and:

- Create `test/converact-platform-foundation-migration.test.ts`.
- Create `test/converact-platform-event-receipt-postgres.test.ts`.
- Create `test/converact-platform-billing-postgres.test.ts`.

Persistence split:

- 108: identity session/revocation snapshot, consent evidence/lease metadata and policy revisions；
- 109: platform outbox/inbox/effect receipts；
- 110: immutable usage entries/reversals and unique billing key/writer fence；
- 111: key/cert metadata/reference/lifecycle receipt only, never raw material。

- [x] RED migration text tests require `tenant_id`, composite uniqueness, CHECK constraints, RLS + FORCE RLS,
  tenant policy, append-only trigger for receipt/usage, bounded claim indexes and no raw-secret column names.
- [x] RED store tests require `withPgTenant`, same-digest replay, changed-digest conflict, generation/epoch fence,
  bounded claim limit and no cross-tenant query.
- [x] GREEN write additive migrations after 107 and minimal stores using existing transaction/RLS conventions.
- [x] Update standalone migration allowlist/order and readiness required migrations; verify 108<109<110<111.
- [x] Run migration checksum/files/standalone/readiness tests and all three focused persistence tests.
- [x] Real PostgreSQL/RLS/crash boundary remains `not_run` until controlled evidence stage.

## 13. Task T11 — Focused local verification and contract evidence

- [x] Run the exact G02 contract test.
- [x] Run all new `test/converact-platform-*.test.ts` files with test concurrency 1 for store-like tests.
- [x] Run impacted existing suites listed per task.
- [x] Run `npm run typecheck`.
- [x] Run the full `npm test` only after focused suites are green; record unrelated pre-existing failures separately.
- [x] Re-run generator and verify zero diff.
- [x] Update evidence index only for commands whose raw output was observed; unexecuted items remain `not_run`.
- [x] Commit narrow slices: contract, clock/identity, consent/event, receipt/billing, key/correlation/resilience,
  persistence, local evidence.

## 14. Task T12 — Controlled and real evidence

This task is authorized only in a reproducible isolated validation environment and never on the frozen production
release. The validation host does not itself make a test reproducible; exact source/image/config/runbook are required.

Controlled progress, without promoting the aggregate task:

- [x] Build and test the fenced matrix catalog and an exact-source PostgreSQL restart slice.
- [x] Run the PostgreSQL slice with real migrations/RLS, actual stop/start, fresh-process reconciliation, synthetic
  transport continuity and project-scoped cleanup; record it as `verified_controlled` only.
- [x] Verify every retained raw hash, byte-identical unrelated-container snapshots, zero campaign resources and
  secret-shaped evidence rejection.
- [x] Keep the aggregate dependency matrix, real Human Communication, capacity, restore, drain, region and production
  claims `not_run`.

- [ ] Build a fenced fault harness for Postgres, event system, object store, PKI/KMS, DNS, config, wall clock,
  AI/GPU, recording upload, provider, observability and node crash.
- [ ] Prove single-node crash/restart, stale owner, duplicate/reorder, N/N-1 rolling and key rotation.
- [ ] Run backup/restore rehearsal and capture measured RPO/RTO.
- [ ] Run multi-node drain/node loss/region recovery with active-zero receipts.
- [ ] Run each fault beside a real long Human Communication session and prove no causal termination from optional
  dependencies; separately report embedded process-owned edge interruption.
- [ ] Run bounded queue/retry/fanout overload and capacity on fixed hardware/config/workload.
- [ ] Record commit/source/binary/image/config/model/hardware/clocks/workload/seed/time/raw output in evidence index.
- [x] If any prerequisite or campaign is absent, keep that entry `not_run`; never borrow historical evidence.

## 15. Task T13 — Independent review and closeout

- [ ] Give a fresh read-only reviewer the Goal, PROGRAM-RULES, design, contracts, source/test map, diff and raw results.
- [ ] Reviewer checks requirement coverage, Authority duplication, fail-open paths, hot-path dependencies, algorithmic
  complexity, secrets, schemas, evidence promotion and all open High/Critical threats.
- [ ] Fix findings through new red tests; rerun relevant verification.
- [ ] Update `independent-review.md` with reviewer identity, commit/diff boundary, commands, findings and disposition.
- [ ] Mark only proven local entries; runtime/production remains false while any real campaign is `not_run`.
- [ ] Use narrow explicit `git add <path>`; never `git add .`; commit only G02 files.
- [ ] Do not call `create_goal` for G03.
