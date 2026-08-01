# Converact Platform — AI-native 多模态通信与业务执行平台

## 平台范围、领域模型与产品组合 R2

> <关联文档>
>
> - [统一领域语言](../../CONTEXT.md)
> - [ADR-CCAAS-11：Engagement 平台核心与 Resolution Profile](../adr/ccaas-11-engagement-platform-and-resolution-profile.md)
> - [统一通信底座 R5](./unified-communication-foundation-r5.md)
> - [Resolve Assist 垂直产品 Profile R1](./2026-07-31-ai-native-multimodal-resolution-platform-r1.md)
> - [18 个 Goal 与执行规则](../../goals/README.md)
> - [本次文档迁移计划](../plans/2026-07-31-platform-scope-engagement-domain-r2.md)
>
> </关联文档>

| 属性 | 内容 |
| --- | --- |
| 文档状态 | `accepted_scope_direction`；实现、市场与生产资格仍按 Gate 验证 |
| 修订版本 | R2 |
| 日期 | 2026-07-31 |
| 平台类别 | AI-native Multimodal Communications & Execution Platform |
| 中文类别 | AI-native 多模态通信与业务执行平台 |
| 首个垂直 Profile | Converact Resolve |
| 首个对外 Offer | Converact Resolve |
| Runtime enablement | `false` |
| Production capacity claim | `none` |
| 未证明能力 | `not_run` |

---

## 1. 本文解决的范围错误

旧 AI-native R1 把“面向出口设备安装与售后的技术问题解决平台”同时用作：

1. Converact 的最终平台类别；
2. 首个垂直产品；
3. 首个商业 Offer；
4. 首个 ICP 与 Pilot。

这四个层次不能合并。用户已明确：Converact 的长期目标是通用通信底座与 AI-native 平台，设备
安装/售后只是首个可销售切口，不是整个平台的业务边界。

本文据此冻结：

> **Converact 是连接人、AI、设备和企业系统的 AI-native 多模态通信与业务执行平台。**

平台完成以下通用闭环：

```text
Connect
  → Understand
  → Collaborate
  → Act
  → Verify
  → Learn
```

`Converact Resolve` 继续作为第一款垂直 Offer，保留其一个 ICP、一个主流程、一个语言对、
固定 Pilot 和可验证 ROI Gate。该聚焦约束销售与垂直产品，不缩小平台核心、通信底座、
AI Runtime、API/OEM 或未来电信能力。

### 1.1 产品命名与模块边界

```text
Converact Platform
├── Converact Fabric         通信、媒体、跨渠道连续性和实时协作底座
├── Converact Engage         Engagement、Evidence、Action、Outcome 与业务协作
├── Converact Agent Runtime  Speech、AgentRun、Context、Tool、Handoff 与 Evaluation
└── Converact Resolve        `resolution` Profile 的首个垂直 Offer
```

这些名称是同一平台内的产品和能力边界，不是四套独立 Authority 或四个必须拆分部署的系统。
Fabric 不写 Engagement 或 Agent 业务状态；Engage 不接管 SIP/Room；Agent Runtime 不直接
写外部副作用；Resolve 只通过 Profile 扩展前三者，不复制它们的核心模型。

## 2. 权威关系与裁决优先级

本文决定平台范围、顶层领域模型、产品组合和跨 Profile Gate。其他文档按领域继续有效：

| 文档 | 继续决定 | 不再决定 |
| --- | --- | --- |
| 通信 R5/R4 | SIP、Call、RTP、LiveKit、Agent channel、故障域、性能与 ViLTE 接口 | Converact 的全部业务类别 |
| 本文 R2 | 平台类别、Engagement 模型、Profile/Offer/Option 分层、跨产品 Gate | SIP/RTP 具体实现 |
| Resolve R1 | Resolve Profile、出口设备 ICP、Pilot、B1、ROI、售后旅程 | Converact 总平台边界 |
| Goal G00–G17 | 当前执行顺序、产物、依赖、Evidence 与停止条件 | 未经 Gate 的市场或生产结论 |

跨文档冲突时使用：

```text
平台/产品/领域：R2 > Resolve R1 > 旧 AI/CCaaS 产品文档
通信/媒体：R5 machine contract > R5/R4 design > R2 的概念性描述
首个售后 Offer：Resolve R1 > R2 的产品组合摘要
执行：Goal 文件 + PROGRAM-RULES > 路线图中的时间假设
```

R2 不删除 R1 的需求。R1 中的 ICP、Evidence、Outcome、长会话、翻译、商业和安全要求转为
`resolution` Profile 的绑定要求。

## 3. 四层产品结构

### 3.1 Horizontal Platform

所有 Profile 共享的长期平台：

- SIP/PSTN、WebRTC、视频、屏幕、消息与未来 ViLTE 通信；
- Interaction、Participant、跨渠道连续性与人工/AI Handoff；
- Speech、翻译、视觉、Copilot、Agent Execution；
- Task、Action、Evidence、Outcome、Knowledge 与 Governance；
- Tenant、Identity、Policy、Consent、Audit、Billing 与 Observability；
- Overlay、Native、Dedicated、On-prem 与 API/OEM 交付能力。

Horizontal Platform 不直接承诺某一行业结果，也不包含所有行业字段和流程。

### 3.2 Engagement Profile

Profile 是版本化的领域语义包，定义：

- `profile_type` 与 schema version；
- Objective/EngagementItem 的业务字段和不变量；
- 角色、权限和 Handoff 规则；
- VerificationPolicy 与 Outcome 类型；
- 指标、基线、观察窗口、争议和重开规则；
- 允许的渠道、AI、工具、数据和部署能力；
- Profile 特有 UI、Connector 与 Playbook；
- Profile 自己的市场、质量、安全和 production Gate。

Profile 不能创建第二套 Tenant、Interaction、Task、Action、Evidence、Billing、Agent 或通信
Authority。它通过稳定接口扩展平台核心。

### 3.3 Product Offer

Offer 是客户可以买到的合同包装，包括：

- 目标客户和购买者；
- 业务结果；
- 包含的 Profile 与能力；
- 接入、人数、用量、区域和支持范围；
- 价格、验收、SLA、变更单和 no-bid；
- 可销售状态 `available/pilot/planned/option/not_run`。

一个 Profile 可以形成多个 Offer；一个 Offer 也可以组合多个已通过 Gate 的 Profile，但不允许
用组合包装绕过每个 Profile 的资格。

### 3.4 Deployment Option

Deployment Option 决定运行和主权方式，不是新的业务领域：

- Overlay SaaS；
- Native Communications；
- Dedicated VPC；
- On-prem/Sovereign；
- Edge Node；
- OEM/Embedded；
- conditional ViLTE/NG-RTC。

同一 Offer 可以选择不同 Option，但必须分别通过容量、安全、升级、恢复和支持矩阵。

## 4. 通用领域模型

### 4.1 核心关系

```text
Tenant
└── Engagement
    ├── EngagementId
    ├── ProfileBinding(profile_type, profile_version)
    ├── Objective[]
    ├── EngagementItem[]
    ├── InteractionRef[]
    ├── TaskRef[]
    ├── EvidenceRef[]
    ├── ActionRef[]
    ├── OutcomeClaimRef[]
    ├── ExternalAuthorityBinding[]
    └── lifecycle/version

Interaction
├── InteractionId
├── one continuous participation window
├── CommunicationSession[]
├── Participant[]
├── active channel generations
└── Handoff/OutputLease refs

CommunicationSession
├── SessionId
├── channel_type
├── provider/runtime references
└── media/data component generations
```

### 4.2 Engagement

`Engagement` 是围绕一个可描述业务目的、可以跨渠道、跨 Interaction 和跨天持续的持久容器。
它不等于电话、Room、消息线程、外部 Ticket、CRM Opportunity 或 Agent session。

示例：

- 一次设备故障解决；
- 一次客户服务事项；
- 一次专家咨询；
- 一次销售/采购协作；
- 一次安装验收；
- 一次远程运营任务；
- 一次 AI 与人工共同完成的业务目标。

### 4.3 EngagementItem

`EngagementItem` 是 Engagement 中能够独立资格化、执行、验证、重开和归因的最小业务结果
单元。它不是路由队列中的 `WorkItem`，也不是 Agent 的一个模型 turn。

每个 Item 至少绑定：

- statement 与 fingerprint；
- qualification baseline；
- Profile/VerificationPolicy version；
- owner/reference version；
- Evidence 与 Task references；
- OutcomeClaim 与 observation window；
- dispute/reversal/reopen 规则。

### 4.4 Interaction

`Interaction` 是参与者的一次连续参与窗口。它可以在不中断参与关系的情况下同时或顺序使用
电话、LiveKit 视频、屏幕和消息；电话增加视频或 SIP↔LiveKit handoff 不创建新 Interaction。

客户离开、重新排队、跨天重新接触或策略定义的连续性终止后，新建 Interaction，但仍可以属于
同一个 Engagement。

这保留 R5 对 Voice/LiveKit 切换中稳定 `InteractionId` 的要求，同时避免让一个
`Interaction` 承担跨月业务事项的全部生命周期。

### 4.5 Resolution Profile

`Resolution` 不是 Horizontal Platform 的上位对象，而是：

```text
Engagement(profile_type = "resolution")
```

`ResolutionItem` 是：

```text
EngagementItem(item_type = "problem")
```

Resolution Profile 增加 ProblemStatement、problem fingerprint、FCR/FTF、派工避免、复发、
VerificationPolicy、OutcomeDispute/Reversal 等售后语义。R1 中这些严格要求全部保留。

### 4.6 OutcomeClaim

`OutcomeClaim` 是针对一个 EngagementItem、按版本化政策和 Evidence 提出的可争议结果声明。
它可以表达：

- 问题解决或未解决；
- 安装/验收通过；
- 咨询完成并被确认；
- 预约、交易或流程完成；
- 风险被消除；
- 运营目标达到。

只有 Profile 的 VerificationPolicy 满足后才能 Finalized。模型自评、通话结束、CRM Closed
或客户沉默都不能自动成为 Finalized Outcome。

## 5. Authority 分配

| 事实域 | 唯一 Authority | Profile 可以做什么 |
| --- | --- | --- |
| Engagement、EngagementItem、ProfileBinding、OutcomeClaim | Converact Engage | 校验 Profile 字段、状态和政策 |
| Interaction、CommunicationSession、BridgeIntent | Converact Fabric Coordination | 声明需要的渠道和连续性 |
| Call/Leg/Dialog/Media Plan | Unified RustPBX | 引用 Call，不写通信状态 |
| Room/Participant/Track | LiveKit | 引用 Room，不写 SFU 状态 |
| Task/AgentRun/Context/Handoff | Converact Agent Runtime | 提供任务模板和角色 |
| ActionIntent/Attempt/Receipt/Reconcile | Converact Action Ledger + owning business service | 声明允许动作和风险策略 |
| Evidence provenance/integrity/retention | Converact Evidence Catalog；媒体源清单按通信合同 | 声明需要的 Evidence 和阈值 |
| Billing/Metering | Converact Metering/Billing | 声明可计费结果，不直接记账 |
| 外部 Case/Opportunity/WorkOrder/SLA | Overlay 外部系统 | 维护 Projection/Binding，不夺取 Authority |

Native 模式下 Converact 可以成为相应业务对象的正式 Authority。Overlay 模式下 Converact 只拥有自己的
Engagement execution、Evidence、Action Ledger 和 OutcomeClaim，不把外部 Case、Opportunity、
WorkOrder、SLA 或正式关闭复制成隐性第二权威。

## 6. 平台产品组合

以下是同一平台上的不同 Profile/Offer 方向，不是当前同时承诺的 SKU：

| 方向 | 形态 | 当前决策 |
| --- | --- | --- |
| Converact Resolve | `resolution` Profile 的首个付费 Offer | 首发，保持一个 ICP/Pilot |
| AI-native Contact Center | customer-engagement/service Profile | 平台方向；需独立市场与功能 Gate |
| AI Voice/Video Agent | agent-service Profile + channel adapters | 平台方向；不得成为第二通信 Authority |
| Expert Collaboration / Operations | consultation/operation Profile | 平台方向；需独立 Outcome 和安全模型 |
| Cross-language Capability | 横向 Speech/Translation capability | 先以 Resolve B1 验证，不限于售后复用 |
| Native Communications | Deployment Option | 按性能、主权、成本和真实客户需求 Gate |
| Platform API / OEM | Offer/Distribution Option | 外部采用、支持和版本稳定后开放 |
| ViLTE / 5G New Calling | conditional telecom Option | 独立运营商/设备商合同和实验网 Gate |

新增 Profile 必须有自己的文档、术语映射、市场证据、机器合同、威胁模型、测试和 Stop Gate。
“平台可以支持”不等于“产品已计划”，更不等于“客户现在可以买”。

### 6.1 竞争面不是单一“远程售后市场”

Converact 的平台竞争必须按买家、Offer 和替代预算分别验证，不能用 Resolve 的竞品清单代表全部
市场，也不能把开源组件误当作完整产品竞品：

| 竞争面 | G01 必须验证的替代集合 | Converact 假设性差异 | 当前状态 |
| --- | --- | --- | --- |
| Enterprise Contact Center | 成熟 CCaaS、自建联络中心、BPO | 通信与受控业务执行同一平台、开放部署和 AI 可替换 | 市场/功能差异 `not_run` |
| CPaaS / RTC / Developer API | 通信 API、WebRTC/SFU、运营商聚合 | Durable Engagement、跨渠道连续性、Action/Evidence/Outcome | 第二 Offer 与外部采用 `not_run` |
| AI Voice/Video Agent | 企业 Agent 平台、垂直 Bot、自建 Agent | 人工/AI 共存、跨渠道 Handoff、可审计副作用和多部署 | 独立 Agent Profile Gate `not_run` |
| CRM / FSM / Workflow | 客户现有记录系统、服务/销售/运营工作流 | Overlay 保留外部 Authority，仅补通信到执行闭环 | Connector 复用与买家证据 `not_run` |
| Visual Remote Assist | 视频远程支持、AR/OCR、知识工具 | Resolve 的电话连续性、翻译、Evidence 和验证闭环 | 仅属于首发 Resolve Gate |
| Telecom / OEM | 软交换、IMS/ViLTE、嵌入式通信方案 | Rust 通信底座、可控媒体路径、开放 API/部署主权 | VOS/ViLTE/OEM 均为独立 Gate |
| Open-source building blocks | RustPBX、rvoip、RTPengine、LiveKit、HF 与 Agent framework | 作为 Build/Absorb/Adapter 候选，不是 Converact 商业闭环 | exact-source 工程与资格待 Goal 验证 |

表中的差异是待验证产品假设，不是市场领先声明。G01 必须分别输出平台竞争地图、首发 Resolve
赢单/no-bid 条件和 Build/Absorb/Buy/Partner 决策；任何一个 Offer 的胜负不能外推到整个平台。

### 6.2 结构优势与结构风险

待验证的结构优势：

- 同一通信 Fabric 服务人工、Agent、Contact Center、Resolve、OEM 和未来电信 Profile；
- Engagement→Interaction→Session 保持跨渠道和跨天连续，而不让 Provider ID 成为业务 ID；
- AI、Speech、录音、Knowledge、Action 和视频可独立失败，人工主通信不被附加能力拖垮；
- Action/Receipt/Evidence/Outcome 把“说了什么”推进到“做了什么、是否被验证”；
- Overlay 先卖价值，Native/Dedicated/On-prem/OEM 再按性能、主权和成本证据启用；
- Rust/RTPengine/LiveKit/HF/rvoip 等组件通过稳定合同组合，避免供应商或框架成为业务 Authority。

必须主动控制的结构风险：

- 平台范围大于单一创业团队可同时产品化的范围；必须坚持一次一个经验证的 Offer/Profile；
- Contact Center、通信和 CRM/FSM 的成熟 table stakes 很多，不能用架构先进替代买家验收；
- 电信互通、全球线路、合规、部署支持和 Connector 长尾可能吞噬毛利；
- 多媒体、GPU 和长会话的质量/成本/故障组合复杂，必须按 profile 独立取证；
- 开源吸收会带来升级、许可证、native/unsafe 和维护责任，不能靠“都是 Rust”推断更优；
- Horizontal Core 若无法被第二个真实 Profile 复用，应触发平台 Thesis Review，而不是继续抽象。

因此 Converact 的卖法是“以窄 Offer 赢单、以横向平台复用、以独立 Option 交付”，不是第一天销售
一个包含全部方向的超级套件。

## 7. 逻辑架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Product Offers                                               │
│ Resolve / Contact Center / Agent / Operations / OEM Options  │
├──────────────────────────────────────────────────────────────┤
│ Engagement Profiles                                         │
│ Profile schema / policy / metrics / UI / connector mapping   │
├──────────────────────────────────────────────────────────────┤
│ Engagement & Collaboration                                  │
│ Engagement / Item / Interaction / Task / Evidence / Outcome  │
├──────────────────────────────────────────────────────────────┤
│ AI & Action                                                  │
│ Speech / Translation / Vision / Agent / Tool / Workflow      │
├──────────────────────────────────────────────────────────────┤
│ Communication Fabric                                        │
│ Overlay / SIP / RTP / WebRTC / Video / IM / future IMS       │
├──────────────────────────────────────────────────────────────┤
│ Platform Foundation                                         │
│ Tenant / Identity / Policy / Audit / Billing / Observability │
└──────────────────────────────────────────────────────────────┘
```

生产仍使用 R5 的四个故障域：

- Telephony Cell；
- WebRTC/Video Cell；
- AI Session Cell；
- Durable Engagement Cell（R1 中的 Durable Resolution Cell 是其 Resolution Profile 视图）。

一个平台 Authority 不要求所有执行器处于一个 OS 进程。AI、GPU、录音、视频和原生/unsafe
codec 必须按故障后果隔离；已建立的人与人媒体不等待这些附加能力。

## 8. 通信底座不被首个行业限制

R5 的以下决定不因 R2 改变：

- Kamailio 是 SIP Edge；
- Unified RustPBX 是 Native Call/业务路由/Media Plan Authority；
- RTPengine 是普通 RTP/RTCP/SRTP 性能底线；
- `voice-media-rs` 承担需要解码的媒体处理；
- rvoip 只按低层 slice 吸收；
- LiveKit 是 Room/WebRTC/SFU Authority；
- HF 只替换重叠 Speech Runtime；
- G.729 工程强制，法律只限制分发/启用；
- Voice↔LiveKit、未来 ViLTE、录音和 AI 使用独立 generation/fence/receipt；
- VOS-EQ-10K、VOICE-100K 和 MIX-100K 必须以真实同源 Evidence 签署。

通信性能目标服务于 Contact Center、Agent、Resolve、OEM 和运营商等多个方向。Resolve Overlay
V1 不应被不使用的 Native 100K Profile 阻塞；反之，Resolve Pilot 通过也不能冒充通信 100K
已通过。

## 9. AI-native 的通用边界

AI-native 不等于“每条媒体必须经过 AI”，也不等于“把所有业务交给一个超级 Agent”。平台
通用 AI 合同为：

- Speech Runtime：VAD/STT/LLM/TTS 与 Realtime provider 的可替换执行；
- Channel Agent Runtime：电话、Room、文本等渠道局部状态；
- AI-native Orchestrator：跨渠道 Task、Context、Policy、Handoff 与 AgentRun；
- Action Ledger：受控副作用与 Receipt/reconcile；
- Evidence/Knowledge/Governance：来源、评测、发布、Shadow、Canary、rollback；
- OutputLease：一个受众/渠道/模态/语义范围只有一个 Converact 输出 owner。

HF、LiveKit Agents、Active、Pi、Nanobot、模型 Provider 或未来框架都不拥有 Engagement、
Interaction、Task、Action、Billing 或外部业务系统状态。

## 10. 商业 Gate 分层

### 10.1 Platform Contract Gate

冻结 Horizontal Platform 的术语、Authority、接口、故障域、状态和 Evidence 纪律。该 Gate
不需要先证明某一个行业付费，但不能据此声称产品市场匹配。

### 10.2 Profile Market Gate

每个 Profile 独立验证 ICP/JTBD、买家、预算、价值池、数据、接入和复用。Resolve R1 的
20 次访谈、3 个付费承诺、USD 20k Pilot 等只属于 `resolution` Profile。

Profile Gate 失败时：

1. 停止该 Profile 的功能扩张、销售或定制；
2. 保留已经证明可复用的 Horizontal Platform 能力；
3. 不把失败自动外推成 Converact 平台失败；
4. 也不得以“平台更广”为理由无限开发；新的垂直扩张必须先有另一个真实 Profile Gate。

### 10.3 Capability Gate

Speech、翻译、Vision、Agent、Action、录音、Native media 等分别证明质量、延迟、成本、安全、
故障隔离和客户价值。一个能力失败只关闭相应能力，除非它是某个 Offer 的 mandatory gate。

### 10.4 Deployment Option Gate

Native、Dedicated、On-prem、OEM 和 ViLTE 分别由真实客户、主权、成本、性能、实验网、支持
和合规证据触发。一个 Option 未触发不否定 Overlay 或其他 Profile。

### 10.5 Platform Thesis Review

只有出现以下跨 Profile 证据时，才重新评估整个平台方向：

- 多个独立 Profile 都无法产生愿意付费的同类核心价值；
- Horizontal Platform 在第二个 Profile 无法复用；
- 通信、AI、Action、Evidence 的组合成本长期高于客户价值；
- 可靠性、安全或支持复杂度无法通过工程和商业方式收敛；
- 客户持续只愿购买可由现成点工具满足的单一功能。

## 11. 首个 Resolve Offer 的保留范围

R2 不扩大 Resolve Assist 的首发范围。它继续固定：

- 中国出口设备厂商服务英语市场；
- 原有电话保持 + 免 App additive video；
- 一个 provider-specific 电话 Adapter；
- 一个 CRM/FSM Connector；
- Evidence、人工 Outcome、服务报告；
- B1 中文↔英文字幕/文字翻译必验；
- B2 Copilot/B3 OCR 独立 Optional Gate；
- 12 周、USD 20k 验证期 Pilot 假设；
- 3 个付费 Pilot、至少 2 个转年约、复用/毛利/实施 Gate。

这些数字和 Gate 仍是待验证假设，不是当前业绩，也不能成为其他 Profile 的默认价格或市场
门槛。

## 12. 对 18 个 Goal 的修正

现有 18 个 Goal 继续使用，但其语义调整为：

| Goal | R2 后的作用 |
| --- | --- |
| G00 | 同时追踪 R2 平台、R1 Profile、R5 通信和旧代码 |
| G01 | Platform Contract Gate + Resolve Profile Market Gate |
| G02 | Horizontal Platform 安全/身份/可观测基础 |
| G03–G08 | 通用通信底座与独立性能资格，不依赖 Resolve 成功 |
| G09 | Engagement/Evidence/Outcome Core + 第一个 Resolution Profile |
| G10 | Profile-neutral Collaboration/Overlay；Resolve 是首个 tracer |
| G11 | Resolve Pilot A 的最小 Provider/Connector，不代表通用 Connector 平台 |
| G12 | 通用 Speech Runtime Core；Resolve B1 是第一个 Profile qualification |
| G13 | 通用 AI-native Orchestrator |
| G14 | 通用 Action/Durable Workflow；每个 Profile 的外部动作另行 Gate |
| G15 | 通用 Context/Knowledge/Governance；B2/B3 是 Resolve Optional |
| G16 | Resolve Assist V1/商业闭环，不是 Converact 整个平台完成证明 |
| G17 | 独立 ViLTE/未来电信 Option；由通信和外部合同 Gate，不由 Resolve 成败决定 |

这 18 个 Goal 覆盖 Horizontal Foundation、首个 Resolve Profile 和一个条件式电信 Option，
不声称已经枚举未来所有行业 Profile。未来 Profile 必须追加独立 Goal/合同，而不是塞入 G16。

依赖也必须反映上述分层：G10 的 Overlay/Workspace Core 不以 Native RustPBX 音频桥为前置，
G12 的 SpeechRuntime Core 不以 G08 的 Native/100K 资格为前置；G07/G08 只资格化实际选择的
RustPBX↔LiveKit、Native telephony 和相应容量路径。Resolve B1 则单独依赖 G11 的真实外部
Provider fork。这样“可选部署路径”不会伪装成 Horizontal Core 或 Overlay Offer 的硬依赖。

## 13. 当前、目标与生产资格

| 层次 | 当前 | Target | Production/Market eligibility |
| --- | --- | --- | --- |
| Platform scope | R2 文档已冻结方向 | 通用通信与业务执行平台 | 多 Profile 复用、可靠性、成本和客户证据 |
| Communication | 有 R4/R5 设计和局部实现候选 | R5 + VOS-EQ/100K | exact source、互通、故障、长稳、容量 |
| Engagement Core | 旧对象和设计候选存在 | Engagement/Item/Profile/Outcome | 并发、幂等、迁移、恢复、租户与 Profile tests |
| Resolve Profile | R1 设计 | 首个付费 Offer | 真实 Pilot、B1、ROI、复用和转年约 |
| Speech/Agent/Action | 零散实现和框架候选 | 可替换 Horizontal Runtime | 同源质量、延迟、成本、安全、回滚 |
| Native/OEM/ViLTE | `not_run/conditional` | 独立 Options | 各自客户、技术、运营和合规 Gate |

“平台范围已纠正”不等于代码已迁移；“Resolve Profile 保留”不等于市场已证明；“通信目标
通用”不等于 VOS-EQ/100K 已通过。

## 14. 被拒绝的方案

### 14.1 只改市场文案，保留 Resolution 为平台根对象

拒绝。销售、咨询、运营、Agent service 和 OEM 会被迫伪装成技术问题，指标、状态机和结果
语义持续泄漏，最终产生大量例外。

### 14.2 每个行业复制一套业务核心

拒绝。它会产生多套 Interaction、Task、Action、Evidence、Billing 和 Agent Authority，无法
跨 Profile 复用、审计或维护。

### 14.3 立即同时开发所有 Profile

拒绝。平台边界宽不代表产品路线无限；首发仍只执行 Resolve Assist，其他方向需要独立真实
市场 Gate。

### 14.4 把 Engagement 做成跨所有服务的巨型事务

拒绝。Engagement 只持有稳定身份、membership/version 和引用；通信、Task、Action、Evidence、
模型和外部系统保持深模块、单独 Authority 与可恢复合同。

## 15. Definition of Done

本次 R2 文档修订完成要求：

- R2 成为平台/产品范围权威；
- R1 明确降为 Resolve 垂直 Profile；
- R5 保留通信权威并映射 Engagement→Interaction→Session；
- CONTEXT.md 无 `Interaction`/`Engagement`/`Resolution` 含义冲突；
- Goal 依赖不再让一个 Resolve Pilot 阻塞通用 Speech/Agent/Action 或 ViLTE 合同；
- G16 明确只关闭 Resolve V1，不冒充整个平台完成；
- 每个停止条件明确作用于 Platform、Profile、Capability 或 Deployment Option；
- manifest 的路径、依赖和 SHA-256 与实际文件一致；
- 所有未验证实现、市场和性能状态继续为 `not_run`；
- 不修改运行时代码、服务器、容器、Feature Flag 或远程分支。

## 16. 变更记录

| Revision | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| R2 | 2026-07-31 | Converact/Codex | 将 Converact 总平台从技术问题解决单一类别扩展为 AI-native 多模态通信与业务执行平台；引入 Engagement/Profile/Offer/Option 分层，保留 Resolve Assist 为首个垂直 Profile |
| R2.1 | 2026-07-31 | Converact/Codex | 增加多竞争面、结构优势/风险与售卖边界；拆开 Overlay/Speech Core 和 Native/100K 部署资格依赖 |
