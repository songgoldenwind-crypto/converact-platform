# Converact AI 外呼与 Voice Agent 平台设计 R1

> 日期：2026-08-31
>
> 状态：`accepted_design / controlled_tracer_bullet_passed / production_not_run`
>
> 适用范围：Converact Engage、Converact Agent Runtime、Converact Fabric 电话通道
>
> 优先级：先完成行业通用 AI 外呼功能闭环，再进行容量压测和性能优化
> Active Call 精确源码：`miuda-ai/active-call@6224d948cc0941ac48b4a5426477aeaf639c2e98`

## 1. 决策摘要

Converact 在现有平台内优先建设行业通用 AI 外呼能力，不建立独立的汽车保养演示项目，
也不建立第二套 PBX、Campaign、Agent 或业务状态权威。

固定架构如下：

```text
Converact Platform（Rust 业务与状态权威）
  ├── Agent Definition / immutable Agent Release
  ├── Campaign / Audience / Dial Policy
  ├── Call Attempt / Interaction / Outcome
  ├── Workflow / Knowledge / Tool / Memory / Policy
  ├── Human Handoff / Evaluation / Dashboard
  └── durable command, event, effect and recovery
               │
               │ mTLS + idempotent command + normalized event
               ▼
Converact Active Call Adapter（Rust）
               │
               │ loopback/private HTTP + WebSocket
               ▼
Active Call 0.3.83（独立 Rust 进程，电话 Channel Agent）
               │
               │ internal SIP endpoint
               ▼
RustPBX（Call/Leg/SIP 呼叫控制、路由、CDR 与录音决策）
               │
               ▼
Kamailio / Trunk / PSTN
```

核心裁决：

1. RustPBX 是 SIP/PSTN Call 与 Leg 权威；Active Call 不是第二 PBX。
2. Converact 是 Agent、Campaign、Workflow、Tool、Action、Outcome 和业务状态权威。
3. Active Call 只承担电话通道中实时 Voice Agent 的独特执行能力。
4. Active Call 以独立进程部署，避免它的故障拖垮 RustPBX 或平台 API。
5. LiveKit Agents 保留 Room、WebRTC、视频、多模态和 LiveKit job lifecycle 能力；不用于替代
   RustPBX 电话通道。
6. Hugging Face `speech-to-speech` 后续只替换与 VAD/STT/LLM/TTS 重叠的执行链，不能替换
   Active Call 或 LiveKit Agents 的非重叠通道能力。
7. 服务端新增业务代码优先使用 Rust；Python 仅允许作为受控模型/GPU executor。
8. 本阶段以功能完整、故障语义和可维护性为验收重点；性能、容量和长稳结论保持
   `not_run`，不得借用上游声明。

## 2. 产品范围

### 2.1 产品定位

这是一个行业无关的 AI 外呼与 AI-Native Call Center 平台能力，不是某个垂直行业的固定
业务程序。汽车保养、金融回访、保险续期、电商营销、运营商提醒、客户服务等均通过下列
可配置对象形成 Solution/Profile：

- Agent Release；
- Conversation Flow；
- Prompt；
- Knowledge；
- Tool；
- Audience 与客户字段；
- Dial Policy；
- Compliance Policy；
- Outcome Schema；
- Evaluation Rubric。

领域差异不得写入 SIP、媒体、Campaign 调度器或 Active Call Adapter。

### 2.2 首个完整能力闭环

```text
创建 Agent
  -> 发布不可变 Agent Release
  -> 创建 Campaign 并导入客户
  -> 合规检查、容量预留和拨号调度
  -> RustPBX 发起 SIP/PSTN 呼叫
  -> 客户接听
  -> 连接 Active Call
  -> AI 身份/录音披露
  -> 多轮对话、打断、DTMF、知识和工具
  -> AI -> 人工 -> AI（可选）
  -> 结束呼叫
  -> CDR、录音状态、转写、摘要、意图、结果和质检
  -> Campaign 与 Agent 数据视图
```

### 2.3 本阶段明确不做

- 不做 100K、VOS-EQ 或生产容量签署；
- 不做性能优化驱动的架构重写；
- 不用本机 Docker；
- 不改变当前服务器正在运行的服务、容器或代码；
- 不把 Active Call 的公开 benchmark 当作 Converact Evidence；
- 不开放 Active Call 原生管理端点给浏览器、租户或公网；
- 不在首轮同时迁移 LiveKit 视频 Agent、ViLTE 或完整 HF SpeechRuntime；
- 不在许可证文件缺失且未审查前 vendor 或分发 Active Call 源码。

这些内容没有被放弃，只是按“先平台功能、后性能资格”的当前策略延期。

## 3. 当前状态、目标状态与生产资格

| 能力 | 当前状态 | 本设计目标 | 生产资格 |
| --- | --- | --- | --- |
| 现有 Agent/Campaign/Call Center UI 与 API | TypeScript 旧写路径仍存在；只读兼容映射已通过本地测试 | 保持兼容，权威写入迁到 Rust | writer switch `not_run` |
| RustPBX 呼叫链 | Rust RWI v1 适配器与失败语义已通过本地合同测试 | 成为外呼 Call/Leg 唯一权威 | real RustPBX `not_run` |
| Active Call 源码 | 已下载、精确 commit/hash 已核验 | 受控电话 Channel Agent | `false` |
| Active Call 构建/测试 | 固定源码本地构建通过；上游测试因外部 `sipbot` 缺失为 `blocked_external`；Converact Adapter 11 项本地测试通过 | 自有 lockfile、构建和合同测试 | runtime/production `not_run` |
| 多轮实时语音 | 受控端口完成 reserve/originate/attach/disclosure/start/finalize；未启动真实进程 | Active Call 驱动的真实功能闭环 | real media/provider `not_run` |
| Tool/Action | Rust Proposal/Policy/Approval/Broker/Receipt、持久化 Adapter、Active Call Worker 桥接及通用查询/变更 Adapter 已通过本地受控测试 | 接入真实 Provider | controlled slice passed；real provider/physical PostgreSQL `not_run` |
| AI/人工协作 | 有产品与通信设计 | durable prepare/commit/abort/reconcile | `not_run` |
| Transcript/Outcome/QM | 受控 Worker 已验证 final segment count 与 bounded outcome；完整 transcript/summary/QM 未实现 | 统一 ID、幂等投影和异步补偿 | complete projection `not_run` |
| 性能/容量/长稳 | 旧证据不能继承到新链路 | 功能稳定后单独执行 | `not_run` |

`target`、`implemented`、`tested` 和 `production_eligible` 是不同状态。实现代码不能自动把任何
资格改为通过。

## 4. Authority 与进程边界

### 4.1 单一 Authority 表

| 领域 | 唯一 Authority | Active Call 可做什么 | Active Call 不可做什么 |
| --- | --- | --- | --- |
| Tenant、用户与权限 | Converact Platform | 接收已裁决的运行上下文 | 自建租户或认证体系 |
| Agent 与 Release | Converact Platform | 执行已发布快照 | 修改或隐式升级 Release |
| Campaign 与客户状态 | Converact Platform | 无 | 调度、重试、修改联系人状态 |
| Workflow/Tool/Memory | Converact Platform | 提出工具请求、消费结果 | 直接写 CRM/订单/支付或业务 Memory |
| Call/Leg/Dialog/route | RustPBX | 作为内部 SIP endpoint | 成为 PBX、路由或 CDR 权威 |
| 电话 Agent 媒体会话 | Active Call | VAD、语音流水线、打断、DTMF、播放 | 决定业务路由、计费或通话结果 |
| Room/WebRTC/视频 | LiveKit | 无 | 用 SIP 音频接口冒充视频网关 |
| Billing/CDR | RustPBX + 平台账本的既定边界 | 上报观察事件 | 写第二份账单或 CDR |
| Recording 决策与归属 | RustPBX/Converact | 按指令提供媒体执行 | 改变 consent、retention、业务归属 |
| Outcome/Evaluation | Converact Platform | 提供转写和运行指标 | 直接改变 Campaign 业务结果 |

### 4.2 为什么 Active Call 独立进程

Active Call 和 RustPBX 都使用 Rust，不等于必须编译进同一二进制。独立进程边界提供：

- Voice Agent、Provider SDK、Playbook 或模型崩溃不会终止 PBX；
- 独立升级、回滚和容量控制；
- 能对不可信工具、环境变量和 Provider 凭据设置更小权限；
- 可以在拨号前进行容量预留，避免客户接听后才发现 Agent 不可用；
- 可在以后替换内部实现而不改变 Campaign、Call 或 Action 领域模型。

独立进程不意味着独立产品权威。平台通过 Rust Adapter 隐藏原生协议，并使用统一 ID、幂等、
generation fencing 和恢复合同。

### 4.3 Active Call 原生接口的限制

源码审查发现当前 Active Call 具有 Call command/event、SIP/WebRTC/WebSocket、Playbook、DTMF、
REFER、barge-in、Provider 和 HTTP Tool 等能力，但其原生接口不满足平台边界：

- 管理/Call API 没有 Converact 租户权限语义；
- 原生事件没有 Converact generation、global sequence 和 effect receipt；
- 内部存在内存 Call registry 和无界 channel，需要后续资格测试；
- Playbook 可直接发 HTTP，存在 SSRF、越权和重复外部效果风险；
- 配置环境变量展开和 Provider key 不能直接暴露给租户；
- 本地 recording/CDR 不能形成第二份权威。

因此生产形态必须是 `Converact Adapter -> private Active Call`，不能让业务代码、页面或租户直接
依赖 Active Call 原生 API。

## 5. 领域模型

### 5.1 核心实体

```text
AgentDefinition
  └── AgentRelease[]（不可变）
        ├── PromptRevision
        ├── ConversationFlowRevision
        ├── KnowledgeRevision[]
        ├── ToolRevision[]
        ├── SpeechProfileRevision
        ├── CompliancePolicyRevision
        ├── OutcomeSchemaRevision
        └── EvaluationRubricRevision

Campaign
  ├── AgentReleaseId
  ├── AudienceId
  ├── DialPolicyRevision
  ├── Schedule
  └── CampaignContact[]
        └── CallAttempt[]
              ├── RustPBX CallId / LegId[]
              ├── InteractionId
              ├── ChannelAgentSession[]
              ├── HumanHandoff[]
              ├── ConversationTurn[]
              ├── ActionReceipt[]
              ├── CallOutcome
              └── Evaluation[]
```

### 5.2 不变量

1. `AgentRelease` 发布后不可修改；修改产生新 Release。
2. Campaign 必须绑定精确 `AgentReleaseId`，不能运行时跟随 `latest`。
3. 每次物理拨号产生新的 `CallAttemptId`；重试不能复用旧 Attempt。
4. `InteractionId` 在 AI -> 人工 -> AI 期间保持稳定。
5. 每次通道执行或控制权切换增加 `ExecutionGeneration`。
6. 旧 generation 的命令、事件、工具结果和媒体控制必须被拒绝。
7. SIP `Call-ID`、RustPBX `CallId`、业务 `InteractionId` 和 `CallAttemptId` 不得混用。
8. Partial transcript 是瞬时数据；Final transcript 才能进入 durable projection。
9. RustPBX CDR 是电话事实来源；平台只建立关联投影和业务结果。
10. 同一 directed external effect 只能有一个 idempotency key 和一个权威 receipt。
11. 状态未知时先 reconcile，不能直接重拨或重复执行工具。

### 5.3 标识和版本字段

所有跨进程命令与事件至少包含：

```text
TenantId
InteractionId
CampaignId
CampaignContactId
CallAttemptId
CallId（建立后）
AgentReleaseId
ChannelAgentSessionId
ExecutionGeneration
IdempotencyKey / EventId
OccurredAt + ReceivedAt
TraceId
SchemaVersion
```

## 6. 状态机

### 6.1 Campaign

```text
draft
  -> scheduled
  -> running <-> paused
  -> draining
  -> completed

draft/scheduled/running/paused/draining -> cancelled
completed/cancelled -> archived
```

- `paused` 不 claim 新 Attempt，活动通话继续；
- `draining` 不 claim 新 Attempt，等待活动 Attempt 收敛；
- `cancelled` 阻止新拨号，活动呼叫按显式策略结束或排空；
- Campaign 完成以 durable Attempt 汇总为准，不能依赖内存计数。

### 6.2 Call Attempt

```text
planned
  -> claimed
  -> compliance_approved | compliance_blocked
  -> agent_capacity_reserved
  -> dialing
  -> ringing
  -> answered
  -> agent_connecting
  -> disclosure_pending
  -> conversing
       -> handoff_pending -> human_active -> ai_resuming -> conversing
  -> finalizing
  -> completed
```

允许的异常终态/中间态：

- `cancelled`；
- `busy`；
- `no_answer`；
- `rejected`；
- `failed_before_answer`；
- `failed_after_answer`；
- `outcome_unknown`；
- `reconcile_required`。

`outcome_unknown` 与 `reconcile_required` 不能自动进入新拨号。Reconciler 必须查询 RustPBX、
Active Call 和 effect receipt 后作出唯一收敛决定。

### 6.3 Agent Release

```text
draft -> validating -> published -> retired
                   \-> rejected
```

`published` 只能读取；`retired` 阻止新 Campaign 绑定，但不破坏仍在运行的 Campaign 和历史审计。

### 6.4 Handoff

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

只有观察到人工 Leg 已连接后才能 `commit`。Abort 必须恢复 AI 或按政策结束，不能留下无声客户。

## 7. 正常执行流程

### 7.1 发布 Agent

1. 校验 Prompt、Flow、Knowledge、Tool schema、Speech profile 和合规政策；
2. 固定所有引用版本；
3. 计算 canonical content hash；
4. 生成不可变 `AgentRelease`；
5. 执行静态安全检查和受控场景测试；
6. 发布后禁止原地修改。

### 7.2 Campaign 调度与拨号

1. Worker 以有界 batch 和租约 claim `planned` Attempt；
2. 检查租户、DNC、同意、时区、允许拨打时间、频次和号码；
3. 校验 Campaign 与 Agent Release 未失效；
4. 向 Active Call Adapter 预留容量并预热 Agent session；
5. 只有容量确认后才调用 RustPBX originate；
6. RustPBX 返回 Call/Leg 标识并持续提供状态；
7. 客户接听后桥接内部 Active Call SIP endpoint；
8. Agent 媒体 ready 后先播放 AI 身份和录音披露；
9. 披露成功后进入业务对话；
10. 通话完成后分别收敛 RustPBX、Agent、Action、Transcript 和 Outcome。

### 7.3 对话执行

Active Call 执行：

- VAD、turn detection、ASR、LLM、TTS；
- realtime speech provider；
- barge-in、interrupt、pause/resume；
- DTMF；
- 电话 Channel Agent 本地运行状态；
- 受控的 Playbook 表达。

Converact 执行：

- Agent Release 和工作流权威；
- Knowledge 访问策略；
- Tool 授权和外部效果；
- Memory 提交；
- Campaign 和客户状态；
- 合规与审批；
- 人工协作；
- Outcome 与 Evaluation。

### 7.4 Transcript

- `TranscriptDelta` 只进入有界内存流和实时 UI；
- `TranscriptFinal` 使用 segment ID 和 generation 幂等落库；
- 迟到的旧 generation final 可作为审计证据，但不能改变当前会话控制；
- Transcript 和音频 retention 独立配置；
- Provider metadata 不能记录完整音频、Prompt、密钥或未经授权的全文。

## 8. Active Call Adapter 合同

### 8.1 Rust 模块

```text
server-rs/crates/active-call-adapter/
  src/
    command.rs
    event.rs
    ids.rs
    client.rs
    mapper.rs
    registry.rs
    capacity.rs
    fence.rs
    transcript.rs
    recovery.rs
    error.rs
```

实际目录可在实施计划中小幅调整，但领域边界不能变化。

### 8.2 Canonical commands

```text
PrepareSession
AttachCall
StartConversation
PlayDisclosure
Interrupt
Pause
Resume
SendDtmf
RequestHandoff
ResumeAgent
AppendToolResult
TerminateSession
QuerySession
```

每个命令拥有：

- 唯一 idempotency key；
- deadline；
- tenant 与 release binding；
- expected generation；
- 成功、确定失败和状态未知三类结果；
- 可查询的 receipt。

### 8.3 Canonical events

```text
AgentReserved
AgentReady
MediaReady
DisclosureStarted
DisclosureCompleted
CustomerSpeaking
CustomerSilence
AgentSpeaking
AgentInterrupted
TranscriptDelta
TranscriptFinal
ToolProposed
ToolResultConsumed
HandoffRequested
MediaInterrupted
ConversationCompleted
AgentFailed
SessionClosed
```

Adapter 负责把 Active Call 原生 command/event 映射到这些合同。上游新增事件在未明确映射前必须
fail closed 或进入受控 `UnknownUpstreamEvent` 审计，不能悄悄改变状态。

### 8.4 网络和安全

- Active Call 原生端口仅监听 loopback 或私有 sidecar 网络；
- 进程外 Converact 调用统一使用 mTLS；
- 不允许浏览器直连；
- Secret 只能通过 Secret Ref 注入，不能进入 Agent Release JSON；
- Active Call 进程使用最小网络、文件和系统权限；
- Tool HTTP、任意 webhook 和租户提供 URL 默认禁止；
- 低基数 metric 不使用 CallId、TenantId 或 InteractionId 标签。

## 9. Tool、Knowledge、Memory 与 Action

### 9.1 Tool Proposal

Active Call 不能直接执行租户业务 Tool。统一链路：

```text
Active Call FunctionCall
  -> Active Call Adapter
  -> ToolProposal
  -> Tool Broker schema validation
  -> Policy / tenant / role / consent / approval
  -> Action Authority idempotent execution
  -> ActionReceipt
  -> Active Call Adapter
  -> Agent continues conversation
```

`ToolProposal` 至少包含：

```text
tenant_id
interaction_id
call_attempt_id
execution_generation
agent_release_id
tool_revision_id
tool_schema_hash
tool_call_id
arguments_hash
arguments
requested_at
deadline
```

### 9.2 Effect 规则

- 查询与变更工具必须分类；
- 变更工具必须使用 durable idempotency key；
- receipt 是“是否已发生外部效果”的唯一判断依据；
- timeout 不等于失败；timeout 后先 query/reconcile；
- 旧 generation 结果只能作为历史，不能驱动当前 Agent；
- 高风险动作必须进入既有审批策略；
- 通话结束不代表已经开始的 effect 可以被重复执行。

### 9.3 Knowledge

Knowledge provider 只返回证据和检索结果，不拥有对话状态。查询必须绑定 tenant、Agent Release、
知识版本和允许的数据范围。检索失败可以降级为无知识回答或转人工，但不得终止媒体链路。

### 9.4 Memory

- Session working memory 可短暂存在于 Agent 执行上下文；
- durable customer/interaction memory 只能由 Converact 提交；
- 模型输出不能未经策略和 schema 校验直接写长期 Memory；
- 人工修正和业务事实优先于模型推断。

## 10. AI 与人工座席闭环

### 10.1 Context Packet

转人工时生成版本化 Context Packet：

- 客户和任务摘要；
- 已完成的对话摘要和 final transcript；
- 意图、情绪、风险和置信度；
- 已执行工具和 receipt；
- 未解决问题与推荐下一步；
- AI 身份/录音披露状态；
- RustPBX Call/Leg 关系；
- Agent Release 与 execution generation。

### 10.2 控制权切换

1. Agent 提出 handoff；
2. Converact 选择队列/技能/座席并创建 Handoff；
3. RustPBX 建立人工 Leg；
4. 人工接听后提交 handoff；
5. generation 增加；
6. AI 停止发言，按策略退出、静默监听或作为坐席辅助；
7. 人工完成后可结束或请求 AI resume；
8. AI resume 再次增加 generation，并使用新上下文继续。

任何时候都不能让两个 generation 同时拥有发言、工具或结束通话权限。

## 11. API 与兼容迁移

### 11.1 对外 API 策略

首轮保留现有 Call Center 页面和 API 契约，降低 UI 和产品闭环的返工。新增 Rust canonical
command 后，由兼容层把现有请求转换为新模型。

需要补充的最小资源：

- Agent Release 发布和查询；
- Call Attempt 明细、事件和 reconcile 状态；
- Handoff 状态和 context packet；
- Action receipt；
- Conversation transcript/outcome/evaluation；
- Active Call worker health/capacity（仅内部管理）。

### 11.2 写 Authority 迁移

```text
阶段 A：旧 TypeScript 作为 baseline，新 Rust 只做合同和 shadow 校验
阶段 B：选定租户/测试数据由 Rust 写入，旧路径只读投影
阶段 C：Rust 成为全部新对象的唯一 writer
阶段 D：排空旧任务并 reconcile active-zero
阶段 E：删除旧 TypeScript 业务写入逻辑
```

不允许同一实体长期存在双写或双状态机。兼容接口不等于兼容旧 Authority。

## 12. Rust 代码结构

首轮目标结构：

```text
server-rs/
├── crates/
│   ├── voice-agent-contracts/
│   │   ├── identifiers
│   │   ├── commands
│   │   ├── events
│   │   ├── state
│   │   └── errors
│   ├── ai-outbound-core/
│   │   ├── agent_release
│   │   ├── campaign
│   │   ├── compliance
│   │   ├── call_attempt
│   │   ├── scheduler
│   │   ├── handoff
│   │   ├── outcome
│   │   ├── persistence
│   │   └── recovery
│   └── active-call-adapter/
│       ├── protocol mapping
│       ├── client
│       ├── capacity
│       ├── fencing
│       └── reconciliation
└── apps/
    └── converact-voice-agent-worker/
```

第一阶段先让 PostgreSQL repository 保持为 `ai-outbound-core` 的内部实现，避免为目录整齐而过度
拆 crate。只有出现独立稳定边界和多个真实消费者时再拆分。

## 13. 合规和安全门

外呼前必须通过：

- 租户和 Campaign 权限；
- 客户同意/合法处理依据；
- DNC 与退订；
- 客户所在地时区和允许拨打时间；
- 频次、失败重试和号码策略；
- 录音/转写政策；
- 行业与地区特定限制；
- Agent Release 已发布且未被禁用；
- Tool 和数据区域政策；
- Agent 容量已预留。

接听后，在业务对话之前完成：

1. AI 身份披露；
2. 需要时的录音/转写告知；
3. 必要的继续同意或退出路径。

披露失败、被打断或客户拒绝时，系统必须根据政策重播、转人工或结束，不能默认进入业务对话。

## 14. 故障语义

| 故障 | 必须行为 | 禁止行为 |
| --- | --- | --- |
| Active Call 在拨号前不可用 | 不拨号，释放/延期 Attempt | 先让客户接听再等待 Agent |
| 客户接听后 Agent 失败 | 安全提示，按策略转人工或结束 | 静音等待或继续计费不处理 |
| ASR/LLM/TTS Provider 失败 | 有配置则切换；否则降级/转人工 | 拖垮 RustPBX |
| Tool 失败 | 话术降级、重试或人工处理 | 结束媒体或假报成功 |
| Tool timeout | 查询 receipt/reconcile | 直接重复变更操作 |
| Knowledge 失败 | 无知识降级或转人工 | 终止媒体 |
| Recording 失败 | 通话继续、异常审计和补偿 | 把 recorder 设为媒体同步依赖 |
| Transcript/摘要/QM 失败 | durable retry | 使通话结果丢失或重复拨号 |
| PostgreSQL 不可用 | 停止 claim 新 Attempt | 在无 durable intent 下新拨号 |
| Worker 崩溃 | 租约到期后 reconcile | 盲目重播命令 |
| 事件重复/乱序 | event id/sequence/generation 去重 | 重复转接、工具或结束 |
| 状态未知 | `reconcile_required` | 自动判定失败并重试 |

活动媒体必须尽可能独立继续；数据库、录音、质检、Dashboard、Knowledge 或 Tool 的单点故障不能
成为通话中断的传播路径。

## 15. 恢复与一致性

### 15.1 Worker 租约

- Attempt claim 使用有到期时间的 durable lease；
- 每次接管增加 fence token；
- 旧 worker 的续租、状态写入和命令被拒绝；
- batch 有界，不能扫描全表或为每条记录无限生成 task。

### 15.2 Reconciler

Reconciler 查询：

- durable intent；
- RustPBX Call/Leg 当前状态和最终 CDR；
- Active Call session 查询结果；
- Handoff 和人工 Leg；
- Tool action receipt；
- final transcript/outcome projection。

根据观测将状态收敛为继续、结束、补投影、释放资源或进入人工处置。不存在足够证据时保持
`outcome_unknown`，不得编造成功或失败。

### 15.3 终态顺序

媒体结束、SIP 结束、Agent session 关闭、Transcript final、外部 effect 完成和 CDR 到达可能乱序。
系统使用独立 observed flags 和最终收敛条件，不能假设某个 webhook 是最后事件。

## 16. 可观测性

首轮功能阶段仍需提供：

- Campaign/Attempt 状态数量；
- 拨号、接听、Agent connect、披露、对话、handoff 和完成事件；
- Adapter command latency 与错误分类；
- Active Call worker ready/capacity；
- Provider 和 Tool 错误；
- duplicate、stale generation、reconcile required 计数；
- transcript final、outcome 和 evaluation 投影积压；
- TraceId 跨 Campaign Worker、RustPBX、Adapter 和 Action Authority 关联。

指标标签保持低基数。Tenant、Call、Attempt、Interaction、客户号码等只能进入受控 trace/audit，
不能作为 Prometheus 标签。

## 17. TDD 实施顺序

### D0：设计和来源冻结

- 提交本设计；
- 提交 Active Call source lock 和 upstream notice；
- 保持 build/test/runtime/license/production 状态真实；
- 不 vendor Active Call。

### D1：纯 Rust 合同与状态机

- 先写失败测试固定 ID、状态转移、不变量、generation fence、错误分类；
- 再实现 `voice-agent-contracts` 与 `ai-outbound-core` 最小领域模型。

### D2：持久化、租约和恢复

- migrations 与 repository；
- Attempt claim、lease、fence；
- idempotent command/event；
- crash/reconcile 测试。

### D3：Active Call Adapter

- 使用固定 upstream JSON 样本编写 mapping contract tests；
- 实现 command/event 映射；
- 实现 private client、health、capacity、fence 和 query；
- 生成并审查依赖 lockfile；
- 完成 upstream build/test，不借用 upstream 声明。

### D4：RustPBX 外呼纵向切片

- 合规 gate；
- Agent capacity reserve；
- RustPBX originate；
- answer 后桥接；
- disclosure；
- 多轮语音；
- hangup 与最终收敛。

### D5：知识、工具和外部效果

- ToolProposal（本地受控合同已通过）；
- schema/policy/approval（本地受控合同已通过）；
- ActionReceipt（本地受控合同已通过）；
- timeout/reconcile（本地受控合同已通过）；
- 一个查询型与一个变更型通用工具演示（本地受控测试已通过；真实 Provider `not_run`）。

### D6：AI/人工/AI

- Handoff state machine；
- Context Packet；
- RustPBX 人工 Leg；
- commit/abort/reconcile；
- AI resume 和 generation 切换。

### D7：结果、质检和现有 UI

- final transcript；
- summary/intent/disposition/outcome；
- evaluation 和 bad case；
- Campaign/Agent dashboard；
- 现有 API 兼容和 writer 切换。

### D8：功能验收

- 真实或明确标记的受控 SIP 功能链；
- 崩溃、重复、乱序和降级矩阵；
- 安全与合规检查；
- 未满足外部前置条件的项目保持 `not_run`。

性能、容量、长稳和 VOS-EQ 在功能状态机稳定后另立资格阶段，不与 D0-D8 混写结果。

## 18. 首个版本验收场景

必须能完整展示并留下证据：

1. 创建行业无关 Agent Definition；
2. 发布不可变 Agent Release；
3. 创建 Campaign、导入联系人并启动；
4. 合规失败联系人不拨号且有明确原因；
5. 合规通过联系人产生独立 Attempt；
6. RustPBX 发起并观测呼叫；
7. 客户接听后 Active Call 媒体 ready；
8. AI 在业务对话前完成身份/录音披露；
9. 多轮对话、客户打断和 DTMF 正常；
10. 知识查询正常；
11. 一个查询工具和一个变更工具通过 receipt 完成；
12. AI 请求转人工，人工获得 Context Packet；
13. 人工可结束或把控制交还 AI；
14. 通话结束后可见 CDR 关联、录音状态、final transcript、摘要、意图、结果和质检；
15. 模拟 Worker 中断、事件重复和乱序后，不重复拨号、不重复外部效果并最终收敛。

验收记录必须区分 `mock`、`loopback`、`controlled integration`、`real provider`、`real SIP/PSTN`
和 `production`，不能跨等级继承。

## 19. Active Call 来源与法律门

精确来源记录位于：

- `infra/converact/active-call/source-lock.json`；
- `infra/converact/active-call/UPSTREAM.md`。

当前已核验：

- repository、commit、tree；
- codeload archive SHA-256 与大小；
- git archive SHA-256；
- Cargo.toml/README SHA-256；
- upstream version 和文件数量。

当前未完成：

- dependency closure；
- license review；
- 上游依赖外部 `sipbot` 的完整测试收敛；
- runtime integration；
- production qualification。

当前本地已完成且不可向更高证据等级继承：

- 固定源码构建 `passed_local`；
- Converact Active Call Adapter 11 项合同/客户端测试；
- RustPBX RWI Adapter 6 项合同/客户端测试；
- Rust 领域、持久化 schema 与 Worker 受控功能测试；
- 固定源码身份脚本重复核验。

详细命令、计数和 `not_run` 矩阵见
[R1 tracer-bullet evidence](../../architecture-foundation/ai-outbound/evidence/r1-tracer-bullet/README.md)。

上游 `Cargo.toml` 和 README 声明 MIT，但固定源码树缺少其引用的 `LICENSE` 文件。因此允许本地
阅读和设计，不允许在法律/许可证门完成前 vendor 或分发。法律门只限制分发和启用，不阻止
独立完成不包含上游源码的 Converact 合同、状态机和 Adapter 测试桩。

## 20. 后续演进接口

本设计保留但不提前耦合：

- HF SpeechRuntime 替换重叠的 VAD/STT/LLM/TTS execution；
- LiveKit Room/视频/音频 Channel Agent；
- SIP/PSTN Voice 与 LiveKit Room 的双向切换；
- ViLTE/4G 视频线路和双向 AV Gateway；
- 多语言实时字幕与语音翻译；
- AI-native Task、Tool、Memory、Policy、Approval、Action Ledger；
- Provider A/B、模型路由、质量闭环和自动优化；
- 功能完成后的性能与容量优化。

这些通道共享 `InteractionId`、Agent Release、Tool/Action、Memory、Policy、Outcome 和 Handoff
语义，但各自保留 Channel Authority。未来增加通道不能复制 Campaign、Workflow、Tool 或业务状态机。

## 21. 设计完成条件与实现检查点

本设计仅在以下条件全部满足后进入实施计划：

- 用户确认架构、领域模型、状态机和首版范围；
- 文档自审无 Authority 冲突；
- Active Call source lock 可重复核验；
- 未证明项保持 `not_run`；
- 没有触碰现有服务器运行服务；
- 实施计划按 TDD 划分可验证纵向切片；
- 代码阶段只修改明确相关文件，并保留仓库现有用户改动。

截至 2026-08-31，上述设计门已完成，D1-D4 的首条受控 Rust tracer bullet 与 D5 Tool Broker
Core/Store/Worker 桥接、通用查询/变更 Adapter 已通过；这只证明 `controlled_test_double` 与本地合同层。物理 PostgreSQL、
真实 RustPBX、真实 Active Call、SIP/PSTN、真实 Tool/审批供应商、录音、完整 final transcript、
人工切换、质检、性能、容量和生产部署均保持 `not_run`，后续必须按独立 Evidence Gate 逐项推进。

## 22. 关联文档

- [统一通信底座 R5](./unified-communication-foundation-r5.md)
- [外部 Intelligence Provider 边界](./external-intelligence-provider-boundaries.md)
- [ADR-CCAAS-9：Channel Agent 与 Speech Runtime](../adr/ccaas-9-channel-agent-and-speech-runtime.md)
- [统一平台范围 R2](./2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)
- [Active Call source lock](../../infra/converact/active-call/source-lock.json)
- [Active Call upstream notice](../../infra/converact/active-call/UPSTREAM.md)
- [AI 外呼 Active Call Tracer Bullet R1 实施计划](../plans/2026-08-31-ai-outbound-active-call-tracer-bullet-r1.md)
- [AI → Human → AI Handoff R1](./2026-08-31-ai-human-ai-handoff-r1.md)
- [AI → Human → AI Handoff R1 实施计划](../plans/2026-08-31-ai-human-ai-handoff-r1.md)

## 23. 变更记录

| 日期 | Revision | 变更 |
| --- | --- | --- |
| 2026-08-31 | R1 | 固定行业通用 AI 外呼优先路线、Active Call 独立电话 Channel Agent、Rust 权威模型、功能闭环和 TDD 顺序 |
| 2026-08-31 | R1 implementation checkpoint | 记录 Rust 合同、领域、schema、适配器与受控 Worker tracer bullet；真实集成和生产资格仍为 `not_run` |
| 2026-08-31 | R1 Tool checkpoint | Tool Broker/Receipt/Store/Active Call Worker 桥接已有本地受控证据；真实 Provider、物理 PostgreSQL 与生产仍为 `not_run` |
| 2026-08-31 | R1 generic Tool Adapter checkpoint | `customer.lookup` 与 `task.create_follow_up` 的 Rust typed Provider Port 切片已有本地受控证据；真实 Provider 与生产仍为 `not_run` |
