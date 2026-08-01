# Goal 11 — 最小 Connector Effect 与 Tracer Pilot A

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G11` |
| 初始状态 | `not_run` |
| 前置 Goal | G01 `resolve_market_gate_completed`；G02、G09、G10 `completed` |
| 解锁 | G12 Resolve B1、G16；其 Effect 可在 G14 中复用但不是横向 G14 的前置 |
| Authority | 外部电话/CRM/FSM 保留 Call/Case；Converact 拥有 Engagement execution、Resolution Profile projection 与 Action Ledger |
| 主要来源 | [平台 R2 §10–§12](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 W5a、§20、§22.2](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

根据三家设计伙伴共同事实，只实现一个 provider-specific 电话 Adapter 和一个 CRM/FSM
Connector，打通首个真实 Tracer Pilot A：

```text
外部服务电话
→ 稳定 Engagement(resolution)/Interaction/ResolutionExecution
→ 电话保持 + 免 App additive video
→ 专家 Workspace + Evidence
→ 一个受控 CRM/FSM EffectReceipt
→ 人工 Verification + OutcomeClaim
```

不得用“generic SIP/BYOC/通用 CRM”掩盖 provider capability 差异，也不得在 UI 或 Connector
中直接写外部状态而绕过 ActionIntent/Authorization/Attempt/Receipt/query/reconcile。

## 3. Required outcomes

1. 基于 G01 Evidence 冻结唯一 phone Provider、唯一 CRM/FSM、exact API/webhook version、
   tenant/region/number/media-fork capability、rate limit、sandbox/production 和责任人。
2. 电话 Adapter 实现外部 Call projection、participant/leg mapping、source cursor/revision、
   duplicate/reorder webhook、signature、query/reconcile 和 stale/unknown。
3. CRM/FSM Connector 只实现 Pilot 所需最小动作与查询；Case/SLA/formal close 保留外部 Authority。
4. 实现 ActionProposal→ActionIntent→PolicyChecked→Authorization→ExecutionAttempt→
   EffectReceipt/Observation→Verification；HTTP 2xx 不能泛称 state-observed。
5. 每个 attempt 固定 dispatch/settlement point、deadline、fence、idempotency、provider request
   ID；timeout 后 query/reconcile，禁止盲目 retry。
6. Pilot A 端到端固定 Engagement/ProfileBinding/Interaction/Resolution/Item/ExternalSessionProjection/
   ExternalCaseProjection、Consent、Evidence、Outcome 和一份服务报告。
7. 建立 provider/connector outage、webhook reorder/conflict、token expiry、rate limit、
   partial success、duplicate effect、late receipt、crash/restart 与 manual recovery。
8. 实测 short、30m、2h、8h；覆盖电话保持、视频链接、browser background/network switch、
   Evidence upload、recording policy、CRM receipt 和清理。
9. 把 LED 或客户应用必须做的适配点输出为单独、可交付的接口文档；不得修改其代码。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-11/`：

- `selected-provider-and-connector-decision.md`
- `telephony-adapter-contract-v1.json` 与 schema
- `minimal-connector-effect-contract-v1.json` 与 schema
- `pilot-a-scenario-contract-v1.json` 与 schema
- `webhook-query-reconcile-runbook.md`
- `customer-application-adaptation-points.md`
- `security-fault-and-rate-limit-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-11-connector-pilot-a-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `pilot-a-milestone-a-report.md`
- `independent-review.md`

客户凭据、录音和 PII 只存在授权存储，Git 中使用引用与脱敏 digest。

## 5. TDD and implementation order

1. Verify G01 real selection;缺真实 Provider/CRM 决定时完成 contract/harness 后停在
   `blocked_external`，不擅自挑选。
2. 先写 signature、duplicate/reorder/conflict、idempotency、unknown/reconcile 和 tenant
   isolation 失败测试。
3. 实现 read-only projections，再实现一个最小 write effect。
4. 连接 human-only Pilot A；AI/Speech 全部关闭仍应完成。
5. 在 sandbox/real dependency 按权限递进验证，最后运行真实授权 Pilot scope。
6. 注入 provider/connector/network/crash fault，完成长通话与 cleanup。
7. 独立复核 Authority、security、effect evidence、用户旅程与客户适配文档。

## 6. Acceptance gates

- Provider 与 CRM/FSM 由真实 G01 Evidence 选择；没有并行第二套 Connector。
- webhook 重复/乱序/伪造/冲突不会重复 Call projection、Action、Receipt 或 Outcome。
- unknown result 必须 query/reconcile；cancel 只在未 dispatch 或 provider 明确确认时成立。
- 外部 state-observed Receipt 引用 source revision；accepted/completed 不被提升为已验证状态。
- Pilot A 在 AI 全关时真实完成电话→视频→Evidence→CRM→人工 Outcome。
- Pilot A 只签署 Resolve Profile；其成功不证明通用 Connector、其他 Profile 或整个 Converact
  平台已具备市场资格。
- phone/video/DB/event/object/connector 任一故障的继续/降级/reconcile 符合合同。
- short/30m/2h/8h 和最终 participant/link/session/action resource cleanup 有 Evidence。
- 客户应用适配点明确；Converact 未修改不归其管理的代码。

## 7. Explicit non-goals

- 不做多个 Provider、多个 CRM/FSM 或通用 Connector 平台。
- 不在本 Goal 做 B1 翻译、Copilot、OCR 或自主工具。
- 不让 CRM Case Closed 自动等于 Converact Outcome Finalized。
- 不使用 mock/sandbox 结果宣称真实 Pilot 完成。
- 不修改生产容器或客户/LED 仓库。

## 8. Completion and commit boundary

Provider decision、adapter、connector effect、Pilot integration、real Evidence 分窄提交。真实
依赖或 Pilot 授权缺失时，完成全部离线工作后标记 `blocked_external`，不得虚构
`completed`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-11-minimal-connector-pilot-a.md`
using its manifest SHA-256 after the G01 market gate and G02/G09/G10. Obey
PROGRAM-RULES.md.

From real design-partner evidence, freeze one provider-specific phone adapter
and one CRM/FSM connector. Implement only the minimal read projections and
ActionIntent/Authorization/Attempt/Receipt/query/reconcile effect needed for
Tracer Pilot A: external call to stable Engagement(resolution)/Interaction/
ResolutionExecution,
phone-preserving app-free video, expert Evidence, one CRM effect and human
verified Outcome. Use TDD for signature, ordering, idempotency, unknown,
crash/rate-limit/fault and tenant isolation; run short/30m/2h/8h real journeys.
AI must be optional. Do not choose fake generic providers, edit LED/customer
code, touch production or claim mock evidence. Missing real dependencies mean
blocked_external after offline work; unproved items remain not_run.
```
