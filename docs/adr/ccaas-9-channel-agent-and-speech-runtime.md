# ADR-CCAAS-9：Channel Agent Runtime、HF Speech Runtime 与 AI-native Authority

- 状态：**Accepted for staged implementation**
- 日期：2026-07-31
- 决策 ID：`channel-agent-speech-runtime-r1`
- 适用范围：Telephony/LiveKit/未来 ViLTE Agent、实时翻译、HF
  `speech-to-speech` 与 AI-native
- Runtime verification：`not_run`
- Performance comparison：`not_run`
- Production eligible：`false`
- 依赖：
  [Revision 5 总设计](../design/unified-communication-foundation-r5.md)、
  [ADR-CCAAS-7](./ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)、
  [ADR-CCAAS-8](./ccaas-8-voice-livekit-bridge-handoff.md)
- Supersedes：
  旧文档中“LiveKit Agents 或 `ai-agent-py` 是全部渠道唯一 Agent/session
  Runtime”的实现假设；不替换其已实现、仍有价值的 channel-local 能力

## 1. 背景

Converact Platform 当前有三类重叠但不相同的能力：

1. 现有 `ai-agent-py`/LiveKit Agents 链负责 Room voice Agent，并通过 Provider plugin
   拼装 STT、LLM、TTS；
2. Active Call 是 Rust voice-agent framework，具有 SIP/WebRTC/Voice WebSocket、
   电话媒体、Playbook、DTMF、REFER、bridge、interrupt 和本地/外部 AI pipeline；
3. Hugging Face `speech-to-speech` 提供模块化
   `VAD → STT → LLM → TTS` 和 OpenAI Realtime-compatible API。

如果任选一个整体替换其他两个，会丢失非重叠能力；如果三套都各自维护 VAD、turn、Agent
state、tool 和 Provider，会产生：

- 同一用户 turn 被多次提交；
- 两套 TTS 同时说话；
- SIP↔LiveKit 切换后旧 Agent 继续执行；
- tool side effect 重复；
- Task/Memory 在 channel 间丢失；
- 供应商和 framework 类型渗透业务代码；
- 端到端延迟无法归因；
- AI worker 故障回压主通话。

用户明确要求：

- HF 只替换 Active Call、LiveKit Agents 和现有 Python 链中功能相同的部分；
- 不同功能全部保留；
- 主要目标是降低转写→模型→合成的端到端延迟；
- 不能因为 AI、录音或单个功能故障影响通话；
- AI-native 不能退化成只做 STT/TTS。

## 2. 决策

采用四层模型：

```text
Communication / Channel
  RustPBX voice | LiveKit Room | future ViLTE
        |
Channel Agent Runtime
  Telephony Agent | Room Agent
        |
Converact Platform SpeechRuntime
  HF primary target | native baseline adapters
        |
Converact Platform AI-native Orchestrator
  Task | Tool | Memory | Policy | Approval | Action Ledger | Evaluation
```

### 2.1 Channel Agent Runtime

**Telephony Agent Runtime**

- 以 pure PCM/canonical-event adapter 复用 Active Call 的
  Agent/Playbook/interrupt/AGC/denoise 等独特能力；
- 作为 RustPBX `voice-media-rs` 的 AI Media Endpoint，不运行第二套 SIP/RTP；
- 不直接接受 Carrier trunk，不成为第二 PBX；
- 不拥有主 SIP/RTP、Call、CDR、billing 或 root RecordingManifest；
- DTMF 只消费 RustPBX canonical event；REFER/MESSAGE/hangup/mute/bridge/transfer
  只生成 typed proposal，由 RustPBX 在当前 fence 下执行；
- Playbook scene/goto/local variable/prompt 属于 pure-local allowlist；HTTP/tool/posthook
  交 Converact Platform Tool Broker，生产禁止任意 URL/direct effect executor；
- 可运行于独立受监管 worker，以免 OOM/native crash 影响 Call Core。

**Room Agent Runtime**

- 使用 LiveKit Agents 的 participant/track、AgentSession、multimodal、task/workflow、
  tools、handoff、job dispatch、load balancing 和 drain；
- 不拥有跨 SIP/LiveKit/IM/ViLTE durable Task/Memory/Policy；
- 不成为 RustPBX telephone AI 的必经路径。

### 2.2 Speech Runtime

建立 Converact Platform-owned `SpeechRuntime` contract。HF `speech-to-speech` 是目标主实现，native
Active/LiveKit/current provider chain 是迁移和 A/B baseline。

HF 只替换：

- acoustic VAD（仅在该 session 被选为 producer 时）；
- streaming/final STT；
- streaming LLM execution；
- streaming TTS；
- 与上述执行直接对应的 Realtime events。

HF 不替换：

- RustPBX SIP、RTP、codec、canonical DTMF 和电话动作执行；
- Active Playbook 的 pure-local scene/variables/prompt 与 proposal 语义；
- LiveKit Room、track、participant、video/text/vision；
- LiveKit AgentSession、task/workflow/handoff/job server；
- channel interruption policy；
- Converact Platform Task、Tool、Memory、Policy、Approval、Action Ledger、Evaluation；
- Provider governance、consent、captions projection；
- recording、CDR、billing。

### 2.3 AI-native Authority

Converact Platform AI-native Orchestrator 是以下事实的唯一 Authority：

- durable AgentRun；
- Task DAG 和 completion；
- memory revision、canonical ContextRevision 与 ResponsePlan；
- policy/guardrail/approval；
- tool capability 与 action intent；
- idempotent Action Ledger；
- human/channel handoff；
- evaluation 和 cost attribution。

LLM、Active Playbook 或 LiveKit workflow 的 tool/communication action 只是 proposal。
任何副作用必须先经过 schema、当前 lease/fence、policy、approval 和 ledger。

## 3. 为什么不是三选一

| 方案 | 结果 | 决定 |
| --- | --- | --- |
| 全部使用 Active Call | 电话强，但 Room video/multimodal/job/workflow 边界不足 | 拒绝整体替换 |
| 全部使用 LiveKit Agents | Room 强，但电话 AI 被迫绕 Room，RustPBX 产生第二 channel state | 拒绝全渠道唯一 |
| 全部使用 HF | HF 是 speech pipeline，不是完整 channel/Agent/AI-native framework | 拒绝整体替换 |
| 三套并列自治 | VAD、turn、tool、memory、TTS 多 Authority | 拒绝 |
| Channel-native runtime + shared SpeechRuntime + Converact Platform Orchestrator | 保留非重叠能力并统一 durable state | **采用** |

## 4. `SpeechRuntime` 合同

### 4.1 生命周期

```text
prepare
  -> prepared_blocked
  -> commit
  -> active
  -> response generation(s)
  -> cancel/reconfigure
  -> close
  -> terminal receipt
```

所有 mutation 携带：

- tenant ID、InteractionId、AgentRunId；
- SpeechSessionId、session generation；
- channel binding 和 media generation；
- owner epoch、SpeechControlFence；
- 产生/改变输出的命令另带 ResponseLease/ResponseFence；
- idempotency key、request digest；
- deadline 和 trace root。

控制面 timeout 后调用 `query`/`reconcile`，不能创建新 session 猜测旧 effect。

规范 lifecycle/API 至少包括：

```text
prepare / commit
try_write_audio
commit_turn
create_response
submit_tool_result
subscribe_events
renew_response_lease / revoke_response_lease
cancel_response
close
query / reconcile
```

`SpeechControlFence` 保护 session/resource lifecycle；`prepare` 可以在尚无新
ResponseLease 时只做 local blocked prepare，但仍必须验证当前 control owner。
`ResponseFence` 保护 turn、response、tool result、cancel 以及可听/可见/副作用输出。
除 `query` 和已验证 cursor 的 `subscribe_events` 外，所有 mutation 都校验
SpeechControlFence；output-affecting mutation 同时校验 ResponseFence。范围包括
prepare、commit、audio write、turn commit、response create、tool-result injection、
lease renew/revoke、cancel、close 和 reconcile；旧 owner 不能靠延迟命令恢复。

`create_response` 只接受 Converact Platform Orchestrator 签署的 `ResponsePlan`，至少绑定：

- ContextRevision/context digest/memory revision；
- policy、tool catalog 与 capability revisions；
- tool schemas；
- model/profile 与 latency/cost budget；
- ResponseLease、response generation 和 fence。

`submit_tool_result` 必须回到相同 Interaction、AgentRun、ContextRevision 和 response
generation。若任一 generation/fence 已失效，结果只做 durable audit/reconcile，不恢复模型。

### 4.2 Audio input

- `try_write_audio` 同步、非阻塞；
- 只返回 `accepted`、`dropped_overflow`、`closed`；
- frame 有 sequence、monotonic capture time、encoding、sample rate、channels；
- queue、prestart buffer 和 replay window 有界；
- raw PCM 不进数据库、普通日志或消息总线；
- queue overflow 只降级 AI，不影响 Call/Room。

### 4.3 Output

normalized output 至少包括：

```text
speech_started / speech_stopped
transcript.partial / transcript.final
turn.committed
response.created
response.text.delta
response.audio.delta
response.tool_call
response.cancelled / response.done
usage.reported
session.degraded / failed / closed
```

旧 ResponseLease/generation 的 audio、text、tool call 一律丢弃并计数。

Active/LiveKit/HF/Provider 的 framework-local chat/history 只是可丢弃 projection/cache；
canonical conversation state 是 Converact Platform Orchestrator 的 `ContextRevision`。Handoff 或 context
commit 后 revision 单调递增，旧 revision 不得创建新 response。

## 5. VAD、Turn 和 interruption

一个 session 只有：

- 一个 acoustic VAD producer；
- 一个 turn commit Authority；
- 一个 response cancel Authority。

推荐：

- Telephony：用相同 8 kHz/16 kHz 语料比较 HF Silero、Active TinySilero/ONNX 和
  WebRTC VAD；Telephony Agent policy 决定最终 turn；
- LiveKit：保留 LiveKit audio turn detector 作为高层 turn signal，HF 内建 VAD
  关闭、旁路或只作 shadow；
- realtime model：模型内置 turn detection 与外部 detector 二选一。

如果 HF 上游不支持 external turn commit/VAD bypass，controlled fork 必须补齐后才可
集成。不能用两套 server VAD 同时 commit。

## 6. ResponseLease 与 Channel Handoff

```text
ResponseLease {
  interaction_id
  agent_run_id
  channel_binding_id
  lease_generation
  response_generation
  owner_epoch
  fence
  state
  issued_at_wall
  expires_at_wall
  lease_duration
}
```

唯一签发 Authority 是 `Converact Platform Interaction Lease Store`。issue/renew/revoke/handoff 都用
`interaction_id` 做 durable CAS，并递增不可回退的 fence。wall clock 表达可持久化 expiry；
executor 从 receipt 派生本机 monotonic deadline，不跨主机比较 monotonic time。

持有 lease 的 Channel Agent 才能：

- 提交 turn；
- 播放/发布 TTS；
- cancel response；
- 提交 communication action proposal；
- 提交 tool proposal；
- 写最终可听 transcript。

audio injector、LiveKit publisher、RustPBX communication-action executor、Tool Broker、
transcript sink 使用本地 `O(1)` `OutputPermit` 检查 lease generation、response
generation 与 fence；不能每帧访问 durable store。RustPBX communication action 在
reserve/execute/receipt 三处同时验证 permit 与幂等键。permit 到期、撤销或 issuer
不可确认时，Agent output/action fail closed，主 Call/Room media 继续。

SIP↔LiveKit 切换：

1. prepare 新 Channel Agent；
2. 保存相同 Interaction/Task，生成或确认新 ContextRevision；
3. CAS revoke 旧 lease，生成 vacant fence，并让所有 mandatory output gate 拒绝旧 fence；
4. cancel 旧 Speech generation，等待旧 channel 的 zero-output/terminal receipt；
5. CAS 从 vacant 签发新 ResponseLease；
6. 新 gate 确认 permit 后，新 channel 才恢复；
7. reconcile stale events、tool attempts 和最终 transcript。

首期是 break-before-make，不承诺零 gap，但禁止双播/双 action。只有多 sink 原子 fence
证据通过并由新版本合同授权后，才允许 make-before-break。

## 7. HF 采用与证据

### 7.1 采用理由

- 一个明确的开源 speech pipeline 主干；
- 可替换、本地/自托管/兼容 Provider backend；
- 可受控 fork 并针对 Converact Platform 语料优化；
- Telephony 和 LiveKit 可共享 normalized contract；
- 更容易统一 latency、cancel、trace、model identity 和 A/B。

### 7.2 不能提前声称的结论

当前没有可直接证明以下结论的官方 apples-to-apples 数据：

```text
HF < Active latency
HF < LiveKit Agents latency
HF VAD > Active/LiveKit VAD
HF quality >= current providers
```

全部保持 `not_run`。HF 的“low-latency”定位是候选输入，不是 Converact Platform production evidence。

### 7.3 A/B 门禁

分两类测试：

1. `framework-overhead`：模型、量化、Provider/locality、硬件、语料和输入完全相同，
   只比较 native 与 HF adapter 的框架成本；
2. `production-frontier`：每个候选采用自身最佳且 exact-source 固定的生产配置，比较最终
   latency、质量、成本、容量和恢复。

两类共同固定 channel semantics、test corpus、measurement clocks 和结果统计方法。
其中 `framework-overhead` 还必须固定：

- hardware/GPU/CPU；
- models/quantization；
- audio corpus/sample rate；
- network/provider locality；
- prompt/tools；
- concurrency；
- measurement clocks。

`production-frontier` 允许双方使用各自最佳的 exact-source model、quantization、
placement/provider locality 和 runtime tuning，但必须在同硬件预算、同 corpus、同
channel input、同 concurrency envelope、同质量门槛和同 measurement clocks 下比较；
任何差异都写入 Qualification Profile，不能把模型收益冒充 adapter overhead。

比较：

```text
Active native vs Active + HF
LiveKit native vs LiveKit + HF
```

指标：

- endpoint、STT final、LLM TTFT、TTS first audio；
- speech-end→first audible p50/p95/p99；
- barge-in cutoff/stale audio；
- WER/CER、翻译质量、task completion、MOS；
- CPU/GPU/VRAM/session；
- queue/drop/cancel；
- concurrency/admission；
- 30m/2h/24h；
- worker crash/restart/drain。

运行前每个 Qualification Profile 必须已有数字化绝对 SLO；缺失 threshold 时结果保持
`not_run`，禁止看完结果再补门槛。相对门禁预先冻结为：

- 功能、lease/context/tool、cancel、fallback 与通信连续性必须全通过；
- framework-overhead：HF p95 ≤ native × 1.05，p99 ≤ native × 1.10；
- CPU/GPU/VRAM/session ≤ native × 1.10，safe capacity ≥ native × 0.95；
- WER/CER、翻译质量、MOS、false endpoint/interruption 在预注册置信区间内非劣；
- stale audio、cancel 与 crash recovery 不劣于 baseline，并满足绝对 SLO；
- production-frontier：HF 成为默认主路径需 speech-end→first-audible p95 至少改善 10%，
  p99 不劣于 5%，质量非劣，safe capacity ≥ 95%，且无关键功能/故障门禁回退。

若 HF 不通过：

1. 先优化 controlled fork、模型、placement 和 streaming；
2. 保留 adapter contract；
3. 继续使用该 channel 的 native baseline；
4. 不允许因“必须使用 HF”牺牲生产指标；
5. 未通过项保持 `not_run/failed`，不得篡改门槛。

“HF engineering adoption mandatory”表示必须完成集成、优化和资格化，不表示未通过也强制
承载生产流量。

## 8. 故障语义

| 故障 | Channel media | Agent/Speech |
| --- | --- | --- |
| tap queue full | 继续 | 丢 AI frame，告警/重建 |
| HF OOM/crash | 继续 | generation failed，转人工或 native fallback |
| STT timeout | 继续 | retry/fallback，不猜 transcript |
| LLM timeout | 继续 | 模板/人工，不执行 tool |
| TTS timeout | 继续 | text-only/人工 |
| tool unknown effect | 继续 | query ledger/target，不重复执行 |
| memory store unavailable | 继续 | 高风险动作 fail closed |
| Agent worker restart | Call/Room 继续 | 新 generation 恢复 |
| eval/analytics down | 继续 | 异步补算 |

任何 AI 队列、Provider、数据库或 GPU 都不能反压主媒体。

## 9. 安全和供应链

- HF、Active Call、LiveKit Agents、模型和 native libs 全部 exact-source；
- OpenAI-compatible 只是 adapter 兼容，不是 Converact Platform 业务领域协议；
- HF Realtime endpoint 前必须有 Converact Platform auth、tenant、quota 和 rate limit；
- Provider secret 不发给 channel client；
- tool schema 和 policy digest 绑定 session；
- model/tool/audio metadata 不泄露 PII、raw prompt、PCM 或 token；
- output injection 必须验证 ResponseLease、generation、tenant 和 purpose；
- AI participant disclosure、recording consent、retention 和 data region 必须执行。

## 10. 后果

正面：

- 保留 Active Call、LiveKit Agents 和 HF 各自最强能力；
- 业务不绑定 framework/provider；
- Telephone AI 不绕 LiveKit；
- 跨 channel Task/Memory/Tool 连续；
- AI 故障与通信隔离；
- 延迟和质量可同口径 A/B。

成本：

- 需要 Converact Platform-owned adapter、lease、event 和 Action Ledger；
- 需要维护 HF controlled fork 的可能性；
- 两个 channel runtime 仍需分别回归；
- 进程隔离增加一次本地 media hop，必须测量复制与排队成本；
- 初期保留 native baseline，存在受控的迁移期重复代码。

## 11. 最终裁决

Active Call 与 LiveKit Agents 都保留为 channel-native Agent Runtime；HF
`speech-to-speech` 成为功能重叠 speech pipeline 的目标主干；Converact Platform AI-native
Orchestrator 拥有跨渠道 durable 业务状态。三者不能互相越权。

文档 Accepted 不代表 HF 已更快、VAD 已更好或生产已启用。所有性能、质量、故障和长稳
结论在真实 A/B 前保持 `not_run`。
