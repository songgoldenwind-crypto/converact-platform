# Competitive and Build / Absorb / Buy / Partner Review

> Decision scope：G01 产品/组件边界；不授权运行时实现
> Evidence status：公开来源已复查；同源性能、供应链、成本和客户选择均 `not_run`

## 1. 决策原则

选择不以 Rust、开源、功能数量或“自己控制”为单一理由。每项能力按以下顺序判断：

1. 它是否属于 Converact 必须拥有的 Authority/差异化合同？
2. 客户是否愿为同一 flow 的结果付费？
3. 现成组件/伙伴是否能在稳定 Adapter 后满足功能、性能、故障、安全和退出要求？
4. 自研是否在 3 个客户复用、20 person-days 和 ≥70% 毛利约束内更优？
5. 失败是否会拖垮 Human Communication 或创建第二 Authority？

任何答案未知时保持 `not_run`，不因为已有代码就默认 absorb。

## 2. Build：必须自研/拥有

| 领域 | 原因 | 边界 |
| --- | --- | --- |
| Engagement/Profile/Offer/Option contract | 平台上位语义与商业隔离 | 不重建 Call/Room/Case Authority |
| Engagement/EngagementItem/ProfileBinding | 平台业务执行 Authority | Profile 只校验/投影 |
| Interaction/CommunicationSession/BridgeIntent | 跨 Call/Room/channel 的连续性 | 各通信系统仍写自身对象 |
| Evidence/VerificationPolicy/OutcomeClaim | 可审计、可逆结果与计费基础 | AI output 不自动成为事实 |
| ActionIntent/Attempt/Receipt/Verification/Reconcile/Compensation | 外部副作用的安全与未知状态 | Provider/Agent 是 executor，不是写者 |
| AgentRun/Task/Context/Handoff/Evaluation contract | 跨框架可替换性和人机责任 | 不自研所有模型/framework |
| Metering/attribution/credit/reversal | 可解释单位经济和争议 | 不借供应商账单当 Outcome |
| Profile/Capability/Option Gate & evidence tooling | 防止路线图冒充可售能力 | 不自研完整 CRM/WFM/QM |

自研仍必须使用深接口和独立故障域；“核心”不代表全部同进程或每包/每 turn 经过中心总线。

## 3. Absorb/Wrap：只吸收有边界的源码能力

| 候选 | 候选范围 | 保留/禁止 | 当前决定 |
| --- | --- | --- | --- |
| RustPBX | 产品进程外壳、现有配置/API/路由/队列/媒体外观候选 | Unified RustPBX 仍为一个 Call Authority；不得保留双 Call/SIP/media 状态 | `planned`：后续 Goal 同源审查 |
| rvoip | parser、transaction/dialog、RTP/RTCP、jitter/codec 等低层 slice 候选 | 先 shadow、逐层替换；不引入高层 Orchestrator/第二 PBX/第二 Session Authority | `planned`：exact-slice Gate |
| `voice-media-rs`/codec/DSP | decode/transcode/mix/record/AI tap 外观与算法候选 | 普通 RTPengine fast path 不绕行；媒体不决定路由/计费 | `planned`：功能/容量/故障 Gate |
| HF speech-to-speech | 与旧链/LiveKit Agents/Active 重叠的 VAD/STT/LLM/TTS 实时 loop | 只替换 `same_function_as_HF_speech_loop=true`；保留非重叠 worker/channel/plugin/telemetry | `planned`：G12 同源质量/延迟/成本 |
| LiveKit Agents | participant/worker/channel/plugin/telemetry、Agent adapter 模式 | 不拥有 Engagement/AgentRun/Action；不因为 HF 删除非重叠功能 | `planned`：逐功能 parity |
| Pi/Nanobot/Agent kernel | specialist executor/interactive kernel 候选 | 有界 lease/context/budget；memory/cron/queue 不成为 Authority | `not_run`：需 exact source 和企业资格 |
| Active Call | fixed `miuda-ai/active-call@a5c7a88490b65975c0b0ae2787311c49022d4a8d`；电话 Agent/Playbook/DTMF/媒体候选 | 只评估 pure PCM/canonical-event adapter；禁止成为第二套 SIP/RTP/Call Authority；缺失的 LICENSE 正文、依赖与源码审计先闭合 | source identity `verified`；吸收/性能/集成 `not_run` |
| Eval/observability/open codecs | 可复用算法/工具 | 不借用 benchmark；保留 license/source/evidence | `not_run`：逐项 Gate |

吸收不是把两个仓库全部拼进 Workspace。每个 slice 必须记录 `keep/wrap/rewrite/reject`、API、
owner、故障域、性能基线、迁移/回滚和旧实现 active-zero 删除条件。

## 4. Exact-source 与供应链 Gate

每个吸收候选在编码前必须固定：

- repository owner、URL、immutable commit/tag、source hash、license 和 THIRD_PARTY_NOTICES；
- dependency lock、SBOM、签名/来源、构建工具链与可复现构建；
- maintainer/activity、known CVE/advisory、升级/退出成本；
- key ownership、短 lease、memory exposure、zeroization 和 core-dump 边界；
- Rust `unsafe`、C/FFI/native codec 隔离清单；
- parser/codec fuzz、known vectors、malicious input、sanitizer/Miri（适用处）；
- panic/OOM/CPU runaway/descriptor/port leak/worker restart 故障注入；
- 相同功能、硬件、网络、source、config/workload 的性能/质量/成本基线；
- 与单一 Authority 冲突审查和 active-zero 删除计划。

上游 README、star、crate 数、供应商 demo 和 upstream benchmark 不能通过 Gate。G.729 等法律
审查只限制分发/enablement，不删除后续强制工程任务。

## 5. Buy/Partner

| 能力 | 首选关系 | 为什么不首轮自研 | 必须保留的控制 |
| --- | --- | --- | --- |
| 全球号码、Carrier、SIP trunk | Buy/Partner | 牌照、互联、合规、全球运营 | 多区域路由/价格/故障 Evidence，Provider 可换；首发只选一个 |
| LiveKit/SFU/TURN/视频 codec | Operate/Buy/Partner | SFU/codec/ICE 全球成熟度和专利/运维 | LiveKit 保持 Room Authority；Cloud/self-host 由 Option Gate |
| CRM/FSM/WFM/QM | Partner/Connector | 已有正式对象和企业流程 | Overlay Authority、Receipt/query/reconcile；首发只选一个 CRM/FSM |
| 基础模型、部分 STT/TTS/translation | Buy/Host/Partner | 训练/评测/硬件成本 | Model adapter、data/region/retention、same-source eval、fallback |
| GPU/对象存储/审计认证 | Buy/Partner | 规模、认证、供应链 | Tenant cost attribution、exit/restore、evidence integrity |
| Remote desktop/control | Partner（未来） | 高安全/平台/支持复杂度 | 独立 consent/action/audit/capacity Gate；不在 Pilot |
| 本地实施 | 单一认证伙伴类型（未来） | 区域/行业交付 | 不得拥有产品 Fork；公共复用/毛利 Gate |
| ViLTE/IMS/NG-RTC | Carrier/device Partner | 网络/终端/Profile/互通依赖 | 独立 G17 Option；无合同和实验网不启动 |

Partner 失败只关闭该 Option/Provider；不得改变 Platform Authority 或把另一未资格 backend 静默
标为可用。

## 6. 明确不做

- 自建完整 IMS/5G Core；
- 训练通用基础模型；
- 首轮自研视频 codec/SFU/全球 Carrier 网络；
- 复制完整 Genesys/Zoom/NICE 的 WFM/QM/全渠道套件；
- 复制 Salesforce/ServiceNow 的通用 CRM/FSM；
- 同时维护两套 SIP/RTP/media/Agent/Recording/Billing/Engagement Authority；
- 为一个客户保留永久 PBX/media Fork；
- 用开源组件数量或 Rust 比例作为产品能力指标。

## 7. 竞争 Win/No-bid/Partner 选择

| 需求重心 | 选择 | 原因 |
| --- | --- | --- |
| 高价值设备问题、原电话、no-app visual、跨语言、Evidence、人工 Outcome | Pursue Resolve Pilot（需 Market Gate） | 与冻结 JTBD 同一 flow |
| 完整 CCaaS/ACD/WFM/QM 替换 | Integrate/Partner Genesys/Zoom/NICE 等 | 首轮不具备也不承诺全套 |
| 只要便宜视频/AR remote assist | Partner/no-bid visual vendor | 无足够增量价值 |
| 只要 Case/WorkOrder/dispatch | Partner Salesforce/ServiceNow/实施商 | 外部系统本应是 Authority |
| 只要低价 Voice Bot/deflection | No-bid/Agent partner | 不符合高价值 Resolution economics |
| 需要线路/API/全球号码 | Buy/Partner CPaaS/Carrier | 不自建受监管网络 |
| 要私有通信底座 | Conditional Native Option | 至少两家签约需求 + 技术/经济 Gate |
| 要 ViLTE/operator video | G17 Partner Option | 需要 Carrier/IMS/device/实验网 |

## 8. 组件选择 scorecard

进入后续 Goal 时每个候选按硬 Gate 而非平均分：

1. Function parity：不能以缺功能换性能；
2. Authority fit：不能创建第二写者；
3. Same-source performance/capacity/quality；
4. Fault isolation/recovery/long-run；
5. Security/privacy/key/native/FFI/supply chain；
6. Maintainability/debuggability/observability；
7. Upgrade/rollback/exit and active-zero deletion；
8. Full cost：compute、operations、support、license、legal、integration；
9. Customer/Offer relevance。

任一强制 Gate 不通过即 `reject/defer`；不能用其他高分补偿。两个 backend 可在灰度期并存，但
最终生产只有一条权威路径，迁移遵守“新流量→drain→reconcile active-zero→删除”。

## 9. 当前结论

G01 只冻结决策方法和初始边界。没有完成任何候选的 exact-source、benchmark、security、fault、
capacity 或真实成本 Gate；Build/Absorb/Buy/Partner 的运行时选择除既有 Authority 合同外均保持
`planned/option/not_run`。这防止“现成代码肯定更好”和“自研肯定更快”两种未经证明的结论。
