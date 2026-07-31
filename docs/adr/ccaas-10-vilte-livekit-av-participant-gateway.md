# ADR-CCAAS-10：ViLTE 与 LiveKit 双向 AV Participant Gateway

- 状态：**Accepted for staged implementation**
- 日期：2026-07-31
- 决策 ID：`vilte-livekit-av-participant-gateway-r1`
- 适用范围：4G/IMS ViLTE、Voice↔Video、LiveKit Room、坐席 WebRTC
- Runtime verification：`not_run`
- Real media verification：`not_run`
- Capacity claim：`none`
- Production eligible：`false`
- 依赖：
  [Revision 5 总设计](../design/unified-communication-foundation-r5.md)、
  [ADR-CCAAS-5](./ccaas-5-media-authority-and-rtpengine.md)、
  [ADR-CCAAS-8](./ccaas-8-voice-livekit-bridge-handoff.md)
- Amends：ADR-CCAAS-8。ADR-8 的 `livekit_sip_bridge` 明确只代表音频执行器；本 ADR
  新增独立 `vilte_livekit_av_gateway`

## 1. 背景

OPC 需要同时支持：

- LiveKit Room 内 audio-only 与 audio+video 切换；
- SIP/PSTN audio 与 LiveKit video room 的协作；
- 未来 4G IMS/ViLTE audio+video；
- ViLTE voice-only 与 video 的 re-INVITE 切换；
- ViLTE 与 LiveKit 坐席之间的双向音视频；
- 视频不可用时回到普通 RTPengine audio fast path。

现有 Voice↔LiveKit 路径基于 LiveKit SIP。LiveKit 官方当前明确标记
`Video over SIP` 不支持，因此它不能处理 carrier `m=video`、H.264 RTP/RTCP、
关键帧和 AV sync。

RTPengine 是高性能 RTP/SRTP 数据面，但不创建 LiveKit Room participant/track。
WHIP/Ingress 是 ingest 方向，不提供完整双向 participant、订阅、回传和统一切换状态机。

## 2. 决策

采用独立、可分片、可替换、无业务 Authority 的双向
**ViLTE↔LiveKit AV Participant Gateway**：

```text
IMS / ViLTE Carrier
  -> Kamailio
  -> Unified RustPBX
  -> RTPengine
  -> AV Participant Gateway
  -> LiveKit Room/SFU
  -> Engineer/Customer WebRTC
```

RustPBX 继续拥有 Call、Leg、SIP、route、Media Plan、billing、recording intent；
LiveKit 继续拥有 Room、participant、track、WebRTC、ICE/DTLS/SRTP、SFU/TURN；
Gateway 只执行 Edge，不成为 PBX、SFU、billing、recording 或 Agent Authority。

坐席浏览器统一使用 LiveKit，不另建 RustPBX browser video WebRTC 栈。

## 3. 为什么选择 Gateway

### 3.1 拒绝 LiveKit SIP 视频

官方当前不支持 Video over SIP。不能基于未支持能力设计生产路线。

### 3.2 拒绝 RTPengine 单独完成

RTPengine 可：

- anchor/relay RTP/RTCP/SRTP；
- NAT、ICE/DTLS 和部分 media manipulation；
- 作为普通 packet fast path。

RTPengine 不：

- join LiveKit Room；
- create participant；
- publish/subscribe track；
- 管理 LiveKit token、track lifecycle 或 SFU feedback。

### 3.3 拒绝 RustPBX 自建坐席 WebRTC 视频

该路线会形成第二套：

- browser SDK；
- ICE/DTLS/SRTP/TURN；
- device/reconnect；
- Room/participant；
- recording/screen share；
- frontend/media capacity。

这会增加维护和故障面，且与 LiveKit 已有能力重复。

### 3.4 拒绝 WHIP-only

WHIP/Ingress 适合单向发布，不足以同时完成：

- Room join identity；
- publish carrier tracks；
- subscribe engineer tracks；
- reverse RTP to carrier；
- bidirectional DTMF/hold/control；
- participant cleanup 和 repeated voice/video handoff。

## 4. Authority

| 事实 | Authority | Gateway role |
| --- | --- | --- |
| Call/Leg/Business Dialog | RustPBX | consumer |
| SIP offer/answer/re-INVITE | selected RustPBX `SipFoundation` | media projection consumer |
| Logical Media Graph | RustPBX Call Core | executor input |
| Edge generation/writer fence | Media Engine Facade | obey |
| RTP/SRTP transport bundle | Media Engine Facade + selected Backend receipt | execute/report |
| Room/participant/track | LiveKit | temporary participant executor |
| billing key/rating | OPC Billing | usage receipt only |
| recording intent | RustPBX Call Core | source receipt only；OPC policy 只提供 revisioned input |
| root RecordingManifest | Region Recording Plane | segment receipt only |
| Agent task/memory/tool | OPC AI-native Orchestrator | media source only |

Gateway 永远是 `executor_not_authority`。

## 5. Media Graph

一个双向 AV call 至少有四条 Edge：

```text
carrier.audio -> room.audio
room.audio    -> carrier.audio
carrier.video -> room.video
room.video    -> carrier.video
```

录音、AI、字幕、翻译各自是独立 tap Edge。每条 Edge generation 只有一个 active
writer。音频和视频可以属于同一 Bridge Generation，但仍分别 fencing、admission 和
evidence。

生产基线使用同一个 Gateway LiveKit participant 和对应 publish/subscribe
PeerConnection 承载同一 carrier leg 的 audio+video。LiveKit participant identity 在
Room 内唯一；不能让 LiveKit SIP participant 提供 audio，再让第二个同 identity Gateway
participant “补 video”。两个不同 participant 也不能默认获得 lip-sync、track selection、
UI、Egress、permission 和 cleanup 一致性。

`room.audio`/`room.video` 不是模糊的“任意 Room track”。Bridge Coordinator 单写带
revision/digest 的 `RoomReturnPolicy`：

- 首期 `LOCKED_AV_PEER` 选择一个 authorized participant，并成对订阅其 audio/video；
- `CONFERENCE_RETURN` 才允许 N-1 authorized audio mix；video 按
  explicit pin > approved screen share > active speaker camera > last-known-good 选择；
- Gateway 自己发布的 carrier tracks 永远排除，避免回环；
- 每次 participant/track/pin/active-speaker 变更生成 `SourceSelectionGeneration`、
  fence 和 receipt，并带 debounce/hysteresis；
- locked peer 资格包含 AV sync；conference mix 只声明统一 playout clock，不把多个
  speaker 与一条视频伪装为 lip-sync；
- 两种模式使用独立质量和容量证据。

每个 Edge 记录：

- `media_component`；
- source/destination；
- codec/profile/packetization；
- clock domain；
- backend/gateway instance；
- group/generation/flow selector；
- writer fence；
- transport/crypto refs；
- admission/output/terminal receipts。

## 6. Gateway capability contract

生产选择 fail closed。能力至少包括：

```text
bidirectional_audio
bidirectional_video
livekit_participant_lifecycle
publish_subscribe_tracks
prepare_blocked
commit
zero_output_revoke
query_reconcile
terminal_tombstone
edge_writer_fence
h264_profile_packetization
rtcp_sr_rr
nack_pli_fir
cvo_orientation
audio_video_clock_mapping
lip_sync
srtp_key_reference
carrier_srtp_termination
internal_srtp_termination
livekit_dtls_srtp_endpoint
hold_direction_update
video_add_remove
audio_only_degrade
recording_source_receipt
quality_telemetry
```

每项绑定 exact source/binary/config/capability digest 和 verification。缺失、unknown、
过期或粒度过粗时该 path 不 eligible。

## 7. Codec 与媒体处理

### 7.1 Audio

ViLTE 首期资格 codec 明确包括 AMR-NB、AMR-WB；EVS 与 AMR-WB IO mode 保留 closed
capability 口，未实现时 fail closed。G.711、G.729 和 Opus 仍用于普通 SIP/Room interop，
但不能代替移动 IMS codec profile。

能力与证据必须覆盖：

- RFC 4867 octet-align、mode-set/CMR；
- ptime/maxptime；
- DTX/CNG/SID、PLC；
- codec mode change；
- AMR/EVS↔Opus/PCM quality、latency、CPU 和 capacity。

普通 voice-only path 继续优先 RTPengine。同步 ViLTE AV 进入 Room 时，audio 与 video
由同一个 combined Gateway participant 执行；如需转码，使用隔离的
`voice-media-rs`/codec worker。同一 directed audio Edge 不能由 LiveKit SIP 与 AV
Gateway 同时写。

### 7.2 Video

首期重点 H.264：

- profile-level-id；
- packetization-mode；
- SPS/PPS；
- keyframe；
- PT、RTP timestamp/sequence/SSRC/marker；
- RTP/RTCP mux、BUNDLE/MID、extmap；
- RTCP SR/RR；
- NACK/RTX cache、PLI/FIR 与关键帧节流；
- CVO/orientation；
- STAP-A/FU-A、MTU；
- congestion control/pacer；
- bitrate/frame rate/resolution；
- lip-sync。

执行顺序：

1. exact compatible 时尝试 encoded passthrough；
2. 只做 depacketize/repacketize/feedback adaptation；
3. 必要时使用独立 transcode pool；
4. admission 不足时显式 audio-only degrade 或拒绝 video。

Room 端 target implementation 是 exact-source 固定的官方
[LiveKit Rust real-time SDK](https://github.com/livekit/rust-sdks) 及其 libwebrtc
PeerConnection。LiveKit Egress 是 recording/export，不是发布 carrier track 的路径；
Ingress/WHIP 是单向 ingest 候选，也不是本双向 Gateway。

packetization-mode 1 到 mode 0 若无法在 MTU 内无损 repacketize，必须转码、重新切
slice 或拒绝，不能默认 passthrough。两端都声称 H.264 不等于 passthrough 已通过；
exact SDK path、packetization、keyframe 和真实浏览器互通必须实测。

### 7.3 Transcode isolation

video decoder/encoder、GPU、native library 必须位于独立 fault domain：

- bounded queues；
- per-session CPU/GPU/VRAM budget；
- no unbounded frame buffering；
- crash 只影响绑定 sessions；
- audio 继续；
- restart 产生新 generation；
- old output 因 fence 被拒绝。

## 8. Voice↔Video 状态机

### 8.1 添加视频

```text
receive validated initial INVITE or active re-INVITE/UPDATE
  -> evaluate tenant/carrier/video policy
  -> resolve early/late offer, 100rel/PRACK, ACK/UPDATE and glare policy
  -> compile candidate video edges
  -> reserve RTPengine/Gateway/SFU/GPU
  -> prepare local capacity/token/identity/unconnected transport only
  -> early/reliable offer-answer: persist NegotiationDecision before final SIP response
  -> late offer in 2xx: persist immutable 2xx offer receipt, wait ACK answer,
     then persist NegotiationDecision; no media writer is authorized while waiting

  no predecessor:
    -> commit new Bridge/Media generation
    -> join combined participant and publish tracks
    -> enable new audio/video writers

  replacing active audio executor:
    -> persist revoke-old decision
    -> invalidate old fence and wait zero-output
    -> commit new Bridge/Media generation
    -> join combined participant and publish tracks
    -> enable new audio/video writers

  -> wait for RTP + keyframe + track observation
  -> release superseded audio bridge generation
```

Participant join、track publish 和 packet output 都是 LiveKit-visible external effects，
不属于 `prepared_blocked`。若未来 SDK 迫使 prepare-time join，该 join 必须单独持久化
receipt，并具有 abort/query/tombstone/compensation；不能标记为无副作用 prepare。
SIP `NegotiationDecision` 与 Media generation commit 是两个 receipt。前者冻结
offer/answer、response 与 compensation，后者才授权 writer。late-offer 是唯一时序例外：
2xx 自身携带 offer 时，先持久化 `LateOffer2xxReceipt` 与 offer digest，收到合法 ACK
answer 后才生成完整 `NegotiationDecision`；这段等待期仍禁止 commit/join/publish。
可靠临时响应完成的 offer/answer 必须持久化 PRACK receipt 与 provisional digest，final
2xx 必须匹配该 digest。2xx 后失败只能按冻结策略执行 compensating re-INVITE/UPDATE
或终止，不能复活旧 fence。

### 8.2 移除视频

```text
validated offer removes/rejects video
  -> durable decision
  -> revoke video writers and wait zero-output
  -> unpublish/stop tracks
  -> preserve audio and Call
  -> return audio to LiveKit SIP/RTPengine when policy selects
  -> cleanup Gateway resources
```

状态机必须分别实现：

- inbound initial AV；
- outbound initial AV；
- active voice→video；
- active video→voice；
- repeated toggles；
- video failure→negotiated audio；
- AV→ordinary RTPengine audio。

并覆盖 late offer、PRACK/100rel、UPDATE/ACK、491 glare/retry、duplicate request、
CANCEL/BYE、4xx、timeout、200 后无 keyframe、rollback 和 compensating re-INVITE。
视频故障后的 audio-only 必须通过新 offer/answer 收敛，不能只本地停视频。

SIP 终止与重新协商语义固定如下：

- established dialog 在任意非终态重新协商阶段收到 BYE，都终止整个 dialog；
- initial INVITE 在 final response 前收到 CANCEL，返回 `200 CANCEL + 487 INVITE` 并终止；
- in-dialog re-INVITE 在 final response 前收到 CANCEL，返回
  `200 CANCEL + 487 re-INVITE`，释放 candidate，恢复原 `audio_active` 或 `av_active`；
- INVITE final response 之后到达的 CANCEL 不得改动 dialog/media；匹配 transaction 时
  `200 CANCEL` 但无效果，否则 `481`；
- active `av_active` 的 media-changing re-INVITE/UPDATE 与 audio call 使用同一状态机，
  必须覆盖 hold/resume、direction、codec、video add/remove；
- 无 SDP media change 或 offer/answer digest 未变化的
  [RFC 4028 session refresh](https://www.rfc-editor.org/rfc/rfc4028.html) 由
  Dialog Timer 子状态机处理，只更新 Session-Expires/Min-SE/receipt，保持原 writer 与
  Media generation；刷新失败可按协议重试或终止 Call，但不得制造周期性媒体 gap；
- [RFC 3261 late-offer](https://www.rfc-editor.org/rfc/rfc3261.html) 等 ACK answer 时禁止
  并发新 offer：UAS 只重传已存 2xx，超时后终止；
  UAC 必须发送合法 ACK answer，不可接受时用合法拒绝媒体的 answer ACK 后 BYE；
- [RFC 3262 reliable provisional](https://www.rfc-editor.org/rfc/rfc3262.html) 与 final
  SDP 不一致时，UAS 在上 wire 前改发 non-2xx 并恢复
  predecessor；UAC 已收到 2xx 时必须 ACK 后 BYE，不能把 2xx 当作可拒绝响应；
- `491` 只在有 retry budget 时重试；耗尽后按 predecessor audio/AV 或 initial-call
  failure 三个确定分支收敛；
- join、keyframe 或 Gateway 失败按冻结 policy 二选一：显式 audio-only compensation，
  或 AV 原子失败并终止；不得静默保留半条 AV path。

每次转移持久化不可变 `SipAvTransitionRecord`：

```text
transition_id / attempt / idempotency_key
from_state / to_state / event / matched_rule_id / guard_revision / guard_result
action / selected_sip_response / response_receipt
negotiation_decision_id / offer_answer_digest
old_bridge_generation / candidate_bridge_generation
old_zero_output_receipt / new_commit_receipt / observation_receipt
rollback_or_compensation / terminal_reason
```

允许转移不是自由组合，而由 machine contract 的 `allowed_transition_rules` 冻结：
每条 rule 明确 priority、from states、events、guard、to state、action、SIP response 和
compensation；只允许最高优先级唯一匹配，零匹配或多匹配一律 fail closed 并审计。
rule table 以 canonical JSON SHA-256 绑定，验证器必须重算而不是只相信声明值。
终态优先级固定为 established-dialog BYE、pre-final initial/re-INVITE CANCEL、
late-CANCEL no-effect、existing tombstone、timeout、491 retry、duplicate replay。
duplicate 只能 replay 已存 response/receipt，不能产生新 effect。

状态至少包括 `idle`、`audio_active`、`local_preparing`、`offer_answer_pending`、
`reliable_provisional_negotiated`、`late_offer_ack_answer_pending`、`retry_wait`、
`negotiated_blocked`、`old_revoking`、`old_zero`、`new_committed`、`joining`、`av_active`、
`fallback_negotiating`、`terminating`、`terminal`。事件至少包括 initial inbound/outbound、
re-INVITE、UPDATE、PRACK、ACK、2xx、4xx、final-SDP-mismatch、491、timeout、duplicate、
CANCEL、BYE、keyframe observed/missing、gateway loss 和 video remove。

原子边界：

1. early/reliable offer-answer 的 `NegotiationDecision` durable 后才发送/接受 final SIP
   response；late-offer 先 durable 2xx offer receipt，ACK answer 后才 durable decision；
2. final SIP acceptance 本身不授权媒体 writer；
3. replacement 必须 old zero-output receipt 在 new Media commit 之前；
4. new Media commit 在 participant join/publish 之前；
5. 每个外部 effect 后写 receipt；timeout 按同 transition ID query/reconcile；
6. rollback 不能删除历史 decision，只追加 compensation transition。

### 8.3 Gateway crash

1. writer stops；
2. RustPBX/Coordinator detects lease/health loss；
3. audio continues if on separate Edge；否则触发 audio fallback；
4. old generation fenced；
5. new participant generation prepare/commit；
6. stale participant/track cleanup；
7. recording/billing timeline marks discontinuity；
8. no claim of seamless recovery before packet evidence。

## 9. Participant 与 Audio executor policy

生产 ViLTE AV 只采用 combined topology：同一 Gateway participant/PeerConnection 执行
audio+video，以获得明确的 AV clock mapping、track ownership、UI/Egress、permission
和 cleanup。

以下两类不能混淆：

1. `SIP audio + unrelated Room video context`：电话 participant 只有 audio，Room 内
   其他人/设备有视频；这是既有 LiveKit SIP 合法场景；
2. `SIP audio participant + Gateway video-only participant`：仅为
   `VILTE-AV-SPLIT-RESEARCH`。在 composite identity、跨 participant sync、audio track
   selection/mix、UI/Egress/permission/cleanup 合同通过前不得生产。

video removal 后可以短暂保留 combined Gateway audio 以防抖；稳定 voice-only 后按
ADR-8 break-before-make 回到 LiveKit SIP/RTPengine。每条 audio Edge 始终只有一个 writer。

## 10. DTMF、Hold、Transfer 与终态

- RFC4733/telephone-event 的 canonical DTMF 业务事件继续归 RustPBX；
- Gateway 只转发/上报带 sequence 的媒体事件；
- hold/sendonly/recvonly/inactive 分 media component 处理；
- video hold 不隐式挂起 audio；
- REFER/Replaces/route change 由 RustPBX 决定，并生成新的 Edge/Bridge generation；
- BYE/CANCEL/participant delete/track unpublish 并发由 terminal decision 和 tombstone 收敛；
- Room 或 participant forged metadata 不能终止 carrier Call。

## 11. Recording 与 Billing

- 同一 `billing_key` 贯穿 voice/video/channel switching；
- Voice CDR、LiveKit usage、Gateway usage 是输入，不各自结算客户账单；
- video bitrate/GPU/track 可作为计费 dimension，但只由 OPC Billing rating；
- recording intent 不因 mode switch 改变；
- audio/video source segment 各有 generation、clock、hash 和 discontinuity；
- root RecordingManifest 只有一个 writer；
- recorder/upload/Egress 故障不影响 AV media。

split/combined topology 的每个 media component 都必须指定唯一 capture executor。
Voice recorder、Gateway capture、LiveKit Egress 之间的 capture 切换使用
prepare/revoke/zero-output fence；segment receipt 必须携带 source clock 到 Interaction
timeline 的映射。

usage receipt 的幂等键固定为
`(billing_key, media_component, edge_generation, interval)`。RTPengine、LiveKit、
Gateway 和 recorder observation 由 OPC Billing 去重，并以 terminal watermark 收敛；
任何 executor 都不能自行 rating，也不能因重复 webhook 双计费。

## 12. 安全

- SIP/SDP 只消费通过 Edge-to-Core contract 的输入；
- Gateway workload identity 只允许目标 tenant/Room/purpose；
- token 短期、单次、带 participant/track/generation/nonce；
- carrier↔RTPengine、RTPengine↔Gateway、Gateway↔LiveKit 使用三个独立 crypto context；
- carrier 边界 SRTP 的 termination、ROC/replay/rekey 归 RTPengine；
- 内部 leg 默认使用独立 SRTP，由 RTPengine/Gateway 各自终止，Region Key Service 只发
  opaque refs；plain RTP 只可经隔离网络专项审批；
- LiveKit leg 使用 Gateway official client SDK/libwebrtc 的 ICE/DTLS-SRTP；
- 三段 key 不复用，分别 generation/fence/query/zeroize；raw key 不落 event/log；
- Gateway 不持有数据库通用凭据、object storage root key 或 billing writer；
- Room/participant/Call/track 查询强制 tenant scope；
- H.264/native decoder 输入需要 fuzz、limit 和 sandbox/fault isolation；
- media frame 不进入普通日志；
- PII/identity 不进入低基数 metric label；
- repair/delete 需要审计 actor、reason、target digest。

## 13. 容量与证据

AV profile 与 R4 Voice/LiveKit audio profile 完全独立，并至少拆为：

- `VILTE-AV-COMBINED`：一个 Gateway participant 的四条 directed AV Edge；
- `VILTE-AV-SPLIT-RESEARCH`：video-only Gateway + SIP audio，未解决 §9 前永不生产。

至少测：

- concurrent gateway sessions；
- topology-specific directed Edge counts；
- publish/subscribe tracks；
- H.264 passthrough/transcode ratio；
- resolution/frame rate/bitrate；
- CPU/GPU/VRAM/encoder slots；
- RTP/RTCP loss/jitter/reorder；
- keyframe acquisition；
- NACK/PLI/FIR；
- freeze/black frame；
- AV drift/lip-sync；
- TURN ratio 和 bandwidth；
- RTPengine sessions/ports/SRTP contexts/PPS；
- participant join、re-INVITE/UPDATE/control CPS；
- audio selection/mix/decode/encode slots；
- locked-peer source switch churn、SourceSelectionGeneration 和 conference N-1 fan-in；
- jitter/retransmit/keyframe caches 与 memory；
- RTCP feedback、keyframe burst 和 pacer；
- NIC/IRQ/NUMA、SFU publish/subscribe、failure reserve/N+1；
- voice→video/video→voice gap/loss；
- recording continuity；
- crash/reconcile/orphan；
- 30m/2h/24h；
- 2/4/8 shard scaling。

场景独立：

```text
inbound new AV
outbound new AV
active voice -> video
active video -> voice
repeated toggles
video failure -> negotiated audio
AV -> ordinary RTPengine audio
```

任一呼叫发起方向、active transition、mock、SDK unit、audio-only 或 bridge-excluded
结果不能授权其他场景；每个 AV session 的四条 media direction 也必须分别计量。

## 14. 迁移与发布

1. 先建立 contract、fake IMS peer 和 real browser harness；
2. 实现 receive-only video；
3. 实现 send-only video；
4. 合并为双向 AV；
5. 加 audio executor handoff；
6. 加 recording/billing/security；
7. 加 fault/orphan；
8. 同硬件容量；
9. test tenant/new calls canary；
10. drain/rollback；
11. 独立 production approval。

不支持的 carrier/codec/profile 必须 fail closed 或明确 audio-only，不允许静默接受后黑屏。

## 15. 后果

正面：

- 坐席统一 LiveKit，不复制浏览器 WebRTC；
- 保持 RustPBX Call Authority；
- RTPengine 继续做擅长的 packet fast path；
- 为 ViLTE 和未来视频线路留下明确入口；
- video failure 可独立降级；
- Agent/recording/billing 不被 Gateway 绑死。

成本：

- 新增独立 gateway 和 video transcode fault domains；
- H.264/WebRTC packetization、feedback 和 AV sync 复杂；
- 四条 Edge、两种 audio executor 增加协调成本；
- 需要真实 IMS/ViLTE peer、浏览器、GPU 和长稳 fleet；
- 首期切换会有可感知 gap。

## 16. 最终裁决

ViLTE 视频不通过 LiveKit SIP，也不由 RTPengine 单独完成，更不在 RustPBX 中再造一套
浏览器 WebRTC。生产目标是 RustPBX 控制、RTPengine 锚定、独立 AV Participant
Gateway 映射、LiveKit 承载坐席 Room。

所有视频、passthrough、transcode、切换、降级、恢复和容量结论在真实测试前保持
`not_run`；文档 Accepted 不自动启用任何服务器能力。
