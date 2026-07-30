# ADR-CCAAS-7：rvoip 与 RustPBX 协议底座整合和替换审计

状态：**Accepted**

日期：2026-07-28

修订：2026-07-30，Revision 6

决策 ID：`rvoip-rustpbx-unified-authority-r4`

本修订保留 ADR-CCAAS-5 对 RTPengine ordinary fast path 的长期正式定位，并
supersede Revision 3 中“多个生产 Profile”“按 Call/媒体方向选择 Backend”“未来沿本
路线整体替换 RustPBX”三项表述。唯一生产基线为 `CARRIER-CELL-V1`；Rust-native 只能
作为同一架构下的 directed Media Edge Backend 候选。

适用范围：iveKit/OPC 通信底座 Goal 4-11

规范性详细方案：
[`rvoip-opc-communication-foundation-integration-design.md`](../design/rvoip-opc-communication-foundation-integration-design.md)

## 1. 决策摘要

**不使用 rvoip 整体替换 RustPBX，也不把整体替换作为本整合路线的既定终点。**

终态通信架构继续保持：

```text
Kamailio SIP Edge
        |
        v
iveKit RustPBX fork          LiveKit                 Tinode
Call/Leg/Business Dialog     WebRTC/SFU              IM
        |
        +-- SipFoundation Seam
        |      |
        |      +-- current: RsipstackFoundationAdapter
        |      \-- target slices: RvoipFoundationAdapter
        |
        +-- Media Engine Facade / Media Plan Authority
        |      |
        |      +-- external RtpengineBackend
        |      |      ordinary RTP/RTCP/SRTP Edge
        |      |
        |      \-- in-process EmbeddedVoiceMediaBackend
        |             codec/transcode/IVR/mix/AI Edge
        |
        \-- API / routing / CDR / recording policy
```

rvoip 的 SIP foundation 与 RustPBX 编译进一个受控 Cargo build graph、一个 Unified
RustPBX executable，并共享 Tokio control runtime；二者之间没有 RPC。rvoip 不作为
第二套在线 SIP B2BUA、RTP relay 或 WebRTC 服务部署，也不把它的
`Conversation/Session` 模型提升为新的业务权威。这样避免同时维护两套 Call/Business
Dialog、两套媒体会话和两套故障恢复语义。这里的“不得运行第二套 SIP runtime”不排斥
RustPBX 进程内使用 rvoip library Adapter；它禁止的是独立 PBX、双主路径和双写权威。

“一个媒体引擎”在本 ADR 中表示一个 Media Engine Facade、一个外部 codec
identity/negotiation registry 和一个 Media Plan Authority；其中 G.729 的外部身份只
有 `G729/8000`，G729A/G729AB 只进入内部 mode/capacity registry。Facade 把
Logical Media Graph 编译成有向 Media Edge；每个 Edge generation 只有一个
`WireMediaBinding` 和 writer fence，并以
`(group_id, group_generation, flow_selector)` 精确绑定一条 member flow。
`BackendBindingGroup` generation 才是共享 Backend allocation 的物理生命周期权威，
`WireTransportBundle` 持有 effective SDP、transport、SSRC 与 crypto state reference。
双向通话是两条 Edge，AI/录音 tap 与处理 chain 也是独立 Edge；group generation
可以共享物理资源，但成员集合冻结后不可修改。

`CARRIER-CELL-V1` 是唯一生产基线：RTPengine 是外部 ordinary media 的长期默认
Backend；`voice-media-rs` 首期作为 Unified RustPBX Process 内的 library/worker
shards，直接通过 Rust Adapter 执行 decode-required Edge，不经过 HTTP/gRPC。
`UNIFIED-STANDALONE-V1` 仅供开发、诊断和 benchmark。Rust-native fast path 只是同一
生产架构下的候选 Backend，不是第二套 Profile。

语音通信底座以 RustPBX、rvoip SIP foundation 和 `voice-media-rs` 为 Rust 主干。
RTPengine 是获批的专业 ordinary RTP 数据面，而非必须淘汰的临时件。Rust Native Fast
Path 只有在功能、PPS、CPU/packet、P99、loss、session density、故障隔离、24h 和
2/4/8 扩展全部不劣时，才能成为 `CARRIER-CELL-V1` 中的 eligible Backend。

但 rvoip 不是“无用”。它有一批质量很高、与当前 Goal 直接相关的实现和工程方法。
本 ADR 将这些能力分为：

1. **协议底座分阶段采用**：SIP Message Codec、Transaction、Protocol Dialog、
   Transport/DNS 和 REGISTER/auth primitives 通过 OPC-owned `SipFoundation`
   Seam 逐模块进入 RustPBX；
2. **Revision 4 D0 后优先或独立切片吸收**：有界 RTP 方法、G.729
   （G729A/G729AB internal modes）、Provider semantics、vCon、
   STIR/SHAKEN、SCIM、benchmark 和证据方法；
3. **作为测试与迁移输入**：SIP 互通用例、拓扑 profile、模糊测试 corpus 和
   rsipstack/rvoip shadow equivalence；
4. **明确不引入**：另一套 PBX/WebRTC、QUIC/MoQ 生产数据面、第二媒体权威，以及
   rvoip Endpoint/SessionHandle/Coordinator/Orchestrator/Conversation/Participant
   等高层 runtime。

“整合”只指低层协议 Module 的 Adapter 迁移、Exact Source Slice 和媒体 primitive
吸收，不指整体切换生产呼叫引擎。未来若要替换 RustPBX 产品主干，必须另立
superseding 架构 ADR。

### 1.1 Revision 4 的补充裁决

Revision 6 把外部评审提出的持久性与迁移边界纳入本 ADR；完整字段由
[`unified-voice-foundation-r4-v1.json`](../capacity/contracts/unified-voice-foundation-r4-v1.json)
约束，零遗漏关系由
[`unified-voice-foundation-r4-traceability-v1.json`](../capacity/contracts/unified-voice-foundation-r4-traceability-v1.json)
约束：

1. 网络不提供 Exactly Once。SIP effect 分别记录 durable decision、send attempted、
   transport accepted、protocol observed、failed 和 unknown；只有 response、ACK 等
   协议事实能证明 peer 可观察，local send 成功不是远端 receipt。
2. wire 必须先绑定 RFC 3263 candidate、route、transport、advertised local endpoint
   和 SNI，再冻结 Via/branch/auth/bytes/hash，完成 durable decision 后才能发送。
   commit 后禁止静默改写；改变 transaction-visible 绑定必须建立有 lineage 的新
   protocol attempt。
3. `SipFoundation` V1 takeover 只允许 confirmed、transaction-quiescent Dialog。
   early dialog、活动 transaction、pending ACK/PRACK、dead TCP/TLS flow、DNS attempt、
   unknown effect、schema 不兼容和跨 Adapter capsule 不能冒充恢复成功。
   `active_timers` 的 lossless 与 cross-Adapter takeover 都是 false；运行时
   `Instant` 不可持久化，恢复只能 fail closed 或按协议重新启动。
4. durable store 的 transaction 边界、P99/deadline、queue/pool ceiling 和降级 cause
   必须冻结。`100 Trying` 可在 transaction admission 后、业务 commit 前发送；18x/2xx
   与其他业务 effect 必须等待相应 durable decision。store 故障拒绝新 Call、保护既有
   Call，所有 retry/repair/reconcile 有界。
5. Kamailio 与 Core 使用版本化 Edge-to-Core Acceptance Contract，固定 raw/canonical
   bytes、parser policy、source/transport/TLS metadata、内部 header 重建和 differential
   security corpus。
6. Business/Protocol Dialog、Effect WAL、Media Plan/Binding、Wire Bundle 和 Recovery
   Capsule 分别版本化，并签署 N/N+1 read/write/takeover/drain/rollback 矩阵。UTC、
   monotonic 与 RTP media clock 不混用，runtime `Instant` 不持久化。
7. 每个 SIP/media Backend 发布绑定 source/binary/config 的 closed
   `BackendCapabilitySet`。required capability 为 false、unknown 或 `not_run` 时
   fail closed；当前 RTPengine atomic lifecycle patch 为 `not_present/not_run`，不能
   授权 active migration。
8. 默认发布只选择新 Call、旧 Call drain。active migration 必须另行通过 single-writer、
   packet gate、remote re-INVITE、SRTP/RTCP、crash 和 continuity 证据，只承诺可测量
   bounded gap/loss，不承诺 zero-loss。普通 drain 超时只进入可观测 repair，不强制
   BYE/CANCEL，也不删除旧实现；必须等 active Call/Protocol Session/Edge/group、
   unknown effect 和 cleanup delta 全部归零且 rollback window 到期后才能移除。
   active-zero 由 `unified_rustpbx`、`rtpengine`、`effect_wal` 三方独立 receipt
   共同证明，不接受单方汇总；删除还必须等 retention/rollback references 清零。
9. 单进程减少 RPC 和重复状态，不产生地址空间故障隔离：OOM、abort、UB、allocator
   corruption 或不可捕获 native failure 可能中断全部 embedded Edge。安全、native/
   unsafe、Conference、quality 和 co-resident capacity 都是独立生产门禁。
10. Voice/SIP/PSTN ↔ LiveKit 按
    [ADR-CCAAS-8](ccaas-8-voice-livekit-bridge-handoff.md) 使用现有
    `RustPBX ↔ livekit-sip ↔ LiveKit` 路径；它是持久 Bridge/Edge handoff，不是 Call、
    Dialog、CDR、billing、recording 或 WebRTC Authority 转移。

本裁决不把任何尚未执行的功能或性能结果提升为通过；相应 verification 继续
`not_run`、`production_eligible=false`。

### 1.2 Machine-exact adoption gates

`edge-core-sip-v1` 只接受 `raw_bytes_with_trusted_metadata`，保留 raw bytes 并校验
SHA-256。metadata allowlist 仅含 `source_identity`、`ingress_transport`、
`tls_verification`、`raw_message_length`、`raw_message_sha256` 和
`parser_policy_version`；外部同名内部 header 先剥离再重建。硬上限是：

| 项 | 上限 |
| --- | ---: |
| SIP message / header section / body | 65,535 / 32,768 / 32,768 bytes |
| start line / URI | 4,096 / 2,048 bytes |
| header count / header line | 128 / 8,192 bytes |
| URI parameters / header components | 32 / 16 |
| multipart boundary / depth / parts | 70 bytes / 2 / 16 |
| multipart part headers / body | 8,192 / 32,768 bytes |

`Content-Length` 只允许一个，或 byte-identical duplicates 且匹配 raw body octets；
`Via`、`Contact`、`Authorization` 保序逐值解析，`Route`/`Record-Route` 保持 wire
order；`From`/`To`/`CSeq` duplicate 语义相同，`Call-ID` byte-identical，
`Max-Forwards` 为相同十进制值。冲突不得选择 first/last，而是 fail closed。URI
非法 percent escape 拒绝；unreserved 仅解码一次、reserved 保留；userinfo 只有一个
`@` delimiter 且解码后不重解释；host 为 lowercase ASCII 或 IDNA2008 A-label，
不得有歧义 trailing dot；IPv6 literal 必须带方括号。multipart boundary 畸形或歧义
同样拒绝。rvoip parser 只有在这些 accept/reject 语义与 differential corpus 全部通过
后才可从 shadow 进入主路径。

Region durable store 固定四个原子边界：Call admission 同时写入 Call Session、
Protocol Effect、Effect WAL、capacity reservation receipt 与 idempotency record；
Media generation 同时写入 Media Plan、directed Edges、Binding Groups 与 capacity
reservation receipt；bridge head 同时写入 command、decision、receipt 并完成 head
CAS；recording 同时写入 intent、root manifest、source chain 与 segment reference。
单 Region 内必须 all-or-nothing，partial failure 以稳定 cause 回滚。路由、媒体、
billing、recording 与 webhook 分别只能在其对应 Call/media-generation/bridge/
recording/protocol decision 持久后产生业务可见 effect。`store_timeout`、
`store_pool_exhausted`、`store_unavailable` 或
`store_schema_incompatible` 必须拒绝为 SIP 503 并携带 deterministic
`Retry-After`，不得 partial commit。其秒数使用 checked-u64
`clamp(1, 30, 1 + ceil(pool_wait_ms/1000) + ceil(queue_depth/256) +
retry_attempt)`；输入范围分别为 0..250 ms、0..1024、0..3，不加 jitter，同一输入
必须同一输出，非法输入拒绝且不得伪造 `Retry-After`。

RFC 3263 candidate 顺序依次执行 NAPTR order/preference、SRV priority/weight 和
地址族选择，并把 target FQDN、transport、port、address、NAPTR 与 SRV identity
冻结进 attempt。DNS query timeout 为 2 秒、connect timeout 为 3 秒，最多 8 个
candidate、每个最多 1 次 retry、总预算 10 秒；耗尽必须产生有序 terminal-effect
receipts。candidate receipt 保留 1 天，transaction effect 保留 7 天，late-response
窗口 32 秒；transaction、Dialog、recovery 与 rollback reference 全部到期后才可 GC。

drain active-zero 使用 checked-u64 且要求同一
`tenant_id/drain_scope_id/generation/observation_epoch` 的三份 digest-bound
receipt：`unified_rustpbx` 的
`call_count/protocol_session_count/edge_count/binding_group_count`，
`rtpengine` 的 `session_count/port_count/allocation_count/generation_count`，
`effect_wal` 的
`pending_effect_count/unknown_effect_count/repair_delta_count/
cleanup_delta_count` 全部为零。缺失、过期、identity/epoch 不一致时继续 drain。
deletion-safe 还要求 `retention_reference_count=0` 和
`rollback_reference_count=0`。普通 timeout 不允许 BYE/强删；emergency action
必须另有带
`actor/reason_code/incident_id/scope/expires_at/decision_hash` 的授权和审计
receipt。

所有 Backend 采用 `backend-capability-set-v1@1.0.0`，绑定 source、binary/image、
config 和 capability-set digest。closed required set 是：

| Backend | allocation/fence scope | required capability IDs |
| --- | --- | --- |
| `embedded_voice_media` | directed Edge generation | `bounded_processing_session`、`codec_chain`、`rfc4733_dtmf`、`recording_tap`、`ai_tap`、`n_minus_one_mix`、`owner_fence`、`zero_output_revoke` |
| `livekit_sip_bridge` | bridge generation | `bidirectional_bridge`、`participant_lifecycle`、`prepare_blocked`、`zero_output_revoke`、`query_reconcile`、`terminal_tombstone`、`ice_dtls_srtp_bundle_mid` |
| `rtpengine_ordinary` | Binding Group generation | `ordinary_rtp_rtcp`、`srtp`、`wire_sdp`、`prepare_blocked`、`commit`、`revoke_zero_output`、`query_reconcile`、`member_flow_binding`、`dtmf_event_notification` |
| `rust_native_fast_path` | Binding Group generation | `rtp_rtcp_srtp_parity`、`kernel_nic_numa_profile`、`same_hardware_rtpengine_floor`、`failure_isolation`、`endurance_24h` |

compiler 只接受 `support=supported && verified=passed` 且 exact runtime identity
匹配的 required capability。allocation/lifecycle/fence 粒度粗于 directed Edge 时，
必须证明 immutable member set 和 exact member-flow fence；否则拆 Binding Group，
无法拆分则在任何 allocation 前 fail closed，不能静默削弱 capability set。

生命周期资格按操作独立签署，不能从汇总状态推断。每个 Backend 对
`allocation/prepare/commit/abort/revoke/fence/query/reconcile/migration/
notification/member_flow_fence/zero_output_ack/security_termination_scope`
逐项发布 `operation_contracts`；每项必须同时满足
`support=supported`、`verified=passed`、exact operation granularity 和全部声明的
prerequisites passed。失败时
`fail_closed_without_side_effect_and_freeze_exact_generation`，并稳定返回
`lifecycle_operation_missing`、`lifecycle_operation_not_supported`、
`lifecycle_operation_not_verified`、
`lifecycle_operation_granularity_mismatch` 或
`lifecycle_operation_prerequisite_unmet`。

持久 schema Authority 是 PostgreSQL Region store 中的
`opc-persistent-schema-registry-v1`，identity 为
`artifact_type/schema_id/schema_version/schema_sha256`；Registry 不可用时禁止新
writer version。Voice↔LiveKit 单独注册
`voice_livekit_bridge_generation/attempt/command/receipt/tombstone` 五个 durable
artifact。1.0.0/1.1.0 expand-contract evidence 必须证明 old reader 拒绝 new
writer、new reader 接受 old producer、所有 live reader 支持前 writer 维持 1.0.0，
回滚也维持 1.0.0 到旧 reader drain。缺失 bridge 对象表示 unsupported 且 advertised
capacity 为零。

Call Session、Business Dialog、Protocol Dialog、Protocol Effect、Effect WAL、
Media Plan、directed Media Edge、Backend Binding Group、Wire Transport Bundle、
Recovery Capsule、root RecordingManifest、recording source chain、Capacity
Vector，加上述五个 bridge artifact，共 18 个独立 artifact contract。每项都固定
自己的 `schema_id`、N=`1.0.0`、N+1=`1.1.0`、N/N+1 hash、current writer
version/identity、reader/takeover matrix、migration receipt、rollback 与 GC
references。当前两个 hash 和 writer version/identity 都必须为 `null`，状态
`not_run`；在 registry receipt 持久化、两个 hash 验证且所有 live reader 兼容之前
禁止启用 writer。迁移按 expand → dual-read/single-write → contract，逐对象幂等并
写 durable receipt；rollback 继续写 N 到旧 reader drain，evidence 保留到 rollback
closed，且 reader/writer/recovery/rollback reference 全部消失前不得 GC。

`media-plan-capacity-demand-v1` 把 RTP/RTCP flow、SRTP context、port pair、
decode/encode/resample/transcode Edge、mix output、recording/AI Edge、
packetization、bitrate 和 NUMA affinity 确定性编译成 RTP/RTCP socket、SRTP
context、port pair、PPS、bps、memory、CPU microseconds/second、NUMA node 与
decode/encode/resample/transcode/mix/record/AI slot。共享 transport 只计一次。RTPengine 与
可选 Rust-native 只供应 Wire Bundle；embedded Backend 供应 Bundle 和全部 processing
slot；LiveKit SIP bridge 供应 Bundle 与 decode/encode/resample/transcode。所有 required demand
在 Backend prepare 前原子预留，并保留 declared failure-domain reserve；N+1 是 peak
demand 加 largest failure-domain demand。缺失、过期或跨 profile supply 拒绝。

admission contract 还必须绑定 `worker_count/shard_count/queue_depth/
service_time_micros/backpressure_limit`。Supply 只有在签名验证、未过期，且
`capacity_profile_id/profile_revision/role/backend_source_digest/binary_digest/
config_digest/hardware_profile_id/cell_id/failure_domain_id/issued_at/expires_at/
signature_key_id` 与请求完全匹配后才可使用。每个维度用 checked-u64 证明
`deduplicated_demand <= signed_unexpired_identity_bound_supply -
active_reservations - failure_reserve`；overflow、underflow、negative、saturation、
unit mismatch 一律拒绝。共享 transport 只按 exact
`binding_group_id/binding_group_generation/wire_transport_bundle_id` 去重。
同一 dedupe key 携带不同 demand vector 时 `conflict_fail_closed`，不能重复计数、
覆盖或任选一个 vector。
reservation CAS 固定 profile/revision/epoch/available-vector digest；在 Backend
prepare 前持久 receipt，绑定 tenant、interaction、Media Plan generation、
reservation/profile/revision、demand/failure-reserve digests 与 decision hash。
N+1 另行证明 `supply - active reservations - largest failure domain >= peak
admitted demand`，缺失 failure-domain identity 直接拒绝。

RTPengine userspace 与 kernel forwarding 是两份独立 execution profile。两者分别
绑定 source/binary/config/capability-set digests、hardware profile、NIC driver、
kernel module 与 Cell；userspace evidence 必须证明 userspace packet path，
kernel evidence 必须证明 kernel packet path 及 module/NIC identity。当前两份结果
均为 `not_run`，且 userspace pass 不得授权 kernel、kernel pass 也不得授权
userspace。

ordinary RFC 4733 唯一 no-decode 采集路径是
`rtpengine_rfc4733_event_notification` → RustPBX per-Leg canonical Authority。
该路径要求 `rtpengine_ordinary.dtmf_event_notification` 达到
`support=supported && verified=passed`。notification 绑定
tenant/interaction/Leg/SSRC/RTP timestamp/event/duration/end
bit/provider sequence，按全字段去重，P99 report budget 为 50 ms；parallel read-only
fork 和 decode-all 禁止，丢失/歧义对业务副作用 fail closed 并 query/reconcile。

notification channel 使用 mutual TLS，并对 payload 做 HMAC；identity 绑定 Backend
instance、Binding Group generation、tenant、interaction 与 Leg，鉴权失败不产生
业务 effect。ordering 与 monotonic sequence 按 tenant/interaction/Leg，sequence
CAS 必须在业务 effect 前持久化。queue 上限 1,024、event 上限 4,096 bytes、
deadline 50 ms；overflow 或 gap 冻结 exact Leg effect 并 query/reconcile。duplicate
返回同 receipt 且不重复 effect；同 identity 不同 payload hash 是 conflict。receipt
固定 event ID/sequence、payload hash、Backend identity digest 与 received time。
只有 exact Backend 的 `query` operation 也通过独立 support/verification gate 后，
该 DTMF business effect 才 eligible；当前保持 `not_run`。

small conference 固定为最多 8 人的 per-participant N-1 mixer：
`N*(N-1)` directed contribution、`N` jitter buffer、`N` encode output；第 9 人不
扰动 active mix 而被拒绝或路由 LiveKit。quality 独立覆盖 clipping、loudness、level
normalization、jitter/PLC 等 machine vector，未运行保持 `not_run`。

十二项 quality method 分别为：MOS-LQO=P.863 或声明的等价评分，
PESQ/POLQA=P.862/P.863 licensed score，packet loss=RTP sequence-gap capture，
jitter=RFC 3550 interarrival，PLC=reference/degraded comparison，
clipping=PCM full-scale ratio，loudness=BS.1770 LUFS，level normalization=
input/output LUFS delta，tandem=codec-chain reference A/B，clock drift=
RTP-versus-monotonic capture PPM，DTX/CNG=state-transition continuity，
switch gap=last-old/first-new capture。每项必须独立绑定 method source/digest、
quality profile identity、workload source/digest、签名 threshold/operator/value/
unit 和 independent-witness evidence digest；任一为空或未签名均保持 `not_run`、
production-ineligible，不能继承其他 metric 的结论。

DTLS setup role/fingerprint、ICE ufrag/password/consent 与 RTCP-mux/BUNDLE/MID 均
绑定 Wire Transport Bundle generation；fingerprint 验证后才能 SRTP，consent 过期
停止输出，ICE restart 或 DTLS role/fingerprint 改变必须新 generation，unknown/
duplicate MID 拒绝。安全响应持续摄取 signed digest-bound RustSec/OSV/GitHub/vendor
advisory；critical/high/medium/low triage SLA 为 4/24/72/168 小时，remediation SLA
为 24/168/720/2160 小时。修复采用 upstream backport→cherry-pick；local fork 必须
bounded 且有 owner/expiry/rebase。production core dump 关闭，只允许不含 key、SDP
或 media 的 redacted minidump，禁止 unredacted crash upload。

Voice↔LiveKit 资格场景让同一 Call 完成 32 个
`V2L_ACTIVE → L2V_ACTIVE` alternating round trip，每次新建 generation。相反方向
并发 command 只有一个 bridge-head CAS winner；loser fail closed 并只
query/reconcile winner。往返不得增加 Call/CDR/rating/root-manifest Authority；
active participant/port/allocation 有界，终态 participants、port pairs、Backend
allocations、writers、pending commands 与 unreconciled receipts 全部为零。

资格证据必须逐项独立执行，不能由 32 次往返汇总继承。八个 scenario 是
`same_call_32_round_trip_v2l_l2v`、`concurrent_head_cas_single_winner`、
`terminal_zero_resource_leak`、`cancel_before_prepare_ack`、
`cancel_after_apply_before_receipt`、`token_expiry_before_prepare`、
`token_expiry_during_active`、`webhook_duplicate_reordered_replayed_forged`；
七个 property 是 `every_switch_allocates_new_generation`、
`cas_loser_never_emits_media`、`one_call_cdr_rating_and_root_manifest`、
`terminal_cleanup_is_idempotent`、`cancel_terminal_prevents_recreate`、
`token_scope_matches_exact_generation`、
`webhook_requires_exact_identity_and_receipt_digest`；九个 fault vector 是
`timeout_before_apply`、`timeout_after_apply`、
`coordinator_crash_after_decision`、`livekit_sip_unavailable`、
`sfu_disconnect`、`webhook_loss_duplicate_and_reorder`、`token_expiry`、
`store_head_cas_conflict`、`cleanup_retry_and_dead_letter`。当前所有项都是
`not_run` 且 production-ineligible。

command token 是 pinned-issuer asymmetric-signed capability，绑定
`tenant_id/interaction_id/bridge_id/bridge_generation/operation_id/
idempotency_key/issued_at/expires_at/key_id` 并 exact scope match；checked
`now < expires_at`，prepare 前过期不创建 command/resource，active 中过期只阻止新
command。cancel 绑定
`tenant_id/interaction_id/bridge_id/bridge_generation/command_id/
idempotency_key/command_hash`，按 generation 内 `command_sequence` 排序并在 ACK 前
写 tombstone；prepare ACK 前无 writer 地释放，apply 后 receipt 前 query/reconcile
exact generation，terminal cancel 战胜 late success 且禁止 recreate。webhook 必须
验证签名/pinned provider，绑定 tenant/interaction/bridge/generation/provider/
event/sequence/type/receipt/payload，reorder window 最大 128，receipt 先于 effect
持久化。三类输入的 exact duplicate 只 replay 原 receipt；same identity/different
hash、forged 或越界重排 fail closed 并 query/reconcile，terminal tombstone 禁止
nonterminal replay/recreate。三份合同当前均为 `not_run`。

确定性 32-round-trip resource model 要求 active generation 的
participant/port-pair/Backend-allocation/writer 为 `1/1/1/1`，
pending-command/unreconciled-receipt 为 `0/0`；每个被替代 generation 显式 terminal
且六项全零，Call/CDR/billing session/root manifest 跨 generation 始终
`1/1/1/1`。CAS loser、cancel、bad/expired token 与 forged webhook 不得创建 writer
或资源，重复 final cleanup 仍为全零。这是 target/`not_run`，不能写成当前能力。

## 2. 审计源码身份

### 2.1 rvoip

| 项目 | 值 |
| --- | --- |
| 仓库 | `https://github.com/eisenzopf/rvoip` |
| 审计分支 | `main` |
| 审计 commit | `4ced02b7f6e73041c848f1765dc2bcf7588796f0` |
| Workspace version | `0.3.2` |
| MSRV | Rust `1.88` |
| Rust 源文件 | 约 `2,272` |
| Rust 行数 | 约 `952,700` |
| Workspace crate | 约 `46` |
| `todo!`/`unimplemented!` | `45` 处；包括文档样例和真实未实现路径 |

上述统计只用于评估集成和审计面积，不用于判断代码质量。rvoip 更新很快，任何后续提取
必须重新固定 exact commit，不允许依赖浮动 `main`。

### 2.2 当前 RustPBX 底座

| 项目 | 值 |
| --- | --- |
| RustPBX commit | `6c49ee76baa54fdbf8f98020cc9bee158c7c15de` |
| rsipstack commit | `8318e97b1170de4e5245b120afec1cdf53e3d716` |
| rustrtc commit | `166c6d22984429eb6b509920c14fcd69f974f0b3` |
| Patch set | `ivekit.38` |
| Patch 文件 | `38` |
| Builder | Rust `1.94` exact image digest |
| 构建方式 | exact source + lockfile + ordered patch queue |

因此，本次比较对象不是“rvoip 对原版 RustPBX 0.4.11”，而是“rvoip 对 iveKit
已经深度改造的 RustPBX + rsipstack + rustrtc + RTPengine 架构”。

## 3. rvoip 的真实成熟度

rvoip 的 README 展示了一个很有吸引力的统一 Rust 通信愿景，但发布判断必须以仓库内
更严格的 RFC、兼容性、安全和拓扑矩阵为准。

### 3.1 已有强项

- SIP INVITE/BYE/CANCEL/REGISTER 主路径和多种 API 模型；
- UDP/TCP/TLS 和部分 SIP-over-WebSocket；
- PCMU、PCMA、RFC 4733 DTMF；
- 部分 SDES-SRTP；
- RTP/RTCP parser、session、jitter、SRTP 和媒体处理组件；
- 纯 Rust G.729 Annex A，及上游可选 Annex B VAD/DTX/CNG；OPC 的 G729AB internal
  processing mode 仍是强制项，对外 wire identity 仍只有 `G729/8000`；
- SIP Digest、AKA、registrar identity provider；
- ASR、TTS、Dialog、Recording 的抽象 trait；
- vCon、STIR/SHAKEN、SCIM/identity 等扩展；
- 较丰富的 Criterion、SIPp、互通、模糊测试和不可变 evidence 设计；
- 明确区分 `Supported`、`Partial`、`Post-beta` 和 `Unsupported`，不把解析 SDP
  attribute 误写成完整协议能力。

### 3.2 当前明确不完整的能力

根据 rvoip 自身的 release matrix：

- SIP core 仍只声明 `Partial`，PRACK、session timer 和 RFC 5626 仍是 bounded partial；
- 盲转 REFER 已声明 `Supported`，但 attended transfer 仍只有 developer-preview
  orchestration primitives，`Replaces` 尚未形成完整 RFC 3891 资格声明；
- UPDATE、SUBSCRIBE/NOTIFY 虽已进入产品 API，仍不能由“存在实现”外推为完整生产审计；
- WSS outbound 不属于当前 beta 支持；
- Opus、G.722、G.729 不属于当前完整 SIP media release path；
- DTLS-SRTP、ICE、TURN 和 browser WebRTC 不属于当前 beta；
- Kamailio/OpenSIPS + RTPengine 仍标记为 investigation topology；
- carrier SBC topology 仍是 post-beta；
- recording、announcement、IVR media server 仍是 post-beta unless completed；
- IPv6 没有完成发布级审计；
- 一小时 soak 有证据，但没有 24 小时稳定性声明。

这并不否定源码价值，但说明它目前不能直接承担 iveKit 已定义的运营级交付承诺。

## 4. 能力对比

| 维度 | iveKit RustPBX 架构 | rvoip 当前 main | 决策 |
| --- | --- | --- | --- |
| SIP Edge | Kamailio 多节点路由、健康、限流、Cell placement | 推荐拓扑仍未把 Kamailio/RTPengine列为支持形态 | 保留现状 |
| Call/Business Dialog 权威 | RustPBX + owner epoch + durable shadow | 通用 Session/Conversation；无 iveKit owner 合同 | 保留现状 |
| SIP Protocol Transaction/Dialog | 当前 rsipstack | transaction/dialog 分层较完整 | 通过 `SipFoundation` 分阶段采用 |
| 普通 RTP | RTPengine fast path，与业务/存储隔离 | rtp-core/media-core 用户态路径 | RTPengine 长期正式；Rust Native 只按门禁竞争 |
| 必须解码媒体 | Unified RustPBX 内嵌 `voice-media-rs` library/worker shards | media-core 组件较多，但完整 release path 未闭环 | 选择性提取，不部署第二服务 |
| 断点恢复 | reciprocal dual-leg capsule、takeover、epoch fencing | 无等价的 iveKit 双腿恢复合同 | RustPBX 胜 |
| 路由热路径 | 签名 route snapshot + Cell admission | 通用 SIP 路由/API | RustPBX 胜 |
| CDR | owner-fenced dual-leg durable spool/quorum receipt | 无等价 Region durability 合同 | RustPBX 胜 |
| 录音隔离 | 有界 capture、独立 lifecycle、local spool、上传故障隔离 | RecordingSink 抽象和媒体能力尚未达到同等故障语义 | RustPBX 胜 |
| AI 实时音频 | 非阻塞 tap + token + provider router | ASR/TTS/Dialog trait 更简洁，但缺少完整准入/背压合同 | 合并思想 |
| Codec | G.711/Opus 已有处理内核；G.729/AMR/T.38 待做 | G.711 和独立 G.729 源码有价值 | 强制 G.729 Exact Source Slice |
| WebRTC | LiveKit 生产路径、TURN/Egress/Agents 边界清楚 | browser WebRTC 仍不属于 beta | 保留 LiveKit |
| IM | Tinode | 不属于 rvoip 核心目标 | 保留 Tinode |
| RFC 证据 | 已有容量合同，但完整 SIP RFC matrix 仍需增强 | RFC/compat/security matrix 很成熟 | 吸收方法 |
| 性能证据 | 绑定 patch/image/profile；已有 4 vCPU 受控回归 | 2K target 三次 clean pass，报告和证据组织优秀 | 吸收方法 |
| 集成面积 | 当前已改造并进入 OPC 协议 | 约 95 万行、46 crates、pre-1.0 | 不整体引入 |

## 5. 性能结论

### 5.1 rvoip 的公开证据说明了什么

rvoip 的 canonical 2K profile 在三轮 2,000 target CPS 测试中记录了约
`1,857 CPS` 实际速率、`65,000/65,000` 完成和 ASR `1.0`。它还记录了媒体 burst
和一小时 soak。这说明：

- SIP 状态机和测试 harness 已经具备较高吞吐；
- 它的证据封装方式值得采用；
- 它可能成为单机信令优化和互通测试的重要代码来源。

但该结果不能直接推出：

- 单节点 10,000 全媒体并发；
- 200,000 PPS G.711 relay；
- 大规模 G.711/Opus/G.729 实时转码；
- 双 Zone owner takeover；
- Kamailio + RTPengine + rvoip 的 Cell 扩展效率；
- VOS-EQ 或 VOICE-100K 达标。

### 5.2 与当前证据不能横向排名

iveKit RustPBX 在共享 4 vCPU 服务器已有 `1,400 CPS` 受控基线和 42,000 call
回归，也有 1,000 CPS Kamailio 全链路回归。rvoip 的硬件、拓扑、媒体 workload、
呼叫时长和证据口径不同。

所以当前不能说“rvoip 比 RustPBX 快”或“RustPBX 比 rvoip 快”。正确动作是把
rvoip 的同类 benchmark 适配为独立 generator，在同一硬件、同一 SDP、同一呼叫
时长和同一媒体 profile 下做 A/B。替换决策不能由 README 中的 CPS 数字触发。

## 6. 源码级数据面审计

### 6.1 值得吸收

- RTP packet 支持 owned `Bytes` 解析和复用 serialize buffer 的接口方向；
- `media-core` 中基于 `ArrayQueue` 的固定容量 audio/RTP pool；
- cache-line 分离的原子计数；
- RTP parse/serialize、SRTP、jitter、UDP loopback 和 demux benchmark；
- 一个 `G729/8000` 外部 identity 与 G729A/G729AB 内部 mode 的独立实现、质量和容量边界；
- packet/session/transport 分层比在一个通用异步任务中混合处理更容易测量。

### 6.2 不能整段复制

当前 `rtp-core` 的 manifest 注释描述了 `Bytes::from_owner` 的接收链路，但审计
commit 中没有实际 `Bytes::from_owner` 调用，RTP/RTCP UDP receive loop 仍在每轮：

```rust
let mut buffer = vec![0u8; recv_buffer_size];
```

RTCP 路径还执行 `Bytes::copy_from_slice`。另一个通用 `BufferPool` 使用异步 Mutex、
Semaphore，并在 `Drop` 中 spawn 任务归还 buffer；它不适合作为 iveKit 200K PPS
热路径的直接依赖。`try_get_buffer` 的 permit 生命周期也必须重新证明，不能仅凭命名
认定“有界”。

因此，iveKit 应采用 rvoip 的**设计意图和测试输入**，在 `voice-media-rs` 内实现：

- `ArrayQueue<Vec<u8>>`；
- 原子 hard allocation ceiling；
- `Bytes::from_owner` 在最后一个引用释放时同步归还；
- 固定 worker 数量；
- 每 worker 固定 session、socket 和 packet budget；
- 无 per-packet task、无 async Mutex、无 Drop spawn；
- pool exhausted 时立即计数并丢弃，不扩容、不阻塞 RTP worker。

这比直接依赖 rvoip 整个 RTP workspace 更小、更可证、更适合当前架构。

## 7. 全部可取能力的吸收清单

### 7.1 P0：先冻结协议底座 Seam，再分阶段采用

SIP 底座不再限定为“只作测试输入”。详细 Interface、状态映射、迁移与回滚以规范性
整合设计为准；本 ADR 固定以下决策：

| Module | rvoip 候选 | 接入方式 | 首个门禁 |
| --- | --- | --- | --- |
| Message Codec | `rvoip-sip-core` | `RvoipFoundationAdapter` 内部 Module | differential parse/serialize、limits、fuzz |
| Transaction Runtime | `rvoip-sip-dialog::transaction` | 同一 Protocol Session 内替换 | timer/retransmit/CANCEL/ACK 等价 |
| Protocol Dialog Runtime | `rvoip-sip-dialog` | 映射而非替换 Business Dialog | early/confirmed/terminated 与 recovery 等价 |
| Transport Runtime | `rvoip-sip-transport` | UDP→TCP→TLS 分阶段 | backpressure、connection budget、drain |
| RFC 3263 DNS | `rvoip-sip-transport` resolver | bounded cache/lookup Adapter | NAPTR/SRV/A/AAAA、TTL、negative cache |
| REGISTER/auth | registrar、Digest、AKA | 最小 credential port | 公网入站 responder/location 归 Kamailio；outbound trunk/Standalone Protocol Transaction 归选定 SipFoundation；identity/credential/placement 归 OPC |
| OPC Protocol Session façade | OPC-owned anti-corruption layer | `SipFoundation` 自己定义；rvoip 高层 API 仅作测试参考 | 不依赖 Endpoint/SessionHandle/Orchestrator，不持久化 rvoip 业务模型 |
| Snapshot/restore | transaction/dialog snapshot 语义 | 映射到既有 durable shadow | owner epoch/sequence fencing |
| Source slice | 固定 commit 的最小 crate 闭包 | vendored/fork manifest | license、hash、SBOM、reproducible build |
| Process/build topology | RustPBX + rvoip SIP source slice | one binary、one control runtime、no RPC | lockfile、feature closure、binary identity |
| Media Engine Facade | RustPBX Media Plan port | Edge single-writer + generation-scoped Backend Binding Group | plan/binding/group revision、O(1) flow selector、writer fence、handoff/reconcile |

Media Authority 的规范性物理模型固定如下：

- Edge generation 通过一个 `WireMediaBinding` 精确映射一个 group generation/member
  flow；packet path 使用 `flow_selector -> Edge` 的 O(1) 索引，禁止扫描 members；
- group membership、Backend、physical ports 或 writer 改变都必须创建新
  `group_generation`；共享资源仅在 `live_member_refcount == 0` 时释放一次；
- raw SRTP key 不持久化，只保存 key reference、negotiation state 和 digest；
- 生命周期为
  `absent -> prepared_blocked -> active -> revoked_receive_only -> released`，
  pre-decision abort 可从 `prepared_blocked` 直接到 `released`；
- prepare 从 allocation 创建时就关闭 user/kernel output gate；revoke 只有在两层 gate
  关闭且 in-flight send 排空后才 ACK；timeout 进入 unknown 并 query/reconcile；
- candidate plan、groups 与 flows 必须在 Backend-specific reserve 前编译完成。decision
  前失败 reverse-abort 并取消 reservations；decision 后 partial commit 保持决定，
  收敛失败按预声明补偿进入 `compensated_failed`。

Initial setup 只有在 immutable final plan/mappings/bundles/decision 已持久化且所有
required groups committed 后才能暴露 effective SDP。Migration 可在旧 generation 仍是
sole writer 时暴露 candidate SDP；远端接受后持久化 handoff decision，先 revoke old
到 zero-output，再 commit new。旧 generation 的有界 grace 只允许
authenticate/count/drop，禁止 forward、DTMF、recording 或 AI 副作用。默认发布策略是
新呼叫选择 + 旧呼叫 drain，不因 selector 变化强迁 active calls，也不宣称 zero-loss。

迁移顺序固定为：文档与能力矩阵 → 同硬件基线 → 只读 parser shadow → Message Codec
主路径 → Transaction/Protocol Dialog/Transport 原子迁移 → 稳定后删除被替代实现。
同一 Protocol Session 只能绑定一个 Adapter；shadow 只能读同一份不可变输入，不能发送、
计时、改状态或产生业务副作用。

所有外发 18x/2xx、NOTIFY、mid-dialog request 和其他可见 effect 必须先
`prepare_effect`，在 Business Dialog/durable shadow 达到对应门槛后再以 owner-fenced、
幂等 `commit_send` 发送；unknown outcome 只能 query/reconcile。Transaction 自动重传
只能重放已提交的同一 bytes/hash，不得绕过业务持久化或生成新副作用。

### 7.2 P0：Revision 4 D0 后优先进入当前 Goal 4

| rvoip 强项 | iveKit 落点 | 接入方式 | 验收 |
| --- | --- | --- | --- |
| owned Bytes RTP parse | `voice-media-rs/rtp.rs` | 保留 exact rustrtc parser，输入改为 pooled owner | packet path 无 payload copy |
| lock-free bounded pool | `datagram_pool.rs` | 根据语义重写，不复制通用 async pool | exhaustion 不分配、不阻塞 |
| reusable serialization | `rtp.rs` | worker-local output scratch | steady-state 无 output Vec churn |
| packet/session benchmark | `benches/*`、Goal 4 evidence | 同 codec pair 分层测量 | parse/codec/e2e 三层可归因 |
| RTP/RTCP/DTMF cases | Goal 4 tests | 提炼为协议测试输入 | malformed、wrap、reorder、duration 全覆盖 |

### 7.3 P1：Goal 6/9 的工程方法

| rvoip 强项 | iveKit 落点 | 要求 |
| --- | --- | --- |
| RFC compliance matrix | Goal 6 SIP matrix | 每一能力绑定 RFC、范围、测试 ID、明确 non-claim |
| compatibility matrix | Kamailio/RustPBX/RTPengine interop | 每个 peer/transport/codec 有版本和 evidence |
| topology profiles | Goal 10 Fleet | standalone、edge、full-media、failure profile 分开 |
| security posture | Goal 9/安全审计 | trace redaction、auth、SDP crypto、ICE secret 逐项门禁 |
| fuzz scope | SIP/SDP/RTP/RTCP/SRTP fuzz | parser crash、CPU amplification、allocation ceiling |
| immutable report | Goal 11 finalizer | commit、binary、config、hardware、raw result hash 绑定 |

### 7.4 P1：Goal 4 的 G.729 强制切片

提取范围限定为 `codec-core` 中：

- G.729 Annex A speech encode/decode；
- Annex B VAD/DTX/CNG；
- 10 ms/80 sample frame contract；
- SID/no-data packet handling；
- bitstream 和 reference-vector tests。

RTP wire 与 SDP 中只有一个 `G729/8000` codec identity。G729A 与 G729AB 是两个
独立、强制实现的 internal processing/quality/capacity mode，不是两个可协商的外部
codec identity，也不是可选候选。不得直接把“源码存在”标记为 codec 完成。合入前必须：

1. 做来源和精确 commit manifest；
2. 剥离与 rvoip 全 workspace 无关的依赖；
3. 加入 `voice-media-rs` internal codec-pair quality/capacity registry，不新增外部
   G729A/G729AB identity；
4. 固定 canonical encoding `G729/8000`，覆盖 static PT 18 和 dynamic PT 96–127
   remap，以及 ptime 10/20/30/40/50/60 ms；50 ms 必须证明为五个连续 10 ms、
   每个 10-octet 的 speech frame，并验证 RTP timestamp/sequence 推进；
5. 验证每 10 ms speech frame 为 10 octets、SID 为 2 octets；一个 RTP payload
   允许零个或多个 speech frame 且至多一个 SID；no-data 必须不发送 RTP packet，
   不能编码成 zero-length speech；
6. 固定 `annexb` 缺失默认 `yes`、显式 `no` 在非对称 offer/answer 中优先；
   G729A=`annexb=no`，G729AB=`annexb=yes`；
7. 覆盖 G.729A、G.729AB、G.711/Opus 双向组合与独立 SIP peer 互通；
8. 运行 reference vector、PESQ/POLQA 或等价质量门禁；
9. 测量每 core sessions、P99 和 steady-state allocation；
10. 工程、互通、质量与容量各自未签署前保持 `not_run`。

Revision 4 D0 合同冻结后，工程提取、实现、编译和测试立即进行且只依赖 D0，不等待
另一轮人工批准；法律/专利结论只阻塞生产分发、runtime enablement 和 Production
Eligibility，不得写成
implementation blocker。

### 7.5 P1：Provider trait

rvoip 的 `AsrProvider/AsrStream`、`TtsProvider/TtsPlayback`、
`DialogManager`、`RecordingSink` 说明了正确的依赖反转方向。iveKit 不直接复用这些
类型，而把以下语义补入已有 Provider 层：

- streaming open/push/next/close；
- partial/final transcript；
- cancelable TTS playback；
- media frame 与 provider request 分离；
- Debug/trace 不输出文本、token、音频和 URL；
- Provider capability、deadline、quota、circuit、fallback；
- bounded input/output queue 和 slow-consumer policy；
- owner/session/sequence fencing；
- realtime 与 offline quality inspection 分离。

原因是 rvoip trait 很轻，直接使用会丢失 iveKit 已有的租户、同意、配额、降级、审计
和实时背压语义。

### 7.6 P2：vCon 与身份能力

- vCon 作为统一会话的**导出/交换格式**，不能替代 iveKit durable session、
  RecordingManifest 或审计事实；
- STIR/SHAKEN 作为 Goal 6 的可插拔签名/验证 adapter；
- registrar identity/credential provider 用于增强 SIP 身份插件边界；
- SCIM 能力进入 OPC 企业身份路线，不进入 RTP/SIP 热路径。

### 7.7 暂不吸收

- rvoip WebRTC/DTLS/ICE/TURN：继续由 LiveKit/Coturn 负责；
- rvoip QUIC/UCTP/WebTransport/MoQ：只跟踪，不进入语音生产数据面；
- rvoip Conversation/Session/Participant 全局业务模型：不替换现有 domain model；
- rvoip 通用 RTP transport server：不直接部署为 ordinary relay 或 Goal 4 worker；
  精确 packet/session slice 可在 processing Backend 或通过全部门禁的可选 Rust Native
  Fast Path Backend 内采用；
- rvoip PBX server：不与 RustPBX 并行部署；
- rvoip recording sink：不替换 RecordingManifest、spool 和 evidence pipeline。

## 8. 防止项目变杂的边界

每一项 rvoip 提取必须满足以下十一条：

1. **一个权威模型**：Call/Business Dialog/Logical Media Graph 归 RustPBX，Media
   Plan/Edge assignment 归 Media Engine Facade，Protocol Dialog 归当前
   `SipFoundation` Adapter；每条 committed Edge 只有一个 wire writer；
2. **一个接入口**：所有处理媒体只通过 Facade 进入进程内
   `EmbeddedVoiceMediaBackend`；首期不使用 HTTP/gRPC；
3. **不引入第二网络 runtime**：允许 RustPBX 进程内 rvoip library Adapter，禁止独立
   rvoip SIP/WebRTC server、双主路径和同一 Protocol Session 双写；
4. **最小源码面**：按独立 crate/模块提取，禁止把 46-crate workspace 加为顶层依赖；
5. **带来源清单**：exact commit、文件 hash、改动说明、测试证据进入 fork manifest；
6. **同一性能合同**：任何提取代码必须接受 Goal 4/6/10/11 的 profile/finalizer，
   不能用上游自己的“通过”替代 iveKit 验收。
7. **单进程 Rust 核心、外部 ordinary data plane**：RustPBX↔rvoip SIP 与首期
   RustPBX↔`voice-media-rs` 调用必须进程内；RTPengine 保持外部专用数据面。
8. **类型隔离**：业务 Interface 不暴露 rsipstack、rvoip、rustrtc 或 audio-codec 类型。
9. **DTMF 单一业务权威**：RustPBX 按 Leg 生成 canonical event；来源优先级为
   negotiated RFC 4733、显式接受的 SIP INFO、in-band detector，并对 repeated end、
   INFO retry 与跨来源同一 tone 有界去重；transparent relay 不产生业务 event，每个
   outbound Leg 只选择一种 wire mechanism。
10. **故障结论按 Edge 聚合**：Unified RustPBX 丢失时 ordinary RTPengine required
    Edge 为 `continue_degraded`，embedded required Edge 为 `interrupt_visible`；
    mixed call 采用最坏 required Edge 结果，optional tap 只降级/释放自身。
11. **容量只认 co-resident SUT**：生产 profile 必须测 control + embedded workers
    同进程的 Unified RustPBX，并绑定 compiler/selector/backend-mix identity、cpuset/
    NUMA/allocator/QoS、SIP headroom 与故障注入；独立 `voice-media-rs`
    microbenchmark 只作诊断，不能授权生产容量。

## 9. 对 Goal 0-11 的影响

| Goal | 调整 |
| --- | --- |
| Goal 0 | 把 rvoip exact commit、能力矩阵和 benchmark 作为 source spike 输入 |
| Goal 1 | 不改变媒体权威和控制协议 |
| Goal 2 | 保留 RTPengine fork；新增 group-scoped atomic blocked lifecycle patch 目标，当前 `not_present/not_run` |
| Goal 3 | 增加 `SipFoundation` Seam 与 Binding Group/Wire Bundle Facade；Business Dialog、owner、recovery、CDR 不迁移 |
| Goal 4 | 吸收 pooled Bytes、fixed worker、benchmark 方法；强制完整 G.729 Exact Source Slice、per-Leg DTMF 与 co-resident SUT |
| Goal 5 | 仅吸收 RecordingSink 的接口思想，不替换 evidence plane |
| Goal 6 | 导入 RFC/compat/security matrix，并按 parser→transaction/dialog/transport 迁移协议底座 |
| Goal 7 | 将 allocation、cache-line、per-core benchmark 纳入 CPU/NUMA 优化 |
| Goal 8 | 不改变 Cell placement；未来可借鉴 registrar identity adapter |
| Goal 9 | 导入 trace redaction、fuzz 和 immutable evidence 方法 |
| Goal 10 | 导入 SIPp profile 组织方式，仍使用独立 generator fleet |
| Goal 11 | 增加 rvoip-derived source identity 和 non-claim 审核 |

## 10. 组件升级策略

“需要升级就升级”采用以下规则：

1. 升级必须解决已知缺口、性能瓶颈、安全问题或长期维护风险；
2. 先在独立 worktree/reproducible image 中 rebase；
3. 现有 38 个补丁逐个 `apply --check` 或语义迁移；
4. 先过 contract、unit、interop、failure、capacity regression；
5. 任何 owner/media/CDR/recording 语义回退都阻止升级；
6. 不为了版本号更新而替换已验证的 rustrtc `0.3.90` 接口；
7. rvoip 组件若被提取，固定 exact commit，不引用 `main` 或宽松 semver。
8. RustPBX 与 rvoip 顶层 MIT 许可文本和相关第三方声明必须保留；MIT 不代替 G.729
   适用专利评估，该评估仍只阻塞生产分发/启用/资格，不阻塞工程。

## 11. Revision 4 D0 后的执行顺序

截至 2026-07-29，下列项目按实际完成状态分别记录；服务器真实 RTP、故障注入和容量签署
仍为 `not_run`：

1. 先完成整合设计、`CONTEXT.md`、本 ADR、总计划、Goal 4 plan 和 capacity index；
2. 同步 rvoip capability matrix/schema，明确每个 SIP foundation Adapter、状态和门禁；
3. 完成文档/schema/链接审查且无 Critical/Important；
4. 已完成 `voice-media-rs` hard-bounded `DatagramPool`；
5. 已完成固定线程、固定 shard、固定 packet budget 的 `RtpWorkerPool`；
6. 已用本机真实 UDP 测试 PCMU/Opus 双向转换、source latch、RFC 4733 和 queue exhaustion；
7. 待完成 parser、serialize、jitter、demux、codec 和 packet-loop 的可复现分层
   Criterion benchmark；SRTP 归当前选定 fast-path/security profile，UDP loopback
   仅作受控诊断；
8. 已完成既有 IVR 的 playback/gather/barge-in、SIP INFO 与 durable terminal event；
9. 已有 media-control/profile-router 代码作为当前实现事实保留；目标接入必须改为
   Media Plan/Edge selector，既有 `voice-media-rs` HTTP/binary 只用于诊断/benchmark，
   生产 IVR 通过 owner-fenced direct Rust Adapter 使用进程内 Backend；
10. 先完成 Backend Binding Group/Wire Transport Bundle、O(1) Edge-flow index、
    atomic `prepare_blocked/commit/revoke/query-reconcile`、initial/migration SDP 与
    decision-aware compensation；RTPengine 新 lifecycle patch 当前为
    `not_present/not_run`，不得借历史补丁证据晋级；
11. Revision 4 D0 冻结后，立即完成 rvoip G.729 exact-source manifest，并实现一个
    `G729/8000` wire codec 及 G729A/G729AB 两个 mandatory internal mode；U2 只依赖
    D0，不等待 U1 或法律结论；
12. 建立 parser shadow 等价门禁，再按 `SipFoundation` 阶段迁移；
13. 在 Goal 6 建立 RFC/compat/security machine-readable matrix；
14. 在服务器以 co-resident Unified RustPBX SUT 跑统一 A/B，而不是直接比较两份项目
    自己的报告；发布只对新呼叫切 selector，旧呼叫 drain。

当前发布候选为 `ivekit.38`：固定上游 RustPBX、rsipstack、rustrtc 源码后，完整 38
补丁按生产构建顺序逐个 `apply --check` 并成功重放；干净 RustPBX 源码回归结果为
`1,911 passed / 0 failed / 1 ignored`，rsipstack 定向回归为 `3 passed / 0 failed`。
这些是源码与功能回归证据，不是服务器容量结论。

## 12. Backend 替换门槛

### 12.1 RustPBX 产品主干不在本 ADR 中被替换

Revision 3 的“未来整体替换 RustPBX 门槛”由 Revision 4 supersede。RustPBX 产品层、
Call Core、Business Dialog、Media Plan、路由、CDR 与运营 Authority 是本架构的冻结
组成。任何整体替换只能由新的 superseding 架构 ADR 发起，不能借 rvoip Module
absorption 或 Backend qualification 获得授权。

### 12.2 Rust Native Fast Path 候选 Backend 的资格门槛

这不是替换 RustPBX，也不要求淘汰 RTPengine；它只允许在 Media Engine Facade 下发布
另一个 ordinary relay Backend。必须全部满足：

1. 与所竞争的 `CARRIER-CELL-V1` workload 等价的功能矩阵完整：RTP/RTCP、
   IPv4/IPv6、NAT/source validation、SDP rewrite、SDES/DTLS-SRTP、
   ICE-aware/ICE-unaware、QoS/TOS、DTMF、media/recording fork、T.38、
   timeout/statistics、受控 userspace fallback、owner fence、query/reconcile，
   以及该 Profile 实际启用的全部功能；
2. ordinary pass-through 无 decode/encode，所有 session/socket/packet/queue/timer
   有硬上限；
3. 同硬件、同 NIC/NUMA、同 packet/security workload 的 PPS、CPU/packet、P99、loss
   和 safe session density 均不劣于 RTPengine 基线；
4. kernel/NIC 加速、batch I/O、affinity 和 memory profile 可重现且不绕过安全；
5. processing、recording、Provider、storage 和 control 故障不影响 ordinary relay；
6. 2/4/8 节点区段边际效率达到计划门槛；
7. 24 小时 endurance、rolling upgrade、drain、Cell canary 和 rollback 通过；
8. `RUST-NATIVE-FAST-PATH-CANDIDATE` source/binary/config/workload/evidence
   finalizer 通过；
9. Backend Binding Group/Wire Transport Bundle 的 generation、O(1) flow mapping、
   blocked prepare、zero-output revoke、query/reconcile、zero-ref release、initial/
   migration SDP 和 pre/post-decision compensation 全部通过 race/failure evidence；
10. rollout 仅对新呼叫启用 selector/backend mix、旧呼叫 drain，证据固定
    `media_plan_compiler_revision`、`backend_selector_revision` 和 `backend_mix_id`。

任一项未满足，`CARRIER-CELL-V1` 的 RTPengine 继续是已批准的长期正式 Backend，
Rust Backend 保持 `not_run/failed`，不得用“纯 Rust”宣称覆盖功能或性能回退。全部
满足也只允许把该 identity 登记为同一 `CARRIER-CELL-V1` 中 eligible 的 ordinary
Media Edge Backend。每条 active Edge 仍只有一个 writer；切换必须建立新 Edge/group
generation、必要时完成 re-INVITE/新 media session，并按 old zero-output revoke ACK
后 commit new 的 barrier 保证 writer 不重叠。RTPengine 保持长期默认 Backend。

## 13. 最终判断

rvoip 是一个值得长期跟踪并按门禁逐模块采用的 Rust 通信技术库，尤其适合提供 SIP
Message Codec、Transaction、Protocol Dialog、Transport/DNS、codec、协议测试、
Provider interface、身份扩展和性能证据方法。它不是当前 iveKit RustPBX 的即插即用
整体替代品。

当前最优解不是在二者之间二选一，而是：

- 用 RustPBX 保住已经完成的运营级呼叫权威和故障恢复；
- 用 `SipFoundation` 把 rsipstack 与 rvoip 隔离成可验证、可回滚的 Adapter，并在
  等价门禁通过后删除被替代的协议实现；
- 把 RustPBX 产品层、Call Core 与 rvoip SIP Module 编译成一个 executable，共用
  control runtime，不引入内部 RPC；
- 用一个 Media Engine Facade 把 Logical Media Graph 编译成 Media Plan，并保证每条
  directed Media Edge 只有一个 fenced writer，同时由 generation-scoped Backend
  Binding Group/Wire Transport Bundle 统一管理共享物理 allocation；
- 用 RTPengine 长期保住普通媒体极致 fast path，并把它作为默认生产 Backend 和不可
  降低的同硬件 oracle；
- 通过第 12.2 节全部门禁后，Rust Native Fast Path 只能成为同一生产架构下的
  eligible Backend，不创建第二套生产 Profile，也不强制替换 RTPengine；
- 把 `voice-media-rs` 首期嵌入 Unified RustPBX Process，以直接 Rust Adapter、固定
  worker/shard、独立 CPU budget 和有界 queue 执行 decode-required Edge；
- 从 rvoip 精确采用或提取协议 Module、codec、buffer、benchmark、RFC 和安全工程成果；
- 用统一 VOS-EQ/100K 合同决定每一次提取是否真的提升系统。

这条路线同时满足“功能不能阉割”“单机性能极致”“横向扩展边际不衰减”和“项目不能
因开源组件叠加而失去边界”四个目标。

## 14. 变更记录

| Revision | 日期 | 变更 |
| --- | --- | --- |
| 3 | 2026-07-29 | 接受 RTPengine 长期正式定位与 Rust-native 性能竞争路线 |
| 4 | 2026-07-29 | 锁定唯一 `CARRIER-CELL-V1` 生产基线；Backend 选择改为 directed Media Edge；首期同进程嵌入 `voice-media-rs`；拒绝 rvoip 高层 runtime；移除本路线整体替换 RustPBX 的出口 |
| 5 | 2026-07-29 | 固化 Backend Binding Group/Wire Transport Bundle、O(1) Edge-flow mapping、atomic blocked lifecycle、initial/migration SDP、decision-aware compensation、per-Leg DTMF、co-resident 容量和新呼叫选择/旧呼叫 drain。 |
| 6 | 2026-07-30 | 绑定 Revision 4 机器合同；冻结 effect/receipt、wire、confirmed-only recovery、durable-store SLO、Edge-to-Core、rolling schema、clock、fail-closed capability、真实单进程故障域和 Voice↔LiveKit Authority 边界；更正 G.729 为一个 wire identity 与两个 mandatory internal mode。 |
