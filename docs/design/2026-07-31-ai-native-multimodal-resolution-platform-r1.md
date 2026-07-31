# OPC AI-native 多模态技术问题解决平台

## 完整产品框架与演化方案 R1

| 属性 | 内容 |
| --- | --- |
| 文档状态 | `proposed_for_review` |
| 修订版本 | R1 |
| 日期 | 2026-07-31 |
| 产品代号 | OPC Resolve |
| 规划周期 | 2026–2031 |
| 文档类型 | 产品权威总纲、目标架构与演化路线 |
| 独立预审 | 商业、领域与通信/AI 架构三路预审已完成；P0 意见已纳入本文 |
| 当前生产证明 | 本文定义目标，不声明目标能力已经实现；未附独立证据的能力一律为 `not_run` |

---

## 1. 文档权威、范围与使用方式

### 1.1 本文决定什么

本文冻结以下长期决策：

1. OPC 的市场类别、首个切入行业和购买价值。
2. 产品的核心业务对象、统一术语和领域不变量。
3. 通信、媒体、AI、任务、工具、知识和治理之间的责任划分。
4. 人工与 AI 协作、渠道切换、动作执行和结果验证的基本合同。
5. SaaS、Overlay、Dedicated VPC、私有化和未来电信视频的演化方向。
6. 产品包装、收费单位、试点方法和 2026–2031 Gate/Horizon。
7. 后续详细设计必须遵守的性能、可靠性、安全和证据原则。

### 1.2 本文不决定什么

本文不是可直接执行的编码计划，也不永久指定：

- Pi、Nanobot 或其他 Agent 框架；
- 某一家 LLM、STT、TTS、VAD 或 Realtime 模型；
- Hugging Face、LiveKit Agents、Active Call 的内部实现；
- 某一个 SFU、远程桌面或运营商；
- 具体数据库表、HTTP 路由和部署副本数；
- 未经测量的最终容量和成本数字。

这些选择必须在本文定义的稳定接口后，通过同源测试、真实业务证据和单位经济性决定。

### 1.3 与旧方案的关系

本文以绿地方式定义未来产品。旧 AI-native、CCaaS、Voice Agent 和通信融合文档只作为需求来源和实现候选，不再自动约束目标架构。

本文经用户批准后，旧 AI-native 产品、业务形态和 Agent 总纲统一标记为 `superseded_reference`。旧文档中的通信安全、性能、互通和验收要求必须进入后续 traceability matrix，不能因架构重写而丢失；若与本文冲突，必须显式 ADR 解决，不能静默兼容两套权威。

旧代码也不享有保留权：

- 符合新合同并通过资格测试的实现可以吸收；
- 只完成演示、重复权威状态或不能隔离故障的实现应替换；
- 因沉没成本而保留框架、服务或数据模型不构成理由。

### 1.4 证据纪律

本文中的状态使用以下语义：

| 状态 | 含义 |
| --- | --- |
| `target` | 已冻结的产品或架构目标 |
| `planned` | 已进入路线但尚未完成独立验收 |
| `passed_controlled` | 仅在受控环境和指定范围内通过 |
| `production_eligible` | 完成真实依赖、容量、故障、安全、升级和恢复证据 |
| `not_run` | 没有可审计证据，不允许通过推断或厂商宣传补齐 |

厂商公开数据只用于市场判断，不得成为 OPC 的性能、可靠性或容量证明。

---

## 2. 执行摘要

### 2.1 最终产品定位

> OPC 是面向设备安装、售后技术支持、远程运维和软件支持的 AI-native 多模态技术问题解决平台。

产品不是以“一次电话”“一个视频房间”或“一条工单”为终点，而是让客户、AI、远程专家和现场工程师围绕同一个问题持续协作，直到结果被验证。

推荐对外价值表达：

> 从客户第一次来电，到看见现场、指导修复、执行操作、验证结果和沉淀知识，在同一条 Resolution 中完成。

### 2.2 商业路径

采用：

```text
Overlay Assist
  → Translation / Copilot / OCR（逐项 Gate）
  → Controlled Autonomous capabilities
  → Native Communications（客户需求 Gate）
  → OEM/Platform（伙伴采用 Gate）
```

1. 先叠加到客户现有 PBX、CCaaS、CRM 和 FSM，降低采购阻力。
2. 先证明电话→视频→Evidence→人工 Outcome，再按顺序加入翻译、Copilot 和 OCR。
3. 主流程可复制后逐步增加受控自主解决。
4. 只有至少 2 个签约客户证明私有化、大并发、主权或成本收益时，才产品化原生通信。
5. 经真实行业验证和外部 API 采用后再开放白标、SDK 和行业平台。

### 2.3 技术路径

内部形成四个独立故障域：

```text
Telephony Cell
WebRTC / Video Cell
AI Session Cell
Durable Resolution Cell
```

HumanCommunicationWithOptionalAI 的已建立基础媒体不等待 AI、数据库、知识库、录音或工作流；能力按租户政策降级、旁路或在敏感步骤前 fail-closed。AIEndpointCommunication 中 AI 是真实对端，故障时必须公告、重建、转人工或受控终止，不能虚假承诺透明旁路。

### 2.4 OPC 必须拥有的核心

OPC 长期必须自己掌握：

1. 跨 SIP/PSTN、WebRTC、屏幕、消息和未来 ViLTE 的 Interaction 连续性。
2. Native 模式的 Customer、Asset、Resolution、Evidence、Task、Action、Outcome 权威；Overlay 模式拥有 OPC 自有 Resolution/ResolutionItem 的问题执行、测量和 Outcome 生命周期，以及稳定 Identity Binding、Projection、ResolutionExecution、Evidence 和 Action Ledger，但不覆盖外部主数据、Case/SLA 或正式关闭。
3. 人工与 AI 的接管、归还、审批和结构化交接。
4. 工具动作的幂等、授权、执行收据、不确定结果查询和补偿。
5. 可验证结果、成本归因、质量评测和知识闭环。
6. 模型、语音引擎、Agent 框架和部署方式的可替换性。

### 2.5 OPC 不应重造的核心

首轮不自研：

- 运营商 IMS/5G Core；
- 通用视频 SFU；
- 通用音视频编解码器；
- 基础模型训练平台；
- 通用 GPU 调度器；
- 完整 CRM、ERP、FSM、WFM 和远程桌面协议栈；
- 已有生态能够提供的全球号码与线路。

OPC 通过受控 Adapter 使用这些能力，并保持退出能力。

---

## 3. 市场类别与竞争决策

### 3.1 为什么不从通用 CCaaS 开始

Genesys、NICE、Zoom、Amazon Connect 和 ServiceNow 已经覆盖：

- 全球语音和数字渠道；
- ACD、队列、路由、WFM、QM；
- Copilot、Virtual Agent、Supervisor；
- AI Studio、测试、发布和分析；
- 大量 CRM、行业和电信集成。

从零正面替换完整 CCaaS，意味着在形成独特客户价值前，就要承担多年表格功能、全球合规、电信运营和生态建设。

OPC 保留完整 CCaaS 的长期可选能力，但首个产品不以“替换 Genesys/Zoom”为采购前提。

### 3.2 为什么不做通用语音 Agent

语音 Agent 基础设施正在快速商品化：

- 低代码平台、开发者 API 和企业托管方案已经密集；
- 模型、STT、TTS 和线路价格持续下降；
- “低延迟、能打电话、能调用工具”已不足以形成长期壁垒；
- Sierra、Decagon、Parloa、PolyAI、Retell、Vapi 等分别占据企业 Agent 和开发者基础设施位置。

OPC 的 Agent 必须服务于可验证的技术问题解决，而不是成为另一个通用电话机器人。

### 3.3 为什么不只做视觉远程支持

SightCall、TechSee、CareAR、Zoom 和部分 FSM 平台已经提供视频、屏幕共享、AR 标注、OCR、条码、视觉识别和知识生成。

OPC 的差异不应是某一个视觉按钮，而应是完整组合：

- 电话和视频连续切换；
- 实时跨语言协作；
- AI 与人工共享任务和证据；
- 通话后仍可继续的持久工作流；
- 受控业务动作；
- 对修复结果的验证；
- 私有化和开放模型；
- 未来运营商视频与 Data Channel 接入；
- 基础通信与 AI 故障隔离。

### 3.4 推荐竞争类别

内部类别名称：

> AI-native Multimodal Technical Resolution Platform（AI-native 多模态技术问题解决平台）

首轮对外销售名称使用客户熟悉的语言：

> 面向出口设备售后的 AI 远程技术支持平台，减少海外派工和跨语言等待。

这是“横向底座、纵向产品”：

- 横向底座：通信、媒体、Interaction、任务、Agent、工具、知识、治理。
- 纵向产品：安装、排障、维修、远程运维和软件支持。

### 3.5 首个 ICP 与后续行业

首 12 个月只冻结一个 ICP：

> 有海外安装和售后成本的中国出口设备厂商。

首个 JTBD：

> 现有电话支持无法看见现场，并受到语言障碍影响；在不替换现有电话和工单系统的情况下，通过免 App 视频与中文↔英文协作，远程完成一次安装或故障排查并留下可审计证据。

ICP 资格假设：

| 维度 | 首轮资格 |
| --- | --- |
| 产品 | LED、安防、网络、智能硬件或相近的可远程诊断设备 |
| 海外业务 | 已服务美国客户，并计划复制到其他英语市场 |
| 服务量 | 每年不少于约 1,000 个同类安装/售后案件 |
| 团队 | 至少 20 名一线支持、远程专家或海外服务伙伴 |
| 价值池 | 可提供 eligible item、可避免事件率、每次价值和客户实施成本数据 |
| 现有入口 | 已有电话/SIP 和工单、CRM 或可提供版本化 REST/Webhook 接口 |
| 首个语言对 | 中文↔英文；其他语言在独立质量证据后开放 |
| 数据条件 | 可以提供脱敏历史案件、设备手册、故障码和试点结果基线 |

商业资格使用总价值池，而不是单次案件价值：

```text
annual_addressable_value
= eligible_annual_items
 × baseline_avoidable_event_rate
 × verified_value_per_avoided_event
+ 经过去重的停机/返工/专家等待价值

annual_first_year_cost
= annual_subscription
 + expected_usage
 + onboarding/integration
 + customer_change_and_labor_cost

必须满足：
annual_addressable_value ≥ 3 × annual_first_year_cost
```

ACV 只能从该公式反推；USD 60k–150k 不是所有合格客户都适用的固定价。

首个区域包冻结为“中国专家服务美国客户”：

- Pilot 媒体与 Evidence 默认在合同指定的美国区域处理；
- 客户为业务数据 Controller/Business，OPC 为 Processor/Service Provider，角色以 DPA 为准；
- 签署 DPA、subprocessor list、跨境数据清单和适用的 PIPL 出境机制/评估；
- 默认不保存完整音视频；选定 Evidence 保留 90 天，转写/翻译派生物 30 天，运营日志 30 天；
- 最小 Outcome/账务证明按合同和适用税务留存，不保留不必要原始媒体；
- EU/UK、中国境内驻留或 On-prem 要求在相应区域包通过前 no-bid/延期。

上述是产品默认合同，不替代客户和 OPC 的正式法律评审。

后续行业顺序：

| 阶段 | 客户类型 | 进入条件 |
| --- | --- | --- |
| P1 | 软件部署、系统集成、IT 运维 | 出口设备主流程可复制后，单独设计屏幕和远控合同 |
| P1 | 工业设备售后 | 完成更高停机价值、安全和设备协议设计 |
| P2 | 运营商家庭设备支持 | 完成大规模并发、线路和运营商合作证据 |
| P2 | 医疗设备 | 形成专门合规、风险和数据处理包后 |
| Option | 保险、零售和一般客服 | 有明确伙伴或客户牵引时 |

### 3.6 买家、用户与采购门槛

首轮销售链：

| 角色 | 典型人员 | 责任 |
| --- | --- | --- |
| Budget Owner | 售后负责人、服务运营负责人 | 提供售后运营或数字化预算，批准年约 |
| Champion | 技术支持经理、服务数字化负责人 | 选择流程、推动试点和内部采用 |
| Operator | 一线支持、远程专家、海外服务伙伴 | 每日使用并反馈 |
| Gatekeeper | CIO、InfoSec、法务、数据保护人员 | 审核集成、安全、数据和合同 |
| Influencer | 海外代理商、现场工程师、设备产品经理 | 影响流程和扩展范围 |

Pilot 通常由 Budget Owner 和 Champion 共同签署，正式合同由 Budget Owner 在 Gatekeeper 通过后批准。

直接用户：

- 客户；
- 一线支持人员；
- 远程专家；
- 现场工程师；
- 主管和质量人员；

AI Agent 和 Copilot 是系统执行组件，不是买家或直接用户。

采购门槛：

- 安全、数据驻留和隐私；
- 是否影响现有电话和服务系统；
- AI 是否会错误操作；
- 是否能够量化结果；
- 是否支持私有化；
- 是否能与 CRM/FSM/CCaaS 共存。

### 3.7 市场模式吸收矩阵

以下是对公开产品模式的方向性吸收，不是逐项功能对标或 OPC 完成证明：

| 平台/类别 | 值得吸收的产品模式 | OPC 的差异化落点 | 明确不复制 |
| --- | --- | --- | --- |
| Genesys / Zoom Contact Center | 全渠道会话、路由、主管、质量、AI 发布治理、企业集成 | 通过 Overlay 接入，并把一次通信延伸为可验证 Resolution | 首轮完整 ACD/WFM/QM/全球线路 |
| ServiceNow / Salesforce Service | Case/WorkOrder/SLA、流程、企业记录和权限 | 让外部 Case 保留 Authority，OPC 提供实时协作、Evidence 和 ResolutionExecution | 通用 CRM/FSM 数据模型 |
| SightCall / TechSee / CareAR | 免 App 视频、远程视觉、标注、现场证据 | 电话连续性、跨语言、AI/人工共同 Task、OutcomeClaim | 只卖一个视频按钮或首轮自研远程桌面协议 |
| Sierra / Decagon 等企业 Agent | Agent 生命周期、工具、评测、升级人工和结果叙事 | Action Receipt/reconcile、跨天 Resolution、设备/现场 Evidence | 通用客服 Agent 横向竞争 |
| LiveKit / SFU 生态 | Room/WebRTC/SFU、实时媒体和 Agent channel 能力 | LiveKit 保持 Room Authority；OPC 拥有跨 SIP/业务连续性 | 用 Room/Agent session 代替 Resolution Authority |
| Hugging Face speech-to-speech | 自托管、可替换的实时语音组件和兼容接口 | 只替换重叠 SpeechRuntime，做同源质量/延迟/成本资格测试 | 宣称默认 VAD/模型天然最优 |
| Pi / Nanobot / Agent kernel | 快速交互循环、工具调用和 specialist executor | 作为有界 AgentRun Adapter | 让框架 memory、cron、queue 成为企业 Authority |

OPC 竞争优势不能来自“每列都有一个功能”，而要来自同一主流程中通信连续、证据可信、动作可控、结果可验证并能私有化。

---

## 4. 客户价值与核心指标

### 4.1 客户购买的结果

产品必须以结果而不是技术功能销售：

| 结果 | 计算口径 |
| --- | --- |
| 远程解决率 | 无需现场派工且 Finalized 的 eligible ResolutionItem / 全部 eligible ResolutionItem |
| 派工避免率 | 满足冻结基线且避免/取消派工的 eligible ResolutionItem / 原本需派工的 eligible ResolutionItem |
| First Contact Resolution | 首次 Interaction 内 Finalized 的 eligible ResolutionItem / 全部 eligible ResolutionItem |
| First Time Fix | 首次维修动作后 Finalized 的 eligible ResolutionItem / 全部 eligible repair ResolutionItem |
| Mean Time to Resolve | ResolutionItem Qualified 到 Finalized 的持续时间 |
| Time to Expert | 需要专家时，从请求到专家有效加入的时间 |
| Expert Leverage | 每位专家单位时间支持的 eligible ResolutionItem 数 |
| Installation Success | 通过验收的 eligible installation ResolutionItem / 开始的 eligible installation ResolutionItem |
| Repeat Incident Rate | 指定观察窗口内相同资产和故障重复打开率 |
| Case-level Closure | 全部 Item 达到约定终态的外部 Case/WorkOrder / eligible Case/WorkOrder |
| Downtime Avoided | 基线停机时间减去实际停机时间 |
| Translation Cost Avoided | 基线人工翻译成本减去实际增量成本 |

试点前必须冻结：

- `eligible_item` 定义、Case→Item 拆分规则和分母；
- 唯一主指标；
- 基线窗口和观察窗口；
- 排除条件；
- 最小案件量；
- CSAT、安全、重复报修和升级率非劣效护栏。

规范计算补充：

- 电话升级视频仍属于首次 Interaction，前提是客户未离开、InteractionId 未变且没有重新排队；否则计为新 Interaction。
- 派工避免必须来自已创建后取消的派工，或与预先冻结的同类历史基线匹配，不能依赖事后主观判断。
- 重复问题由 `problem_fingerprint + asset_id + observation_window` 判定。
- “可远程处理”集合必须在试点开始前按设备族、故障类和安全规则冻结。

### 4.2 北极星指标

长期产品北极星指标：

> Verified Resolution Value（已验证解决价值）

它由以下部分组成：

```text
避免派工价值
+ 减少专家与一线工时
+ 减少停机损失
+ 减少翻译成本
+ 自动解决价值
+ 服务续费或增购贡献
- OPC 平台、通信和 AI 成本
```

不得只使用通话量、坐席数、Token 或“机器人回复率”作为成功指标。

该组合指标用于内部产品经济模型。首轮 Pilot 仪表盘只展示一个预先签署的主业务结果，避免把派工、停机、翻译和续费价值重复归因。

### 4.3 试点转正式合同门槛

首轮商业验证建议采用：

- 12 周固定范围付费试点；
- 只限定 1 个高成本、可测量主流程；
- 主流程必须有试点前基线；
- 客户与 OPC 共同签署结果定义；
- `benefit / total_cost` 目标不低于 3.0，等价于净 ROI `(benefit - total_cost) / total_cost` 不低于 2.0；
- 目标回收期不超过 6 个月；
- 结果达不到门槛时不扩大范围。

这些是产品验证门槛，不是已经实现的业绩声明。

Pilot 窗口收益按实际发生记录；年化收益单独按季节性、eligible volume 和保守改善率建模，不能把 12 周最好结果直接乘四。`total_cost` 同时包含 Pilot/订阅、用量、OPC onboarding、客户集成、培训、内部人工和流程变更成本。只有实际 Pilot 护栏通过且保守年化模型仍满足正式合同价值池，才能转年约。

---

## 5. 产品体验框架

### 5.1 客户体验

客户无需理解底层渠道：

1. 通过现有号码、网页、App、消息或二维码发起请求。
2. 系统识别客户、资产、授权和历史 Resolution。
3. AI 或人工完成初步分诊。
4. 需要看现场时，从电话无缝邀请客户打开摄像头或共享屏幕。
5. 客户可选择字幕、翻译、录音和数据授权。
6. AI 与专家共同指导，每一步都可附图、视频、标注和验证。
7. 未解决时，任务可以等待配件、升级专家或派遣现场人员。
8. 解决后执行测试或获取客户/设备确认。
9. 形成客户可见的服务报告和后续承诺。

### 5.2 专家工作台

专家工作台应提供：

- 当前客户、资产、站点和问题摘要；
- 电话、视频、屏幕、消息和文件的统一控制；
- 实时字幕和双向翻译；
- 设备画面、屏幕、遥测和历史证据；
- 有来源的知识建议；
- AI 推荐步骤和可勾选检查清单；
- 远程标注、截图、OCR、条码和安全远程控制入口；
- 工具动作建议、影响范围和审批状态；
- 专家接管、归还和升级；
- 结构化 Resolution 时间线；
- 自动服务报告和工单更新；
- 对 AI 建议的接受、修改和拒绝反馈。

专家必须能够关闭某一项 AI 能力，而不退出通信会话。

### 5.3 主管与质量体验

主管需要：

- 按风险、停机价值、客户影响和 SLA 排序的 Resolution 视图；
- 人工与 AI 当前归属；
- 实时质量、卡住原因和升级预警；
- 通话、视频、动作和模型执行的统一 Trace；
- 远程协助、耳语、接管和回滚；
- 自动和人工质量评价；
- 翻译、知识、AI 建议和工具动作的准确性；
- 成本、结果和重复问题趋势；
- Playbook 缺口和知识衰减提示。

### 5.4 AI Studio

Studio 不是单纯 Prompt 编辑器，应管理：

- 角色和自治等级；
- Skill、知识、工具和流程；
- 语音、语言、翻译和品牌风格；
- 适用客户、资产、渠道和地区；
- 风险政策和人工审批规则；
- 测试场景和对抗样本；
- 离线评测、模拟器、Shadow、Canary 和回滚；
- 每个版本的质量、延迟、成本和结果；
- 版本依赖和供应链来源。

### 5.5 管理与开发者体验

管理与开发者能力包括：

- 租户、区域、身份、角色和数据策略；
- BYOC、SIP、LiveKit 和 Overlay 集成；
- CRM、FSM、ERP、知识和设备平台连接器；
- REST/Webhook、SDK、MCP 和未来 A2A；
- 数据驻留、保留、导出、删除和 Legal Hold；
- 成本预算、配额、限流、熔断和模型路由；
- 运行状态、容量、告警和审计。

---

## 6. 典型端到端业务旅程

### 6.1 电话升级现场视频

```text
客户拨打原有服务号码
  → 识别客户、资产和服务资格
  → AI/一线完成分诊
  → 发现必须看现场
  → 发送一次性安全视频链接
  → 客户授权摄像头、录音、翻译
  → 优先保持原电话并增加 WebRTC 视频；替换音频时执行 make-before-break
  → AI 识别设备、指示灯、线缆、错误码
  → Copilot 提供带来源步骤
  → 专家标注并指导操作
  → 调用设备诊断或配置工具
  → 执行验证测试
  → 生成证据包、服务报告和知识候选
```

失败行为：

- 视频加入失败：保留电话，回退异步图片或短信链接。
- AI 不可用：专家继续使用音视频和手动工具。
- 翻译不可用：提示状态并切换备用翻译或人工语言队列。
- 录音不可用：按合规策略继续无录音服务或阻止受监管步骤，不影响非受监管基础通信。

### 6.2 软件和 IT 支持

这是出口设备主流程复制后的 P1 Journey，不属于首个 Pilot：

```text
语音/聊天进入
  → 识别账号、设备和软件版本
  → 共享屏幕或浏览器协作
  → 收集日志和错误信息
  → AI 形成诊断假设
  → 专家确认
  → 经用户授权执行远程操作
  → 自动验证服务、配置和版本
  → 更新工单并生成复盘
```

远程控制必须：

- 与通信会话分开授权；
- 明确显示操作者；
- 每个高风险动作可撤销或要求确认；
- 物理断开和权限撤销立即生效；
- 完整记录动作而非只录屏。

### 6.3 AI 自助后人工接管

1. 客户先与 AI 交互。
2. AI 只能在发布版本允许的范围内回答和提议动作。
3. 复杂、敏感、低信心或客户主动要求时进入人工队列。
4. 人工收到结构化 Handoff Artifact，而不是仅收到摘要。
5. 人工接管对外输出权，AI 转为 Copilot。
6. 人工可把特定子任务交回 AI，但不能产生双重输出者。
7. 人工退出后，AI 只有在策略允许且客户明确知情时恢复客户侧输出。

### 6.4 跨天 Resolution

一个 Resolution 可以：

- 当天通过电话开始；
- 等待配件或供应商回复；
- 次日通过消息收集照片；
- 第三天通过视频由另一位专家继续；
- 必要时派遣现场工程师；
- 最终通过设备遥测和客户确认验证。

Interaction 和 Session 可以多个，ResolutionId 保持稳定。

### 6.5 知识闭环

```text
已验证 Resolution
  → 提取问题、环境、证据、步骤和结果
  → 形成 PlaybookCandidate
  → 去除 PII/PHI 和不必要媒体
  → 专家审核、修订和批准
  → 离线评测
  → 发布 PlaybookVersion
  → 用于 Copilot 或自主 Agent
  → 线上结果反馈到下一版本
```

未经审核的个案内容不得自动成为生产 Agent 指令。

---

## 7. 统一领域模型

### 7.1 核心关系

```text
Tenant
├── Party[] ── ServiceAccount[] ── Entitlement[]
├── ServiceSubject[]
│   ├── Asset[]
│   ├── Site[]
│   ├── SoftwareInstance[]
│   └── Order / Contract[]
└── Resolution
    ├── ResolutionItem[]
    ├── InteractionRef[]
    ├── TaskRef[]
    ├── EvidenceRef[]
    ├── ActionRef[]
    ├── HandoffArtifactRef[]
    └── OutcomeClaimRef[]

Interaction ── CommunicationSessionRef[]
CommunicationSession ── ParticipantRef[] / MediaEdgeGenerationRef[]
TaskGraph ── WorkItemRef[] / AgentRunRef[]
Action ── AuthorizationRef[] / ExecutionAttemptRef[] / EffectReceiptRef[]
EvidenceCatalog ── ArtifactRef[] / ObservationRef[] / ClaimRef[] / DerivationRef[]
```

该图表示领域关联，不表示一个数据库事务或一个巨型聚合。聚合之间只通过稳定 ID 和版本引用。

事务与一致性：

| 聚合/模块 | 强一致范围 | 最终一致投影 |
| --- | --- | --- |
| Resolution | item membership、当前生命周期、owner version | 客户时间线、搜索、分析 |
| ResolutionItem | problem fingerprint、VerificationPolicyVersion、状态 | CRM/FSM case view |
| Interaction | 当前 ownership lease、active session refs | 主管和报表 |
| CommunicationSession | 当前 generation、admission 和终态 | Resolution 时间线 |
| Task | 状态、lease、等待原因和预算 | 队列、WFM 和统计 |
| Action | intent、authorization、attempt fence 和 effect state | CRM/FSM action history |
| OutcomeClaim | policy、证据集、账单键和最终状态 | 收入和 ROI 报表 |
| EvidenceCatalog | provenance、integrity、retention 和 tombstone | 搜索、知识候选 |

跨聚合使用 Outbox/Event、幂等消费者和 query/reconcile，不使用分布式大事务。

### 7.2 规范术语

| 术语 | 规范定义 | 明确不等于 |
| --- | --- | --- |
| Tenant | 拥有隔离、策略、账单和数据边界的客户组织 | 单个用户 |
| Party | 人、组织或服务伙伴的规范身份主体 | 登录账号 |
| Customer | 在某个 Entitlement 下接受服务的 Party | 永久固定角色 |
| ServiceAccount | Party 与租户、产品、区域和合同的服务关系 | 用户登录凭据 |
| Entitlement | 某 ServiceSubject 在时间范围内享有的服务资格、SLA 和限制 | 付款记录 |
| PartnerAccessGrant | 海外代理商、承包商或跨租户伙伴对指定 Resolution/Asset 的限时授权 | 全租户访问 |
| ServiceSubject | 被服务的问题主体，可指设备、站点、软件实例、订单或合同 | 只能是人 |
| Asset | 有身份、类型、配置、历史和遥测的设备或产品 | 任意附件 |
| Resolution | 一次相关服务事件的持久容器，可包含一个或多个明确 ResolutionItem | 电话、Room、Ticket |
| ResolutionItem | 一个规范化问题陈述及其独立验证、结果和复发口径 | 一段自由文本 |
| ResolutionExecution | Overlay 模式下由 OPC 拥有的协作、媒体、AI、证据和动作执行状态 | 外部 CRM Case |
| Interaction | 客户、人工或 AI 围绕 Resolution 的一次连续参与 | 永久业务真相 |
| CommunicationSession | 某一渠道上的通信实例 | Resolution |
| ExternalSessionProjection | 对外部 PBX/CCaaS 会话的带版本、游标和陈旧状态的只读投影 | 外部 Call Authority |
| ExternalCaseProjection | 对外部 CRM/FSM Case、WorkOrder、SLA 和关闭状态的投影 | OPC 可任意覆盖的数据 |
| ExternalOutputProjection | 对外部人工、提示音或 Bot 输出的观测；无能力时不能被 OPC fence | OPC OutputLease |
| ResolutionBinding | 外部 Case/Call 与 OPC Resolution/Item 的版本化多重关联 | 两侧对象的所有权转移 |
| Leg | SIP、WebRTC、ViLTE 或外部平台上的单个通信端点 | Participant |
| Participant | 参与者身份及其当前角色，可为客户、人工、AI 或观察者 | 媒体 Track |
| RealtimeStream | 可实时传输的统一资源族，分为 MediaStream、RealtimeTextStream、DataStream 和未来 IMSDataChannelSession | 所有资源都按 RTP Track 处理 |
| MediaSource / Publication | 产生音频、视频或屏幕内容的发布源 | 一条有方向的连接 |
| MediaEdgeGeneration | 从一个 Source/Publication 到一个 Sink 的单向媒体连接世代 | 双向通话、整个 Session |
| MediaPipelineGeneration | 附着在一个 Edge 世代上的处理拓扑、能力、容量和旁路合同 | 共享的全局处理器 |
| PassiveFork | 只复制媒体给录音、转写或分析；分支丢弃不得反压主媒体 | 改变客户听到内容的必经路径 |
| InlineTransform | 改变目标媒体的必经处理路径，例如翻译音频或转码 | 可以无条件旁路的可选插件 |
| EndpointProcessor | 作为会话端点收发媒体的 AI 或服务，例如 Voice Agent | 人与人通话中的透明媒体 tap |
| OutputLease | 对指定 audience、channel、modality 和 semantic_scope 的主动输出租约 | 整个 Interaction 的全局互斥锁 |
| Evidence | 带来源、时间、授权、完整性和保留策略的事实材料 | Agent 总结 |
| Task | 可等待、重试、恢复和分解的工作 | 一次模型调用 |
| WorkItem | 分配给人工或团队的 Task 执行单元 | 坐席账号 |
| AgentRun | 在有限预算和版本下执行的 AI 工作单元 | 业务 Authority |
| ActionProposal | AI 或人工提出的外部副作用请求 | 已执行动作 |
| EffectReceipt | 外部系统对动作结果的可审计证明 | 日志文本 |
| OutcomeClaim | 针对一个 ResolutionItem、按版本化政策和证据提出的可争议结果声明 | 已开票结果 |
| OutcomeDispute / OutcomeReversal | 对不可变 Finalized Claim 的争议与冲正对象 | 修改原 Claim |
| Outcome | 已 Finalized 的 OutcomeClaim 所表达的业务结果 | 客户沉默 |
| HandoffArtifact | 人机或团队交接的结构化事实、状态、风险和未完成任务 | 自由文本摘要 |
| Playbook | 经过审核、评测和发布的可复用解决方法 | 原始聊天记录 |
| AgentRelease | 不可变的 Agent 行为、模型、工具、知识和策略组合 | 在线可变 Prompt |
| ContextRevision | 某个 AgentRun 所见上下文的不可变版本 | 全量数据库快照 |

### 7.3 领域不变量

1. SIP `Call-ID`、LiveKit Room 名称和外部 CCaaS EngagementId 都不是 ResolutionId。
2. 一个 Resolution 可以拥有多个 Interaction 和 Session。
3. 一个 ResolutionItem 只表达一个规范化 ProblemStatement，并拥有独立 problem fingerprint、资格基线、VerificationPolicy、OutcomeClaim 和复发窗口。
4. 一个 Resolution 可以包含多个 ResolutionItem，但 FCR、复发和 Outcome 计费必须按 Item 计算后再聚合。
5. 一个 Session 必须且只能归属一个 Interaction。
6. 一个业务状态字段只能有一个权威写入者。
7. 一个方向的 MediaEdgeGeneration 只能有一个生命周期 owner 和一个计费写入者；每个 MediaPipelineGeneration 也必须独立 fencing。
8. AI 只能返回 Response、Action、Handoff、Memory、Evidence 或 TaskDecomposition Proposal。
9. 未经授权，AgentRun 不能直接修改业务状态或调用外部副作用工具。
10. OutcomeClaim 必须引用 VerificationPolicyVersion、问题指纹、基线、观察窗口和 Evidence，不能只依赖模型自评。
11. 只有 `Finalized` OutcomeClaim 可以进入结果计费；复发、争议或错误归因通过 Credit/Reversal 更正。
12. 所有 OPC-generated 客户侧业务答复受 OutputLease 控制；字幕和翻译只有在其 OutputLease 的 audience、modality 和 semantic_scope 不冲突时才可并行。Overlay 外部人工、提示音或 Bot 输出只进入 ExternalOutputProjection，除非 Adapter 的 mute/floor/hold 能力已通过资格测试，否则 OPC 不声称能够 fence。
13. 录音、转写、翻译和 AI 处理必须分别记录授权范围。
14. 框架本地 session、memory、cron 和 queue 不是 OPC 权威。
15. 任何 `unknown` 外部动作结果必须进入查询或 reconcile，不能盲目重试。

### 7.4 Resolution 状态机

以下 Resolution/ResolutionItem 生命周期在 Native 与 Overlay 两种模式都由 OPC Resolution Core 写入，用于 OPC 自己的问题执行、测量、验证和 Outcome 归因。Native 模式可把它作为 OPC 产品内的正式 Resolution 生命周期；Overlay 模式仍不得把它冒充外部 CRM/FSM 的 Case、SLA 或正式关闭：

```text
Open
  → Triaged
  → InProgress
  → Waiting
  → InProgress
  → Verifying
  → Resolved
  → Closed

任意非终态 → Cancelled
Resolved / Closed → Reopened
```

语义：

- `Waiting`：明确等待客户、配件、外部系统、预约或审批，不消耗活动专家。
- `Verifying`：解决动作已完成，但验证政策尚未满足。
- `Resolved`：验证完成，但仍处于观察窗口。
- `Closed`：观察窗口结束或业务明确关闭。
- `Reopened`：相同 ServiceSubject 和问题在策略窗口内复发。

每个 ResolutionItem 独立使用：

```text
Identified
  → Qualified
  → InProgress
  → Waiting
  → Verifying
  → Resolved
  → Observing
  → Final

Resolved / Observing / Final → Reopened
Identified / Qualified → RejectedAsDuplicate / OutOfScope
```

Resolution 只有在全部 Item 进入终态后才能 Closed。新发现的问题必须新建 ResolutionItem，不能静默改变原 ProblemStatement 和基线。

关闭使用版本化 barrier：

- `resolution_item_membership_version` 在 add、remove（仅未开始的误建项）、reopen 时递增；
- Close Command 必须携带 expected membership version 和 expected Resolution version；
- Authority 在同一事务中确认该 membership snapshot 的所有 Item 已终态，写入 `close_epoch`；
- 并发 add/reopen 使 Close 失败；Closed 后新增 Item 必须先原子 Reopen，再 attach；
- projection 只在看到相同或更高 close_epoch 时显示 Closed，不能用异步计数猜测。

Overlay 模式不复制外部 Case/WorkOrder 的正式生命周期。除了上述 OPC 自有 Resolution/ResolutionItem，OPC 还写一个用于描述本次外部系统协作进度的 `ResolutionExecution`：

```text
Bound
  → Active
  → Waiting
  → Verifying
  → ExecutionComplete
  → Reconciled

任意非终态 → Aborted
ExecutionComplete / Reconciled → ExecutionReopened
```

`ExecutionComplete` 表示 OPC 的协作/证据工作完成，不表示外部 Case 已关闭。只有外部 Projection/Receipt 达到新 source revision 后，OPC 才把执行标记为 `Reconciled`；ExternalCaseProjection 陈旧时界面必须显示 `stale/awaiting_external_authority`。

Overlay 映射规则：

- 外部 Case `Closed` 只更新 ExternalCaseProjection；当对应 Verifier Receipt 满足 VerificationPolicy 时，OPC 才可推进 OutcomeClaim、ResolutionItem 和 Resolution，且仍须通过 membership-version close barrier；
- 外部 Case `Reopened` 只更新 Projection 并触发 query/reconcile；若同一 problem fingerprint 在策略窗口内复发，则 OPC 重开对应 ResolutionItem，否则创建新 Item 或新 Resolution；
- OPC 的 `Resolved/Closed/Reopened` 不直接改写外部 Case；需要外部变更时必须创建 ActionProposal/ActionIntent，并以 EffectReceipt 确认；
- 任一侧状态无法权威查询或 source revision 陈旧时，映射保持 `Unknown/AwaitingAuthority`，不得推断两侧已同步。

### 7.5 Action 状态机

Action 由独立对象构成，避免把建议、业务意图、授权、执行和外部观察混成一条记录：

```text
ActionProposal
  └── accepted by Action Authority → ActionIntent

ActionIntent
├── Authorization
├── ExecutionAttempt[]
├── EffectObservation[]
├── EffectReceipt[]
└── EffectVerification
```

只有 Action Authority 验证 Proposal schema、租户、目标、风险和去重后才能创建唯一 ActionIntent；拒绝的 Proposal 不进入执行账本。`ActionIntent`：

```text
Created
  → PolicyChecked
  → AwaitingApproval
  → Authorized
  → Executing
  → EffectKnown
  → Verified / Rejected

AwaitingApproval / Authorized → Expired
AwaitingApproval / Authorized → Cancelled
Authorized → ReauthorizationRequired
Executing → Unknown → Reconciling → EffectKnown / Failed
```

每个 ExecutionAttempt 具有独立 attempt_id、idempotency key、authorization version、deadline、fence token 和 provider request id。迟到的旧 Attempt 不能覆盖新 Authorization 或新 Attempt。

ExecutionAttempt 固定 `dispatch_point` 和 `settlement_point`。只有尚未 dispatch，或 provider 以可审计 Receipt 明确确认取消时，才能进入 Cancelled；超时、交接或断网不能假装取消，必须进入 Unknown/query/reconcile。

EffectObservation 可以来自多个外部查询或回调。EffectReceipt 分级：

| Receipt level | 只证明 |
| --- | --- |
| `accepted` | provider 接受请求，不证明执行完成 |
| `completed` | provider 声称完成，不证明目标状态正确 |
| `state_observed` | 在指定 source revision 查询到目标状态 |

EffectVerification 按工具和 VerificationPolicy 判定哪个 level、哪些 Observation 足以证明实现 ActionIntent，不能把 HTTP 2xx 或 `accepted` 泛称为权威效果证明。

Compensation 也是新的外部副作用：必须创建新的 ActionIntent，引用 `compensates_action_intent_id`，重新执行 Policy/Authorization，并使用独立 idempotency key。原 Action 只记录补偿关系和最终 Effect，不直接“跳转”执行补偿。

### 7.6 OutcomeClaim 状态机

```text
Proposed
  → Provisional
  → Verified
  → Finalized

Proposed / Provisional / Verified → Rejected
```

`Finalized` OutcomeClaim 永久不可变。争议和冲正使用独立对象：

```text
OutcomeDispute
  → Reviewing
  → Rejected（原 Claim 不变）
  → Upheld
       ├── OutcomeReversal
       └── Billing Credit/Reversal
```

OutcomeClaim 固定：

- resolution_item_id；
- problem_fingerprint；
- VerificationPolicyVersion；
- baseline_version；
- observation_window；
- verifier identity/type；
- required Evidence threshold；
- confidence 和不确定性；
- value components、currency 和计算版本；
- contribution record；
- 唯一 billing key。

同一个 `(resolution_item_id, outcome_type, policy_family)` 同时最多一个 active Claim；新 policy 可以创建 successor，但必须显式 supersedes。一个计费窗口内每个 outcome type 最多一个未冲正 Finalized Claim。

ResolutionItem 进入 `Final` 必须存在 active policy 下的 Finalized OutcomeClaim，且观察窗口完成。映射规则：

- 相同 problem fingerprint 复发、验证证据失效或“未真正解决”争议成立：创建 OutcomeReversal/Credit，并将 Item 与 Native Resolution 置为 Reopened；Overlay 置 `ExecutionReopened` 并向外部 Authority 提交 reopen proposal/query。
- 仅价值、币种、贡献或账单计算错误：创建 OutcomeReversal/Credit 和 successor Claim，不自动重开技术问题。
- 外部 Verifier Receipt 未到或 ExternalCaseProjection stale 时，Claim 最多停在 Provisional/Verified，不能 Finalized。

历史 Claim、发票和 Credit 均不可覆盖。

### 7.7 渠道切换状态机

所有 SIP/PSTN、WebRTC、LiveKit 和未来 ViLTE 切换使用同一个持久合同：

```text
Idle
  → Preparing
  → Prepared
  → Committing
  → Active

Preparing / Prepared → Aborting → Aborted
Committing → Unknown → Querying / Reconciling
Active → Returning / Replacing / Terminating
```

要求：

- prepare、commit、abort、query、reconcile 幂等；
- 使用 make-before-break；新媒体达到 commit condition 前不释放旧媒体；
- 使用 generation fencing 防止旧回调覆盖新状态；
- 失败后能够返回原通道；
- billing、recording、consent 和 Trace 连续；
- Room、Participant 和端口孤儿可恢复。

首版优先 `additive_video`：保留 PSTN/SIP 音频，只增加 WebRTC 视频或屏幕。`replace_audio_video` 必须单独证明。

每个切换规格必须定义：

- RTPengine offer/answer/delete receipt；
- Room/Participant reservation；
- commit point；
- 最大双媒体重叠时间；
- 最大允许媒体空洞和丢包；
- old-leg grace period；
- hangup race 和 crash-before/after-commit；
- late callback 处理；
- bridge capacity reservation；
- rollback 和返回原通道条件。

RTPengine 资源使用独立状态机：

```text
Reserved
  → OfferPending → Offered
  → AnswerPending → Answered
  → Active
  → DeletePending → Deleted

任意命令超时 → Unknown → Querying/Reconcile → 已知状态
```

`RtpAllocation` 固定记录 set/node affinity、call-id、from/to tag、branch label、generation、command idempotency key、offer/answer/delete receipt 和 lease。控制状态与 outbox/journal 同一 durable boundary 提交；网络超时先 query/reconcile，禁止盲目重复创建或释放。`Deleted` receipt 或明确 lease/reconcile 完成前，端口与 billing generation 不得复用。

LiveKit Room/Participant 也先 reserve capacity/token，再创建或加入；commit 前必须同时满足目标 Publication/Subscription ready 和 Bridge media-ready。crash 恢复按 generation 查询两侧并选择 commit、abort 或 return，不能只相信 webhook。

---

## 8. 目标产品架构

### 8.1 逻辑分层

```text
┌────────────────────────────────────────────────────────────┐
│ Product Experiences                                        │
│ Customer Join / Expert Workspace / Supervisor / Studio     │
├────────────────────────────────────────────────────────────┤
│ Resolution & Collaboration                                 │
│ Resolution / Interaction / Task / Routing / Handoff        │
├────────────────────────────────────────────────────────────┤
│ AI & Media Intelligence                                    │
│ Speech / Translation / Vision / Copilot / Agent Execution  │
├────────────────────────────────────────────────────────────┤
│ Action, Knowledge & Governance                             │
│ Tool Policy / Workflow / Evidence / Memory / Eval / Release│
├────────────────────────────────────────────────────────────┤
│ Communication Fabric                                       │
│ Overlay Adapters / SIP / RTP / WebRTC / Video / Future IMS │
├────────────────────────────────────────────────────────────┤
│ Platform                                                   │
│ Identity / Tenant / Storage / Events / Billing / Observability│
└────────────────────────────────────────────────────────────┘
```

### 8.2 Authority 分配

Authority 必须按部署模式区分。

#### Native 模式

| 领域 | 唯一 Authority |
| --- | --- |
| SIP REGISTER、Contact Binding、Location 和 edge dispatcher runtime | Kamailio；Standalone profile 才可由 Unified RustPBX 内置，二者不得同时写 |
| 业务 Route/Trunk 选择、PSTN/SIP Call、Leg、Dialog | OPC Telephony Control（Unified RustPBX） |
| WebRTC Room、Participant、Publication 和 SFU runtime | LiveKit/SFU |
| Interaction、CommunicationSession、BridgeIntent 和跨通道 generation | OPC Communication Coordination |
| Resolution、ResolutionItem、Task、OutcomeClaim | OPC Resolution Core |
| 外部副作用 | OPC Action Ledger + Tool Policy |
| 企业 Context、Memory、Knowledge | OPC Context & Knowledge Core |
| Agent 发布和推广 | OPC Governance Core |
| 计费归因 | OPC Metering Core |
| 客户侧业务输出 | OPC Collaboration OutputLease |

#### Overlay 模式

| 领域 | 唯一 Authority | OPC 拥有 |
| --- | --- | --- |
| 外部电话、Dialog、Queue、Transfer | 客户 PBX/CCaaS | ExternalSessionProjection、ResolutionBinding、BridgeIntent |
| 外部视频 Room/Meeting | 外部视频平台或 LiveKit/SFU | ExternalRoomProjection、CapabilityLease |
| CRM Case、FSM WorkOrder、SLA、正式关闭 | 客户 CRM/FSM | ResolutionExecution、Interaction、Evidence、AI Run、Action Ledger |
| 问题执行、测量与 OutcomeClaim | OPC Resolution Core | Resolution、ResolutionItem、ResolutionExecution、VerificationPolicy |
| OPC 增加的视频/屏幕协作 | LiveKit/SFU 拥有 Room runtime | OPC CommunicationSession、BridgeIntent、ParticipantProjection |
| Outcome 正式确认 | 外部 Case Authority 或双方约定 Verifier | OutcomeProposal、Evidence、OutcomeClaim lifecycle |
| 外部副作用 | 外部系统 + OPC 动作合同 | Authorization、Attempt、Receipt、reconcile |
| 外部人工/平台对客户输出 | 客户 PBX/CCaaS/视频平台 | ExternalOutputProjection；不能默认 fence |
| OPC 生成的字幕、翻译、TTS、通知 | OPC Collaboration OutputLease | 仅控制 OPC 自己的 generation |

Overlay 不创建隐性系统替换。OPC 始终拥有自己的 Resolution/ResolutionItem 问题执行与测量生命周期，但它不等于外部 Case、SLA 或正式关闭。`ResolutionBinding` 版本化关联两侧：

```text
binding_id
external_case_ref + source_revision
resolution_id
resolution_item_ids[]
relationship_type
valid_from / valid_to
binding_version
```

一个外部 Case 可关联多个 Item，一个 Item 也可跨多个外部 Case/WorkOrder；默认不自动合并或拆分，变更必须 expected-version 和审计。外部系统确认正式关闭/验证后返回相应 Receipt，OPC 才能推进 Reconciled/Finalized。

External Projection 必须记录：

```text
source_system
source_object_id
source_revision / etag
webhook_cursor
observed_at
stale_after
projection_state
last_query_result
```

Adapter 必须处理乱序、重复、丢失和迟到事件。投影陈旧时禁止声称外部状态已更新；命令被拒绝或结果未知时进入 query/reconcile。

若外部系统没有 source revision/etag 或可靠 cursor，Adapter 必须从权威 query 结果生成带采样时间、内容 digest 和单调本地序号的 `synthetic_revision`，并将一致性等级标记为 `query_derived`。无法权威 query 的能力 fail-closed/no-bid，不能用 webhook arrival order 冒充业务顺序。

### 8.3 深模块与稳定接口

| 模块 | 对外接口提供 | 隐藏的复杂度 | 不负责 |
| --- | --- | --- | --- |
| Resolution Module | open、transition、verify、close、reopen | 状态机、并发、审计、观察窗口 | 媒体包、模型调用 |
| Communication Coordination Module | bind、prepare、commit、return、terminateIntent | Native/Overlay 能力、make-before-break、恢复 | 伪装成外部 Call/Room Authority |
| Telephony Control Module | originate、answer、modify、terminate、query | SIP、Dialog、RTP 生命周期 | Resolution、AI |
| WebRTC Control Adapter | reserveRoom、join、publish、subscribe、remove、query | LiveKit/SFU API、Room/Participant/Publication projection 和供应商差异 | 冒充 Room runtime Authority、电话 Dialog |
| Collaboration Module | assignOwner、handoff、takeover、return | 单输出者、角色、接管和通知 | 模型实现 |
| Media Intelligence Module | attachCapability、detach、health、quality | tap、decode、采样、队列、旁路 | 业务 Outcome |
| Speech Runtime Module | start、update、interrupt、stop | Cascade、Realtime、VAD、TTS 差异 | 持久 Task |
| Agent Execution Module | run、steer、cancel、resume | Pi/Nanobot/其他框架、预算、事件 | 工具副作用 |
| Action Module | propose、authorize、execute、query、reconcile | 权限、幂等、收据、补偿 | 自由对话 |
| Context Module | assembleRevision、retrieve、proposeMemory | 来源、版本、TTL、删除和地域 | 通信状态 |
| Governance Module | publish、evaluate、promote、rollback | Artifact、Shadow、Canary、策略 | 在线媒体 |
| Metering Module | reserve、recordUsage、attributeOutcome、invoiceProjection | 多种用量、退款、唯一账单键 | 决定产品策略 |

接口必须包含：

- 语义和不变量；
- 顺序与幂等要求；
- 超时和错误模式；
- 性能等级；
- 可取消性；
- 权限和租户范围；
- Trace、版本和成本标识。

不允许只定义类型签名而隐藏这些调用义务。

所有跨模块 Command/Event 使用共同 envelope：

```text
contract_version
command_or_event_id
tenant_id
authority_id
aggregate_id
aggregate_version / expected_version
idempotency_key
source_revision
deadline
cancel_token
ordering_key
trace_context
data_region
```

每个接口规格必须明确：

- 强一致、读己之写或最终一致；
- caller 与 callee 中谁负责重试；
- 最大在途数量和背压结果；
- 超时后是 `failed` 还是 `unknown`；
- 是否允许取消以及取消结算点；
- 兼容版本和降级能力；
- Command、Event 和 Query 的 Schema；
- 允许同步调用的最大预算。

### 8.4 四个故障域

四个 Cell 是独立部署和资源隔离合同，不只是逻辑目录。

#### Telephony Cell

独立 Rust 控制进程、RTPengine 进程/节点池、端口和 CPU 预留。负责 SIP/PSTN 控制和普通 RTP/SRTP。不得加载 Python、GPU 或模型运行时。

#### WebRTC / Video Cell

独立 LiveKit/SFU、Ingress/Egress、Control Adapter 和桥接资源池。LiveKit/SFU 拥有 Room、Participant、Publication runtime；OPC 只拥有业务绑定和桥接 generation。SFU 故障不得拖垮 Telephony Cell。

#### AI Session Cell

独立 Worker、GPU 配额和 admission。Speech、Vision、Realtime Model、Translation 和 Copilot 至少使用独立进程、队列、配额和 bulkhead，不能共享无界 GPU/CPU 池。Recorder/Media Worker 使用独立进程和 admission pool，合规录音不得与 GPU AI 共用 host/OOM 故障域。

#### Durable Resolution Cell

独立应用、Workflow Worker、数据库和事件处理器。负责 Resolution、Task、Action、等待、恢复、知识和治理。其短暂不可用不得中断已经建立的允许继续媒体；恢复后通过持久 Journal、事件和查询补账。

#### 共享依赖与隔离

允许共享的基础设施必须按租户、Cell 和优先级隔离：

- Identity/PKI；
- KMS/Key Service；
- 签名配置分发；
- DNS/Service Discovery；
- Time Synchronization；
- Event Bus；
- Object Store；
- Observability；
- Durable Store。

Telephony/WebRTC 媒体热路径不得同步依赖这些共享服务。

#### Fault Containment Matrix

| 故障 | 已建立 Human Communication | 新会话 | AI/附加能力 | 恢复与证据 |
| --- | --- | --- | --- | --- |
| Resolution DB 不可用 | 按本地有效策略继续媒体 | 只接受签名策略快照允许的路由；其余明确拒绝/回退 | 新 Action 和高风险 AI fail-closed | bounded durable journal，恢复后 replay/reconcile |
| Event Bus 不可用 | 媒体继续 | admission 受 journal 配额限制 | 非关键事件 store-and-forward | 本地磁盘 WAL；满后先拒绝附加能力和新非关键会话 |
| Object Store 不可用 | 媒体按租户政策继续 | 受 recorder/evidence policy 控制 | 停止新 Evidence 上传 | spool 有界；超限按 fail-open/fail-closed policy |
| AI Speech/Model 不可用 | 可选 AI detach，人与人通话继续 | AI Endpoint 转人工、公告、重建或受控终止 | 对应 capability 熔断 | 记录因果、fallback 和丢失区间 |
| Vision GPU 过载 | 音视频继续 | 视频仍可加入 | Vision 降采样或关闭 | 不抢占 Speech/Translation 保留容量 |
| WebRTC Cell 故障 | PSTN/SIP 音频继续 | 视频升级暂不可用或换区 | 视频 AI 关闭 | 清理 reservation/participant，保留 Resolution |
| Telephony Cell 故障 | 受影响活动 Call 通常不可迁移 | 新呼叫转健康 Cell | WebRTC 独立会话可继续 | CDR/资源 reconcile，不能伪称活动媒体无损迁移 |
| Workflow/Tool 故障 | 通信继续 | 会话可建立 | Action 停止或排队 | durable retry、query/reconcile |
| Identity/PKI 不可用、证书到期/吊销 | 已建立媒体按 pinned lease 继续到明确期限 | 本地身份/证书无效即 fail-closed | 新 token/lease 停止 | 独立吊销缓存；恢复后重新认证，不降级明文 |
| KMS/Key Service 不可用 | 已有会话只用内存中有效 key 到 rotation deadline | 需要新 key 的媒体/录音 fail-closed | 不能解密或加密的新能力关闭 | 不复用过期 key；记录 rotation/coverage gap |
| DNS/Discovery 错误或陈旧 | 已建立连接/媒体不依赖重新解析 | 仅在签名 endpoint cache TTL 内尝试健康地址 | 新 Worker attach 可暂停 | TTL 到期 fail-closed；禁止随机 fallback |
| 签名策略过期 | 活动 Session pin 原版本到 max-session grace | 超过策略 grace 后拒绝新 admission | 新敏感能力停止 | 拉取/验证新版本，记录 stale duration |
| wall-clock 跃迁或 NTP 异常 | monotonic media loop 继续 | token/signature 超偏差时隔离节点 | Evidence 标记 clock uncertainty | 校准后再 admission；禁止修改历史时间线 |

#### Admission 与离线窗口

新会话 admission 读取签名、版本化本地策略快照，并将决定写入本地 durable journal。租户选择：

```text
fail_open_nonregulated
fail_closed_before_sensitive_step
fail_closed_before_answer
```

已建立媒体继续转发不等于所有新会话都 fail-open。超过租户最大离线窗口或 journal 上限时拒绝新会话，让旧会话 drain。

ConsentLease 使用短 TTL 和 monotonic deadline；正常撤销走 Event Bus，紧急撤销同时走独立签名控制通道。两条都不可用时，相关 AI/录音能力最迟在 `max_consent_staleness` 到期自动 detach；高风险租户取更短 TTL。每次传播延迟和超期处理必须计量。

#### 故障验收

每个 Cell 规格必须定义：

- 独立进程/Pod/节点池；
- CPU、内存、网络、端口、队列和 GPU 配额；
- 必需与可选依赖；
- 同步调用预算；
- admission class 和保留容量；
- circuit breaker、bulkhead 和本地 journal；
- RTO/RPO；
- kill、网络分区、磁盘满、DB/Event/Object Store、PKI/KMS、DNS、配置过期和时钟跃迁故障注入；
- 原始 Evidence 和审核人。

默认恢复目标（客户合同可更严格，当前均未证明）：

| 范围 | Target RTO | Target RPO / 语义 |
| --- | --- | --- |
| Telephony 实例故障后的新呼叫 | ≤30s 被健康 Cell 接管 admission | 已提交 CDR/effect journal 不丢；故障实例活动媒体不承诺迁移 |
| WebRTC/SFU 新 Room admission | ≤60s 路由到健康节点/区域 | Room projection 可重建；故障节点活动 Room 按供应商能力和测试报告 |
| BridgeIntent `Prepared/Committing/Unknown` | p95≤30s、p99≤120s query 两侧并决定 commit/abort/return | durable generation RPO=0；恢复期间禁止双 billing writer，孤儿 p99≤5min 清理 |
| 可选 AI/Media Worker | ≤60s 恢复 admission 或保持熔断 | 最后确认 Checkpoint；不得重放 Action，coverage gap 明示 |
| Durable Resolution 同区域多 AZ | ≤15min | 对已确认 Command/Action/OutcomeClaim 目标 RPO=0 |
| Durable Resolution 跨区域灾备 | ≤4h | 默认 RPO≤5min；更严格客户需同步架构和独立价格 |
| 本地 durable journal | 进程重启即 replay/query | 未收到 Authority ack 前不删除；满载后拒绝新 admission |

RTO 不代表活动音视频无损迁移；RPO=0 只适用于已返回 durable acknowledgment 的对象。

---

## 9. 通信与媒体架构

### 9.1 两种接入模式

#### Overlay

连接客户现有：

- PBX、SBC、Genesys、Zoom、Five9、Amazon Connect；
- CRM、FSM、ITSM；
- 浏览器、移动 App 和消息渠道。

Overlay Adapter 将外部标识映射到稳定 Interaction 和 Resolution，但不假装拥有外部平台状态。

首个 Pilot 的接入拓扑固定为 provider-specific、非通话中继：

- 订阅权威 call event/webhook，获得稳定 external call id、参与者和终态；
- 通过 CTI deep link/SDK 在专家工作台关联当前 Call；
- 原电话音频继续由客户 PBX/CCaaS 承载，OPC 不 answer、不 transfer、不改 Queue；
- Milestone B1 只选择支持双声道 receive-only media fork 的一个 Provider，用于中英字幕/文字翻译；
- 若 Provider 不支持可验证 media fork，则该 Provider 不满足 B1；不得用“generic SIP”掩盖差异；
- translated TTS 不回注外部电话，除非未来 Adapter 通过 mute/floor/hold 能力 Gate。

具体 Provider 在 3 个设计伙伴收敛后、实现前冻结；Pilot A 可以先验证事件/CTI/video，Pilot 完成必须包含同一 Provider 的 B1。

#### Native

目标组合：

```text
Kamailio / SBC Edge
        ↓
Unified RustPBX / Rust Telephony Control
        ↓
RTPengine Fast Path
        ↘ 按需 Media Intelligence Tap

Web / Mobile / Video
        ↓
LiveKit-compatible SFU
        ↘ 按需 Media Intelligence Tap
```

Kamailio 保持 SIP edge，RTPengine 是普通 RTP/SRTP 性能下限，LiveKit/SFU 保持 WebRTC Room runtime Authority。具体 Rust SIP/RTP 库由资格测试决定，不能仅因已有代码或同为 Rust 而锁定。

`voice-media-rs` 在本文中是 OPC 内部 Rust 媒体处理模块的工作名，不是假定存在的成熟第三方服务。它可吸收现有 codec/jitter/mixer/recorder 实现，但只能暴露统一 MediaPipeline 合同。

生产部署中：

- Unified Rust Telephony Control 保持唯一 Native Call Authority；
- 普通媒体仍走 RTPengine；
- 必须内联且已证明安全的低层能力可使用同源 Rust crate；
- 可选录音、翻译、AI、视觉和高成本处理运行在独立 Media/AI Worker 进程与资源池；
- “共享源码”不等于“共享故障域”，Worker panic/OOM/GPU 故障不能结束 Telephony Control；
- Worker 不拥有 Call/Resolution Authority，恢复时通过 generation/lease/query 重新附着。

#### 互通与切换矩阵

| 起点 → 目标 | 媒体做法 | Runtime Authority | 产品阶段 |
| --- | --- | --- | --- |
| LiveKit audio → LiveKit audio+video/screen | 同 Room 增加 Publication，不重建业务 Interaction | LiveKit/SFU；OPC 管 consent/业务绑定 | Pilot/V1 |
| Overlay 外部电话 audio → 外部 audio + LiveKit video | 音频留在客户 PBX/CCaaS，OPC 只增加视频和关联；不经过 RTPengine | 客户 PBX/CCaaS 管 Call；LiveKit 管 Room；OPC 仅 Projection/BridgeIntent | Pilot |
| Native SIP/PSTN audio → RTPengine audio + LiveKit video | 保持 RTPengine 音频，增加独立 LiveKit 视频 | Unified RustPBX 管 Call；LiveKit 管 Room；OPC Coordination 管关联 generation | Native Option |
| SIP/PSTN audio → LiveKit audio+video | prepare 新 Room/Participant/媒体边，make-before-break 后替换音频 | 双 Authority + OPC BridgeIntent | 资格测试后 |
| LiveKit audio+video → SIP/PSTN audio | 先建立/确认 SIP 音频，视频 graceful detach，返回 RTPengine | 双 Authority + OPC BridgeIntent | 资格测试后 |
| SIP/PSTN audio ↔ LiveKit audio | 独立 SIP↔WebRTC Bridge，录音/DTMF/hold/transfer 单独验证 | Unified RustPBX + LiveKit/SFU | V1/Native Option |
| ViLTE voice/video mode switch | IMS 会话内按目标 Operator Profile 修改媒体；不经过 LiveKit SIP | IMS Control + IMS AV Gateway | Horizon Option |
| ViLTE AV ↔ LiveKit AV | IMS AV Gateway 与 WebRTC/SFU 建立显式 AV bridge | IMS runtime + LiveKit/SFU + OPC Coordination | Horizon Option |

所有路径保持稳定 Resolution/Interaction 标识，使用显式 leg、participant、edge、pipeline 和 bridge generation；每个有向媒体 Edge generation 只有一个 billing writer。切换合同统一使用 prepare/commit/abort/query/reconcile，记录 codec、DTMF、hold/transfer、SRTP/DTLS、token/tenant、webhook 顺序、participant cleanup、crash/orphan、录音分段、switch gap/loss 和返回 RTPengine 的证据。Bridge 容量单独测试，不能继承排除 Bridge 的压测结果。

### 9.2 普通媒体与处理媒体分流

每个候选 Route 先生成版本化 `MediaDemand`：

```text
required:
  codec/profile
  encryption
  DTMF mode
  recording/compliance
  bridge/mix/transcode
optional:
  caption
  translation
  quality
  copilot
capacity_class
fallback_policy
```

Backend 发布 `BackendCapabilities`，未知能力按 `false` 处理。只有 required demand 全部匹配并成功 reserve capacity 才能 answer/originate；optional demand 可以按策略关闭。Capability 声明必须绑定 backend/version/config 和 Evidence，不允许因“底层库理论支持”而开放产品能力。

DTMF 是独立实时事件流：RTP telephone-event、SIP INFO 和受控 in-band 检测进入统一 `DtmfEvent`，保留 source、duration、volume、clock 和 generation；转换、去重和转发由明确 owner 完成，不把 DTMF 当作 codec 附带字符串。

```text
人与人普通音频：
Endpoint ↔ RTPengine fast path ↔ Endpoint
                    └── PassiveFork → recorder / ASR / quality

需要改变目标媒体：
Source → InlineTransform
       → jitter / decode / process / encode
       → Sink

AI 本身是对端：
Human Endpoint ↔ EndpointProcessor（Voice Agent）
```

原则：

- 不需要解码的媒体不进入 AI 或通用事件总线；
- 每个 PassiveFork 有界；满载时只丢弃或降级分支，不能反压主媒体；
- InlineTransform 在 admission 前必须预留容量，并定义健康探测、最大缓冲、断路、旁路和终止政策；
- EndpointProcessor 是媒体端点，不能承诺“AI 故障后透明旁路为同一通话”；其故障回退是公告、重建、转人工或受控终止；
- 翻译后的语音、混音和转码属于 InlineTransform；旁路为原声是否合规必须由租户策略决定；
- 视频 AI 使用事件触发或自适应抽帧，不持续把全帧送入大模型；
- 录音、转码、翻译、会议和 AI 分别产生容量证据；
- 不允许继承“普通转发”压测数据；
- 媒体帧不访问数据库；
- 避免每包分配、全局锁、全局扫描和每包 Task。

录音必须区分三条产品合同：

| 录音路径 | 产物 | 适用范围 | 故障策略 |
| --- | --- | --- | --- |
| Packet Capture | 加密边界允许范围内的原始 RTP/SRTP 相关包或封装 | 法证、协议排障 | 有界 spool；不拖慢媒体 |
| Decoded Multitrack | 每位 Participant/Source 的独立解码轨 | QA、转写、重混 | PassiveFork；允许标记缺口 |
| Mixed/Composed | 客户最终听到/看到的混合音视频 | 回放、服务报告 | 单独 Mixer/Composer 容量和证据 |

三者不得共享“录音已成功”这一模糊状态；每个 RecordingGeneration 记录 coverage、gap、clock mapping 和终态。

### 9.3 统一 RealtimeStream 与媒体资源模型

```text
RealtimeStream
├── MediaStream
│   ├── Audio
│   ├── Video
│   ├── Screen
│   └── FutureImmersive
├── RealtimeTextStream
├── DataStream
└── IMSDataChannelSession（未来、独立协议合同）

MediaSource / Publication
  → MediaEdgeGeneration(source → sink)
      ├── PassiveFork[]
      └── MediaPipelineGeneration?
            ├── InlineTransform[]
            └── Sink
```

Source/Publication、Edge 和 Pipeline 是不同资源，不能共用一个生命周期。规范字段：

- stream_id、source_id、publication_id；
- edge_id、edge_generation、source、sink 和 lifecycle_owner；
- pipeline_id、pipeline_generation、capacity_reservation 和 fence_token；
- codec/profile；
- encryption boundary；
- consent lease 和处理目的；
- recording/translation/AI policy；
- quality state；
- cost attribution；
- lifecycle state；
- created_at、media_clock、monotonic_clock 和 wall_clock mapping。

规则：

- 每个方向、每个 generation 只有一个媒体 owner 和一个 billing writer；
- Source 可以被多个 Edge 引用，但一个 Sink 的某个 publication slot 只有一个当前 generation；
- 新 generation commit 后，旧 generation 进入 grace/drain，再由 owner 回收；
- DataStream 和 IMSDataChannelSession 不伪装成视频 Track；它们使用各自的可靠性、顺序、拥塞和安全合同；
- consent、记录、翻译和 AI 处理附着在具体 Edge/Pipeline generation，不能只挂在 Session 上；
- PassiveFork 的丢帧只形成 coverage gap；InlineTransform 丢帧属于客户体验故障。

三方及以上协作创建显式 `ConferenceGeneration`，记录 membership generation、每位 Source/Edge、音频 mixer、视频 SFU subscription、active-speaker policy、转码/录音 demand 和容量 reservation。专家加入失败时按策略保留原双人通话；会议容量、N 方混音、异构 codec、录音和参与者 churn 必须独立验收，不能以双人 Bridge 数据代替。

### 9.4 Codec 策略

电话侧目标至少覆盖：

- PCMA/PCMU；
- Opus；
- G.722；
- `G729/8000`。

G.729 使用一个 wire codec 名称 `G729/8000`。G.729A 和 G.729AB 是内部实现模式，不作为不同 SDP codec 名称。合同必须覆盖：

- 动态 payload type 映射和 offer/answer 对称性；
- `ptime`、`maxptime` 和帧聚合；
- RFC 4856 `annexb=yes|no`，省略时按 `yes` 解释；
- RFC 7261 的不匹配 offer/answer 行为；
- Annex B 的 VAD/DTX/CNG 行为；
- packet loss、SID、重排序、长静音和跨实现互通；
- exact source、构建选项、许可证、已知向量和逐样本回归；
- G.729↔PCMA/PCMU/Opus 转码的独立容量和质量证据。

G.729 工程能力是电话互通的强制目标。分发、启用和商业许可由法律/合规策略控制，但法律结论不得替代实现、测试或互通证据。

视频侧优先复用成熟 WebRTC/SFU codec 能力，不自研视频 codec。

### 9.5 ViLTE 和 5G New Calling

LiveKit SIP 不能作为 ViLTE 视频网关。未来能力拆成四个独立模块：

```text
Carrier IMS / ViLTE
  ├── IMS Control Adapter / B2BUA
  │     SIP/SDP、注册/鉴权边界、补充业务和会话连续性
  ├── IMS AV Media Gateway
  │     RTP/RTCP、codec/profile、SRTP/DTLS、lip-sync、keyframe/feedback
  ├── IMS Data Channel Gateway / DCS
  │     bootstrap/application data channel、应用发现、授权和内容策略
  └── Operator Conformance Profile
        运营商、终端、地区、3GPP Release、GSMA profile 和测试证据
        ↓
  LiveKit/SFU + OPC RealtimeStream/Resolution Coordination
```

IMS Data Channel 是与 IMS MMTel 会话关联、经 SDP 协商的独立媒体能力，不等于把一个普通 WebRTC `RTCDataChannel` 或 SFU Track 透传过去。必须按明确 Release 和运营商 Profile 实现；不能用未来兼容接口宣称已具备 ViLTE/NG-RTC。

未来 Carrier IMS 保持网络侧注册、策略和 MMTel Session Authority；OPC 的 IMS Control Adapter/B2BUA 是 Unified Telephony Authority 内的一个 Adapter，只拥有 OPC 终止的 Leg/Dialog 和 External IMS Projection，不建立第二套 Call Authority。

现在只冻结扩展接口：

- MediaStream.Video；
- RealtimeTextStream；
- DataStream；
- IMSDataChannelSession；
- 通话内 Web mini-app；
- 表单、位置、图片、屏幕和支付确认；
- 运营商身份和服务连续性。

不在首轮自建 IMS Core，也不冻结具体 IMS 网关实现。进入开发的前置条件是运营商/设备商合同、目标 3GPP Release、GSMA Profile、终端矩阵和实验网。

### 9.6 通信可靠性原则

1. 新会话进入健康 Cell，旧会话 drain。
2. 滚动升级不迁移活动媒体，除非协议和测试明确支持。
3. 所有资源有 lease、generation 和 owner fencing。
4. RTP 端口、Room、Participant、Recording 和 reservation 可查询、回收和 reconcile。
5. Edge-to-Core 使用强身份和最小权限。
6. HumanCommunicationWithOptionalAI 中，非监管 profile 的可选 AI、录音和知识默认不形成建呼依赖；监管 profile 可把 recorder/consent/readiness 显式设为 answer 或敏感步骤前的 fail-closed Gate。
7. 普通媒体容量、录音容量、转码容量、AI 容量和视频桥容量分别验收。

Native SIP 合同至少覆盖：

- INVITE/CANCEL/BYE race、事务计时器和 `100 Trying` 预算；
- early media、可靠临时响应/PRACK；
- parallel/sequential fork、最终响应选择和迟到分支；
- Session Timer、re-INVITE/UPDATE、hold/resume；
- REFER、Replaces、blind/attended transfer；
- NAT、Contact/Route、Record-Route 和拓扑隐藏边界；
- DTMF 的 RFC 4733、SIP INFO 和受控 in-band 检测；
- RTP/RTCP、SRTP、ICE/DTLS 边界和 SDP glare；
- 崩溃恢复、重复消息、乱序和资源原子回收。

Overlay Adapter 使用 fail-closed capability matrix。对每个供应商/版本记录 `observe/query/command/receipt/reconcile` 能力，无法证明 transfer、recording、participant cleanup 或 webhook ordering 时不得对外宣称相应能力。

多区域默认采用 session affinity：一个活动 Session 的控制 owner、媒体 generation 和 recorder writer 固定在一个 Cell/区域。区域故障可将新 Session 导向健康区域；活动媒体只有在协议和故障演练证明后才允许迁移。数据跨区和 failover 必须遵守租户驻留策略。

### 9.7 RustPBX 与 rvoip 吸收原则

Unified RustPBX 是 Native 电话产品和 Call Authority；rvoip 不是并列产品、独立节点或第二套 Call 状态机。只按低层能力切片评估：

```text
SIP message/parser
transport
transaction
dialog
SDP
RTP/RTCP
jitter
codec/resample/mix primitives
```

规则：

1. 先冻结 `SipFoundation`、Call/Leg/Dialog/Media ID、错误、事件和所有权合同。
2. 现有 rsipstack/媒体路径保持基线，rvoip 先做 shadow parse/observe，不发送第二份响应。
3. parser、transport、transaction、dialog、RTP 等按层独立迁移和回滚，不能一次 wholesale merge。
4. 每个 slice 比较 RFC/互通正确性、算法复杂度、分配、锁、CPU、内存、长通话、崩溃和维护性。
5. 同为 Rust、已有 benchmark 或上游声称性能高都不是吸收理由；OPC 必须复现 exact commit 的同源 Evidence。
6. 中间双 Backend 只能用于 shadow/Canary，最终生产中一个领域只保留一个权威实现。
7. 新呼叫迁到新实现，旧呼叫 drain；active-zero 和 reconcile 后才删除旧代码。
8. 无法证明更优或维护风险更高的 rvoip slice 可以拒绝，不以“融合比例”衡量成功。

rvoip RTP/RTCP slice 默认只可作为 endpoint、SIP↔WebRTC bridge、decode/AI worker 或算法候选，不拥有普通 RTPengine relay allocation/session。若未来要替换 RTPengine，必须单独 ADR、复现同源 `VOS-EQ-100K` 与故障证据，并按新呼叫迁移、旧呼叫 drain、active-zero/reconcile 删除；在该 Gate 前 RTPengine 始终是普通 RTP/SRTP Authority。

热路径约束：

- Call actor/Task 只处理控制事件，不传每个 RTP packet；
- registry 按 tenant/session 分片，稳定键均摊 O(1)，禁止全局扫描；
- RTP worker 使用固定 shard、有界 ring、buffer pool 和批量 I/O；
- 不每包创建 async Task、分配 Vec/String、写数据库或发送通用 Event；
- 任何锁竞争、队列长度和内存增长必须有负载曲线与上界；
- 优化必须同时证明正确性，不接受用跳过 CDR、RTCP、recording hook 或安全检查换 benchmark。

---

## 10. AI-native 运行时架构

### 10.1 四种实时语音路径

产品合同必须支持：

| 路径 | 适用场景 | 优势 | 主要风险 |
| --- | --- | --- | --- |
| Controlled Cascade | 合规、精确字幕、固定脚本、可审计工具 | 可替换、可检查、转写明确 | 多阶段延迟 |
| Native Realtime | 自然对话、情绪、低延迟 | 交互自然、端到端优化 | 可控性、恢复和供应商差异 |
| Half Cascade | 原生语音理解 + 独立 TTS | 理解自然且保留品牌声音 | 集成和调度复杂 |
| Human-only Bypass | AI 故障、低收益或客户选择 | 最高可靠性和明确责任 | 无 AI 增益 |

`SpeechRuntime` 负责统一事件和生命周期，产品不把某一路径永久写死。

同时必须区分两种服务类：

| 服务类 | AI 位置 | 基础承诺 | AI 故障回退 |
| --- | --- | --- | --- |
| HumanCommunicationWithOptionalAI | 人与人通信的 PassiveFork、Copilot 或可旁路 InlineTransform | AI 故障不得因果性中断已建立的人与人媒体 | detach、原声旁路、关闭字幕/翻译、人工继续 |
| AIEndpointCommunication | AI 是客户对话的 EndpointProcessor | 不承诺 AI 消失后“同一对端透明继续” | 播放公告、重建 Endpoint、转人工队列或受控终止 |

“AI 故障不影响基础通话”只适用于第一类，不能用于掩盖 Voice Agent 作为对端时的真实依赖。

### 10.2 Hugging Face speech-to-speech

Hugging Face `speech-to-speech` 作为首个自托管 SpeechRuntime 候选和评测基线。

当前官方实现仍是模块化：

```text
VAD → STT → LLM → TTS
```

可吸收价值：

- 可替换 VAD、STT、LLM、TTS；
- 本地和自托管模型；
- OpenAI Realtime-compatible WebSocket；
- 流式转写、音频和工具事件；
- 适合私有化和供应商切换。

采用边界必须严格按“功能相同的部分替换”：

- 替换 Active Call、LiveKit Agents 或旧 OPC 链路中重叠的 VAD→STT→LLM→TTS/流式语音循环；
- 保留它们不重叠的 Room/Participant、Channel、Agent lifecycle、tool orchestration、handoff、telemetry 和插件能力；
- HF、托管 Realtime 和其他 Cascade 都实现同一 SpeechRuntime 合同；
- VAD 是可独立资格测试和替换的组件，不因采用 HF 仓库而永久绑定其默认实现；
- Rust Telephony Control 只提供媒体 Endpoint/Tap 和会话事件，不直接嵌入 Python Speech/Agent 状态。

不能假设：

- 所有语言和噪声下优于托管模型；
- 整体延迟必然低于 Native Realtime；
- 已具备 OPC 所需的多租户、HA、配额和审计；
- 其 VAD 在所有场景最佳。

生产采用必须通过长短通话、噪声、重叠说话、打断、多语言、成本、GPU 利用率、崩溃恢复和容量测试。

选择 HF 的理由是自托管、可替换和可优化潜力，而不是未经测试宣称它一定比 LiveKit Agents、Active Call 或托管 Realtime 更快、更准。比较必须使用相同音频集、语言、硬件、网络、turn 定义、首个稳定 partial、首个可听音频、质量护栏和总成本。

预期降延迟来自 OPC 对整条链的工程控制，而不是仓库名称：

- RTP/WebRTC frame 到 SpeechRuntime 使用有界、时间戳一致的流式接口；
- VAD、streaming STT、LLM 和 streaming TTS 尽量同区/同资源池，减少跨供应商网络跳；
- 对尚未 committed 的 STT partial 只允许可取消的 speculative reasoning，不执行工具、不直接对外输出；
- 稳定语义片段到达后尽早生成可中断 TTS，barge-in 立即提升 generation 并 fence 旧音频；
- 使用 warm session、模型预热、显存 admission 和分级降载，不靠过量排队；
- 每一段记录 VAD endpoint、STT partial/final、LLM first token、TTS first frame 和客户端 playout；
- 同时保留托管 Realtime 路线；在自然度/延迟明显更优且合规可接受时不强制 HF。

VAD 独立 Gate：

- 中文、英文、口音、长停顿、数字/序列号和代码混合；
- 安静、风噪、工厂噪声、键盘、免提回声和 packet loss；
- 双讲、插话、短应答、假启动和远端串音；
- false activation、missed speech、endpointer latency、barge-in success 和截断率；
- 30 分钟、2 小时、8 小时漂移与资源泄漏；
- 默认 VAD、候选替换和 endpoint AEC 条件下同源比较。

VAD 未过 Gate 时，HF SpeechRuntime 仍可保留而替换 VAD；不能因担心默认 VAD 而推翻整个模块边界，也不能因采用 HF 而忽略 VAD 风险。

### 10.3 Agent 框架

Pi、Nanobot、LiveKit Agents、Active Call 或其他框架只允许作为 Adapter：

```text
AgentExecution
├── InteractiveKernelAdapter
├── RealtimeChannelAdapter
├── SpecialistExecutorAdapter
└── LongGoalStepAdapter
```

永久规则：

- 长任务属于 Resolution Task 和 Durable Workflow；
- 框架只执行有界 AgentRun；
- 模型和工具通过 OPC Gateway；
- 框架本地 memory 不成为企业记忆；
- 框架 cron、channel 和 queue 不成为平台 Authority；
- 不允许直接取得 RustPBX、LiveKit、数据库或第三方系统的管理凭据。

框架可以全部被替换，而不改变产品业务对象。

迁移不得按仓库整体替换。每个框架先建立 capability inventory：

```text
capability
current_owner
target_owner
same_function_as_HF_speech_loop
retain / adapt / replace / retire
parity_test
rollback
```

只有 `same_function_as_HF_speech_loop=true` 的 VAD/STT/LLM/TTS 实时循环进入 HF 替换范围。LiveKit Agents 的 worker/participant/channel/plugin/telemetry 等非重叠能力、Active Call 的非重叠产品流程，以及 Pi/Nanobot 的 specialist execution，必须在新的目标模块中保留或明确迁移；没有 parity test 不得删除。

### 10.4 Agent 角色

同一底座提供不同角色，但角色使用独立策略和权限：

| 角色 | 主要职责 | 默认自治级别 |
| --- | --- | --- |
| Customer Agent | 分诊、答疑、低风险自助和收集证据 | 受限自治 |
| Copilot | 给人工建议、知识、检查清单和动作提案 | 默认只提议 |
| Resolution Agent | 执行跨系统、跨时间的任务步骤 | 按动作风险授权 |
| Supervisor Agent | 质量、风险、卡点和升级建议 | 不直接接管客户输出 |
| Knowledge Agent | 形成 PlaybookCandidate 和知识缺口 | 必须审核后发布 |

不得创建一个拥有所有工具、所有客户和所有通信控制的超级 Agent。

Translation 是 `SpeechRuntime + MediaCapability`，不是业务 Agent。它可以使用术语表、说话人和上下文，但不掌握 Resolution、Action 或客户输出 Authority。

### 10.5 RunEnvelope

每次 AgentRun 必须携带：

```text
run_id
tenant_id
resolution_id
task_id
interaction_id
agent_release_digest
context_revision_digest
tool_capability_digest
model_route
deadline
token_budget
cost_budget
fanout_budget
cancel_token
trace_context
data_region
consent_scope
```

允许输出：

- ResponseProposal；
- ActionProposal；
- HandoffProposal；
- EvidenceProposal；
- MemoryProposal；
- TaskDecompositionProposal。

所有 Proposal 由相应 Authority 验证后生效。

### 10.6 多模态视觉

视觉处理采用分级策略：

1. 边缘或轻量模型做画面质量、敏感区域、运动和事件检测。
2. OCR、条码、物体和界面元素识别按需要运行。
3. 只有关键帧、裁剪区域或短片段进入高成本多模态模型。
4. 每个视觉结论引用原 Evidence。
5. 高风险判断要求人工确认或设备遥测交叉验证。
6. 画面长期保存必须符合单独授权和保留策略。

### 10.7 端云协同

边缘优先：

- VAD、降噪和网络质量估计；
- 只有拥有近端麦克风与远端参考信号的 Endpoint 才执行完整 AEC；
- 无远端参考的网络中间节点最多执行经过验证的 residual echo suppression，不能宣称等价 AEC；
- 敏感区域预处理；
- 视频事件检测和抽帧；
- 可选离线字幕或低能力降级。

中心优先：

- 大模型推理；
- 企业知识和跨会话 Context；
- 工具、审批和 Durable Workflow；
- 多人协作、统一治理和审计。

EdgeInferenceAdapter 隔离 ONNX、Native、WASM、WebNN 和未来硬件差异。

### 10.8 长会话与运行世代

几十分钟到数小时的安装和软件排障不能依赖一个无限增长的模型 Session。

每个实时能力使用有界 `RuntimeGeneration`：

```text
Active
  → Checkpointing
  → Rotating
  → Active(new generation)

任意阶段 → Degraded / Detached / Failed
```

要求：

- 按时间、Token、上下文、GPU 内存和供应商限制轮换；
- Checkpoint 只保存已确认事实、未完成 Task、术语状态、speaker map 和 Evidence 引用；
- 音频 ring buffer 有界，并记录交接覆盖区间；
- 新 generation 获得 OutputLease 后旧 generation 才停止；
- generation fencing 防止重复字幕、重复翻译或双重 TTS；
- 崩溃恢复从最后确认 Checkpoint 继续，不能重放有副作用动作；
- 长通话测试必须覆盖轮换、静音、断网重连、参与者变化、屏幕/视频切换和录音分段。

### 10.9 加密与服务端处理模式

租户和每个 Session 明确选择：

| 模式 | 服务端可处理内容 | 可用能力 |
| --- | --- | --- |
| E2EE_STRICT | 不可访问端到端媒体明文 | 仅端点能力；服务端录音、转写、翻译、视觉 AI 禁用 |
| SERVER_PROCESSING_CONSENTED | 在受控服务端解密和处理 | 录音、转写、翻译、Copilot、视觉能力按 consent |
| TRUSTED_EDGE_PROCESSING | 在客户/边缘信任边界内处理 | 本地模型、录音和过滤；只上传允许的派生物 |

任何服务器端 AI、合成录音或媒体转换都意味着处理边界必须能访问明文；产品不能同时承诺严格 E2EE 和任意服务端 AI。密钥访问、处理目的、区域、RuntimeGeneration 和派生物必须审计。

---

## 11. 人工与 AI 协作

### 11.1 OutputLease 与单一语义输出

“单输出所有者”按具体输出范围执行，不用一个全局锁阻止合法的字幕和翻译：

```text
OutputLeaseKey =
  interaction_id
  + audience
  + channel
  + modality
  + semantic_scope

OutputLease =
  owner
  + generation
  + source_output_ref?
  + expires_at
  + fence_token
```

`semantic_scope` 来自版本化 Scope Registry，不是自由文本。Registry 定义父子关系、互斥矩阵、允许的派生 scope 和优先级；Lease 同时绑定 `audience_membership_generation`。网络分区时只能在短 TTL 内续用本地租约，无法向 Authority 续租就在到期前停止 OPC 生成输出，不能双主。

同一个 LeaseKey 或语义重叠的 scope 同时只能有一个有效 owner：

```text
AI_ACTIVE
HUMAN_ACTIVE
JOINT_ASSIST_HUMAN_OUTPUT
SYSTEM_HOLD
```

示例：

- 人工拥有“客户侧问题答复/语音”时，AI 不得另行回答；
- AI 可以并行生成只给专家看的 Copilot 建议；
- 字幕可以作为人工语音的派生输出，但必须引用 `source_output_ref`；
- 翻译可以面向另一语言 audience 并行输出，但只能忠实转换来源语义，不能夹带新的业务答复；
- 告警和法定披露使用独立、预留的 system semantic_scope。

Copilot 可以并行推理，但任何 OPC 对外输出都必须先获得对应 OutputLease。迟到 generation 的文本、TTS 或 DataStream 消息被 fence 丢弃并计数。

该承诺只覆盖 OPC-generated output。Overlay 中客户 PBX/CCaaS 的人工语音、提示音或外部 Bot 只能进入 `ExternalOutputProjection`，OPC 无法天然 mute/fence。只有 Adapter 的 mute/floor/hold 能力通过 capability test，产品才可承诺跨平台全局单输出；否则：

- 客户音频上的 OPC AI TTS 或同声译音 fail-closed；
- 只允许专家侧 Copilot、明确派生字幕或不冲突的独立 audience；
- UI 必须显示外部输出状态可能陈旧；
- 不用“单输出所有者”掩盖不可控的外部平台。

### 11.2 Handoff Artifact

交接必须包含：

- 客户身份和已验证级别；
- ServiceSubject、Asset、版本和环境；
- 客户目标和当前问题；
- 已验证事实与 Evidence 引用；
- 已尝试步骤及结果；
- 已执行 Action 和 EffectReceipt；
- 未完成 Task、等待对象和 SLA；
- 风险、合规、客户情绪和升级原因；
- 当前通信渠道、语言和可用媒体；
- 建议下一步及其来源；
- 当前输出所有者和接管 generation。

不得依赖自由文本摘要作为唯一交接。

### 11.3 接管与归还

接管流程：

1. 请求接管。
2. 锁定新的 ownership generation。
3. 停止旧所有者新输出。
4. 取消未越过 dispatch/settlement point 的输出或 ActionAttempt；其余保留原 idempotency key 并进入 query/reconcile。
5. 提交新所有者。
6. 通知客户和参与者。
7. reconcile 迟到事件。

新 owner 不得因交接重发 Unknown 副作用。归还流程使用同一合同。

### 11.4 自治等级

| 等级 | 行为 |
| --- | --- |
| A0 | 观察和记录，不输出建议 |
| A1 | 只读建议，人工决定 |
| A2 | 低风险回复和无副作用动作自动执行 |
| A3 | 条件授权动作，超出规则需审批 |
| A4 | 在限定目标、预算和工具内完成多步骤任务 |
| A5 | 不作为常规生产等级；仅隔离研究环境 |

自治等级按 AgentRelease、Task、租户、渠道、客户和工具共同决定，不能只按 Agent 名称配置。

---

## 12. 工具、动作与持久工作流

### 12.1 Tool 接入

内部工具使用版本化机器合同；外部生态可以暴露 MCP Adapter。

MCP 只负责接入，不替代：

- OPC 身份和租户隔离；
- Tool Policy；
- 人工审批；
- 幂等和 fencing；
- EffectReceipt；
- query、reconcile 和 compensation；
- 成本和审计。

### 12.2 风险等级

| 风险 | 示例 | 默认政策 |
| --- | --- | --- |
| R0 | 查询知识、读取公开设备状态 | 自动 |
| R1 | 创建内部草稿、生成报告 | 自动并审计 |
| R2 | 更新非关键工单字段、安排回访 | 条件授权 |
| R3 | 修改设备配置、发起退款、预约派工 | 人工批准或强策略 |
| R4 | 中断生产、固件升级、权限变更 | 双人审批、维护窗口 |
| R5 | 安全关键、不可逆或法规禁止 | 不允许 Agent 自动执行 |

### 12.3 不确定结果

超时不等于失败。对外部系统：

1. 使用稳定 idempotency key。
2. 超时后先 query。
3. 能确定结果时写 EffectReceipt。
4. 不能确定时进入 `Unknown`。
5. 通过 reconcile worker 继续查询。
6. 禁止无条件重复执行。
7. 支持补偿的动作必须记录补偿能力和前置条件。

### 12.4 Durable Workflow

Durable Workflow 负责：

- 跨小时和跨天等待；
- 定时器；
- 人工批准信号；
- 外部回调；
- 重试、恢复和补偿；
- Child Task；
- 观察窗口和主动回访。

不负责：

- RTP/WebRTC 媒体；
- 每个语音 turn；
- 每帧视觉处理；
- 模型 Token 流。

---

## 13. Evidence、Context、Knowledge 与 Memory

### 13.1 Evidence

EvidenceCatalog 区分：

| 类型 | 含义 | 示例 |
| --- | --- | --- |
| Artifact | 被保存、寻址和校验的原始或派生内容 | 音轨、视频片段、截图、日志、遥测文件 |
| Observation | 某主体在某时刻对世界状态的观察 | “设备 LED 为红色”、`service=down` |
| Claim | 人、设备、外部系统或模型提出的可验证陈述 | “配置已经生效” |
| Derivation | 完整记录输入、模型、参数、随机性和输出的审计关系；允许审计性重执行，不保证非确定模型逐字一致 | OCR、ASR、翻译、摘要、视觉检测 |
| Verification | 按版本化政策判断 Claim 是否满足 | 设备自检通过且客户确认 |

每条记录必须包含：

- 来源、采集者、producer type 和 trust class；
- source timestamp、ingest timestamp、monotonic offset、media clock 和不确定区间；
- Resolution、ResolutionItem、Interaction、Session、Stream 和 Asset 关联；
- 内容摘要、对象存储引用、格式和大小；
- digest、签名、chain-of-custody 和完整性状态；
- consent、lawful basis、处理目的和用途限制；
- PII/PHI/secret 分类、数据区域和访问策略；
- retention_until、Legal Hold、删除和导出状态；
- redaction、transformation、parent evidence 和模型/算法版本；
- 访问、纠正、争议和导出审计。

Trust 不是一个永久布尔值。设备遥测、客户陈述、专家观察、外部工单和模型结论各有不同 trust class，VerificationPolicy 决定组合门槛。

删除使用可审计 tombstone：权威索引立即拒绝访问，异步清理对象、副本、向量索引和缓存；Legal Hold 时记录拒绝删除的法律依据。派生物必须沿 lineage 传播删除或重新证明匿名化。

consent 撤回、数据删除、合同/税务留存和 Legal Hold 冲突时，由版本化 RetentionPolicy 记录适用法律基础、优先级、范围和审核人。账单或 Finalized Outcome 只保留最小不可逆证明（claim id、policy/digest、金额、Receipt/Credit 和审计元数据）；除非另有法律基础，不因发票存在而保留整段音视频、转写或图片。

AI 结论必须作为 Claim/Derivation 引用输入 Evidence，不得把模型生成内容伪装为现场事实。

### 13.2 ContextRevision

Agent 每次运行只读取一个不可变 ContextRevision，包括：

- 客户和资产允许范围；
- Resolution 当前状态；
- Evidence 引用；
- 已批准知识；
- 当前 Task；
- 可用工具能力；
- 权限、预算和风险政策；
- 语言、地区和 consent。

后续数据库变化不修改历史 ContextRevision。

### 13.3 企业记忆分类

| 记忆类型 | 示例 | 默认规则 |
| --- | --- | --- |
| Customer Fact | 联系方式、语言偏好 | 来源明确、可更正和删除 |
| Asset Fact | 型号、版本、安装历史 | 绑定资产和时间有效性 |
| Resolution Memory | 已尝试步骤、结果 | 属于 Resolution，不自动永久化 |
| Preference | 希望短信、偏好语言 | 需用途和保留策略 |
| Operational Pattern | 某型号常见故障 | 聚合、去标识并经过验证 |
| Agent Working Memory | 当前推理中间状态 | 短期、不可作为企业事实 |

框架本地 history、Markdown、SQLite 或向量库只是实现，不是 Authority。

### 13.4 Playbook 生命周期

```text
Candidate
  → Redacted
  → ExpertReviewed
  → Evaluated
  → Approved
  → Published
  → Monitored
  → Superseded / Retired
```

每个 PlaybookVersion 必须包含：

- 适用 Asset、版本和环境；
- 前置条件；
- 风险和所需技能；
- 步骤和验证；
- 失败/停止条件；
- Evidence 来源；
- 评测结果；
- 发布、回滚和有效期。

---

## 14. AI Studio、评测与治理

### 14.1 不可变发布物

AgentRelease 至少冻结：

- system behavior；
- Skill 和流程版本；
- 模型路由策略；
- Speech/Vision runtime policy；
- Tool capability；
- Knowledge 和 PlaybookVersion；
- Guardrail 和自治等级；
- Context assembly policy；
- 成本和超时预算；
- 数据区域和合规政策。

在线编辑不能直接改变活动生产版本。

### 14.2 发布状态

```text
Draft
  → Validated
  → Evaluated
  → Shadow
  → Canary
  → Production
  → Retired

任意已发布状态 → RolledBack
```

### 14.3 评测层级

1. **静态合同**：Schema、权限、版本和依赖。
2. **离线场景**：标准问题、噪声、语言、工具和对抗样本。
3. **模拟器**：客户行为、打断、网络和工具故障。
4. **Shadow**：真实流量旁路，不影响客户。
5. **Canary**：小租户、小流程或低风险客户。
6. **生产监控**：Outcome、质量、延迟、成本和安全。
7. **回归与红队**：模型、知识和工具变更触发。

### 14.4 人工与 AI 统一评价

统一评价维度：

- Resolution 结果；
- 正确性和证据来源；
- 安全和合规；
- 客户努力；
- 步骤完整性；
- 升级时机；
- 工具动作成功率；
- 重复问题率；
- 延迟和成本；
- 知识贡献。

不能只比较 AI containment，也不能用 AI 代替人工质量评价的最终治理责任。

---

## 15. 性能、可靠性与容量目标

### 15.1 时间尺度隔离

| 循环 | 典型工作 | 约束 |
| --- | --- | --- |
| Media Loop | RTP、WebRTC 音视频包 | 无数据库、无模型、无通用事件总线 |
| Realtime Perception Loop | VAD、字幕、翻译、视觉事件 | 有界、可取消、可降级 |
| Reasoning/Action Loop | LLM、知识、工具提案 | 预算、超时、权限和 Trace |
| Durable Resolution Loop | 等待、审批、恢复、结果 | 持久、幂等、可 reconcile |

### 15.2 Target NFR Profile v1

以下是目标合同，不是当前证明。每份 Evidence 必须引用冻结的 workload manifest、exact commit、镜像 digest、机器、内核、NIC、网络损伤、codec、加密、通话时长、预热、采样、失败注入和原始结果。

#### 测量场景

| Profile | 流量定义 | 用途 |
| --- | --- | --- |
| `TEL-BASE` | 2-party SIP/PSTN，人类通信，无 AI、无解码 | RTPengine/控制面性能下限 |
| `TEL-FEATURED` | 真实 codec mix，含 SRTP、DTMF、hold/transfer、录音、转码和会议子集 | Native 生产组合 |
| `BRIDGE-AV` | SIP 音频 + WebRTC 音视频/屏幕的 additive/replace 切换 | Bridge 独立验收 |
| `HUMAN-AI-ASSIST` | 人工通话 + PassiveFork 字幕/翻译/Copilot/质量 | Resolve Assist |
| `AI-ENDPOINT` | Voice Agent 是 EndpointProcessor，含打断、工具和转人工 | Autonomous |
| `LONG-RESOLUTION` | 30 分钟、2 小时和 8 小时，会话轮换、重连和跨天 Task | 安装/排障耐久性 |

#### 基础通信目标

| SLI | Target v1 | 边界 |
| --- | --- | --- |
| SIP admission→首个 `100 Trying` | p99 ≤ 100ms | OPC edge 收到完整 INVITE 到发出响应；不含公网 |
| 符合能力合同的建呼成功率 | ≥ 99.99% | 排除主叫取消、无路由、对端拒绝；单独报告所有排除项 |
| OPC 增加的建呼处理延迟 | p95 ≤ 50ms，p99 ≤ 100ms | 不含上游/被叫振铃 |
| 建立后意外中断 | ≤ 1 / 1,000,000 eligible session-minutes | 只计 OPC 因果；按 Cell/版本分解 |
| 无转码 RTP 单向增加延迟 | p99 ≤ 5ms | 同机架测量点，包含 OPC media path |
| OPC 增量丢包/重排 | ≤ 0.01% | 在冻结输入损伤矩阵内 |
| DTMF 正确交付 | ≥ 99.99% | RFC 4733 主路径；INFO/in-band 分开报告 |
| hold/resume/re-INVITE 成功率 | ≥ 99.95% | 合法协商且对端能力满足 |
| blind/attended transfer 成功率 | ≥ 99.95% | 每种 REFER/Replaces 场景独立 |
| Established Human Media good-minute ratio | 99.99% 月度设计目标 | `good established media minutes / all established media minutes`；未建成呼叫只进入建呼成功率 |

#### Durable 与控制面目标

| SLI | Target v1 | 边界 |
| --- | --- | --- |
| 本地 admission journal append | p99 ≤ 10ms | 冻结 NVMe/fsync profile；失败不得假装已持久 |
| Resolution/Action durable command commit | p95 ≤ 100ms，p99 ≤ 250ms | API ingress 到 durable acknowledgment，不含外部工具 |
| Outbox commit→Event 可见 | p95 ≤ 500ms，p99 ≤ 2s | 正常依赖；故障时按 journal backlog 单独报告 |
| Event→关键 Projection freshness | p95 ≤ 1s，p99 ≤ 5s | source revision 已提交到 projection query 可见 |
| Unknown Action reconcile 启动 | p95 ≤ 30s | 超时判定到首次 provider query；业务策略可更快 |

`100 Trying` 不等待远程 Resolution DB：完成语法、边缘身份和最小本地检查后立即发送。是否 answer/originate 仍必须满足签名策略、admission 和 durable journal；超过离线窗口时明确拒绝，不能用快速 `100 Trying` 冒充建呼成功。

#### 视频、切换和记录目标

| SLI | Target v1 | 边界 |
| --- | --- | --- |
| no-app 视频加入 | p95 ≤ 5s | 客户点击有效链接到双向媒体 ready |
| 首个可用视频帧 | p95 ≤ 2s | Participant connected 到远端渲染首个解码帧 |
| additive video 音频中断 | p99 ≤ 50ms | 原 SIP/PSTN 音频应保持；超过即违反 |
| replace audio/video control completion | p95 ≤ 200ms，p99 ≤ 400ms | commit decision 到目标 generation active；允许媒体重叠 |
| active-speech playout gap | p99 ≤ 160ms | 同一 Media Timeline 上最后旧 active-speech playout 到首个新 playout；DTX/expected silence 排除 |
| active-speech 媒体丢失 | p99 ≤ 8 个 20ms audio frames | 单独记录 missing、duplicate、reorder 和 overlap |
| A/V sync | p95 绝对偏差 ≤ 80ms | 端到端渲染测量 |
| 视频冻结次数 | 每个 participant-session 10 分钟窗口 p95 ≤ 1 次 | freeze 定义为连续 ≥500ms 无新可渲染帧 |
| 视频冻结时长占比 | p95 ≤ 1% | 每个 participant-session 窗口；在冻结网络 profile 下 |
| Recording coverage | ≥ 99.99% | 已授权、已 admission 区间；packet/multitrack/composed 分开 |
| 字幕/翻译 coverage | ≥ 99.9% | 已启用可解码语音区间；沉默和未授权区间排除 |

#### AI 与协作目标

| SLI | Target v1 | 精确定义 |
| --- | --- | --- |
| Cascade turn-end→首音 | p50 ≤ 800ms，p95 ≤ 1500ms | VAD committed turn end 到客户端首个可播放 TTS frame |
| Endpointing | p95 ≤ 500ms | 最后有效源语音 sample 到 turn commit；按语言/噪声分别报告 |
| 用户实际等待到首音 | p50 ≤ 1200ms，p95 ≤ 2000ms | 最后有效源语音 sample 到客户端首个可播放 TTS frame |
| 误截断/未完成 turn | ≤1% / ≤0.5% 目标 | 在冻结中英场景集；与 endpointing 延迟共同评估 |
| 首个稳定字幕 partial | p95 ≤ 500ms | 音素开始到随后 1 秒内不被撤回的首个 partial |
| 双向翻译文字延迟 | p95 ≤ 1200ms | source semantic segment commit 到目标文字 committed |
| 双向翻译首音 | p95 ≤ 1800ms | source semantic segment commit 到目标首个可播放 frame |
| Copilot 首个可操作建议 | p95 ≤ 2500ms | Evidence ready 到满足 Schema/来源的首条建议 |
| AI Add-on 可用性 | 99.9% 月度设计目标 | 每项 capability 独立，不与基础通信混算 |
| AI Endpoint 转人工恢复 | p95 ≤ 10s | failure detected 到人工/队列媒体 ready；不保证人工已应答 |

#### 安全不变量与运营 SLI

以下“零容忍”是特定故障矩阵内的设计不变量，不是可以用一句 `0` 代替持续测量：

- 旧 generation 获得资源写权；
- 同一 OutputLeaseKey 存在双 owner；
- 相同 idempotency key 产生重复外部副作用；
- 未 Finalized 的 OutcomeClaim 被结果计费；
- 未授权媒体被录制、转写、翻译或送入模型；
- HumanCommunicationWithOptionalAI 因可选 AI 故障被因果性中断。

生产必须持续记录 invariant violation、被 fence 的迟到写、suppression、reconcile、credit/reversal 和人工修复次数；任何非零均触发事故和发布 Gate。AIEndpointCommunication 的模型故障不计入最后一项，而按其独立转人工/终止 SLI 计算。

每个数字必须在真实网络、真实模型、真实语言和真实长通话下单独证明；未运行保持 `not_run`。

### 15.3 容量证据分组

分别验证：

- SIP 信令；
- 普通 RTP/SRTP；
- WebRTC Room；
- SIP↔WebRTC Bridge；
- G.711/Opus/G.729；
- 转码；
- 录音；
- 实时字幕；
- 双向翻译；
- Voice Agent；
- 视频抽帧和多模态推理；
- 会议和多专家；
- Durable Task；
- Tool Broker；
- 组合业务流。

任何“排除桥、录音、AI 或转码”的压测不能证明相应组合容量。

`VOS-EQ-100K-v1` 是未来通信底座验收目标，不是单节点承诺。以下是 R1 manifest skeleton 的最小数值；执行前生成机器可读 manifest 并冻结 seed、分布和环境：

- 100,000 个同时建立的双向 Session；
- 信令：持续 1,000 CPS 运行 15 分钟，2,000 CPS burst 60 秒；
- 时长分布：50% 为 90–180 秒、40% 为 3–15 分钟、9% 为 15–60 分钟、1% 为 2 小时；
- codec 分布：PCMA/PCMU 60%、`G729/8000` 20%、Opus/G.722 20%；
- SRTP 占 30%，其余 RTP；不得用关闭加密证明 SRTP 容量；
- 15% Session 执行 codec 转换：G729↔PCMA 40%、G711↔Opus 40%、G.722↔Opus 20%；
- 20% Session 录音：packet 10%、decoded multitrack 8%、mixed/composed 2%；
- 5% Session 为 SIP↔WebRTC Bridge，其中 additive video 80%、replace 20%；
- 2% Session 为会议：其中三方 80%、五方 20%；
- 每个 Session 均启用真实 RTCP、计费和最小可观测性；
- 协议扰动包含 BYE/CANCEL race、re-INVITE/hold、REFER、DTMF 和 Session Timer；
- 网络矩阵至少包含 clean profile，以及 RTT 100ms、随机丢包 1%、p95 jitter 50ms、reorder 0.1%、duplicate 0.05% 的 impaired profile；
- 滚动升级每轮最多替换 10% 节点，新呼叫移入新版本，旧呼叫 active-zero drain。

AI、双向翻译、视觉和完整 Bridge 各有独立集群容量证据，再运行 `VOS-EQ-100K-v1 + feature admission` 组合测试，证明附加能力过载时基础通信仍满足 SLI。节点数和硬件只能由实测决定，不允许线性外推。

近线性扩展 Gate：

- N→2N 相同节点时 good-session capacity ≥1.8×，scale-out efficiency ≥90%；
- 最热 shard 与均值偏斜 ≤15%；
- 稳态 CPU/NIC/端口 ≤70%、内存 ≤75%，故障/滚动时仍保留 headroom；
- 扩容后关键 p99 SLI 退化 ≤10%，且不突破 Target；
- 单节点故障后不允许靠超卖、丢弃 RTCP/CDR/安全检查维持数字。

### 15.4 性能工程硬约束

- 热路径拒绝全局锁、全局扫描和无界队列；
- 媒体对象和缓冲区复用；
- 按 Session/MediaEdgeGeneration 分片；
- 控制面和媒体面独立资源池；
- 模型/GPU 和 Rust 通信进程隔离；
- 数据库故障不阻断已建立媒体；
- recording、translation、vision、copilot 分别熔断；
- 过载时优先保留基础通信；
- 所有容量结论记录 exact source、commit、配置、机器和原始结果；
- 100K 并发是后续系统验收目标，不通过线性外推或厂商数据宣称完成。

---

## 16. 可观测性、质量和成本

### 16.1 统一关联键

所有日志、Trace、指标和账单至少能够关联：

```text
tenant_id
resolution_id
interaction_id
communication_session_id
stream_id
media_edge_generation
media_pipeline_generation
runtime_generation
task_id
run_id
action_id
agent_release_digest
context_revision_digest
billing_key
```

### 16.2 分段延迟

语音链必须分开测量：

- 网络输入；
- jitter/VAD；
- STT partial/final；
- LLM 首 Token；
- Tool；
- TTS 首帧；
- 网络输出；
- 用户可感知首音。

只记录一个“总延迟”不足以定位问题。

### 16.3 时钟域与跨媒体时间线

每个节点维护和导出：

```text
wall_clock_utc
monotonic_clock
RTP_audio_timestamp + clock_rate
RTP_video_timestamp + clock_rate
RTCP sender report mapping
WebRTC stats timestamp
model/provider timestamp
source device timestamp
clock_uncertainty
```

跨节点不直接比较裸 monotonic 时间。Media Timeline Service 使用 RTCP、采集事件和定期校准建立显式映射，并保存 offset、drift、uncertainty 和校准版本。A/V sync、字幕对齐、翻译延迟、录音 coverage 和 Evidence 顺序必须引用该映射；不确定区间过大时结果标记 `uncertain`，不能伪造精确顺序。

### 16.4 质量指标

- ASR WER/CER 和关键实体错误；
- 翻译术语、语义和数字准确率；
- VAD 漏检、误检和打断；
- 音频 MOS/丢包/抖动；
- 视频冻结、分辨率和关键帧；
- 视觉识别精度和无法判断率；
- Tool 成功、Unknown 和 reconcile；
- 知识引用正确性；
- Handoff 完整性；
- Outcome 验证和复发率。

可用性必须分别报告：

- Control Plane Availability；
- Human Communication Availability；
- Media Quality Availability；
- Feature/AI Capability Availability；
- Durable Resolution Availability；
- 外部依赖导致的不可用和 OPC 因果不可用。

不得用控制 API 正常代替媒体可用，也不得用基础通话正常掩盖翻译或录音缺口。

### 16.5 单位经济性

内部按 Resolution 记录：

- 通信分钟；
- 转码和录音；
- STT、TTS、翻译；
- LLM Token 和 Realtime audio Token；
- GPU 时间和利用率；
- 工具调用和外部费用；
- 人工工时；
- 派工和配件；
- 收入、退款和 Outcome 奖励。

模型路由应优化“每个 Verified Resolution 的总成本”，不是单独优化 Token 单价。

---

## 17. 安全、隐私和合规

### 17.1 基本原则

- Zero Trust Edge-to-Core；
- Tenant、Region 和 Environment 隔离；
- 最小权限和短期凭据；
- Secret 不进入 Prompt、日志和客户端；
- 数据最小化；
- 明确 consent 和 AI disclosure；
- 全量管理动作审计；
- 默认拒绝未知能力；
- 供应链来源和签名可追溯。

Edge-to-Core 机器合同：

- 服务使用短期工作负载身份和 mTLS，证书绑定 environment、region、cell 和 service role；
- 每个 Command 附 tenant、authority、generation、deadline、nonce/idempotency key 和签名上下文；
- 接收方重新执行授权，不能信任边缘传入的 role 字符串；
- 重放窗口、时钟偏差和吊销状态可配置并可观测；
- 生产不存在“鉴权失败后自动退回明文/无 mTLS”的通用兼容路径；
- LiveKit token 短期、tenant/room/participant/permission scoped，并绑定 Bridge generation；
- 外部 webhook 验证签名、event id、source revision 和 provider account，乱序后 query/reconcile；
- 密钥由 KMS/HSM 或客户边界管理，服务只持有最小用途 lease，不把密钥放入日志、Prompt 或 Evidence。

### 17.2 多媒体授权

以下授权分别处理：

- 电话录音；
- 视频录制；
- 屏幕共享；
- 远程控制；
- 转写；
- 翻译；
- AI 分析；
- 模型训练或改进；
- 跨区域处理；
- 长期知识使用。

同意录音不自动意味着同意模型训练。

Consent 使用有版本、范围和到期时间的 `ConsentLease`，绑定 participant、purpose、stream/edge generation、region 和 processor。新增参与者、切换媒体、改变用途或跨区处理需要重新评估，不能继承模糊的 Session 级布尔值。

中途撤回时：

1. Authority 提升 consent generation 并停止发放新处理 lease。
2. 对应 PassiveFork/InlineTransform/Recorder 在有界时间内 detach 或关闭分段。
3. 迟到的旧 generation 输出、上传和模型结果被 fence。
4. 清理队列、临时缓冲和未提交派生物。
5. 按保留/法律政策删除或 tombstone 已存数据；Legal Hold 冲突需向用户明确。
6. Human Communication 是否继续按租户策略决定；相关 AI/录音能力默认 fail-closed。
7. 记录撤回传播时间、漏处理区间和 reconcile 结果。

### 17.3 AI 与工具安全

- Prompt guardrail 不能代替身份、授权和审批；
- MCP Authorization 不能代替业务 Tool Policy；
- 外部 Agent 通过 A2A 接入时只能看见明确委派的任务和数据；
- 模型输出视为不可信输入；
- 高风险动作需独立政策判断；
- 敏感工具默认不可见，而不是可见后提示模型别用；
- 工具响应经过 Schema、来源和敏感字段处理；
- 对抗输入和 Prompt Injection 进入发布评测。

### 17.4 数据生命周期

每类数据定义：

- 收集目的；
- 数据控制者和处理者；
- 存储区域；
- 加密和密钥；
- 保留期；
- 删除和导出；
- Legal Hold；
- 训练用途；
- 派生数据关系；
- 审计。

---

## 18. 部署与商业交付模式

### 18.1 Overlay SaaS

适合最快进入客户：

- OPC 托管 Resolution、AI 和管理能力；
- 通过 SIP/BYOC、Webhook、SDK 与现有系统连接；
- 客户无需整体迁移 CCaaS；
- 可先启用 Copilot 和视频升级。

### 18.2 Dedicated VPC

适合中大型和受监管客户：

- 单客户网络和计算边界；
- 客户或 OPC 管理密钥；
- 区域数据驻留；
- 专属容量和升级窗口；
- 可连接客户私有模型和系统。

### 18.3 On-prem / Sovereign

适合严格数据主权、工业网络和运营商：

- 控制面、媒体面和模型可本地化；
- 离线/受限网络运行；
- 明确升级包、签名和支持周期；
- Telemetry 可选择只输出聚合指标。

标准化交付前置条件：至少 2 个签约客户需要相同部署模型，或 1 个战略合同完整覆盖产品化、18 个月维护和测试成本。每个版本必须提供：

- 支持的 Kubernetes/OS/CPU/GPU/DB/Object Store 矩阵；
- 最低容量、备份、恢复和离线许可要求；
- 签名 SBOM、镜像/模型 digest 和供应链证明；
- 最低健康、审计和聚合 Telemetry；
- 标准升级窗口、回滚和最长支持版本；
- 配置漂移检测和禁止客户专属长期 Fork；
- RTO/RPO、恢复演练和支持责任边界。

### 18.4 Edge Node

用于：

- 本地媒体终止；
- VAD、降噪和网络质量估计；
- 在拥有近端输入和远端参考的 Endpoint 执行 AEC；
- 敏感画面预处理；
- 低带宽和断网降级；
- 设备协议适配。

Edge Node 不成为企业 Task、Knowledge 或 Billing Authority。

### 18.5 滚动升级

- 新呼叫进入新版本 Cell；
- 老呼叫在旧 Cell drain；
- active-zero 后删除旧版本；
- 数据 Schema 使用 `expand → dual-read/write（必要时）→ backfill → verify → contract`；
- Event/API Schema 先增加可忽略字段，消费者兼容后再切 producer，最后删除旧字段；
- 每个 aggregate/event 携带 schema/contract version，未知必需字段 fail-closed；
- backfill 有界、可暂停、幂等且不与媒体热路径争抢资源；
- rollback 前验证旧版本仍能读取新写入数据；
- AgentRelease 与平台版本兼容性显式记录；
- 活动会话不可因控制面升级被强制终止。

---

## 19. 产品包装与收费

### 19.1 首个可销售 Offer

首个 12 个月只销售一个外部 Offer：

> **OPC Resolve Assist — 海外设备安装与售后远程解决**

包含：

- Overlay 接入现有服务号码和工单；
- 电话内发送免 App 安全视频链接；
- 专家工作台、客户视频和结构化步骤；
- Evidence、人工验证、服务报告和 OutcomeClaim；
- 必验 Milestone B1：中英双向字幕/文字翻译；
- B1 通过后才可选增加来源化 Copilot 和限定 OCR；
- 基础质量、用量和业务结果仪表盘。

以下是内部能力层或未来 Option，不在首日形成四个并列 SKU：

| 名称 | 当前定位 | 对外开放条件 |
| --- | --- | --- |
| Resolve Autonomous capabilities | Assist 上的受控能力包 | 人工主流程可复制，低风险动作通过安全/ROI Gate |
| Native Communications | 部署选项和性能/私有化能力 | 至少 2 个已签客户明确要求，且 Overlay 无法满足 |
| Resolve Platform/OEM | 未来分销模式 | 稳定 API 被外部伙伴采用，核心流程没有被平台化稀释 |
| ViLTE/NG-RTC | 远期电信 Option | 运营商/设备商合同、目标 Profile 和实验网到位 |

### 19.2 固定范围付费 Pilot

首个标准合同假设：

| 项目 | 固定范围 |
| --- | --- |
| 价格 | USD 20,000，验证期价格；税费、线路和超额第三方用量另计 |
| 付款 | 50% 签约、25% Milestone A 验收、25% Milestone B1 验收 |
| 周期 | 12 周：2 周接入、8 周运行、2 周结果复盘 |
| 客户范围 | 1 个业务团队、1 个产品族、1 个相同主流程 |
| 语言 | 中文↔英文双向字幕/文字翻译；不包含译音 TTS 回注 |
| 接入 | 1 个 provider-specific 外部电话 Adapter、1 个 CRM/FSM Connector |
| 用户 | 不超过 20 名 named experts |
| 样本 | 最多 300 个 agreed eligible items；最小样本按基线波动、预期改善和统计功效在签约前计算 |
| 交付 | Milestone A：电话关联→免 App 视频→Evidence→人工 Outcome→CRM；Milestone B1：中英字幕/文字翻译 |
| 实施 | OPC 最多 20 person-days；客户按期提供线路、API、测试用户和基线 |
| 培训/支持 | 2 次远程管理员/专家培训、1 份运行手册、约定工作时区的 business-hours 支持；24×7 另购 |
| 转正抵扣 | Pilot 完成后 30 天内签年约，50% Pilot 费抵首年平台费 |

不包含：

- 客户专属媒体协议或自建 PBX；
- 高风险自主工具；
- 通用视觉模型训练；
- 远程桌面控制；
- 多 CRM/FSM；
- 多产品族、多语言或跨国定制合规；
- ViLTE、OEM 或通用 AI Studio。

客户要求新增范围时使用书面 change order，不能用“Pilot 灵活”吞掉产品边界。

Milestone A 先独立验收通信、Authority、Evidence 和 Outcome 主链。B1 是完成首个 JTBD 和整个 Pilot 的必验项，不是赠送 Optional：

- 双声道说话人归属和 coverage；
- 设备术语、命令、否定、单位、数字和序列号；
- 中文/英文口音、现场噪声、双讲、长停顿和丢包；
- §15 的稳定 partial/翻译延迟；
- 低置信提示、原文可见和人工回退；
- controlled set 中不得出现未标记的关键数字/序列号篡改；
- 不向外部电话回注 translated TTS。

B1 未通过则 Pilot 不算完成，不进入年约转换；Copilot 和 OCR 仍是后续可选 Gate。

### 19.3 转正式合同的收费模型

正式 Assist 采用一个可解释模型：

```text
年度平台订阅（按 named-expert tier）
+ 通信、录音、AI 和翻译的透明实际用量
+ Dedicated VPC / On-prem 支持（如选择）
+ 通过成熟 Gate 后的可选 Finalized Outcome 奖励
```

验证假设（受 §3.5 价值池公式约束）：

- Assist 目标订阅 ACV：USD 60k–150k；低价值池客户必须降低范围/价格或 no-bid；
- Dedicated/On-prem：USD 150k+ 年平台与支持，实施另计；
- 标准一次性 onboarding：USD 20k、最多 20 person-days；由 Pilot 转正且范围不变时不重复收取，Pilot 抵扣按合同执行；
- named-expert tier 先使用 `≤25 / ≤100 / ≤250 / enterprise`；
- 套餐包含明确月度用量，超额单价和供应商成本传导写入 Order Form；
- 不按一个“AI 分钟”掩盖电话、视频、GPU、模型和翻译成本。

最终价目必须由 20 次买家访谈、3 个付费 Pilot、赢单/丢单和真实成本校准；这些数字不是当前市场证明。

### 19.4 单位经济与交付 Gate

正式扩张前目标：

- 3 个设计伙伴运行同一个主流程；
- 核心产品/Connector/Playbook 复用率不低于 80%；
- 客户专属代码与流程不超过交付工作量 20%；
- 标准 Pilot OPC 实施不超过 20 person-days；
- 至少 2/3 完成的 Pilot 转成年约；
- 至少 70% 的 eligible items 按 Pilot 流程提供能力，且每周至少 60% 的 assigned experts 有有效使用；客户阻塞和系统不可用分别归因；
- 稳态订阅与用量综合毛利不低于 70%；
- Founder-led 销售阶段估算 CAC payback 小于 12 个月；
- CAC 必须计入 founder 销售时间、售前方案、安全/法务审查、免费集成和差旅；
- 每个客户的支持、GPU、线路和第三方模型成本可归因到 Resolution。

贡献毛利：

```text
订阅 + 用量 + 实施摊销 + Finalized Outcome 奖励
- 线路/SFU/模型/GPU/存储
- 客户专属运行与支持
- 退款/Credit/Reversal
```

任何规模增长如果依赖持续定制、毛利低于 Gate 或不能在第二客户复用，应暂停扩张而不是继续包装新功能。

### 19.5 Verified Outcome 计费

Pilot 默认使用人工确认 Outcome，不立即采用纯 Outcome pricing。未来 Outcome 奖励只有在以下条件满足时才能计费：

- 双方预先签署 eligible item、基线、价值、币种、窗口和 VerificationPolicyVersion；
- Evidence 达到政策阈值；
- OutcomeClaim 进入 `Finalized`；
- 观察窗口内没有被判定为同一问题复发；
- 人工、AI、派工和第三方贡献可以解释；
- 唯一 billing key 尚未计费；
- 客户可以查询、争议和申诉。

Finalized Claim 保持不变；争议成立或复发时创建 OutcomeReversal 和不可变 Credit/Reversal，不得覆盖历史记录。

---

## 20. Go-to-Market

### 20.1 首发市场与渠道

首发对象：

> 中国总部、向英语市场出口设备、已有远程专家和海外安装/售后成本的制造商。

资格条件：

- 有可识别的设备/站点/订单；
- 每月存在足够 eligible items；
- 远程专家稀缺或跨语言；
- 视频能改变诊断/安装结果；
- 派工、停机、退换或重复报修价值显著；
- 有可接入的服务号码和 CRM/FSM；
- Budget Owner 愿意签署基线和结果口径。

首年采用 founder-led direct sales。首个参考集成包是“一个支持权威 call event + 双声道 receive-only media fork 的 provider-specific PBX/CCaaS Adapter + Salesforce Service Cloud”；具体电话 Provider 在 3 个设计伙伴收敛后、编码前冻结。若至少 2 个伙伴共同使用另一 CRM/FSM，可在编码前一次性替换 Salesforce Connector，但不能并行做三套，也不以 `generic SIP/BYOC` 模糊不同平台能力。

落地从一个产品族、一个团队、一个中文↔英文流程开始，再扩展产品线、地区、语言和伙伴。营销语言使用“减少海外派工和停机、让专家远程解决更多安装问题”，不先销售抽象的“Resolution 平台”。

### 20.2 商业发现与转化 Gate

顺序：

1. 完成至少 20 次 Budget Owner/Champion 访谈。
2. 取得 3 家对同一主流程的书面付费意向或 Pilot 合同。
3. 对三家使用同一 Pilot Scope、指标和演示。
4. 第一阶段只完成电话→视频→Evidence→人工验证。
5. 核心链路通过后完成必验 B1 中英字幕/文字翻译；B2 来源化 Copilot、B3 OCR 再逐项启用。
6. 至少 2/3 Pilot 转年约后扩展第二个流程。
7. 用复用率、实施天数、毛利和 ROI 决定是否扩大团队和渠道。

三家设计伙伴不是三套需求清单。任何单客户功能必须证明能进入 80% 公共产品层，否则作为付费集成或拒绝。

### 20.3 首发演示与证据边界

Pilot A 的真实演示只展示已经通过 Gate 的主链：

1. 客户拨打现有服务号码。
2. 外部 Call 被绑定到稳定 Interaction/ResolutionExecution。
3. 专家发送一次性、免 App 的视频链接。
4. 客户授权后加入视频，原电话音频保持。
5. 专家查看现场并记录结构化 Evidence。
6. 结果由预先指定人员按 VerificationPolicy 人工确认。
7. 外部 CRM/FSM 获得 Receipt，并生成服务报告和 OutcomeClaim。
8. OPC/外部故障时按合同继续、降级或 reconcile。

B1 中英字幕/文字翻译通过资格测试后，完整 Pilot 演示必须包含它；B2 Copilot 和 B3 OCR 只有各自过 Gate 才加入。自主工具、通用视觉 AI、远程控制和 Playbook 自动发布不得以概念动画冒充当前产品。

未来 ViLTE、AI Endpoint 和平台化可以单独标记为 `future concept`；销售材料必须区分 `available / pilot / planned / option / not_run`。

只展示聊天、Prompt、合成语音或后台图表不足以证明产品价值。

### 20.4 竞争选择与 No-bid

| 客户主要需求 | OPC 应对 | Win 条件 | No-bid / Partner 条件 |
| --- | --- | --- | --- |
| 继续使用微信/WhatsApp/Teams/邮件和人工翻译 | 量化派工、返工、语言等待和证据缺失后再比较 | 现状成本可验证且超过商业门槛 | 免费工具已满足、客户不提供基线或价值池不足时不投 |
| 替换完整呼叫中心、WFM/QM | Overlay 到现有 CCaaS | 客户接受保留现有系统 | 只要传统 CCaaS 表格能力时不投 |
| 单纯视频远程支持 | 强调电话连续性、Evidence、Outcome 和 AI 演进 | 派工/停机价值可测 | 只要便宜视频链接时交给伙伴 |
| 低价 Voice Bot | 展示技术 Resolution 和人工协作 | 复杂高价值问题、需专家/视觉 | 只按分钟比价且无 Resolution 价值时不投 |
| CRM/FSM 工单管理 | 做深 Connector，不替换 Authority | 需要实时协作和证据补强 | 只要工单/派工管理时与实施商合作 |
| 私有化通信底座 | Native deployment option | 至少 2 个签约客户、有性能/主权收益 | 单客户专属 PBX Fork 不做 |
| ViLTE/运营商 NG-RTC | 保留合规网关路线 | 运营商合同、Profile 和实验网 | 没有网络方/终端方配合不启动 |

OPC 的核心 Win 主题是“在不推翻现有系统的前提下，提高跨语言设备问题的远程解决率，并留下可验证证据”，不是功能列表更长。

### 20.5 销售异议

| 异议 | 产品回答 |
| --- | --- |
| 会不会影响现有电话 | Overlay、PassiveFork/有界能力；人与人通话中可选 AI 故障不应因果性中断媒体 |
| 已经有 Zoom/Genesys | 不要求替换；补上技术 Resolution、视觉证据和跨天执行 |
| AI 会不会乱操作 | Tool Policy、审批、Receipt、Unknown reconcile |
| 为什么不买 SightCall | OPC 销售完整 Resolution Loop，而非单独视频工具 |
| 数据能否不出客户环境 | Dedicated VPC、On-prem、自托管 Speech/Model |
| 如何证明省钱 | 试点前基线、Verified Outcome、派工和停机证据 |
| 模型过时怎么办 | Speech/Model/Agent Adapter 和版本化发布 |

### 20.6 伙伴策略

首年只发展一种实施伙伴：

- 服务中国出口制造商的 Salesforce Service Cloud 实施伙伴，能够共同完成数据、流程和客户培训，但不能拥有 OPC 产品 Fork。

PBX/CCaaS Provider、运营商、LiveKit/SFU、远程桌面、本地模型/GPU 和行业认证方只是技术/供应候选，不同时建设渠道计划。OPC 不在早期自行建立全球线路销售和所有行业实施团队。

### 20.7 扩张顺序

```text
同一客户：一个流程 → 同产品族更多问题 → 更多产品线
同一能力：中文↔英文 → 其他语言 → 更多区域
同一交付：Founder-led → 标准实施包 → 认证伙伴
同一产品：Assist → 受控 Action → AI Endpoint → Native/Private
```

每次扩张必须保留主流程指标、非劣效护栏和公共产品复用率。不能用新增收入掩盖重复报修、客户安全或交付毛利下降。

---

## 21. Build / Absorb / Buy / Partner

### 21.1 必须自研

- Resolution、Task、Outcome 权威；
- CommunicationSession 与渠道切换合同；
- 人机 ownership 和 Handoff Artifact；
- Evidence、VerificationPolicy 和 Outcome 归因；
- Action Ledger、Receipt、query/reconcile；
- ContextRevision、Playbook 和 Release 治理；
- 模型/语音/Agent 路由与成本计量；
- 行业 Resolution Graph；
- Overlay 与 Native 的统一产品合同。

### 21.2 可吸收和改造

- RustPBX/rvoip 的低层 SIP/RTP 能力；
- Hugging Face speech-to-speech；
- LiveKit Agents；
- Pi、Nanobot 或其他 Agent kernel；
- 现有 codec、jitter、mixer、recorder；
- 开源评测和可观测性模块。

吸收前必须完成：

- exact source；
- License 和 notices；
- 维护活跃度；
- 安全和供应链；
- SBOM、签名、构建可复现性和依赖锁定；
- cryptographic key 的所有权、短期 lease、内存暴露和 zeroization 边界；
- Rust `unsafe`、C/FFI、native codec 的隔离清单；
- parser/codec fuzz、sanitizer/Miri（适用部分）、已知向量和恶意输入测试；
- panic、OOM、CPU runaway、descriptor/port 泄漏和 worker restart 故障注入；
- 热路径性能；
- API 变化和退出成本；
- 与 OPC Authority 的冲突审查。

吸收不是复制目录。每项能力必须记录 `keep / wrap / rewrite / reject`、理由、基准、替换路径和删除旧实现的 active-zero Gate。

### 21.3 采购或合作

- 全球号码、线路和运营商；
- SFU 和视频 codec；
- 基础模型和部分语音模型；
- 通用 CRM/FSM/WFM；
- 远程桌面协议；
- GPU 基础设施；
- 认证、审计和本地实施。

### 21.4 明确不做

- 自建完整 IMS/5G Core；
- 训练通用基础模型；
- 首轮自研视频 codec/SFU；
- 首轮复制完整 Genesys WFM/QM；
- 同时维护多套业务 Authority；
- 以开源项目数量作为产品能力指标。

---

## 22. 演化路线

时间只是资源规划假设；只有 Gate 通过才进入下一阶段，不能因日历到期自动扩大范围。

### 22.1 0–3 个月：市场资格与权威合同

目标：

- 冻结一个 ICP、一个 JTBD、一个 ResolutionItem 和 OutcomeClaim 口径；
- 完成至少 20 次 Budget Owner/Champion 访谈；
- 获得 3 家针对同一主流程的付费意向或合同；
- 冻结 Native/Overlay Authority、RealtimeStream、Action、Evidence 和 OutputLease 机器合同；
- 建立 Security/Identity/Event/Audit 基线和 Fault Matrix；
- 建立旧代码 Gap、资格测试和删除计划；
- 冻结标准 Pilot 合同、参考 SIP Adapter 和唯一 CRM/FSM Connector。

Gate：

- 3 家客户的问题、买家、预算、数据和 ROI 基线真实存在；
- 三家愿意测试同一个主流程，而不是三个定制项目；
- 至少 1 家签署 USD 20k Pilot，另外 2 家有有时限的书面付费承诺；
- 威胁、故障、数据、容量和 Authority 设计通过独立审查；
- 未证明能力保持 `not_run`，没有借用开源或供应商 benchmark。

### 22.2 3–6 个月：Tracer Pilot

阶段 A 只实现最小可售主链：

```text
Tenant / Identity / Consent / Audit
  → 一个真实外部电话 Adapter
  → ExternalSessionProjection + ResolutionExecution
  → 电话保持 + 免 App additive video
  → 专家工作台 + Evidence
  → 一个 CRM/FSM Receipt
  → 人工 OutcomeClaim verification
```

阶段 A 同时交付基础质量、成本、故障降级和 reconcile 证据。它不依赖 Speech、LLM、Vision 或自主工具完成业务主链。

阶段 B 按顺序、独立 Gate 增加：

1. **B1（Pilot 必验）**：基于双声道 receive-only fork 的中文↔英文字幕和文字翻译；
2. **B2（Optional）**：有来源 Copilot；
3. **B3（Optional）**：针对已冻结设备画面的 OCR。

不进入：自主工具、通用视觉、远程控制、AI Studio、多 Agent 市场、Native PBX、ViLTE 和跨天自动编排。

Gate：

- 外部 Authority、视频升级、Evidence、CRM Receipt 和人工 Outcome 全链真实运行；
- Human Communication 在 AI、DB、Event、Object Store、PKI/KMS、DNS、配置和时钟故障矩阵下行为符合合同；
- 短通话、30 分钟、2 小时和 8 小时测试完成；8 小时覆盖浏览器前后台、移动省电、Wi‑Fi/蜂窝切换、token 续期和录制分段；
- consent、驻留、清理、Recording coverage 和降级可审计；
- 第一个客户的 eligible items 可与基线比较；
- 每增加一项阶段 B 能力都证明非劣效、延迟、质量、成本和旁路。

### 22.3 6–12 个月：正式产品 V1

范围：

- 多租户 Overlay SaaS；
- 三家设计伙伴的同一主流程；
- 稳定的 provider-specific 外部电话 Adapter 和参考 CRM/FSM Connector；
- 电话→视频、Evidence、人工验证、结构化 Handoff、运营和计费；
- 必验 B1 中英字幕/文字翻译；
- B2 Copilot、B3 OCR 分别只有在通过质量 Gate、改善主指标且至少 2 家转正客户购买时才进入 V1；
- 仅为已毕业 AI capability 提供最小 AgentRelease/Eval/Policy、Shadow/Canary/rollback；
- 首个设备族 Playbook 只在 B2 被购买后进入；

Gate：

- 3 个付费 Pilot，至少 2 个转年约；
- 至少两个可公开或可审计 ROI 案例；
- 公共产品复用率 ≥80%，客户专属工作 ≤20%；
- 标准实施 ≤20 person-days，稳态毛利模型 ≥70%；
- 主指标改善且安全、CSAT、复发和升级率非劣效；
- 真实长短通话、媒体、翻译和故障测试完成；
- 第二个流程只有在以上 Gate 通过后才能进入。

### 22.4 12–24 个月：受控自主与私有化

候选范围：

- 低风险 Action 和 Customer Voice/Video Endpoint；
- 完整 Receipt/reconcile/compensation；
- Agent/human 统一路由；
- Dedicated VPC；有合同再做 On-prem/Sovereign；
- 自托管 HF SpeechRuntime 和托管 Realtime 双路线；
- Edge inference；
- 更多 CRM/FSM/设备平台；
- Native Communications deployment option；
- OEM 白标只做单个验证伙伴。

Gate：

- 自主动作安全和结果优于人工基线或达到客户阈值；
- Dedicated/On-prem 可升级、可回滚、可支持；
- 模型和框架可替换性有真实演练；
- AI 成本和 Outcome 收入可持续；
- Native 只有在至少 2 个已签客户明确需要性能、主权或成本收益时启动；
- 每个新 Connector 有复用客户或伙伴共同承担。

### 22.5 24–36 个月：条件式电信视频与平台化

这些是独立商业 Option，不是自动路线：

- ViLTE IMS Control Adapter 和 AV Media Gateway；
- 5G New Calling IMS Data Channel Gateway/DCS；
- 通话内表单、位置、屏幕和 mini-app；
- 运营商合作；
- 行业 SDK 和伙伴市场；
- 跨企业 A2A Agent 协作；
- 选择性 Native Communications 能力，不复制完整 CCaaS。

Gate：

- 有已签运营商或大型设备商需求；
- 目标 3GPP Release、GSMA Profile、终端和网络矩阵冻结；
- IMS/ViLTE 合规、互通、容量和故障实验完成；
- 平台 API 已被外部伙伴稳定使用；
- 不因平台化削弱核心 Resolution 产品。

### 22.6 36–60 个月：未冻结 Horizon Options

以下只保留观察和 Adapter 位置，不冻结产品承诺：

- 多企业 Agent 联邦；
- 智能眼镜和沉浸式远程专家；
- 端侧个性化和隐私推理；
- MoQ 等新媒体 Adapter；
- 行业 Agent、Tool、Knowledge Marketplace；
- 跨产品、跨组织的授权 Resolution 协作。

任何 Option 进入产品路线都必须重新完成市场、Authority、安全、经济性和能力资格审查。所有能力仍遵守单 Authority、可验证动作和客户授权。

---

## 23. 工作流分解

本文是总纲，开发前必须拆成独立规格：

| 工作流 | 独立规格内容 |
| --- | --- |
| W0 Product & Domain | Persona、JTBD、Resolution、Outcome、术语和用户旅程 |
| W1 Communication Fabric | Overlay、SIP、RTP、WebRTC、switch、codec、drain、capacity |
| W2 Resolution Core | 状态机、Task、Evidence、Outcome、API、数据和恢复 |
| W3 Realtime Intelligence | Speech、HF、Realtime、VAD、翻译、Vision、旁路 |
| W4 Human/AI Collaboration | Routing、ownership、handoff、workspace、supervisor |
| W5a Minimal Connector Effect | 一个 CRM/FSM 的 ActionIntent、Authorization、Attempt、Receipt、query/reconcile |
| W5 Action & Workflow | Tool Policy、审批、Receipt、reconcile、Durable Workflow |
| W6 Context & Knowledge | ContextRevision、Memory、Playbook、retention、search |
| W7 Studio & Governance | Release、Eval、Shadow、Canary、rollback、red-team |
| W8 Platform Foundation | Identity、tenant、consent、security、event、audit、billing、observability、deployment、DR |
| W9 Future Telecom | ViLTE、IMS AV Gateway、Data Channel、运营商互通 |
| W10 Commercialization | Pilot、包装、价格、ROI、伙伴和交付方法 |

依赖 DAG：

```text
W0 Product/Domain + W10 Commercialization
  → Pilot contract / acceptance / stop gate

W0 + W8 Platform Foundation
  ├─→ W1 Communication Fabric
  └─→ W2 Resolution Core

W2 + W8 → W5a Minimal Connector Effect
W1 + W2 + W4 + W5a → Tracer Pilot A

W3 Realtime Intelligence → Pilot B1 Translation
W3 + W6 + W7-min → Pilot B2 Copilot
W3 + W2 Evidence → Pilot B3 OCR

W5a + customer demand → W5 Full Action & Workflow
W3 + W5 + W6 + W8 → W7 Full Studio & Governance

W1 production evidence + 2 signed Native customers ─→ Native Communications
W1 + W8 + operator contract/profile/lab ─→ W9 Future Telecom
```

约束：

- W8 不是最后的运维收尾，而是 W1/W2 开始前的身份、事件、安全、审计和观测基础；
- W10 与 W0 同时开始并有权停止无买家证据的工程；W0/W8 是 W1/W2 前置；
- W3 只能附着在已经可用、可旁路、可计量的通信和 Resolution 主链；
- Pilot A 的 CRM/FSM 写入必须经过 W5a，不允许 UI/Connector 直接写；W5 完整自治在后续；
- W7 先做满足当前 Release 的最小治理，不先建通用低代码 Studio；
- W9 没有商业与互通前置条件时只维护接口文档，不占用主线开发。

每个工作流依次执行：

```text
Design
→ Machine Contract
→ Threat/Failure Review
→ TDD Plan
→ Controlled Evidence
→ Real Dependency Evidence
→ Capacity/Recovery Evidence
→ Production Eligibility
```

不得从本文直接跳到大规模并行编码。

---

## 24. 风险、反指标与停止条件

### 24.1 主要风险

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| 产品范围过大 | 长期无可售版本 | 一个 ICP、一个主流程、Overlay、固定付费 Pilot Gate |
| 与 SightCall/Zoom 功能同质 | 缺乏赢单理由 | Resolution 连续性、结果验证、私有化、Native 通信 |
| AI 延迟和成本失控 | 体验和毛利恶化 | 多路径 SpeechRuntime、模型路由、预算和单位经济性 |
| AI 错误动作 | 客户和合规损失 | Proposal、Tool Policy、审批、Receipt、reconcile |
| 通信被 AI 拖垮 | 核心服务不可用 | 四故障域、fast path、有界 tap、旁路 |
| 结果无法归因 | Outcome 计费争议 | VerificationPolicy、Evidence、观察窗口和申诉 |
| 框架 Fork 负担 | 维护速度下降 | Adapter、exact source、替换演练、退出 Gate |
| 集成周期过长 | 销售成本过高 | 标准 Overlay 套件、行业模板、伙伴交付 |
| 私有化碎片化 | 无法升级和支持 | 受支持矩阵、签名包、统一控制合同 |
| 过早建设 CCaaS 表格功能 | 消耗研发且无差异 | CRM/FSM/WFM 集成优先 |

### 24.2 反指标

出现以下情况不能视为成功：

- Demo 很自然，但不能验证问题是否解决；
- AI containment 提高，但重复报修上升；
- 平均通话时间下降，但派工和停机没有下降；
- 模型单价下降，但每个 Resolution 总成本上升；
- 新功能增加，但客户需要替换更多现有系统；
- 自治增加，但 Unknown 动作和人工补救增加；
- 压测数字提高，但排除了录音、转码、桥或 AI；
- 支持多个框架，但每个框架拥有自己的状态和工具。

### 24.3 停止或转向条件

在以下条件下暂停相应路线：

- 完成 20 次合格买家访谈后仍少于 3 家对同一流程的有时限付费意向：停止编码扩张，重做 ICP/JTBD；
- 3 个标准 Pilot 中少于 2 个转年约：停止第二流程和规模销售，复盘产品价值；
- Pilot 的 `benefit / total_cost` 无法达到预签门槛，或任何强制安全、CSAT、复发、升级率护栏失败：均不得转正式合同；
- 连续两个客户的标准实施超过 20 person-days，公共复用低于 80% 或客户专属工作高于 20%：停止新增 Connector；
- 真实成本模型在合理价格下 12 个月内无法达到 70% 稳态毛利：缩减高成本能力或调整市场；
- 客户只愿为视频链接付费，不愿采用 Evidence、Resolution 和 Outcome：不继续打造平台，转伙伴/点工具策略；
- Overlay 接入成本接近完整系统替换，或外部平台缺少可验证能力：对该平台 no-bid，不伪装完整集成；
- 视频或必验 B1 翻译未改善主指标、不能达到质量门槛或损害护栏：暂停/重定位首个 Offer；B2 Copilot 或 B3 OCR 失败则只关闭对应 Optional；
- 自主 Agent 的质量、安全或经济性长期低于 Copilot：保持人工主导；
- 少于 2 个签约客户需要 Native Communications，或无法证明主权、成本、性能优势：不启动 Native 产品化；
- ViLTE 没有已签运营商/设备商、Profile、终端和实验网：不进入实现。

停止某一路线不等于推翻 Resolution Core，可保留验证有效的底座。

---

## 25. R1 决策清单

### 25.1 已冻结

- 内部产品类别：AI-native 多模态技术问题解决平台；
- 首发外部 Offer：面向中国出口设备厂商的海外安装与售后远程解决；
- 首个区域包：中国专家服务美国客户，按 DPA/跨境/保留默认合同交付；
- 首个 JTBD：现有电话→免 App 视频→中文/英文协作→Evidence→人工验证；
- 商业路径：Overlay-first、AI capability gated、Native-demand-gated、OEM-evidence-gated；
- Overlay Authority：外部 PBX/CCaaS/CRM/FSM 保留 Call/Case/SLA/正式关闭权威；OPC 拥有问题测量的 Resolution/Item、Projection、Execution、Evidence、AI 和 Action Ledger；
- Native runtime：Kamailio 管 Registrar/Location，Unified RustPBX 管业务 Call，RTPengine 管普通 RTP/SRTP，LiveKit/SFU 管 Room runtime；
- 核心聚合：Resolution + 独立 ResolutionItem；
- 核心结果：版本化且 Finalized 后不可变的 OutcomeClaim；争议/冲正使用独立对象；
- 人工与 AI：统一 Task、只约束 OPC 输出的范围化 OutputLease、结构化 Handoff；
- 通信与 AI：四个资源/故障域，区分 HumanCommunicationWithOptionalAI 与 AIEndpointCommunication；
- 工具动作：Proposal→Intent、Policy、Approval、Attempt、分级 Receipt、Verification、Reconcile；
- AI Runtime：多路径、多框架、可替换；HF 只替换重叠的 SpeechRuntime 功能；
- 数据：Evidence、ContextRevision、PlaybookVersion；
- 实时资源：MediaSource/Publication、MediaEdgeGeneration、MediaPipelineGeneration、PassiveFork、InlineTransform、EndpointProcessor 和非媒体 DataStream；
- G.729：wire codec 为 `G729/8000`，A/AB 是内部模式，工程强制、分发受法律策略控制；
- ViLTE 扩展边界：IMS Control、AV Gateway、Data Channel/DCS 和 Operator Conformance Profile 分离；
- MCP/A2A：外部生态，不进入媒体热路径和内部 Authority；
- 首个 Pilot：12 周、USD 20k、一个流程/语言对/provider-specific 电话 Adapter/CRM Connector；B1 中英字幕/文字翻译必验，不回注 TTS；
- 收费：named-expert 年度订阅、透明用量、可选私有化和成熟后的 Finalized Outcome 奖励。

### 25.2 必须经资格测试决定

- Rust SIP/RTP 实现组合；
- rvoip 能力吸收范围；
- 首个 provider-specific PBX/CCaaS Adapter 和最终 CRM/FSM Connector；
- HF SpeechRuntime 生产方式；
- Pi/Nanobot/其他 Agent kernel；
- VAD、STT、TTS、Realtime 模型；
- SFU 和远程桌面供应商；
- 自托管与托管模型分界；
- Target NFR Profile 的最终生产阈值、节点数和容量硬件；
- Outcome 价格和归因窗口。

### 25.3 当前均为 `not_run`

除非另有针对本文目标的独立证据，以下不视为已完成：

- 产品市场匹配；
- 付费设计伙伴；
- Target NFR Profile v1 延迟、质量和可用性目标；
- HF 企业容量和 HA；
- 完整 SIP↔WebRTC/视频切换；
- 真实双向翻译质量；
- 视觉 AI 验证；
- 自主 Action 安全；
- Dedicated/On-prem 交付；
- ViLTE/5G New Calling；
- OEM 平台；
- 100K 组合容量。

### 25.4 当前、目标和生产资格

| 领域 | 当前状态 | 本文目标 | 进入 `production_eligible` 的最低证据 |
| --- | --- | --- | --- |
| 市场 | `not_run`；无本文范围内付费证明 | 一个 ICP、Offer 和 Pilot | 20 访谈、3 付费 Pilot、2 转年约、ROI/毛利/复用证据 |
| Overlay | 存在旧集成候选，未按本文验收 | 外部 Authority + OPC Projection/Execution | 真实供应商 capability matrix、乱序/丢失/Unknown/reconcile |
| Telephony/Media | 存在旧代码与开源候选，资格未完成 | Native 合同、RTPengine fast path、统一资源世代 | SIP/codec/bridge/long-call/fault/capacity 原始 Evidence |
| AI Runtime | 存在零散链路与框架候选 | 可替换 Speech/Agent/Vision Adapter | 同源质量/延迟/成本、长会话、故障、隐私和回滚 |
| Resolution/Action | 存在设计或局部实现候选 | 单 Authority、Receipt、OutcomeClaim | 并发、幂等、crash、unknown、reversal 和审计测试 |
| ViLTE/NG-RTC | `not_run` | 只冻结四模块扩展接口 | 商业合同、Release/Profile、实验网、终端互通和容量 |

“存在代码”不等于 current capability，“设计目标”不等于 planned，“测试通过一个 happy path”不等于 production eligible。

---

## 26. 参考资料

以下只作为市场和技术方向参考，不作为 OPC 完成证据。访问日期均为 2026-07-31；动态网页和 `latest/main` 只用于本次方向判断，进入实现前必须冻结版本、commit 或发布日期。

- [Genesys AI and Automation](https://www.genesys.com/capabilities/ai-and-automation)
- [NICE CXone](https://www.nice.com/products/cxone)
- [Zoom Contact Center](https://www.zoom.com/en/products/contact-center/)
- [Zoom AI Expert Assist](https://www.zoom.com/en/products/ai-expert-assist/)
- [Amazon Connect](https://aws.amazon.com/connect/)
- [ServiceNow Contact Center](https://www.servicenow.com/products/contact-center.html)
- [Salesforce Service Cloud](https://www.salesforce.com/service/cloud/)
- [Sierra Product](https://sierra.ai/product)
- [Decagon](https://decagon.ai/)
- [Intercom Fin Outcomes](https://www.intercom.com/help/en/articles/8205718-fin-ai-agent-outcomes)
- [Retell AI Pricing](https://www.retellai.com/pricing)
- [SightCall Remote Visual Support](https://sightcall.com/platform/remote-visual-support-2026/)
- [SightCall Xpert Knowledge](https://sightcall.com/platform/xpert-knowledge/)
- [TechSee](https://techsee.com/)
- [CareAR](https://carear.com/)
- [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech)
- [LiveKit Agents](https://docs.livekit.io/agents/)
- [LiveKit Telephony — access-date feature table marks Video over SIP unsupported](https://docs.livekit.io/telephony/)
- [RTPengine source and control documentation](https://github.com/sipwise/rtpengine)
- [Model Context Protocol Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [Agent2Agent Protocol](https://a2a-protocol.org/latest/)
- [RFC 4733 — RTP telephone events](https://www.rfc-editor.org/rfc/rfc4733)
- [RFC 4856 — RTP audio/G729 media registration](https://www.rfc-editor.org/rfc/rfc4856)
- [RFC 7261 — G.729 Annex B offer/answer](https://www.rfc-editor.org/rfc/rfc7261)
- [GSMA NG.134 v5.0 — IMS Data Channel, 2025-07-17](https://www.gsma.com/newsroom/wp-content/uploads/NG.134-v5.0.pdf)
- [GSMA TS.65 v1.0 — UE IMS Data Channel testing, 2026-01-30](https://www.gsma.com/get-involved/working-groups/gsma_resources/ts-65-ue-ims-data-channel-device-testing/)
- [GSMA TS.66 v2.0 — IMS Data Channel API, 2026-07-20](https://www.gsma.com/get-involved/working-groups/gsma_resources/ts-66-ims-data-channel-api-specification/)
- [GSMA Voice Communications Evolution](https://www.gsma.com/newsroom/gsma_resources/gsma-voice-communications-evolution-whitepaper/)
- [IETF Media over QUIC Transport](https://datatracker.ietf.org/doc/draft-ietf-moq-transport/)

---

## 27. 独立预审闭环

| 审查 P0/P1 | 本文闭环位置 |
| --- | --- |
| 首个 ICP/JTBD 过宽 | §3.5、§19、§20：一个出口设备 ICP、美国区域包、一个流程和固定 Pilot |
| Resolution 粒度与结果争议 | §7：ResolutionItem、OutcomeClaim、Observation/Reversal |
| Overlay 权威冲突 | §7.4、§8.2：外部 Call/Case Authority，OPC 问题测量 Resolution/Item、Projection/Execution |
| Track 混合资源和旁路承诺 | §7.2、§9：Source、Edge、Pipeline、Fork、Transform、Endpoint |
| AI 故障承诺不准确 | §10.1：Human optional AI 与 AI Endpoint 两类服务 |
| 四故障域只有口号 | §8.4：进程、资源、依赖、Fault Matrix、Journal、RTO/RPO |
| ViLTE/Data Channel 过度简化 | §9.5：Control、AV、DCS、Operator Profile 四模块 |
| SIP/G.729 细节缺失 | §9.4、§9.6：wire codec、Annex B、事务/对话/转接/DTMF |
| SLO 不可测量 | §15–§16：workload、边界、telephony/video/AI SLI 和时钟映射 |
| Pilot 范围过大 | §19.2、§22.2：Tracer A + 必验 B1 翻译；B2 Copilot/B3 OCR Optional |
| 商业模型和单位经济不足 | §3.5、§19–§20：价值池公式、固定合同、ACV、毛利、复用、转化和 no-bid |
| 工作流依赖错误 | §23：W0/W8 前置，W5a 进入 Pilot A，B1/B2/B3 各自依赖 |
| 长通话、E2EE、录音、consent | §9.2、§10.8–§10.9、§13、§17 |
| 远期功能被错误冻结 | §22.5–§22.6、§25：商业 Option 与当前目标分离 |
| 当前/目标/生产状态混淆 | §1.4、§25.3–§25.4：Evidence-backed 状态明确 |

独立预审不等于用户批准，也不等于实现验收。本文仍为 `proposed_for_review`。

---

## 28. 用户评审重点

请优先评审以下六项：

1. 是否接受内部“多模态技术问题解决平台”、外部“出口设备售后远程解决”的双层定位。
2. 是否接受一个 ICP、美国首发区域、一个主流程、USD 20k 固定 Pilot、必验 B1 翻译和明确 no-bid。
3. 是否接受 Overlay 外部系统保留 Authority，Native 必须由至少 2 个签约客户触发。
4. 是否接受 ResolutionItem、Evidence、Task、Action、OutcomeClaim 和 OutputLease 作为永久业务核心。
5. 是否接受 HF 只替换重叠 SpeechRuntime，Pi、Nanobot、LiveKit Agents 等均为可替换 Adapter。
6. 是否接受 ViLTE、平台化和 36–60 月方向只是有 Gate 的 Option，不是当前开发承诺。

本文获批后，下一步不是直接编码，而是先为 W0–W10 建立依赖顺序、机器合同和详细实施计划。
