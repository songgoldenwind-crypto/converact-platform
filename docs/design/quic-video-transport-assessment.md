# QUIC 视频传输技术评审与演进裁决

> 日期：2026-07-21
> 输入：`quic优化视频传输.pdf`，论文 *QUIC as Multiplexing Layer in WebRTC*
> 范围：Converact Fabric/Converact Platform/LED 共用的 LiveKit 音视频、屏幕共享、实时控制与文件传输底座
> 裁决：有明确价值，但当前只进入传输竞争治理和隔离实验，不替换生产 LiveKit WebRTC

## 1. 结论

这篇论文解决的是一个真实问题：传统 WebRTC 的 RTP 媒体与 SCTP DataChannel 使用不同拥塞
控制器，当视频、屏幕共享和大文件经过同一瓶颈链路时，可靠数据流可能压低媒体码率并放大延迟和
抖动。论文把 RTP 与数据流复用到同一条 QUIC 连接，以一个拥塞控制器、一个 pacer 和显式优先级
统一分配带宽，实验显示并发数据传输时媒体更稳定，应用也能决定媒体与文件各占多少带宽。

它对 Converact Fabric 有帮助，但不能直接作为 LiveKit 的生产补丁，原因有四个：

1. Converact Fabric 当前附件走独立 HTTP/分片上传，参考客户端的 LiveKit adapter 只承载音频、视频和屏幕
   共享，并没有把文件放进 LiveKit DataChannel。论文中的 SCTP 竞争不会原样出现，但同一用户出口
   上的 HTTP 上传仍会与媒体竞争。
2. 当前固定的 Converact Fabric LiveKit Server `v1.13.4-ivekit.1` 和 2026-07-21 检查的上游 master 都使用 WebRTC
   SRTP/DTLS/SCTP，没有 RoQ 或 WebTransport 媒体实现。只改 Server 不够，浏览器和所有客户端也
   必须支持同一传输协商、拥塞反馈和恢复语义。
3. 浏览器标准 `RTCDataChannel` 仍以 SCTP/DTLS 为传输。WebTransport 虽然使用 QUIC，但把文件
   改成 WebTransport、媒体继续走 WebRTC，会保留两个独立拥塞控制器，不能得到论文的核心收益。
4. 论文实现是 quic-go/Pion/GStreamer 原型：使用定制 QUIC ACK receive timestamp、关闭默认拥塞
   控制、接入 GCC 和优先队列；它仍有发送端内部缓冲、动态带宽未覆盖、部分可靠性未完成、硬编码
   flow identifier 等限制。

因此采用三层策略：

- **生产立即落地**：基于现有 LiveKit RTCStats/QoS，给 HTTP 附件、录制上传和其他后台数据流增加
  会话感知的带宽治理，先解决真实用户体验问题。
- **协议隔离实验**：建立 RoQ/Pion/quic-go lab，复现论文并加入 Converact Fabric 的屏幕共享、控制消息、文件
  和弱网矩阵，不进入生产端口或默认 SDK。
- **长期可插拔演进**：只有标准、浏览器/原生客户端、LiveKit fork 和真实收益同时达到门槛，才把
  `roq_quic` 作为可协商 transport capability；WebRTC 始终保留回退。

## 2. 论文方案与证据边界

### 2.1 方案

论文在一条 QUIC 连接中承载：

- RTP：使用 RTP over QUIC（RoQ）的 QUIC DATAGRAM 或 stream 映射；
- DataChannel：可靠消息映射到独立 QUIC stream；
- 带宽估计：QUIC ACK 携带 receive timestamp，复用 Pion 的 GCC 估计器；
- 发送调度：连接级 rate pacer；RTP 为高优先级，数据流消费媒体未使用的预算；
- 丢弃策略：过期媒体 stream 可 reset，避免旧帧继续排队。

### 2.2 实验结果

论文在 1/5/10 Mbit/s、单向传播时延 10/25/50 ms 的 Linux netem 环境中，每组运行 10 次。
结论是：

- 只有媒体时，RoQ 与传统 WebRTC 性能接近，但 QUIC 头部/控制帧和内部缓冲可能带来额外开销；
- 媒体和持续 DataChannel 并发时，传统 SCTP 的 loss-based controller 会争抢带宽，RoQ 的统一
  调度能让媒体接近分配目标，并降低平均延迟和抖动；
- 10 MB 延迟文件场景中，QUIC 按 50% 带宽保护媒体，文件平均耗时 38.77 秒，传统 WebRTC 为
  25.03 秒。这不是“QUIC 文件更快”，而是应用用较慢文件换取了媒体确定性；
- 文件结束后，媒体可以立即使用释放的连接预算，不需要再次从低码率爬升。

### 2.3 论文没有证明的内容

- 没有动态带宽、随机丢包、乱序、突发拥塞、Wi-Fi/蜂窝切换和长稳结果；
- 没有浏览器互操作、SFU 多订阅者、TURN、E2EE、simulcast/SVC、录制或大房间结果；
- 没有证明单机吞吐、CPU/内存效率或十万并发优势；
- 没有形成可以直接替换 WebRTC 的成熟标准和多端实现。

## 3. 与当前 Converact Fabric 的实际映射

| Converact Fabric 流量 | 当前数据面 | 是否命中论文问题 | 当前动作 |
| --- | --- | --- | --- |
| 麦克风、摄像头、屏幕共享 | LiveKit WebRTC/SRTP | 媒体本身由 WebRTC GCC 管理 | 保持生产链路 |
| LiveKit 控制/实时数据 | 当前参考 adapter 未向产品暴露 DataChannel | 暂无大数据竞争 | 后续控制消息只允许小包、有界频率 |
| IM 文本 | Tinode WebSocket | 与媒体共享接入链路但不是 SCTP | 保持独立 authority，不塞入媒体协议 |
| IM 附件/安全文件 | Converact Fabric HTTP 单次或 multipart upload | 会争抢用户上行带宽 | 增加媒体感知节流、暂停和恢复 |
| 录音/录像上传 | Egress 或节点 spool 异步上传 | 服务端出口可能与媒体竞争 | 保持独立池/NIC/队列，不进入 SFU 热路径 |
| RustDesk 控制与文件 | RustDesk 独立数据面 | 远控画面、输入和文件存在同类优先级问题 | 在 RustDesk 层做控制优先和文件限速 |
| SIP/PSTN RTP | RustPBX RTP，经 Kamailio 只走信令 | 运营商暂不支持 RoQ | 不改；RoQ 仅可做受控 SIP/SDP 实验 |

现有 SDK 已能提交 `rtt_ms`、`jitter_ms`、`packet_loss_ratio`、`bitrate_bps` 和质量级别，但参考
LiveKit 客户端目前只消费 `ConnectionQualityChanged`，没有周期采集 `RTCStats` 并形成可用于带宽
治理的本地快照。这是论文对当前系统暴露出的最直接代码缺口。

## 4. 生产路线：会话感知带宽治理

### 4.1 优先级

同一终端和同一 Cell 的默认优先级固定为：

1. 音频与呼叫保活；
2. 摄像头/屏幕媒体和媒体反馈；
3. 远控输入、授权、剪贴板小消息；
4. IM 文本、状态和审计事件；
5. 附件、远控文件、缩略图和后台同步；
6. 录制上传、OCR/ASR 导入和其他可延迟副本。

优先级只影响发送预算，不允许绕过权限、病毒扫描、审计、幂等或数据保留。

### 4.2 客户端 governor

新增的客户端 governor 应只依赖抽象的 media quality snapshot，不依赖 LiveKit 私有对象：

- 每 2 秒采集有界 RTCStats，按 `connection_revision + participant + track_source` 去重；
- 计算可用上传预算、RTT、jitter、loss、outbound bitrate、quality limitation reason；
- `good` 连续 3 个窗口后逐步放量，`poor/lost` 或屏幕共享启动后立即降低后台预算；
- 音视频 active 时，附件上传使用可取消的 multipart，限制并发 part 和每秒字节；
- 网络恶化时暂停未提交 part，不中断媒体，也不丢失 resumable upload 状态；
- 网络恢复后采用 additive increase，禁止一次恢复到全速造成二次拥塞；
- governor 失败时 fail-safe 到保守限速，不得阻止通话加入、重连或挂断。

初始策略不把带宽估计写成全局固定百分比。策略由质量窗口、媒体类型和管理员上限共同决定，且
不得把 tenant、call、room、participant 或文件 ID 放入 Prometheus 标签。

### 4.3 服务端隔离

- LiveKit SFU、TURN、Egress、附件上传和录制 intake 使用独立容量维度；
- SFU/TURN 的实时端口和 Egress/对象存储出口分别限速与告警，避免副本任务吃满节点 NIC；
- attachment/recording worker 使用 bounded queue、lease 和 backpressure；存储失败不回压 SFU；
- 多 Cell placement 依据媒体 bitrate、TURN relay bitrate 和上传 ingress 分开 admission，不能用一个
  CPU 百分比代表全部资源。

## 5. 实验路线：RoQ transport lab

实验放在独立进程、独立端口和独立镜像中，不修改生产 LiveKit 默认配置。建议使用论文同类技术栈
Pion + quic-go，并把所有 fork 固定到 commit、patch SHA-256、SBOM 和构建来源。

### 5.1 最小协议范围

- QUIC v1 + TLS 1.3 + DATAGRAM；
- 明确版本化 ALPN，不复用生产 LiveKit ALPN；
- RTP/RTCP flow ID、可靠 data stream ID 和控制 stream ID 有严格边界；
- 音频优先于视频，视频优先于可靠数据；关键帧和过期 delta frame 使用不同可靠性；
- 禁止对授权、文件提交、远控副作用使用可重放 0-RTT；
- 连接迁移后必须重新验证 tenant/session/owner epoch，不能只相信 QUIC connection ID；
- 每条 stream、connection、participant 和 Cell 都有内存、流数、速率和超时上限。

### 5.2 测试矩阵

| 维度 | 测试点 |
| --- | --- |
| 带宽 | 1、2、5、10、50 Mbit/s；运行中阶跃和锯齿变化 |
| RTT | 20、50、100、200、400 ms |
| 丢包 | 0、0.5%、1%、3%、5%，含 burst loss |
| 网络行为 | 乱序、重复、MTU 变化、NAT rebind、Wi-Fi/热点切换 |
| 负载 | 音频；摄像头；屏幕；音视频+控制；音视频+10/100 MB 文件；多订阅者 |
| 安全 | 伪 flow ID、stream flood、0-RTT replay、oversized datagram、token/epoch 漂移 |
| 运行 | 30 秒、30 分钟、8 小时；进程重启、Cell drain、观测系统失效 |

每组至少记录媒体 goodput、端到端 P50/P95/P99、jitter、freeze、NACK/PLI、文件完成时间、连接恢复
时间、CPU/内存、每 bit CPU 成本和 QUIC 控制开销。论文中的平均值不足以作为发布依据。

### 5.3 进入生产候选的门槛

RoQ 只有同时满足以下条件才可进入灰度：

- 所有目标客户端都支持，或者 capability negotiation 能稳定回退 WebRTC；
- 音频 P99 和视频 freeze 不劣于生产 WebRTC；
- 在并发文件/控制流时，媒体 P95 latency 或 jitter 至少改善 30%；
- 正常媒体场景 CPU/bit 增幅不超过 15%，单节点 safe capacity 没有显著下降；
- TURN/NAT、E2EE、simulcast/SVC、录制、QoS、重连、drain 和审计具备同等能力；
- 连续两轮 release-bound 多节点弱网证据通过，且没有用受控结果冒充物理容量。

任一条件不满足，生产继续使用 LiveKit WebRTC，实验状态保持 `not_run` 或 `failed`。

## 6. 对 MIX-100K / Cell 架构的影响

QUIC 不会自动提高单机 SFU 容量，也不会消除视频下行带宽这一物理约束。它可能降低连接数、统一
拥塞状态并改善弱网体验，但加密、ACK、stream 调度和用户态 pacer 也可能增加 CPU。容量模型必须
新增而不是合并以下维度：

- `media_quic_connections`
- `media_quic_datagram_pps`
- `media_quic_streams_active`
- `media_quic_egress_bps`
- `media_quic_pacer_queue_bytes`
- `media_quic_ack_timestamp_rate`

Cell 路由仍以 room owner 为边界；同一 room 不因单条 QUIC 路径波动而迁移 SFU。跨 Zone 或跨 Cell
迁移必须由更高 owner epoch、客户端重新协商和明确的恢复事件驱动。连接迁移只处理网络地址变化，
不能替代应用 owner fencing。

十万并发阶段首先优化现有 LiveKit 的 room affinity、小房间 fanout、UDP/TURN 路径、NIC/IRQ、
Egress 拆池和带宽 admission。RoQ 只有物理曲线证明“每节点 safe capacity 提升或同容量机器减少”
后，才计入容量主张。

## 7. 不采用的捷径

- 不把所有 IM 和附件迁入 LiveKit DataChannel；Tinode durable history、安全文件状态和审计仍是
  各自 authority。
- 不仅用 WebTransport 传文件就宣称解决了论文问题；媒体与数据仍是两个拥塞控制器。
- 不直接 fork 浏览器或要求客户安装私有浏览器作为第一版交付前提。
- 不把 QUIC 连接迁移描述为 SFU/room 无损迁移。
- 不因 QUIC 常用 UDP/443 就移除 TURN/TLS、ICE/TCP 或 WebRTC 回退。
- 不在缺少真实客户端和弱网证据时宣传“QUIC 更快”或“单机容量提升”。

## 8. 推荐后续目标

### Goal Q1：现有 WebRTC 竞争治理

实现 RTCStats 采集、QoS 本地快照、终端 upload governor、multipart 暂停/恢复、RustDesk 文件限速
接口、指标和 netem/浏览器自动化测试。该目标不改 LiveKit wire protocol，优先进入生产。

### Goal Q2：RoQ 可重复实验

固定 Pion/quic-go fork，复现论文三组基线并扩展动态弱网、屏幕共享、控制消息、100 MB 文件、资源
和安全测试；生成 source-bound evidence，不接生产用户。

### Goal Q3：LiveKit transport capability 评审

当 Q2 达标后，再评审 LiveKit Server、JS/Windows/其他客户端、信令 SDP/ALPN、TURN/E2EE/录制和
灰度回退的完整改造量。通过架构评审后才建立实现 Goal。

## 9. 上游依据

- 论文 DOI：`https://doi.org/10.1145/3822163.3827919`
- RTP over QUIC：`https://datatracker.ietf.org/doc/draft-ietf-avtcore-rtp-over-quic/`
- SDP Offer/Answer for RoQ：`https://datatracker.ietf.org/doc/draft-ietf-avtcore-sdp-roq/`
- QUIC receive timestamp：`https://datatracker.ietf.org/doc/draft-ietf-quic-receive-ts/`
- WebRTC 标准：`https://www.w3.org/TR/webrtc/`
- LiveKit realtime data：`https://docs.livekit.io/transport/data/`
- LiveKit self-hosted transport：`https://docs.livekit.io/transport/self-hosting/deployment/`

截至 2026-07-21，RoQ 与 SDP RoQ 文档仍处于 Internet-Draft 演进阶段，receive timestamp 也是
活跃草案；这些文档是实验设计输入，不是当前生产兼容性承诺。
