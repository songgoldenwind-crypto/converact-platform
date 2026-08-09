# ADR-CCAAS-12：Policy-driven Interaction、Speech、Tool Adapter 与 Action Authority

- 状态：**Accepted additive amendment**
- 日期：2026-08-09
- 决策 ID：`policy-interaction-speech-tool-adapter-action-authority-r2`
- Runtime verification：`not_run`
- Performance comparison：`not_run`
- Production eligible：`false`
- 依据：[IPPBX 行业研究审查](../architecture/2026-08-09-ippbx-contact-center-ai-industry-analysis-adoption-review.md)
- 适用：G10、G12、G13、G14、G15、G16

## 1. 优先级与纠错范围

本 ADR 是 additive forward amendment，不改写已经由 `goals/manifest.json` 冻结的历史文件。
发生冲突时，本 ADR 对下列问题具有更高优先级：

1. `HF speech-to-speech 是目标主实现`解释为：首个必须工程集成和资格化的自托管
   `controlled_cascade` 主干候选，不是所有 Profile 的无条件生产默认。
2. Agent Runtime/AI-native Orchestrator 只拥有 `ActionProposal`；历史文本中把
   `ActionIntent`、idempotency ledger 或 Action Ledger 归给 Orchestrator 的表述失效。
3. MCP/REST/SDK 都是 Tool Broker 后的协议 Adapter，不能成为 Task、Workflow、Action 或
   external effect Authority。
4. AI/录音身份披露与 processing Consent 是不同事实，不能复用一个布尔值或 Receipt。

本文不改变 G03–G08 的 Authority、依赖、状态、Evidence 或执行顺序。

## 2. Authority

| 事实 | 唯一 Authority | Adapter/执行器不得拥有 |
| --- | --- | --- |
| Call/Leg/Route/CDR/Media Plan | Unified RustPBX | Speech、Agent、MCP |
| Room/Participant/Track/WebRTC/SFU | LiveKit | RustPBX、Speech、Agent |
| Interaction/Speech policy 与 canonical selection record | Converact Agent Runtime | HF、Provider、Channel Agent、SpeechRuntime |
| AgentRun/Task DAG/ContextRevision/ResponsePlan/Handoff/Evaluation | Converact Agent Runtime | LiveKit Agents、Active、HF、LLM |
| ActionIntent/Authorization/Attempt/Observation/Receipt/Reconcile/Compensation | Converact Engage Action Authority | Agent Runtime、Tool Broker、MCP server |
| 外部 CRM/FSM/PBX 的实际目标状态 | 对应外部系统 | Converact projection/receipt |
| Disclosure policy/evidence 与 ConsentLease generation | Converact Platform Consent/Policy | Provider session、UI local flag、Agent prompt |
| Append-only disclosure/selection/action audit fact | Converact Platform Audit | domain audit SDK/store、runtime log |

以上名称复用 G02 和 `PROGRAM-RULES.md` 已冻结的 Authority。`ConversationPerception`、
`SpeechModePolicy`、`Trusted Action Plane` 和 Human Collaboration 都是 bounded module、policy、
record 或解释性能力名，不创建新的 writer/Authority。

Agent Runtime 可评估 policy、选择 tool capability 并提出 `ActionProposal`，但不能创建最终
ActionIntent、签发 Authorization、写 Effect truth 或在 Unknown 时盲重试。

## 3. `InteractionExecutionPolicy` 与 `SpeechModePolicy`

`InteractionExecutionPolicy` 是 Converact Agent Runtime 已有 Policy Authority 内的版本化
策略，不是独立 Router Authority。它在任务阶段或已提交 turn 的边界选择：

```text
task_stage / turn_boundary
speech_mode
reasoning_path
deterministic_workflow_path
human_collaboration_mode
delivery_channel
policy + qualification revisions
```

输入至少包括 task、language/dialect、jurisdiction、data residency、PII/risk class、modality、
tool requirements、channel quality、latency/quality/cost/capacity budget 和可用资格。
deterministic workflow、人工审批/接管和 messaging channel 是执行或协作路径，不是 Speech
mode。外部产品支持多种模式不等于已证明逐 turn 切换；Converact 必须自行实现和验证。

Policy 只能在显式 boundary 改变路径。正在播放音频或调用有副作用 tool 时，不允许隐式换路
并沿用旧 state；可取消的输出先按 fence cancel。Effect 为 Unknown 不得阻塞人工通信或
AI→Human owner handoff：把稳定 Attempt/Unknown/reconcile handle 写入 HandoffArtifact 后可创建新
response generation。只有重试、替换或复用该 effect 的 Action path 必须先 query/reconcile，
且任何路径都不得把 Unknown 宣称为成功。每次 execution path 改变均创建新的
`InteractionExecutionSelectionReceipt`、generation、lease 和 fence。

### 3.1 `SpeechModePolicy`

每个 Speech session/generation 必须在创建前选择一个模式：

```text
human_only_bypass
controlled_cascade
half_cascade
native_realtime
fused_asr_cascade
```

Policy 输入至少包括：

- tenant、Profile、Offer、channel 与 region；
- language/dialect、codec/sample rate 和 channel quality；
- AI identity disclosure 与每个 processing purpose 的 ConsentLease；
- exact-script、audit、transcript、tool maturity 和 action risk；
- latency、quality、cost、capacity 和 data-residency budget；
- runtime/model/source qualification、health 和 provider-exit availability。

结果写入不可变 `SpeechModeSelectionReceipt`：

```text
selection_receipt_id
policy_revision + policy_digest
input_digest + reason_codes
selected_mode
runtime/model/source revisions
fallback_chain
qualification_profile_id
latency/quality/cost budgets
disclosure_receipt_refs
consent_lease_refs
speech_generation
```

Provider、HF 或 Channel Agent 不能自行改变模式。模式、runtime、model、region、fallback 或
资格身份改变时必须创建新 selection receipt 和新 Speech generation；旧 ResponseFence 不得复用。

Fallback 只可选择 policy 中预先允许且已经资格化的路径，不能跨 tenant、region、Consent、
exact-script 或 action-risk 边界。所有 AI 路径不可用时回到 `human_only_bypass`，不能阻塞主通信。

## 4. HF overlap-only 决策

HF `speech-to-speech` 固定为首个必须完成的 self-hosted exact-source
`controlled_cascade` 实现和 consolidation candidate。它只替换：

- acoustic VAD（当本 generation 被选为唯一 producer）；
- streaming/final STT；
- streaming LLM execution；
- streaming TTS；
- 与上述执行直接对应的 normalized realtime events。

它不替换 Call/Room、codec、DTMF、Channel Agent、LiveKit job/AgentSession、durable Task、
ContextRevision、Handoff、Action Authority、Recording、Evidence、Billing 或 Consent。

`engineering_mandatory` 不等于 `production_default`。如果 HF 未通过功能、质量、延迟、容量、
故障、安全或成本 Gate，保留 normalized contract 并继续使用通过资格的 native/managed path；
失败项保持 `failed/not_run`，不得降低门槛。

## 5. Conversation Perception 边界

`ConversationPerception` 是 SpeechRuntime 内部的深模块和 observation producer，不是新服务
Authority。它可组合：

- denoise、AEC、resample 与输入质量；
- VAD、streaming transcription、language/dialect/speaker 与 calibrated confidence；
- EOT、interruption、hesitation、continuation、barge-in 与 word timing；
- 可选 prosody、fraud 和 acoustic quality signals。

每个 `PerceptionObservation` 必须绑定 source/model/config revision、stream generation、clock
span、confidence/calibration、privacy class 和 provenance digest。transcript、speaker guess、
emotion、fraud score 与 model summary 都不是 customer/business fact，不能直接创建
ActionIntent、改变 owner 或覆盖已确认 Context。高风险观察必须独立通过数据权利、偏差、误报、
地区合规和 cohort Gate；无法证明时保持 `not_run` 或禁用。

## 6. 资格与指标

资格分两层：

1. `adapter_overhead`：固定相同模型、量化、硬件、语料、网络、prompt/tools、并发和时钟，
   只比较 Adapter/Runtime 开销。
2. `mode_frontier`：每个模式使用自己的最佳 exact-source 配置，但固定相同功能、输入、
   质量阈值、硬件预算、网络区域、并发和统计合同。

指标至少包含：

```text
network one-way
speech-end -> endpoint commit
STT stable partial/final
LLM first token / valid tool proposal
TTS first frame
speech-end -> first audible
complete turn gap
interruption -> audible cutoff
WER/CER + exact-script adherence + task/action correctness
CPU/GPU/VRAM + queue/drop + safe concurrency + total cost
```

结果按 channel、codec/sample rate、language/dialect、noise/loss/jitter、tool/action mode、
risk/Profile、hardware/provider locality 分开。组件 TTFS、厂商 benchmark、PCMU、ordinary relay
或 bridge-excluded 结果不得跨 profile 继承。

## 7. Disclosure 与 Consent

`DisclosureReceipt` 证明版本化内容已按 policy、language、channel 和 audience 送达，并记录
适用的 displayed/played/acknowledged 方式。AI identity、recording disclosure 和 handoff notice
可以是不同 Receipt。

`ConsentLease` 对 participant、purpose、data/stream generation、processor、region 和期限授权。
录音、转写、翻译、AI analysis、training 和 cross-region processing 分别处理；撤回后按 fence
停止对应处理和派生输出。

不变量：

- Disclosure 不授予 processing 权限；
- Consent 不证明已经披露；
- 一个全球固定开场白不能代替地区/用例 policy；
- 法律判断只限制适用地区的 enablement，不删除工程合同。

## 8. 主动 Handoff 与 Human Collaboration

`HandoffTriggerPolicy` 可基于用户请求、校准置信度、动作风险、policy/safety、连续 tool
Unknown/failure、延迟/队列/成本预算、语言能力和 channel quality 产生：

```text
continue | prepare_human | require_human | degrade_human_only
```

触发结果只是 `AgentHandoffDecision`，不能直接撤销 owner、播放新输出或重复外部动作。
执行仍使用 durable prepare/commit/abort/query/reconcile、ResponseLease、generation、fence、
HandoffArtifact 和 Action unknown-state reconciliation。

必须测量：

- trigger→human-ready；
- trigger→first-human-response；
- offer/accept/commit 成功率；
- media gap/loss 与 stale output；
- Handoff context completeness 和 customer re-ask；
- duplicate/unknown action；
- rollback/reconcile time；
- abandonment。

情绪识别只能作为辅助信号，不能单独授权接管、拒绝服务或副作用。

Participant capability 允许 Human `Owner/Supervisor/Approver/Expert/Observer` 与 AI
`Primary/Copilot/Specialist/QA/Translator/FraudDetector`。approval、advice、silent supervision、
temporary voice takeover、AI 继续获批的 tool 工作和 AI resume 都必须显式声明 role、scope、
lease、generation、Output/Action permission 与 receipt。角色不是 Authority；临时语音 owner
也不能绕过 Engage Action Authority，AI tool execution 也不能绕过当前 Authorization。

## 9. MCP/REST/SDK Tool Adapter

Tool Adapter 位于 Action Authority 与外部系统之间：

```text
Agent/Human -> ActionProposal
  -> Action Authority
  -> Tool Broker
  -> MCP | REST | SDK Adapter
  -> external system
```

MCP Adapter 必须：

- 显式协商 protocol version 与 capabilities；
- 允许预先冻结且有截止日期的兼容窗口，禁止静默 downgrade；
- 绑定 server identity、catalog/tool metadata/schema digest 与显式 state handle；
- 校验 credential/token issuer、audience、tenant、target、scope、expiry、region；
- 禁止 ambient authority、未授权 token passthrough 与 confused-deputy 代理；
- 限制 URL、redirect 和 resource fetch，防 SSRF；
- 对 catalog drift、metadata/tool-description poisoning、schema drift fail closed；
- timeout/disconnect/缺少有效 Receipt 时返回 Unknown 并按固定策略 query/reconcile。

MCP 2026-07-28 的 protocol-level stateless 语义不改变 Converact durable Task、Workflow、
ActionIntent、Attempt、Receipt 或 external target state。Tool Adapter 不能绕过 Action Authority。

## 10. Context 事实状态与跨层 Evaluation

`ContextRevision` 中的候选事实必须标记 epistemic state：

```text
observed | inferred | user_confirmed | system_confirmed | action_confirmed
```

任何状态提升都绑定 source、subject、time、revision 和 confirmation/Action Receipt；状态不是
自动线性升级。transcript 与 model summary 只是来源/projection，不能覆盖 confirmed fact。
冲突必须并存并进入 Policy 或 Human resolution，不能静默选一个。

G15 的 Evaluation/Governance 横跨 Perception、Agent、Action 与 Outcome，包含 replay、
simulation、regression、shadow/canary、A/B、rollback、policy/safety、cohort drift、cost 与
verified resolution。Evaluation 只产生 assessment/evidence，不写客户事实、Action effect 或
production eligibility；后者仍由冻结 Gate 签署。

## 11. Codec 与媒体边界

传统 PSTN 窄带不是平台全局 codec 限制。资格至少区分 PCMU、PCMA、G.729、G.722、Opus；
ViLTE/future profiles 另区分 AMR-NB、AMR-WB 和 EVS。一个 codec/sample-rate 的结果不能继承
给另一个。

普通 RTP/SRTP 优先 RTPengine fast path。只有必须转码、解码、混音、录音 tap 或 AI tap 的
Edge 才进入 decoded-media path；每个 codec pair、方向、ptime、implementation、CPU/SIMD 和
concurrency 单独测量。任何“每路转码固定占单核百分比”的外部泛化数字都不是容量 Evidence。

## 12. 故障与降级

- Speech/Agent/GPU/Provider 故障只停止相应 generation，Human Call/Room 继续；
- Tool Adapter 故障不终止通信，Unknown 不盲重试；
- Disclosure service 不可确认时，受约束的 AI 输出 fail closed，人工通信继续；
- Consent 不可确认或撤回时，对应 processing/output fail closed；
- Handoff prepare 失败保留旧合法人工/通信 owner，不产生双输出；
- queue、retry、fallback、fan-out 和兼容窗口全部有界。

## 13. 被拒绝的方案

- HF、LiveKit Agents、Active 或任一 Provider 成为全局唯一 Speech/Agent Authority；
- 以厂商延迟、成本、转码 CPU、WER 或 containment 数字签署 Converact Gate；
- 把 8 kHz PCMU 固化为全部渠道和未来 ViLTE 的唯一格式；
- 把 MCP server/session/tool catalog 当 Task、Action 或 Workflow truth；
- Agent Runtime 直接执行副作用或写 Action Ledger；
- 用 disclosure 替代 consent，或用 consent 替代 disclosure；
- 为追求低延迟让 AI、tool、数据库进入 ordinary RTP 热路径。
- 把 Microsoft/AWS 的多路径产品能力写成逐 turn 动态切换已经通过 Converact 验证；
- 把 `Conversation Perception`、`Trusted Action Plane`、Human Collaboration 或 Evaluation
  变成第二 Agent/Action/Context Authority；
- 把 transcript、summary、emotion、fraud score 或 synthetic evaluator score 当成已确认事实。

## 14. 执行映射

本 ADR 通过
`goals/amendments/2026-08-09-ai-speech-action-program-amendment-v1.json`
绑定到 G10、G12、G13、G14、G15 和 G16。未来 `create_goal` 必须同时携带原 Goal SHA-256 与
该 amendment SHA-256；resolver 只追加条款，不允许修改原依赖、状态、顺序或 Authority。

G03 当前执行不受本 ADR 影响。所有新增实现、性能、合规和商业结论在对应未来 Goal 运行前
保持 `not_run`。

## 15. 后果

收益：

- 低延迟、审计、精确话术、成本和供应商自由可以按 Profile 平衡；
- HF 工程要求与生产择优不再冲突；
- Action truth 不会因 Agent framework 或 MCP 变化分裂；
- Disclosure、Consent 和 Handoff 可独立审计；
- execution path、Perception observation、Context fact 和 Human collaboration 可独立追踪；
- 外部行业数字不会污染通信性能和商业 Evidence。

成本：

- 需要多模式合同、Adapter 和更大的资格矩阵；
- 迁移期保留多个受控执行路径；
- MCP 多版本兼容、安全测试和 provider-exit 演练增加前期工作；
- 每种模式、codec、语言和渠道必须独立收集 Evidence。
