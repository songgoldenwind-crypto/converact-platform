# ADR-CCAAS-7：rvoip 替换 RustPBX 与能力提取审计

状态：**Accepted**

日期：2026-07-28

适用范围：iveKit/OPC 通信底座 Goal 4-11

## 1. 决策摘要

**当前不使用 rvoip 整体替换 RustPBX。**

终态通信架构继续保持：

```text
Kamailio SIP Edge
        |
        v
iveKit RustPBX fork          LiveKit                 Tinode
Call/Leg/Dialog/IVR          WebRTC/SFU              IM
        |
        +------------------ media-control
                               |
                    +----------+-----------+
                    |                      |
                RTPengine           voice-media-rs
                fast path           processing pool
                relay/SRTP          transcode/IVR/mix
```

rvoip 不作为第二套在线 SIP B2BUA、RTP relay 或 WebRTC 服务部署，也不把它的
`Conversation/Session` 模型提升为新的业务权威。这样避免同时维护两套 Call/Dialog、
两套媒体会话和两套故障恢复语义。

但 rvoip 不是“无用”。它有一批质量很高、与当前 Goal 直接相关的实现和工程方法。
本 ADR 将这些能力分为：

1. **立即吸收**：有界 RTP buffer、zero-copy packet、基准与证据方法、RFC/安全矩阵；
2. **独立切片吸收**：G.729A/AB、Provider trait、vCon、STIR/SHAKEN；
3. **只作测试输入**：SIP 互通用例、拓扑 profile、模糊测试 corpus；
4. **明确不引入**：另一套 WebRTC、QUIC/MoQ、媒体权威和通用 session runtime。

未来只有 rvoip 同时通过第 12 节的完整替换门槛，才重新讨论替换 RustPBX。在此之前，
“升级”指选择性提取与重写，不指切换生产呼叫引擎。

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
| Patch set | `ivekit.35` |
| Patch 文件 | `34` |
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
- 纯 Rust G.729 Annex A，及可选 Annex B VAD/DTX/CNG；
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
| Call/Dialog 权威 | RustPBX + owner epoch + durable shadow | 通用 Session/Conversation；无 iveKit owner 合同 | 保留现状 |
| 普通 RTP | RTPengine fast path，与业务/存储隔离 | rtp-core/media-core 用户态路径 | 保留 RTPengine |
| 必须解码媒体 | 独立 `voice-media-rs` processing pool | media-core 组件较多，但完整 release path 未闭环 | 选择性提取 |
| 断点恢复 | reciprocal dual-leg capsule、takeover、epoch fencing | 无等价的 iveKit 双腿恢复合同 | RustPBX 胜 |
| 路由热路径 | 签名 route snapshot + Cell admission | 通用 SIP 路由/API | RustPBX 胜 |
| CDR | owner-fenced dual-leg durable spool/quorum receipt | 无等价 Region durability 合同 | RustPBX 胜 |
| 录音隔离 | 有界 capture、独立 lifecycle、local spool、上传故障隔离 | RecordingSink 抽象和媒体能力尚未达到同等故障语义 | RustPBX 胜 |
| AI 实时音频 | 非阻塞 tap + token + provider router | ASR/TTS/Dialog trait 更简洁，但缺少完整准入/背压合同 | 合并思想 |
| Codec | G.711/Opus 已有处理内核；G.729/AMR/T.38 待做 | G.711 和独立 G.729 源码有价值 | 提取 G.729 候选 |
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
- codec registry 和 G.729A/AB 的独立实现边界；
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

### 7.1 P0：立即进入当前 Goal 4

| rvoip 强项 | iveKit 落点 | 接入方式 | 验收 |
| --- | --- | --- | --- |
| owned Bytes RTP parse | `voice-media-rs/rtp.rs` | 保留 exact rustrtc parser，输入改为 pooled owner | packet path 无 payload copy |
| lock-free bounded pool | `datagram_pool.rs` | 根据语义重写，不复制通用 async pool | exhaustion 不分配、不阻塞 |
| reusable serialization | `rtp.rs` | worker-local output scratch | steady-state 无 output Vec churn |
| packet/session benchmark | `benches/*`、Goal 4 evidence | 同 codec pair 分层测量 | parse/codec/e2e 三层可归因 |
| RTP/RTCP/DTMF cases | Goal 4 tests | 提炼为协议测试输入 | malformed、wrap、reorder、duration 全覆盖 |

### 7.2 P1：Goal 6/9 的工程方法

| rvoip 强项 | iveKit 落点 | 要求 |
| --- | --- | --- |
| RFC compliance matrix | Goal 6 SIP matrix | 每一能力绑定 RFC、范围、测试 ID、明确 non-claim |
| compatibility matrix | Kamailio/RustPBX/RTPengine interop | 每个 peer/transport/codec 有版本和 evidence |
| topology profiles | Goal 10 Fleet | standalone、edge、full-media、failure profile 分开 |
| security posture | Goal 9/安全审计 | trace redaction、auth、SDP crypto、ICE secret 逐项门禁 |
| fuzz scope | SIP/SDP/RTP/RTCP/SRTP fuzz | parser crash、CPU amplification、allocation ceiling |
| immutable report | Goal 11 finalizer | commit、binary、config、hardware、raw result hash 绑定 |

### 7.3 P1：Goal 4 的 G.729 候选

提取范围限定为 `codec-core` 中：

- G.729 Annex A speech encode/decode；
- Annex B VAD/DTX/CNG；
- 10 ms/80 sample frame contract；
- SID/no-data packet handling；
- bitstream 和 reference-vector tests。

不得直接把“源码存在”标记为 codec 完成。合入前必须：

1. 做来源和精确 commit manifest；
2. 剥离与 rvoip 全 workspace 无关的依赖；
3. 加入 `voice-media-rs` codec-pair registry；
4. 覆盖 G.729A、G.729AB、G.711/Opus 双向组合；
5. 验证 packetization、ptime、Annex B fmtp 和 PLC；
6. 与独立 SIP peer 互通；
7. 运行 reference vector、PESQ/POLQA 或等价质量门禁；
8. 测量每 core sessions、P99 和 steady-state allocation；
9. 未签署前保持 `not_run`。

### 7.4 P1：Provider trait

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

### 7.5 P2：vCon 与身份能力

- vCon 作为统一会话的**导出/交换格式**，不能替代 iveKit durable session、
  RecordingManifest 或审计事实；
- STIR/SHAKEN 作为 Goal 6 的可插拔签名/验证 adapter；
- registrar identity/credential provider 用于增强 SIP 身份插件边界；
- SCIM 能力进入 OPC 企业身份路线，不进入 RTP/SIP 热路径。

### 7.6 暂不吸收

- rvoip WebRTC/DTLS/ICE/TURN：继续由 LiveKit/Coturn 负责；
- rvoip QUIC/UCTP/WebTransport/MoQ：只跟踪，不进入语音生产数据面；
- rvoip Conversation/Session/Participant 全局模型：不替换现有 domain model；
- rvoip 通用 RTP transport runtime：不作为 Goal 4 worker；
- rvoip PBX server：不与 RustPBX 并行部署；
- rvoip recording sink：不替换 RecordingManifest、spool 和 evidence pipeline。

## 8. 防止项目变杂的边界

每一项 rvoip 提取必须满足以下六条：

1. **一个权威**：Call/Dialog 仍归 RustPBX，wire media 归选定执行器；
2. **一个接入口**：所有处理媒体只通过 `media-control.v1` 进入 processing pool；
3. **不引入第二 runtime**：不运行 rvoip SIP/WebRTC server；
4. **最小源码面**：按独立 crate/模块提取，禁止把 46-crate workspace 加为顶层依赖；
5. **带来源清单**：exact commit、文件 hash、改动说明、测试证据进入 fork manifest；
6. **同一性能合同**：任何提取代码必须接受 Goal 4/6/10/11 的 profile/finalizer，
   不能用上游自己的“通过”替代 iveKit 验收。

## 9. 对 Goal 0-11 的影响

| Goal | 调整 |
| --- | --- |
| Goal 0 | 把 rvoip exact commit、能力矩阵和 benchmark 作为 source spike 输入 |
| Goal 1 | 不改变媒体权威和控制协议 |
| Goal 2 | 不改变 RTPengine fork |
| Goal 3 | 不替换 RustPBX；保留现有 patch queue |
| Goal 4 | 吸收 pooled Bytes、fixed worker、benchmark 方法；增加 G.729 candidate slice |
| Goal 5 | 仅吸收 RecordingSink 的接口思想，不替换 evidence plane |
| Goal 6 | 导入 RFC/compat/security matrix 和互通用例 |
| Goal 7 | 将 allocation、cache-line、per-core benchmark 纳入 CPU/NUMA 优化 |
| Goal 8 | 不改变 Cell placement；未来可借鉴 registrar identity adapter |
| Goal 9 | 导入 trace redaction、fuzz 和 immutable evidence 方法 |
| Goal 10 | 导入 SIPp profile 组织方式，仍使用独立 generator fleet |
| Goal 11 | 增加 rvoip-derived source identity 和 non-claim 审核 |

## 10. 组件升级策略

“需要升级就升级”采用以下规则：

1. 升级必须解决已知缺口、性能瓶颈、安全问题或长期维护风险；
2. 先在独立 worktree/reproducible image 中 rebase；
3. 现有 34 个补丁逐个 `apply --check` 或语义迁移；
4. 先过 contract、unit、interop、failure、capacity regression；
5. 任何 owner/media/CDR/recording 语义回退都阻止升级；
6. 不为了版本号更新而替换已验证的 rustrtc `0.3.90` 接口；
7. rvoip 组件若被提取，固定 exact commit，不引用 `main` 或宽松 semver。

## 11. 立即执行顺序

1. 完成 `voice-media-rs` hard-bounded `DatagramPool`；
2. 完成固定线程、固定 shard、固定 packet budget 的 `RtpWorkerPool`；
3. 用真实 UDP 测试 PCMU/Opus 双向转换、source latch、RFC 4733 和 queue exhaustion；
4. 增加 parser/codec/packet-loop Criterion benchmark；
5. 完成 IVR playback/gather/barge-in；
6. 接入 media-control 和 RustPBX profile router；
7. 建立 rvoip G.729 candidate source manifest；
8. 在 Goal 6 建立 RFC/compat/security machine-readable matrix；
9. 在服务器跑统一 A/B，而不是直接比较两份项目自己的报告。

## 12. 未来允许替换 RustPBX 的门槛

rvoip 只有全部满足以下条件，才可重新提交替换 ADR：

1. 支持当前 RustPBX patch queue 的所有外部合同；
2. owner epoch、command sequence、idempotency、prepare/commit 语义完全一致；
3. route snapshot、Cell admission 和 Kamailio placement 完整；
4. reciprocal dual-leg dialog shadow、takeover 和 recovery 完整；
5. RTPengine offer/answer/delete、DTMF、mid-dialog renegotiation 完整；
6. dual-leg CDR、Region receipt 和 terminal repair 完整；
7. 录音、AI tap、Provider 故障不回压 SIP/RTP；
8. PRACK、UPDATE、REFER、Replaces、session timer 等 Goal 6 矩阵通过；
9. WSS/WebPhone 兼容或保持 LiveKit/现有 WebPhone 接口；
10. 相同硬件、相同 workload 的 CPS/PPS/P99/CPU 至少不劣于现状；
11. 2/4/8 节点扩展效率满足目标；
12. 24 小时 endurance、故障注入和 rolling rollback 通过；
13. 迁移可逐 Cell 灰度，旧会话不被中断；
14. 总维护面积和补丁成本低于继续维护 RustPBX。

任一项未满足，结论仍为“选择性吸收，不整体替换”。

## 13. 最终判断

rvoip 是一个值得长期跟踪的 Rust 通信技术库，尤其适合提供 codec、协议测试、
Provider interface、身份扩展和性能证据方法。它不是当前 iveKit RustPBX 的即插即用
替代品。

当前最优解不是在二者之间二选一，而是：

- 用 RustPBX 保住已经完成的运营级呼叫权威和故障恢复；
- 用 RTPengine 保住普通媒体极致 fast path；
- 用 `voice-media-rs` 建立可严格准入的高性能处理池；
- 从 rvoip 精确提取 codec、buffer、benchmark、RFC 和安全工程成果；
- 用统一 VOS-EQ/100K 合同决定每一次提取是否真的提升系统。

这条路线同时满足“功能不能阉割”“单机性能极致”“横向扩展边际不衰减”和“项目不能
因开源组件叠加而失去边界”四个目标。
