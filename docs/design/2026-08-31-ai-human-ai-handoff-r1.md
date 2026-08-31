# AI → Human → AI Handoff R1

> 状态：`controlled_core_store_worker_and_active_call_port_passed /
> physical_integrations_not_run / production_not_run`
>
> 日期：2026-08-31
>
> 范围：AI 外呼电话 Channel 的人工接管与 AI 恢复；模型可被后续跨渠道复用

## 1. 目标

在不复制 Call、SIP、媒体或 Agent Authority 的前提下，实现可恢复、幂等且可审计的
`AI -> 人工 -> AI` 接管闭环：

- AI 请求接管时冻结版本化 Context Packet；
- RustPBX 建立并观察人工 Leg；
- 只有人工 Leg 已接听，才允许提交人工所有权；
- 每次所有权切换都推进 `ExecutionGeneration`；
- 任一时刻只有一个 generation 能发言、执行 Tool 或结束通话；
- crash、超时或结果未知进入 query/reconcile，不盲目重复拨号或切换；
- 人工处理后可以结束通话，也可以用新上下文恢复 AI。

首轮只证明 Rust 合同、状态机、持久化边界和受控 Worker 适配。真实座席、RustPBX、SIP、媒体、
LiveKit、性能和生产资格保持 `not_run`。

## 2. Authority

| 领域 | 唯一 Authority | Handoff 中的职责 |
| --- | --- | --- |
| Call/Leg/SIP | RustPBX | 建立、查询、断开人工 Leg；报告事实，不决定业务所有权 |
| AI 执行 | Active Call Channel Adapter | 准备/暂停/恢复 AI session；不提交 Handoff |
| 接管事务 | Converact Handoff Core + durable Store | 状态、revision、generation、owner、幂等 receipt |
| Tool/Action | Tool Broker | 只接受当前 generation；不由 Handoff Adapter 直接执行 |
| 业务 Attempt | AI Outbound Core | 投影 `handoff_pending/human_active/ai_resuming/conversing` |
| 媒体 | 既有媒体 Authority | 根据已提交 owner/generation 路由；不创建业务状态 |

Handoff 不是第二套 Call 状态机。它只管理一个 Call 内的控制权切换事务；RustPBX CallId、
CallAttemptId 和 InteractionId 在整个过程保持稳定。

## 3. 核心对象

### 3.1 HandoffSession

必须包含：

- `HandoffId`、tenant、`InteractionId`、`CallAttemptId`、RustPBX `CallId`；
- immutable source `AgentReleaseId`；
- `HandoffRevision` 与当前 `ExecutionGeneration`；
- `ControlOwner = ai | human`；
- frozen `ContextPacket`；
- bounded target queue/skill/seat selector；
- 可选人工 `ChannelLegRef` 与 AI resume session ref；
- 当前状态、最近 transition receipt 与 reconcile 来源状态。

Store 以 `(tenant_id, handoff_id)` 为主键，以 `(tenant_id, interaction_id)` 约束同一交互只有一个
非终态 Handoff。每条命令使用独立 `HandoffCommandId` 和 payload hash。

### 3.2 ContextPacket

Context Packet 是不可变、有版本且 PII 最小化的引用集合，不把任意 transcript 或模型自由文本
直接塞进 Handoff 热状态：

- `ContextPacketId`、`ContextRevision`、canonical digest；
- summary/transcript artifact refs；
- bounded intent、risk 与 unresolved-item refs；
- bounded Tool `ActionReceiptId` 列表；
- disclosure/recording 状态；
- Call/Leg、Agent Release 与 source generation；
- created time 与 data-region policy ref。

真正文本由独立 transcript/context authority 按 tenant 权限读取。日志只记录 ID、状态、revision、
generation、hash 和安全错误码。

## 4. 状态机

```text
requested
  -> prepared
  -> human_leg_dialing
  -> human_leg_answered
  -> committed
  -> human_active
  -> ai_resume_preparing
  -> ai_resumed

requested/prepared/human_leg_dialing -> aborted
任意非终态 -> reconcile_required
```

规则：

1. `prepare` 必须先持久化 Context Packet、目标选择和 effect intent；
2. `human_leg_dialing` 必须绑定一个确定的 RustPBX Leg ref；
3. `commit_human` 只接受 `human_leg_answered`，并原子推进 generation、把 owner 改为 human；
4. `committed -> human_active` 只记录已观察到的新 owner 媒体可用，不再次推进 generation；
5. `prepare_ai_resume` 在 human generation 下准备新的 AI session，human 仍是 owner；
6. `commit_ai_resume` 只在 AI ready 后原子推进 generation、把 owner 改回 AI；
7. abort 不推进 generation，必须保证 AI 仍可服务，或由上层按策略结束 Call；
8. `reconcile_required` 禁止普通 transition；Reconciler 查询 Store、RustPBX 与 Channel Agent 后，
   使用一个带 observed evidence hash 的确定性决议收敛；
9. revision、generation 或 command payload 不匹配均 fail closed；exact replay 返回原 receipt；
10. generation overflow、revision overflow、无 CallId、未接听 commit 和 stale owner command 均拒绝。

## 5. 单一所有权与故障隔离

- `requested` 到 `human_leg_answered`：AI source generation 仍拥有发言/Tool/结束权限；
- `committed` 到 `ai_resume_preparing`：新 human generation 拥有这些权限；
- `ai_resumed`：再下一个 AI generation 获得权限；
- prepare 阶段不提前撤销当前 owner，避免拨号失败造成无声客户；
- commit 是 Store 中 owner + generation + state + receipt 的同一原子事务；
- 媒体/录音/质检/Knowledge/Tool 故障不得自行改变 Handoff owner；
- 录音按稳定 Interaction/Call 继续，owner generation 只作为 segment 元数据；
- Context Packet 构建失败只阻止新 Handoff，不终止既有通话。

## 6. Rust 模块边界

```text
converact-agent-handoff-core
  IDs / ContextPacket / HandoffSession / transition / reconcile decision / ports

converact-agent-handoff-store
  additive schema / tenant transaction / command dedupe / CAS / lease / receipt

converact-voice-agent-worker
  Handoff orchestration adapter
    -> HandoffStorePort
    -> TelephonyHandoffPort (RustPBX)
    -> ChannelAgentHandoffPort (Active Call)
```

Core 和 Store 不接收 Provider URL、数据库凭据、SIP 消息、RTP 包或 Agent framework 对象。
Provider Adapter 只能返回 typed observation。

## 7. 命令与查询

首轮 Rust 命令：

- `RequestHandoff`；
- `PrepareHandoff`；
- `ObserveHumanLegDialing`；
- `ObserveHumanLegAnswered`；
- `CommitHuman`；
- `MarkHumanActive`；
- `PrepareAiResume`；
- `CommitAiResume`；
- `AbortHandoff`；
- `RequireReconcile`；
- `ResolveReconcile`。

外部 effect 使用 durable intent/receipt：先 Store prepare，再调用 RustPBX/Channel Agent，最后 Store
finalize。结果未知时只 query；禁止用第二次 originate/start 替代 query。

## 8. 精准测试与状态声明

首轮只运行：

- Handoff Core 状态/所有权/generation/revision/idempotency 单元测试；
- Handoff Store schema 与受控事务测试；
- Voice Agent Worker Handoff 纵向测试；
- 上述 crate 的 scoped Clippy 和 format check。

不自动运行全仓回归、Docker、性能、容量或真实服务器测试。未证明项明确记录为 `not_run`，不会从
Tool Broker、旧 warm-transfer TypeScript 或 Voice↔LiveKit Handoff 继承证据。

截至 2026-08-31，本地受控证据已覆盖 Rust Core、命令/receipt Store、惰性 PostgreSQL
Adapter、Worker normal/replay/abort/unknown-query 路径和 AI/human generation 切换，详见
[R1 human Handoff evidence](../../architecture-foundation/ai-outbound/evidence/r1-human-handoff/README.md)。
具体 Active Call 私有进程端口还通过了 replacement-session 存在性查询、AI generation
commit 时再次确认、确定性缺失处理和 human-generation 后旧播放 interrupt 的本地 loopback 合同，详见
[R1 Active Call Handoff Adapter evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-handoff-adapter/README.md)。
Active Call `/command` 只证明命令入队，不证明执行或媒体-owner 已改变。
物理 PostgreSQL、真实 RustPBX/Active Call/人席、SIP/PSTN/媒体/录音和生产仍为 `not_run`。

## 9. 与未来跨渠道架构的关系

本设计固定的是稳定 Interaction、Context revision、owner generation、prepare/commit/abort/query/
reconcile 与 typed Channel ports。后续 SIP↔LiveKit↔text、ViLTE 或 AI↔AI specialist 可以复用这套
合同，但每种 Channel 的媒体桥、容量、加密、参与者清理和切换间隙仍需独立证据，不能把电话人工
接管测试当作跨渠道通过。
