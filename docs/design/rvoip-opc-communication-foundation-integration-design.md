# rvoip × OPC/iveKit 通信底座整合设计

> 相关文档：
> [`CONTEXT.md`](../../CONTEXT.md) ·
> [`ADR-CCAAS-5`](../adr/ccaas-5-media-authority-and-rtpengine.md) ·
> [`ADR-CCAAS-7`](../adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md) ·
> [`ADR-CCAAS-8`](../adr/ccaas-8-voice-livekit-bridge-handoff.md) ·
> [`VOS5000 对等与性能计划`](communication-foundation-vos5000-parity-performance-plan.md) ·
> [`Revision 4 实施计划`](../superpowers/plans/2026-07-29-unified-voice-foundation-r4.md)
>
> 文档状态：Accepted，Revision 4，唯一权威架构与生产基线；运行与生产资格仍按各门禁
> 保持 `not_run`
>
> 决策 ID：`rvoip-rustpbx-unified-authority-r4`
>
> 日期：2026-07-30
>
> 适用范围：OPC/iveKit、iveKit RustPBX fork、rsipstack、rustrtc、RTPengine、`voice-media-rs`
> 与 `eisenzopf/rvoip`
>
> 前置约束：本文完成、能力矩阵同步并通过文档审查前，不开始新的 rvoip 协议底座实现切片

## 1. 决策摘要

本次整合不是在 OPC 与 rvoip 之间二选一，也不是把 rvoip 当成只供参考的测试仓库。
最终决策是：

1. **rvoip 进入 OPC 的通信协议底座候选层。** 只把 SIP parser/serializer、Protocol
   Transaction、Protocol Dialog、UDP/TCP/TLS Transport、DNS、认证 primitives 和
   必需 RTP/codec primitives 按独立模块逐步接入。rvoip 高层 Orchestrator、
   Conversation/Participant、PBX server 和全局 Session runtime 不接入生产主干。
2. **RustPBX 不被 rvoip 替代。** RustPBX 继续是唯一 Call、Leg、Business Dialog、
   owner epoch、双腿恢复、路由执行、CDR 和 Logical Media Graph Authority。
3. **RustPBX 与 rvoip SIP 底座单进程融合。** 目标是一个受控 Cargo build graph、
   一个 RustPBX 可执行文件、一个 Tokio control runtime；两者通过 Rust Interface 和
   内存对象调用，不使用 RPC，也不部署“RustPBX 节点 + rvoip 节点”。
4. **不运行第二套 PBX。** rvoip 以库、Adapter、Exact Source Slice 或测试资产进入，
   不在 RustPBX 旁边部署另一套 rvoip B2BUA、registrar、generic RTP relay 或全局
   Conversation/Session runtime。
5. **不重复造 SIP/RTP 基础设施。** 经过等价门禁后，现有内部协议实现应被 rvoip
   模块替换，而不是永久叠加；迁移期只允许只读 shadow 比对，禁止两个栈同时发送响应、
   修改 Protocol Dialog 或分配媒体。
6. **媒体只有一个 Media Plan Authority，并以有向 Media Edge 为最小执行单位。**
   RustPBX 只依赖一个 Media Engine Facade；Facade 把 Logical Media Graph 编译为有
   版本的 Media Plan。每条有向 Media Edge 在 commit 后只绑定一个 Backend、一个
   writer fence 和一份 Wire Media Binding；一条或多条 Edge 可显式引用同一个
   Backend Binding Group/Wire Transport Bundle，以匹配 RTPengine 的
   call/tag/media-section 与共享端口、SDP、ICE/DTLS 物理粒度。普通 relay Edge 默认由 RTPengine 执行；
   需要解码的 Edge 由 Unified RustPBX Process 内嵌的 `voice-media-rs` 执行。rvoip 的
   RTP packet/session 方法只能替换对应 Backend 内部实现，不能形成第二个线上 RTP
   Authority。双向通话、tap、录音和处理 chain 都必须展开为不同 Edge，不能用“一个
   Call 一个 Backend”掩盖混合媒体图。
7. **G.729 必须实现。** 对外和 RTP wire 只有一个 codec identity：
   `G729/8000`。G729A（Annex B 关闭）和 G729AB（Annex B 开启）是两个独立、强制的
   internal processing/quality/capacity mode，从固定 rvoip commit 提取精确源码，并完成
   双向 G.711/Opus、ptime、Annex B、参考向量、互通、质量和容量门禁。
8. **法律/专利不阻塞工程。** 法律、专利和分发结论只阻塞生产分发、runtime enablement
   和 Production Eligibility；不阻塞源码提取、实现、编译、单元测试、互通测试和性能测试。
9. **终态是 Rust 主导、性能优先的语音底座。** SIP、Call Core、codec、jitter、DSP、
   mix、recording control 和 AI audio Interface 的产品实现以 Rust 为主；RTPengine
   是获准长期使用的运营级 ordinary RTP fast path，而不是必须淘汰的临时件。
   Rust-native Fast Path 保留为同一生产架构下的可选竞争 Backend，只有同时达到功能、
   性能、音质、故障隔离、长稳和扩展门禁后才可成为 eligible Backend；它不是第二套
   Deployment Profile。不得为语言纯度牺牲能力或性能。

一句话定位：

> rvoip 是可逐模块采用的 SIP/RTP 协议底座与工程资产；RustPBX 是 OPC 的业务软交换
> Authority。rvoip SIP Module 与 RustPBX 同进程、无 RPC；`CARRIER-CELL-V1` 是唯一
> 生产基线，RTPengine 默认执行 ordinary Media Edge，进程内 `voice-media-rs` 执行
> decode-required Media Edge。获批的 Rust-native fast path 只能替换特定 Edge 的
> Backend，不改变 Authority 和生产拓扑。

### 1.1 Revision 4 的可执行合同

Revision 4 不推翻 Revision 3 的单一 Authority、单一生产基线和渐进式吸收方向；它把
评审中仍有歧义的运行语义变成机器合同。规范性入口是：

- [`unified-voice-foundation-r4-v1.json`](../capacity/contracts/unified-voice-foundation-r4-v1.json)；
- [`unified-voice-foundation-r4-traceability-v1.json`](../capacity/contracts/unified-voice-foundation-r4-traceability-v1.json)；
- [`rvoip-capability-integration-v1.json`](../capacity/contracts/rvoip-capability-integration-v1.json)；
- [`voice-media-goal4-v1.json`](../capacity/contracts/voice-media-goal4-v1.json)。

前两个合同负责 Revision 4 新增的横切不变量与零遗漏追踪；后两个合同保留已经冻结的
198 项 rvoip capability、14 个历史替换门禁和 Goal 4 切片事实。历史条目不得为了让
Revision 4 “看起来完成”而删除、重命名或批量改成已实现。

状态必须分四层：

| 层级 | 含义 |
| --- | --- |
| `current` | 当前源码中真实存在且能定位的行为 |
| `target` | 本文接受、但仍可能尚未实现或运行的唯一目标行为 |
| `verification` | 绑定精确 source/binary/config/workload 的测试结果；未运行就是 `not_run` |
| `production_eligible` | 所有适用功能、互通、性能、安全、供应链和外部环境门禁都通过 |

`implemented`、上游 README、编译成功、单元测试、mock、local microbench 或 controlled
same-host 结果都不能自动提升 `production_eligible`。本 Revision 冻结合同时的容量、
真实 RTP/SRTP、真实 LiveKit bridge、G.729 互通/音质/容量和外部生产资格均保持
`not_run`。

### 1.2 SIP 可见 Effect、Receipt 与 wire freeze

系统不承诺网络 Exactly Once。每个 SIP 可见 Effect 必须以同一
`protocol_effect_id` 和 immutable wire hash 分别记录以下事实：

1. `durable_decided`：权威存储已提交允许发送的决定；
2. `send_attempted`：本地 runtime 已尝试提交给 transport；
3. `transport_accepted`：本地 transport 接受 bytes，不等于 peer 收到；
4. `protocol_observed`：response、ACK 或其他 RFC 协议事件证明远端可观察；
5. `failed`：有确定不可恢复的本地或协议失败；
6. `unknown`：超时、断连或崩溃使结果无法确定，必须 query/reconcile。

`query_effect` 只能返回本地 WAL、transaction 和已观察协议事实；不能把 kernel
`send()` 成功推断为 peer receipt。重传必须复用同一 transaction identity 和同一
wire bytes/hash。冲突 replay fail closed；保留期和 GC 只能删除已到不可逆终态且超过
审计窗口的记录。

wire 构造顺序固定为：

```text
semantic intent
  -> RFC 3263 / route / transport / advertised-local-endpoint binding
  -> Via/branch/Route/auth/bytes/hash freeze
  -> durable business/effect decision
  -> transmit
```

DNS 和 connect 可在 durable decision 前作为有界、无 SIP 可见输出的准备动作。
`PreparedProtocolEffect` 必须绑定 candidate、transport、local endpoint、TLS SNI、
route set 和 wire hash。commit 后不得静默改写 bytes。candidate failover 若改变
transaction identity、Via/branch、route、transport 或 local endpoint，必须建立带
lineage 的新 protocol attempt；是否可以复用 transaction/bytes 由冻结的 Adapter
capability 决定，不能临场猜测。

非 2xx ACK 属于 INVITE Transaction；2xx ACK、重复/分叉 2xx 与 UAS 2xx 重传属于明确
的 UAC/UAS Core/Protocol Dialog policy。自动 ACK、CANCEL、重传和错误响应同样属于
可见 Effect，必须进入 effect policy，不得绕过 durable decision 或偷偷双发。

### 1.3 持久恢复、存储 SLO 与 Edge-to-Core 安全

V1 takeover 只承诺 **confirmed 且 transaction-quiescent** 的 Business/Protocol
Dialog。以下状态不能被笼统标为“已恢复”：

- early dialog；
- 活动 INVITE 或 non-INVITE transaction；
- UAS 等待 2xx ACK 或 UAC 尚未发送 2xx ACK；
- PRACK/RSeq/RAck 未闭合；
- 已失效的 TCP/TLS/WS flow；
- 未决 DNS/candidate attempt；
- `active_timers`（availability=`unavailable`、lossless=false、
  cross-Adapter=false；runtime `Instant` 不持久化）；
- `unknown` protocol effect；
- 不兼容 schema 或来自另一 Adapter runtime identity 的 capsule。

这些场景必须按 recovery matrix 选择 fail closed、旧 owner drain、协议终止或
operator-visible repair；`active_timers` 只能 fail closed 或按协议重新启动。
socket、connection 和 monotonic `Instant` 不持久化；restore 失败不能记为 takeover
成功。Kamailio Record-Route、mid-dialog owner routing、owner
epoch/token 与失效 flow 的重路由必须一起闭合。默认不跨 Adapter 恢复 active Call。

权威 durable store 必须给出 transaction 原子边界、pool/queue 上限和建呼各阶段
P99/deadline。`100 Trying` 只可在 SIP transaction admission 成功后、业务 commit 前
发送，用于抑制上游重传；18x/2xx、路由、计费、媒体 commit 等业务可见 Effect 必须在
相应 durable decision 后发送。store 延迟、不可用或容量耗尽时拒绝新 Call、给出确定
SIP cause/`Retry-After` 并保护既有 Call；重试、repair 和 reconciliation 都有界。每个
“durable decision 前/后、send result unknown”的 crash point 都必须有测试。

store 的原子边界不是“最终一致即可”：Call admission 必须同事务写
Call Session、Protocol Effect、Effect WAL、capacity reservation receipt 与
idempotency record；media generation 同事务写 Media Plan、directed Edges、Binding
Groups 与 reservation receipt；bridge head 同事务写 command/decision/receipt/CAS；
recording 同事务写 intent、root manifest、source chain 与 segment reference。四类
事务都是 single-Region all-or-nothing，partial commit 回滚并返回稳定错误。
route、media、billing、recording、webhook 分别等待其声明的 durable gate。

`store_timeout/store_pool_exhausted/store_unavailable/
store_schema_incompatible` 一律返回 SIP 503 和确定性 `Retry-After`：
`clamp(1, 30, 1 + ceil(pool_wait_ms/1000) + ceil(queue_depth/256) + retry_attempt)`。
输入必须是 checked u64，pool wait/queue/retry 上限为 250/1024/3；禁止 jitter，同一
输入得到同一输出，非法输入拒绝且不得伪造 `Retry-After`。

Kamailio 与 Core 之间还须冻结 Edge-to-Core Acceptance Contract：

- 选择并版本化 raw bytes 或唯一 canonical bytes 的传递方式；
- 双方共享 parser accept/reject policy；
- 可信传递 source identity、ingress transport、TLS verification、原始/规范长度和
  policy version；
- 清除外部伪造的内部 metadata，再由 Edge 重建；
- differential security corpus 覆盖冲突/重复 Content-Length、Via、Authorization、
  obsolete folding、URI escape、Contact 和 multipart。

Revision 4 的唯一具体版本是 `edge-core-sip-v1`：转发
`raw_bytes_with_trusted_metadata`，保留原始 bytes 并校验其 SHA-256。可信 metadata
只允许 `source_identity`、`ingress_transport`、`tls_verification`、
`raw_message_length`、`raw_message_sha256` 和 `parser_policy_version`；任何公网传入的
同名内部 header 先剥离，再由受信 Edge 重建。硬上限固定如下，不能由某个 Adapter
自行放宽：

| 项 | 上限 |
| --- | ---: |
| 完整 SIP message | 65,535 bytes |
| start line | 4,096 bytes |
| URI | 2,048 bytes |
| header section | 32,768 bytes |
| header 数量 | 128 |
| 单条 header line | 8,192 bytes |
| body | 32,768 bytes |
| multipart boundary | 70 bytes |
| multipart nesting depth | 2 |
| multipart part 数量 | 16 |
| 单个 part headers | 8,192 bytes |
| 单个 part body | 32,768 bytes |

关键 header 规则同样闭合：`Content-Length` 只允许一个值，或与 raw body octet 长度
匹配的 byte-identical duplicates；`Via`、`Contact`、`Authorization` 是保持顺序且
逐值成功解析的 repeatable header；`Route`/`Record-Route` 保持 wire order；
`From`/`To`/`CSeq` 只接受语义相同 duplicate，`Call-ID` 只接受 byte-identical
duplicate，`Max-Forwards` 只接受相同十进制值。发生冲突时 fail closed，禁止选择
first/last value。URI 的非法 percent escape 一律拒绝；unreserved 只解码一次，
reserved octet 保留；userinfo 只有一个 `@` delimiter，解码后不得重新解释 delimiter；
host 规范化为 lowercase ASCII 或 IDNA2008 A-label，拒绝歧义 trailing dot；IPv6
literal 必须带方括号。multipart boundary 畸形或歧义同样 fail closed。
一个 URI 最多 32 个 parameter 和 16 个 header component。

RFC 3263 的 NAPTR order/preference、SRV priority/weight 和 address-family policy
决定 candidate order；candidate identity 绑定 target FQDN、transport、port、
address 与上述 DNS 权重字段。DNS query/单 candidate connect/总 resolution-connect
deadline 固定为 2/3/10 秒，最多 8 个 candidate、每个最多一次 retry。耗尽时写
terminal effect 和 ordered candidate-attempt receipts。attempt receipt、transaction
effect、late-response correlation 分别保留 1 天、7 天、32 秒；只有 transaction、
Dialog、recovery 与 rollback reference 均过期后才能 GC。

### 1.4 Schema、时钟、drain 与 Backend capability

Business/Protocol Dialog、Effect WAL、Media Plan/Binding、Wire Bundle、
Recovery Capsule 和 Voice-LiveKit Bridge 各自携带 `schema_version`。每次 rolling
upgrade 都必须冻结 N/N+1 reader-writer、takeover、drain、rollback、migration、
retention/GC 矩阵。closed schema 的 unknown-field policy 与前向兼容策略必须一致；
不兼容 snapshot fail closed 或由旧 binary drain，禁止猜测转换。

版本权威不是进程内常量，而是 PostgreSQL Region durable store 中的
`opc-persistent-schema-registry-v1`。每条注册事实由
`(artifact_type, schema_id, schema_version, schema_sha256)` 唯一识别；Registry
不可用时禁止启用新 writer version。Call Session、Business/Protocol Dialog、
Protocol Effect、Effect WAL、Media Plan、directed Media Edge、Binding Group、
Wire Bundle、Recovery Capsule、root RecordingManifest、recording source chain 和
Capacity Vector 各自版本化；Voice↔LiveKit 还必须分别注册五个 durable artifact：
`voice_livekit_bridge_generation`、`voice_livekit_bridge_attempt`、
`voice_livekit_bridge_command`、`voice_livekit_bridge_receipt` 和
`voice_livekit_bridge_tombstone`，不能用一个可变 bridge blob 代替它们。

这 18 类 artifact 不是共享一张抽象兼容表：每一类独立记录 `schema_id`、N/N+1
版本、两个 schema hash slot、current writer version/identity、四格 reader matrix、
writer gate、takeover prerequisite、migration、rollback、retention 与 GC。
当前两个 schema hash、current writer version 和 current writer identity 均为
null，状态为 `not_run`。writer 只有取得 Registry receipt、两个 schema hash 已验证且
全部 live reader 兼容后才能启用；迁移使用逐对象幂等 durable receipt，回滚保持 N
writer 到全部 N reader drain，GC 等所有 reader/writer/rollback reference 清零。

Capacity Vector 采用显式 expand/contract：`1.1.0` reader 可读取不含
`voice_livekit_bridge` 的 `1.0.0` producer vector；`1.0.0` reader 不承诺读取
`1.1.0`。因此 `oldest_live_reader_first` 在所有在线 reader 支持 `1.1.0` 前禁止
writer 发出桥接向量。桥接向量一旦出现，必须完整携带 13 个 canonical
dimension；`target`、`not_run` 或 `failed` 证据只能发布
`safe_capacity=0` 且拒绝新 interaction，不能继承 ordinary RTP、LiveKit-only
或未包含可选桥接路径的容量结果。

compatibility evidence 必须直接证明四件事：旧 `1.0.0` reader 拒绝 `1.1.0`
writer、`1.1.0` reader 接受 `1.0.0` producer、所有 live reader 支持 `1.1.0` 前
writer 继续发 `1.0.0`、回滚期间仍以 `1.0.0` 写到旧 reader 全部 drain。`1.0.0`
缺少 bridge 对象的唯一语义是“不支持且 advertised bridge capacity 为零”，不得
解释成 unknown fields 会被隐式保留。

时钟域不得混用：

| 时钟 | 用途 | 禁止 |
| --- | --- | --- |
| UTC wall clock | durable/audit/event correlation | SIP timer、进程内 elapsed deadline |
| monotonic clock | timer、deadline、lease、elapsed latency | 跨进程持久化 `Instant` |
| RTP media clock | sequence/timestamp、ptime、jitter、drift | 当作 UTC 或业务排序时钟 |

NTP 跳变不得改变 SIP timer。跨节点证据必须记录 offset/quality；RTP wrap、长期 skew、
resampler correction 和恢复策略分别测试。

`drain` 默认停止新 Call/Protocol Session/Binding，旧 Call 保持原 runtime identity
完成。active-zero 必须取得三个 Authority 的 checked-u64 zero receipt：
`unified_rustpbx` 的 `call_count/protocol_session_count/edge_count/
binding_group_count`，`rtpengine` 的
`session_count/port_count/allocation_count/generation_count`，以及 `effect_wal`
的 `pending_effect_count/unknown_effect_count/repair_delta_count/
cleanup_delta_count`。三份 receipt 必须绑定并一致于 exact
`tenant_id/drain_scope_id/generation/observation_epoch`，同时携带
`counter_vector_digest/receipt_digest`；缺失、过期或不一致都表示尚未
active-zero，只能继续 drain。删除还要求 `retention_reference_count=0` 和
`rollback_reference_count=0`。普通 timeout 只停止新 admission、继续 drain，
不得 BYE 或强删；紧急终止/删除必须由包含
`actor/reason_code/incident_id/scope/expires_at/decision_hash` 的独立授权触发并写
审计 receipt，不能伪装成正常 drain 或无损迁移。

每个 Backend 发布绑定 source/binary/config digest 的 `BackendCapabilitySet`，至少包含
allocation、prepare、blocked output、commit、abort、revoke-zero-output、fence、
query、reconcile、migration、security termination 和 member-flow fence 的粒度与
verification。Media Plan compiler 只选择全部 required capability 为
`support=supported && verified=passed` 的 Backend；`unsupported`、`partial`、
`unknown`、`not_run` 或粒度粗于目标 Edge 的能力全部 fail closed。当前 RTPengine
atomic binding lifecycle 是强制 Target，但
patch=`not_present`、verification=`not_run`，因此不得宣称 active migration 已可用。

闭合 schema 固定为 `backend-capability-set-v1@1.0.0`。四个 Backend 的完整 required
capability ID 集合为：

| Backend | role / allocation-fence scope | required capability IDs |
| --- | --- | --- |
| `embedded_voice_media` | decode-required / directed Edge generation | `bounded_processing_session`、`codec_chain`、`rfc4733_dtmf`、`recording_tap`、`ai_tap`、`n_minus_one_mix`、`owner_fence`、`zero_output_revoke` |
| `livekit_sip_bridge` | voice-room bridge / bridge generation | `bidirectional_bridge`、`participant_lifecycle`、`prepare_blocked`、`zero_output_revoke`、`query_reconcile`、`terminal_tombstone`、`ice_dtls_srtp_bundle_mid` |
| `rtpengine_ordinary` | ordinary / Binding Group generation | `ordinary_rtp_rtcp`、`srtp`、`wire_sdp`、`prepare_blocked`、`commit`、`revoke_zero_output`、`query_reconcile`、`member_flow_binding`、`dtmf_event_notification` |
| `rust_native_fast_path` | optional candidate / Binding Group generation | `rtp_rtcp_srtp_parity`、`kernel_nic_numa_profile`、`same_hardware_rtpengine_floor`、`failure_isolation`、`endurance_24h` |

每份记录还绑定 source、binary、config 与 capability-set digest，并逐 capability
给出 `required/support/verified/granularity`；任一 digest 缺失、runtime identity
不匹配或 `verified != passed` 都不可选。Media Graph compiler 的权威输出仍是一条
directed Edge generation。若 Backend allocation/lifecycle/fence 粒度粗于 Edge，
必须证明 immutable member set 与 exact member-flow fence；证明不了就拆出独立
Binding Group，无法拆分则在任何 Backend allocation 前 fail closed。

同一 Backend 的 lifecycle 不能由一个 aggregate boolean 推断。compiler 对
`allocation/prepare/commit/abort/revoke/fence/query/reconcile/migration/
notification/member_flow_fence/zero_output_ack/security_termination_scope` 13 个
operation 分别检查 `support=supported`、`verified=passed`、exact operation
granularity 和全部 prerequisite。缺失、unsupported、unverified、granularity
mismatch、prerequisite unmet 是五个独立 compile error；任一个都在产生副作用前
fail closed 并冻结 exact generation。

### 1.5 单进程故障域、媒体需求和安全门禁

Unified RustPBX 单进程减少 RPC、重复状态和序列化开销，但不提供地址空间隔离。
固定 worker/shard、CPU budget、有界 queue/pool、admission 和 panic policy 可以隔离
健康进程内的局部过载；OOM、process abort、undefined behavior、allocator corruption
或不可捕获 native failure 可能中断该进程内全部 embedded Edge。普通 RTPengine Edge
在 control process 丢失后是否继续必须单独实测，不能由架构图推断。

`media-plan-capacity-demand-v1` 在 admission 前把 authoritative Media Plan 的
RTP flows、RTCP flows、SRTP contexts、port pairs、decode/encode/resample/
transcode Edges、mix outputs、recording/AI Edges、packetization、bitrate 和 NUMA
affinity，以及 worker/shard count、queue depth、service time、backpressure limit
编译为：

- `rtp_socket_count`、`rtcp_socket_count`、`srtp_context_count`、
  `port_pair_count`；
- `packet_rate_pps`、`bit_rate_bps`、`memory_bytes`、
  `cpu_micros_per_second`、`numa_node`；
- `decode_slots`、`encode_slots`、`resample_slots`、`transcode_slots`、
  `mix_slots`、`record_slots`、`ai_slots`；
- `worker_count`、`shard_count`、`queue_depth`、`service_time_micros`、
  `backpressure_limit`。

编译按 exact directed Edge 与 Binding Group generation 求和，共享
`wire_transport_bundle` 只计一次。role supply 固定为：`rtpengine_ordinary` 和
`rust_native_fast_path` 只供应 Wire Transport Bundle；`embedded_voice_media`
供应 Bundle 以及 decode/encode/resample/transcode/mix/record/AI；
`livekit_sip_bridge` 供应 Bundle 以及 decode/encode/resample/transcode。所有
required demand 必须在 Backend
prepare 前原子预留；还必须为已声明 failure domain 保留 reserve，N+1 等于 peak demand
再加最大 failure-domain demand。缺失、过期或属于另一 profile 的 supply 一律 fail
closed，独立 codec microbench 不能授权 co-resident production capacity。

每条 supply 还必须绑定 capacity profile/revision、role、Backend source/binary/config、
hardware profile、Cell、failure domain、issued/expires time 与 signature key，并在
admission 前验签。对每个 capacity-vector dimension 使用 checked u64 计算：
`deduplicated_demand <= signed_unexpired_identity_bound_supply
- active_reservations - failure_reserve`；shared transport 只按
`(binding_group_id, binding_group_generation, wire_transport_bundle_id)` 去重。
同一 dedupe key 对应不同 demand vector 时 `conflict_fail_closed`，不得重复计数、
覆盖或任选一个 vector。
缺字段、过期、签名/identity/unit 不匹配、overflow 或 underflow 一律拒绝。
reservation 用 profile/revision/epoch/available-vector digest CAS，并在 Backend
prepare 前持久化含 tenant/interaction/Media Plan generation、demand/failure-reserve
digest 和 decision hash 的 receipt。N+1 另证
`supply - active reservations - largest failure domain >= peak admitted demand`；
缺 failure-domain identity 直接拒绝。

Conference 首期固定为 `embedded_voice_media` 上最多 8 人的 per-participant N-1
audio mixer：每个 generation 有 `N*(N-1)` 个 directed mix contribution、`N` 个
participant jitter buffer 和 `N` 个 encode output，naive admission cost 为 O(N²)。
第 9 人在不扰动当前 mix 的前提下被拒绝；更大会议转给 LiveKit 或拒绝。member change
建立新 Binding Group generation，录音从 authoritative mix output 建独立 Edge。
质量门禁独立记录 MOS-LQO、PESQ/POLQA、loss、jitter、PLC、clipping、**loudness**、
level normalization、tandem transcode、clock drift、DTX/CNG transition 与 switch
gap；未实测的每项继续 `not_run`。

每个 quality metric 还要绑定唯一 method ID/source/digest、quality profile
（codec pair、ptime、security、transcode、network impairment、hardware 和 exact
Backend identity）、workload identity、signed threshold 和 immutable evidence。
当前所有 method source/digest、workload source/digest/current profile、
threshold source/digest 都为 null，threshold binding 为空；缺失或未签名只能
`not_run`/ineligible，且最终证据必须有 independent witness。

ordinary fast path 的 RFC 4733 只有一条采集/上报路径：
`rtpengine_rfc4733_event_notification` → RustPBX per-Leg canonical DTMF Authority。
该路径要求 `rtpengine_ordinary` 的 `dtmf_event_notification` capability 达到
`support=supported && verified=passed`。
它不解码 ordinary audio，也不建立另一个 read-only fork。notification 必须携带
`tenant_id/interaction_id/leg_id/ssrc/rtp_timestamp/event/duration/end_bit/
provider_event_sequence`，按全部字段组成的 key 去重，P99 report budget 为 50 ms。
丢失或歧义时禁止业务副作用，只能 query/reconcile，不能退化为 decode-all。
SIP INFO、in-band detector 与 LiveKit data/control 也只是候选输入，最终统一进入一个
monotonic per-Leg sequence；handoff grace 中旧 generation 不得产生 DTMF 副作用。

该 notification 运输合同固定为
`rtpengine_authenticated_event_notification`，使用 mutual TLS 加 HMAC payload
signature，并绑定 Backend instance、Binding Group generation、tenant、
interaction、Leg。队列最多 1,024 个、单 event 4,096 bytes、delivery deadline
50 ms；overflow 冻结业务副作用并 query exact Leg。`event_sequence` 由 per-Leg
durable CAS 分配且先持久化再产生业务 effect；duplicate replay 原 receipt，不产生
第二 effect，gap 先冻结再 query/reconcile。receipt 绑定 event ID/sequence、
payload hash、Backend identity digest 与 receive time；同 identity 不同 hash 冲突
fail closed。Backend query 未验证前，该路径不具备业务副作用资格。

任何终止 SRTP 的 Backend 必须覆盖 key memory lifetime、zeroize、core-dump policy、
rekey、ROC/replay、日志脱敏和 crash evidence。KMS/HSM 管理长期身份/包装密钥，不要求
每个临时 DTLS-SRTP session key 直接来自 KMS。native/unsafe slice 必须分别审计 ABI、
allocator ownership、thread safety、CPU feature、ASan/UBSan 或等价工具和 abort
behavior；无法证明 co-resident 安全时不得进入统一进程生产路径。

安全响应必须持续摄取带 digest 的已签名 RustSec、OSV、GitHub Security Advisory 与
vendor advisory snapshot；critical/high/medium/low 的 triage SLA 分别为
4/24/72/168 小时，remediation SLA 分别为 24/168/720/2160 小时。修复优先 upstream
backport 后 cherry-pick；不得不维护 local fork 时必须 bounded，并记录 owner、
expiry 和 rebase。逾期要禁用受影响 capability，或记录 time-bounded exception；
受影响 slice 必须重新资格化。生产环境关闭 core dump；唯一允许的 crash artifact 是
不含 key、SDP 或 media 的 redacted minidump，禁止上传 unredacted crash artifact。

WebRTC wire state 仍由 LiveKit 独占，但 OPC 的 generation contract 必须完整约束它：
协商后的 DTLS setup role 与 exact fingerprint hash/value 绑定一个 Wire Transport
Bundle generation，认证 fingerprint 后才可派生 SRTP；role 或 fingerprint 改变必须
建立新 generation。ICE ufrag/password 同样绑定 generation，consent freshness
过期立即停止输出；ICE restart 使用新 ufrag/password 和新 generation。BUNDLE 必须
协商 RTCP mux 并绑定 generation，BUNDLE group/MID demux 遇到 unknown 或 duplicate
MID 时拒绝；payload type 绑定 Leg/binding revision，security context 绑定
Bundle/transport generation。

RTPengine 的 userspace 与 kernel execution profile 必须独立签署，不得继承结果。
两者各自绑定 source/binary/config/capability-set digest 与 hardware/NIC driver/
Cell identity；kernel profile 还绑定 exact kernel-module identity。当前所有 digest、
hardware/Cell identity 和结果均为 null/`not_run`，`production_eligible=false`。
userspace 证据不能授权 kernel packet path，kernel 证据也不能反向授权 userspace。

### 1.6 Voice/SIP/PSTN ↔ LiveKit 双向切换

双向切换采用现有 `RustPBX ↔ livekit-sip ↔ LiveKit` 路径，不引入 rvoip WebRTC
runtime，也不把 LiveKit SIP 提升为第二 PBX。Authority 固定为：

| 事实 | 唯一 Authority |
| --- | --- |
| Call/Leg、Business Dialog、路由、计费/录音决策、Logical Media Graph | RustPBX/iveKit |
| Room、WebRTC Participant/Track、ICE/DTLS/SRTP、SFU route | LiveKit |
| Voice↔LiveKit logical bridge、correlation、generation/attempt、command/receipt、handoff decision 与 tombstone | OPC Bridge Coordinator store |
| Media Plan、directed Edge assignment、Edge generation 与 writer fence | Media Engine Facade |
| SIP participant/provider state | LiveKit SIP executor receipt/query |
| root RecordingManifest、source segment chains、retention、evidence | Region recording plane |
| rating 和最终客户账单 | OPC/iveKit billing |

一次切换保持同一 `interaction_id` 和业务 `CallId`，并建立显式
`bridge_id/bridge_generation`、两条反向 directed Media Edge、owner epoch、command
sequence、writer fence、participant/provider receipt 和 terminal cleanup receipt。
`VoiceLiveKitBridge` 是执行绑定/receipt，不是第二个 Call、CDR、Room、
RecordingManifest 或 billing Authority。

Bridge Coordinator 使用持久、幂等的
`prepare → commit | abort`、`query`、`reconcile` 状态机，覆盖 participant
create/terminate/delete、超时 unknown、webhook 乱序/重放、crash 和 orphan cleanup。
每条 directed Edge generation 只能有一个 writer；一个 `billing_key/rating_session`
覆盖整个 interaction，SIP leg duration 与 LiveKit participant minutes 只是可对账的
usage fact。每个逻辑录音 role 只有一个 capture owner，切换前中后必须在同一 root
RecordingManifest 下以 source segment chains 保持 lineage、consent 和 retention
连续。

同一业务 Call 必须支持 1..32 个完整
`V2L_ACTIVE → L2V_ACTIVE` alternating round trip；资格场景执行全部 32 个。每次
switch 都创建新的 bridge、Edge 和必要的 Binding Group generation，禁止复活已 revoke
generation。相反方向并发 command 以 bridge head
`(revision, owner_epoch, state)` CAS 仲裁：exactly one winner 可写 durable handoff
decision 并调用 Provider；loser fail closed，只能 query/reconcile winner，不能创建
participant、申请 port、打开 writer 或产生 billing/recording/DTMF side effect。
相同 idempotency key/hash replay 原 decision/receipt，同 key 不同 hash 冲突拒绝。

Bridge command token 是强类型 generation-scoped capability。identity 固定
`tenant_id/interaction_id/bridge_id/bridge_generation/operation_id/
idempotency_key/issued_at/expires_at/key_id`，以 pinned issuer identity 验证非对称
签名，并要求 tenant/interaction/bridge/generation/operation/key 全量匹配。有效期用
checked comparison 且 `now < expires_at`；prepare 前过期不得创建 command 或 resource，
active generation 的 token 过期只阻止新 command，不得改动已 commit generation。
identity mismatch fail closed；同 identity/hash replay 同 receipt，同 identity
不同 hash 冲突。该合同当前 `not_run`、production-ineligible。

Cancel identity 固定
`tenant_id/interaction_id/bridge_id/bridge_generation/command_id/
idempotency_key/command_hash`，以 generation 内单调 `command_sequence` 排序，并在 ACK
前持久化 cancel tombstone。prepare ACK 前 cancel 只能 abort/release 且不得产生
writer；apply 后 receipt 前 cancel 必须 query exact generation 并收敛到 terminal。
terminal tombstone 禁止 recreate；duplicate replay 同 cancel receipt，同 identity
不同 hash 冲突；late provider success 不能覆盖 cancel，必须 freeze 并清理 exact
generation。该合同当前 `not_run`、production-ineligible。

Webhook 必须验证签名和 pinned provider identity，并绑定
`tenant_id/interaction_id/bridge_id/bridge_generation/provider_id/
provider_event_id/provider_sequence/event_type/receipt_digest/payload_hash`。
ordering scope 是 tenant/interaction/bridge generation，reorder window 上限 128；
receipt 必须先持久化再产生业务 effect。同 identity/hash replay 原 receipt 且无第二
effect，同 identity 不同 hash 冲突；窗口内有界重排，越界则 freeze、query/reconcile；
forged event 无业务 effect，terminal tombstone 阻止 nonterminal replay/recreate。
该合同当前 `not_run`、production-ineligible。

往返期间不得单调增长：business Call、immutable Voice CDR、rating session 和每个
recording role 的 root manifest 各保持一个；每个 role 同时最多一个 active LiveKit
participant，port pair 和 Backend allocation 只按 active generation 有界，每条 Edge
generation 只有一个 writer。最终 teardown 必须证明 participants、port pairs、
Backend allocations、writers、pending commands 和 unreconciled receipts 全部为零。

32-round-trip 资格测试使用确定的 generation resource model：唯一 active generation
的 `participants/port_pairs/backend_allocations/writers` 分别为 `1/1/1/1`，
`pending_commands/unreconciled_receipts` 为 `0/0`；每个非 active generation 必须先
进入显式 terminal set，且上述六项全部为零。跨全部 generation，
Call/CDR/billing session/root RecordingManifest 仍分别为 `1/1/1/1`。CAS loser、
cancelled command、expired/mismatched token 和 forged webhook 都不得创建 writer
或资源；final cleanup 可重复执行且仍保持全 generation 零资源。该模型是待执行的
qualification target，不是当前已验证结果。

机器资格必须逐条运行且不得继承：

- scenario vectors：`same_call_32_round_trip_v2l_l2v`、
  `concurrent_head_cas_single_winner`、`terminal_zero_resource_leak`、
  `cancel_before_prepare_ack`、`cancel_after_apply_before_receipt`、
  `token_expiry_before_prepare`、`token_expiry_during_active`、
  `webhook_duplicate_reordered_replayed_forged`；
- property vectors：`every_switch_allocates_new_generation`、
  `cas_loser_never_emits_media`、`one_call_cdr_rating_and_root_manifest`、
  `terminal_cleanup_is_idempotent`、`cancel_terminal_prevents_recreate`、
  `token_scope_matches_exact_generation`、
  `webhook_requires_exact_identity_and_receipt_digest`；
- fault vectors：`timeout_before_apply`、`timeout_after_apply`、
  `coordinator_crash_after_decision`、`livekit_sip_unavailable`、
  `sfu_disconnect`、`webhook_loss_duplicate_and_reorder`、`token_expiry`、
  `store_head_cas_conflict`、`cleanup_retry_and_dead_letter`。

全部 8/7/9 个 vector 当前均为 `not_run`、`production_eligible=false`，任一 vector
通过都不能替代另一 vector 或另一切换方向。

首期如果 LiveKit SIP 不能提供 packet-level `prepared_blocked` 与 zero-output revoke
ACK，必须采用可测量的 break-before-make，记录 switch gap/loss/reorder/duplicate，
不得宣称 seamless 或 zero-loss。候选 busy/reject/cancel/pre-commit failure 时旧端
保持不变；成功离开 LiveKit 后 ordinary Call 回到 RTPengine fast path。

该路径必须使用独立 `VOICE-LIVEKIT-BRIDGE-V1` workload/profile，冻结方向比例、bridge
CPS、participant/track、codec/security/transcode、recording、switch rate、
LiveKit SIP/SFU/RTPengine identity、硬件和 fault schedule。任何排除了 optional bridge
的 Cell/MIX 或 ordinary RTP 证据均不得外推给它。

## 2. 两个项目的边界

### 2.1 OPC/iveKit 提供的能力

OPC/iveKit 当前不是原始 RustPBX。它已经围绕固定 RustPBX、rsipstack 和 rustrtc 源码
形成维护分支，并补齐：

- Call/Leg/Business Dialog Authority；
- owner epoch、command sequence、idempotency、prepare/commit；
- signed route snapshot、Cell placement 和 capacity admission；
- reciprocal dual-leg shadow、takeover、recovery capsule；
- RTPengine offer/answer/update/delete 与 Wire SDP 管理；
- dual-leg CDR、Region durable receipt、terminal repair；
- IVR、播放、收号、SIP INFO、barge-in 和 durable terminal event；
- 录音、AI tap、Provider 和对象存储的故障隔离；
- `media-control.v1` 的 owner-fenced command/reconcile 语义（Current HTTP transport
  不作为 Target 进程边界）；
- 不可变源码、补丁、镜像、配置、证据和容量声明体系。

这些是整合必须保留的外部合同，不因采用 rvoip 而弱化。

### 2.2 rvoip 提供的能力

固定审计源码：

| 项目 | 值 |
| --- | --- |
| Repository | `https://github.com/eisenzopf/rvoip` |
| Commit | `4ced02b7f6e73041c848f1765dc2bcf7588796f0` |
| Tree | `74dabd314841d99e1a87dbdaca6050fc4e8ed923` |
| Archive SHA-256 | `16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e` |
| Workspace version | `0.3.2` |
| MSRV | Rust `1.88` |
| Publishable crates | `44`；固定源码树中约 `46` 个 workspace crate |

rvoip 的主要可用资产包括：

- `rvoip-sip-core`：SIP/SDP parser、serializer、类型、header、URI、校验和 builder；
- `rvoip-sip-dialog`：已合并 Transaction layer 的 Protocol Dialog 与事务状态机；
- `rvoip-sip-transport`：UDP、TCP、TLS、WS、RFC 3263 resolver 等 Transport；
- `rvoip-sip-registrar` 与认证/身份扩展：REGISTER mechanics、Digest、AKA 等；
- `rvoip-sip`：Endpoint、StreamPeer、CallbackPeer、SessionHandle 等高层协议 façade；
- `rvoip-rtp-core`：RTP/RTCP packet、SRTP、jitter、demux、UDP benchmark；
- `media-core` 与 `codec-core`：有界媒体方法、G.711，以及一个 `G729/8000` wire
  identity 下的纯 Rust G729A/G729AB internal modes；
- RFC、compatibility、topology、security、fuzz、SIPp、Criterion 和 immutable evidence；
- Provider traits、vCon、STIR/SHAKEN、SCIM 和企业身份扩展。

源码存在不等于 Production Eligibility。rvoip 自身矩阵仍把 PRACK、部分订阅、
mTLS、WS/WSS、IPv6、carrier topology、WebRTC、复杂媒体和 24 小时 endurance 中的
若干项目标记为 Partial、Post-beta、Unsupported 或 Not audited。

### 2.3 三个媒体名词的事实状态

| 名称 | 是否现成 | 本方案中的真实含义 |
| --- | --- | --- |
| `voice-media-rs` | **是本仓库已经存在并持续开发的 Rust crate/module**，不是另一个可直接采购或下载的成熟上游产品 | 现有 codec/RTP/worker/IVR/HTTP 代码是 Current；Target 是把 library/worker 内核嵌入 Unified RustPBX Process |
| RTPengine | **是成熟的外部开源媒体服务/数据面** | `CARRIER-CELL-V1` 的长期默认 ordinary RTP/RTCP/SRTP Backend |
| Rust-native fast path | **目前不是现成服务** | 只是未来候选 Backend 的架构插槽和资格轨道；需要自研或从 rvoip 等项目吸收低层 primitive，并以 RTPengine 为同硬件性能/功能下限 |

因此不能把 “Rust-native fast path” 当作已经可部署的第三方服务，也不能把
`voice-media-rs` 当前 standalone HTTP binary 误认为首期生产必须独立部署的服务。

### 2.4 为什么上游没有天然合并，以及 OPC 何时才会更好

RustPBX 和 rvoip 的现状不是“作者不知道可以合并”，而是产品目标、兼容范围、发布节奏
和维护预算不同：

- RustPBX 优先交付 PBX 产品外壳、既有 API、路由、队列、录音和较小依赖面；
- rvoip 优先建设宽泛、模块化的 Rust 通信框架，覆盖的协议与实验面更大，但各模块生产
  成熟度不一致；
- 两边都必须保留自己可独立发布的 domain model 和高层 API，因此上游不可能天然采用
  OPC 的 owner fencing、Cell placement、CDR、Media Plan 和 VOS-EQ 约束；
- “同为 Rust”只降低进程内组合成本，不自动消除状态机重叠、分配、锁、缓存局部性、
  feature closure、错误语义和维护成本。

所以“融合后超过任一上游”是需要逐 Module 证明的工程假设，不是架构口号。每次吸收都
必须同时通过 correctness、互通、复杂度、allocation/lock、P99、同硬件吞吐、故障隔离、
依赖闭包和长期维护门禁；没有证据就保留当前实现。高层模型不融合，低层实现只在稳定
Seam 后竞争，获胜实现进入主路径，失败实现删除。这样才能获得两边优点，而不是把两套
复杂度相加。

## 3. 统一领域语言

整合方案必须使用仓库根目录 [`CONTEXT.md`](../../CONTEXT.md) 的术语。特别是：

| 容易混淆的词 | 本文规范含义 |
| --- | --- |
| Business Dialog | RustPBX 持久、owner-fenced、可恢复的业务对话事实 |
| Protocol Dialog | RFC 3261 的 Call-ID/tag/route-set/CSeq 协议状态 |
| Protocol Transaction | SIP 请求、响应、计时器、重传和终止状态 |
| Protocol Session | 协议 Adapter 内的临时执行上下文，不是业务 Call |
| Logical Media Graph | RustPBX 决定的媒体连接意图 |
| Media Plan | Facade 编译出的有版本 Media Edge 集合及 Backend assignment |
| Media Edge | 从一个 Media Endpoint 到另一个 Endpoint 的有向执行单元 |
| Backend Binding Group | 一个 Backend 原生 session/transport allocation 的物理生命周期单元，可承载多条 Edge |
| Wire Transport Bundle | Binding Group 共享的端口、有效 SDP、ICE/DTLS/SRTP、SSRC/key 与 reservation facts |
| Wire Media Binding | 已 commit Edge 对 Binding Group/Transport Bundle 的逻辑映射与 writer fence |
| Processing Session | `voice-media-rs` 内需要解码的有界媒体状态 |

文档、代码、指标和测试中禁止用裸 `Session` 或裸 `Dialog` 同时指代上述不同对象。

## 4. 目标架构

```text
                         OPC / iveKit Control Plane
                policy, tenant, route, billing, audit, admission
                                      |
                                      v
                              Kamailio SIP Edge
                  auth / rate-limit / routing / NAT edge / SBC
                                      |
                                      v
                  +---------------------------------------+
                  | Unified RustPBX Process               |
                  |                                       |
                  | RustPBX product shell + Call Core     |
                  | Call / Leg / Business Dialog Authority|
                  | owner / recovery / CDR / IVR / route |
                  |                   |                   |
                  |          SipFoundation Interface      |
                  |                   |                   |
                  |       in-process rvoip Adapter         |
                  | parser / transaction / Protocol Dialog|
                  | transport / DNS / auth                |
                  |                                       |
                  |          Media Engine Facade          |
                  | compile/commit/reconcile Media Plan |
                  |                   |                   |
                  |     embedded voice-media-rs library  |
                  | codec / DSP / IVR / mix / AI workers |
                  +-------------------+-------------------+
                                      |
                        bounded direct Rust adapters
                                      |
                                      v
                         RTPengine ordinary fast path
                       Wire SDP / ports / RTP/RTCP/SRTP
```

这张图表达的是调用与依赖方向，不表示所有 RTP 包串行经过每一层：

- 普通 G.711 relay 不进入 `voice-media-rs`；
- 浏览器 WebRTC 继续由 LiveKit/Coturn 负责；
- 录音、ASR、TTS、质检和对象存储不进入 SIP/RTP 热路径；
- RustPBX 与 rvoip Adapter 是一个可执行进程、共享 control runtime，不存在内部 RPC；
- `media-control.v1` 的命令语义继续作为 Facade 合同；RTPengine 使用外部 control
  Adapter，首期 `voice-media-rs` 使用进程内 Rust Adapter，不走 HTTP/gRPC/RPC；
- 一个 Call 的 Business Dialog 与 Protocol Dialog 状态固定在同一 Unified RustPBX
  owner；ordinary Edge 可由同 Cell 的 RTPengine 执行，decode-required Edge 在本
  Unified RustPBX Process 的隔离 worker shards 中执行。

### 4.1 唯一生产基线与两个非生产资格身份

| 身份 | 形态 | 允许用途 | 明确禁止 |
| --- | --- | --- | --- |
| `CARRIER-CELL-V1` | Unified RustPBX Process（内嵌 rvoip SIP slice 与 `voice-media-rs`）+ RTPengine | 唯一生产部署、VOS-EQ 与 100K 证据签署 | 不得在未 supersede 本 ADR 时改变 Authority 或首期进程边界 |
| `UNIFIED-STANDALONE-V1` | 无 RTPengine 的本地/隔离运行拓扑 | 开发、诊断、互通、benchmark、故障复现 | 不得作为生产基线，不得外推 Carrier 容量 |
| `RUST-NATIVE-FAST-PATH-CANDIDATE` | 同硬件候选 Backend 资格轨道 | correctness、性能、隔离、长稳和 2/4/8 对照 | 不得成为第二套 Authority/Profile；未通过时不得接生产 Edge |

三者使用相同 RustPBX/rvoip SIP source identity、Call Core、业务 API 和事件合同，但只有
`CARRIER-CELL-V1` 是 Deployment Profile。`UNIFIED-STANDALONE-V1` 是测试拓扑；
`RUST-NATIVE-FAST-PATH-CANDIDATE` 是 Backend qualification identity。候选通过全部
门禁后，也只是在 `CARRIER-CELL-V1` 内成为可选的 ordinary Edge Backend；RTPengine
继续是默认、正式且长期支持的性能基线，不设强制淘汰期限。

仓库 Helm 中沿用的 `deploymentProfiles.core/ai/observability/benchmark` 是
Component Bundle Overlay 配置名，不是本节的语音 Deployment Profile。AI 或
observability overlay 即使标记 production-eligible，也不得改变 `CARRIER-CELL-V1`
的进程边界、Authority、Edge writer 或默认 RTPengine Backend。

### 4.2 “统一”的精确定义

| 必须统一 | 不要求物理合并 |
| --- | --- |
| 一个 RustPBX 产品主干 | Kamailio Edge |
| 一个 Call/Leg/Business Dialog 模型 | selected Carrier Fast Path ordinary relay |
| 一个进程内 SIP foundation Adapter | RTPengine ordinary data plane |
| 一个 Logical Media Graph Authority | recording/upload/evidence workers |
| 一个 Media Plan Authority | RTPengine 外部数据面 |
| 一个 Media Engine Facade | LiveKit/Coturn WebRTC |
| 一套 external codec identity/negotiation registry（G.729 仅 `G729/8000`） | 独立 generator 与观测后端 |

因此，用户提出的“一个 Cargo Workspace、一个可执行进程、一个呼叫状态模型”被采纳为
RustPBX+rvoip SIP/Call/首期 decode-required media 整合约束；“一个媒体引擎”被规范为
一个 Facade、一个 external codec identity/negotiation registry、一个 Media Plan
Authority 和每条有向 Edge 一个 active writer。G729A/G729AB 只进入内部
processing/quality/capacity mode registry，不建立外部 codec identity。媒体 worker
与 control runtime 必须有独立 shard、CPU budget 和有界队列；同进程不等于同线程。
RTPengine 保持外部专用 ordinary data plane。

## 5. Authority 矩阵

| 事实 | 唯一 Authority | rvoip 的角色 |
| --- | --- | --- |
| SIP Edge、入口限流、拓扑隐藏、Cell 分发 | Kamailio | 提供测试与协议库，不接管 Edge |
| 用户、租户、业务策略、计费规则 | OPC/iveKit | 无 |
| Call、Leg、Business Dialog | RustPBX | 提供协议事件，不保存业务最终事实 |
| owner epoch、route revision、command sequence | RustPBX/iveKit owner contract | 携带并校验，不自行生成业务 Authority |
| Protocol Transaction | 当前 rsipstack；迁移后 rvoip Adapter | 目标实现候选 |
| Protocol Dialog | 当前 rsipstack；迁移后 rvoip Adapter | 目标实现候选 |
| 公网入站 REGISTER responder 与 location binding | Kamailio | 只提供测试与可选 mechanics |
| outbound trunk/Standalone REGISTER Transaction | 当前选定 `SipFoundation` Adapter | rvoip 是目标实现候选 |
| 租户身份、credential 事实和 placement | OPC identity | rvoip 只通过最小 credential port 读取 |
| Logical Media Graph | RustPBX | 不接管 |
| Media Plan、Media Edge 与 Backend assignment | RustPBX Media Engine Facade | 只实现被选中的内部 primitive |
| committed Edge writer fence | RustPBX Media Engine Facade | Backend 必须校验，不得自行转移 |
| Backend reservation receipt | 对应 Edge Backend，经 Facade 记账/reconcile | rvoip 不单独持有 |
| `CARRIER-CELL-V1` ordinary Wire Media Binding | RTPengine | 正式长期 Backend，不启动第二 relay |
| 候选 ordinary Wire Media Binding | 已获资格的 Rust-native Fast Path Backend | 同一 `CARRIER-CELL-V1` 下逐 Edge 选择，不创建新 Profile |
| 诊断拓扑 ordinary Wire Media Binding | Media Engine Facade 选定的 Embedded Backend | 仅非生产验证 |
| decode-required Edge Wire Media Binding | 进程内 `voice-media-rs` Backend | 可替换内部 packet/session/codec 实现 |
| Processing Session | Unified RustPBX 内嵌 `voice-media-rs` | 不通过 HTTP/gRPC 成为第二服务 |
| Room、WebRTC Participant/Track、ICE/DTLS/SRTP、SFU route | LiveKit/Coturn | rvoip/RustPBX 不接管 |
| Voice↔LiveKit logical bridge、generation/attempt、command/receipt、handoff decision 与 tombstone | OPC Bridge Coordinator store；Edge/writer decision 仍归 Media Engine Facade | 不创建第二 Call/Room/CDR/媒体 Authority |
| `VOICE-LIVEKIT-BRIDGE-V1` admission、profile 与 evidence finalization | iveKit capacity ledger/finalizer | 不继承 ordinary RTP、LiveKit-only 或 bridge-excluded 证据 |
| root RecordingManifest、source segment chains、retention、legal hold | Region recording plane | 只吸收接口语义 |
| durable CDR 与 terminal repair | RustPBX + Region convergence | 不接管 |
| IM | Tinode | 不接管 |
| vCon | OPC export/exchange adapter | 不成为 durable session Authority |

任何设计如果让同一行出现两个可写 Authority，必须拒绝或提交新的 superseding ADR。
同一 REGISTER request 必须由 deployment profile 和 route 预先选定唯一 responder；
Kamailio 与 `SipFoundation` 不得同时响应或写同一 binding。

## 6. 核心 Seam 与深模块设计

### 6.1 外部 Seam：`SipFoundation`

RustPBX 只依赖一个深模块 `SipFoundation`。其 Interface 必须保持小而稳定，隐藏 parser、
Transaction、Protocol Dialog、Transport、timer、DNS、认证重试和连接管理。

概念 Interface：

```rust
trait SipFoundation {
    fn start(
        &self,
        config: SipFoundationConfig,
        events: Arc<dyn SipFoundationEventSink>,
    ) -> Result<Arc<dyn SipFoundationHandle>, SipFoundationError>;
}

trait SipFoundationHandle {
    async fn prepare_effect(&self, command: SipProtocolCommand)
        -> Result<PreparedProtocolEffect, SipFoundationError>;
    async fn commit_send(
        &self,
        identity: ProtocolEffectIdentity,
        fence: OwnerFence,
    ) -> Result<ProtocolEffectReceipt, SipFoundationError>;
    async fn query_effect(&self, identity: ProtocolEffectIdentity)
        -> Result<ProtocolEffectReceipt, SipFoundationError>;
    async fn reconcile_effect(&self, identity: ProtocolEffectIdentity)
        -> Result<ProtocolEffectReceipt, SipFoundationError>;
    async fn snapshot(&self, dialog: ProtocolDialogKey)
        -> Result<ProtocolDialogSnapshot, SipFoundationError>;
    async fn restore(&self, snapshot: ProtocolDialogSnapshot, fence: OwnerFence)
        -> Result<RestoreReceipt, SipFoundationError>;
    async fn drain(&self, deadline: Instant) -> DrainResult;
}
```

这只是设计级形状，不是立即冻结的 Rust 签名。正式签名前必须做 interface design review。
必须保留的语义：

- 命令携带稳定 command ID、owner epoch、sequence 和 payload hash；
- stale owner、sequence gap、conflict、unknown outcome 和 replay 明确区分；
- `prepare_effect` 只生成规范化 bytes、Protocol Transaction/Protocol Dialog delta
  和 effect hash，
  不发包、不启动可见副作用；
- 对 18x/2xx、NOTIFY、mid-dialog request 和其他会改变外部状态的 effect，RustPBX
  必须先提交对应 Business Dialog/durable shadow，再调用 fenced `commit_send`；
- `commit_send` 以 effect identity 幂等；timeout/unknown 必须 query/reconcile，不能
  用新 identity 猜测重发；
- Transaction 自动重传只能重放已提交 effect 的相同 bytes/hash；不得绕过 owner
  fence、durable state 或产生第二份业务副作用；
- 自动 ACK/CANCEL/错误响应必须在 Interface 的 effect policy 中显式分类和测试，
  Adapter 不得隐藏未登记的网络输出；
- Protocol Dialog snapshot 不包含租户密钥、业务 CDR 或媒体 Authority；
- `restore` 只能恢复协议状态，Business Dialog Authority 仍由 RustPBX takeover 流程授予；
- Transport 和 Transaction 的内部重试有硬上限；
- 任何队列、timer、connection、pending transaction 和 dialog table 有硬上限；
- `drain` 只停止新 Protocol Session，旧 Call 按原 runtime identity 完成。

### 6.2 两个 Adapter

该 Seam 只有在存在两个真实 Adapter 后才成立：

1. `RsipstackFoundationAdapter`：包装当前 RustPBX/rsipstack 行为，形成迁移基线；
2. `RvoipFoundationAdapter`：使用固定 rvoip source slice 实现相同 Interface。

迁移完成且旧 Adapter 的 active Call/Protocol Session、unknown effect 和 repair
delta 全部归零、rollback window 到期后，才可删除旧 Adapter 及其只验证内部实现的
测试；普通 drain timeout 不强制 BYE/CANCEL，也不授权删除，但不得永久保留双栈。

### 6.3 内部 Seam

`RvoipFoundationAdapter` 内部可有四个私有 Seam，但不得暴露给业务调用者：

| 内部 Module | rvoip 候选 | 责任 |
| --- | --- | --- |
| Message Codec | `rvoip-sip-core` | SIP/SDP parse、serialize、typed header、URI、limits |
| Transaction Runtime | `rvoip-sip-dialog::transaction` | request/response matching、timer、retransmit、CANCEL/ACK |
| Protocol Dialog Runtime | `rvoip-sip-dialog` | tags、route set、CSeq、early/confirmed/terminated |
| Transport Runtime | `rvoip-sip-transport` | UDP/TCP/TLS、connection、DNS、bounded ingress/egress |

高层 `rvoip-sip` 的 `SessionHandle`、Endpoint、StreamPeer 和 CallbackPeer 只可作为
测试与 Interface 语义参考，首期不形成生产依赖。任何未来直接依赖都必须由 superseding
ADR 证明其必要性、feature closure、Authority 不重叠和同硬件收益，不能借“代码现成”
绕过评审。

### 6.4 单 Cargo build graph 与源码布局

目标 RustPBX 构建单元包含一个可执行文件和一个受控 dependency graph。建议形态是：

```text
rustpbx-build-root/
├── Cargo.toml
├── Cargo.lock
├── apps/rustpbx/
├── crates/call-core/
├── crates/sip-foundation/
├── crates/sip-foundation-rsipstack/
├── crates/sip-foundation-rvoip/
├── crates/media-engine-facade/
└── vendor/rvoip/<source-slice-id>/
```

这是目标模块结构，不授权立即移动 OPC 仓库或重写已完成的 RustPBX patch queue。第一步
只在可重复 build context 中加入固定 commit 的最小 source slice 和 path dependency。
严禁：

- 把 rvoip 的 44 个可发布 crate 或整个 workspace 平铺进主 Workspace；
- 让 workspace dependency、feature 或 build script 隐式拉入 WebRTC、UCTP、MoQ、
  identity store、PBX server 或 media server；
- 在 lockfile 外使用 floating git branch 或宽松 path 内容；
- 暴露 `rsipstack`、`rvoip_*`、`rustrtc` 或 `audio-codec` 类型到 Call Core、Queue、
  Routing、Billing、API 或 Addon 的 public Interface。

每个纳入 crate 都必须有 dependency closure、feature closure、license、
`THIRD_PARTY_NOTICES`、逐文件 provenance、SBOM 和 reproducible build 记录。整合完成、
active/unknown/repair 归零且 rollback window 到期后删除旧 Adapter 和只为旧实现存在的
依赖；不能把双栈永久留在 Workspace。

### 6.5 统一 ID 与 Call Core

先统一语义，再统一代码目录。Call Core 至少使用互不混淆的强类型：

```rust
struct CallId(/* existing stable representation */);
struct LegId(/* existing stable representation */);
struct ProtocolDialogKey(/* SIP Call-ID + tags */);
struct MediaPlanId(/* Call-scoped stable identity */);
struct MediaEdgeId(/* stable directed-edge identity */);
struct BackendBindingGroupId(/* stable physical backend-allocation identity */);
struct MediaPlanRevision(/* monotonically increasing revision */);
struct MediaBindingRevision(/* monotonically increasing revision */);
struct BindingGroupGeneration(/* immutable physical membership generation */);
struct BindingGroupRevision(/* monotonically increasing physical revision */);
struct FlowSelector(/* O(1) backend-native flow lookup key */);
struct MediaWriterFence(/* owner epoch + edge generation */);
struct ProcessingSessionId(/* executor identity */);
struct RecordingId(/* evidence identity */);
```

本文不擅自把现有 ID 表示改成 ULID；表示迁移必须另有兼容方案。固定关系是：

- SIP `Call-ID` 不等于 `CallId`；
- 一个 Call 可因 fork、Queue、转接产生多条 Leg 和多个 Protocol Dialog；
- 一条 Leg 在某一时刻绑定一个活动 Protocol Dialog；
- RustPBX Call Core 拥有 Business Dialog 和 Logical Media Graph；
- Media Engine Facade 拥有由 Logical Media Graph 编译出的 Media Plan；
- 双向通话由两条相反方向的 Media Edge 表示，不存在“一个双向 Edge”；
- 多条 Edge 可以映射到一个 Backend Binding Group，但该 group 不能取得 Edge writer
  Authority；group 只管理共享物理资源和原子生命周期；
- SIP Foundation 不访问业务数据库、计费或 RecordingManifest；
- 媒体 Backend 不决定路由、租户政策或业务终态。

可采用 call coordinator/actor，但每 Call 状态、mailbox、timer 和 replay window 必须有硬
上限。是否“每通 Call 一个 Tokio task”由同硬件 profile 决定，不作为架构前提；任何 RTP
packet 都不得经过 Call actor 或通用业务事件总线。

### 6.6 Media Engine Facade

业务层只依赖一个深 Interface，设计级形状如下：

```rust
trait MediaEngineFacade {
    async fn prepare(&self, command: MediaCommand, fence: OwnerFence)
        -> Result<MediaReceipt, MediaError>;
    async fn commit(&self, command: MediaCommand, fence: OwnerFence)
        -> Result<MediaReceipt, MediaError>;
    async fn abort(&self, command: MediaCommand, fence: OwnerFence)
        -> Result<MediaReceipt, MediaError>;
    async fn revoke(&self, command: MediaCommand, fence: OwnerFence)
        -> Result<MediaReceipt, MediaError>;
    async fn update(&self, command: MediaCommand, fence: OwnerFence)
        -> Result<MediaReceipt, MediaError>;
    async fn delete(&self, command: MediaCommand, fence: OwnerFence)
        -> Result<MediaReceipt, MediaError>;
    async fn query(&self, identity: MediaCommandIdentity)
        -> Result<MediaReceipt, MediaError>;
    async fn reconcile(&self, identity: MediaCommandIdentity)
        -> Result<MediaReceipt, MediaError>;
}
```

简单的 `create_session/bridge/start_recording` trait 方向正确，但不足以承载当前
owner epoch、command sequence、payload hash、prepare/commit、unknown outcome、
idempotent replay 和 durable reconciliation 合同。Facade 必须先把 Logical Media
Graph 编译成下列概念模型，再调用 Backend：

```text
MediaPlan {
  plan_id, call_id, plan_revision, owner_fence,
  policy_revision, attempt_revision, final_admission_receipt,
  lifecycle: candidate | commit_pending | committed | compensated_failed,
  edges[], binding_groups[]
}

MediaEdge {
  edge_id, source_endpoint, destination_endpoint, mode,
  backend_identity, backend_source_identity,
  edge_generation, plan_revision, binding_revision,
  binding_group_id, binding_group_generation, flow_selector, writer_fence,
  lifecycle: prepared_blocked | active | revoked_receive_only | released
}

BackendBindingGroup {
  binding_group_id, binding_group_generation, binding_group_revision,
  backend_identity, backend_instance_id, backend_native_session_key,
  membership_digest,
  members[] {
    edge_id, edge_generation, binding_revision, flow_selector, writer_fence
  },
  admission_receipt_id, lifecycle, output_gate, prepared_lease_deadline
}

WireTransportBundle {
  binding_group_id, binding_group_generation, bundle_revision,
  backend_native_session_key, bundle_digest, effective_sdp_views[],
  flow_bindings[] {
    flow_selector, participant/tag/label, mline_index/mid,
    local_tuple, remote_tuple, ssrc_state, key_reference
  },
  ICE_state, DTLS_state, SRTP_state, live_member_refcount,
  tx_counter_watermark, prepared_at, committed_at, revoked_at, released_at
}

WireMediaBinding {
  edge_id, edge_generation, binding_revision,
  binding_group_id, binding_group_generation, flow_selector,
  writer_fence, lifecycle
}
```

Facade 内部只有两类首期生产 Adapter：

- `RtpengineBackend`：外部控制 Adapter，执行 ordinary RTP/RTCP/SRTP Edge；
- `EmbeddedVoiceMediaBackend`：进程内直接 Rust Adapter，执行 decode-required Edge。

`EmbeddedLegacyBackend`、`EmbeddedRvoipBackend` 和 Rust-native fast-path 只允许存在于
测试、shadow 或资格轨道，不能成为并列 Authority。必须满足：

- Backend 选择粒度是每条有向 Media Edge，不是整个 Call、Leg 或双向 session；
- 物理 allocation/release 粒度是 Backend Binding Group；RTPengine 的
  call/tag/media-section、双向端口、有效 SDP、ICE/DTLS/SRTP 和共享 SSRC/key state
  只存在于一份 Wire Transport Bundle 中；
- 每个 `(edge_id, edge_generation, binding_revision)` 必须恰好映射一个
  `(binding_group_id, binding_group_generation, flow_selector)`；反向 member set 和
  `membership_digest` 必须完全一致，不得有 orphan；
- Edge→group 是显式、可对账的多对一映射；每条 Edge 的 writer fence 独立，但 group
  mutation 必须携带完整成员集合、group generation/revision、member-fence digest 和
  Backend native identity；
- group membership 在同一 generation 内不可变；增加成员、改变 Backend/端口/writer
  必须建立新 generation。需要独立生命周期的 Edge 必须拆 group，除非 Backend 已证明
  member-flow 级 fence/revoke；
- packet path 使用预编译 `flow_selector -> WireMediaBinding` 的 `O(1)` 查找，不扫描
  group members；raw SRTP key 不进入 durable model，只持久化 key reference、state
  与 digest；
- 每条 committed Edge 同一时刻只有一个 active writer；
- read-only observer/tap 必须建成独立 Edge；它可消费源流，但不能复用原 Edge 的
  writer fence 或改写原 Edge 的 Wire Media Binding；
- Backend 在 Edge prepare 时固定；prepared Backend 可分配资源但不得发包，只有持有
  committed writer fence 才可输出；
- active Edge 迁移必须创建新 Edge generation/Binding，经必要的 re-INVITE/新媒体
  session 和 commit handoff barrier 后才能切 outbound writer；old/new outbound writer
  永不同时 active；
- Backend failure 不允许无证据热切换。unknown outcome 必须 query/reconcile；
- Edge release 独立推进其逻辑生命周期并从 group 解除成员关系；共享端口、SDP、
  ICE/DTLS、SSRC/key、buffer、timer 和 reservation 只在 group live member
  refcount 为零时释放一次，禁止 per-edge 双重释放；whole-group replacement 必须
  创建新 generation，不能绕过旧 generation 的 zero-live-ref 条件；
- migration 通过后删除失败或被替代的同职责 production implementation。

典型混合媒体图不是“一条 Edge 两个 Backend”，而是：

```text
caller --Edge E1/RTPengine--> callee
caller --Edge E2/embedded voice-media, read-only--> AI/QA
```

需要串联处理时也必须拆开：

```text
caller --E1/RTPengine--> processing ingress
processing ingress --E2/embedded voice-media--> processing egress
processing egress --E3/RTPengine--> callee
```

这种表示使 writer、故障、容量和证据能按 Edge 对账，同时让共享端口、SDP、ICE/DTLS、
SSRC/key 和 release 能按 Backend Binding Group 对账；两种粒度不得互相冒充。

#### 6.6.1 编译、预留与最终提交顺序

资源种类取决于候选 Backend 和 Binding Group，不能在编译前用一个抽象“媒体配额”
完成最终预留。固定顺序为：

1. RustPBX 校验 policy 并生成 draft Logical Media Graph；
2. Facade 以 `O(E)` 编译 candidate Media Plan 与 Edge；`E` 有硬上限；
3. 根据 Edge 的独立生命周期和 Backend 原子能力形成 Backend Binding Group；每 Call
   group 数、每 group member 数和 flow selector 表都有硬上限；
4. 对 candidate plan/group demand 执行 Backend-specific capacity quote/reserve，取得带 TTL、
   source/config identity 和 group demand 的 reservation；
5. reservation 全部成功后原子 prepare group 为 `prepared_blocked`；任何
   failure/unknown 进入幂等补偿或
   query/reconcile，不创建第二份物理资源；
6. 持久化 candidate bindings/bundles 和本次 attempt/handoff intent，但不把 candidate
   冒充 committed plan；
7. initial admission：在一次 durable transaction 中同时冻结 immutable final plan、
   Edge↔group/flow mapping、reservation、Wire Transport Bundle、唯一
   `commit_decision` 和 `commit_pending`；按确定顺序 commit groups，所有必需 ACK
   返回后标为 `committed`，最后才暴露 initial effective SDP；
8. active migration 是唯一 SDP 可见性例外：old generation 仍是唯一 writer、new group
   仍为 `prepared_blocked` 时可把 candidate SDP 发给远端。远端接受事实持久化后，在
   一次 durable transaction 中冻结 final plan 与 handoff `commit_decision`；随后先
   revoke old writer 并取得 zero-output ACK，再 commit new writer，记录 writer gap，
   取得 ACK 后 plan 才进入 `committed`；
9. commit decision 前失败：按 group 逆序 abort，再取消 reservation；reserve retry
   必须创建新 candidate attempt/revision，prepare 后不得静默重编译或换 Backend；
10. commit decision 后 partial commit：decision 不可改写为 abort；先 query/reconcile
    exact decision。若终局不可达，按 decision 中预声明的 compensation policy
    revoke/release 已 active group，plan 进入 `compensated_failed`；
11. Edge detach 与 group atomic release 分开记录，物理资源只在 zero live refs 时释放。

#### 6.6.2 RTPengine 可执行的 Binding lifecycle

当前五补丁 RTPengine fork 只提供 command fencing、drain/metrics 和 durable replay，
尚未证明下列原子 lifecycle；因此该能力是 `not_run` 的生产阻塞项，不能靠 Adapter
内连续发 `offer` 再 `block media` 冒充原子 prepare：

| 操作 | 必须满足的 Backend 语义 | 成功证据 |
| --- | --- | --- |
| `prepare` | 按 `(group_id, group_generation)` 原子分配 `prepared_blocked` group；创建时 output gate 已关闭，禁止 `offer` 后再 `block media` 冒充原子操作 | prepare ACK 到 commit ACK 前 outbound datagram delta 为 0；重复 prepare 返回同 bundle digest/端口 |
| `commit` | durable commit decision 已存在且 group/member-fence digest 完全匹配时，才启用指定 outbound writer | 单一 writer 首包、TX watermark 与 receipt |
| `abort` | 只对从未 commit 的 `prepared_blocked` group 幂等释放 | 无端口/session/ICE/key reservation 泄漏 |
| `revoke` | 同时关闭 userspace/kernel output gate，清空在途发送后才 ACK，并进入 `revoked_receive_only` | revoke ACK 后旧 group outbound delta 永久为 0 |
| `query` | 纯只读返回 group lifecycle/output gate、bundle digest、last command identity/hash/receipt 和 TX watermark | 事实可与 WAL/durable decision 对账 |
| `reconcile` | Facade 按既有 durable decision 精确重放；不是创建新 allocation 的上游命令 | applied/unseen/conflict 均不产生第二 group/writer |

唯一合法核心状态转换是：

```text
absent --prepare--> prepared_blocked --commit--> active
prepared_blocked --abort--> released
active --revoke--> revoked_receive_only
revoked_receive_only --grace expired + zero live refs--> released
mutation timeout/disconnect --> unknown --query/reconcile exact decision--> known state
```

`active -> abort`、`prepared_blocked -> emit`、`unknown -> new allocation` 和已 revoke
generation 再次 active 均非法。unknown 期间冻结 group 及全部 member Edge mutation；
在旧 writer 是否仍存在未确认前，禁止激活新 writer。改变端口、Backend、membership
或 writer 的 update 必须创建新 group generation。

当前 source-lock 中的五个 patch 包括 durable replay，但都没有实现上述 packet output
gate 和 group-generation lifecycle。若上游 NG 协议不能原子表达这些语义，Goal 2
必须在受控 fork 中新增并固定未来 patch
`rtpengine-ivekit-atomic-binding-lifecycle-v1`，再生成新的 patch-set identity。该 patch
当前状态只能是 `not_present`，其运行验证是 `not_run`，不得列入现有 patch-set 冒充已实现。
当前 `ivekit_guard_entry` 仍以 SIP call-id 为主索引，无法区分同一 Call-ID 下的多个
branch/group；未来 patch 必须改为以 `(binding_group_id, binding_group_generation)`
为幂等/查询键，并绑定 native call-id/tag/flow selector 与完整 member-fence digest。
该变更存在、编译或单测通过仍不够；真实 packet gate 必须证明 prepare→commit 前
0 包、revoke ACK 后旧 writer 0 包、abort 无泄漏、userspace/kernel 两种模式一致，以及
unknown outcome 可恢复。

#### 6.6.3 非原子远端切换的边界

SIP re-INVITE 与远端 UA 的 RTP tuple 切换不是分布式原子事务。本设计只承诺 outbound
single-writer，不承诺 active migration 零丢包：

- 默认 rollout 是 **new-call selection + old-call drain**；普通升级不得主动迁移活跃
  ordinary Edge；
- 必须迁移时，先 prepare new group 为 `prepared_blocked` 并持久化 candidate bundle
  与 handoff intent；暴露 candidate SDP 时 old 仍是唯一 active writer，new 只能
  receive/count/drop；
- re-INVITE/UPDATE 或远端 readiness 失败时，commit decision 前 abort new，old 不变；
- 远端接受后形成不可变 handoff commit decision，先 revoke old 并等待 zero-output ACK，
  再 commit new；两者 outbound 不重叠，但会记录不可避免的 writer gap；
- old 进入 profile-bounded `revoked_receive_only` grace 时只能 authenticate/count/drop，
  绝不能 forward、产生 DTMF、写 recording 或触发 AI business side effect；
- inbound grace 必须 bounded，按 SSRC/sequence/source tuple 去重，且只允许一个
  DTMF/recording/AI business side-effect path；
- signed profile 必须给出有限的 `inbound_grace_ms`、`handoff_rto_ms`、
  `max_writer_gap_ms` 和 `max_migration_loss_ratio`，并记录 late-old、first-new、
  re-INVITE RTO、切换中断、loss/reorder/duplicate；超门槛即 migration fail，
  不得声称 zero-loss；
- old revoke ACK 后不得重新启用旧 generation；new commit 若 unknown 只能 reconcile，
  终局失败必须如实记录为中断/`compensated_failed`；grace 到期且 zero live refs 后才
  原子释放旧 Binding Group。

## 7. SIP 协议底座整合范围

### 7.1 Parser、Serializer 与 SDP

必须整合和验证：

- strict 与 bounded-lenient parsing；
- request/response line、65+ typed headers、unknown header；
- SIP/SIPS/TEL URI、IPv4/IPv6 syntax、percent encoding；
- Content-Length、multipart、PIDF/sipfrag；
- SDP common fields、multi-m-line、codec mapping、offer/answer；
- canonical serialization、round-trip 和 malformed input；
- per-message bytes、header count、line length、nesting 和 allocation ceiling；
- trace redaction，禁止 auth、token、identity、SDES key、ICE secret 泄漏。

parser 产出的 SDP 只是 RustPBX Logical Media Graph 和 Media Engine Facade 的结构化
输入。ordinary Edge 的 effective Wire SDP 默认由 RTPengine 拥有；只有通过全部资格
门禁的 Rust-native Backend 才可在同一 `CARRIER-CELL-V1` 内接管新 Edge。
decode-required Edge 的 effective binding 由进程内 `EmbeddedVoiceMediaBackend`
拥有。

### 7.2 Protocol Transaction

必须覆盖：

- INVITE client/server transaction；
- non-INVITE transaction；
- ACK for non-2xx 与 ACK for 2xx 的不同语义；
- CANCEL 与原 INVITE correlation；
- Timer A/B/D/E/F/G/H/I/J/K；
- 100 Trying、provisional、final response、forked branch；
- UDP retransmission 与 TCP/TLS reliable transport；
- 401/407、stale nonce、auth retry；
- overload 时 `503 + Retry-After`；
- process restart、unknown outcome 和 bounded recovery。

Transaction Runtime 不能直接更新 Business Dialog、CDR、route revision 或媒体资源。

### 7.3 Protocol Dialog

必须覆盖：

- Call-ID、local/remote tag 和 route set；
- early、confirmed、terminated；
- local/remote CSeq 单调性；
- Contact、Record-Route、strict/loose routing；
- re-INVITE、UPDATE、glare/491；
- BYE、INFO、OPTIONS、MESSAGE；
- REFER/NOTIFY、Replaces；
- PRACK/100rel；
- Session Timer；
- SUBSCRIBE/NOTIFY 和事件包；
- snapshot/restore 与 RustPBX reciprocal dual-leg capsule 的映射。

Protocol Dialog 可以由 rvoip 实现，但 RustPBX 的 Business Dialog pair、owner epoch 和
takeover 仍是外层 Authority。

### 7.4 Transport 与 DNS

接入顺序为 UDP、TCP、TLS，再评估 WS；WSS outbound 在固定 rvoip 审计版本中仍是
明确 non-claim，不能提前启用。

Transport 必须具备：

- listener/connection/socket/queue 硬上限；
- per-IP、per-tenant 和 global admission；
- TCP/TLS framing、Content-Length、slowloris deadline；
- TLS server/client、SNI、certificate、mTLS gate；
- RFC 3263 NAPTR/SRV/A/AAAA failover；
- IPv4/IPv6 明确 profile；
- connection reuse、idle timeout、drain；
- no per-message task explosion；
- low-cardinality metrics；
- Kamailio upstream identity 和 trusted-network 策略。

### 7.5 REGISTER、认证与身份

rvoip 可提供 REGISTER Transaction、Digest、Bearer、AKA、nonce 和 credential Provider
方法，但：

- Kamailio 继续承担公网 Registrar 和 Edge 防护；
- OPC identity/tenant store 继续承担用户、租户和 credential reference Authority；
- rvoip Adapter 只接收最小 credential port，不直接访问业务数据库；
- Basic auth 必须显式 opt-in 且仅在安全 Transport；
- STIR/SHAKEN 是可插拔签名/验证 Adapter，不代表认证或运营商认证已完成；
- SCIM 位于企业身份控制面，不进入 SIP/RTP 热路径。

### 7.6 OPC-owned Protocol Session façade

`SipProtocolCommand`、`SipFoundationEvent` 和 Protocol Dialog snapshot 是 OPC 自己
定义的 anti-corruption layer。rvoip 的 Incoming/Outgoing Call、`SessionHandle`、
Endpoint、Coordinator、Orchestrator、Conversation 和 Participant 不进入生产依赖，
也不成为 OPC 的 façade 或持久模型。它们只可作为测试/API 语义参考。

这条边界防止 rvoip 高层 call/media lifecycle 与 RustPBX Call Core 形成第二套状态机；
任何未来例外必须由 superseding ADR 单独证明，而不是在 Adapter 内隐式引入。

## 8. RTP 与媒体整合范围

### 8.1 按 Media Edge 用途互斥的执行路径

| Edge 用途 | 唯一生产执行器 | rvoip 使用方式 |
| --- | --- | --- |
| ordinary relay default/reference | RTPengine | 正式长期 fast path、同硬件 oracle 与默认生产 Backend；不引入 rvoip runtime |
| ordinary relay Rust-native candidate | 仅限已通过资格门禁的 Rust Native Fast Path Backend | packet/session/transport 可逐项采用；通过后仍属于 `CARRIER-CELL-V1` |
| decode-required processing | Unified RustPBX 内嵌 `voice-media-rs` | packet/session/codec 模块可逐项替换 |
| standalone diagnostics | Unified RustPBX 内嵌 diagnostic Backend | 仅测试/互通/benchmark，不可外推生产 |
| browser WebRTC/video | LiveKit/Coturn | 不接入 rvoip WebRTC runtime |

同一 Media Edge 在同一时刻只能绑定一个 active writer。一个 Call 可以同时包含由
RTPengine 执行的 ordinary Edge 和由 embedded `voice-media-rs` 执行的 AI/录音/转码
Edge。切换必须通过 Facade 的 owner-fenced prepare/commit 和 handoff barrier，不能由
rvoip Protocol Session runtime 或 Backend 自行重路由。

#### 8.1.1 重叠能力的首期唯一归属

| 能力 | 首期默认执行器 | 禁止的重复处理 |
| --- | --- | --- |
| RTP/RTCP/SRTP pass-through、NAT anchoring、IPv4/IPv6、ICE bridge | RTPengine | `voice-media-rs` 再做第二层 relay、NAT 或 Wire SDP rewrite |
| ordinary encoded packet fork | RTPengine 独立 fork Edge | embedded worker 再复制同一 fork |
| decoded/dual-track recording、PCM quality/AI tap | embedded `voice-media-rs` 独立 Edge | RTPengine 与 Rust 同时声明 decoded recording Authority |
| G.711↔G.729、G.711↔Opus、其他必须解码的转码 | embedded `voice-media-rs` | 同一 processing chain 再启用 RTPengine transcoder |
| IVR 动态播放、gather、barge-in | embedded `voice-media-rs` | 两边同时生成音频或消费同一 DTMF event |
| conference/mixer | embedded `voice-media-rs` | RTPengine 与 Rust 形成两级无声明 mixer |
| DTMF 透明转发 | RTPengine ordinary Edge | `voice-media-rs` 重复转换 |
| 业务 DTMF 检测、生成、IVR 状态推进 | RustPBX `DtmfEventAuthority`；媒体 source 由 assigned Backend 上报 | RTPengine 命令、SIP INFO 和 embedded detector 分别产生业务副作用 |
| T.38/PCM 转换 | Goal 4 独立资格化后固定单一 Backend | 未签署前用配置在两边随机切换 |

一条处理链只能有一层 jitter/reorder、一层 resample 和一个 codec state owner；后续能力
迁移必须以 ADR、同硬件/同输入证据和新 Edge binding revision 完成，不能用配置让两套
实现同时成为生产权威。

业务 DTMF 必须按 Leg 固定一个 `DtmfEventAuthority`，而不是按输入方式建立三套状态机：

- source 可为 negotiated RFC 4733、SIP INFO 或 in-band detector；透明 RTP 转发本身不
  产生业务事件；
- 优先级固定为 negotiated RFC 4733 → explicitly accepted SIP INFO → in-band；
  SIP INFO 未协商/未允许时 fail closed，in-band 只在更高优先级 source 缺失时启用；
- 每个原始输入先归一化为 `{leg, digit, start, end, duration, source, source_sequence}`，
  再由 Leg-local bounded dedup window 生成单调 `canonical_sequence`；
- RFC 4733 repeated/end packets、SIP INFO retry 和同时检测到的 in-band tone 必须去重；
  end/duration 乱序按固定上限重排，超窗输入丢弃并计数；
- 每个 canonical event 最多推进一次 IVR/gather、录音 marker、Webhook 或其他业务副作用；
  replay 返回原 receipt，不再次执行；
- outbound DTMF injection 也是 owner-fenced command，选择一个 wire mechanism 后记录
  receipt，禁止 RTPengine 与 embedded worker 同时注入。

### 8.2 `rvoip-rtp-core` 可吸收项

- RTP/RTCP packet parse/serialize；
- sequence/timestamp wrap；
- SSRC、source validation 和 demux；
- jitter/reorder、duplicate、late packet；
- RFC 4733；
- SRTP primitive 和独立 benchmark；
- packet/session/transport 分层；
- owned bytes、reusable scratch、fixed buffer 方法。

采用方式：

1. 在 Processing Session 内先做同输入 A/B；
2. 每次只选择一个 parser/session implementation 产生输出；
3. 达到 correctness、allocation、P99 和 maintenance gate 后替换旧实现；
4. 删除被替换的 rustrtc/local 重复实现；
5. ordinary relay 不受影响。

第一轮不得删除 RustPBX 现有 `rustpbx-media`、rustrtc 或 audio-codec 路径。它们先作为
测试基线；rvoip slice 作为 processing-only internal implementation 对相同输入做离线或
read-only shadow。生产 `EmbeddedVoiceMediaBackend` 对每条 Edge 仍只有一个输出实现。
通过全部门禁后删除被替换的同职责重复实现。

Rust Native Fast Path 不是把当前 rvoip generic RTP server 原样上线。它是 Media Engine
Facade 下的深 Backend，必须具备：

- `recvmmsg/sendmmsg` 或经证明更优的批量 I/O、`SO_REUSEPORT`、固定 shard；
- CPU affinity、NUMA-local memory、NIC queue/RSS/RPS/XPS 和 busy-poll profile；
- pooled owned bytes、reusable serialization scratch、无 per-packet task；
- 与所竞争/对照的 `CARRIER-CELL-V1` workload 等价的完整 feature matrix：RTP/RTCP、
  IPv4/IPv6、NAT/source validation、SDP rewrite、SDES/DTLS-SRTP、
  ICE-aware/ICE-unaware bridging、QoS/TOS、DTMF、media/recording fork、T.38、
  timeout/statistics，以及该 Profile 实际启用的全部功能；
- kernel path 不可用时的受控 userspace fallback，并以独立容量身份签署；
- ordinary pass-through 零 decode/encode；
- bounded session/socket/packet/queue/timer budgets；
- drain、owner fence、query/reconcile 和低基数 telemetry；
- 相同硬件上不劣于 RTPengine 的 PPS、CPU/packet、P99、loss 和 sessions/core；
- 2/4/8 节点近线性、24 小时 endurance 和故障注入。

如果用户态 Rust 路径达不到门槛，可评估以 Rust/Aya 管理的 eBPF/XDP/AF_XDP 或其他
内核旁路，但该实现仍必须受同一 Rust control plane、source identity、SBOM 和 evidence
合同约束。任何内核加速都不能以绕过 correctness、security 或可回滚性换吞吐。

### 8.3 不采用的 RTP 形态

- 不部署 rvoip generic RTP server；
- 不让 generic rvoip runtime 独立分配 ordinary Wire Media 端口；端口只归该 Edge
  选定的单一 Backend；
- 不让 rvoip 与 RTPengine 同时改写 Wire SDP；
- 不把 async Mutex、spawn-on-drop、per-packet task 或无界 channel 带入热路径；
- 不把 QUIC、UCTP、WebTransport 或 MoQ 带入生产语音数据面。

## 9. Media Engine、FreeSWITCH 与 rvoip 的关系

rvoip 的 SIP/RTP foundation 不等于完整媒体服务器。以下能力继续由 OPC 媒体体系负责：

- Codec、resample、PLC、DSP；
- IVR playback/gather/barge-in；
- conference/mix；
- T.38；
- recording、spool、manifest、retention、legal hold；
- ASR、TTS、AI audio 和质量分析；
- codec-pair capacity 与 failure isolation。

`rustpbx-media` 是诊断拓扑的迁移基线，不是不可替换的内部实现。它的 bridge、mixer、
recorder、transcoder 和 RTP track 能力按相同 Interface 测量；rvoip 中表现更好的 RTP、
jitter、codec、resampler 或 mixer Module 可逐项迁入，最终删除重复实现。生产基线由
Media Engine Facade 把 ordinary Edge 分配给 RTPengine，把 decode-required Edge 直接
分配给进程内 `voice-media-rs` worker shards；两类执行资源分别设 CPU、内存、队列和
admission budget，避免转码拖死 SIP control runtime。

FreeSWITCH 不进入默认主链。只有会议、T.38、特殊运营商媒体或某个 codec 的同硬件门禁
证明 embedded processing Backend 长期不达标时，才可作为专用媒体 Adapter 另行评审。它不能
替换 RustPBX Business Authority，也不能让所有普通呼叫强制经过完整媒体服务器。

## 10. G.729 强制实现方案

### 10.1 Source Slice

G.729 源码固定为：

- rvoip commit `4ced02b7f6e73041c848f1765dc2bcf7588796f0`；
- `crates/media/codec-core/src/codecs/g729/` 下 136 个 Rust 文件；
- repository、commit、tree、archive hash 和逐文件 tuple 全部固定；
- 目标为独立 codec crate/Module，不依赖 rvoip SIP、RTP、Session、WebRTC 或 runtime。

### 10.2 一个 wire identity 与两个强制 internal modes

| Internal mode | Annex B | External SDP/RTP identity | 独立验证/容量 |
| --- | --- | --- | --- |
| G729A | false | `G729/8000` | speech encode/decode、`annexb=no` |
| G729AB | true | `G729/8000` | VAD、DTX、CNG、SID/no-data、`annexb=yes` |

共同合同：

- external codec registry 中只有一个 `G729/8000` entry；mode 由 Annex B 协商和
  internal processing policy 选择；
- 8 kHz；
- 10 ms frame；
- 80 PCM samples；
- RTP encoding 固定为 `G729/8000`；支持静态 PT 18，也支持 SDP 明确映射的动态 PT
  96–127，任何 remap 都固定在 Leg/Binding revision；
- 10/20/30/40/50/60 ms packetization；内部 codec Interface 仍只处理 10 ms frame；
- RTP timestamp 正确推进；
- G.729/G.729A speech frame 为 10 octets；Annex B SID frame 为 2 octets；一个 RTP
  payload 为零个或多个 speech frame，末尾最多一个 SID frame；silence suppression 的
  no-data 是“没有 RTP payload/packet”，不能伪造成零长度 speech frame；
- erasure/burst loss/PLC；
- G729A/G729AB 分别与 PCMU、PCMA、Opus 双向转换；
- 每个 mode、direction、ptime 独立 capacity identity；
- 独立 reference vector、peer interop、质量和性能证据。

### 10.3 接入形态

```text
voice-media-rs Codec Interface
             |
      IveKit G729 Adapter
             |
   exact rvoip G729 source crate
```

一帧 codec Interface 固定 10 ms。10/20/30/40/50/60 ms RTP packet 由 iveKit Adapter
合并/拆分 1/2/3/4/5/6 个 speech frame；其中 50 ms 必须明确证明为五个 10 ms、
每个 10-octet 的 speech frame，并验证对应 RTP timestamp/sequence 行为。Adapter
还要正确处理 payload 末尾最多一个 2-octet SID；不得修改 136 个固定上游源文件来
迎合现有 20 ms pipeline。

`annexb` offer/answer 固定按 RFC 7261：

- 参数缺失等价于 `annexb=yes`；
- 任一侧明确 `annexb=no`，协商结果为 `no`；
- G729A internal mode 必须生成/接受 `annexb=no` 且拒绝 SID；
- G729AB internal mode 允许 `yes`/缺失并验证 VAD/DTX/CNG/SID/no-data；
- asymmetric offer/answer、缺失参数、静态 PT 18 与动态 remap 都是独立互通用例。

### 10.4 法律与供应链边界

这里的“法律/专利”不是指 G.729 可以不做，也不是技术风险的代称，而是三个独立的
生产发布检查：

- **开源许可证**：保留
  [RustPBX](https://github.com/restsend/rustpbx/blob/main/LICENSE) /
  [rvoip](https://github.com/eisenzopf/rvoip/blob/main/LICENSE) 的 MIT notice；对分发的
  [RTPengine GPL-3.0-only](https://github.com/sipwise/rtpengine/blob/master/LICENSE)
  二进制和维护 fork 按
  [GPLv3 官方文本](https://www.gnu.org/licenses/gpl.en.html)处理对应源码、许可文本及
  修改说明义务；
- **codec 专利/权利**：源码许可证不自动授予算法专利权，需按实际部署国家、客户、
  分发方式和用途取得书面适用性结论；
- **供应链与来源**：固定源码、逐文件 provenance、SBOM、第三方 notice、漏洞和构建
  身份，确保最终启用的正是已评估对象。

这些检查必须形成可审计的 release decision；本文不自行给出任何地区的法律结论。

Revision 4 D0 合同冻结后，下列 U2 工程工作立即获准执行且只依赖 D0，不依赖 U1；
不等待另一轮人工批准或法律结论：

- exact source extraction；
- dependency closure；
- 编译、单元、参考向量和互通测试；
- codec-pair、packetization、Annex B、PLC；
- quality、allocation、latency 和 sessions/core benchmark。

下列状态必须等待外部结论和同源码身份供应链证据：

- production distribution；
- runtime enablement；
- Production Eligibility。

任何法律/专利事项不得被写成 `implementation_blocked`。正确状态是
`engineering_in_progress` 或 `engineering_passed`，同时 production gate 保持 `not_run`。

## 11. Provider、录音、vCon 与身份扩展

### 11.1 Provider semantics

吸收 rvoip `AsrProvider/AsrStream`、`TtsProvider/TtsPlayback`、`DialogManager` 和
`RecordingSink` 的依赖反转方向，但保留 iveKit：

- tenant、consent、quota、deadline、circuit、fallback；
- bounded input/output queue；
- partial/final transcript；
- cancelable playback；
- slow-consumer policy；
- owner/session/sequence fencing；
- trace redaction；
- realtime 与 offline quality separation。

### 11.2 Recording

`RecordingSink` 只能作为 capture Adapter 语义，不能替换：

- RecordingManifest；
- segment sequence/checksum；
- local spool 和 uploader；
- retention、legal hold；
- consent；
- Region durable evidence Authority。

### 11.3 vCon

vCon 只作为导出、交换和互操作格式。它不替代 Call、Business Dialog、CDR、
RecordingManifest 或审计事实。

### 11.4 STIR/SHAKEN 与 SCIM

- STIR/SHAKEN 进入 Goal 6，作为 signing/verifying Adapter；认证、证书运营和 carrier
  certification 另行签署；
- SCIM 进入 OPC 企业身份路线；不进入 SIP/RTP packet path；
- registrar credential Provider 可借鉴 rvoip，但 tenant/identity Authority 不迁移。

## 12. 不整合清单

以下内容明确不进入当前生产架构：

- rvoip PBX/B2BUA server 与 RustPBX 并行运行；
- rvoip SIP proxy 替换 Kamailio；
- rvoip-client 进入服务端核心；
- rvoip UnifiedCoordinator/Orchestrator 成为 Call Core；
- rvoip Conversation/Session/Participant 作为 OPC 业务模型；
- rvoip generic RTP transport runtime 作为普通 relay；
- rvoip Wire SDP 与 RTPengine 双写；
- rvoip WebRTC/DTLS/ICE/TURN 替换 LiveKit/Coturn；
- rvoip RecordingSink 替换证据平面；
- rvoip QUIC/UCTP/WebTransport/MoQ 进入语音生产数据面；
- 将 44 个可发布 crate 或整个 workspace 作为无裁剪顶层依赖；
- 用 rvoip 上游 2K/一小时结果宣称 OPC 容量；
- 用源码存在、编译通过或单元测试通过宣称 Production Eligibility。

## 13. 运行流程

### 13.1 入站 INVITE

```text
Kamailio receives INVITE
  -> route/admission hint
  -> SipFoundation parses and starts Protocol Transaction/Dialog
  -> RustPBX receives normalized protocol event
  -> RustPBX validates owner, route revision and policy
  -> RustPBX constructs Logical Media Graph
  -> Facade compiles Candidate Media Plan and directed Media Edges in O(E)
  -> Facade forms immutable-generation Backend Binding Groups
  -> Backend-specific admission reserves exact group/flow demand
  -> each group atomically prepares as prepared_blocked
  -> Facade persists candidate bindings, Wire Transport Bundles and receipts
  -> SipFoundation prepares provisional/final protocol effect without sending
  -> RustPBX atomically persists immutable final plan + mappings + reservations
     + bundles + Business Dialog/durable shadow + unique commit decision
  -> Facade commits groups in deterministic order
  -> all required ACKs make plan committed
  -> RustPBX fenced commit_send of the prepared effect
  -> SipFoundation first exposes exact committed initial SDP bytes and records receipt
```

失败语义：

- parser/transaction overload：明确 4xx/5xx，不能无界排队；
- owner/route stale：fail closed；
- media capacity exhausted：`503 + Retry-After`；
- commit decision 前失败：逆序 abort prepared group 并取消 reservation；
- commit decision 后 partial failure：decision 不变，query/reconcile；终局失败执行预声明
  compensation 并进入 `compensated_failed`，不能改写成 aborted；
- protocol send 返回 unknown：按 effect identity query/reconcile，不生成新 effect 猜测重发；
- rvoip Adapter 不写 CDR，不自行创建业务 Call。

### 13.2 Mid-dialog request

```text
SipFoundation matches Protocol Dialog/Transaction
  -> emits INFO/UPDATE/re-INVITE/REFER/BYE event
  -> RustPBX checks Business Dialog owner epoch and sequence
  -> compile new Candidate Media Plan / Edge and Binding Group generations
  -> reserve exact group demand; prepare new group as prepared_blocked
  -> persist candidate bundle and handoff intent
  -> when migration needs remote tuple change, expose candidate SDP while old remains sole writer
  -> persist remote acceptance, immutable final plan and handoff commit decision atomically
  -> revoke old writer and wait userspace/kernel zero-output ACK
  -> commit new writer; record writer gap
  -> old generation receives/counts/drops only during bounded grace
  -> detach logical Edge and release old group only at zero live refs
  -> SipFoundation prepares any remaining response/request effect without sending
  -> durable Business Dialog/shadow transition according to profile
  -> fenced commit_send
  -> SipFoundation records send receipt and Protocol Dialog snapshot
```

### 13.3 恢复

```text
new RustPBX owner claims Business Dialog pair
  -> validates recovery capsule and old owner fence
  -> restores/reconciles every Media Edge and Wire Media Binding
  -> grants new owner epoch
  -> asks SipFoundation to restore Protocol Dialog snapshots
  -> commits reciprocal pair before accepting mutations
```

Protocol restore 失败不能把 Business Dialog 标记为成功接管；既有媒体的真实状态必须如实
记录，不得把中断重命名为恢复成功。

## 14. 状态、并发与背压不变量

所有 rvoip-derived Module 必须满足：

1. pending Transaction、Protocol Dialog、connection、timer 和 DNS request 有硬上限；
2. 每个 Call、Leg、Business Dialog、Protocol Dialog 和 Processing Session 的状态有固定上限；
3. 无 per-packet/per-message unbounded task；
4. queue full 不触发无限等待者或隐式扩容；
5. control-path retry 有上限和抖动；durable repair 使用单一有界 worker/lease；
6. stale owner 只能 query，不能 mutate；
7. command replay 返回原 receipt，不重复产生媒体、DTMF、录音或 CDR 副作用；
8. metrics label 只使用固定 method、transport、profile、result、failure stage；
9. trace 不含原始号码、凭据、SDP key、音频、文本、URL 或 provider payload；
10. 远程数据库、broker、对象存储和 Provider 不进入 packet path。

Unified RustPBX Process 的 SIP、API、routing 和 Call control 共享一个 Tokio control
runtime；媒体 packet loop 使用固定数量的 native worker/shard，不用每包 Tokio task。
`CARRIER-CELL-V1` 中 control 与 embedded media 两类线程有独立 CPU budget、队列和
admission；RTPengine 进一步提供进程/节点故障域隔离。转码耗尽只能拒绝新的
decode-required Edge，不能拖死 SIP transaction 或 ordinary relay。

### 14.1 算法与热路径复杂度预算

任何实现 PR 必须说明受影响路径的时间/空间复杂度、上限和分配行为：

| 路径 | 允许复杂度 | 禁止 |
| --- | --- | --- |
| RTP/RTCP packet receive、demux、writer-fence check | expected `O(1)`，固定哈希/shard，steady-state 零或经证据最小分配 | 扫描 Call/Edge 全表、每包 task、全局锁、动态扩容 |
| SIP Transaction/Dialog lookup | expected `O(1)`，bounded table；timer wheel/heap 为 `O(1)` amortized 或 `O(log N)` bounded | 每消息 `O(active_calls)`、无界重传/定时器 |
| Backend selection | `O(E)` 编译 Media Plan，`E` 受每 Call Edge hard limit；单 Edge lookup `O(1)` | 每包重算策略、跨库/网络查询 |
| Media Plan update/handoff | `O(E)`，只在控制路径；按 Edge generation 幂等 | 在 packet loop 扫描图或同步 durable I/O |
| jitter/reorder | `O(log W)` 或更优，`W` 为固定小窗口 | 随通话时长增长的数据结构 |
| metrics/logging | `O(1)` 低基数计数，采样 trace | Call/phone/IP label、每包字符串构造 |

代码审查必须拒绝任何把 `E/W/queue/session/table` 上限留给运行时自然增长的实现。性能
门禁既看大 O，也看常数项、cache locality、原子竞争、syscall/batch、allocator 和 P99；
“Rust 编写”或“上游测过”都不能替代 OPC 同源码、同硬件证据。

### 14.2 按 Edge/Backend 分类的故障语义

“RustPBX owner 故障时已建立媒体继续”只适用于媒体 writer 位于外部 RTPengine 的
ordinary Edge，不能外推到同进程 embedded processing：

| 故障 | ordinary RTPengine Edge | embedded decode-required Edge | Call/mixed chain 结论 |
| --- | --- | --- | --- |
| Call control task/actor panic，process 存活 | `continue_degraded`，冻结 mutation 等待 reconcile | 未受影响 shard 可继续；受影响控制命令拒绝 | 按实际受影响 Edge |
| embedded media worker panic/restart | `continue` | `interrupt_visible`，只允许有证据的 bounded rebuild；必要时 re-INVITE | 若该 Edge 是 mandatory chain，Call 为 `interrupt_visible` |
| Unified RustPBX process abort/OOM/kill | RTPengine packet forwarding 可 `continue_degraded`，但 SIP/控制失去 owner | 全部 embedded Edge `interrupt_visible` | mixed Call 只要含 mandatory embedded Edge 即 `interrupt_visible` |
| RTPengine process/node loss | 对应 ordinary Edge `interrupt_visible` | 进程内 Edge 是否仍活跃单独记录 | 端到端路径断即 `interrupt_visible` |
| 可选 AI/质量 tap failure | 主 Edge `continue` | tap Edge `degraded/released` | 主 Call 可继续 |

一个 Call 的 overall outcome 由端到端 mandatory chain 推导，不能因为其中一条 RTPengine
Edge 仍收发包就把 G.729/IVR/transcode 中断记为“媒体继续”。每个 failure test 必须记录
Edge 类型、Backend identity、group identity、process exit reason、worker/shard、
rebuild/re-INVITE 结果和端到端 packet evidence。

同进程故障隔离的 Production Eligibility 不是布尔配置，必须在 co-resident profile 中
完成：worker panic containment、process abort、OOM/cgroup kill、allocator pressure、
cpuset/NUMA 隔离、Guaranteed QoS、watchdog、restart、SIP headroom 与 ordinary
RTPengine continuity。任何一项 `not_run` 都不能签署 production processing capacity。

## 15. 安全设计

### 15.1 输入安全

- SIP/SDP/RTP/RTCP/SRTP corpus 与 fuzz；
- bytes、headers、URI、multipart、SDP lines、attributes、nesting 硬上限；
- malformed input fail closed；
- CPU amplification 和 allocation ceiling；
- parser strict/lenient profile 明确，不允许公网入口无限 lenient；
- Content-Length、smuggling、duplicate header、UTF-8/binary body；
- TLS identity、trusted proxy header 和 source-IP provenance。

### 15.2 认证与秘密

- credential 通过 injected port 获取，不复制进 event 或 snapshot；
- nonce、qop、nc、stale retry 和 replay 矩阵；
- mTLS 只有完成证书校验和 trusted-header stripping 才可声明；
- trace redaction 覆盖 Authorization、Proxy-Authorization、Identity、SDES 和 ICE secret；
- evidence 和日志禁止 secret。

### 15.3 供应链

每个 Source Slice 必须记录：

- repository、exact commit、tree、archive URL/hash/bytes；
- selected file path/bytes/hash；
- Cargo.lock 与 dependency closure；
- license、third-party notices、修改说明；
- reproducible build、SBOM、vulnerability scan、provenance、signature；
- test binary、runtime config 和 evidence hash。

RustPBX 与 rvoip 顶层许可证均为 MIT，这允许修改和合并源码，但不等于“没有义务”：

- 保留两边版权与 MIT 许可文本；
- 复制并裁剪与选中 slice 相关的 rvoip `THIRD_PARTY_NOTICES.md` 条目；
- 对每个 transitive dependency 重新执行 license policy；
- MIT 许可不提供专利授权保证，也不替代 G.729 的适用地区/分发/使用场景评估；
- 上述 G.729 评估仍只阻塞生产分发、runtime enablement 和 Production Eligibility，
  不阻塞工程实现、编译和测试。

## 16. 性能设计

### 16.1 可归因 benchmark

必须把以下层分开，禁止一个 e2e 数字掩盖瓶颈：

| 层 | 指标 |
| --- | --- |
| SIP parse/serialize | msg/s、ns/msg、alloc/msg、malformed cost |
| Transaction | CPS、timer/retransmit、pending high-water、P99 |
| Protocol Dialog | create/lookup/update/terminate、memory/dialog |
| Transport | UDP/TCP/TLS CPS、connection count、queue、handshake cost |
| RTP packet | parse/serialize/demux/SRTP、PPS、alloc/packet |
| Processing Session | codec pair、ptime、quality、P99、sessions/core |
| End-to-end | setup P50/P95/P99、ASR、stuck state、CPU/RSS |

### 16.2 同硬件 A/B

rsipstack 与 rvoip 的比较必须使用：

- 同一物理/虚拟硬件与 CPU governor；
- 同一 Kamailio、RTPengine、RustPBX 业务逻辑；
- 同一 SDP、method mix、call duration、transport 和 security；
- 同一 independent generator；
- 至少三次有效重复和预定义 invalid-generator 规则；
- raw result、binary、commit、config、hardware hash。

只有对应 Module 在 correctness 和 maintenance gate 同时通过且性能不劣，才能替换。

### 16.3 横向扩展

- SIP Foundation 跟随 RustPBX Cell-local shard，不跨 Cell 共享活跃 Protocol Dialog；
- 每个 SIP/Call owner 节点运行相同 Unified RustPBX binary 和同一受控 rvoip slice；
- placement 只为新 Call 选择 Cell；
- active session 不靠 Redis/数据库搬迁；
- Carrier profile 的媒体 executor 可独立扩缩，但必须留在同一 Cell/Zone 拓扑合同内，并
  通过 Media Engine Facade reservation；
- 2/4/8 节点扩展效率分别签署；
- rvoip 上游 CPS 只作为 generator/harness 参考，不能转成 OPC claim。

### 16.4 “性能完美、功能完美”的工程判定

“完美”不能用主观形容词或一次峰值代替，必须同时满足：

| 维度 | 硬门禁 |
| --- | --- |
| 功能完整 | 本设计、Goal 4/6 和 VOS-EQ 必需项均有 pass evidence；缺项保持 `not_run`，不能删功能换性能 |
| 信令性能 | rvoip Adapter 在同硬件/同场景下 correctness 全过且 CPS、P99、CPU/RSS 不劣于届时获批的基线 |
| ordinary RTP | RTPengine 的 VOS-EQ 结果只有完成证据签署后才成为 `CARRIER-CELL-V1` 正式性能基线；当前仍为 `not_run/none`。Rust-native 候选必须在同硬件下 PPS、CPU/packet、P99、loss、session density 不劣于该基线 |
| 处理媒体 | 每 codec pair/ptime/direction 的质量、P99、sessions/core 和 allocation 分别通过 |
| Voice↔LiveKit | `V2L_NEW/L2V_NEW/V2L_ACTIVE/L2V_ACTIVE` 四条路径在独立 `VOICE-LIVEKIT-BRIDGE-V1` 中分别通过真实媒体、故障、录音/计费和容量门禁；路径间及 ordinary RTP/bridge-excluded profile 间不继承 evidence |
| 稳态内存 | 无随时长、重传、弱网或 peer failure 无界增长；所有 high-water 可解释 |
| 故障隔离 | codec/AI/recording/storage/control 故障不终止无关 SIP 或 ordinary relay |
| 横向扩展 | component 区段 marginal efficiency ≥90%，Cell/shared-data ≥95%，并签署 2/4/8 节点 |
| 长稳 | 24 小时 endurance、rolling upgrade、drain、rollback、owner takeover 无泄漏或持续 drop |
| 可维护性 | 唯一生产架构不分叉；每条 committed Media Edge 只有一个 fenced writer；SIP 与同职责 media internals 迁移后删除重复主实现 |

若 Rust-native Backend 任何一项不达标，状态只能是 `not_run/failed`，RTPengine 基线继续
作为长期正式 `CARRIER-CELL-V1` 服务；不得用“全 Rust”标签覆盖性能或功能回退。
达标后只能把该 source/binary/config identity 登记为
`RUST-NATIVE-FAST-PATH-CANDIDATE` 的 eligible Backend，并在同一
`CARRIER-CELL-V1` 中按新 Edge 灰度；不会自动废止 RTPengine，也不设强制迁移期限。

### 16.5 embedded processing 的两层性能证据

`voice-media-rs` 作为独立 binary 的 codec/packet-loop microbench 仍保留，用来定位算法、
allocation、cache 和 sessions/core 上限；但它不代表生产拓扑。生产签署必须另跑
co-resident Unified RustPBX profile：

- Primary SUT 是同一个 `unified-rustpbx` process/binary，不是远端 transcoder service；
- 同一节点同时承载 SIP Transaction/Dialog、Call Core、Facade 和 embedded media
  worker；RTPengine 仍在外部专用 fast-path 节点；
- 固定 32 physical cores 的 cpuset/NUMA/IRQ 计划，例如 control reserve、media shard
  ceiling 与 OS/IRQ reserve，总和严格等于可用核心；不得用 Kubernetes `1 CPU` 历史
  limit 运行此 profile；
- SIP CPS、setup P99、timer lag、control queue、allocator/arena、LLC/cache miss、
  NUMA remote access、media P99/loss 与 OOM/panic evidence 同时采集；
- production admission 同时保留 SIP/control headroom 和 codec-pair permits，不能让
  processing 把 control runtime 压到 SLO 之外；
- profile identity 必须固定 Media Plan compiler revision、Backend selector revision、
  Edge/backend mix、RTPengine identity、embedded source/binary/config 和 CPU topology；
  只要 Backend mix/selector 改变就生成新 profile/hash，禁止沿用全 RTPengine 结果；
- independent microbench 可以指导优化，但只有 co-resident profile 能签署
  `CARRIER-CELL-V1` processing safe capacity。

## 17. 测试与证据矩阵

### 17.1 测试层级

1. source identity 与 dependency closure；
2. parser/serializer unit + property + fuzz；
3. Transaction/Protocol Dialog deterministic timer tests；
4. Adapter contract tests；
5. snapshot/restore 与 owner fencing；
6. Kamailio/RustPBX/RTPengine integration；
7. SIPp、Asterisk、FreeSWITCH、baresip、WebPhone 和 carrier simulator interop；
8. real RTP、codec、weak network 和 quality；
9. overload、process kill、network loss、disk full、dependency outage；
10. same-hardware A/B、2h soak、24h endurance、2/4/8 node scaling；
11. SBOM、scan、sign、provenance 和 immutable finalizer。

### 17.2 SIP 必测能力

- INVITE、ACK、BYE、CANCEL、REGISTER、OPTIONS；
- re-INVITE、UPDATE、INFO；
- PRACK/100rel；
- Session Timer；
- REFER/NOTIFY、Replaces；
- SUBSCRIBE/NOTIFY、MWI、BLF；
- MESSAGE；PUBLISH 保持 parser-only，直到完整行为签署；
- 401/407、Digest variants、AKA Provider；
- RFC 3263 DNS failover；
- UDP/TCP/TLS、mTLS、WS/WSS non-claim；
- IPv4/IPv6；
- offerless/late offer、forking、491 glare；
- malformed、torture、fuzz、CPU/allocation abuse；
- Reason/Q.850、CDR/cause 和 trace redaction。

### 17.3 RTP/媒体必测能力

- RTP/RTCP parse、malformed、sequence/timestamp wrap；
- reorder、duplicate、late、loss、burst loss、jitter；
- RFC 4733 duration/retransmit/duplicate end；
- PCMU、PCMA、Opus；
- `G729/8000` external identity，以及 G729A/G729AB 两个 internal mode；
- SRTP profile；
- source change、one-way/no-media；
- processing overload 对 ordinary relay 零影响；
- recorder、Provider、storage、database outage。

### 17.4 非声明

以下项目在证据完成前保持 `not_run`：

- Production Eligibility；
- VOS5000 parity；
- 10K 单节点和 100K 平台容量；
- carrier certification；
- WSS outbound、IPv6、DTLS-SRTP、ICE/TURN；
- 24 小时 endurance；
- G.729 production distribution/runtime enablement。

## 18. 完整能力登记

机器可读的完整清单由
[`rvoip-capability-integration-v1.json`](../capacity/contracts/rvoip-capability-integration-v1.json)
负责，Schema 为
[`rvoip-capability-integration.schema.json`](../capacity/schemas/rvoip-capability-integration.schema.json)。

该矩阵必须覆盖且只允许以下处置：

- `existing_authority`：当前 Authority，rvoip 不接管；
- `direct_exact_source_candidate`：精确源码提取；
- `future_adapter`：未来 Adapter；
- `semantic_absorption` / `semantic_rewrite`：吸收语义或方法；
- `test_input_only` / `method_absorption`：测试或工程方法；
- `non_claim_evidence`：保留但不提升声明；
- `explicit_rejection`：明确不接入；
- `replacement_gate`：未来 Runtime Replacement 的硬门禁。

在进入实现前，矩阵必须新增显式条目并完成 Schema 锁定：

1. SIP Message Codec Adapter；
2. Transaction Runtime Adapter；
3. Protocol Dialog Runtime Adapter；
4. UDP/TCP/TLS Transport Adapter；
5. RFC 3263 DNS Adapter；
6. REGISTER protocol mechanics；
7. Digest/AKA auth Adapter；
8. OPC-owned Protocol Session façade semantics（高层 rvoip runtime 明确拒绝）；
9. Protocol Dialog snapshot/restore mapping；
10. shadow equivalence migration；
11. minimal dependency/source slice；
12. processing-only RTP packet/session Adapter；
13. Unified RustPBX single binary；
14. no RustPBX↔rvoip RPC；
15. curated Cargo build graph；
16. upstream type isolation；
17. Media Engine Facade 与 Media Plan Authority；
18. directed Media Edge identity/classification；
19. Edge Backend binding、binding revision 与 writer fence；
20. Backend handoff/drain/query/reconcile；
21. `CARRIER-CELL-V1` 唯一生产 deployment profile；
22. `UNIFIED-STANDALONE-V1` 非生产诊断 identity；
23. 历史 `RUST-NATIVE-CARRIER-V1` ID 的非 Profile 降级与候选 Backend 资格轨道；
24. RTPengine 长期默认 ordinary Edge Backend；
25. 首期进程内 `voice-media-rs` decode-required Edge Backend；
26. 高层 rvoip Endpoint/SessionHandle/Orchestrator 显式拒绝；
27. `RsipstackFoundationAdapter` baseline；
28. `RvoipFoundationAdapter` composite；
29. Rust-native ordinary RTP fast-path candidate；
30. Rust-native RTP/RTCP/SRTP/NAT/DTMF feature parity；
31. Rust-native same-hardware RTPengine performance gate；
32. Rust-native batch-I/O/kernel/NIC/NUMA profile；
33. Rust-native failure isolation；
34. Rust-native 24-hour endurance；
35. Rust-native 2/4/8-node scaling；
36. SIP effect prepare/durable-commit/commit-send fence；
37. SIP bounded state and overload；
38. SIP Cell canary and rollback；
39. live shadow non-interference budgets；
40. SIP foundation 2/4/8-node scaling。

现有能力不得因新增上述条目被删除、合并或静默改名。

## 19. 分阶段迁移

### Phase D0：文档与基线

交付：

- 本设计；
- ADR-CCAAS-7 更新；
- `CONTEXT.md`；
- 完整 capability matrix/schema；
- exact rvoip source identity；
- Unified RustPBX Process、无 RPC 和受控 Cargo build graph 合同；
- `CARRIER-CELL-V1` 唯一生产拓扑与 `UNIFIED-STANDALONE-V1` 非生产诊断身份；
- `RUST-NATIVE-FAST-PATH-CANDIDATE` Backend 对照身份，不建立第二生产拓扑；
- Media Plan、directed Media Edge、per-edge writer fence、Backend handoff 和
  upstream-type-isolation 合同；
- rsipstack/rvoip 同硬件 benchmark 规格；
- migration/rollback checklist。

退出条件：文档审查无 Critical/Important，所有历史能力仍可追踪。

#### Phase D0.1：开发前代码完整性冻结

Revision 4 D0 合同冻结即授权后续计划按门禁自动推进，不再等待第二次人工批准；修改
runtime 主路径前仍必须先完成：

1. 记录当前 branch/HEAD、上游 commit、patch queue 顺序和 dirty-worktree 归属；先把
   文档切片与已有 G.729/runtime 未提交改动分离，禁止混合提交；
2. 对 RustPBX patch queue、`voice-media-rs` library/binary、RTPengine Adapter 和
   rvoip Source Slice 建立逐文件 Current/Target/Keep/Replace/Delete 清单；
3. 在不改变行为的基线执行现有 Rust/TypeScript contract、compile、fmt、clippy 和
   controlled benchmark，任何既有失败都先登记，不能归咎于后续融合；
4. 每个实现 PR 只允许一个可回滚 vertical slice，必须列出 Authority 变化、状态迁移、
   时间/空间复杂度、allocation、lock/atomic、syscall、队列上限和 P99 影响；
5. 先 shadow/Adapter，再切单一主实现；同职责旧实现只有在新实现通过功能、故障和性能
   门禁后删除，任何阶段都不允许两个 production writer；
6. 每个 PR 由独立 review 检查语义回归、无界集合、全局锁、线性扫描、per-packet task、
   high-cardinality metrics 和隐式 fallback。

退出条件：可复现基线存在、工作树归属清楚、无未解释测试失败、首个 vertical slice 的
输入/输出/回滚和性能预算已签署。这个 Gate 的目的不是追求“每行都不动”，而是保证每行
改动都有明确的 Authority、复杂度和证据理由。

### Phase D1：G.729 独立切片

G.729 工程只依赖 Revision 4 D0，不依赖 SIP runtime/U1 迁移，直接按第 10 节实现。
任何法律/专利 gate 不阻塞工程。

退出条件：源码、编译、功能、互通、质量、性能证据分别记录；production gate 可继续
`not_run`。

### Phase D2：测试资产和 parser shadow

- 导入 RFC/compat/security/fuzz corpus；
- 建立 canonical message model；
- 先比较 SDP model，再比较完整 SIP message model；
- 同一只读输入分别交给 rsipstack 与 rvoip parser；
- 比较 parse result、error category、serialization、allocation 和 latency；
- shadow 结果不得生成网络输出或修改任何状态。
- live shadow 只对固定 allowlist/sample 生效，使用独立有界 queue、inflight、bytes、CPU
  budget 和 deadline；shadow 饱和或超时先丢 shadow，不得反压或延迟主 parser；
- shadow 只记录低基数 diff/drop/reason 和脱敏样本哈希，禁止原始号码、credential、
  body 或 SDP key 进入日志。

退出条件：预定义 corpus 无未解释 semantic diff，malformed input 有界。

### Phase D3：Message Codec 主路径

只替换 parser/serializer，Transaction/Dialog/Transport 仍由当前 Adapter 管理。

退出条件：全部 SIP matrix、性能、回滚和长稳通过；旧 parser 删除而非永久双跑。

### Phase D4：Transaction + Protocol Dialog + Transport Adapter

按 rvoip 的实际耦合，把 `sip-dialog::transaction`、`sip-dialog` 和 `sip-transport`
作为一个可复现 slice 验证。顺序为：

1. deterministic harness；
2. OPTIONS/REGISTER test profile；
3. INVITE client/server；
4. mid-dialog；
5.双腿 B2BUA legs；
6. snapshot/restore；
7. UDP、TCP、TLS；
8. 一 Cell 新 Call canary。

一个 Protocol Session 只能选择一个 Adapter。禁止双栈同时发送或 mutate。
Adapter 与 RustPBX Call Core 编译进同一个 Unified RustPBX binary，共用 control
runtime，无内部 RPC。这里替换的是 Protocol Transaction/Dialog/Transport
implementation，不替换 RustPBX 的 B2BUA Business Authority；迁移清单中的“B2BUA
legs”只表示验证双腿协议映射。

退出条件：Goal 6、owner/recovery/CDR/media-control、同硬件 A/B 和 rollback 全部通过。

### Phase D5：RTP processing internals

在 `voice-media-rs` 内对 packet/session implementation 逐项 A/B 和替换；ordinary relay
仍由 RTPengine 负责。

`voice-media-rs` 首期作为 Unified RustPBX Process 内的 library 与固定 worker shards
运行；Facade 通过直接 Rust Adapter 调用，不使用 HTTP/gRPC。已有 binary/HTTP surface
只保留给 benchmark、soak、诊断和未来独立扩容研究。Legacy 与 rvoip-derived internals
只能对离线输入或不同测试 Edge 做 A/B；获选实现通过后，还须等旧实现 active
Edge/session、unknown outcome 和 cleanup delta 归零且 rollback window 到期，才删除
旧 rustrtc/local/rvoip 重复代码和依赖，只保留一个 production implementation。

退出条件：correctness、quality、PPS、allocation、P99 和 failure isolation 通过，并删除
被替换重复实现。

### Phase D6：Provider 与身份扩展

STIR/SHAKEN、credential Provider、vCon export、SCIM 和 Provider semantics 分别进入
Goal 5/6/8/9，不与 SIP foundation rollout 捆绑。

### Phase D7：可选 Rust-native Fast Path Backend 资格化

在 `CARRIER-CELL-V1` 已形成稳定基线后，开发 Media Engine Facade 下的 Rust Native
Fast Path Backend：

1. 与 `CARRIER-CELL-V1` 实际 workload 等价的完整功能矩阵：RTP/RTCP、IPv4/IPv6、
   NAT/source validation、SDP rewrite、SDES/DTLS-SRTP、ICE-aware/ICE-unaware、
   QoS/TOS、DTMF、media/recording fork、T.38、timeout/statistics、受控 userspace
   fallback，以及该 Profile 启用的所有功能；
2. batch I/O、fixed shard、CPU/NUMA/NIC queue 和 allocation profile；
3. 与 RTPengine 同硬件、同 packet/call/security workload A/B；
4. fault isolation、drain、rollback 和 24 小时 endurance；
5. 2/4/8 node scaling；
6. 新 Call allowlist → Cell → Region canary。

退出条件是第 16.4 节所有门禁和 candidate Backend finalizer 通过。此前及此后，
RTPengine 都继续作为正式 `CARRIER-CELL-V1` 默认 Backend；通过后只对新
directed Edge 显式选择候选，旧 Edge 保持原 Binding 并自然 drain。生产 Profile 始终
只有一个，每条 Edge 始终只有一个 fenced writer。

## 20. Canary、发布与回滚

### 20.1 发布单位

- 只对新 Call 选择 Adapter；
- Adapter identity 固定在 Call/Leg metadata；
- Unified RustPBX binary、Cargo.lock、rvoip source-slice、`CARRIER-CELL-V1` 与每条
  Edge 的 Backend source/binary/config identity 一并固定；
- 同一 Call 的所有 Protocol Dialog 使用同一 Adapter；
- 每条 Media Edge 固定一个 active writer Backend；
- active Edge 不原地换 Backend；显式迁移建立新 generation、完成必要协商与 handoff
  barrier 后再释放旧 Edge；
- Cell、transport、peer profile 和 tenant allowlist 均为低基数配置。

### 20.2 Canary 顺序

1. offline corpus；
2. shadow parse；
3. isolated test Cell；
4. one peer + UDP；
5. one peer + TCP/TLS；
6. one tenant/new Calls；
7. full Cell/new Calls；
8. Region/new Calls。

### 20.3 自动回滚触发

- semantic diff 未解释；
- ASR、P99、CPU/RSS、allocation 超阈；
- transaction/dialog leak；
- stale owner mutation；
- duplicate CDR/media/DTMF side effect；
- recovery/RTO 失败；
- SIP peer regression；
- RTPengine/processing binding divergence；
- security/redaction/fuzz gate 失败。

### 20.4 回滚动作

- 停止把新 Call 分配给 rvoip Adapter；
- 旧 rvoip Call 保持原 runtime identity 直到 BYE/CANCEL/其他协议终态；普通 drain
  timeout 只进入 operator-visible repair，不强制 BYE/CANCEL；
- 保留旧 Adapter binary/config，直到 active Call/Protocol Session、unknown effect
  和 cleanup delta 全部归零且 rollback window 到期；
- 不跨 Adapter restore 活跃 Call，除非独立迁移门禁已通过；
- 保留所有失败 attempt、trace、binary/config/source hash；
- 上述 active-zero、reconciliation 和 rollback-window 条件全部满足后才删除旧
  runtime。

## 21. RustPBX 产品主干冻结

本方案不提供用 rvoip 高层 runtime 整体替换 RustPBX 的既定出口。RustPBX 产品层、
Call Core、Business Dialog、Media Plan、路由、CDR 和运营 Authority 是本架构的冻结
组成；rvoip 只在低层 Adapter/primitive seam 内竞争。

未来若业务确实要求替换产品主干，必须由一份独立、superseding 的架构 ADR 重新定义
Authority、数据迁移、兼容、容量、故障域和回滚，不能把本设计中的 Module absorption
或 Backend qualification 解释为整体替换许可。

## 22. 文档与变更控制

### 22.1 规范文档

| 文档 | 责任 |
| --- | --- |
| 本文 | 两项目整合的完整设计和迁移顺序 |
| `CONTEXT.md` | 统一领域语言 |
| ADR-CCAAS-7 | 不并行 PBX、分层吸收与 Authority 决策 |
| VOS5000/100K 总设计 | Goal 0-11 的总体依赖和终态架构 |
| Goal 4 plan | processing、G.729、AMR、mix、T.38 实施 |
| capability matrix/schema | 每项 rvoip 能力的唯一处置和证据路径 |
| G.729 candidate manifest/schema | G.729 exact source identity |
| fork manifest | vendored/fork source、license、build 和 release gate |
| RFC/compat/security matrices | Goal 6/9 的逐协议证据 |
| rollout/rollback evidence | 每个 Cell 的 runtime identity 和 attempt |

规范冲突时，优先级为：最新 Accepted ADR 决策 > 本文的 rvoip 整合细节 >
VOS5000/100K 总设计的 Goal 依赖与全局门禁 > capability matrix/schema 的当前处置与
证据状态。机器矩阵不能自行改变 Authority；设计文档也不能把没有 evidence 的
`not_run` 提升为 pass。

### 22.2 变更规则

- 新增 rvoip 能力时，先改设计或 matrix，再写实现；
- 删除或拒绝能力必须记录理由和 superseding decision；
- Authority 变化必须有新的 ADR；
- source commit 变化必须重新生成 source slice、dependency closure 和证据；
- status 只能由绑定同一 source/binary/config identity 的 evidence 提升；
- 文档中的 `not_run` 不得凭人工编辑改成 pass；
- 每个实现切片完成后同步设计、matrix、runbook、manifest 和 test index。

## 23. 当前状态与下一步

### 23.1 Current（已观察，不代表目标拓扑已实现）

- RustPBX 当前仍由 `infra/ivekit/rustpbx` 的 pinned upstream + patch queue 构建，不是
  本设计的统一 Cargo Workspace；
- 现有代码仍包含 RustPBX/rsipstack/rustrtc、RTPengine control 和
  `voice-media-rs` HTTP/binary 路径；
- `services/voice-media-rs` 已同时具有 Rust library modules 与 standalone HTTP
  binary；codec/RTP/session/worker/IVR 内核是 Current，但 Unified RustPBX 进程内
  direct Adapter 尚未接线；
- 仓库尚未纳入 rvoip SIP foundation Source Slice，也没有让 rvoip
  parser/Transaction/Protocol Dialog/Transport 成为任何生产主路径；
- rvoip exact source 已完成审计与能力登记；
- G.729 exact source candidate 已固定，工程实现是后续强制任务；Revision 4 D0
  冻结后由 U2 自动开始，工程状态仍为 `not_run`，不冒充已经实现；
- rvoip capability matrix 已登记 SIP foundation、single-process、workspace、Facade、
  Backend 和历史 deployment capability identity；
- parser/Transaction/Protocol Dialog/Transport 主路径尚未迁移，状态为 `not_run`；
- 所有真实容量、carrier、24h、Production Eligibility 声明仍为 `not_run` 或 `none`。

### 23.2 Target（Revision 4 接受的唯一架构）

- `CARRIER-CELL-V1` 是唯一生产基线；
- Unified RustPBX Process 内嵌低层 rvoip SIP slice 与 `voice-media-rs` library；
- RTPengine 是 external ordinary Edge 的长期默认 Backend；
- Media Plan/directed Edge/writer-fence 是唯一逻辑媒体权威模型；
- Backend Binding Group generation/Wire Transport Bundle 是唯一物理 allocation、
  SDP/security state 与 release 模型；
- LiveKit 保持 Room/WebRTC/SFU Authority；四条 Voice↔LiveKit 路径使用独立
  `VOICE-LIVEKIT-BRIDGE-V1`，不继承 ordinary RTP 或 bridge-excluded evidence；
- Rust-native 仅是可替换 Backend 资格轨道，不形成第二生产 Profile。

文档阶段完成顺序：

1. 评审本文、`CONTEXT.md` 和 ADR 更新；
2. 同步 capability matrix/schema，不删除既有条目；
3. 更新总设计、Goal 4 plan 和 capacity index；
4. 运行文档/schema/链接/JSON 门禁；
5. 独立复审无 Critical/Important；
6. 再恢复 G.729 和后续实现。

## 24. 最终裁决

OPC 不再把 rvoip 简化为“只拿 G.729 和测试”的外部参考，也不把它误当成可直接替换
RustPBX、Kamailio、RTPengine 或 FreeSWITCH 媒体能力的完整软交换。

正确整合方式是：

- RustPBX 产品层、Call Core 与 rvoip SIP foundation 编译为一个 Unified RustPBX
  executable、共享 control runtime、内部无 RPC；
- rvoip 逐模块成为 RustPBX 下方的 SIP 协议 foundation；
- RustPBX 保留全部业务和运营级 Authority；
- 业务只看一个 Media Engine Facade、一个 Media Plan Authority 和一个 external
  codec identity/negotiation registry；G.729 对外只有 `G729/8000`；
- RTPengine 是可长期正式使用的 ordinary Edge 默认 fast path；首期
  `voice-media-rs` 作为同进程 library/worker 执行 decode-required Edge；
- Rust-native fast path 只有同硬件功能、性能、音质、隔离、长稳和扩展全部不劣时，
  才能在同一 `CARRIER-CELL-V1` 中成为 eligible Backend；晋级不自动废止 RTPengine；
- 每条 directed Media Edge 同一 binding revision 只有一个 fenced writer，Backend
  切换必须通过新 generation 和无重叠 handoff；
- rvoip RTP/codec 能力只替换对应路径内部实现；
- Revision 4 D0 冻结后，`G729/8000` 及 G729A/G729AB 两个 mandatory internal
  mode 作为只依赖 D0 的 U2 exact-source slice 自动开始；
- Provider、vCon、STIR/SHAKEN、SCIM 和证据方法按各自 Goal 接入；
- 任何重复 runtime、双写 Authority、无界热路径和虚假容量声明都被禁止。

这采纳了“以 RustPBX 为产品主干、以 rvoip 为进程内源码能力库、迁移后删除重复 SIP
主实现”的核心方案；同时用一个生产 Profile、一个非生产诊断拓扑和一个候选 Backend
资格轨道，避免架构分叉。这样既兑现“不重复造 SIP/RTP 基础设施”，又不丢失 OPC
已经完成的 owner、恢复、CDR、媒体隔离、容量准入和云化能力。普通 RTP 数据面以
RTPengine 为长期默认性能基线；任何替代实现必须用同身份、同硬件证据赢得资格。

## 25. 变更记录

| Revision | 日期 | 变更 |
| --- | --- | --- |
| 1 | 2026-07-29 | 首次接受 RustPBX 产品主干、rvoip 低层吸收、RTPengine 长期 fast path 与渐进迁移方案 |
| 2 | 2026-07-29 | 锁定唯一 `CARRIER-CELL-V1` 生产基线；引入 Media Plan/有向 Media Edge/per-edge writer fence；首期同进程嵌入 `voice-media-rs`；把 Rust-native 降为同架构 Backend 资格轨道；明确拒绝 rvoip 高层 runtime |
| 3 | 2026-07-29 | 增加 Backend Binding Group generation/Wire Transport Bundle 物理模型、原子 prepare/commit/revoke/query/reconcile 状态机、initial 与 active-migration SDP 双规则、commit decision 前后补偿语义、共驻容量与细化 G.729/DTMF/failure 门禁 |
| 4 | 2026-07-30 | 绑定 Revision 4 machine contracts；冻结 effect/receipt、wire/recovery/store/schema/clock、安全与真实单进程边界；统一 G.729 为一个 external identity 与两个 internal modes；加入 Voice↔LiveKit 独立 Authority、四路径和不可继承容量证据 |
