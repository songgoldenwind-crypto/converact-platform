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
| `services/voice-media-rs/src/session.rs` | owner-fenced processing session 状态机 |
| `services/voice-media-rs/src/rtp.rs` | UDP socket、port allocator 和 packet loop |
| `services/voice-media-rs/src/http.rs` | mTLS control API、health 和 metrics |
| `src/agent-runtime/ivekit/media-control/processing.ts` | processing transport client |
| `src/agent-runtime/ivekit/media-control/router.ts` | fast-path/processing profile 路由 |
| `infra/ivekit/media-processing/*` | 可重复镜像和运行配置 |
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
- [x] RTP packet processor 使用 owned `Bytes` 输入和复用 output scratch，不在 parser 与
  codec 之间复制 payload。
- [x] 两腿各自维护 SSRC、sequence、timestamp、source validation、jitter 和 RTCP 统计。
- [x] PCMU/PCMA/Opus RTP wire path 支持双向 payload type、sequence 和 timestamp 重写。
- [x] RFC 4733 支持 event 映射、duration clock 缩放和 start/completed 重复抑制。
- [ ] IVR playback 预解码到有界 PCM frame cache；文件、HTTP、对象存储不进入 RTP loop。
- [ ] SIP INFO gather 接入 RustPBX command path；in-band DTMF 作为后续独立能力状态。
- [ ] playback/gather command 支持 start/stop/barge-in，重复命令不重复播放或完成事件。
- [x] packet-loop 测试覆盖双向真实 UDP、NAT source 更新、DTMF duration/retransmit、
  单次 budget 以上 burst、并发 pool ceiling、session 安装冲突和容量耗尽。
- [ ] packet-loop 继续覆盖一方无媒体、播放结束、barge-in、事件队列满和播放中
  session 删除竞争。
- [ ] rvoip-derived buffer/packet/benchmark 代码必须固定 exact source identity；只提取
  必需模块，不引入其 SIP、WebRTC 或通用 session runtime。

## 7. Task 5：media-control 与 RustPBX 接入

- [ ] `processing.ts` 实现 bounded HTTP/mTLS client，禁止 redirect、压缩响应和无限 body。
- [ ] `router.ts` 仅按冻结 profile 路由：
  `VOICE-ORDINARY -> RTPengine`，
  `VOICE-IVR-G711-OPUS-V1 -> processing pool`。
- [ ] 同 reservation 的全部后续命令固定到同一 transport，禁止 update 时换执行器。
- [ ] RustPBX patch 将 processing profile、codec pair 和 ptime 写入 offer；
  effective SDP 成功后才向对端暴露。
- [ ] processing pool capacity/error 映射为稳定 SIP 503 + Retry-After，不静默退回本地转码。
- [ ] 已建立 processing session 故障不触碰其他 RTPengine reservation。

## 8. Task 6：部署、指标和过载保护

- [ ] 新增可重复 processing image，固定 Rust、rustrtc、audio-codec 和 lockfile identity。
- [ ] Compose/Helm 使用独立 workload、ServiceAccount、mTLS Secret、PDB、
  anti-affinity、topology spread、hostNetwork 可选项和 CPU/NUMA 资源。
- [ ] readiness 同时要求 port budget、codec registry 和 control identity；
  drain 先将路由权重归零，再拒绝 prepare，最后等待 active sessions。
- [ ] 指标至少包含 pair slots、processing seconds、jitter depth、reorder、duplicate、
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

## 12. 第一执行批

本次立即执行 Task 1 和 Task 2。完成门槛：

1. Goal 4 合同和 G.711/Opus profile 可被机器校验；
2. `voice-media-rs` 不再只是 HTTP 桩，具备可测试的 codec-pair capacity、
   bounded jitter/reorder 和 PLC/transcode core；
3. Rust 单测、Clippy、TypeScript 合同测试全部通过；
4. 未接入真实 UDP/media-control 的项目诚实保持 `not_run`。
