# Converact AI 外呼 Tool Broker 与 Action Receipt 设计 R1

> 日期：2026-08-31
>
> 状态：`controlled_core_and_worker_slice_passed / physical_integrations_not_run / production_not_run`
>
> 上位设计：[AI 外呼与 Voice Agent 平台 R1](./2026-08-31-ai-outbound-active-call-platform-r1.md)

## 1. 决策

下一条纵向切片实现统一 Tool Broker。Active Call 只能提出 `ToolProposal`，不能直接访问租户
HTTP、CRM、订单、支付、知识库或 Memory。Converact 是 Tool、Policy、Approval、Action 和 Receipt
唯一业务权威。

采用独立 Rust crate `converact-tool-broker-core`，复用现有通用幂等/Receipt 与 Outbox 基础能力。
不把 Tool 状态机塞进 `ai-outbound-core`，也不在 Active Call Adapter 内执行工具。

考虑过三种方案：

1. **独立 Tool Broker Core（采用）**：电话、LiveKit、未来 ViLTE 共用；Call 状态与外部 Effect
   故障隔离；接口稍多，但 Authority 清晰。
2. 放入 `ai-outbound-core`：代码最少，但 Campaign/Call 会与 CRM/订单等外部动作耦合。
3. 直接扩展现有通用 Outbox：能复用持久化，但通用投递层不应理解 Agent Release、审批、
   generation 和 Tool Schema。

## 2. 首条完整范围

```text
Normalized ToolProposed
  -> ToolProposal 合同校验和 arguments canonical hash
  -> 精确 ToolRevision/Schema 解析
  -> tenant / AgentRelease / generation / Policy 检查
  -> 必要时校验 exact ApprovalGrant
  -> 原子 prepare（先于外部执行）
  -> 允许列表中的 Action Adapter execute
  -> 原子 finalize ActionReceipt
  -> 当前 generation 才可消费 ToolResult
```

首轮覆盖查询和变更 Tool。外部任意 URL、租户自带脚本、浏览器直连、任意 shell、模型直接写库
全部禁止。具体 CRM/订单 Provider Adapter 在后续能力切片实现，但本切片必须形成可持久化、可恢复的
完整 Broker 状态语义。

## 3. 核心合同

`ToolProposal` 固定包含：

- `EnvelopeContext`：tenant、Interaction、Attempt、Agent Release 和 execution generation；
- `ToolRevisionId` 与 `ToolCallId`；
- `tool_schema_hash`；
- `arguments_hash` 与 bounded canonical JSON arguments；
- `requested_at_ms` 与 `deadline_ms`。

构造时重新计算 `arguments_hash`。不匹配、超过 64 KiB、deadline 不晚于请求时间、标识或 digest
非法时拒绝。原始凭据不能进入 Proposal。

`ToolDefinition` 由 Catalog 精确返回：

```text
ToolRevisionId
AgentReleaseId
schema_hash
effect_class = query | mutation
risk = low | high
action_capability
```

Catalog 记录不包含运行时 Secret 或任意目标 URL。`action_capability` 只能解析到部署时注册的 Rust
Adapter。

## 4. Policy 与 Approval

Policy 的闭集结果为 `Denied`、`Allowed`、`ApprovalRequired`：

- Schema、tenant、Agent Release、Tool Revision 或 generation 不匹配时 fail closed；
- mutation 必须具有 durable idempotency key；
- high-risk action 必须 `ApprovalRequired`，不能由 Agent 自行降级；
- Approval 精确绑定 tenant、Interaction、Attempt、generation、Tool Revision、Tool Call、Schema
  hash、arguments hash、审批到期时间；
- 过期、撤销或字段不匹配的 Approval 等同不存在；
- Denied/ApprovalRequired 均不得触发 Action Adapter。

## 5. Durable Effect 与恢复

`ToolActionStorePort.prepare` 必须在外部执行前原子写 Proposal、策略决定、幂等键与 accepted Receipt，
并返回以下闭集之一：

- `Prepared`：本进程本轮唯一一次可执行权限；
- `Replay(ActionReceipt)`：已存在最终结果，禁止再次执行；
- `ReconcileRequired`：已有 accepted 但无最终观察，只允许 query；
- `InProgress`：另一有效租约正在处理，只能等待，禁止 execute/query；
- `Conflict`：相同键绑定了不同 payload 或 Authority。

Action Adapter 结果为 `Applied`、`NotApplied` 或 `OutcomeUnknown`。`OutcomeUnknown` 不能转成失败，
不能再次 execute；只能调用 provider query/reconcile。最终 `completed + state_observed` Receipt、结果投影
和 Outbox 转移由 Store Adapter 在一个事务中提交。

`ActionReceipt` 是外部效果是否发生的唯一依据。通话结束、Worker 重启和 Agent 超时均不能改变这条
规则。

## 6. Generation 与 Agent 返回

所有结果永久保留在原 generation 历史中。只有 Receipt generation 等于当前 Call execution
generation 时，Broker 才返回 `Consumable` ToolResult。旧 generation 返回 `Historical`，不能继续
驱动当前 Agent、发言或调用后续工具。

## 7. 故障隔离和安全

- Tool Broker/Provider 故障不得终止 SIP/RTP 媒体或录音；Agent 得到 bounded unavailable/pending；
- 不在日志、metric、health 或错误中输出 arguments、ToolResult、Secret、客户号码或完整转写；
- 每个 Proposal、Result、错误文本、claim batch、等待时间和并发数均有界；
- 热路径不做全表扫描、全局锁或每请求创建无限任务；
- Adapter 只接受 Secret Ref，Debug 必须脱敏；
- 高风险动作在审批服务不可用时拒绝，不允许降级执行。

## 8. 精准测试策略

本切片只保留能证明关键不变量的测试：

1. Proposal canonical hash/时间/边界不合法时不能进入 Broker；
2. high-risk mutation 没有 exact Approval 时 Action 调用次数为 0；
3. approved mutation 的顺序为 `prepare -> execute -> finalize`，同一幂等键 replay 时 execute
   总次数仍为 1；
4. execute outcome unknown 后只 query/reconcile，不重复 execute，旧 generation Result 为
   `Historical`。

只运行新 crate、被修改的共享合同 crate、相关 schema 测试和 scoped Clippy/format。除非出现共享
合同影响或明确故障证据，不运行全仓回归、性能或容量测试。

## 9. 当前不证明

- 真实 CRM/订单/支付 Adapter；
- 外部审批服务；
- PostgreSQL 物理集成（没有可用测试库时保持 `not_run`）；
- Active Call 实进程 Tool round-trip；
- LiveKit/ViLTE Agent Tool round-trip；
- 性能、容量、长稳和生产资格。

这些不影响先完成独立 Rust 合同、Broker、持久化 Adapter 和受控功能切片，但不得从受控测试继承
更高证据等级。

## 10. 实现与证据状态

已实现并通过受控测试：

- `converact-tool-broker-core` 的 Proposal、Definition、Policy/Approval、Action Receipt、
  prepare/execute/finalize、replay、unknown reconcile 与 generation fence；
- `converact-tool-broker-store` 和 PostgreSQL tenant-transaction wrapper；
- migration 125 与 SQLite development mirror；
- Active Call normalized Tool Proposal 到 Rust Worker/Broker 的桥接，以及仅当前 `Consumable`
  结果回传的门禁。

证据见 [R1 Tool Action evidence](../../architecture-foundation/ai-outbound/evidence/r1-tool-action/README.md)。
证据等级仅为 `local_contract + controlled_test_double`；本节不改变第 9 节任何 `not_run` 项。

## 11. 首批通用业务 Adapter

D5 下一条功能切片固定两个行业无关能力，不把汽车、保险或某一 CRM 写进 Core：

| capability | 类别 | 输入 | Provider Port | 结果 |
| --- | --- | --- | --- | --- |
| `customer.lookup` | query | bounded `customer_id` | `CustomerDirectoryPort` | typed customer snapshot / not found |
| `task.create_follow_up` | mutation | `customer_id`、bounded reason、due time | `FollowUpTaskPort` | created / not applied / outcome unknown |

Adapter 必须使用 `AuthorizedToolAction` 中固定的 capability/effect class；不接受 URL、Secret、shell、
SQL 或动态代码。变更 Provider 的幂等键固定使用 `ToolCallId`，ambiguous execute 只能通过
`FollowUpTaskPort.query(ToolCallId)` 收敛。Provider 只负责外部系统协议，不能拥有 Tool Policy、
Approval、Receipt 或 Agent 状态。
