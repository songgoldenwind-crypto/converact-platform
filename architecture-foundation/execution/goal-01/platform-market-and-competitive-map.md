# Converact Platform Market and Competitive Map

> Facts captured：2026-08-01
> Claim register：`competitive-source-register-v1.json`
> 状态：公开能力基线已复查；Converact 差异、性能、赢单和市场需求均 `not_run`

## 1. 两层地图

竞争必须分两层：

1. **Horizontal Platform 层**：客户可能从 Contact Center、CPaaS/RTC、Enterprise Agent、
   CRM/FSM/Workflow、Telecom/OEM 或内部开源工程预算购买；
2. **Resolve Profile 层**：客户会拿现有电话/消息/人工翻译、普通视频会议、视觉远程支持、
   CRM/FSM 既有流程或低价 Bot 与一个具体 Pilot 比较。

平台层不能拿 Resolve 的派工/停机假设证明领先；Resolve 也不能以平台未来能力回避与当前视觉
支持/现状的直接比较。

## 2. Horizontal Platform 预算地图

| 类别 | 典型买家/预算 | 正式对象或能力 | Converact 首轮关系 | 不做的错误比较 |
| --- | --- | --- | --- | --- |
| Enterprise Contact Center | CX/Contact Center/IT；坐席、渠道、WEM/QM | ACD、路由、渠道、坐席、质量、WFM、Journey | Overlay/合作，补 Engagement/Evidence/Action/Outcome | 首轮复制完整功能表或宣称替代 |
| CPaaS/RTC | Product/Engineering/Telecom；API/用量 | 号码、线路、SIP、Voice/Video/Messaging API、RTC | Buy/Partner/Adapter；保留可替换性 | 用上游规模宣称 Converact 容量 |
| Enterprise AI Agent | CX/Digital/AI；自动化/Outcome | Agent lifecycle、知识、渠道、工具、评测、Studio | 竞争或吸收执行模式；Converact Authority 不外包 | 用 LLM/Voice demo 代替业务闭环 |
| CRM/FSM/Workflow | Service/Operations/IT；系统记录和实施 | Case、WorkOrder、SLA、资产、派工、流程 | Overlay 中保持外部 Authority，做深 Connector | 重建第二 Case/WorkOrder 数据模型 |
| Telecom/OEM | Carrier/Device/OEM；网络、终端、合规 | IMS、号码、线路、ViLTE/NG-RTC、终端 Profile | 条件式 Option/Partner | 无合同/实验网就建完整 IMS/Core |
| Open-source components | Engineering；研发/运维/云成本 | SIP/RTP/SFU/Speech/Agent/codec 等构件 | Build/Absorb/Operate，经 exact-source Gate | 把 repo 数量或上游 benchmark 当产品价值 |

[Twilio 官方 CPaaS 页面](https://www.twilio.com/en-us/cpaas)将 CPaaS 定义为通过 API 把消息、
语音、视频、邮件和验证嵌入业务应用。这证明“通信 API/线路”有独立采购层，不证明其任何规模
数字可被 Converact 继承。

## 3. 官方公开事实基线

以下只陈述官方页面当前公开的能力；不复述其未经同源验证的效果百分比。

| 产品/类别 | 2026-08-01 官方公开事实 | 对 Converact 的含义（推断，未证明） |
| --- | --- | --- |
| Genesys Cloud CX | [Genesys](https://www.genesys.com/genesys-cloud)公开 voice、digital、AI、journey 与 workforce engagement 的综合平台范围 | 广义 CCaaS 替换会进入成熟全套预算；首轮应 Overlay，而非功能表硬碰 |
| Zoom Contact Center | [Zoom](https://www.zoom.com/en/products/contact-center/)公开 phone、video、email、chat、SMS、social、AI assist、quality/WFM 等范围 | “Zoom 没视频/没 AI”不是可用差异；必须在同一 Resolve flow 比 Outcome/Evidence |
| Twilio CPaaS | [Twilio](https://www.twilio.com/en-us/cpaas)公开多渠道通信 API；其产品页另列 Voice、SIP、Video | 可作为线路/API/Connector 候选，不成为 Engagement Authority |
| LiveKit | [LiveKit 概览](https://docs.livekit.io/intro/about/)把 server 定义为开源 WebRTC SFU；[Telephony](https://docs.livekit.io/telephony/)列出 SIP/RTP/SRTP/DTMF/transfer，同时明确 `Video over SIP` 不支持 | Room/WebRTC/SFU 是独立 Authority；现有 SIP 路径只能视为音频桥，未来运营商视频需 AV Gateway Option |
| LiveKit Agents | [Agents 文档](https://docs.livekit.io/agents/)公开实时 Agent framework 与 STT/LLM/TTS/realtime model 集成 | 可保留 participant/worker/plugin/telemetry 等非重叠能力；不能拥有 Agent/Engagement/Action Authority |
| Salesforce Service/Field | [Service Cloud](https://www.salesforce.com/service/cloud/guide/)公开 Case、omnichannel、knowledge、voice/telephony 和 Field Service；[Field Service](https://www.salesforce.com/service/field-service-management/guide/)公开 scheduling、mobile、asset/inventory、work order | Overlay 中 Salesforce 继续为 Case/WorkOrder Authority；Converact 补实时协作/Evidence，不复制 CRM/FSM |
| ServiceNow CSM/FSM | [CSM](https://www.servicenow.com/products/customer-service-management.html)公开 Case、Agent Workspace、workflow、knowledge/AI；[FSM 文档](https://www.servicenow.com/docs/en-US/bundle/zurich-field-service-management/page/product/field-service-management/concept/fsm-application-landing-page.html)覆盖 dispatcher/technician/mobile field service | 同上；竞争或合作取决于客户是否要实时 Resolution execution，而非工单能力 |
| Sierra | [Sierra 产品](https://sierra.ai/product/meet-your-agent)公开 phone/chat/SMS/email、多语言、系统动作、handoff 和 Agent Studio | 企业 Agent 已覆盖渠道/动作叙事；Converact 必须用可验证现场业务和 Authority/Receipt 证明差异 |
| Decagon | [Decagon 产品](https://decagon.ai/product/overview)公开 chat/voice/email、guardrails/integration、testing/versioning/observability | Agent framework 功能数量不是壁垒；需比较同一高价值 flow、数据/动作安全和 Outcome |

厂商“低延迟、规模、ROI、解决率”等宣传只有其自己可解释的上下文，不进入 Converact Evidence。

## 4. Resolve 直接替代方案

| 替代方案 | 客户为何选择 | Converact 候选 Win 条件 | No-bid/Partner 条件 |
| --- | --- | --- | --- |
| 现有电话 + 微信/WhatsApp/Teams/邮件 + 人工翻译 | 已部署、低增量成本、用户熟悉 | 真实基线显示视觉/语言/Evidence 缺口带来 ≥3×价值池 | 现状已满足或客户不提供基线 |
| Zoom/Teams/普通视频会议 | 视频和屏幕成熟、采购已有 | 必须保留原电话连续性、no-app 现场视角、业务 Evidence/Outcome | 客户只要会议链接时不投 |
| SightCall | [官方页面](https://sightcall.com/platform/remote-visual-support-2026/)公开 no-app video、AR、Evidence/集成 | 同一 flow 中证明跨语言、电话连续、Action/Outcome 和私有化带来增量 | 只要视觉远程支持时 partner/no-bid |
| TechSee | [官方页面](https://techsee.com/techsee-live-field-services/)公开 AI visual assistance/field-service remote support | 需要同源 buyer/flow 评估；当前差异未证明 | 客户已有满意 TechSee 流程且无增量价值 |
| CareAR | [官方页面](https://carear.com/assist-demo)公开 live video、annotations、AR remote assistance | 同上；不能靠“我们也有视频”获胜 | 只需 AR remote assist 时 partner/no-bid |
| Salesforce/ServiceNow 原流程 | 系统记录、派工、权限和实施已成熟 | 客户需要电话内实时协作、跨语言 Evidence 和验证但不想替换 Authority | 只要工单/派工/资产管理时 partner |
| Sierra/Decagon/低价 Voice Bot | 自动化、跨渠道、快速响应或按用量 | 复杂设备现场需要视觉、人类专家、安全验证和跨天 Outcome | 只按分钟/deflection 比价、无高价值 Resolution 时 no-bid |

## 5. Resolve 差异化假设（不是事实）

待 Market/Pilot Evidence 验证的组合假设：

```text
existing phone continuity
+ no-app additive video
+ CN/EN source-visible collaboration
+ provenance-bound visual Evidence
+ human/AI shared Task with controlled Action
+ customer-system Authority preserved
+ versioned, reversible OutcomeClaim
= measurably better high-value Resolution economics
```

每一项单独都可能被竞品覆盖。只有三个不同客户愿意为同一完整 flow 付费、并在预签指标/护栏
下产生结果，组合才可能成为差异；当前 `not_run`。

## 6. HF、LiveKit Agents、Active 与开源候选

[Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech)当前官方 README 描述
模块化 VAD→STT→LLM→TTS、可换 backend 和 Realtime-compatible interface。它只提供重叠
SpeechRuntime 候选，不能据此宣称 VAD、延迟、准确率或成本优于 LiveKit Agents/托管 Realtime。

[LiveKit Agents](https://github.com/livekit/agents)是实时 Agent framework 候选；其 worker、
participant、channel、plugin、telemetry 等非重叠能力必须保留/迁移评估，不能因为采用 HF 而
全部删除。

[Active Call](https://github.com/miuda-ai/active-call/tree/a5c7a88490b65975c0b0ae2787311c49022d4a8d)
已经固定为 `miuda-ai/active-call` commit
`a5c7a88490b65975c0b0ae2787311c49022d4a8d`。该 revision 的 `Cargo.toml` 声明 crate
`active-call` `0.3.75`、repository owner/URL 与 MIT SPDX license；README 将其描述为 Rust
SIP/WebRTC voice-agent framework，包含传统/Realtime speech pipeline、Playbook、电话动作和
媒体处理。仓库根目录在该 revision 没有可取得的 `LICENSE` 正文，因此 **source identity 已
verified，完整 license/notice、dependency、unsafe/FFI、功能和性能审查仍为 `not_run`**。
在这些 Gate 前不得吸收源码、借用上游 benchmark 或让它成为第二套 SIP/RTP/Call Authority。

[RustPBX](https://github.com/restsend/rustpbx)与[rvoip](https://github.com/eisenzopf/rvoip)只有
公共源码候选事实。上游测试不等于 Converact 同功能性能；吸收前仍需 exact commit、license、
SBOM/security/unsafe/FFI、fuzz、fault、same-workload benchmark、Authority 和 active-zero 删除 Gate。

## 7. 必须实测/访谈的竞争问题

| Requirement | 同源条件 | 当前状态 |
| --- | --- | --- |
| Resolve buyer win/loss | 同 ICP/flow、相同商业范围、真实 budget/status quo | `not_run` |
| no-app phone→video journey | 同设备/浏览器/网络/Consent/长短通话 | `not_run` |
| B1 quality/latency/cost | 同 audio/language/hardware/network/turn/quality guardrail | `not_run` |
| visual Evidence/Outcome | 同 problem、verification、observation window、dispute | `not_run` |
| build vs partner TCO | 同 SLA/region/support/upgrade/security/capacity | `not_run` |
| platform Profile reuse | 第二客户/flow 的真实复用与定制比例 | `not_run` |

没有这些 Evidence，不能在销售材料写“优于 Genesys/Zoom/SightCall/TechSee/CareAR/LiveKit/HF”或
“行业领先”。

## 8. 市场地图结论

- 首轮不进入完整 CCaaS、CRM/FSM 或低价 Bot 功能表竞争；
- CPaaS/RTC、Carrier、SFU、模型和通用企业系统优先 Buy/Partner/Adapter；
- Converact 自研单一 Engagement/Interaction/Action/Evidence/Outcome Authority 与跨系统连续性；
- Resolve 只在高价值、视觉/跨语言/专家协作且可测的同一 flow 上竞争；
- 只要便宜视频/传统 CCaaS/工单/低价 Bot 或无基线时 no-bid/partner；
- 当前地图是合同和公开事实基线，不是 Market Gate。
