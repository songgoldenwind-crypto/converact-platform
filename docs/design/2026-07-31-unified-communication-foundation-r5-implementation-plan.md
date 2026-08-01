# Unified Communication Foundation Revision 5 — TDD Implementation Plan

> <关联文档>
>
> - [Revision 5 总设计](./unified-communication-foundation-r5.md)
> - [Revision 5 绑定目标](../capacity/contracts/unified-communication-foundation-r5-objective.md)
> - [ADR-CCAAS-9](../adr/ccaas-9-channel-agent-and-speech-runtime.md)
> - [ADR-CCAAS-10](../adr/ccaas-10-vilte-livekit-av-participant-gateway.md)
> - [Revision 4 实施计划](../plans/2026-07-29-unified-voice-foundation-r4.md)
>
> </关联文档>

- 状态：**R4 implementation already started；R5 delta plan only，pending user confirmation**
- 日期：2026-07-31
- Plan ID：`unified-communication-foundation-r5-plan-v1`
- Runtime changes：`not_authorized`
- Server/container changes：`forbidden`
- 生产容量：`none`

## 1. 执行原则

1. R4 U1–U9 继续按原合同执行；本计划只增加 R5 的 fault-domain、Speech、Agent、
   multimodal 和 ViLTE slices。
   R4 D0 checkpoint commit `2c360a3990201e037be33a98623ae65720c6a092` 及其后
   已有实现事实不被重置；暂停只作用于尚未授权的 R5 delta。
2. 每个 slice 遵循 red→green→refactor；未先出现失败测试，不写生产实现。
3. 每个提交只包含相关 clean files；禁止 `git add .`。
4. 不 reset、rebase、discard 或覆盖既有 dirty/untracked 用户工作。
5. 不因本地/CI 通过自动部署服务器。
6. 新功能先 closed capability、admission、query/reconcile，再进入 main path。
7. shadow 不产生外部副作用；canary 只移动 new sessions；旧 session drain 到 active-zero。
8. 任何 upstream claim、mock、loopback 或 microbenchmark 不能标记生产通过。
9. 普通 RTP 热路径不因 AI/AV 新增 HTTP、数据库、全局锁、scan 或 per-packet task。
10. recording、AI、AV、GPU 和 native/FFI 失败不得影响 ordinary call。

## 2. Gate map

```text
R5-D0 docs/contracts
  |
  +--> R4 U1/U2/U3/U4/U5/U6/U7/U8/U9 continue
  |
  +--> F0 fault-domain contracts
  |
  +--> S0 SpeechRuntime contract/harness
  |      +--> S1 Telephony + HF
  |      +--> S2 LiveKit + HF
  |      \--> S3 cross-channel Agent handoff
  |
  +--> A0 AV contracts/harness
         +--> A1 receive video
         +--> A2 send video
         +--> A3 bidirectional AV
         +--> A4 voice/video handoff
         \--> A5 AV capacity/production gates

F0 + S3 + A4 + R4 U7/U8
  -> M0 mixed-cell fleet
  -> M1 final production eligibility
```

S1 与 S2 可在 S0 后并行；A1 与 A2 可在 A0 后并行。任何共享 schema、Authority 或
Media Edge 改动必须先串行冻结。

## 3. R5-D0：文档与机器合同

### Task D0.1 — 文档关系与哈希

测试/校验先行：

- JSON schema validation 预期失败：R5 contract 尚不存在；
- trace inheritance 预期失败：R4 hash/count 未绑定；
- link checker 预期失败：R5 canonical artifacts 未全部存在。

实现：

- 总设计、ADR-9、ADR-10；
- objective、machine contract/schema、trace/schema；
- `CONTEXT.md`、`docs/design/README.md`；
- 旧 AI 文档 supersession banner；
- hashes 和 artifact paths。

通过条件：

- JSON 全部 parse/schema-valid；
- R4 objective/contract/trace SHA 与固定值相同；
- R4 row count=362；
- R5 delta trace ID 唯一；
- 无 TODO/TBD/placeholder；
- Git diff 不含 runtime/server/dirty unrelated files。

### Task D0.2 — 独立审查

至少两名独立 reviewer 分别检查：

- Authority/重复状态；
- 热路径/复杂度；
- fault isolation；
- HF 只替换重叠功能；
- ViLTE 双向性；
- current/target/evidence；
- R4 零遗漏继承。
- fault-domain reference integrity；
- ResponseLease/ContextRevision/action proposal single-writer；
- AV participant/crypto/codec/recording/capacity topology。

任何 blocker 修正后重新计算 hashes 和 schema validation。

### Task D0.3 — Versioned governance registry migration

现有交付脚本仍消费
`docs/architecture/component-authority-matrix-v1.json` 与
`communication-technology-baseline-v1.json`。开发阶段先写失败测试，再原子完成：

- 新的 versioned registry 能表达 R5 Channel Agent、HF、AV Gateway 和 fault domains；
- LiveKit Agents 不再被登记为跨渠道 AI primary；
- `voice-media-rs` 的执行隔离不再被固定为永远同地址空间；
- 新 R5 capability 的 `production_eligible` 默认 false；
- delivery bundle、governance validator 和 tests 同一提交切换；
- v1 保留历史，不在原地改写后伪装同一版本；
- 新旧消费者混跑范围明确，rollback 可恢复。

## 4. F0：Fault-domain foundation

### Task F0.1 — Worker contract

先写失败测试：

- capacity exhausted 时 admission fail closed；
- queue full 时 `try_write` 不阻塞；
- stale generation output 被拒绝；
- worker crash 不终止 Call Core harness；
- restart 后 old fence 无效；
- graceful drain 不接新 session；
- query/reconcile 收敛 terminal receipt。

目标接口：

```text
prepare / commit / try_write / revoke / close / query / reconcile
```

统一字段：

- worker/source/binary/config/capability digest；
- session/edge/generation/owner epoch；
- queue and memory budgets；
- heartbeat/lease；
- terminal tombstone。

### Task F0.2 — In-node bounded media transport

对 Unix socket、shared-memory ring 和现有内存 queue 做同机基准：

- copy count；
- frames/s；
- p50/p95/p99；
- CPU/frame；
- queue overflow；
- worker restart；
- backpressure isolation。

选择最小满足方案。禁止先设计通用 RPC 平台。

### Task F0.3 — Native/unsafe isolation

故障注入：

- abort；
- segfault；
- allocator failure；
- OOM；
- malformed codec/video packet；
- GPU timeout。

通过条件：ordinary RTP 与 RustPBX control harness 继续；受影响 processing session
明确 degraded/failed 并可 reconcile。

### Task F0.4 — Recording capture/upload isolation

- machine schema 验证所有 `must_not_share_failure_with` 都引用已声明 fault-domain ID；
- capture 与 upload 是两个 domain；
- upload crash、credential failure、object-store timeout 或 backlog 不停止 capture；
- capture queue/spool 满只产生有界 gap/degraded receipt，不回压主媒体；
- capture generation 切换和 billing interval 使用唯一 fence/idempotency key。

## 5. S0：SpeechRuntime contract 与 A/B harness

### Task S0.1 — Domain types

失败测试：

- Interaction/AgentRun/channel/session ID 混用被拒；
- 同 idempotency key 不同 digest conflict；
- stale ResponseLease output rejected；
- two VAD/turn owners rejected；
- unsupported audio format fail closed；
- secret/raw PCM 无法序列化到 metadata event。

实现 Converact Platform-owned：

- `SpeechSessionId`、`SpeechGeneration`、`SpeechFence`；
- `PrepareSpeechSession`；
- normalized events；
- `ResponseLease`；
- `ContextRevision`、`OrchestratorResponsePlan`；
- output-gate `OutputPermit`；
- error taxonomy；
- clock/timing envelope。

### Task S0.2 — Lifecycle state machine

property tests：

- prepare/commit/create-response/tool-result/lease-renew/revoke/cancel/close/query/reconcile
  任意重试幂等；
- crash at every transition；
- response generation 单调；
- ContextRevision 单调，旧 revision 不能 create response；
- terminal state 不复活；
- stale event 永不注入媒体；
- stale control/response fence 不能 prepare、commit、write audio、commit turn、
  create response、submit tool result、renew/revoke、cancel、close 或 reconcile；
- revoke old→all gates zero-output→issue new 的 break-before-make 顺序不可绕过；
- queue/buffer 永远不超过预算。

### Task S0.3 — Baseline adapters

为当前 Active-native、LiveKit-native/provider chain 建只读 adapter，不改变生产行为。
同一 corpus 输出 normalized timing/quality/usage，作为 HF A/B baseline。

### Task S0.4 — Exact source

固定：

- HF repository/commit/tree/file hashes；
- Active Call；
- LiveKit Agents/SDK；
- VAD/STT/LLM/TTS model and runtime；
- license/SBOM/build flags。

浮动 main/latest 测试必须失败。

## 6. S1：Telephony Agent + HF

### Task S1.1 — RustPBX AI tap

先写：

- 8 kHz G.711/G.729 and 16 kHz PCM format tests；
- bounded `try_write_audio`；
- queue overflow call continuity；
- tap close/BYE race；
- media generation change；
- no DB/HTTP on frame path；
- recording and AI tap independent。

实现最窄的 `voice-media-rs` tap，不改 ordinary Edge。

### Task S1.2 — Active Call capability adapter

保留测试：

- Playbook pure-local scene/goto/variables/prompt；
- RustPBX canonical DTMF event consumption；
- REFER/transfer proposal；
- interruption/AGC/denoise policy；
- Tool Broker result 回注同一 AgentRun/ContextRevision/generation/fence；
- graceful stop。

禁止测试：

- direct carrier trunk production mode；
- Active SIP/RTP/REGISTER/Dialog executor；
- direct REFER/MESSAGE/hangup/mute/bridge/transfer effect；
- direct arbitrary HTTP/posthook/secret-bearing URL；
- second Voice CDR/billing writer；
- direct root recording manifest。

### Task S1.3 — HF adapter

先写 protocol tests：

- prepare/commit；
- external turn commit；
- VAD bypass/shadow；
- transcript/text/audio/tool events；
- Orchestrator ResponsePlan create；
- tool-result injection；
- normalized event cursor/subscribe；
- lease renew/revoke；
- response cancel；
- provider timeout；
- unknown effect/query；
- worker crash/restart；
- lease/generation fencing。

若 upstream API 不足，先写 controlled-fork failing test，再做最小 patch。

### Task S1.4 — Telephony A/B

先用相同模型、硬件、Provider locality、8 kHz/16 kHz 语料做 framework-overhead；
再用双方最佳 exact-source 配置做 production-frontier：

- Active native；
- Active + HF。

验收指标与预冻结的相对门禁见总设计 §16.2。每次运行前 Qualification Profile 还必须
给出绝对 numeric SLO；没有真实长通话、并发或预注册门槛，状态保持 `not_run`。

## 7. S2：LiveKit Agent + HF

### Task S2.1 — Room track adapter

测试：

- participant/track authorization；
- track subscribe/unsubscribe；
- 16/48 kHz conversion；
- Room reconnect；
- bounded buffer；
- AI failure Room continues；
- old participant/track generation fenced。

### Task S2.2 — 保留 LiveKit Agents 非重叠能力

回归：

- AgentSession；
- audio/video/text/vision input；
- task/group/workflow；
- tool adapter；
- agent handoff；
- job dispatch/load/drain；
- testing/observability。

HF adapter 不能删除这些能力。

### Task S2.3 — Turn ownership

矩阵：

- LiveKit audio turn detector + HF external commit；
- HF VAD-only；
- native provider endpoint；
- realtime model internal turn。

每个配置只有一个 commit Authority。双 owner 配置必须启动失败。

### Task S2.4 — LiveKit A/B

比较：

- LiveKit native；
- LiveKit + HF。

覆盖多语言翻译、视频会话 audio track、barge-in、multi-party、30m/2h/24h。
同样先过 framework-overhead，再过 production-frontier；不能用不同模型结果声称
adapter overhead 更低。

## 8. S3：AI-native 与跨 Channel handoff

### Task S3.1 — Durable AgentRun/Task

先写 domain/property tests：

- Interaction 下多 channel；
- one active ResponseLease；
- lease issue/renew/revoke durable CAS 与 monotonic fence；
- audio/LiveKit/RustPBX communication-action/tool/transcript 五类 output gate；
- Task/Memory revision CAS；
- canonical ContextRevision 与 channel-local history projection；
- channel crash/retry；
- human handoff；
- terminal task 不复活。

### Task S3.2 — Tool Broker/Action Ledger

失败场景：

- duplicate tool call；
- timeout before/after effect；
- same key different intent；
- approval revoked；
- channel switch mid-action；
- connector restart；
- unknown external effect。

只有 query/reconcile 后才能决定 retry。

### Task S3.3 — SIP↔LiveKit Agent handoff

端到端：

- active telephone Agent -> Room Agent；
- Room Agent -> telephone Agent；
- repeated A→B→A；
- stale HF audio after switch；
- prepare new blocked→revoke old fence→all sinks zero-output→issue new lease；
- task/memory/tool continuity；
- recording/billing/transcript continuity；
- new channel failure rollback。

测 switch gap/loss、stale output 和 duplicate action；首期不要求 zero gap，明确禁止
make-before-break。

## 9. A0：ViLTE/AV contract 与 harness

### Task A0.1 — Media component schema

失败测试：

- audio/video 隐式共用 writer；
- missing codec/clock；
- capability unknown；
- video admission inherited from audio；
- group change without new generation；
- forged Room metadata changes Call。
- same participant identity split audio/video rejected；
- prepared_blocked participant join/publish rejected；
- split topology cannot authorize combined production。

### Task A0.2 — SIP/SDP video corpus

覆盖：

- `m=video` add/remove/reject；
- sendrecv/sendonly/recvonly/inactive；
- H.264 profile-level-id/packetization-mode；
- AMR-NB/AMR-WB RFC 4867、mode-set/CMR、octet-align、ptime、DTX/SID；
- EVS/AMR-WB IO unsupported capability fail closed；
- multiple m-lines/MID/BUNDLE；
- malformed/oversized SDP；
- initial inbound/outbound、late offer、PRACK/100rel、UPDATE/ACK、491 glare/retry；
- duplicate/CANCEL/BYE/4xx/timeout/200-without-keyframe/compensating re-INVITE；
- CANCEL initial INVITE 与 CANCEL active re-INVITE 分开验证；后者分别恢复 predecessor
  `audio_active`/`av_active`，final response 后的 CANCEL 必须无媒体副作用；
- BYE 覆盖 active audio/AV 的 local-prepare、offer/answer、late-ACK、commit/join 和
  fallback 全部非终态；
- late-offer 2xx receipt 在 ACK answer 前不得生成完整 decision/授权 writer；
  reliable provisional SDP/PRACK digest 必须与 final 2xx 一致；
- late-offer 分 UAC/UAS：UAS 只重传 stored 2xx 并在 ACK timeout 后终止；UAC 必须
  发送合法 ACK answer，不可接受时 reject-media ACK 后 BYE；invalid ACK answer
  不得触发并发新 offer；
- no-media-change/unchanged-digest RFC 4028 refresh 只改 dialog timer/receipt，
  不 reserve/revoke/commit media；覆盖 422/Min-SE、retry、expiry 与 30m/2h/24h；
- reliable provisional/final mismatch 分别覆盖 UAS-before-wire non-2xx 与
  UAC-after-2xx ACK-then-BYE；491 budget remaining/exhausted 及
  audio/AV/no-predecessor 三分支全部生成；
- active AV hold/resume、direction/codec/session refresh/video add/remove，以及
  audio-fallback 与 AV-atomic-terminate 两个互斥 policy 分支；
- hold/transfer/BYE races。

### Task A0.3 — Fake carrier + real browser harness

必须能产生/观察：

- RTP/RTCP audio/video；
- 三段独立 crypto context：carrier↔RTPengine、RTPengine↔Gateway、Gateway↔LiveKit；
- ROC/replay/rekey、key fence/zeroize；
- H.264 keyframe；
- NACK/PLI/FIR；
- CVO；
- packet loss/jitter/reorder；
- AV clock drift；
- LiveKit participant/tracks。

### Task A0.4 — Executable SIP/IMS transition contract

- machine schema freezes states, events, guard/action/SIP-response/receipt fields and atomic boundaries；
- generated property tests use `allowed_transition_rules` as the only oracle；every
  `(from_state,event,guard_result)` tuple not uniquely matched is rejected；
- canonical JSON of the rule table must match `allowed_transition_rules_sha256`；
- TransitionRecord must include `to_state` and `matched_rule_id`；
- BYE/pre-final initial-or-re-INVITE CANCEL/late-CANCEL-no-effect/tombstone/timeout/
  491/duplicate priority is deterministic；
- property tests generate initial inbound/outbound、active re-INVITE/UPDATE、PRACK/ACK、
  491、duplicate、CANCEL/BYE、timeout 和 compensation interleavings；
- property tests prove in-dialog CANCEL restores the exact audio/AV predecessor while BYE
  terminates the dialog from every nonterminal renegotiation state；
- early/reliable `NegotiationDecision` precedes final SIP response；late offer persists the
  2xx offer receipt first and cannot complete its decision before a digest-matching ACK answer；
- complete reliable provisional SDP persists PRACK/provisional receipts and rejects a mismatched
  final 2xx with direction-correct UAS non-2xx or UAC ACK-then-BYE behavior；
- late-offer ACK timeout/invalid-answer tests prove no overlapping offer is emitted；
- unchanged session refresh leaves BridgeGeneration、MediaGeneration and writer fence exactly
  unchanged while dialog timer receipts advance；
- exhausted 491 retry budget returns the exact audio/AV predecessor or terminates an initial call；
- active AV renegotiation covers hold/resume/direction/codec/session refresh/video add/remove；
- join/keyframe/Gateway failure exercises both policy-authorized audio compensation and
  policy-required atomic AV termination；
- SIP acceptance never directly authorizes a writer；
- replacement old-zero receipt precedes new Media commit，which precedes join/publish；
- crash after every transition reconciles the same transition ID。

## 10. A1/A2：单向视频 slices

### Task A1 — Carrier video → LiveKit

先实现 receive-only：

- prepare local resources only；commit 后才 join combined participant；
- carrier H.264 ingest；
- 通过 exact-source LiveKit Rust SDK/libwebrtc publish track；
- keyframe/feedback；
- query/reconcile；
- crash/orphan cleanup；
- no reverse video claim。

### Task A2 — LiveKit video → Carrier

先实现 send-only：

- Bridge Coordinator emits revisioned `RoomReturnPolicy`；
- `LOCKED_AV_PEER` subscribes paired audio/video from one authorized participant；
- `CONFERENCE_RETURN` uses N-1 audio mix and deterministic pinned/screen-share/active-speaker
  video selection；
- every source switch creates `SourceSelectionGeneration`/fence/receipt with debounce；
- gateway-published carrier tracks are excluded；
- H.264 PT/SSRC/sequence/timestamp/marker、mode 0/1、STAP-A/FU-A、MTU output；
- RTP/RTCP/SRTP；
- NACK/RTX/PLI/FIR、bandwidth/keyframe/pacer control；
- revoke zero-output；
- no inbound video claim。

A1/A2 evidence 不互相继承。

## 11. A3/A4：双向 AV 与 Voice↔Video

### Task A3.1 — Four-edge bridge

property/fault tests：

- four directed Edges；
- one combined Gateway participant/PeerConnection for synchronized AV；
- per-component fence；
- one audio executor；
- participant cleanup；
- simultaneous terminal events；
- recording source segments；
- billing usage single key。

### Task A3.2 — Passthrough/transcode

profile matrix：

- exact H.264 compatible；
- repacketize only；
- mode-1→mode-0 exceeds MTU → transcode/reslice/reject；
- CPU transcode；
- GPU transcode；
- no capacity → audio-only；
- decoder/encoder crash。

“passthrough”需 packet capture 和 decoded visual validation。

### Task A4.1 — Voice→Video

re-INVITE：

- reserve all resources；
- prepared_blocked local-only，禁止 participant join/publish；
- persist NegotiationDecision；
- revoke old audio fence and obtain zero-output；
- commit new Bridge/Media generation；
- join/publish/enable combined participant；
- keyframe observed；
- audio writer handoff if needed；
- old bridge release；
- gap/black-frame/AV sync。

### Task A4.2 — Video→Voice

- revoke video；
- preserve audio Call；
- unpublish/cleanup；
- optional return to LiveKit SIP/RTPengine；
- compensating offer/answer confirms audio-only；
- recording/billing continuity；
- repeated toggle soak。

### Task A4.3 — Failure degradation

- Gateway crash；
- GPU loss；
- LiveKit reconnect；
- carrier stops video；
- keyframe never arrives；
- SRTP failure；
- Room participant deleted；
- RTPengine restart。

按 policy audio continues 或 whole-call fail；结果可解释且可 reconcile。

## 12. Evidence 和性能

### Task E1 — Speech fleet

- independent clients；
- real models/providers；
- 8/16/48 kHz；
- noisy/multilingual field corpus；
- concurrency ramp/steady/burst；
- 30m/2h/24h；
- crash/drain；
- exact source/config/hardware/clocks。

### Task E2 — AV fleet

- real browser peers；
- carrier emulator/真实 IMS prerequisite；
- inbound new AV、outbound new AV、active add/remove video、repeated toggles 分开；
- `VILTE-AV-COMBINED` 与 `VILTE-AV-SPLIT-RESEARCH` 分开，split 不授权生产；
- `LOCKED_AV_PEER` 与 `CONFERENCE_RETURN` 分开，后者覆盖 N-1 mix、选轨 churn 和
  source-generation fencing；
- AMR-NB/AMR-WB↔Opus/PCM matrix；
- resolution/fps/bitrate matrix；
- TURN ratio；
- H.264 passthrough/transcode；
- AV sync/freeze；
- switch/failure；
- RTPengine port/SRTP/PPS、control CPS、cache/memory、NIC/IRQ/NUMA、N+1 reserve；
- GPU/CPU/shards。

### Task E3 — Mixed Cell

同时运行：

- ordinary RTP；
- decoded/transcode；
- LiveKit audio bridges；
- AV gateways；
- HF Telephony/Room sessions；
- recording/upload；
- database/control workload。

验证 ordinary Voice SLO 不因 overlay 失控。

## 13. Commit slicing

建议窄提交：

```text
docs(architecture): freeze unified foundation r5
test(runtime): define isolated worker lifecycle
feat(runtime): add bounded worker lifecycle
test(speech): define normalized speech contract
feat(speech): add speech runtime state machine
feat(speech): add hf exact-source adapter
feat(agent): add telephony channel runtime
feat(agent): add livekit channel runtime
feat(agent): fence cross-channel responses
feat(ai): add idempotent action ledger
test(video): define vilte media components
feat(video): add livekit av gateway ingress
feat(video): add livekit av gateway egress
feat(video): add voice video handoff
test(evidence): add speech and av profiles
docs(evidence): record independent results
```

提交标题只是建议；每个提交前必须跑其适用单元、contract、property、integration 和 lint。

## 14. Stop conditions

只在以下情况暂停并请求外部输入：

- 需要真实 Carrier/IMS/ViLTE trunk、证书、号码或硬件；
- 需要合法 G.729 分发/商业许可决定；
- 需要生产服务器或外部账号变更授权；
- 需要付费 GPU/Provider/LiveKit Cloud 配额；
- 需求会改变 Authority、计费、合规或用户体验且不能从合同推出。

外部条件缺失前，继续完成所有可离线的 contract、tests、harness、simulation、fault
injection 和文档；缺失项保持 `not_run`。

## 15. Plan completion

本计划完成不等于架构完成。只有所有适用 R4/R5 gates、独立 evidence profiles、
source identity、安全、合规、长稳、drain、rollback 和 production approval 完成，
才可标记总体目标完成。

## 16. 变更记录

| Revision | 日期 | 作者 | 变更 |
| --- | --- | --- | --- |
| 1 | 2026-07-31 | Converact Platform/Codex | 新增 fault-domain、HF/Agent、AI-native、ViLTE AV 和 mixed-cell TDD 路线；保持服务器冻结 |
