# ADR-CCAAS-8：Voice/SIP 与 LiveKit 桥接和双向切换

- 状态：**Accepted for staged implementation**
- 日期：2026-07-30
- 决策 ID：`voice-livekit-bridge-handoff-r1`
- 适用范围：R4 D0.3 contract-first slice、历史 Goal 映射 `Goal 3L` 与执行阶段
  `U6`
- 运行时验证：`not_run`
- 真实媒体验证：`not_run`
- 容量结论：`none`
- Supersedes：无
- 依赖：
  [ADR-CCAAS-3](ccaas-3-recording-evidence.md)、
  [ADR-CCAAS-5](ccaas-5-media-authority-and-rtpengine.md)、
  [ADR-CCAAS-7](ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)
- 规范性架构：
  [rvoip-opc-communication-foundation-integration-design.md](../design/rvoip-opc-communication-foundation-integration-design.md)
- 总体 Goal 与证据口径：
  [communication-foundation-vos5000-parity-performance-plan.md](../design/communication-foundation-vos5000-parity-performance-plan.md)
- R4 实施计划：
  [2026-07-29-unified-voice-foundation-r4.md](../superpowers/plans/2026-07-29-unified-voice-foundation-r4.md)
- Revision 4 根 machine contract：
  [unified-voice-foundation-r4-v1.json](../capacity/contracts/unified-voice-foundation-r4-v1.json)
- machine Authority matrix pointer：
  `docs/capacity/contracts/unified-voice-foundation-r4-v1.json#/authority_matrix`
- Voice↔LiveKit machine slice pointer：
  `docs/capacity/contracts/unified-voice-foundation-r4-v1.json#/livekit_handoff`

本 ADR 只接受 Authority、状态机、故障、计费、录制、容量和迁移边界。它不把现有
`livekit_bridge_create`、静态 readiness、单元测试或受控 Provider 解释为双向切换已经
完成，也不授权生产流量。所有本 ADR 新增的运行、真实媒体、故障和容量证据在实际执行前
都保持 `not_run`。

## 1. 背景

iveKit 当前同时存在两类实时通信事实：

- RustPBX/Voice Core 管理 SIP/PSTN Call、Leg、Business Dialog、路由、CDR、DTMF、
  录音意图和运营级恢复；
- LiveKit 管理 Room、WebRTC participant、track、ICE/DTLS/SRTP、SFU 转发、TURN 和
  Egress。

现有代码已经有一条受限的桥接控制路径：

- [`MediaCallService.ensureVoiceBridge`](../../src/agent-runtime/livekit/media-call-service.ts)
  以确定性 room/media-call identity 关联 Voice Call；
- [`LiveKitSipBridgeAdapter`](../../src/agent-runtime/ivekit/voice/adapters/livekit-sip.ts)
  在 Provider effect 前持久化 bridge，调用 LiveKit SIP 创建 participant，并在控制面
  timeout 后通过 participant lookup 对账；
- [`VoiceMediaBridgePort`](../../src/agent-runtime/ivekit/voice/ports.ts) 当前只暴露
  `create`、`transfer` 和 `reconcile`；
- [`VoiceLiveKitBridge`](../../src/agent-runtime/ivekit/voice/types.ts) 当前只记录一个
  bridge 的 call/media-call/room/participant/provider 映射与粗粒度状态。

这条路径可以作为实现基础，但它还不是“Voice/SIP 与 LiveKit 互相切换”的完整合同：

1. 没有 directed Edge、generation、owner epoch、writer fence 和 durable handoff
   decision；
2. 没有 `prepared_blocked`、`commit`、`revoke`、`release` 和纯只读 `query`；
3. `transfer` 的 idempotency identity 没有 durable attempt/receipt，控制面 timeout 后
   不能证明不会重复产生 Provider effect；
4. participant lookup 只能证明 participant 当前可见，不能证明 output gate、TX
   watermark、删除 tombstone 或旧 writer 已永久停止；
5. 没有 participant/bridge 的安全终止与 zero-reference cleanup；
6. SIP CDR、LiveKit usage、Voice recording 和 LiveKit Egress 若各自推进业务副作用，
   会产生双计费、双录音或重复证据；
7. 当前
   [`workload-profile.schema.json`](../capacity/schemas/workload-profile.schema.json)
   明确把 LiveKit SIP 固定为 `optional_bridge_excluded`，现有 Cell-10K/MIX-100K
   结果不能覆盖本 Goal。

产品需要覆盖以下用户结果：

- SIP/PSTN 呼叫进入 LiveKit Room；
- LiveKit Room 呼叫 SIP/PSTN endpoint；
- 活跃 SIP 端继续到浏览器；
- 活跃浏览器继续到 SIP/PSTN；
- 切换期间保持同一业务 interaction、合规策略、计费键和证据链。

这里的“切换”是媒体 endpoint/Edge generation 的 handoff，不是把 Call、Room、WebRTC、
CDR、计费或 Recording Authority 从一个系统迁到另一个系统。

## 2. 约束

本决策必须同时满足：

1. LiveKit 继续独占 Room、WebRTC participant/track、ICE/DTLS/SRTP 和 SFU Authority；
2. RustPBX 继续独占 Call/Leg/Business Dialog、Logical Media Graph、immutable Voice
   CDR fact 和业务 DTMF Authority；Region CDR convergence 独占 durable
   projection/finalization；
3. Media Engine Facade 继续独占 Media Plan、directed Media Edge assignment 和
   writer fence；
4. 同一 logical directed Edge generation 同一时刻只有一个 active writer；
5. 同一 logical recording role/time interval 只有一个 active capture executor；
6. 同一 billing dimension 只由一个 rating session 结算；
7. timeout、进程崩溃或数据库回写失败不能通过重新 create 猜测外部状态；
8. recorder、Egress、object storage、billing 或 evidence 故障不能回压已建立主媒体；
9. 未证明 packet-level output gate 时不得声称 make-before-break、seamless 或
   zero-loss；
10. Voice-only、LiveKit-only、readiness 或受控 mock 证据不得外推为 bridge capacity。

### 2.1 Ubiquitous language

- **Voice-LiveKit Bridge**：同一 business interaction 下，把 RustPBX/Voice Call 与
  LiveKit Media Call/Room 关联，并由一对相反方向 directed Media Edge 执行的 durable
  bridge。它是关联和执行合同，不是第二个 Call、Room、PBX、CDR 或媒体 Authority。
- **Voice-LiveKit Handoff**：在稳定 `interaction_id`、Voice `call_id`、business
  policy 和 `billing_key` 下，把一个 logical endpoint/media role 从 old Bridge
  Generation 切到 new Bridge Generation 的 owner-fenced 过程。其 gap、loss、reorder
  和 duplicate 必须测量。
- **Bridge Generation**：一个 bridge 的不可变执行修订。writer、participant、
  transport、Backend、binding group membership 或 source selection 任一变化都创建
  new generation；旧 generation 只能 revoke、release 或保留 terminal tombstone。
- **Directed Media Edge**：Logical Media Graph 中从一个 source 到一个 destination 的
  单向媒体意图。双向媒体是两条相反 Edge；每个 Edge generation 只有一个
  `WireMediaBinding` 和一个 active writer fence。

## 3. 备选方案

### 3.1 方案 A：在既有 LiveKit SIP 路径上建立 Bridge Coordinator

RustPBX 通过 Media Engine Facade 创建 Voice↔LiveKit directed Edges；LiveKit SIP 是
外部 bridge executor，继续把 SIP/RTP endpoint 映射为 LiveKit participant/track。
OPC-owned Bridge Coordinator 只持久化关联、意图、decision、receipt 和 reconciliation，
不接管任一协议或媒体 runtime。

优点：

- 复用现有 LiveKit SIP、MediaCall 和 Voice bridge 代码；
- 不复制 WebRTC、TURN、SFU、SIP B2BUA 或 RecordingManifest；
- 可以把 current create path 逐步升级为 generation/fence 状态机；
- 与 ADR-CCAAS-5/7 的 directed Edge 和单一 Authority 模型一致。

成本：

- LiveKit SIP/LiveKit control surface 需要提供或经受控 fork 补齐 output gate、
  zero-output revoke、query 和 tombstone；
- 在这些能力缺失时，活跃切换只能采用有中断的 break-before-make；
- 必须增加 bridge-specific capacity profile 和独立真实链路 evidence。

### 3.2 方案 B：RustPBX/rvoip 直接实现 LiveKit WebRTC endpoint

RustPBX 或 rvoip 直接管理 ICE、DTLS、SRTP、TURN、WebRTC participant 与 track，再向
LiveKit 发布或订阅。

不采用。该方案会建立第二套 WebRTC Authority，复制 LiveKit/Coturn 的连接恢复、SFU
路由、安全和容量语义，并违反 ADR-CCAAS-7 明确拒绝 rvoip WebRTC runtime 的决定。

### 3.3 方案 C：把 LiveKit SIP 提升为主 PBX/Call Authority

所有 SIP participant、转接、终态和 CDR 由 LiveKit SIP 管理，RustPBX 退化为 trunk。

不采用。该方案会重复或迁移 Business Dialog、路由、owner recovery、CDR、计费和录音
Authority；现有 LiveKit SIP bridge 也没有 iveKit 的双腿 CDR、Region durability 和
运营恢复合同。

### 3.4 决定

采用方案 A。第一生产资格阶段只接受诚实的 break-before-make。未来只有在新 candidate
从 allocation 起即为 `prepared_blocked`、旧 writer 可返回 packet-level zero-output
ACK、两端可 query/tombstone 且真实故障证据通过后，才允许把 make-before-break 加入
eligible capability。

## 4. Goal 位置和实施边界

该能力的历史 Goal 映射固定为 `Goal 3L`：功能上位于 Goal 3 之后，与 Goal 4、Goal 5、
Goal 6 并行，而不是追加到 Goal 11 正式验收之后。Revision 4 实际执行阶段固定为
`U6: bidirectional_voice_livekit_handoff`。依赖按 slice 计算，不能把完整 U6 的最终
门禁误当成 repository/backfill 的启动门槛：

```text
Goal 3 Media Plan / Edge / writer-fence
        |
        +--> Goal 3L Voice <-> LiveKit Bridge & Handoff
        |        +--> Goal 4 codec/transcode slices
        |        +--> Goal 5 recording/evidence closure
        |        \--> Goal 6 SIP interop/transfer/failure closure
        |
Goal 7/8/9/10 capacity, admission, observability and independent fleet
        |
Goal 11 formal VOS-EQ / 100K finalizer
```

| Slice | 依赖 |
| --- | --- |
| repository/schema/backfill | 仅 D0；不启用 runtime behavior |
| durable coordinator/new-call base | U1 effect semantics + U3 Edge/generation fencing；G.711↔Opus 只等对应 U5 slice |
| G.729 carrier leg | U2 + 对应 U5 G.729 integration slice |
| rvoip/advanced SIP transport/transfer | 只等适用的 U4 module，不阻塞 rsipstack baseline |
| recording physical convergence | U6 lifecycle contract；真实 root manifest/source-chain evidence 在 U7 完成 |
| fault/capacity/production finalization | U7 → U8 → U9 |

Goal 3L 固定为四条不可合并的功能/故障/容量 slice：

| Path ID | 路径 | 建立/切换语义 |
| --- | --- | --- |
| `V2L_NEW` | SIP/PSTN → RustPBX → LiveKit SIP → Room/browser | new-call bridge admission |
| `L2V_NEW` | Room/browser → LiveKit SIP → RustPBX → SIP/PSTN | new-call bridge admission |
| `V2L_ACTIVE` | active Voice/SIP/PSTN → browser | generation handoff；首期 break-before-make |
| `L2V_ACTIVE` | active browser → Voice/SIP/PSTN | generation handoff；首期 break-before-make |

每条路径分别签署方向、offer/answer、DTMF、终态竞态、fault matrix、真实 RTP/SRTP、
recording/billing continuity 和容量。`V2L_NEW` 的通过不能授权 `L2V_NEW`，new-call
不能授权 active handoff，任何单向或 mock/readiness 结果也不能授权其反向路径。
共享源码或同一个 participant API 只允许复用测试资产，不允许继承 evidence status。

D0.3 只冻结本 ADR，并对齐当前
[`unified-voice-foundation-r4-v1.json`](../capacity/contracts/unified-voice-foundation-r4-v1.json)
的 `/livekit_handoff`。基础 G.711↔Opus bridge 可在 Goal 3 后实现；涉及 G.729、AMR
或 T.38 的 slice 依赖 Goal 4；计费/录制闭环依赖 Goal 5；REFER/Replaces、NAT、
IPv6、长通话和运营商互通依赖 Goal 6。任何 production profile 签署还依赖 Goal 7
至 Goal 11 的对应门禁。

当前 canonical machine-readable Authority 是
`docs/capacity/contracts/unified-voice-foundation-r4-v1.json#/authority_matrix`；
本 ADR 的 handoff 状态/证据 slice 是同一根合同的 `#/livekit_handoff`。两者不得混写
为一个 pointer。
R4 计划冻结的未来实现/测试路径为：

- `future:src/agent-runtime/ivekit/voice/postgres/media-bridge-store.ts`
- `future:src/agent-runtime/ivekit/voice/livekit-handoff.ts`
- `future:test/ivekit-voice-media-bridge-store.test.ts`
- `future:test/ivekit-livekit-handoff.test.ts`
- `future:docs/capacity/profiles/voice-livekit-bridge-v1.json`
- `future:docs/evidence/voice-livekit-bridge-handoff-real-media.json`
- `future:docs/evidence/voice-livekit-bridge-handoff-failure.json`
- `future:docs/evidence/voice-livekit-bridge-handoff-capacity.json`

`future:` 表示路径尚不存在，不能作为已实现或已通过证据。未来 slice-specific
contract/profile 不得降低当前 R4 contract 和本 ADR 的 single-writer、单计费、单录制
或 non-claim 要求。

## 5. Authority 矩阵

| 事实 | 唯一 Authority | 其他组件的合法角色 |
| --- | --- | --- |
| tenant、identity、business policy、合规、recording rule 与计费规则 | OPC/iveKit policy store | RustPBX、LiveKit 只消费版本化裁决 |
| Call、Leg、Business Dialog、业务终态 | RustPBX Call Core | LiveKit participant 只是关联 projection |
| owner epoch、route revision、command sequence | iveKit Voice owner contract | RustPBX 执行；Bridge executor 只校验 fence |
| RustPBX Protocol Transaction/Dialog | 当前选定 `SipFoundation` | LiveKit SIP 不写 RustPBX protocol shadow |
| LiveKit SIP native participant/call 状态 | LiveKit SIP executor | 通过 receipt/query 暴露，不成为 Business Dialog |
| Logical Media Graph | RustPBX Call Core | MediaCall 只保存 Room/participant projection |
| Media Plan、directed Edge、Backend assignment | RustPBX Media Engine Facade | Bridge Coordinator 编排 Facade decision |
| Edge generation 与 committed writer fence | RustPBX Media Engine Facade | Backend 只执行 exact fence |
| SIP 侧 ordinary RTP binding | 被 Facade 选中的 RTPengine Backend | 不决定 Room、route 或业务终态 |
| SIP/RTP 与 LiveKit track 的 gateway native session | LiveKit SIP executor | 不拥有 logical Edge assignment |
| Room、WebRTC participant、track、ICE/DTLS/SRTP、SFU | LiveKit | Coturn 只执行 TURN relay；RustPBX/rvoip 不接管 |
| bridge correlation、attempt、durable orchestration decision、receipt、tombstone | OPC-owned Bridge Coordinator store | 只持久化 Facade/Call Core 裁决，不成为 Call、Room 或 Media Authority |
| canonical DTMF event 与 IVR/业务副作用 | RustPBX per-Leg `DtmfEventAuthority` | LiveKit/SIP/RTP source 只上报候选输入 |
| immutable Voice CDR fact | RustPBX Call Core | LiveKit usage 只作为关联 usage fact |
| durable SIP CDR projection、final receipt 与 terminal repair | Region CDR convergence service | RustPBX 提交 immutable fact；LiveKit 不生成第二 SIP CDR |
| customer rating session | OPC/iveKit billing | CDR、bridge、LiveKit 只提交 usage facts |
| per-interaction recording intent 与 policy snapshot | RustPBX Call Core | 读取 OPC policy revision；executor 不自行决定开始录制 |
| root RecordingManifest、其下 source segment chains、retention、legal hold | Region recording plane | SIP recorder/LiveKit Egress 只执行 source-scoped capture job |
| capacity admission 与 signed profile | iveKit capacity ledger/finalizer | Backend 只上报 source-bound demand/usage |

任何实现如果让同一行出现两个可写 Authority，必须被拒绝或提交 superseding ADR。Bridge
Coordinator 不是第三个媒体引擎；它不解析 WebRTC、不写 SIP Transaction、不转发 RTP，
也不直接启动未被 Recording/Billing Authority 授权的副作用。

## 6. 标识与持久化合同

一个业务 interaction 可以同时关联 Voice Call、Media Call、LiveKit Room 和多个 bridge
generation，但只能有一个业务根身份。未来 contract 至少绑定：

```text
tenant_id
interaction_id
call_id
media_call_id
leg_id
sip_dialog_id
livekit_room_id
livekit_participant_id
room_name
bridge_id
bridge_generation
handoff_id
handoff_kind
direction
edge_id
edge_generation
binding_group_id
binding_group_generation
writer_fence
owner_epoch
command_sequence
idempotency_key
request_hash
decision_id
decision_hash
handoff_decision_id
activation_decision_id
predecessor_zero_output_receipt_hash
provider_participant_id
provider_call_id
backend_identity
last_command_id
last_command_hash
last_receipt_hash
terminal_receipt_id
terminal_receipt_hash
cleanup_state
billing_key
recording_intent_id
root_recording_manifest_id
recording_source_chain_id
state
created_at
updated_at
ended_at
```

规则：

- `interaction_id` 在 SIP↔browser handoff 中不变；
- `call_id` 是稳定的 RustPBX/Voice business Call identity；`media_call_id` 只是
  LiveKit Media Call correlation，不能替换它；
- `leg_id` 与 `sip_dialog_id` 绑定每次 SIP execution；`livekit_room_id` 与
  `livekit_participant_id` 绑定 LiveKit Authority 返回的 Room/participant fact，
  四者都不能替换稳定 `interaction_id`/`call_id`；
- `bridge_id` 标识逻辑关联，writer、participant、transport、Backend 或 immutable
  membership 改变时必须增加 `bridge_generation`；
- `direction` 只允许 `voice_to_livekit` 或 `livekit_to_voice`；
- 两个方向可以共享同一 native SIP participant/transport
  `binding_group_generation`，但各自保留 Edge generation 和 writer fence；
- `request_hash`、`decision_hash` 和 `last_command_hash` 必须使用 canonical payload；
- clear phone number、clear SIP URI、raw token、API secret、raw SRTP key 和未脱敏 SDP
  不进入 bridge durable metadata、日志或指标；
- Room/participant attributes 只能保存 opaque iveKit identity 和 correlation，不得被
  信任为 durable Authority；
- terminal bridge 保留 tombstone、最后 receipt 和清理结果；不得删除后让同一
  idempotency key 被解释成从未执行。

### 6.1 逻辑 Bridge、不可变执行事实与 CAS

目标存储不能继续用一行可覆盖记录同时表示逻辑关联、执行 generation、Provider
attempt 和最后状态。至少拆成以下事实：

| 记录 | 可变性与内容 |
| --- | --- |
| logical bridge | 稳定 `bridge_id/interaction_id/call_id/media_call_id/room_name`、policy/billing/root RecordingManifest correlation，以及当前 head pointer |
| bridge generation | append-only；冻结 generation digest、前驱 generation、Voice side 与 LiveKit side binding、两条反向 Edge/group generation、writer fence 和 Backend/participant/transport identity |
| bridge attempt | append-only；每次 prepare/handoff/release/cleanup 的 immutable attempt identity、request hash、expected predecessor 和 decision lineage |
| bridge command | append-only；`command_id/owner_epoch/command_sequence/operation/target/request_hash/decision_id`，同 identity 不同 hash fail closed |
| bridge receipt | append-only；关联 exact command，记录 Provider/Backend observation、gate/TX watermark、terminal result、observed_at 和 receipt hash |
| bridge head | 唯一可 CAS 推进的 projection，保存 `revision/owner_epoch/state/current_generation/current_attempt/last_command_sequence` |

一个 generation 必须同时冻结 **Voice side**（Call/Leg、RTPengine/Voice binding、
Edge/group generation）和 **LiveKit side**（Room、participant/track、LiveKit SIP
native call/transport）的 identity/digest，以及 `voice_to_livekit`、
`livekit_to_voice` 两条 directed Edge。任一侧 writer、participant、transport、
Backend、member set 或 source selection 改变，都创建新的 immutable generation；
不得原地改写旧 generation 或 receipt。

Bridge head 的每次状态迁移必须等价于：

```sql
UPDATE voice_media_bridge_heads
SET revision = revision + 1, owner_epoch = :new_epoch, state = :new_state, ...
WHERE bridge_id = :bridge_id
  AND revision = :expected_revision
  AND owner_epoch = :expected_epoch
  AND state = :expected_state;
```

影响行数不是 1 时，stale owner/command 必须 fail closed 并 query/reconcile；禁止
last-write-wins。generation、attempt、command、receipt 表通过外键
`ON DELETE RESTRICT` 串联，物理资源 cleanup 只追加 terminal receipt/tombstone，不
删除审计 lineage。GC 只能在 retention/legal-hold 允许、所有 refs/unknown/repair
归零且 tombstone 已提交后处理允许删除的 payload；identity/hash/tombstone 仍保留。

当前代码尚未实现该模型：bridge persistence 暂位于 `VoiceRecordingRepository`，
`VoiceLiveKitBridge` 是一个粗粒度可更新 projection，`VoiceMediaBridgePort` 也只有
`create/transfer/reconcile`。实施时必须抽出
`VoiceMediaBridgeRepository`；“当前有表、有 create/reconcile”不等于 generation、
CAS、command/receipt 或 terminal tombstone 已实现。

### 6.2 存储迁移

存储迁移不得引入两个可写 Bridge Coordinator，也不得把缺失事实倒推成已收到的
receipt：

1. 先创建 logical bridge、generation、attempt、command、receipt、head 和 tombstone
   表及 `RESTRICT` 外键，不改变 runtime selector；
2. 每个旧 row 幂等 backfill 一个 logical bridge 和 `generation=0` 的
   `legacy_unverified` attempt，只复制真实存在的 correlation/status；不得合成
   writer fence、blocked gate、TX watermark 或 Provider ACK；
3. 对存在 Provider identity 的旧 row 执行只读 query；仅把实际观察到的事实追加为
   receipt，unknown 保持 unknown；
4. 按 bridge 获取迁移 fence，提高 owner epoch，并以
   `(revision, owner_epoch, state)` CAS 切换唯一 writer；旧 repository 随即只读，
   禁止 dual-write；
5. canary 新 interaction 后，再迁移 active/terminal row；每批都核对 logical bridge、
   generation、attempt、command、receipt、unknown 和 tombstone 数量；
6. 只有旧表 active/unknown/repair 为零、所有新 head/receipt 可对账、rollback window
   与 retention 到期后，才可移除兼容读路径。`ON DELETE RESTRICT` 或 legal hold
   阻止删除时必须保留，不得绕过。

该迁移不创建、拆分或替换 root `RecordingManifest`，也不改变任何 source segment
chain；bridge rows 只保存 opaque recording correlation。

## 7. Durable bridge lifecycle

### 7.1 状态机

Bridge generation 的规范状态机为：

```text
absent --prepare--> prepare_pending
prepare_pending --prepare ACK--> prepared_blocked

prepare_pending/prepared_blocked
  --abort before activation/handoff decision--> abort_pending
abort_pending --abort/release ACK--> released

prepared_blocked --persist immutable activation_decision--> commit_pending
commit_pending --commit ACK--> active

active --persist immutable revoke_decision--> revoke_pending
revoke_pending --zero-output revoke ACK--> revoked_receive_only
revoked_receive_only --zero live refs + release--> release_pending
release_pending --release ACK/tombstone--> released

any mutation timeout/disconnect
  --> unknown(expected_operation, decision_id, command_hash)
  --query/reconcile exact durable fact--> a known state above

commit_pending/active/revoke_pending
  --predeclared compensation + cleanup--> compensated_failed
```

`released` 和 `compensated_failed` 是 durable terminal facts。物理资源可以已经不存在，
但 tombstone、decision 和 receipt 仍必须可对账。

非法转换：

- `prepared_blocked -> emit`；
- `active -> abort`；
- `unknown -> create new generation`，除非旧 generation 已通过 query/tombstone 明确
  terminal 且新 generation 使用新的 identity；
- revoked generation 再次 active；
- 修改同一 generation 的 writer、Backend、participant、transport 或 member set；
- activation decision 或 composite handoff decision 之后把同一 attempt 改写为
  pre-decision abort。

### 7.2 `prepare`

`prepare` 必须：

1. 校验 owner epoch、command sequence、policy、capacity reservation 和 exact Backend
   identity；
2. 创建或解析确定性的 Room/participant/dispatch target；
3. 从 allocation 创建时就关闭 candidate outbound output gate；
4. 允许 candidate reserve、negotiate、receive、authenticate、count/drop，但不允许向
   logical destination 发媒体，不允许产生 DTMF、recording、AI 或 billing 副作用；
5. 返回 participant/native call、binding group、bundle digest、gate state、command
   identity/hash 和 lease expiry receipt；
6. 同一 idempotency identity/hash 重放返回同一 receipt；同 identity 不同 hash 冲突。

如果 LiveKit SIP/LiveKit API 不能证明 allocation-time output gate，能力必须报告
`prepare_blocked=false`，不得用“先 create 再 mute”冒充原子 prepare。

### 7.3 `commit`

初始 bridge 没有 predecessor writer，可由 initial `activation_decision` 直接授权
candidate commit。handoff 有 predecessor writer 时，`handoff_decision` 与 candidate
`activation_decision` 必须分离：

1. `handoff_decision` 冻结 old/new generation、执行顺序、deadline 和 compensation；
2. old generation revoke 并返回 zero-output receipt；
3. 该 receipt 先 durable 持久化；
4. 再生成引用
   `(old_generation, zero_output_receipt_hash, last_tx_watermark)` 的
   `activation_decision`；
5. candidate Backend 只有看到 exact activation decision 才能 commit。

`activation_decision` 之前必须在 durable transaction 中冻结：

- immutable candidate identities；
- exact Edge/group generations 和 writer fences；
- capacity reservation；
- recording/billing policy snapshot；
- `activation_decision`、decision hash 和 compensation policy；
- handoff candidate 必须额外冻结 predecessor zero-output receipt hash。

Backend 只有在 decision、owner fence、group/member digest 和 command hash 全部匹配时
才能打开 output gate。handoff candidate 若缺 predecessor zero-output receipt 或
receipt/hash 不匹配，必须 fail closed。ACK 必须带首次 TX watermark。控制面回写失败
后重试 `commit` 返回原 receipt，不创建第二 participant、call 或 track。

### 7.4 `abort`

`abort` 只允许在 activation decision 和 composite handoff decision 都不存在时执行。
它幂等关闭 candidate、释放 reservation，并写 terminal tombstone。若 Provider create
的 outcome unknown，先 `query`，不得直接再 create 或把资源标为 released。已有
handoff decision 但尚未生成 activation decision 时，只能继续 old revoke、执行
预声明 compensation 或进入 `compensated_failed`，不能把 attempt 冒充 pre-decision
abort。

### 7.5 `revoke` 与 `release`

`revoke` 先关闭所有与该 Edge generation 对应的 output path，排空 in-flight send，再
返回 zero-output ACK 和最后 TX watermark。UI mute、participant muted、Room 列表中
不可见或 SIP BYE 已发送都不是 packet-level zero-output ACK 的替代物。

revoke 后的 bounded grace 只允许 authenticate/count/drop；不得 forward、生成 canonical
DTMF、写 recording、触发 AI 或产生 billing interval。物理 participant、ports、track
和 reservation 只在 group `live_member_refcount == 0` 后释放一次。

既有 Room 不是 bridge 私有资源。只有同时满足以下条件才可删除 Room：

- Room 由该 bridge generation 创建；
- durable metadata 明确标记 exclusive ownership；
- 无非 bridge participant；
- 无 active recording/Egress；
- 所有 Edge/group live refs 为零。

其他情况只删除本 generation 创建的 participant/binding，不删除 Room。

### 7.6 `query`

`query` 是纯只读操作，至少返回：

- participant/native call 是否存在及 terminal tombstone；
- exact Room、participant、provider call 和 generation identity；
- output gate；
- first/last TX watermark；
- last applied command ID/hash/receipt；
- handoff/activation/revoke decision state；
- predecessor zero-output receipt hash；
- release state 和 live-member count；
- Backend instance/source/config identity。

Room participant list 或 `sip.callID` attribute 只能作为一项 observation，不能单独证明
writer、commit、revoke 或 release 终态。

### 7.7 `reconcile`

`reconcile` 读取 durable decision，再通过 `query` 收敛 exact generation：

- durable prepare、Provider absent：重放同一 prepare；
- durable pre-decision abort、Provider present：重放同一 abort/release；
- initial activation decision、Provider prepared：重放同一 commit；
- handoff decision 存在但 predecessor zero-output receipt 缺失：只 query/reconcile
  old revoke，绝不 commit candidate；
- predecessor zero-output receipt 已 durable，activation decision 存在且 Provider
  prepared：重放同一 commit；
- activation decision、Provider active：持久化原 receipt，不 redial；
- durable revoke decision、Provider active：重放同一 revoke；
- durable release、Provider present：按 exact generation 清理；
- hash、generation、participant 或 fence 冲突：fail closed，进入人工/自动 repair，
  不接管不属于本 decision 的资源。

`reconcile` 不是 create fallback。unknown 期间冻结该 logical role 的后续 handoff；在旧
writer 是否仍可能输出未确认前，禁止激活新 writer。

### 7.8 同一 Call 的交替往返与并发仲裁

`V2L_ACTIVE` 和 `L2V_ACTIVE` 不是一次性迁移。一个仍处于 active 的同一业务
`CallId` 必须允许在有界场景内交替往返；资格场景固定为 32 个完整 round trip。每次
switch 都创建新的 bridge、Edge 和必要的 binding-group generation，禁止复活或原地
改写已 revoke 的 generation。往返过程中业务 Call、immutable Voice CDR、OPC rating
session 和每个 recording role 的 root `RecordingManifest` 始终各只有一个；Provider
participant、port pair、Backend allocation 和 writer 只允许随当前 generation 有界
替换，不能随往返次数累积。

同一 Call 的并发 switch command 只由 Bridge Coordinator Store 仲裁：

1. command 先以 `(head revision, owner_epoch, idempotency_key, request_hash)` 做 CAS；
2. 唯一 CAS winner 才能写 durable handoff decision 并进入 Provider mutation；
3. 相同 idempotency key/hash 重放 winner 的原 decision/receipt；
4. 相同 key 不同 hash 冲突并 fail closed；
5. CAS loser 不得创建 participant、申请 port 或打开 writer，只能 query 并 reconcile
   winner 的 exact generation；
6. timeout-after-apply 同样查询原 command，不得以新 generation 猜测重试。

必须以状态机/property test 覆盖任意交错的双向 command、CAS loser、Provider
apply/ACK/durable-write 各故障点。每次 transition 断言没有重复或增长的 Call、CDR、
billing、recording root、active participant、port 和 writer；终态必须证明
participant、port pair、Backend allocation、writer、pending command 和
unreconciled receipt 全部为零。任何一项只能由后台 repair 最终收敛而未能在证据窗口
归零时，本场景保持 `not_run`/失败，不能获得生产资格。

### 7.9 Participant terminate/delete 与 orphan cleanup

终止和删除是两个 durable fact：

- `terminate` 持久化 exact generation 的 terminal decision，先 revoke media writer，
  再向 LiveKit SIP/SIP endpoint 发 BYE/terminate；
- `delete participant` 只在 terminal receipt 或 query tombstone 证明 native call 已
  结束后执行，并返回独立 idempotent cleanup receipt；
- terminate/delete timeout 进入 unknown，按同一 command identity query/reconcile，
  不发送第二次不确定的 BYE、transfer 或 participant create；
- cleanup target 必须同时匹配 tenant、bridge/generation、Room、participant、
  provider call 和 receipt digest，不能只按 Room/participant identity 删除；
- orphan scan 只能收敛有 durable bridge/attempt 归属的资源。无法证明归属的 participant
  进入 quarantine/repair，不自动删除；
- Room cleanup 继续服从第 7.5 节 exclusive ownership 与 zero-reference 条件；
- terminal receipt、cleanup receipt 和 tombstone 永久阻止同一 attempt 被解释成从未
  执行。

## 8. 双 directed Edge 与 single-writer

一个 Voice↔LiveKit bridge 至少展开为两条相反方向的 logical Edge：

```text
Voice/SIP source
  -- Edge V2L / writer fence V2L --> LiveKit room publication

LiveKit selected source/track
  -- Edge L2V / writer fence L2V --> Voice/SIP destination
```

两条 Edge 可以由同一 LiveKit SIP participant 和 native RTP/WebRTC gateway session
执行，也可以共享端口和 security state，但共享不改变以下规则：

- 每条 Edge 有独立 ID、generation、binding revision 和 writer fence；
- group membership 在 generation 内 immutable；
- 任何 source selection、participant、transport、codec chain 或 writer 改变都创建新
  generation；
- old/new generation 的相同 logical role 永不同时 active；
- conference 中多个独立 speaker/source 是多条不同 Edge，不违反 single-writer；
- 同一个 speaker role 的 SIP source 与 browser source 同时被转发，会形成重复音频或
  echo，属于违规 writer overlap；
- read-only tap、recording、AI 和 quality inspection 必须是独立 Edge，不能复用主 Edge
  writer fence。

### 8.1 SIP 继续到浏览器

未来具备 blocked-prepare 能力时：

1. 浏览器 participant 加入并完成 WebRTC readiness，但 candidate speaker output 保持
   blocked；
2. SIP→LiveKit old Edge 仍是该 logical speaker role 的唯一 writer；
3. 持久化 immutable `handoff_decision`；
4. revoke old SIP writer 并取得 zero-output ACK；
5. durable 持久化 old zero-output receipt/last TX watermark；
6. 生成引用该 receipt 的 candidate `activation_decision`；
7. commit browser source Edge；
8. old SIP leg 按 policy 结束、保持只收或转为其他独立角色；
9. 记录 writer gap、late-old、first-new、loss/reorder/duplicate。

### 8.2 浏览器继续到 SIP/PSTN

未来具备 blocked-prepare 能力时：

1. dial candidate SIP leg，early media 保持隔离或映射为显式独立 Edge；
2. SIP answer 不自动取得当前 logical speaker/listener role；
3. 持久化 immutable `handoff_decision`；
4. revoke old browser role 的 outbound writer 并取得 zero-output ACK；
5. durable 持久化 old zero-output receipt/last TX watermark；
6. 生成引用该 receipt 的 SIP candidate `activation_decision`；
7. commit SIP Edge；
8. browser participant 可继续以其他 Room role 存在，但不得继续写已切换 role。

### 8.3 DTMF

RFC 4733、SIP INFO、in-band detector 和 LiveKit data/control input 先归一化为
RustPBX per-Leg candidate event。只有 RustPBX `DtmfEventAuthority` 可以生成 monotonic
canonical sequence 并推进 IVR、recording marker、Webhook 或业务状态。handoff grace
中的旧 generation 不能产生 DTMF 副作用。

## 9. Break-before-make 的诚实边界

当前 `LiveKitSipClientPort` 只有 trunk list、create participant 和 transfer participant；
当前 lookup 只查询 participant。现有接口没有：

- allocation-time output gate；
- commit/revoke primitive；
- zero-output ACK/TX watermark；
- participant delete/release receipt；
- provider terminal tombstone；
- durable transfer query/reconcile。

因此当前实现不能证明 active make-before-break，也不能声称 seamless、zero-gap 或
zero-loss。

### 9.1 Break-before-make durable state machine

首期 break-before-make 不复用 blocked-prepare 状态机。它有独立的 composite handoff
状态：

```text
prechecked
  --persist immutable break_decision--> break_decided
break_decided
  --revoke old--> old_revoke_pending
old_revoke_pending
  --zero-output observation durable--> old_revoke_confirmed
old_revoke_confirmed
  --create exact new generation--> new_create_pending
new_create_pending
  --active receipt--> active
new_create_pending
  --definite busy/reject/no-answer/cancel/failure--> interrupted

old_revoke_pending --timeout/disconnect--> old_revoke_unknown
old_revoke_unknown --query/reconcile old exact generation-->
  old_revoke_pending | old_revoke_confirmed

new_create_pending --timeout/disconnect--> new_create_unknown
new_create_unknown --query/reconcile new exact generation-->
  new_create_pending | active | interrupted

interrupted --cleanup succeeds--> interrupted_terminal
interrupted --cleanup/compensation cannot converge--> compensated_failed
```

规则：

- policy、capacity、consent、recording reservation 或 readiness 在
  `break_decision` 前失败，结果是 `precheck_failed`，old writer 不变；
- `break_decision` 后 old writer 必须先收敛到 `old_revoke_confirmed`，才能 create new；
- `old_revoke_unknown` 期间禁止 create new；
- `new_create_unknown` 期间禁止 redial/create another generation；
- busy、reject、no-answer、cancel 或 definite create failure 若发生在 old 已 revoke
  之后，结果是显式 `interrupted`，不能声称 old writer 保持不变；
- `interrupted_terminal` 是 handoff 业务终态；candidate resource 的 release/tombstone
  仍按第 7 节 group lifecycle 对账；
- 恢复 old endpoint 也必须建立新的 Bridge Generation，不能 re-activate revoked
  generation。

### 9.2 首期行为

初始 eligible 行为固定为 break-before-make：

1. 校验新 endpoint、capacity、policy 和 readiness，但不创建一个可能输出的并行 writer；
2. 持久化 `break_decision`；
3. 停止旧 logical role writer，并通过当前可用的最强 packet observation 确认旧输出已停；
4. 再创建/激活新 endpoint；
5. 测量并记录媒体中断、writer gap、setup RTO、loss、reorder 和失败原因；
6. 新 endpoint 失败时如实返回 handoff failed/interrupted，不把旧 generation 非法
   re-activate。

`break_decision` 不是要求
`prepared_blocked` candidate 的普通 `activation_decision`。`break_decision` 一旦使旧
writer revoke，就不能改写为 pre-decision abort；恢复只能继续建立新 generation 或
进入显式 `compensated_failed/interrupted`。

如果当前 Provider 连旧 writer zero-output 都不能确认，则 active handoff 保持
`not_run/not_eligible`；只允许 new-call bridge selection 和 old-call drain。产品 UI
不得把“拨打另一个 endpoint”显示为无缝继续。

未来 make-before-break 资格不改变 single-writer：它只允许先分配 receive-only/
output-blocked candidate，真正媒体 writer 仍在 old zero-output ACK 后才切换。即使该
门禁通过，也只承诺 outbound writer 不重叠，不承诺 SIP/WebRTC 远端切换零丢包。

## 10. Billing 与 CDR

RustPBX Call Core 是 immutable dual-leg CDR fact Authority；Region CDR convergence
service 是 durable projection、final receipt 和 terminal repair Authority。它们管理
不同事实，不是双写同一 CDR。现有实现以 `voice-cdr:${interaction_id}` 生成 billing
key，并只在 durable CDR commit 后产生一个 `ivekit.voice.cdr.committed` event。新
Goal 必须保留该单一客户计费入口。

规则：

- handoff 前后 `interaction_id` 和根 `billing_key` 不变；
- `media_call_id`、Room、participant、provider call 和 bridge generation 只作为 usage
  fact correlation；
- LiveKit/SIP gateway 不直接生成第二个 customer charge 或第二个 SIP terminal CDR；
- bridge usage fact 以
  `(tenant_id, interaction_id, bridge_id, generation, direction, interval, metric)`
  幂等；
- 同一 tariff dimension 的 connected interval 使用去重后的 interval union，不把
  old/new handoff overlap 或 reconcile replay 重复相加；
- 如果 tariff 明确同时收费 PSTN minute 与 LiveKit participant minute，仍由同一 OPC
  rating session 按两个明确 dimension 结算；这不是组件各自收费；
- early media、prepared candidate、revoked grace 和 receive/count/drop 不进入 billable
  connected interval，除非独立 tariff 明确规定且 evidence 可对账；
- billing outage 只延迟 durable usage/rating，不阻塞已建立媒体；
- billing repair 重放 usage fact，不重建 bridge、不延长 CDR duration。

验收必须证明：

- 每个 interaction/rating revision 只有一个 authoritative rating session；
- create、commit、revoke、terminal event replay 不增加重复账单；
- handoff gap 不被虚构为 connected duration；
- old/new overlap 即使因 bug 出现，也被检测为 evidence failure，而不是双倍计费。

## 11. Recording 与 evidence

[ADR-CCAAS-3](ccaas-3-recording-evidence.md) 的 Region `RecordingManifest` 继续是唯一
录制治理和 evidence Authority；ADR-CCAAS-5 的 recording Edge/single-writer 约束继续
适用。

每个 `recording_intent_id + logical recording role` 在整个 interaction 中只有一个
root `RecordingManifest`。SIP fork、LiveKit TrackEgress、RoomComposite 或 handoff 后
的新 source 都只能在该 root manifest 下创建 source-specific segment chain，不得各自
创建竞争的 root manifest。目标 source chain 至少冻结
`source_chain_id/source_kind/source_identity_digest/first_segment_sequence/
last_segment_sequence/predecessor_chain_hash/bridge_generation_range/
discontinuity_reason`；segment 与 chain 都 append-only，root manifest 统一保存 consent、
policy revision、retention、legal hold、checksum finalization 和交付状态。当前代码与
schema 尚未证明这一 root/chain 模型，状态保持 `not_run`。

规则：

- 同一 logical recording role 和时间区间只有一个 active capture executor；
- SIP encoded fork 与 LiveKit TrackEgress 不得同时把同一逻辑音频角色写成两份可交付
  evidence；
- policy 若要求 SIP 原 track、LiveKit participant track、video 或 RoomComposite 等
  不同 source，必须声明为不同 recording role/source-track set，并分别接受 capacity、
  consent、retention 和 provenance 校验；
- source 在 handoff 中变化时，关闭当前 source segment chain，并在同一 root
  `RecordingManifest` 下以 predecessor hash 开启下一条 chain；需要表达的 gap、clock
  reset 或 source discontinuity 写入 chain transition，不关闭或替换 root manifest；
  同一 role/time interval 不得重叠写入；
- candidate `prepared_blocked` 和 revoked grace 不生成 recording segment；
- recorder job 必须携带 interaction、recording intent、bridge/edge generation、
  owner epoch 和 idempotent job identity；
- Provider callback 只能推进 exact manifest/job，不得凭 Room 或 phone number 猜测；
- mandatory recording handoff 在 candidate recording reservation 不足时拒绝 handoff，
  old active path 保持不变；
- established interaction 的 recorder/Egress/object storage 故障只使 recording
  complete/partial/failed，不终止主媒体；
- optional recording 可以按 policy 显式降级，但必须产生 durable event；
- legal hold、retention、consent、pause/resume/mask 在 handoff 前后保持同一 policy
  snapshot 或显式新 revision。

如果 SIP 与 LiveKit 两边都捕获了同一 role 的重叠媒体，该 attempt 必须标为录制证据
失败并进入 reconciliation；不得通过只隐藏其中一个下载链接把重复 capture 冒充成功。

## 12. 故障、竞态与清理

### 12.1 决策前故障

- prepare definite failure：abort candidate，取消 reservation，old writer 不变；
- prepare timeout：进入 unknown，query exact command；禁止 redial/create；
- blocked-prepare future path 的 remote reject/no-answer/busy/cancel：candidate
  terminal，old writer 不变；
- break-before-make 在 `break_decision` 前的 policy/capacity/consent/recording
  reservation/readiness failure：`precheck_failed`，old writer 不变；
- database 在 Provider effect 前失败：不调用 Provider；
- Provider success 后数据库失败：query/reconcile 原 participant，不创建第二个。

### 12.2 决策后故障

- commit timeout：保留 immutable activation decision，query/reconcile exact command；
- old revoke unknown：冻结 new commit，直到证明 old zero-output；
- break-before-make 在 old revoke confirmed 后遇到 busy/reject/no-answer/cancel 或
  definite create failure：进入 `interrupted`，不能写成 old writer 不变；
- handoff decision 存在但 activation decision 尚不存在：reconcile 只推进/query old
  revoke；缺 predecessor zero-output receipt 时绝不 commit new；
- old 已 revoke、new commit 失败：记录可见中断并执行预声明 compensation，不能声称
  old 无缝恢复；
- new active、durable ACK 丢失：query TX/command receipt 后补写，不重拨；
- RustPBX owner takeover：新 owner 必须携带更高 owner epoch，并先 reconcile durable
  decision；stale owner 只能 query；
- LiveKit SIP/LiveKit restart：依 participant/native call/tombstone 和 command receipt
  收敛；Room presence 不是充分证据；
- RTPengine failure：按受影响 Edge 显式记录 interruption，不能让 LiveKit participant
  presence 掩盖 SIP 侧媒体中断。

### 12.3 终态竞态

必须覆盖：

- SIP BYE 与 browser accept 同时发生；
- Room end、participant leave 与 commit/revoke 同时发生；
- caller cancel 与 outbound SIP answer 交叉；
- duplicate Webhook/provider event；
- owner takeover 与 cleanup worker 交叉；
- recording stop 与 source handoff 交叉；
- billing terminal CDR 与晚到 bridge usage 交叉。

终态选择由 durable Call/decision sequence 决定。迟到事件只补充可验证事实，不复活
Call、participant、writer、recording 或 billing interval。

### 12.4 清理

Cleanup 必须：

- 以 exact tenant/bridge/generation/provider identity 查询并删除；
- 只清理本 generation 创建且 receipt digest 匹配的 participant/native session；
- group live refs 为零后才释放共享 port/track/security state；
- 失败进入 bounded retry/dead-letter/repair，不使用无界队列；
- 保留 tombstone、decision、last TX watermark、receipt hash 和清理原因；
- 不删除用户创建或其他 interaction 仍在使用的 Room；
- 不删除已生成的 CDR、billing usage、RecordingManifest 或 evidence；
- 不在日志、dead letter 或 repair payload 中泄露 clear destination、token、secret 或 raw
  SDP crypto。

## 13. 必须场景

新 Goal 的最小场景矩阵包括：

1. SIP/PSTN → RustPBX → LiveKit SIP → existing/new Room；
2. LiveKit Room → LiveKit SIP → RustPBX/carrier/PSTN；
3. active SIP → browser handoff；
4. active browser → SIP/PSTN handoff；
5. blind/attended transfer、REFER/Replaces 与 Room transfer；
6. WebRTC 多参与人加一个或多个独立 SIP participant；
7. early media、no-answer、busy、reject、cancel 和 timeout；
8. hold/resume、mute、RFC 4733、SIP INFO、in-band DTMF；
9. SIP BYE、browser leave/reconnect、Room end 的竞态；
10. create/commit/revoke 后 durable write failure与 replay；
11. RustPBX、RTPengine、LiveKit SIP、LiveKit node 和控制 API 故障；
12. G.711↔Opus；涉及外部 `G729/8000` carrier leg 时使用 Goal 4 唯一
    transcoder，并把 G729A/G729AB 仅作为内部 processing/quality/capacity mode；
13. recording 在 handoff 前、中、后开始/停止，mandatory、consent 和 storage failure；
14. CDR/rating 跨 handoff 无重复、无虚构、无丢失区间；
15. IPv4/IPv6、NAT、TLS/SRTP、SSRC/RTCP continuity/reset；
16. tenant isolation、伪造 participant attribute、secret/PII redaction；
17. 24 小时 long-call/endurance 和 1/2/4/8 节点扩展。

未通过的 codec、transport、recording mode 或 failure scenario 必须保持独立
`not_run/failed`，不能用基础 G.711 happy path 代替。

## 14. 验收门禁

### 14.1 Contract 与状态机

- machine-readable Authority matrix 拒绝第二 Dialog/WebRTC/Media Plan/Recording/
  Billing owner；
- 状态机/property test 覆盖每个合法和非法转换；
- stale owner、stale generation、same idempotency/different hash 全部 fail closed；
- unknown/reconcile 不产生第二 participant、binding、recording 或 billing event；
- terminal tombstone 阻止已清理 generation 被重建为同一 attempt。

### 14.2 真实媒体

必须使用真实 RustPBX、RTPengine、LiveKit SIP、LiveKit、至少两个独立 browser context
和 SIP peer/运营商模拟器。证据至少包含：

- RTP/SRTP packet counters 与 source/config identity；
- candidate commit 前 TX delta；
- old revoke ACK 后 TX delta；
- first-new/last-old watermark；
- writer overlap、gap、loss、reorder、duplicate；
- 两端可听媒体、重复音频/echo；
- DTMF canonical sequence；
- Room/participant/track 和 SIP dialog trace。

静态 readiness、Room participant list、Playwright UI、mock HTTP 或 SDK success response
不能替代 packet evidence。

### 14.3 Billing/recording

- 一个 authoritative rating session；
- 同 dimension interval union，无 replay/overlap 双计费；
- 一个 logical recording role/time interval 一个 active capture executor；
- 一个 root `RecordingManifest` 下的 source segment chain predecessor/discontinuity
  可追溯，且无竞争 root manifest；
- recorder、Egress、object storage 和 billing 故障不终止 established media；
- mandatory recording 无 capacity 时 handoff fail closed；
- consent、retention、legal hold 和 checksum reconciliation 通过。

### 14.4 故障和恢复

- 每个 mutation 在 request send 前、Provider apply 后、ACK 返回前、durable write 前后
  注入故障；
- restart/takeover 后 exact decision 收敛；
- unknown 期间没有第二 writer；
- orphan participant、Room、port、track、reservation 和 multipart 为零，或存在明确
  bounded repair state；
- post-decision compensation 记录可见 interruption，不伪装成功。

### 14.5 交替往返/property 资格

- 同一业务 Call 依次执行 `V2L_ACTIVE -> L2V_ACTIVE` 32 个完整 round trip；
- 每次切换的 generation 严格递增，任何旧 generation 都不能重新 active；
- 双向并发 switch 通过 coordinator CAS 产生唯一 winner，loser fail closed 后只
  query/reconcile；
- 注入 CAS winner durable 后 ACK 丢失、Provider apply 后超时和 coordinator restart，
  不产生第二 participant、port、writer、billing interval 或 recording root；
- 每一步断言 Call/CDR/rating/recording root 不重复，active participant、port 和 writer
  数量有界；
- 最终 hangup/release 后 participant、port pair、Backend allocation、writer、pending
  command 和 unreconciled receipt 为零。

上述 scenario、property 和 fault assertion 均保持 `not_run`，直到真实实现和独立证据
执行完成；合同存在本身不构成通过。

## 15. 容量和证据

当前 Cell-10K/MIX-100K profile 将 LiveKit SIP 标记为
`optional_bridge_excluded`。本 ADR 不修改该 profile，也不继承其容量结论。

未来 `VOICE-LIVEKIT-BRIDGE-V1` profile 至少冻结：

- exact RustPBX、rsipstack/rvoip slice、RTPengine、LiveKit SIP、LiveKit、Coturn 和
  Egress source/image/config identity；
- hardware、kernel、NIC、NUMA、cpuset、IRQ、allocator 和 network topology；
- concurrent Voice calls、Rooms、SIP participants、WebRTC participants、tracks；
- V2L/L2V directed Edge 数和 native binding group 数；
- bridge setup CPS、active handoff CPS、early-media/no-answer ratio；
- codec/ptime/security/NAT/IPv4/IPv6 mix；
- RTP RX/TX PPS/bps、SFU packet/track load、SIP gateway transcoding slots；
- TURN ratio、recording/Egress ratio、billing/manifest event rate；
- call duration、handoff count per interaction、failure injection mix；
- bounded queue、port、participant、Room、recording、spool 和 admission budgets。

容量签署规则：

- Voice-only、LiveKit-only、Egress-only 和 RTPengine-only 结果不能相加或外推；
- generator 与 SUT 分离，generator exhaustion 使 attempt
  `invalid_generator_capacity`；
- exact profile 至少三次有效重复；
- P50/P95/P99 setup/handoff latency、writer gap、loss、CPU、memory、queue、ports 和
  reconciliation delta 完整；
- 24 小时 endurance 无 unbounded growth、orphan、duplicate billing/recording；
- 1/2/4/8 节点边际效率和 failure domain 可解释；
- 不把 break-before-make gap 隐藏在平均值中；
- Goal 11 finalizer 之前 `capacity_claim=none`。

当前证据状态：

| 证据 | 状态 | 说明 |
| --- | --- | --- |
| D0.3 ADR/Authority contract | `not_run` | ADR 已存在，但没有运行证据 |
| R4 machine contract `/livekit_handoff` | `not_run` | contract 已存在；本 ADR 不把存在性当运行证据 |
| normalized bridge store/CAS/command/receipt migration | `not_present` | 当前粗粒度 bridge row 不满足第 6 节目标模型 |
| production HTTPS-only LiveKit control endpoint | `not_run` | 当前 `internal_service` 配置仍可放行裸 HTTP，不能取得生产资格 |
| durable lifecycle/property tests | `not_run` | 未实现 |
| 双向真实 SIP/WebRTC 媒体 | `not_run` | 未执行 |
| packet-level single-writer | `not_run` | 未执行 |
| billing/recording convergence | `not_run` | 未执行 |
| restart/failure/cleanup | `not_run` | 未执行 |
| bridge capacity/24h/1-2-4-8 | `not_run` | 未执行 |
| production eligibility | `not_run` | 不可启用 |

ADR 的 `Accepted for staged implementation` 状态只表示决策获准实施，不是 runtime
evidence，也不能被 finalizer 解释为 pass。

## 16. 迁移

迁移按可独立回滚的 vertical slice 推进：

1. **D0.3 contract-only**：合入本 ADR 和 future path 清单；所有 runtime evidence
   `not_run`。
2. **数据/Port seam**：按第 6.2 节增加 logical bridge、immutable
   generation/attempt、command/receipt、CAS head、`RESTRICT` 外键与 tombstone，
   backfill 只复制已知事实；不双写、不激活新行为。
3. **现有 create hardening**：为 create/participant terminal 增加 query、release 和
   durable receipt；保留现有单向能力。
4. **LiveKit → SIP new-call canary**：只对新 interaction，G.711↔Opus，旧调用 drain。
5. **SIP → LiveKit new-call canary**：真实 dispatch/Room/participant/RTP evidence。
6. **break-before-make handoff**：capability flag、有限 tenant/Cell、新 handoff command，
   显式显示中断语义。
7. **billing/recording closure**：单 rating、single capture、一个 root
   `RecordingManifest` 下的 source segment chains、storage/billing fault。
8. **interop/failure/endurance**：Goal 4/5/6 依赖场景与 independent fleet。
9. **make-before-break qualification**：仅在 blocked prepare、zero-output ACK、query/
   tombstone 和 packet evidence 全部通过后增加 eligible capability。
10. **capacity/finalizer**：签署独立 bridge profile，之后才可进入 Goal 11 production
    conclusion。

每个 slice 只允许一个 production behavior change，必须列出 Authority、状态迁移、
failure outcome、rollback 和 evidence。不得在迁移窗口保留两个可写 Bridge Coordinator
或让旧/新实现同时写同一 Edge generation。

## 17. 回滚

默认回滚只影响新 handoff admission：

1. 禁止新的 handoff/create selector；
2. 已 active bridge 保持原 Backend/generation identity 并 drain；
3. prepared 且无 activation/handoff/break decision 的 candidate 执行 exact
   abort/release；
4. 已有 activation、handoff 或 break decision 的 attempt 必须 query/reconcile 或执行
   预声明 compensation；
5. 已 revoked generation 永不重新启用；
6. 新 endpoint 失败时不猜测恢复旧 writer；需要恢复时建立新的 handoff/generation 并重新
   走完整门禁；
7. 不删除仍有 active participant/Edge/group ref 的 LiveKit SIP/RustPBX/RTPengine
   runtime；
8. 所有 CDR、billing usage、RecordingManifest、attempt、receipt、packet evidence 和
   tombstone 保留；
9. active sessions、orphan resources、unknown attempts 和 reconciliation delta 全部归零
   后，才可移除实现或 deployment。

回滚不能恢复一条隐藏的 RustPBX WebRTC path，也不能把 LiveKit SIP 提升为临时 PBX。
如果没有已资格化的 bridge Backend，新 handoff admission 明确失败，旧 interaction
继续其原 channel。

## 18. 安全和合规

- tenant identity 只来自认证上下文；
- Room、participant、bridge、call 和 recording 查询全部强制 tenant scope/RLS；
- 生产 LiveKit/LiveKit SIP control endpoint 必须使用 `https://`、校验证书链与 hostname，
  并绑定明确 TLS policy；`internal_service=true` 不能成为允许裸 `http://` 的理由。
  裸 HTTP 只允许 non-production loopback test fixture，且其结果永不授权生产资格；
- 当前 `livekit-sip.ts` 的 `validatedHost` 对 `internal_service` 仍允许 HTTP，包括
  production flag 为 true 的组合。这是明确的 current→target 缺口，不得把现有 host
  validation 描述成生产 TLS 门禁已实现；
- clear destination 只在授权后的最末 Provider SDK 边界出现；
- secret 使用 ref/resolver，禁止写 durable payload、event、metric、trace 或 evidence；
- 外呼必须经过 DNC、时间窗和 tenant policy；
- 录音必须绑定 consent、recording mode、retention 和 legal hold；
- AI participant/agent 仍执行 disclosure policy；
- forged Room attribute、participant metadata 或 SIP header 不能改变 Authority；
- 指标不含 tenant、phone、SIP URI、Room name、participant identity 等高基数/PII label；
- repair/cleanup 需要审计 actor、reason、decision 和 exact target digest。

## 19. 后果

### 正面

- Voice/SIP 与 LiveKit 可以共享一个业务 interaction，而不合并两套 domain model；
- LiveKit 保持 WebRTC/SFU 专业边界，RustPBX 保持运营级 Call/CDR/恢复边界；
- directed Edge/generation 让双向桥、handoff、录音和 AI tap 可分别对账；
- timeout/restart 不通过 redial 猜测结果，减少 orphan 和重复副作用；
- billing 与 recording 在 channel 切换后仍保持单一治理 Authority；
- break-before-make 的中断成为可测事实，不再被控制面 success 掩盖；
- 新容量 profile 阻止 Voice-only/LiveKit-only 证据错误外推。

### 成本

- LiveKit SIP/LiveKit 需要更强的 gate、query、tombstone 和 TX evidence，可能需要受控
  fork 或 sidecar；
- durable decision、generation、receipt、tombstone 和 repair 增加状态与运维复杂度；
- break-before-make 会产生用户可感知 gap；
- 双向 bridge 同时消耗 SIP、RTPengine、LiveKit SIP、SFU、TURN、transcoding 和
  recording capacity；
- 真实验收需要独立 SIP peer、浏览器、packet capture、故障注入和长稳 fleet；
- source handoff 增加 RecordingManifest segment/discontinuity 和 billing interval
  reconciliation 成本。

### 明确非目标

- 不用 rvoip/RustPBX 替换 LiveKit WebRTC；
- 不用 LiveKit SIP 替换 RustPBX PBX/Business Dialog；
- 不承诺 active handoff 零丢包、零 gap 或 carrier-transparent；
- 不在本 ADR 内声明 G.729、VoLTE video、T.38、TURN、Egress 或 100K 已通过；
- 不把 bridge participant、MediaCall 或 vCon 变成 durable Call/CDR/evidence Authority；
- 不因文档 accepted 自动启用任何 capability。

## 20. 最终判断

Voice/SIP 与 LiveKit 的正确整合方式不是在两套 runtime 之间移动 Authority，而是在同一
business interaction 下建立 owner-fenced、generation-scoped、可查询和可对账的双向
Media Edge。RustPBX 管 Call 与 SIP 业务事实，LiveKit 管 WebRTC/Room/track，Media Engine
Facade 管 Edge/writer decision，LiveKit SIP 只执行 bridge native session，Region
recording plane 和 OPC billing 各自保持唯一治理 Authority。

现有代码是可复用的 create/reconcile 起点，但不具备 active handoff 的原子 gate 和
packet evidence。因此 R4 D0.3 先冻结合同；首期诚实采用 break-before-make，所有真实
媒体、故障、计费、录制和容量结论保持 `not_run`。只有补齐并验证 blocked prepare、
zero-output revoke、query/tombstone、single-writer、single-rating 和 single-capture
后，make-before-break 才能成为可选生产能力。
