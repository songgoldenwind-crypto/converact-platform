# Unified Communication Foundation Revision 5 — Binding Objective

- Objective ID：`unified-communication-foundation-r5`
- Revision：5
- 日期：2026-07-31
- 状态：`target`
- Runtime enablement：`false`
- Production capacity claim：`none`
- 生产服务器变更授权：`false`

## 1. Objective

在不丢失 Revision 4 任何要求、门禁、证据状态和历史 Goal 1–11/rvoip/Revision 3
review 追踪的前提下，冻结并实现 OPC 的统一 Rust 通信底座、双向音视频切换、
HF Speech Runtime 和 AI-native 架构。

Revision 5 必须：

1. 把 Revision 4 objective、machine contract 和 362 行 trace 作为固定 SHA-256 的完整
   前置合同；任何 R4 `not_run`、failed 或 deferred 项不得因 R5 文档自动升级。
2. 保持 Kamailio 为 SIP Edge，Unified RustPBX 为唯一 Call/Leg/Business
   Dialog/routing/CDR/recording-intent Authority。
3. 只按 exact-source slice 吸收 rvoip 低层能力；不得部署第二个 rvoip PBX、第二套
   Call state 或双写 SIP/media Authority。
4. 保持 RTPengine 为 ordinary RTP/RTCP/SRTP 长期性能底线和默认 Fast Path；任何
   Rust-native candidate 必须通过同硬件完整 A/B，且不得形成第二生产架构。
5. 强制完成 `G729/8000` 工程，G729A/G729AB 为内部 modes；法律审查只门禁分发和
   enablement。
6. 由 RustPBX Call Core 唯一拥有 Logical Media Graph；由 RustPBX Media Engine
   Facade 唯一拥有 Media Plan、Directed Media Edge generation 和 writer fence；
   Backend 永远不是业务 Authority。
7. 将“单一 Authority”与“单 OS 地址空间”解耦：ordinary media、decoded/native
   media、recording、Agent、Speech Runtime、AV Gateway 和视频转码使用与故障后果匹配的
   受控 fault domains；任何旁路不得回压主媒体。
8. 保持 LiveKit 为 Room/WebRTC/SFU/TURN Authority，LiveKit SIP 只作为音频桥执行器。
9. 继续实施 R4 durable、idempotent、owner-fenced
   `prepare/commit/abort/query/reconcile` Voice↔LiveKit handoff，保持 InteractionId、
   CallId、billing key、recording intent 与每代 Directed Edge single writer。
10. 支持 LiveKit audio↔video、SIP voice↔LiveKit、未来 ViLTE voice↔video、
    ViLTE↔LiveKit 双向 AV，以及视频失败后回到 RTPengine audio；每条路径使用独立证据。
11. 新增独立 ViLTE↔LiveKit AV Participant Gateway；它不得拥有 Call、Room、billing、
    recording 或 Agent 状态。
12. 坐席端统一使用 LiveKit WebRTC，不在 RustPBX 中再建第二套浏览器视频 WebRTC。
13. 通过 pure PCM/canonical-event adapter 保留 Active Call 的电话
    Agent/Playbook/interrupt 等非重叠能力；DTMF 只消费 RustPBX canonical event，
    REFER 等电话动作只生成 proposal。Active Call 不直接接管 Carrier SIP、主 RTP、
    CDR、Call 或任何业务副作用。
14. 保留 LiveKit Agents 的 Room participant、AgentSession、multimodal、
    task/workflow/tool/handoff/job dispatch 等非重叠能力，但不拥有跨渠道 durable AI state。
15. 采用 Hugging Face `speech-to-speech` 作为 OPC `SpeechRuntime` 的目标主实现，只
    替换当前 Python、Active Call 和 LiveKit Agents 中功能相同的 VAD/STT/LLM/TTS
    执行部分；所有不同功能继续保留。
16. 建立 OPC-owned normalized `SpeechRuntime` lifecycle、audio/event、
    response/tool-result、lease/fence、cancel、query/reconcile、source/model identity、
    clock、quota 和 error contract。
17. 每个 active speech session 只有一个 acoustic VAD producer、一个 turn commit
    Authority 和一个 response cancel Authority；HF、Active、LiveKit turn detector 必须
    通过同语料 A/B 选择，禁止双 commit。
18. 不用 upstream claim 证明 HF 更快；必须在相同模型、硬件、语料和并发下比较
    Active native vs Active+HF、LiveKit native vs LiveKit+HF，测量
    speech-end→first-audible p50/p95/p99、质量、资源、barge-in、长稳和故障。
19. 建立 OPC AI-native Orchestrator，唯一拥有跨渠道 AgentRun、Task、Tool、Memory、
    Policy、Approval、Action Ledger、Handoff 和 Evaluation；LLM tool call 只是 proposal。
20. 使用由 OPC Interaction Lease Store 以 durable CAS 签发的
    ResponseLease/fence，保证 SIP↔LiveKit/ViLTE 切换时只有一个 Channel Agent 可以说话
    和提议当前 generation 的动作；首期换主采用 break-before-make。
21. recording capture/upload、Provider、AI、视频或数据库故障不得终止已建立主媒体；
    root RecordingManifest、CDR 和 billing 保持单写。
22. 保持所有工作有界、fenced、可 drain、可 reconcile；拒绝热路径 global lock、
    total scan、per-packet task、unbounded queue、avoidable allocation 和不可解释回归。
23. 为 ordinary voice、decoded media、LiveKit audio bridge、ViLTE AV、Telephony HF、
    LiveKit HF、translation、recording 和 mixed cell 建立相互不可继承的 workload/evidence
    profiles。
24. 所有 source、model、binary/image、config、hardware、clock 和 workload 身份必须
    固定；任何没有实际证据的结果保持 `not_run`。
25. 当前生产服务器容器保持冻结。文档、代码、测试和 GitHub commit 不授权服务器部署、
    Feature Flag 或 release 变更。

## 2. Canonical artifacts

```text
docs/design/unified-communication-foundation-r5.md
docs/adr/ccaas-9-channel-agent-and-speech-runtime.md
docs/adr/ccaas-10-vilte-livekit-av-participant-gateway.md
docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md
docs/capacity/contracts/unified-communication-foundation-r5-v1.json
docs/capacity/schemas/unified-communication-foundation-r5.schema.json
docs/capacity/contracts/unified-communication-foundation-r5-traceability-v1.json
docs/capacity/schemas/unified-communication-foundation-r5-traceability.schema.json
CONTEXT.md
docs/design/README.md
```

## 3. Development authorization

R4 的 D0 checkpoint 已由 commit `2c360a3990201e037be33a98623ae65720c6a092`
完成，R4 实现历史及其已提交成果继续保留。根据 D0 后用户“先把方案讨论好并落成文档”的
后续指令，本 objective 显式 supersede R4 的“checkpoint 后无需再次确认即可继续开发”
一句，作用域只限 **R5 delta 新开发**；不撤销、不伪装或重置已经发生的 R4 开发事实。

本 objective 只冻结架构与未来开发门禁，不授权本次文档任务立即开始 R5 delta 开发。
R5 delta 启动条件：

1. R5 文档通过独立一致性审查；
2. 用户明确确认进入开发；
3. 只在指定 worktree/branch 工作；
4. 保留所有既有 dirty/untracked 用户工作；
5. TDD、窄提交、无 `git add .`、无 reset/rebase/discard；
6. 不因代码完成自动部署当前服务器。

## 4. Completion

只有 R4 与 R5 所有适用功能、故障、安全、质量、容量、供应链、长稳、drain、迁移和
外部互通门禁都绑定同一 release identity 并通过，才可标记整体目标完成。预算、时间、
upstream claim、文档 Accepted 或局部测试都不是完成条件。
