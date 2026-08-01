# Goal 14 — Action、Tool Broker 与 Durable Workflow

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G14` |
| 初始状态 | `not_run` |
| 前置 Goal | G02、G09、G13 `completed`；真实 Connector/动作另需对应 Profile Gate |
| 解锁 | G15；仅在 Resolve Offer 纳入完整 Workflow/Action 时为 G16 提供资格 |
| Authority | Converact Engage Action Authority 与 Durable Workflow；外部系统拥有实际目标状态 |
| 主要来源 | [平台 R2 §4、§8–§10](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 §7.5、§12、W5](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

建立 Profile 无关、安全、持久、可审计的 Action 与跨时间 Workflow；G11 的单 Connector
effect 在其 Resolve Profile Gate 通过后作为首个真实适配器被吸收，而不是横向内核的前置条件。
AI/人工只能提出 ActionProposal；Action Authority 负责 schema、tenant、target、risk、dedup、
policy、approval、authorization 和唯一 ActionIntent。Tool Broker 仅持有最小、短期、
scope-bound capability；执行结果通过 Attempt、Observation、Receipt 与 Verification 收敛。

网络只提供 at-least-once/unknown 现实，不能宣称 Exactly Once。补偿是新的 ActionIntent，
必须重新授权，不能覆盖原动作。

## 3. Required outcomes

1. 实现 ActionProposal、ActionIntent、Authorization、ExecutionAttempt、EffectObservation、
   EffectReceipt、EffectVerification、CompensationLink 和 immutable audit。
2. 实现 `Created→PolicyChecked→AwaitingApproval→Authorized→Executing→EffectKnown→
   Verified/Rejected`，以及 Expired/Cancelled/ReauthorizationRequired/Unknown/
   Reconciling/Failed。
3. 每个 Attempt 固定 attempt ID、idempotency key、authorization version、deadline、fence、
   dispatch/settlement point、provider request ID 和 query strategy。
4. 建立 versioned Tool/Capability Registry：input/output schema、risk、tenant/region/data、
   credential lease、rate limit、side-effect class、required receipt、cancel/query/compensate。
5. 建立 policy engine 与审批：A0–A4、amount/resource limits、four-eyes、separation of duty、
   emergency stop、revocation 和 reauthorization。
6. 建立 Durable Workflow Task graph：wait、timer、signal、retry budget、human work item、
   external event、child step、checkpoint、cancel、resume、migration 和 version pinning。
7. unknown 结果必须 freeze successor conflict、query/reconcile；same identity/different hash
   fail closed；late old attempt 不能覆盖新 authorization。
8. compensation 创建独立 intent/idempotency/policy/receipt；原 Effect/Receipt 永久保留。
9. Tool/Provider 故障、queue backlog、workflow crash、worker loss、approval timeout、credential
   expiry 不影响 Human Communication 或 Engagement read path。
10. 建立 action safety、cost、latency、success/unknown/reconcile、manual intervention 和
    business Outcome 关联指标。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-14/`：

- `action-and-workflow-design.md`
- `action-state-machine-v1.json` 与 schema
- `tool-capability-registry-v1.json` 与 schema
- `authorization-policy-v1.json` 与 schema
- `durable-workflow-contract-v1.json` 与 schema
- `receipt-query-reconcile-contract.md`
- `compensation-and-reversal-contract.md`
- `threat-failure-and-abuse-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-14-action-workflow-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit existing tool/workflow implementations；若 G11 已完成则吸收其已证明 contract，否则
   先以 fake provider 验证横向内核。
2. 先写 proposal cannot execute、risk/policy/approval、idempotency conflict、unknown、
   late attempt、credential scope 和 compensation 的失败/property tests。
3. 实现 Action Authority/Ledger 和 fake provider；仅在对应 Profile Market/Action Gate 通过后
   接 G11 或其他 real connector。
4. 实现 Tool Broker short-lived lease 和 policy/approval。
5. 实现 minimal durable workflow wait/resume/query/reconcile；逐步增加客户已购买步骤。
6. 注入 crash/partition/duplicate/reorder/rate limit/credential expiry/approval timeout。
7. 用已通过 Profile Gate 的真实低风险动作做 controlled/canary Evidence；高风险动作保持
   模拟或人工批准直到授权。

## 6. Acceptance gates

- Agent/UI/Connector 都不能绕过 ActionIntent 与 Authorization 直接产生外部副作用。
- duplicate/replay/crash 不重复 effect；unknown 不盲重试；state-observed 与 source revision
  才能满足对应 VerificationPolicy。
- cancel 只在未 dispatch 或 provider 明确确认时成立；超时不伪装取消。
- revoke/reauthorize/fence 后迟到 attempt 不能覆盖当前状态。
- compensation 有新 intent/approval/receipt，原动作与账单审计不可变。
- Tool Broker 无长期管理凭据；tenant/target/scope/expiry/region fail closed。
- Workflow engine restart/upgrade/step migration 不丢 wait、signal、budget 或 action truth。
- action/tool/workflow 故障不终止 Human Communication 或 Engagement 人工主链；
  queue/retry/fanout 全有界。
- 只有真实低风险 canary 通过的 tool/action 才可 production eligible。

## 7. Explicit non-goals

- 不建设无限制通用 RPA、浏览器远程控制或任意代码执行市场。
- 不让 Agent framework 自己拥有 tool credentials、cron、queue 或 workflow truth。
- 不用 HTTP 2xx 或日志文本当 Effect verification。
- 不自动启用 A4 高风险自治；A5 不进入生产。
- 不为没有对应 Profile 客户需求与 Gate 的 Connector 预建生产动作。

## 8. Completion and commit boundary

按 ledger/contracts、policy/broker、workflow、real connector、failure/security Evidence 分窄
提交。高风险或真实外部动作缺授权时保持 `not_run/blocked_external`，不得降级 Gate。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-14-action-durable-workflow.md`
using its manifest SHA-256 after G02/G09/G13. Obey PROGRAM-RULES.md. Build the
horizontal kernel with a fake provider; any real Connector/action additionally
requires its owning Profile market, risk and authorization gates.

Build the durable Action Authority, Tool Broker and Workflow around
Proposal->Intent->Policy/Approval->Authorization->Attempt->Observation/
Receipt->Verification. Use scoped short-lived credentials, dispatch and
settlement points, idempotency/fencing, query/reconcile for unknown results,
and separate newly authorized compensation intents. Frameworks, UI and
connectors cannot bypass the ledger. Prove duplicate/reorder/crash, late
attempt, approval, credential, provider and workflow recovery while human
communication and the Engagement read path remain isolated. Enable only
Profile-authorized low-risk canaries; do not build unrestricted RPA or claim
exactly-once. Anything unproved remains not_run.
```
