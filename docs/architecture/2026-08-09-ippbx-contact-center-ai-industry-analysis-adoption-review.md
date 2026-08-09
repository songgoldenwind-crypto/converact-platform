# IPPBX 呼叫中心 AI 行业分析：事实审查与 Converact 采纳裁决

- 日期：2026-08-09
- 状态：`research_input_reviewed_non_authoritative`
- 对运行时的授权：`none`
- 对生产资格的影响：`none`
- 外部性能、质量、成本与商业主张：`not_run`
- 来源文件：`IPPBX呼叫中心AI机器人部署技术研究（2026）-SIP实验室发布.pdf`
- 来源 SHA-256：`d45ffbeaa945ec87a7046d420977489c2173c12b86d131cf22af7f31f11ec026`
- 补充分析：`pasted-text.txt`
- 补充分析 SHA-256：`fc1c98fb7936ff40bfc6957006a73dd435939e4a31ab64fbcdefaabbe8a7094a`
- 关联决策：[ADR-CCAAS-12](../adr/ccaas-12-policy-driven-speech-and-tool-adapter-boundaries.md)
- 绑定 Goal 增补：
  [2026-08-09 future-goal amendment](../../goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.md)

PDF 与补充分析由用户从仓库外部提供，不 vendoring 到本仓库；上述 SHA-256 是本次 intake
身份，clean clone 不能重新读取外部原件，因此它们明确是 `external_supplied_source_identity`，
不是本地可复现实验或生产 Evidence。仓库内可复现的是本审查、ADR、机器 amendment 及其哈希。

## 1. 结论

这份文章适合作为趋势雷达，不适合作为架构规范、性能基线、容量规划或供应商采购依据。
文章对多语音运行时、Action-first、人工接管、开放工具协议、方言和完整单位经济的方向判断
有价值；但缺少完整参考文献、原始样本、测试环境、复现步骤和统一术语，并把厂商自报、二手
统计、组件微基准与端到端结论混在一起。

Converact 不因本文改变下列已冻结边界：

- Kamailio 仍是 SIP Edge；
- Unified RustPBX 仍是 Call、Leg、路由、CDR、Media Plan Authority；
- RTPengine 仍是 ordinary RTP/RTCP/SRTP 性能底线；
- `voice-media-rs` 仍处理必须解码的转码、混音、录音 tap 和 AI tap；
- LiveKit 仍是 Room、Participant、Track、WebRTC、SFU Authority；
- Agent Runtime 只产生 `ActionProposal`；
- Converact Engage Action Authority 单写 ActionIntent、Authorization、Attempt、Receipt、
  query/reconcile 与 Compensation；
- G.729 exact-source 工程、Voice↔LiveKit 和未来 ViLTE 独立资格继续执行。

本文只产生向前兼容 additive contract。任何外部主张在 Converact 自己的相同源码、硬件、
网络、音频、并发、功能和统计合同下运行前都保持 `not_run`。

## 2. 审查方法

1. 提取并逐页目视检查全部 16 页；前 15 页有内容，第 16 页无实质研究内容。
2. 将关键主张归为：
   `verified_primary`、`vendor_reported`、`unverified` 或 `rejected`。
3. 优先使用 RFC、官方项目文档、法规原文、厂商原始案例和论文核验；二手文章不能提升
   Converact Evidence 状态。
4. 将采纳动作归为：`adopt`、`qualify`、`reject` 或 `defer`。
5. 不把文章、厂商 benchmark、mock、loopback 或 microbenchmark 写成生产 Evidence。

## 3. 关键主张审查

| 主张 | 事实等级 | 审查结论 | Converact 裁决 |
| --- | --- | --- | --- |
| 级联 STT→LLM→TTS 仍适合多数生产 Agent | `verified_primary_limited` | LiveKit 当前也将级联作为多数生产 Agent 的默认建议，但同时支持 Realtime 与 Half-cascade；不能外推成级联全面占优 | `adopt` 多路径，不固定唯一默认 |
| GPT Realtime 86.7%、GPT-4.1 94.9% | `verified_primary_limited` | 是 Daily 特定长对话/工具/指令测试结果，不是模型通用准确率 | `qualify`，只能作为候选语料设计输入 |
| Pipecat 247/256/266/281 ms 证明级联等于 S2S | `rejected_inference` | 数字描述单组件 TTFS/相关延迟，不包含 LLM、TTS、网络与 first-audible；不能证明端到端结论 | `reject` 该推论 |
| HF `speech-to-speech` 是原生端到端 S2S | `rejected` | 该项目是模块化 VAD→STT→LLM→TTS；兼容 Realtime API 不改变其级联性质 | `adopt` 为 exact-source Controlled Cascade 候选 |
| HF 必然比 Active/LiveKit/托管路径更快 | `unverified` | 没有同模型、同硬件、同语料、同网络、同功能的端到端公开对比 | `qualify`，不得预设胜者 |
| Deepgram Flux 降低 200–600 ms、误打断约降 30% | `vendor_reported` | 官方厂商数据存在，但不是独立证明 | `qualify` 为 fused-ASR 候选 |
| Genesys + Deepgram 约 425 ms | `unverified` | 未找到可复现的一手端到端合同 | `reject` 为 SLO 或验收线 |
| OpenAI Realtime 音频单价 | `verified_primary_time_sensitive` | 当前官方价格可核对，但价格会变且不等于全成本 | `qualify`，运行时固化 price revision |
| 原生 S2S 总是比级联贵 2.3–2.6 倍 | `rejected_generalization` | 特定 Azure 组合不能代表所有模型、区域和折扣，也可能漏算链路成本 | `reject` 通用倍数 |
| 电话只能使用 8 kHz PCMU 且不可协商 | `rejected` | SIP/SDP 可协商 PCMU、PCMA、G.722、G.729、Opus、AMR-WB 等；传统 PSTN 段常见窄带不等于平台全局限制 | `reject`，按 codec profile 资格化 |
| 每路转码消耗单核 50%–80% | `unverified_non_generalizable` | 缺 CPU、codec pair、ptime、方向、SIMD、实现和并发身份 | `reject` 为容量输入 |
| MCP 于 2025 年进入 AAIF | `verified_primary` | Anthropic 与 Linux Foundation 的原始资料一致 | `adopt` 开放协议方向 |
| MCP 2026-07-28 移除 initialize/session | `verified_primary_with_scope` | 协议不再依赖隐式 session；应用仍通过显式 handle 保存业务状态 | `adopt` 版本/能力协商，不删除 durable state |
| MCP 自动把 N×M 变为 N+M并提速 40%–60% | `unverified` | schema、认证、租户、审批、版本、幂等和恢复复杂度不会自动消失 | `reject` 为交付承诺 |
| MCP 已是所有呼叫中心的事实标准 | `unverified` | 文章混合客户端、服务端、Beta、预告与 GA | `defer` 市场强度结论，工程上保留 Adapter |
| EU AI Act 第 50 条带来 AI 交互披露要求 | `verified_primary_with_legal_scope` | 总体方向成立，但主体、例外、时间和话术需按地区/用例法律审查 | `adopt` policy + Disclosure Receipt，不硬编码全球话术 |
| Siemens 90% 电话均由 AI 完全解决 | `rejected_overstatement` | AWS 案例的 90% 同时包含直接解决和自动正确路由 | `reject` 为 containment/ROI 证明 |
| Genesys 的 LAM 证明应从对话转向动作 | `vendor_reported_direction` | Action、guardrail、验证和人工接管方向值得借鉴；不证明模型天然无幻觉 | `adopt` Action-first，拒绝厂商模型 Authority |
| LiveKit SIP 可承载未来运营商视频 | `rejected` | LiveKit 当前明确标记 Video over SIP 不支持 | `reject`，继续独立 ViLTE AV Gateway |
| 中文方言是可售卖差异化 | `research_direction` | 新模型扩大语言/方言覆盖，但“支持”不等于 8 kHz、噪声、混码生产合格 | `qualify` 独立 cohort |

## 4. 补充分析的采用裁决

补充分析可以作为架构输入，但其中的“85%”“行业终局”“模型商品化”和产品命名均是判断，
不是可继承 Evidence。Microsoft 与 AWS 的一手资料证明多种模型路径、确定性 workflow 和
agentic experience 可以在同一产品中共存；它们没有证明 Converact 可在任意正在进行的
音频 turn 内无代价切换路径。Deepgram 的 turn 模型和约 260 ms 等数字属于厂商公开能力或
厂商报告性能，只用于构造候选和测试，不成为我们的 SLO。

| 补充建议 | 裁决 | 边界 |
| --- | --- | --- |
| `Policy-driven Interaction Runtime` | `adopt` | 作为 Agent Runtime 的版本化 `InteractionExecutionPolicy`，不是新 Authority |
| 一个任务阶段或 turn 可选择不同路径 | `adopt_with_fence` | 只在冻结的阶段/turn 边界切换；每次切换新建 selection receipt、generation 和 fence |
| `Conversation Perception Runtime` | `adopt_as_submodule` | 是 SpeechRuntime 内的深模块和 observation producer，不拥有事实、Task、Action 或 Handoff |
| Reason→Plan→Authorize→Execute→Verify→Compensate | `adopt` | Reason/Plan 形成 Proposal；Authorize 以后仍由 Engage Action Authority 单写 |
| `Trusted Action Plane` | `qualify_as_description` | 可作解释性名称；规范名称仍是 Engage Action Authority + Tool Broker，不新增 Authority |
| Human Collaboration roles | `adopt` | 角色、能力和 lease，不是新的 Human Collaboration Authority |
| 合规成为 Runtime Policy 输入 | `adopt` | 法律适用性由地区/用例审查；Policy 只选择已经允许且已资格化的路径 |
| 跨层 Evaluation/Governance | `adopt` | G15 的治理能力，不成为业务事实 writer |
| Context 事实可信度分层 | `adopt` | transcript/summary 仅是来源；事实提升必须有明确 confirmation receipt |
| `Communication AI Operating System` | `defer_as_positioning` | 可作为产品愿景，不替换已冻结产品域、Authority 或已证明的市场主张 |
| ASR 会过时、模型会完全商品化 | `reject_as_fixed_prediction` | 保留 STT/ASR 精确组件名和 provider 独立资格，降低应用架构对品牌的耦合 |

### 4.1 `InteractionExecutionPolicy`

`SpeechModePolicy` 继续存在，但只是更上层策略的语音子策略。每次决策至少绑定：

```text
InteractionExecutionPolicy {
  task_stage / turn_boundary
  jurisdiction / data_residency / pii_class / risk_class
  language / dialect / modality / channel_quality
  latency / quality / cost / capacity budgets
  speech_mode / reasoning_path / workflow_path
  human_collaboration_mode / delivery_channel
  qualification_profile / policy_revision
}
```

`controlled_cascade`、`half_cascade`、`native_realtime` 等是 Speech 模式；deterministic
workflow、人工审批、人工接管和 SMS/IM 是执行或协作路径，不能塞进 Speech mode enum。
Policy 可在任务阶段或已提交的 turn 边界重新选择。正在播放或正在调用有副作用工具时禁止
无痕换路；先 fence/cancel 可取消输出。effect 为 Unknown 时保留稳定 Attempt 和 reconcile
handle，仍允许人工通信与 fenced owner handoff；只有重试、替换或复用该 effect 的 Action path
必须先 query/reconcile，且不得把 Unknown 宣称为成功。每次 execution path 改变都签发新
generation、lease、fence 和 selection receipt。Microsoft 的混合产品形态只支持这个设计方向，
不证明逐轮切换已经由外部产品替 Converact 完成。

### 4.2 Conversation Perception 是 observation，不是事实 Authority

SpeechRuntime 内建立 `ConversationPerception` 深模块，覆盖 audio conditioning、VAD、streaming
transcription、language/dialect/speaker、turn/EOT/interruption/hesitation/barge-in、quality 以及
可选的 prosody/fraud signals。每个输出必须带：

```text
kind + value
confidence + calibration_profile
source/model/config_revision
stream_generation + clock_span
tenant/privacy_class + provenance_digest
```

这些输出只是 `PerceptionObservation`。transcript 不自动成为客户事实，情绪、声纹或欺诈信号
也不能单独触发拒绝服务、Action 或所有权变更；高风险信号还需独立数据、合规、偏差和误报
资格。HF 是其中受控级联的 exact-source 候选，不因此成为 Perception 或 Agent Authority。

### 4.3 Human Collaboration、可信 Context 与 Evaluation

Participant capability 至少允许 Human `Owner/Supervisor/Approver/Expert/Observer` 和 AI
`Primary/Copilot/Specialist/QA/Translator/FraudDetector`。approval、advice、silent supervision、
temporary voice takeover、AI 继续受权 tool 工作和 AI resume 都使用显式 role、lease、scope、
generation 与 receipt；角色不改变 Call、Room、Agent、Action 或 Output Authority。

Context fact 的 epistemic state 固定为：

```text
observed -> inferred -> user_confirmed | system_confirmed | action_confirmed
```

状态不是线性自动升级。任何提升都要绑定来源、时间、主体、revision 和相应确认/Action
Receipt；model summary 不能覆盖已确认事实，冲突必须保留并进入 policy/human resolution。

G15 的 Evaluation/Governance 横跨 Perception、Agent、Action 和 Outcome，至少包含 replay、
simulation、regression、shadow/canary、A/B、policy/safety、rollback、cost 和 cohort drift。
它评估事实，不拥有被评估事实，也不能把 synthetic score 自动提升为生产资格。

## 5. 一级来源索引

- [LiveKit Pipeline Types](https://docs.livekit.io/agents/models/pipelines/)
- [LiveKit Telephony](https://docs.livekit.io/telephony/)
- [LiveKit Codec Negotiation](https://docs.livekit.io/reference/telephony/codecs-negotiation/)
- [Hugging Face speech-to-speech](https://github.com/huggingface/speech-to-speech)
- [Pipecat STT latency](https://docs.pipecat.ai/pipecat/fundamentals/stt-latency-tuning)
- [Daily voice-agent benchmark](https://www.daily.co/blog/benchmarking-llms-for-voice-agent-use-cases/)
- [Deepgram Flux](https://deepgram.com/learn/introducing-flux-conversational-speech-recognition)
- [OpenAI API pricing](https://openai.com/api/pricing/)
- [RFC 3551](https://www.rfc-editor.org/rfc/rfc3551.html)
- [RTPengine source and documentation](https://github.com/sipwise/rtpengine)
- [MCP 2026-07-28 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Anthropic MCP donation to AAIF](https://www.anthropic.com/news/donating-the-model-context-protocol-and-establishing-of-the-agentic-ai-foundation)
- [European Commission AI transparency rules](https://digital-strategy.ec.europa.eu/en/factpages/quick-facts-transparency-rules-ai-systems)
- [AWS Siemens case](https://aws.amazon.com/blogs/contact-center/how-siemens-handles-90-of-calls-autonomously-with-amazon-connect-customer-ai-agents/)
- [Genesys action-oriented orchestration](https://www.genesys.com/blog/post/how-genesys-and-scaled-cognition-are-shaping-the-future-of-agentic-orchestration)
- [Microsoft Copilot Studio real-time agents](https://learn.microsoft.com/en-us/microsoft-copilot-studio/voice-realtime-configure)
- [Amazon Connect agentic self-service](https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-connect-agentic-self-service/)
- [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart)
- [EU trustworthy AI rules](https://eur-lex.europa.eu/EN/legal-content/summary/rules-for-trustworthy-artificial-intelligence-in-the-eu.html)

这些链接只支持对应事实，不赋予 Converact production eligibility。价格、产品能力、协议和法规
会变化；每个未来 Qualification Profile 必须固定检索日期、版本和适用范围。

## 6. 采纳后的 Speech 架构

`SpeechModePolicy` 在每个 Speech session/generation 建立前，从以下模式选择：

| 模式 | 用途 | 生产前置 |
| --- | --- | --- |
| `human_only_bypass` | AI 不可用、未获授权、容量不足或 Profile 禁用 AI | 人工通信连续性 |
| `controlled_cascade` | 精确话术、审计、成熟工具调用、可替换 STT/LLM/TTS | 端到端 A/B；HF 是必须集成候选之一 |
| `half_cascade` | 保留音频理解或低延迟输入，同时控制最终 TTS 文本 | Provider capability 与 exact-script Gate |
| `native_realtime` | 优先自然度、语气理解和低延迟 | 指令、工具、审计、transcript、fallback Gate |
| `fused_asr_cascade` | 用融合式 ASR/turn 模型降低 endpoint 与误打断 | 独立 vendor/self-hosted 对比 Gate |

选择输入至少包括 tenant/Profile、channel、语言/方言、风险、披露/Consent、数据区域、
精确话术要求、tool mode、质量/延迟/成本预算、当前容量和已通过 Qualification Profile。

选择产生不可变 `SpeechModeSelectionReceipt`，绑定 policy revision、selected runtime/model/source、
fallback chain、reason codes、预算和证据身份。模式或 runtime 改变必须产生新 Speech generation；
Provider、HF、LiveKit Agents 或 Channel Agent 不能自行切换并继续沿用旧输出许可。

## 7. HF 的精确定位

HF `speech-to-speech` 是首个必须完成工程集成和资格化的自托管 exact-source
`controlled_cascade` 主干候选，只替换功能相同的 VAD/STT/LLM/TTS/streaming loop。

明确保留：

- RustPBX SIP/RTP/DTMF/REFER/Call/Media Plan；
- Active Call 的电话 channel、Playbook pure-local 能力和 typed proposal；
- LiveKit Room、Participant、Track、video/text/vision；
- LiveKit Agents 的 AgentSession、job、drain、Room-local workflow/handoff；
- Converact durable Task、ContextRevision、Policy、Handoff、Evaluation；
- Action Authority、Recording、Billing、Evidence 与 Consent。

`engineering_mandatory` 只表示必须集成、优化和测试，不表示 HF 未通过 Gate 时也强制承载生产流量。

## 8. 延迟、质量与容量证据

禁止用一个“500 ms”混合所有时钟。每次测量至少拆开：

- capture/network one-way；
- speech-end→endpoint commit；
- STT stable partial/final；
- LLM first token / first valid tool proposal；
- TTS first frame；
- first audible；
- complete turn gap；
- interruption detection→audible cutoff；
- Handoff trigger→human-ready→first-human-response。

每个结果必须按 channel、codec/sample rate、language/dialect、noise/loss/jitter、tool mode、
risk/Profile、source/model/config、hardware/provider locality 和 concurrency 独立签署。

特别禁止：

- STT TTFS 冒充完整 Speech E2E；
- PCMU 结果继承给 PCMA、G.729、G.722、Opus、AMR-WB 或 EVS；
- ordinary relay 结果继承给 transcode/decode/AI；
- 单模型 microbenchmark 继承给完整 Agent；
- 厂商成本或性能数据写成 Converact passed Evidence。

## 9. Action 与 MCP 边界

MCP、REST、SDK 和未来协议均位于 Tool Broker 后面。MCP Adapter 只负责：

- protocol version 与 capability negotiation；
- discover/catalog/schema 映射；
- server identity、tool metadata/schema digest 固定；
- 显式外部 state handle；
- 受限的 request/response transport。

它不拥有 Tool Policy、credential authorization、Task、ActionIntent、Attempt、Receipt、
Workflow 或外部业务事实。所有有副作用调用仍遵守：

```text
ActionProposal
  -> PolicyChecked
  -> Authorization
  -> ActionIntent
  -> ExecutionAttempt
  -> EffectObservation / Receipt
  -> query / reconcile / Verification
```

必须测试 version/capability downgrade、catalog drift、metadata/tool-description poisoning、
issuer/audience/scope、confused deputy、token passthrough、SSRF、timeout、disconnect 和 Unknown。
协议变为 stateless 不允许删除 Converact durable Task、Workflow、Action 或 Receipt。

## 10. Disclosure、Consent 与主动 Handoff

`DisclosureReceipt` 证明某个版本化披露已按指定语言、渠道、受众和政策送达，并记录政策要求的
确认方式。它不授权录音、转写、翻译、AI 分析、训练或跨区处理。

`ConsentLease` 对 participant、purpose、stream/data generation、processor、region 和期限授予
处理权限。它不是 AI 身份或录音提示已经送达的证明。两者必须独立版本、独立撤回和独立审计。

Handoff 除用户主动请求外，也可由版本化政策触发候选 prepare：

- 校准后置信度低于预注册阈值；
- 动作风险或政策要求人工；
- 连续 tool Unknown/failure；
- 延迟、队列或成本预算接近耗尽；
- 不支持的语言/方言或 Speech runtime；
- 安全命中或渠道质量持续恶化。

这些信号只能启动 prepare；owner/output/action 的改变仍通过 prepare/commit/abort/query/reconcile、
ResponseLease、generation、fence 和结构化 HandoffArtifact。情绪推断不能单独授权接管或动作。

## 11. Goal 映射

| Goal | 新增绑定内容 | 不改变 |
| --- | --- | --- |
| G10 | Disclosure Receipt、Consent 分离、人工主链、协作角色和主动 Handoff 基础合同 | 不要求 Speech/LLM 才能通信 |
| G12 | SpeechModePolicy、ConversationPerception、多路径、HF overlap-only、E2E/codec/VAD/方言/provider-exit 资格 | 不预设 HF 生产胜出，不把 observation 当事实 |
| G13 | InteractionExecutionPolicy、HandoffTriggerPolicy、跨渠道恢复、上下文完整性和旧输出 fencing | 只产生 ActionProposal；换路必须新 generation |
| G14 | MCP/REST/SDK Adapter、版本/能力、安全、Unknown reconcile | Action Authority 单写不变 |
| G15 | 可信事实状态、跨层 Evaluation、RAG/tool/citation poisoning、多步指令和 provenance cohort | Eval 不成为业务 Authority，summary 不成为事实 |
| G16 | provider exit、可携带、全成本、地区披露、协作连续性和 verified-resolution 指标 | Resolve V1 不冒充整个平台 |

G03–G08 不增加新开发范围。G03 继续完成 SIP/Call/Effect/Receipt；G04–G08 继续 G.729、
RTPengine、rvoip、Voice↔LiveKit 和通信资格。AI 不进入普通 SIP/RTP 热路径。

## 12. 状态

| 项目 | 当前 | Target | Production eligible |
| --- | --- | --- | --- |
| 研究主张 | 已审查 | 形成候选与拒绝清单 | `false` |
| SpeechModePolicy | 文档增补 | G12 实现和资格 | `false/not_run` |
| HF Controlled Cascade | 设计候选 | exact-source 集成与 A/B | `false/not_run` |
| Native/Half/Fused paths | 候选 | Profile 独立资格 | `false/not_run` |
| MCP Adapter | 文档增补 | G14 合同/安全/恢复 | `false/not_run` |
| 主动 Handoff | 文档增补 | G10/G13 实现与 Evidence | `false/not_run` |
| InteractionExecutionPolicy | 文档增补 | G13 实现并在 G12/G10 消费 | `false/not_run` |
| ConversationPerception | 文档增补 | G12 exact-source 实现与 cohort 资格 | `false/not_run` |
| 可信 Context 与跨层 Evaluation | 文档增补 | G15 contract、replay 和 Gate | `false/not_run` |
| 商业效果 | 文章主张不可继承 | G16 真实 Pilot | `false/not_run` |

## 13. 审查裁决

`accepted_as_research_input_with_binding_forward_amendment`。

开放 Critical/High 架构问题：`0`。外部数字和未执行能力不是关闭项，而是明确的 `not_run`；
不得因文档 accepted 将其提升为实现完成、客户可用或 production eligible。
