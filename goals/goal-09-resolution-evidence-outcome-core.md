# Goal 09 — Engagement、Evidence、Outcome Core 与 Resolution Profile

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G09` |
| 初始状态 | `not_run` |
| 前置 Goal | G01 `platform_contract_gate_completed`；G02 `completed` |
| 解锁 | G10、G11、G12、G13、G14 |
| Authority | Converact Engage；Resolution 是首个 Profile；Overlay 外部系统保留其业务 Authority |
| 主要来源 | [平台 R2 §4–§5](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 §7–§9](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

建立 Converact 永久 Horizontal 业务核心：Engagement、独立 EngagementItem、ProfileBinding、
Task references、Evidence Catalog、VerificationPolicy 和不可变 OutcomeClaim；再以同一核心
实现第一个 `resolution` Profile，把 Resolution/ResolutionItem 作为严格特化而不是平行
Authority。Native 模式可让 Converact 成为相应 Engagement 的正式 Authority；Overlay 模式只拥有
Converact 自己的执行、测量、Evidence 和 Outcome，不覆盖外部 CRM/FSM 的 Case、Opportunity、
WorkOrder、SLA 或正式关闭。

本 Goal 必须以稳定 ID、版本引用和小聚合实现，不能做一个跨所有域的巨型事务，也不能把
Call、Room、Ticket、Opportunity 或 Provider Conversation 当成 Engagement/Resolution。

## 3. Required outcomes

1. 实现 Tenant/Subject/Engagement/EngagementItem/ProfileBinding/ExternalAuthorityBinding、
   InteractionRef、TaskRef、EvidenceRef、ActionRef 和 OutcomeClaimRef 的通用领域合同。
2. 实现 Profile registry/validator contract：Profile 只扩展 schema、policy、metrics 和 UI/
   Connector mapping，不直接写平台表、不创建第二 Task/Action/Evidence/Billing Authority。
3. 实现 Engagement 与 EngagementItem 的通用 version/membership/lifecycle；每个 Item 绑定
   statement、fingerprint、qualification baseline、VerificationPolicyVersion、observation/
   reopen window 和 Outcome 类型。Profile-specific state 保存在版本化 extension 中。
4. 实现 membership-version close barrier：并发 add/reopen 使 close CAS 失败；Closed 后新增
   Item 必须先原子 Reopen；projection 不用异步计数猜关闭。
5. 实现通用 Overlay ExternalAuthorityProjection 与 source revision/staleness；
   `ExecutionComplete` 不等于外部 Case/Opportunity/WorkOrder Closed，stale/unknown 显式显示。
6. 实现 EvidenceCatalog：Artifact、Observation、Claim、Derivation、provenance、capture time、
   clock uncertainty、consent、integrity、retention、legal hold、tombstone 与 lineage。
7. 实现通用 OutcomeClaim `Proposed→Provisional→Verified→Finalized`；Finalized 永久不可变，
   同 Item/type/policy family 最多一个 active claim。
8. 实现 Profile-defined OutcomeDispute、OutcomeReversal 和 Billing Credit/Reversal；
   业务重开与纯价值/币种/贡献错误使用不同规则。
9. 实现第一个 Resolution Profile：Resolution/ResolutionItem/ResolutionExecution/
   ResolutionBinding、ProblemStatement、problem fingerprint、复发和售后 VerificationPolicy；
   证明它映射通用对象而不泄漏字段到其他 Profile。
10. 实现 versioned APIs、command idempotency、optimistic concurrency、outbox/projection、
   query/reconcile、backup/restore 与 multi-AZ recovery。
11. 实现通用 Outcome/成本/周期指标合同；Resolution Profile 再定义 remote resolution、
    dispatch avoidance、FCR、FTF、MTTR、expert leverage、installation success，并按 eligible
    ResolutionItem 计算再聚合。
12. 对 `current/target/production_eligible`、数据迁移、rolling schema、tenant isolation、
    audit 与性能建立 Evidence。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-09/`：

- `engagement-core-and-profile-design.md`
- `engagement-domain-contract-v1.json` 与 schema
- `engagement-item-state-machine-v1.json` 与 schema
- `engagement-profile-contract-v1.json` 与 schema
- `resolution-profile-contract-v1.json` 与 schema
- `evidence-catalog-contract-v1.json` 与 schema
- `outcome-claim-contract-v1.json` 与 schema
- `overlay-external-authority-projection-mapping.md`
- `api-and-data-migration-contract.md`
- `threat-failure-and-complexity-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-09-engagement-core-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit existing Conversation/Task/Resolution/Case/assignment/collaboration objects after G00；
   明确 current→target 迁移，不复制 Authority。
2. 先写 Profile isolation、unknown profile/version、schema compatibility、membership close race、
   claim uniqueness、finalized immutability、reversal 与 tenant isolation property tests。
3. 实现最小 Engagement commands/repository/outbox 和 Profile validator；读模型与搜索最终一致。
4. 实现 Evidence provenance/integrity/retention 和通用 Outcome verification。
5. 在通用核心上实现 Resolution Profile 及其 external Case projection/reconcile。
6. 实现 API version/rolling migration，再注入 duplicate/reorder、concurrent update、DB/event
   failure、clock uncertainty、restore、stale receipt 和 external authority reopen。
7. 运行跨 Profile 污染、容量、恢复、安全测试与独立领域审查。

## 6. Acceptance gates

- Call-ID、Room、Ticket、Opportunity 不可被当作 EngagementId；一个 Engagement 可有多个
  Item/Interaction，Profile/version 明确且不可静默改变。
- 两个 Profile 共享 Horizontal Core 时字段、状态、指标和策略不互相污染；未知 Profile/
  version fail closed 或只读降级。
- Resolution Profile 中每个 Item 的问题、基线、政策、结果和复发独立；新增问题不能静默
  改原 Item。
- close/add/reopen concurrency 通过 version barrier，无 premature Closed。
- Overlay 不写外部 Case/Opportunity/WorkOrder Authority；stale/unknown projection 不被推断成一致。
- Evidence 的 source、consent、hash、lineage、clock uncertainty、retention/tombstone 可审计；
  模型生成内容不能冒充现场 Observation。
- 未满足 policy/observation window 的 Claim 不可 Finalized/计费；争议不修改原 Finalized。
- duplicate/replay/crash/recovery 不重复 Engagement/Resolution、Claim、billing key 或 reversal。
- API/schema N/N-1 rolling、backup/restore、multi-tenant isolation 与性能 Gate 通过。

## 7. Explicit non-goals

- 不替换客户 CRM/FSM、Case、Opportunity、WorkOrder、SLA、WFM 或正式关闭。
- 不在本 Goal 实现完整 Action execution、Agent、Speech、Connector 或视频 UI。
- 不把 Profile 做成独立平台，也不把所有对象放进一个数据库事务或巨型 ORM aggregate。
- 不由 LLM 自评决定 Outcome。
- 不立即启用 Outcome pricing；G16 基于真实 Pilot 决定。

## 8. Completion and commit boundary

按 domain/schema、state tests、Evidence/Outcome、projection/API、recovery Evidence 分窄提交。
迁移删除只在 active-zero/reference scan 后执行。任何未证明项保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-09-resolution-evidence-outcome-core.md`
using its manifest SHA-256 after the G01 contract gate and G02. Obey
PROGRAM-RULES.md.

Build the durable horizontal Converact Engagement core with independent
EngagementItems, versioned ProfileBinding/validators, close barriers, external
authority projections, Evidence provenance and immutable policy-backed
OutcomeClaims plus dispute/reversal/credit objects. Implement Resolution as the
first strict profile, not a second authority. External systems retain
Case/Opportunity/WorkOrder/SLA/formal-close authority. Use small aggregates,
stable IDs, outbox/reconcile and TDD for profile isolation, concurrency,
idempotency, stale projections, tenant isolation, rolling schemas and
crash/recovery. Never treat Call/Room/Ticket or model self-assessment as an
Engagement/Outcome.
Do not implement unrelated Agent/Speech/Connector features or touch
production. Anything unproved remains not_run.
```
