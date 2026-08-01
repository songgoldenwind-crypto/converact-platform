# Converact Product Domain Contract

> Contract：G01 Product Domain v1
> Scope：Horizontal Platform；Resolve 仅作为首个 Profile 示例
> Current：文档/机器合同 `verified_contract`；Runtime migration `not_run`
> Production eligible：`false`

## 1. 平台类别

Converact 是 **AI-native 多模态通信与业务执行平台**。它把跨语音、视频、屏幕、消息、未来
运营商 AV 的连续参与组织成可治理的 Engagement，把人、AI 和外部系统的工作组织成 Task、
Evidence、Action 和可验证 Outcome。

平台不是 PBX、SFU、CRM、FSM、工单系统、模型服务或某一个行业产品的同义词。这些能力或
系统通过稳定合同参与 Engagement，但不能反向定义平台根对象。

## 2. 上位对象图

```text
Tenant
└── Engagement
    ├── ProfileBinding
    ├── Objective[]
    ├── EngagementItem[]
    ├── Interaction[]
    │   └── CommunicationSession[]
    ├── Task[]
    ├── Evidence[]
    ├── ActionIntent[]
    │   └── Attempt[] → Receipt[] → Verification[]
    └── OutcomeClaim[]
```

不可变关系：

- `Engagement` 是平台业务执行根；`EngagementItem` 是其中需要跟踪的可验证工作对象；
- `Resolution` 是 `Engagement(profile_type="resolution")` 的 Profile 投影；
- `ResolutionItem` 是 `EngagementItem(item_type="problem")` 的 Profile 投影；
- Call、Leg、Room、Participant、Ticket、Case、Opportunity、WorkOrder、AgentRun 都是关联
  对象，不是 `Engagement` 的别名；
- 一个业务 Engagement 可跨多个 Interaction 和 CommunicationSession；一个通信会话失败不
  自动关闭 Engagement；
- 只有满足 `VerificationPolicy` 的 `OutcomeClaim` 才能进入 Finalized，逆转使用不可变
  Reversal/Credit 事实，不能覆盖历史。

## 3. 单一 Authority

| Domain | 唯一 Authority | 其他组件允许做什么 | 禁止做什么 |
| --- | --- | --- | --- |
| SIP Edge | Kamailio | Core 提供路由/策略输入 | Profile 注册、Location 或边缘限流第二写 |
| Native Call/Leg/Dialog/CDR/Recording intent/Media Plan | Unified RustPBX | Adapter 执行计划并回报 Receipt | LiveKit、rvoip、RTPengine 或 Profile 写第二 Call/录音意图状态 |
| Ordinary RTP/SRTP | RTPengine | RustPBX 发原子生命周期意图 | AI/录音/数据库进入普通每包路径 |
| Decode/mix/capture/AI tap execution | `voice-media-rs` | Codec/DSP backend 与 fenced capture worker 可替换 | 自行决定录音意图、root manifest、路由、计费或 Call 生命周期 |
| Root RecordingManifest/Evidence | Converact Region Recording Plane | `voice-media-rs` capture、LiveKit Egress、上传与存储 Adapter 回报分段/缺口 Receipt | Capture/Egress/对象存储各写一份 root manifest，或把上传成功冒充录音完整 |
| WebRTC Room/Participant/Publication/SFU | LiveKit | Fabric 协调桥接 generation | RustPBX 伪造第二 Room Authority |
| Engagement/Evidence/Outcome | Converact Engage | Profile 校验与投影 | Profile、Connector、CRM 成为第二写者 |
| Interaction/CommunicationSession/BridgeIntent | Fabric Coordination | 通信 Authority 执行各自 leg | 把 Room/Call 直接当 Interaction Authority |
| AgentRun/Task/Context/Handoff/Evaluation | Agent Runtime | Agent framework 执行租约内任务 | Agent framework 直接写 Action 完成或 Outcome |
| Action lifecycle | Engage Action Authority | Provider/Connector 执行并回 Receipt | Agent、LLM、Profile 或 webhook 直接完成业务动作 |
| External Case/Opportunity/WorkOrder/SLA | 客户 CRM/FSM（Overlay） | Converact 保存引用、Evidence 和建议 | Overlay 中镜像成正式第二 Case/WorkOrder |

Authority 判定规则：同一 domain 在一个 generation 内只有一个写者；Adapter、Worker、Backend、
Framework 和 Profile 都是可替换执行器。任何新增写者必须先修改上位合同并重新审查，不能靠
“临时同步”绕过。

## 4. Native 与 Overlay

| 维度 | Native | Overlay |
| --- | --- | --- |
| 正式业务对象 | Converact 可成为明确签约对象的 Authority | 客户现有 CRM/FSM/PBX 继续为 Authority |
| Converact 拥有 | Engagement、Evidence、Action Ledger、OutcomeClaim 及明确 Native 对象 | Engagement execution、Evidence、Action Ledger、OutcomeClaim 与外部引用 |
| 关闭语义 | 由 Converact policy + human verification 决定 | Converact 只能建议/请求；外部关闭结果经 Receipt/query/reconcile 观察 |
| 冲突 | owner epoch + version/fence；拒绝旧写 | 外部版本优先；`unknown` 查询/对账，禁止盲重试 |
| 失败 | 核心持久化不可用时 fail closed 到安全人工路径 | Connector 故障不停止 Human Communication；动作 deferred/unknown |

部署 Option 不能静默改变 Authority。Dedicated、On-prem、OEM 或 ViLTE 只是交付/能力选择，
若其合同需要不同 Authority，必须成为新版本合同并单独 Gate。

## 5. Profile extension contract

Profile 可以增加：

- `Engagement`/`EngagementItem` 的 namespaced schema；
- 目标、验证策略、指标、资格规则、UI projection；
- 所需 Capability/Connector/Deployment Option；
- Profile 自己的术语映射、市场 Evidence、威胁模型和 Stop Gate。

Profile 不得：

- 改写平台对象 ID、owner epoch、版本、状态历史或 Authority；
- 创建第二 Engagement/Task/Evidence/Action/Outcome store；
- 把 Profile 状态直接写入通信 Authority；
- 用售后特有字段阻塞其他 Profile 的水平核心；
- 把本 Profile 的客户结果外推为整个平台市场证明；
- 绕过 Consent、Tenant、Region、Retention、Audit、VerificationPolicy 或人工责任。

Profile validator 只返回 `accept/reject/defer` 和原因，不执行副作用。副作用始终通过 Action
Authority 的 idempotent prepare/execute/query/reconcile/compensate 流程。

## 6. 稳定接口与时序事实

G01 只冻结语义，不实现 API。后续接口必须保持以下最小事实：

- 平台标识：`TenantId`、`EngagementId`、`EngagementItemId`、`ProfileBindingId`；
- 协作标识：`InteractionId`、`CommunicationSessionId`、`BridgeGeneration`；
- 执行标识：`TaskId`、`ActionIntentId`、`AttemptId`、`IdempotencyKey`；
- 证据标识：`EvidenceId`、`OutcomeClaimId`、`VerificationRevision`；
- 每个事件携带 tenant、authority、aggregate version、owner epoch/fence、event time、ingest time、
  causation/correlation 和 schema version；
- wall clock 仅用于业务时间与展示；顺序使用版本、generation、epoch/fence，不能靠跨机时间戳；
- 网络副作用只承诺 at-least-once delivery + idempotent observation，不宣称 exactly once。

## 7. 人与 AI 的责任边界

AI 可以：理解、翻译、总结、检索、提出 Task/ActionProposal、标注候选 Evidence、生成草稿和
风险提示。AI 不可以自行：

- 改变 Call/Room/Engagement Authority；
- 将 OutcomeClaim 设为 Finalized；
- 执行未经授权的高风险动作；
- 伪造来源、签名、客户同意或测量；
- 将模型置信度当业务事实；
- 在 AI/Provider 故障时阻断已建立的人类通信。

每个 Offer 明确 human accountable owner、需要的授权级别、可撤销窗口和降级路径。无法满足
验证策略时保持 `proposed/pending_verification/disputed`，不能为了 KPI 自动关闭。

## 8. Failure/degradation contract

| 故障 | 保留的 Authority/体验 | 降级 | 禁止行为 |
| --- | --- | --- | --- |
| AI/VAD/STT/LLM/TTS 不可用 | Human Communication、Engagement、人工 Task | 关闭 AI/翻译，显示原因，允许人工继续 | 结束通话、伪造 transcript 或 silent fallback |
| 录音/对象存储不可用 | Human Communication、Call Authority | 停止新录音、明确 consent/recording 状态、告警 | 用无界内存/磁盘拖垮通话 |
| Connector/CRM/FSM 不可用 | 外部 Authority、Human Communication | Action `deferred/unknown`，query/reconcile | 盲重试、镜像关闭、重复计费 |
| LiveKit/SFU 不可用 | RustPBX Call 与普通 RTP 可继续 | 保持/返回 audio fast path；新视频 fail closed | 把 Room 不存在解释为 Call 结束 |
| RTPengine 不可用 | Call Authority | 按 Offer 能力拒绝新媒体或选择已资格化 backend | 未声明切到低性能/不同能力路径 |
| Engage durable store 不可用 | 外部正式对象和已建立通信 | 拒绝新业务状态写；有限缓冲只保存可对账事实 | 内存状态冒充持久事实 |
| Profile validator 崩溃 | Platform Authority | Profile request reject/defer，其他 Profile 不受影响 | 修改平台状态或启动第二 validator writer |

所有队列、重试、fan-out、证据大小和同步窗口必须有界。G01 不授权具体性能实现，但后续实现
不得引入热路径全局锁、全局扫描、每包 task/HTTP/数据库或不可解释分配。

## 9. Evidence 与状态纪律

状态词只使用：

- `available`：已有适用 Offer 且所有依赖 Gate 通过；
- `pilot`：只允许在签署 Pilot 合同与约定范围内；
- `planned`：有批准路线但未达到 Pilot/available；
- `option`：条件式能力/部署选择，尚未资格化；
- `not_run`：没有运行或没有原始 Evidence。

另外，合同内可分别表达 `target` 和 `production_eligible=false`，但它们不是销售词。文档、Mock、
synthetic fixture、供应商 benchmark、内部意见和演示都不能升级市场或生产状态。

Evidence 至少固定 source、commit/binary/model、config、hardware/region、clock、workload、sample、
时间、原始输出、consent/retention 和 reviewer。竞争公开资料只能证明厂商公开了某能力，不能
证明本平台优于它。

## 10. Threat/failure review

| Threat | 影响 | 约束/检测 | 剩余状态 |
| --- | --- | --- | --- |
| Resolve 语义泄漏到水平核心 | 新 Profile 需要大量例外 | schema 禁止平台根为 Resolution；trace 检查 | 后续代码迁移 `not_run` |
| 第二 Authority/双写 | 状态分叉、重复计费/动作 | domain-authority 唯一键；旧 epoch/fence 拒绝 | Runtime enforcement `not_run` |
| Profile 绕过平台状态机 | 审计和政策失效 | validator 纯函数；禁止副作用与自有 store | Runtime enforcement `not_run` |
| AI 置信度冒充事实 | 错误关闭/安全风险 | Outcome verification + human accountable owner | 实际模型评估 `not_run` |
| 外部 webhook 乱序/重复 | 重复动作、错误关闭 | idempotency + query/reconcile + immutable receipt | Connector evidence `not_run` |
| Vendor marketing 冒充证据 | 错误定位和投资 | claim 类型、官方源、Converact 实测分离 | 实测竞争差异 `not_run` |
| PII/合同进入 Git | 隐私和商业泄露 | 只保存 pseudonymous metadata/受控 URI/hash | 真实 Evidence 收集 `not_run` |
| 单一 Profile 失败否定平台 | 错误停止水平基础 | Stop Gate 明确 Profile scope | 其他 Profile 未授权 |
| 功能故障拖垮通信 | 客户现场支持中断 | 故障域与降级表；AI/录音/Connector 非关键路径 | 实现/故障注入 `not_run` |

## 11. Gate 判定

本合同只有在 schema、trace、链接、Authority 唯一性、Profile 隔离和独立第二遍审查均通过后，
才能作为 Platform Contract Gate 的证据。它不证明运行时已实现，也不证明 Resolve 可销售。
