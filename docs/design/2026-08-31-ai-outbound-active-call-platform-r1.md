# Converact AI 外呼与 Voice Agent 平台设计 R1

> 日期：2026-08-31
>
> 状态：`accepted_design / controlled_functional_slices_passed / physical_integrations_not_run /
> production_not_run`
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
| Dial Policy 与 Attempt 拨号快照 | Rust 不可变 Policy、Campaign 绑定、滚动 schema、首次 Attempt/重试快照和 fail-closed load 已通过精准本地测试 | 接入租户 PostgreSQL runtime，旧空快照保持不可拨号 | physical PostgreSQL/runtime composition/production `not_run` |
| RustPBX 呼叫链 | 具体 Rust `TelephonyPort` 已通过本地 loopback：精确 originate、O(1) inspect、answer 后 Agent leg、hangup 与 unknown-outcome；无进程内 Call 表 | 成为外呼 Call/Leg 唯一权威并接入 durable runtime | physical dial store/runtime composition/real RustPBX `not_run` |
| Active Call 源码 | 已下载、精确 commit/hash 已核验 | 受控电话 Channel Agent | `false` |
| Active Call 构建/测试 | 固定源码本地构建通过；上游测试因外部 `sipbot` 缺失为 `blocked_external`；预约、SIP session 绑定和显式启动门已通过本地精确源码/loopback 测试 | 自有 lockfile、构建和合同测试 | runtime/production `not_run` |
| 多轮实时语音 | reserve/originate/attach/disclosure/start/finalize 的 Rust 契约、稳定 Session ID、精确 Release/component resolver、有界 Playbook artifact、SIP 控制头绑定、单 leg claim、精确 disclosure `TrackEnd` 启动门和完整 `ChannelAgentPort` 已通过本地合同；未启动真实进程 | Active Call 驱动的真实功能闭环 | RustPBX header 注入、真实 SIP/media/provider、可听披露与录音连续性 `not_run` |
| Tool/Action | Rust Proposal/Policy/Approval/Broker/Receipt、持久化 Adapter、Active Call Worker 桥接及通用查询/变更 Adapter 已通过本地受控测试 | 接入真实 Provider | controlled slice passed；real provider/physical PostgreSQL `not_run` |
| AI/人工协作 | Rust Handoff Core/Store/Worker 的 commit/abort/replay/unknown-query 和具体 Active Call 私有进程端口已通过本地受控/loopback 测试 | 接入真实人席、RustPBX 媒体切换与 Active Call | physical integration/production `not_run` |
| Transcript/Outcome/QM | Rust final transcript/snapshot/result/evaluation/Bad Case、durable reconcile、权限化查询 API，以及 Active Call intent 候选到精确 Release OutcomeSchema/结果证据的投影已通过本地受控测试 | 接入真实 Speech/模型/UI 并迁移旧 writer | physical integration/writer switch/production `not_run` |
| 逐轮 Intent/Emotion/Dialogue 状态 | Rust Core、closed checkpoint、四领域原子 Store、Worker 恢复/写入端口、tenant PostgreSQL adapter、Active Call final transcript 到原子 Store 的边界、Safety/Fast/Contextual Intent Provider、同轮 Router、显式 Layered Intent Runtime、Text Emotion Provider/text-only checkpoint，以及原始 Intent contributor + resolution 同事务批次已通过本地精准测试 | 接入 Active Call 实时 SSE/有界历史读取、真实 Fast/LLM/文本情绪模型、声学 Emotion Provider、多模态融合、原始 Emotion 证据事务和完整 Worker 进程组合 | physical PostgreSQL/real channel-model integration/restart/two-node/production `not_run` |
| Post-call Finalization | Rust terminal/enqueue 受控原子边界、durable queue、Worker、D7 projection reuse 与进度查询已通过本地精准测试 | 接入物理 PostgreSQL 合并事务和真实终态输入 | physical transaction/real call/production `not_run` |
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

### 6.5 Dial Policy 与物理 Attempt 快照

`DialPolicyRevision` 是发布后不可原地修改的拨号策略，固定：

- revision ID 与 canonical content hash；
- 可选 caller ID；
- `1..=120` 秒拨号超时；
- 可选 trunk；
- E.164 或 SIP/SIPS 地址约束。

Campaign 必须绑定一个已持久化的精确 Policy revision。导入 Contact 时，将 Contact destination 与
Policy 的 revision、content hash、caller ID、timeout 和 trunk 一次性复制到首个物理 Attempt；
Retry 只能从其 predecessor 复制同一快照。Worker 拨号只读取 Attempt 快照，不重新查询可变 Campaign、
Contact 或默认配置，因此重放和恢复不会因后来配置变化而改变目标或线路。

迁移期间旧 Attempt 允许保留全空快照，避免伪造历史和阻塞滚动部署；运行时加载遇到全空、部分空、
非法或 hash 不一致的行必须 fail-closed，不允许回退到环境变量、租户默认值或当前 Campaign Policy。

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

### 9.5 意图识别

Active Call 当前没有独立的结构化 Intent Classifier。现有能力是主对话 LLM 根据 ASR、历史、
Scene、RAG 和 Prompt 做多轮语义判断；`intent_clarification` 仅作为 Prompt 片段要求意图模糊时
先追问；模型可用 `<set_var key="intent" .../>` 将候选写入通话 `extras`。Converact 只从终态
事件接收这个有界候选，并按精确 Agent Release 的闭集 `OutcomeSchema` 校验，生成绑定 Schema、
Release、intent 与 canonical hash 的证据。缺失值保持缺失，越界或跨 Release 值 fail-closed。

截至 2026-09-01，Rust `conversation-understanding-core` 已实现 Release-bound 层级 Intent
Catalog、每个 Intent 的 Slot allow-list、安全关键标签、最多五个有序 top-k 候选、basis-point
置信度、来源/模型版本/turn/transcript evidence、canonical hash 和跨轮
`unknown / provisional / clarification_required / confirmed / changed` 状态机。阈值来自版本化
策略输入，不固化为全局常量；相同 turn、旧 generation、跨 Release/Catalog 和非法 Slot 均
fail-closed，诊断不输出候选与 Slot 内容。即使安全规则确认分类，Core 也只产生 evidence，不产生
转接、挂机、DNC 写入或高风险 Tool 授权。

截至 2026-09-01，首个真实 Rust `SafetyIntentProvider` 已接收经过 Result Core 校验并持有稳定
segment ID 的 final customer transcript。规则集绑定精确 Agent Release 与 Intent Catalog，只能指向
标记为 safety-critical 的闭集 Intent；Exact/Phrase 模式、显式唯一 priority、重复归一化 phrase、
规则/phrase 数量与长度都 fail-closed。Provider revision 由规范化规则全集内容寻址；命中结果使用
provider revision、transcript payload hash 与 turn 派生稳定 observation ID，再通过同一 Core 生成
Intent observation、推进状态并关闭 Intent checkpoint。它没有 Tool、DNC、Handoff、Telephony 或
Media 端口，因此即使确认安全意图也只能产出证据。匹配不使用正则，全文只归一化一次，规则和
phrase 均有硬上限；这只是有界功能合同，不构成性能或准确率资格。

截至 2026-09-01，Rust `FastIntentClassifierProvider` 已实现真实模型之前的 provider-neutral
Layer-1 接入边界。不可变 classifier artifact 精确绑定 Agent Release、Intent Catalog、model、
tokenizer、label map、confidence calibration、支持语言、输入/top-k 上限与 inference deadline；
其中四个模型制品都使用 lowercase SHA-256 身份，规范化全集派生稳定 artifact revision。推理端口
只接收 artifact revision、语言、文本和 top-k，不接收租户、电话或 Campaign 身份；响应必须回显
精确 revision，漂移、超时、越界输入、未知/乱序标签和非法分数全部 fail-closed。空 top-k 是显式
unknown；高分但 Top1/Top2 差值不足进入 `clarification_required`。Provider 只生成
`FastClassifier` observation/state checkpoint，不拥有 Tool、DNC、Handoff、Telephony 或 Media
端口。测试替身只验证合同，不是训练模型，也不构成分类准确率证据。

同日新增的 Rust `IntentConfidenceRouter` 固定同一 customer turn 的 Safety → Fast → Contextual
顺序语义。Safety 命中时短路 Fast；Fast 只有在 `confirmed/changed` 时直接关闭 turn，unknown、
provisional 或低 margin 结果只形成内存 pending resolution，不先推进权威 Intent state。未来
Contextual LLM observation 必须与 Fast 使用同一 Release、Catalog、authority、turn 和当前 transcript
anchor；它可增加有界历史 evidence，并从原 previous state 推进一次；Layer 2 不可用时只能显式
fallback 到原 Fast evidence。
最终 in-memory resolution 规范化并 content-hash 所有唯一 contributor、选中 observation、完整
checkpoint 与实际 basis-point policy，诊断不输出候选、Slot 或 transcript。它仍无动作端口。raw
contributor 与 resolution 现已作为 record-only evidence 与四个 understanding heads 在同一
caller-owned transaction 内写入；selected Intent checkpoint 仍是唯一可推进的 Intent head。

同日完成的 Rust `ContextualIntentClassifierProvider` 已关闭 Layer-2 的 provider-neutral 合同：
artifact 精确绑定 Agent Release、Intent Catalog、model profile、prompt template、label map、
structured output schema 和 confidence calibration，并固定支持语言、历史 segment/byte、top-k、
Slot 与 deadline 上限。输入只接受同 authority、durable sequence 严格递增的 final transcript；当前
segment 必须为 customer，历史允许 AI/customer/human，不允许 System transcript。不同 trace span
不改变 authority。模型端口只看到 artifact revision 和 speaker/language/text 窗口，不接收租户、
电话或 Campaign ID。served revision、标签、顺序、分数和 Slot allow-list 统一 fail-closed；稳定
observation ID 绑定有序 evidence payload hashes 与 turn。测试端口不是实际 LLM，也不构成准确率、
延迟或生产资格。

同日新增的无状态 Rust `LayeredIntentRuntime` 把 Store 顺序窗口的最后一个 final segment 接到
Safety/Fast Router，并仅在 pending 时调用 Contextual Provider。每个 resolution hash 和持久证据都
显式绑定 `safety_short_circuit / fast_confirmed / contextual_selected / fast_fallback` 路径；fallback
还必须绑定关闭原因。Release 可选择 transient failure 时回退 Fast，但只允许模型不可用和超时；
Catalog、artifact、输入、served revision、输出 schema 或 observation 漂移始终 fail-closed。该
Runtime 不拥有 transcript sequence、head、动作或通信状态。它证明了层间组合合同，不等于真实
Active Call consumer、历史仓库或模型进程已接通。

截至 2026-09-01，durable transcript sequence 已有独立 Store 权威：经校验的
`TranscriptSegmentDraft` 不携带 sequence；PostgreSQL adapter 在一个 tenant transaction 内锁定
`tenant / Interaction / execution generation` stream head，先按稳定 `source_event_id` 判定重放，
仅对新事件分配 `last_sequence + 1`，再构造并追加不可变 final segment。segment insert trigger 与
stream-head fence 保证写入成功才推进 head，失败随事务回滚；迁移从旧 segment 最大 sequence 回填，
保留历史空洞并约束同一 stream 不得混用 Attempt/Release。旧 caller-sequenced 写路径暂时保留用于
滚动兼容，但也必须经过同一 head 并只能追加下一位置。

Active Call SSE 到上述 Draft 的真实接入、断线 gap/replay 恢复、实时 binding 派生、租户规则
artifact 解析、真实 Fast Classifier 模型/制品解析、Contextual provider-pool 模型调用、durable
阈值/phrase/置信度校准、Active Call consumer 与有界历史读取、完整四领域逐轮提交和真实意图质量仍为
`not_run`。特别是部分上游 ASR
固定为 `0` 的 `index` 不会被当作
durable turn sequence。Intent checkpoint、sequence authority 和有界 durable Store adapter 已有本地
合同证据，但物理 PostgreSQL 尚未执行。目标实现继续保留 Active Call 的多轮理解，并把规则、
小模型、上下文 LLM 与人工纠正作为独立可审计证据源。

### 9.6 情绪证据与客户压力趋势

Active Call 当前的 `emotion_resonance` 和 `intent_clarification` 是注入主对话 LLM 的 Prompt
片段；`voice_emotion` 与 synthesis `emotion` 主要控制机器人 TTS 表达风格。Playbook 也可以让
LLM 写入 `user_sentiment` 变量。固定源码中没有独立声学情绪分类器、文本情绪分类器、跨模态
分数融合、校准置信度或多轮趋势状态机，因此不得把这些 Prompt/TTS 能力记为已证明的客户情绪
识别。

截至 2026-09-01，Rust `conversation-understanding-core` 已将情绪证据与意图证据分开建模：

- Emotion Catalog 绑定精确 Agent Release，标签不固化到 Provider；每个标签具有
  `negative / neutral / positive` valence 和显式 distress rank；
- Acoustic Model 必须引用 audio evidence window，Text Classifier、Contextual LLM 与 Active
  Call Playbook 必须引用 transcript segment；Human Correction 也作为独立来源而非覆盖原证据；
- 每个观察包含有界 top-k、basis-point confidence、0–4 intensity、Provider revision、turn、
  authority/generation 和 canonical hash，诊断不输出客户标签或证据内容；
- 只有绑定同一 authority、Catalog 和 turn 的 `EmotionFusion` 能更新 `EmotionState`，原始模型
  观察不能直接写状态；融合证据保留有序无关且去重的 contributor hashes；
- 状态区分 `unknown / provisional / confirmed`；仅 confirmed 融合更新连续压力轮数以及
  `unknown / stable / improving / worsening` distress trend，低置信观察不能覆盖上一个确认状态；
- 情绪和压力趋势只是 Customer State evidence，不授权挂机、转人工、DNC、Tool 或业务写入。

截至 2026-09-01，Rust `TextEmotionClassifierProvider` 已实现真实模型之前的 provider-neutral
文本情绪接入边界。不可变 artifact 绑定 Release、Emotion Catalog、model、tokenizer、label map、
calibration、支持语言、输入/top-k 上限与 deadline；端口只接收 revision/language/text/top-k，响应
必须回显精确 revision。只接受 final customer transcript，产生的 `TextClassifier` observation 精确
引用一个 durable segment 且没有 audio evidence。漂移、超时、未知标签、非法 confidence/intensity
均 fail-closed，诊断不输出文本或标签。测试替身不代表真实模型，也不构成情绪质量证据。

同日新增的 `TextEmotionTurnRuntime` 将该 observation 不改分数地包成显式
`text-only-emotion-fusion-v1`，再通过共享 Emotion State 关闭 checkpoint。fusion ID 绑定 raw
observation hash、策略 revision 与 turn；结果保留 raw contributor 并可编码为 record-only
`emotion_observation`。这使文本情绪具有完整状态语义，但不声称已实现声学或跨模态融合。

真实声学 Provider、文本模型运行时、实际融合算法、校准数据、Worker 实时接入、真实音频质量和生产均为
`not_run`。Emotion checkpoint、durable Store adapter 和 Dialogue Policy 的确定性本地合同已通过；
物理 PostgreSQL 尚未执行。原始音频和 transcript 内容不进入该 Core，只持有受控 evidence ID。

### 9.7 Customer State 与 Dialogue Policy

Rust `conversation-understanding-core` 已将同一 tenant/Interaction/Attempt/Call/Release/Agent
session/execution generation 下的 `IntentState` 与 `EmotionState` 合并为不可变
`CustomerStateSnapshot`。快照绑定两个 Catalog revision、最后 turn、各自 evidence hash、完整来源
state fingerprint（含 revision/previous state）与 canonical payload hash；跨 generation/authority、
相同投影但不同来源历史，或早于来源证据的 snapshot clock 均 fail-closed。
日志只显示状态、计数和是否存在证据，不输出客户意图或情绪标签，也不持有 transcript/audio。

Release-bound `DialoguePolicy` 只把 Customer State 确定性映射为有界建议：继续发现、继续 Workflow、
澄清意图、先回应情绪、先回应情绪再澄清、建议人工接管。高压力只在连续确认轮数达到版本化阈值且
趋势继续恶化时产生 `propose_human_handoff`；该值不是 Handoff command，真实接管仍必须通过独立
Handoff Core 的路由、prepare/commit、generation fencing 与 receipt。相同原则适用于 Tool、DNC、
挂机和任何业务写入：理解与对话策略只产出证据/建议，不能绕过各领域 Authority。

Customer State/Dialogue recommendation 已具有 closed versioned checkpoint 和 durable Store codec：
Customer State 恢复必须与精确 Intent/Emotion 来源状态重算一致；Dialogue 恢复必须用含 Release、
revision 和阈值 fingerprint 的精确 Policy 对精确 Customer State 重算，不能信任存储中的
recommendation kind。Worker 的窄持久化端口、单次一致快照恢复、四领域写入批次与 tenant PostgreSQL
adapter 已通过本地合同；真实逐轮 Provider/Active Call 事件接入、Worker 进程组合、物理 PostgreSQL、
Active Call Prompt/Scene 消费、Handoff 提案桥接、策略运营配置和真实通话验证仍为 `not_run`。

### 9.8 理解证据耐久化

Additive migration `133_converact_conversation_understanding.sql` 已冻结不可变 understanding record
与每领域 latest head。record 保存 Intent observation、Emotion observation/fusion、Customer State
snapshot 和 Dialogue recommendation 的规范化载荷、hash、authority/generation、turn、时钟与保留
策略；head 仅保存恢复所需的最新定位和单调 revision。恢复索引以 tenant、Attempt、generation、
domain 开头，禁止依赖全局扫描；head 复合外键必须指向同一 Interaction/Attempt/generation/domain/
turn/time/hash 的实际 record。

record 不允许普通 UPDATE/DELETE，head 只能 revision `+1` 且 turn/time 不倒退。到期清理只能调用
tenant-bound、当前时间上限、每批 1–1000 条的 security-definer retention 函数；运行角色不持有表级
DELETE。Rust SQL Adapter 已实现规范化 object/hash/128 KiB 边界、record-only 与 record+head 两种
追加、exact replay/conflict 分类、revision+record ID+payload hash 三重围栏、按
Attempt/generation/domain 的事务级局部 advisory lock，以及 `load_current` 的 O(1) head+record
恢复查询。完整 EnvelopeContext（含 schema/Campaign/Contact/trace）随 record 保存；raw Emotion
observation 可留证但不能成为权威 head。Intent observation+state 与 Emotion fusion+state 现已使用
closed versioned checkpoint payload；恢复时重算内层 evidence hash，并校验 record kind/ID、完整
Envelope、catalog、turn 和 clock，因此 latest head 一次读取即可恢复当前 Intent/Emotion 状态，不需
扫描通话历史。Customer State snapshot 必须从恢复后的精确 Intent/Emotion state 确定性重建；
Dialogue recommendation 必须由精确 Policy + Customer State 重算。

Worker 现在只依赖 `UnderstandingDurabilityPort`，不接触连接池、SQL 或 transaction。具体
`PostgresConversationUnderstandingStore` 在一个 tenant transaction 内完成：

- 一条有界 SQL 同时读取 Intent、Emotion、Customer State 与 Dialogue 四个 current head/record；
- 全空是合法新会话；部分、重复、跨 authority/generation、head/record domain 漂移一律 fail-closed；
- 按 `Intent -> Emotion -> Customer State -> Dialogue` 固定顺序写入四个 domain；
- 每个 head 都使用 revision、record ID 与 payload hash 三重围栏；
- 全 replay 返回 `replayed`；至少一个 advance 且无 superseded 返回 `applied`；无写入且存在
  superseded 返回 `superseded`；advance 与 superseded 混合在 commit 前报错，整笔事务回滚。

因此冷恢复是“一条 SQL 快照 + 固定四节点内存重建”，每轮提交是“一个 tenant transaction + 固定
四次有界 append”，均不扫描历史。伪造 stored kind、同投影但不同来源历史，以及同输出但阈值不同
的 Policy 都会被拒绝。物理 PostgreSQL 执行、真实 Worker process composition、真实 Provider/Active
Call 逐轮接入、重启/双节点恢复和生产仍为 `not_run`。

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
- RustPBX originate：具体 `TelephonyPort` 的精确 RWI wire、身份校验与 answer 观察已通过本地
  loopback；物理 dial-binding Store、运行时组合与真实进程 `not_run`；
- answer 后桥接：RustPBX `call.leg_add` 创建唯一 Agent SIP leg，Active Call 仅确认关联；本地
  合同已通过，真实 SIP/RTP `not_run`；
- disclosure；
- 多轮语音；
- hangup 与最终收敛：`session.inspect_call` 使用 O(1) Registry lookup；进程内 known-call
  全局表已删除，正常终态和 unknown mutation reconcile 保持不同语义；真实恢复 `not_run`。

### D5：知识、工具和外部效果

- ToolProposal（本地受控合同已通过）；
- schema/policy/approval（本地受控合同已通过）；
- ActionReceipt（本地受控合同已通过）；
- timeout/reconcile（本地受控合同已通过）；
- 一个查询型与一个变更型通用工具演示（本地受控测试已通过；真实 Provider `not_run`）。

### D6：AI/人工/AI

- Handoff state machine 与 Context Packet：本地 Rust 合同已通过；
- durable command/receipt Store 与惰性 PostgreSQL Adapter：本地受控测试已通过，物理数据库
  `not_run`；
- commit/abort/replay/unknown-query 与 AI resume generation 切换：Worker test double 已通过；
- 具体 Active Call Handoff 端口的 replacement-session 查询、缺失判定和 human-generation
  旧播放清理：本地 loopback 合同已通过；`/command` 只证明入队，不冒充执行或媒体切换证据；
- 真实 RustPBX 人工 Leg、Active Call 进程、人席、SIP/PSTN/媒体/录音与生产：`not_run`。

### D7：结果、质检和现有 UI

- final transcript、terminal snapshot 与 generation 分类：本地 Rust 合同已通过；
- Active Call Playbook 的终态 `extra.intent` 已映射为有界、脱敏的候选，只保留该字段；候选到
  精确 Agent Release `OutcomeSchema`、durable result command 与 finalization 的受控投影已通过；
- summary/intent/disposition/outcome 版本投影与 durable effect reconcile：本地受控测试已通过；
- evaluation、rubric 复算和 deterministic Bad Case：本地 Rust 合同已通过；
- tenant-bound Rust result/transcript/evaluation/Bad Case API：本地受控测试已通过，全文权限
  独立且列表不返回 transcript text；
- terminal Attempt 与 post-call job 的受控原子边界、独立 Finalization Worker、D7 projection
  reuse 和有界进度查询已通过；物理 PostgreSQL 合并事务仍为 `not_run`；
- 确定性终态的 Campaign 重试 Core、原子 Store 合同、Worker 编排和有界 inspection 已通过；
  物理 PostgreSQL、真实 Campaign/Contact writer 和真实重拨仍为 `not_run`；
- Agent Release 发布、Campaign 创建/生命周期、1–500 Contact 导入与首个 Attempt 创建的
  Core、Store SQL 合同和受权限 HTTP 边界已通过；具体 `CampaignAdminPort` 到
  `PostgresRuntime` 组合、物理数据库和真实 UI/import 仍为 `not_run`；
- Campaign/Agent dashboard、生产路由/授权接线、现有 TS API shadow parity、writer switch、
  drain/active-zero 与物理集成：`not_run`。

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

截至 2026-08-31，上述设计门已完成，D1-D4 的首条受控 Rust tracer bullet、D5 Tool Broker
Core/Store/Worker 与通用 Tool Adapter、D6 Handoff 以及 D7 Result/Quality 的 Rust
Core/Store/Worker/API、D8 post-call finalization 的本地 Rust 切片均已有受控证据。这只证明
`controlled_test_double` 与本地合同层。Campaign Scheduling & Retry 的 Core/Store/Worker
本地切片也已通过，未知结果禁止重拨；Campaign Authoring 的 Core、Store SQL 合同与
权限化 HTTP 边界亦已通过。具体 PostgreSQL Runtime Adapter、物理事务和真实 Campaign
调度仍未证明。Active Call Adapter 已受控映射上游现有 `speaking`、`eou`、`interruption`、
`dtmf`、`hold` 和 `inactivity` 信号，并避免复制字幕、Play URL、EOU 文本或在 `Debug`
泄露按键。Adapter 同时只开放 Pause、Resume 与非 graceful Interrupt 三个输出控制命令，
不开放 Hangup、REFER 或 Bridge；真实 VAD/打断质量、命令投递与端到端电话路径仍未证明。
具体 `ChannelAgentHandoffPort` 已在本地 loopback 下接入 Active Call client：替换 session 不存在
时确定失败，AI generation commit 前再次确认其仍存在，人工 generation 提交后只清理旧 AI
当前播放，新 AI generation 不错误恢复一个并未暂停的播放轨。该证据不包含 Active Call 命令
执行回执或 RustPBX 媒体-owner 切换。
Active Call Playbook 已识别的终态 `extra.intent` 也已进入规范化事件：值必须是非空、无控制字符、
不超过 256 bytes 的字符串，`Debug` 不显示原文，其他 `extra`（包括客户文本和 Provider 元数据）
全部丢弃。它只是候选证据，不能绕过 Agent Release 固定的 `OutcomeSchema`；本地受控投影已将
Release、Schema、terminal transcript、意图证据与 result revision 绑定到同一摘要，并在 execute、
query/replay 和 finalization 上拒绝漂移。真实 Playbook/模型意图质量仍未证明。
固定 Active Call 精确源码的构建覆盖层也已通过本地受控测试：平台可选择稳定 session ID，同 ID
同 Playbook 可重放，内容漂移返回冲突，并可查询进程内 `pending / attached / media_ready /
disclosure_completed / started / terminal` 和兼容 `active` 状态。Runner 在同一 session 的正时长
披露 `TrackEnd` 到达前保持静默，start 端点只允许从 `disclosure_completed` 进入 `started`。该覆盖层
不改变固定源码 checkout，也不冒充耐久存储、用户可听证明、录音证据或原子 pending-to-active
交接；`404` 不能授权盲目重试。真实 Rust Adapter 和完整 `ChannelAgentPort` 已在 loopback 下组合
Release artifact resolver、稳定 ID 预留、SIP 附着观察、media-ready、披露命令、披露终态、启动和
terminal 查询；同 session 查询与 mutation 串行，较早状态不能清除 disclosure/start 的未知结果，
mutation 不自动重试，也不把 not-found 解释成安全重建。真实进程、durable Worker
协调、重启恢复、真实媒体与生产仍为 `not_run`。
固定 RustPBX 的真实 RWI wire 也已完成一条本地契约切片：客户侧 `call.originate` 使用上游
`call_id / destination / caller_id / timeout_secs / extra_headers / trunk` 字段且
`extra_headers` 固定为空；它不携带 Agent 会话身份。客户接听后，平台使用独立
`call.leg_add` 请求携带有界 `agent_session_id`。ivekit.86 只在该内部 leg 的 INVITE 上生成
`X-Converact-Agent-Session`，普通队列或其他动态 leg 在值缺失时不生成该头；CRLF、超长和非法
标识在进入 `CallCommand` 前 fail-closed，Debug 不显示原值。平台 wire 测试、固定源码三个精确
单测、补丁重放文件摘要及动态-leg 集成目标编译已通过。真实 RustPBX/Active Call 进程、客户接听
事件到 leg-add 的 durable 编排、SIP 头在线观测、RTP 音频与端到端会话附着仍为 `not_run`。
ivekit.87 进一步增加只读 `session.inspect_call`，按 `call_id` 对现有并发 Registry 做单次键查找并
返回精确 `CallInfo` 或 `null`。具体 Rust `TelephonyPort` 已在 loopback 中完成客户 originate、
answer 观察、Agent leg、hangup 与终态查询；mutation receipt 缺失保持 `OutcomeUnknown` 且不重放。
Adapter 不保留进程内 known-call HashSet/Mutex，也不通过 `session.list_calls` 扫描。只有已走过
answer/disclosure/conversation 的编排上下文可在正常 finalization 中把 `NotFound` 接受为终态；
unknown mutation 的 reconcile 仍把原始观察交给后续策略。物理 dial-binding Store、应用组合、
真实进程、重启与媒体仍为 `not_run`。
平台现在还会从 tenant、物理 Attempt 和精确 Release 稳定派生 Active Call Session ID；Agent
不得替换该身份。Release 的八个组件摘要随预留继续传递，有界 Playbook artifact 会校验声明摘要
并隐藏 Prompt 内容。但该边界不冒充源组件到 Playbook 的确定性编译证明。固定源码 overlay 和
完整 `ChannelAgentPort` 的本地组合已经完成；RustPBX 尚未真实注入控制头，真实 SIP-leg、媒体、
provider、可听披露、录音连续性和进程重启恢复仍保持 `not_run`。
物理 PostgreSQL、真实 RustPBX/Active Call/Speech、SIP/PSTN/媒体、真实 Tool/审批/模型供应商、
生产路由授权、Dashboard、旧 writer 迁移、性能、容量和生产部署均保持 `not_run`，后续必须按
独立 Evidence Gate 逐项推进。

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
- [Conversation Result & Quality R1](./2026-08-31-conversation-result-quality-r1.md)
- [Conversation Result & Quality R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-conversation-result-quality/README.md)
- [Campaign Authoring R1 实施计划](../plans/2026-08-31-ai-outbound-campaign-authoring-r1.md)
- [Campaign Authoring R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-campaign-authoring/README.md)
- [Active Call Realtime Event Parity R1 实施计划](../plans/2026-08-31-active-call-realtime-event-parity-r1.md)
- [Active Call Realtime Event Parity R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-realtime-events/README.md)
- [Active Call Output Control R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-output-control/README.md)
- [Active Call Handoff Adapter R1 计划](../plans/2026-08-31-active-call-handoff-adapter-r1.md)
- [Active Call Handoff Adapter R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-handoff-adapter/README.md)
- [Active Call Intent Candidate Parity R1 计划](../plans/2026-08-31-active-call-intent-candidate-r1.md)
- [Active Call Intent Candidate Parity R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-intent-candidate/README.md)
- [Active Call Intent → Outcome Projection R1 计划](../plans/2026-08-31-active-call-intent-outcome-projection-r1.md)
- [Active Call Intent → Outcome Projection R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-intent-outcome/README.md)
- [Emotion Understanding Core R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-emotion-understanding-core/README.md)
- [Text Emotion Classifier Provider R1 计划](../plans/2026-09-01-text-emotion-classifier-r1.md)
- [Text Emotion Classifier Provider R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-text-emotion-classifier-provider/README.md)
- [Text-only Emotion Turn Runtime R1 计划](../plans/2026-09-01-text-emotion-turn-runtime-r1.md)
- [Text-only Emotion Turn Runtime R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-text-emotion-turn-runtime/README.md)
- [Customer State and Dialogue Policy R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-customer-state-dialogue-policy/README.md)
- [Conversation Understanding Store Schema R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-understanding-store-schema/README.md)
- [Conversation Understanding Store Adapter R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-understanding-store-adapter/README.md)
- [Conversation Understanding Checkpoints R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-understanding-checkpoints/README.md)
- [Conversation Understanding Worker R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-understanding-worker/README.md)
- [Safety Intent Provider R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-safety-intent-provider/README.md)
- [Fast Intent Classifier Provider R1 计划](../plans/2026-09-01-fast-intent-classifier-provider-r1.md)
- [Fast Intent Classifier Provider R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-fast-intent-classifier-provider/README.md)
- [Intent Confidence Router R1 计划](../plans/2026-09-01-intent-confidence-router-r1.md)
- [Intent Confidence Router R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-intent-confidence-router/README.md)
- [Contextual Intent Provider R1 计划](../plans/2026-09-01-contextual-intent-provider-r1.md)
- [Contextual Intent Provider R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-contextual-intent-provider/README.md)
- [Durable Intent Resolution R1 计划](../plans/2026-09-01-durable-intent-resolution-r1.md)
- [Durable Intent Resolution R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-durable-intent-resolution/README.md)
- [Layered Intent Runtime R1 计划](../plans/2026-09-01-layered-intent-runtime-r1.md)
- [Layered Intent Runtime R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-layered-intent-runtime/README.md)
- [Active Call Reservation Overlay R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-reservation-overlay/README.md)
- [Active Call Reservation Adapter R1 evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-reservation-adapter/README.md)
- [Agent Release reservation binding evidence](../../architecture-foundation/ai-outbound/evidence/r1-agent-release-reservation-binding/README.md)
- [Active Call Playbook reservation evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-playbook-reservation/README.md)
- [Active Call session/artifact evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-session-artifact/README.md)
- [Active Call SIP binding/start gate evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-sip-start-gate/README.md)
- [Active Call complete channel-agent port evidence](../../architecture-foundation/ai-outbound/evidence/r1-active-call-channel-agent-port/README.md)
- [RustPBX TelephonyPort evidence](../../architecture-foundation/ai-outbound/evidence/r1-rustpbx-telephony-port/README.md)

## 23. 变更记录

| 日期 | Revision | 变更 |
| --- | --- | --- |
| 2026-08-31 | R1 | 固定行业通用 AI 外呼优先路线、Active Call 独立电话 Channel Agent、Rust 权威模型、功能闭环和 TDD 顺序 |
| 2026-08-31 | R1 implementation checkpoint | 记录 Rust 合同、领域、schema、适配器与受控 Worker tracer bullet；真实集成和生产资格仍为 `not_run` |
| 2026-08-31 | R1 Tool checkpoint | Tool Broker/Receipt/Store/Active Call Worker 桥接已有本地受控证据；真实 Provider、物理 PostgreSQL 与生产仍为 `not_run` |
| 2026-08-31 | R1 generic Tool Adapter checkpoint | `customer.lookup` 与 `task.create_follow_up` 的 Rust typed Provider Port 切片已有本地受控证据；真实 Provider 与生产仍为 `not_run` |
| 2026-08-31 | R1 Result/Quality checkpoint | final transcript、snapshot、result、evaluation、Bad Case、durable reconcile、tenant PostgreSQL Adapter 与权限化 Rust API 已有本地受控证据；物理集成、旧 writer 迁移、UI 与生产仍为 `not_run` |
| 2026-08-31 | R1 Post-call Finalization checkpoint | terminal/enqueue 受控原子失败语义、durable queue、独立 Worker、D7 projection reuse 与有界进度查询已有本地证据；物理 PostgreSQL 合并事务和真实通话仍为 `not_run` |
| 2026-08-31 | R1 Campaign Retry checkpoint | 确定性失败重试、Attempt lineage、Campaign/Contact Gate、幂等 replay、unknown-outcome 禁止重拨和有界 inspection 已有本地证据；物理 PostgreSQL、真实 Campaign/通话与生产仍为 `not_run` |
| 2026-08-31 | R1 Campaign Authoring checkpoint | Agent Release 发布、Campaign 创建/生命周期、批量 Contact 导入和初始 Attempt 的 Core、Store SQL 合同与权限化 HTTP 已有本地受控证据；具体 PostgreSQL Runtime 组合、真实 UI/通话与生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call realtime event checkpoint | `speaking`、EOU、播放打断、DTMF、Hold 与 Inactivity 已通过安全 Rust 映射合同；真实 Active Call/RustPBX/SIP/PSTN、音频质量与生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call output control checkpoint | Pause、Resume 与非 graceful Interrupt 已通过固定 wire 合同，fade 上限为两秒且未开放 Hangup/REFER/Bridge；真实命令投递、人工接管与生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call Handoff Adapter checkpoint | 具体 Rust `ChannelAgentHandoffPort` 已通过 replacement-session 与 human-generation interrupt 的 loopback 合同；命令执行、RustPBX 媒体切换、真实通话和生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call intent candidate checkpoint | Playbook 的终态 `extra.intent` 已通过有界脱敏 Rust 映射且不保留其他 `extra`；Release OutcomeSchema 投影、真实意图质量与生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call intent outcome checkpoint | 候选到精确 Release/OutcomeSchema、terminal transcript、durable result command 与 finalization 的受控证据链已通过；真实 Playbook/模型质量、物理集成与生产仍为 `not_run` |
| 2026-08-31 | R1 Agent Release reservation checkpoint | Campaign 选择的精确 Release ID/content hash 已进入 Agent 预留请求并通过 Core/Worker 受控测试；真实 Active Call artifact resolution、媒体和生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call Playbook reservation checkpoint | 固定 `/api/playbook/run` 的有界 inline Playbook wire、typed session 和 unknown-outcome 语义已通过 loopback；上游随机 ID 导致的 pending reservation 不可查询问题、真实进程/媒体和生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call reservation overlay checkpoint | 精确源码覆盖层的稳定 ID、同载荷重放、漂移冲突和 pending/active 查询已通过；耐久性、原子交接、真实进程/Adapter 协调和生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call reservation adapter checkpoint | Rust Client 的稳定 ID、响应身份校验、pending/active/not-found 查询和 unknown-outcome 语义已通过；真实进程、durable Worker 协调和生产仍为 `not_run` |
| 2026-08-31 | R1 Active Call session/artifact checkpoint | 平台稳定 Session ID、Agent 回执身份锁定、Release 全组件摘要和有界 Playbook artifact 已通过；确定性 component resolver、SIP-leg 绑定、disclosure 后启动门、真实媒体和生产仍为 `not_run` |
| 2026-09-01 | R1 Active Call SIP/start-gate checkpoint | 固定源码覆盖层已把平台 Session ID 绑定到唯一 SIP leg，保留预约 Playbook 权威，并在显式 start 前阻止 Runner 进入业务对话；RustPBX header 注入、真实 SIP/媒体/Provider 和生产仍为 `not_run` |
| 2026-09-01 | R1 Active Call complete channel-port checkpoint | Rust 完整 `ChannelAgentPort` 已组合精确 Release artifact、稳定 session 预留、附着/media-ready、披露命令、精确 `TrackEnd`、显式 start 与 terminal 查询，并以每 session 串行化保证并发预留重放只产生一次外部 mutation；真实进程、RustPBX header、SIP/媒体/provider、可听披露、录音与生产仍为 `not_run` |
| 2026-09-01 | R1 RustPBX TelephonyPort checkpoint | Rust 具体端口、immutable dial contract、精确 originate/inspect/Agent-leg/hangup wire 和 unknown-outcome 已通过本地 loopback；ivekit.87 O(1) inspect 精确源码测试通过且已删除进程内 known-call 全局锁；物理 Store/runtime、真实进程/SIP/媒体和生产仍为 `not_run` |
| 2026-09-01 | R1 Intent Understanding Core checkpoint | Release-bound 层级 Catalog、Slot allow-list、top-k、basis-point confidence、证据来源和 `unknown/provisional/clarification_required/confirmed/changed` Rust 状态机已有本地合同证据；checkpoint/Store adapter 已通过，真实分类 Provider、融合、校准、Worker/Active Call 实时接入和质量仍为 `not_run` |
| 2026-09-01 | R1 Emotion Understanding Core checkpoint | Release-bound Catalog、声学/文本证据约束、top-k/confidence/intensity、同 authority/turn 融合与确认后压力趋势 Rust 状态机已有本地合同证据；checkpoint/Store adapter 与 Policy 本地消费已通过，真实模型/融合算法、校准、Worker、音频与生产仍为 `not_run` |
| 2026-09-01 | R1 Customer State/Dialogue Policy checkpoint | 同 authority 的 Intent/Emotion 快照、Release-bound Policy、情绪优先澄清与恶化压力人工接管建议已有本地合同证据；来源状态重建和 Policy 重算 checkpoint 已通过，建议不具有 Handoff/Tool/电话动作权，Worker/Active Call 接线、物理 PostgreSQL 和生产仍为 `not_run` |
| 2026-09-01 | R1 Understanding Store schema checkpoint | additive immutable record + fenced latest-head schema、复合 evidence FK、Attempt/generation/domain 有界恢复索引及专用保留期清理函数已有本地合同证据；SQL Adapter、物理 PostgreSQL、恢复重放和生产仍为 `not_run` |
| 2026-09-01 | R1 Understanding Store Adapter checkpoint | bounded canonical record、record-only/atomic head append、三重 optimistic fence、per-scope transaction lock 与 O(1) current recovery Rust Adapter 已通过本地合同；物理 PostgreSQL、Core codec/replay、Worker writer switch 和生产仍为 `not_run` |
| 2026-09-01 | R1 Understanding state checkpoint | versioned Intent、Emotion、Customer State 与 Dialogue payload、来源状态/Policy 重算、内外 hash、authority/record identity 校验及 O(1) restore 已通过本地合同；Worker writer/recovery、物理 PostgreSQL 和生产仍为 `not_run` |
| 2026-09-01 | R1 Understanding Worker checkpoint | Worker 单次四领域一致恢复、typed write batch、具体 tenant PostgreSQL adapter 与 commit 前原子 outcome 分类已通过本地精准测试；真实逐轮 Provider/Active Call、物理 PostgreSQL、重启/双节点和生产仍为 `not_run` |
| 2026-09-01 | R1 Safety Intent Provider checkpoint | Release/Catalog-bound 有界 Rust Safety Rule Provider 已把 final customer transcript 转为稳定 Intent observation/state checkpoint，且无任何业务动作端口；Active Call durable ingest、真实租户规则、Fast/LLM/融合、物理 PostgreSQL、质量和生产仍为 `not_run` |
| 2026-09-01 | R1 Fast Intent Classifier Provider checkpoint | Release/Catalog/model/tokenizer/label-map/calibration-bound Rust Layer-1 Provider 已把受期限约束的模型 top-k 转为稳定 Intent checkpoint；测试端口不代表真实模型，模型运行时、制品解析、准确率、Provider 融合、物理 PostgreSQL 和生产仍为 `not_run` |
| 2026-09-01 | R1 Intent Confidence Router checkpoint | Safety 短路、Fast confidence gate、Contextual same-turn resolution 与显式 Fast fallback 已在原 state 上保持单次推进；Contextual 模型、durable contributor/resolution、完整 Worker/Store 和生产仍为 `not_run` |
| 2026-09-01 | R1 Contextual Intent Provider checkpoint | Release/Catalog/model/prompt/label/schema/calibration-bound Layer-2 Rust Provider 已把同 authority 有界多轮 transcript 转为 Intent/Slot observation；真实 provider-pool 模型、准确率、durable resolution、Worker/Store 和生产仍为 `not_run` |
| 2026-09-01 | R1 durable Intent resolution checkpoint | 原始 Provider observations、Router resolution 与四领域 heads 已进入同一有界 transaction；物理 PostgreSQL、真实模型、进程组合、重启/双节点和生产仍为 `not_run` |
| 2026-09-01 | R1 layered Intent Runtime checkpoint | Store 顺序窗口已在无状态 Runtime 中按 Safety → Fast → Contextual 组合，resolution path 与 transient fallback reason 可持久审计，非 transient 漂移 fail-closed；真实 Active Call consumer、历史仓库、模型、完整四领域 turn 和生产仍为 `not_run` |
| 2026-09-01 | R1 Text Emotion Classifier Provider checkpoint | Release/Catalog/model/tokenizer/label-map/calibration-bound Rust Provider 已把 final customer transcript 转成 text-only Emotion observation；真实模型、声学证据、融合、完整 Worker turn、质量和生产仍为 `not_run` |
| 2026-09-01 | R1 text-only Emotion Turn Runtime checkpoint | raw Emotion observation wire、显式 text-only fusion、单次 Emotion state 推进/checkpoint 与 record-only contributor 已通过；声学窗口、Acoustic Provider、多模态融合、四领域事务组合和生产仍为 `not_run` |
