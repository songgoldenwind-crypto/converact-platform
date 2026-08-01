# Goal 12 — HF SpeechRuntime Core、VAD 资格与 Resolve B1 翻译

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G12` |
| 初始状态 | `not_run` |
| 前置 Goal | Core：G09、G10；Resolve B1：另需 G11 `completed`；Native/Bridge Speech adapter qualification：另需 G08 `completed` |
| 解锁 | `speech_runtime_core_completed` 解锁 G13/G15；`resolve_b1_completed` 解锁 G16 |
| Authority | SpeechRuntime 只拥有实时语音处理；Translation 不是业务 Agent |
| 主要来源 | [平台 R2 §6、§9–§12](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[ADR 9](../docs/adr/ccaas-9-channel-agent-and-speech-runtime.md)、[通信 R5 S0–S2](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md)、[Resolve Profile R1 §10.1–§10.2](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

建立统一、可替换、可观测的 `SpeechRuntime`，将 Hugging Face
`huggingface/speech-to-speech` 作为首个自托管 exact-source 实现和评测基线，只替换
Active Call、LiveKit Agents 与旧 Converact 链路中功能相同的 VAD→STT→LLM→TTS/流式语音循环。
Room/Participant、channel、worker、plugin、telemetry、agent lifecycle、tool orchestration、
handoff 和产品流程等非重叠能力全部保留或显式迁移，未通过 parity test 不得删除。

Horizontal Core 完成不依赖 Native RustPBX/100K，也不依赖 Resolve Pilot 的真实 Provider/CRM。
Resolve Profile 另有必验 B1：基于双声道 receive-only fork 的中文↔英文字幕与文字翻译；只有 G11 完成后才能签署
真实 B1。首期不向外部电话回注 translated TTS，Translation 不拥有 Engagement、
Resolution、Action 或客户输出 Authority。

## 3. Required outcomes

1. 固定 HF exact repository/commit、dependency/model/container/GPU/runtime/license、patch、
   build 和 SBOM；禁止浮动 upstream。
2. 冻结 SpeechRuntime lifecycle/events：start/update/interrupt/stop、audio/time mapping、
   partial/final、turn、barge-in、caption/translation/TTS frame、error/degraded、usage/cost。
3. 支持 Controlled Cascade、Native Realtime、Half Cascade、Human-only Bypass；HF、
   managed Realtime 和现有路径都经 adapter，不把产品写死。
4. 建立 capability inventory，逐项记录 `same_function_as_HF_speech_loop`、retain/adapt/
   replace/retire、parity test 与 rollback。
5. 先实现 bounded ChannelAudioAdapter contract、fake/audio-corpus harness 与 LiveKit/telephony
   adapter seam；RustPBX 只提供媒体/session events，不嵌入 Python Agent state。真实 Native
   telephony/Voice-LiveKit adapter 必须在 G08 后单独 qualification，Resolve B1 可使用 G11
   已冻结的外部 provider receive-only fork。
6. VAD 独立可替换和资格测试：中文/英文/口音/数字/序列号/代码、静音/工厂/风噪/键盘/
   回声/loss、双讲/插话/短应答/假启动；测 false activation、miss、endpointer、
   barge-in、截断。
7. 优化端到端而非仓库名称：有界 timestamped frame、同区资源、warm session、GPU
   admission、speculative cancellation、streaming partial/LLM/TTS、generation fence。
8. 在 G11 可用时实现 Resolve B1 speaker attribution、stable partial、术语/命令/否定/单位/数字/序列号、
   low-confidence/original-text/human fallback 和 translation OutputLease。
9. 实现 RuntimeGeneration checkpoint/rotation/recovery；只保存已确认事实、speaker map、
   terminology、unfinished Task 和 Evidence refs，不无限增长上下文。
10. 完成同源 A/B：HF/VAD candidates/managed realtime/current pipeline 使用相同 audio、
    language、hardware、network、turn definition、quality guardrail 与 total cost。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-12/`：

- `speech-runtime-design.md`
- `speech-runtime-contract-v1.json` 与 schema
- `framework-capability-parity-inventory-v1.json` 与 schema
- `hf-source-model-runtime-lock.md`
- `vad-qualification-protocol.md`
- `b1-translation-contract-v1.json` 与 schema
- `telephony-room-adapter-contract.md`
- `latency-quality-cost-evidence-protocol.md`
- `fault-security-and-long-session-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-12-speech-runtime-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit existing STT/LLM/TTS/VAD/Active/LiveKit Agents paths and exact ownership。
2. 先写 normalized events、generation fence、bounded queue、barge-in、checkpoint 和 parity
   失败测试。
3. 实现 baseline adapters 与 A/B harness，再接 exact-source HF；不先删除旧路径。
4. 分别实现 bounded Telephony 与 LiveKit adapter seam/harness，验证 passive fork 不反压主媒体；
   真实 Native/Bridge qualification 在 G08 后执行，不阻塞 Core。
5. 独立 A/B VAD；默认 HF VAD 未过 Gate 时替换 VAD，不推翻 SpeechRuntime seam。
6. 实现 B1 text/captions、术语与数字保护；translated TTS output 保持关闭。
7. 完成 noise/loss/double-talk、short/30m/2h/8h、GPU crash/restart、overload、cost/capacity
   与 human bypass Evidence。

## 6. Acceptance gates

### SpeechRuntime core gate

- 只有 `same_function_as_HF_speech_loop=true` 的功能被替换；所有非重叠能力有 parity/retain
  Evidence，框架 Authority 不进入 Converact。
- HF、managed Realtime 和 current baseline 的 exact-source 同源 A/B 可复现；不预设谁
  在全部场景更优。
- VAD Gate 单独通过或明确选定更优替代；漏检、误检、端点延迟、打断与截断有分布。
- Channel adapter harness 中 passive fork 丢弃或 AI 故障不反压/中断 Human Communication；
  每个真实 Provider、Native telephony 或 Room adapter 仍需自己的 deployment qualification。
- 延迟记录 VAD endpoint、STT stable partial/final、LLM first token、TTS first frame 与
  playout；质量和成本护栏同时满足。
- 30m/2h/8h generation rotation、reconnect、memory/GPU stability 和 bypass 有 Evidence。
- 首期不向外部电话回注 translated TTS；E2EE strict 时服务器 Speech fail closed。

Core Gate 通过即可形成 `speech_runtime_core_completed`，供 G13/G15 使用；它只证明可替换
Speech seam、bounded adapter contract/harness、VAD/A-B/故障/长稳，不证明任何真实渠道
adapter 或 Profile 翻译已可销售。

### Deployment adapter qualification

- G11 的外部 provider fork、G08 的 Native telephony/Voice-LiveKit bridge 和每个 LiveKit
  deployment 分别冻结 source/config/security/workload 并取证。
- 任一 adapter 未通过只关闭该部署路径；不得把 fake/corpus、另一 Provider 或普通媒体
  Evidence 外推为本 adapter 的 production qualification。

### Resolve B1 profile gate

- G11 的真实 Resolve Pilot Adapter 已完成，B1 使用同一 Profile、语言、Consent、Region、
  Evidence 和用户旅程；mock/synthetic 不能签署 B1。
- B1 对 speaker、术语、否定、单位、数字、序列号、口音、噪声、双讲和 loss 达到冻结门槛；
  关键数字/序列号无未标记篡改。
- B1 改善 Resolve 主指标且安全、CSAT、升级率和人工可用性非劣效；否则只拒绝/重定位该
  Profile capability，不否定 SpeechRuntime Core。

缺 G11 或真实 Pilot 时，完成所有 Core 与离线 B1 harness 后，G12 可记录 Core sub-gate 已完成、
总体为 `blocked_external`；G13/G15 不因此阻塞，G16 必须等待 `resolve_b1_completed`。
缺 G08 只令 Native/Bridge Speech adapter 保持 `not_run`，不阻塞 Core 或外部 Provider B1。

## 7. Explicit non-goals

- 不把 HF 整仓替换 LiveKit Agents、Active Call、Pi、Nanobot 或 Converact Agent Runtime。
- 不宣称 HF/VAD 天然最快或最好。
- 不让 Translation 创建 Action、Outcome 或客户业务答复。
- 不把 Resolve B1 的中英质量、价格或术语集冒充其他 Profile/语言对的资格。
- 不把 Python Speech state 放进 RustPBX Call authority。
- 不在 B1 交付 Copilot、OCR、Voice Bot 或自动工具。

## 8. Completion and commit boundary

按 contract/harness、HF adapter、Telephony、Room、VAD、Core Evidence、Resolve B1 分窄
提交。HF 路径必须可回滚到 Human-only/其他 Speech adapter；Core 与 Profile status 分开，
任何未实际比较项保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-12-speech-runtime-hf-translation.md`
using its manifest SHA-256. Start the horizontal core after G09/G10; the
Resolve B1 gate separately requires G11, and real Native/Bridge speech adapter
qualification separately requires G08. Obey PROGRAM-RULES.md.

Create a normalized multi-path SpeechRuntime and integrate exact-source
huggingface/speech-to-speech only for functionality identical to existing
VAD-STT-LLM-TTS/streaming loops. Preserve all non-overlapping LiveKit Agents,
Active Call and framework capabilities through explicit parity inventory.
Build bounded channel adapter contracts and harnesses, independent replaceable VAD gates,
generation rotation/fencing, human bypass and exact-source same-audio A/B for
latency, quality, cost, noise, double-talk, barge-in, failure and capacity.
Qualify each real provider, Native telephony and Room adapter independently.
After the core gate, allow G13/G15 to proceed without fabricated Resolve
market evidence. When G11 is real, separately deliver Resolve B1
Chinese-English speaker-attributed captions/text translation with terminology/
digit/serial safeguards and no translated TTS injection. AI faults
must not break human media. No production changes or unsupported superiority
claims; unproved items remain not_run.
```
