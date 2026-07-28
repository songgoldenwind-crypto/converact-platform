# iveKit Goal 4 Media Processing Implementation Plan

> 执行模式：Inline Execution。本文是
> `communication-foundation-vos5000-parity-performance-plan.md` 的 Goal 4
> 详细实施计划；每个切片必须先有失败测试，再实现，再形成不可变证据。

**Goal:** 建成与 RTP fast path 隔离、按 codec pair 独立准入、可横向扩展的
Rust 媒体处理与转码池，完整覆盖 IVR、G.711/Opus、G.729、AMR、会议混音和 T.38，
且处理池过载或崩溃不影响普通 RTP relay。

**Architecture:** RustPBX 保留 Call/Leg/Dialog 和逻辑媒体图，RTPengine 继续承担
无解码需求的 relay。`services/voice-media-rs` 升级为 Cell-local processing pool；
media-control 根据冻结后的 media profile 将会话交给 RTPengine fast path 或
processing pool。processing pool 使用 owner epoch、reservation、codec-pair slot 和
有界 RTP 队列，任何资源不足均在新会话建立前 fail closed。

**Tech Stack:** Rust 2021、Tokio、rustrtc exact commit、audio-codec 0.3.40、
Axum、Prometheus metrics、TypeScript media-control、Compose/Helm、SIPp/RTP generator。

**Source decision:** rvoip 仅作为可审计的能力来源，不作为第二套在线 SIP/RTP/WebRTC
runtime。替换结论、exact source 和提取边界见
[`ADR-CCAAS-7`](../adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)。

---

## 1. 不变量

1. `VOICE-ORDINARY` G.711 pass-through 不进入 processing pool。
2. codec pair、ptime、方向和安全模式都是容量身份，不能只使用一个总 CPU 百分比。
3. processing slot 在 SDP 对外可见前完成 prepare/commit；过载只拒绝新处理会话。
4. RTP 接收队列、jitter buffer、播放队列、会议输入和事件队列均有硬上限。
5. 不在 RTP 包路径访问 PostgreSQL、NATS、对象存储、Provider 或远程控制面。
6. owner epoch、command sequence 和 idempotency key 与 Goal 1/3 保持一致。
7. processing pool 停止不得重启或清空 RTPengine fast-path 会话。
8. 指标标签只允许固定 codec pair、profile、direction、result 和 failure stage。
9. 未通过真实音频、质量和容量验收的 codec 保持 `not_run`。
10. G.711/Opus 切片通过后才能开始 G.729、AMR 和 T.38。

## 2. 文件边界

| 文件 | 单一职责 |
| --- | --- |
| `docs/capacity/schemas/voice-media-goal4.schema.json` | Goal 4 机器合同 Schema |
| `docs/capacity/schemas/voice-media-processing-profile.schema.json` | Processing profile Schema |
| `docs/capacity/contracts/voice-media-goal4-v1.json` | 源码、切片、质量、容量和证据状态 |
| `docs/capacity/profiles/vos-eq-v3-g711-opus-1k-v1.json` | 第一批 processing profile |
| `services/voice-media-rs/src/codec.rs` | codec 和 codec-pair registry |
| `services/voice-media-rs/src/capacity.rs` | codec-pair slot 与 RAII permit |
| `services/voice-media-rs/src/frame.rs` | 无运行时依赖的 RTP 音频帧值对象 |
| `services/voice-media-rs/src/jitter.rs` | 有界 reorder、duplicate、late 和 gap 决策 |
| `services/voice-media-rs/src/pipeline.rs` | decode、PLC、resample、encode 和 RTP timing |
| `services/voice-media-rs/src/ivr.rs` | 有界 prompt cache、playback/gather、barge-in 和幂等状态机 |
| `services/voice-media-rs/src/session.rs` | owner-fenced processing session 状态机 |
| `services/voice-media-rs/src/rtp.rs` | RTP/RTCP、RFC 4733、PCM 注入和 packet processor |
| `services/voice-media-rs/src/worker.rs` | 固定 mio worker、UDP socket、IVR timer 和有界事件队列 |
| `services/voice-media-rs/src/http.rs` | 有界认证 control API、health、readiness 和 metrics |
| `src/agent-runtime/ivekit/media-control/processing.ts` | processing transport client |
| `src/agent-runtime/ivekit/media-control/router.ts` | fast-path/processing profile 路由 |
| `infra/ivekit/voice-media/*` | 可重复镜像和运行配置 |
| `test/ivekit-voice-media-goal4-*.test.ts` | 合同、集成、部署和 finalizer 门禁 |

## 3. Task 1：冻结 Goal 4 合同

- [x] 新增 Goal 4 Schema，要求：
  `source_identity`、`codec_slices`、`processing_runtime`、`failure_matrix`、
  `quality_evidence`、`capacity_evidence`、`claim`。
- [x] 新增 `voice-media-goal4-v1`，初始所有真实环境项为 `not_run`，
  `capacity_claim=none`。
- [x] 新增 `vos-eq-v3-g711-opus-1k-v1`，固定：
  双向 1,000 processing sessions、20 ms ptime、PCMU/PCMA/Opus、无录音、
  独立 generator、P99 processing latency、loss/jitter 和音质门槛。
- [x] 测试拒绝缺失 codec pair、使用高基数标签、把 `not_run` 手工改成 pass、
  generator 与 SUT 同机和没有 processing headroom 的合同。
- [x] 验证：
  `node --import tsx --test test/ivekit-voice-media-goal4-contract.test.ts`。

## 4. Task 2：G.711/Opus 处理内核

- [x] `codec.rs` 定义固定枚举 `Pcmu/Pcma/Opus`、稳定 label、clock/sample rate、
  payload type 和允许的第一批双向 pair；未知 codec fail closed。
- [x] `capacity.rs` 实现每 pair 独立的 `safe_capacity`、atomic used/rejected、
  `try_acquire` 和 Drop 自动释放；不允许跨 pair 借槽。
- [x] `jitter.rs` 使用固定容量 ring/window：
  sequence wrap-aware 排序、重复抑制、过晚丢弃、达到等待门槛后输出明确 gap，
  不允许随网络恶化无限增大。
- [x] `pipeline.rs` 对收到的帧执行 decode/resample/encode；gap 使用上一帧 PCM
  衰减生成 PLC，连续 conceal 达到上限后输出静音并记录原因。
- [x] RTP sequence/timestamp 在 16/32 位回绕时保持单调域；8 kHz 与 48 kHz
  互转保持 20 ms 节拍。
- [x] 单元测试覆盖：
  PCMU->Opus、Opus->PCMU、PCMA->Opus、乱序、重复、burst loss、sequence wrap、
  timestamp wrap、slot exhaustion、permit release 和 10,000 次 acquire/release。
- [x] 验证：
  `cargo fmt --manifest-path services/voice-media-rs/Cargo.toml -- --check`，
  `cargo test --manifest-path services/voice-media-rs/Cargo.toml --locked`，
  `cargo clippy --manifest-path services/voice-media-rs/Cargo.toml --locked -- -D warnings`。

## 5. Task 3：Owner-fenced Processing Session

- [x] `session.rs` 实现 `prepare/commit/update/delete/query/reconcile`，命令身份沿用
  `ivekit.media-control.v1`。
- [x] 每个 reservation 保存固定上限状态：
  owner、epoch、last sequence、codec pair、ptime、两腿 transport、permit 和 deadline。
- [x] stale epoch、sequence gap、payload conflict、unknown outcome 和 replay
  与 Goal 1/3 语义一致。
- [x] prepare 原子获取双向 codec-pair permit 和两个 UDP port；任一步失败全部补偿。
- [x] control API 中断后已提交 session 不因 lease sweep 终止；未提交 lease
  到期进入有界且公平的 shard 轮转 sweep。
- [x] release 模式实际执行 100,000 reservation / 200,000 command 有界状态测试，
  并验证 command replay 不产生重复资源副作用。

## 6. Task 4：RTP、IVR 与 DTMF 数据面

- [x] `worker.rs` 使用固定原生 worker/shard、可配置 `SO_REUSEPORT` 和固定 packet
  budget；有界 ready queue 保留 edge-triggered budget continuation，不创建 per-leg task。
- [x] hard-bounded `DatagramPool` 使用 `ArrayQueue`、原子 allocation ceiling 和
  `Bytes::from_owner`；最后一个引用释放时同步归还，耗尽时由 worker-local discard
  buffer 排空内核队列，不阻塞、不扩容、不自旋。
- [x] 会话安装按两侧 jitter capacity 预留 datagram retention budget，并为每个 worker
  保留一个瞬时接收 buffer；容量不足在绑定 socket 前拒绝新会话，删除会话自动归还，
  防止 jitter 长期持有 owner 后把接收路径锁死。
- [x] RTP packet processor 使用 owned `Bytes` 输入和复用 output scratch，不在 parser 与
  codec 之间复制 payload。
- [x] 两腿各自维护 SSRC、sequence、timestamp、source validation 和 jitter；当前
  RTCP report/statistics 是 session aggregate，per-leg RTCP 指标归入 Task 6。
- [x] PCMU/PCMA/Opus RTP wire path 支持双向 payload type、sequence 和 timestamp 重写。
- [x] RFC 4733 支持 event 映射、duration clock 缩放和 start/completed 重复抑制。
- [x] IVR playback 在控制路径重采样并写入有界 48 kHz/20 ms PCM frame cache；
  文件、HTTP、对象存储不进入 RTP loop。
- [x] worker 暴露 SIP INFO digit 输入，并与 RFC 4733 共用一个有界 gather/去重状态机。
- [ ] 将 SIP INFO gather API 接入 RustPBX command path；in-band DTMF 作为后续独立能力状态。
- [x] playback/gather command 支持 start/stop/barge-in、首键/键间超时和会话删除取消；
  在配置的有界 replay window 内，重复 command/event 返回原结果且不重复播放、收号或
  生成完成事件。
- [x] IVR 使用每 worker 有界 indexed mutable min-heap deadline queue；update 原位调整，
  不积累 stale timer。迟到 tick 跳帧而不突发补帧，无 RTP destination 时按 20 ms 重试。
- [x] playback/gather 开始前预留 terminal-event slot；完成、停止、超时和 session removal
  事件经有界 reliable outbox 交付，主事件队列满时保留待发。容量不足拒绝新 IVR work；
  非终态 telemetry 仍允许丢弃且不阻塞媒体或控制线程。
- [x] 生成提示音与实时媒体共享同一 RTP sequence/timestamp domain，提示音结束后的
  实时帧显式重新锚定，包含生成流完整 sequence wrap 后恢复，防止序号或时间戳倒退。
- [x] 第一版 playback 固定为 `replace` 语义：目标方向仍消费 jitter/RFC 4733，
  但不编码或发送实时媒体，避免提示音与实时流形成双倍包率；播放完成后连续恢复。
- [x] UDP send `WouldBlock`/error 采用实时媒体 drop-and-advance：记录计数并丢弃该 20 ms
  frame，不重试过期 RTP；Task 6 补齐按 leg/result 的低基数指标和告警。
- [x] processor 测试覆盖 NAT source 更新、RTCP、DTMF duration/retransmit、replace
  suppression tail 和恢复；worker UDP 测试覆盖双向 wire、PCMA/Opus、burst、
  `SO_REUSEPORT`、晚到 destination、RFC 4733 barge-in、安装冲突及资源准入。
- [x] `ProcessingRuntime` 使用 `rustrtc::SessionDescription` 解析/重写 offer、answer
  和 update，将 SDP 目的地址作为 early-media hint，并在对端发包后切换到验证过的
  symmetric RTP source；会话端口、codec slot、worker 安装及 owner-fenced 状态以
  事务方式提交，bind/control 失败时完整回滚。
- [x] `main.rs` 已接入 Tokio/Axum 服务，暴露 processing command、reconcile、query、
  health、readiness 和低基数 Prometheus metrics；阻塞运行时操作统一进入有界
  `spawn_blocking` 控制路径。
- [x] 控制面强制请求体上限和 fail-fast inflight semaphore；Bearer 与可信代理注入的
  client identity 可同时校验，超大请求保留 `413`，错误配置在绑定端口前 fail closed。
- [ ] client identity header 不是原生 mTLS；Task 6 必须由受信 sidecar/mesh 完成
  TLS 客户端证书校验并剥离外部同名 header，或为服务增加原生 Rustls，完成前不得声明
  end-to-end mTLS。
- [x] processing command 保存有界历史 effective SDP，并提供
  `command_id + owner_epoch + command_hash` reconcile；prepared 超时先删除 worker
  再归还端口/slot，terminal retention 到期后再清理运行时状态。
- [x] IVR pure-state 测试覆盖背压、首键/键间超时、截止时刻 digit、迟到跳帧、
  RFC 4733/SIP INFO 共用状态、stop/replay、cache 全部上限及 session removal；
  worker 测试覆盖有界 timer fairness 和 terminal-event overload。
- [ ] 用 allocator/heap profiler 验证稳定 RTP packet loop 的分配次数与高水位；代码已复用
  PCM conceal/output scratch，但 codec 上游 API 仍可能分配，未取得证据前不声明零分配。
- [x] ADR 固定 rvoip exact source identity、替换结论和提取边界；不引入其 SIP、
  WebRTC、QUIC/MoQ 或通用 session runtime。未来复制或改写代码仍须逐文件登记 provenance。

## 7. Task 5：media-control 与 RustPBX 接入

- [x] `processing.ts` 实现 bounded HTTP client，禁止 redirect、压缩响应和无限 body；
  Bearer 与受信 sidecar 注入的 client identity 可同时校验，原生 mTLS 仍归 Task 6。
- [x] `router.ts` 仅按冻结 media profile 路由：
  `g711-relay-v1 -> RTPengine`，
  `VOICE-IVR-G711-OPUS-V1 -> processing pool`。
- [x] 同 reservation 的全部后续命令固定到同一 transport，禁止 update 时换执行器；
  重启后同时探测两个 transport，双侧同时认领时 fail closed。
- [ ] 将 worker 内已完成的 terminal-event reliable outbox 接到 media-control durable
  handoff，并提供 query/reconcile；worker telemetry queue 满可以丢统计事件，但
  playback/gather 完成事件不得在进程边界永久丢失。
- [x] RustPBX patch 将逐会话 processing profile、codec pair 和 ptime 写入 offer；
  effective SDP 成功后才向对端暴露。
- [ ] processing pool capacity/error 映射为稳定 SIP 503 + Retry-After，不静默退回本地转码。
- [ ] 已建立 processing session 故障不触碰其他 RTPengine reservation。

## 8. Task 6：部署、指标和过载保护

- [x] 新增可重复 processing image，固定 Rust toolchain、依赖 lockfile 和运行镜像 digest。
- [ ] Compose/Helm 已接入独立 processing 容器/sidecar、独立 UDP 端口范围、只读文件系统、
  非 root、资源上限和探针；仍需补齐独立 workload、ServiceAccount、原生 mTLS Secret、PDB、
  anti-affinity、topology spread、hostNetwork 可选项和 CPU/NUMA 资源。
- [ ] readiness 已要求 worker 与 RTP port budget；仍需加入 codec registry、control identity，
  drain 先将路由权重归零，再拒绝 prepare，最后等待 active sessions。
- [ ] 已暴露 active/retained sessions、RTP packet、datagram retention、queue drop、
  control rejection 和 port budget；仍需补齐 pair slots、processing seconds、
  jitter depth、reorder、duplicate、
  late、conceal、queue drop、RTP/RTCP、active sessions 和 drain。
- [ ] 告警区分 capacity exhausted、packet backlog、processing P99、持续 PLC、
  one-way/no-media 和 worker stall。

## 9. Task 7：G.711/Opus 服务器验收

- [ ] 只使用隔离的 OPC project/network/container，不修改 LED 服务。
- [ ] 验证 exact source、lockfile、image digest、config hash、kernel、CPU 和 NIC。
- [ ] 用独立 caller/callee generator 跑 PCMU<->Opus 与 PCMA<->Opus 双向真实 RTP。
- [ ] 注入 reorder、duplicate、1/3/5% loss、burst loss、20/40 ms jitter 和 source change。
- [ ] 测量 packet reconciliation、P50/P95/P99 processing latency、mouth-to-ear、
  PESQ/POLQA 或等价质量证据。
- [ ] 停止 control API、processing worker、录音、对象存储和 PostgreSQL；
  证明普通 RTPengine relay 未终止。
- [ ] 运行 1K safe-capacity 阶梯和至少两小时 soak；环境不足保持 `not_run`。

## 10. Task 8：后续 codec 与会议切片

- [ ] G.729：以 rvoip exact-commit G.729A/AB 为候选源码，独立 pair、ptime、来源、
  reference vector、互通、质量和容量签署；不得因源码存在直接标记完成。
- [ ] AMR-NB/WB：独立 fmtp、mode-set、octet-align、DTX 和容量签署。
- [ ] conference/mix：按 participant-input 和 output mix slot 准入，不复用 transcode slot。
- [ ] T.38：UDPTL redundancy、ECM、G.711 fallback 和 fax quality 独立签署。
- [ ] 任一切片失败不回退为“功能已完成”，只保留已签署 pair。

## 11. Task 9：Finalizer 与 Goal 4 收口

- [ ] finalizer 从原始 evidence 重算 source、功能、质量、故障和容量状态。
- [ ] invalid generator、identity mismatch、持续 packet drop 或 processing pool
  影响 ordinary relay 时整轮失败。
- [ ] 更新 fork manifest、capacity README、总体设计和 completion audit。
- [ ] Goal 4 只有全部 codec/IVR/conference/T.38 交付完成才标记 `implemented`；
  未有物理证据仍不得标记 `production_pass`。

## 12. 当前执行状态

1. Task 1–3 已完成：机器合同、G.711/Opus 内核和 owner-fenced processing session
   均有自动化门禁。
2. Task 4 的 runtime/HTTP 切片已完成固定 RTP worker、PCMU/PCMA/Opus wire path、
   RFC 4733、IVR pure/worker 状态机、有界 terminal-event outbox、datagram-retention
   admission、事务化 `ProcessingRuntime`、结构化 SDP、command reconcile 及
   Tokio/Axum control service。HTTP 契约覆盖双凭据、body limit、readiness、聚合指标
   和规范化 hash/decimal；完整 Rust 回归与严格 Clippy 已通过。
3. Task 5 已完成 bounded processing transport、`g711-relay-v1`/processing profile
   混合路由、reservation transport 粘滞、双 transport 重启探测、公平 orphan scan、
   owner-fenced release context 和 RustPBX 逐会话 profile/codec/ptime 注入。
   inbound admission 与 RWI 现在冻结相同的 tenant、Cell、owner node、route revision、
   availability、auth context 和 media profile；恢复胶囊也持久化同一 profile，旧胶囊
   仅通过显式 G.711 兼容迁移读取。RWI originate 先取得真实 rsipstack dialog tag，
   再把 authoritative media-control SDP 写入尚未发送的 INVITE，183/200 SDP 也在暴露
   给本地 RTP track 前完成 media commit；未知结果使用原始 command 对账后再删除，
   未确认的清理由单一限流 worker 保留重试；同步准备失败只释放本命令新打开的 owner。
   干净固定源码重放后的 RustPBX 原生库测试 76 项、dialog shadow 合同 20 项、
   rsipstack 单元测试 249 项和文档测试 65 项已通过；本轮受影响 Node 回归 148 项，
   扩展 RustPBX/rsipstack/rustrtc 合同回归 205 项也已通过（两组有重叠）。
   全仓 Node 回归共 4,475 项，其中 4,461 项通过、14 项按环境条件跳过、0 项失败。
   镜像和真实 SIP/RTP 尚未运行。SIP INFO、
   SIP 503 映射及 terminal-event durable handoff 仍未完成。
4. Task 6 已完成可重复 processing image、Compose 同网络命名空间部署、Helm sidecar
   骨架、独立 UDP 端口边界和基础 readiness/metrics。原生或 mesh mTLS、完整 drain、
   K8s workload 隔离、全量媒体指标和告警仍未完成。
5. Task 7–9、真实服务器媒体/质量/容量证据仍未完成，合同继续保持 `not_run`，
   不声明生产容量。
