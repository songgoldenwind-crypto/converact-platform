# 通信底座 VOS5000 对标与 100K 性能优化完全体设计

> 文档状态：终态架构裁决与后续开发计划
>
> 更新日期：2026-07-26
>
> 适用范围：OPC 与 LED 共用的 iveKit 通信底座
>
> 不包含：LED 业务领域逻辑、移动端产品实现、真实 OCR/ASR/翻译供应商采购、双 Windows 物理机验收

## 1. 文档目的

本文把前面几轮通信底座升级、性能设计和 VOS5000 对标讨论收敛成一个可执行的终态方案。
它不是新的平行架构，也不是推翻现有 iveKit，而是回答以下问题：

1. 之前的 Wave 1、Wave 2、Wave 3 和 MIX-100K/Cell 架构哪些继续保留；
2. 现有 Kamailio + RustPBX 架构离运营级软交换底座还缺什么；
3. 单机如何尽量逼近 10,000 路全媒体并发；
4. 一套平台如何通过横向扩展达到 100,000 路通信并发；
5. 如何保证增加节点时边际效率不明显衰减；
6. 录音、录像、对象存储、ASR、OCR、翻译和 AI 故障如何不影响实时媒体；
7. 旧性能测试是否继续，以及哪些测试能形成真实容量结论；
8. 后续开发应该拆成哪些 Goal，每个 Goal 如何验收。

## 2. 最终结论

### 2.1 能否齐平 VOS5000 的底层能力

结论分成三层：

| 层级 | 结论 |
| --- | --- |
| 架构上限 | 可以设计到接近或齐平 VOS5000 类运营级软交换的信令、RTP Relay、录音隔离和横向扩展能力 |
| 当前代码能力 | 已具备较完整的控制面、Cell、Kamailio SIP Edge、RustPBX B2BUA、容量准入、录音隔离和自动化证据框架，但尚不能宣称 VOS5000 性能齐平 |
| 最终证明条件 | 必须完成独立 RTP 快速路径、完整 SIP/媒体互通、物理机调优和 VOS-EQ 压测矩阵，才能形成可对外使用的容量结论 |

现阶段正确的产品表述是：

> iveKit 已具备向 VOS5000 级通信底座演进的控制面和集群骨架，容量声明仍为 `none`，待终态媒体面和目标硬件证据完成后再更新。

### 2.2 当前架构是否需要改变

不需要推翻 Region/Zone/Cell、Kamailio、RustPBX 和 iveKit 控制面，但需要调整媒体职责。

保留：

- Region、双 Zone、Cell 的故障域和容量边界；
- Kamailio 作为 SIP Edge、接入、鉴权、限流、初始路由和 dialog 路由节点；
- RustPBX 作为 B2BUA、Call/Leg/Dialog 和逻辑媒体图权威；wire SDP/transport runtime
  由已分配媒体执行器权威；
- iveKit 的 placement、admission、lease epoch、owner fencing、signed snapshot 和审计体系；
- PostgreSQL、NATS JetStream、对象存储、HOMER、OpenTelemetry 和 VictoriaMetrics；
- LiveKit 作为 WebRTC 音视频、屏幕共享、Ingress/Egress、TURN 和视频 SFU；
- Tinode 作为 IM 数据面；
- RustDesk 作为桌面远控数据面；
- 外部/自建 Provider 的 OCR、ASR、翻译、TTS 和模型网关边界。

必须增加：

- 独立 RTP 快速转发层；
- 独立媒体处理与转码资源池；
- 独立录音节点和本地 NVMe spool；
- 以 PPS、codec pair、录音、AI tap 和 NUMA/NIC 队列为维度的媒体容量模型；
- 完整 SIP 互通、媒体质量、单机密度和多节点线性扩展验收。

必须禁止：

- 让 RustPBX 的通用业务线程处理所有 RTP 包；
- 在 SIP/RTP 热路径同步访问 PostgreSQL、NATS、Redis/Valkey、对象存储或外部 HTTP Provider；
- 用 Redis 迁移活跃 RTP 会话；
- 让录音上传、磁盘写入、ASR、OCR、翻译或审计反向阻塞媒体；
- 只依据平均 CPU、平均延迟或单一成功率形成容量声明；
- 把 4 vCPU 云主机的受控结果外推为 32 物理核生产结论。

## 3. 已完成的几轮优化如何合并

### 3.1 Wave 1：通信核心与安全

当前已经形成的基线：

- RustDesk、LiveKit、Tinode 等组件采用精确源码和自有 overlay/patch 管理；
- Kamailio 正式进入 SIP Edge；
- HOMER/HEP 采集具备故障隔离和高水位策略；
- NATS 客户端、JetStream 和消息边界已生产化；
- ClamAV、文件安全、SBOM、签名、漏洞扫描和 OCI 发布门禁已设计并部分受控验证；
- RustPBX 已有容量、owner epoch、route snapshot、录音热路径、HTTP client、WebPhone、实时音频 tap 等补丁。

这些工作继续保留，不重新实现。

#### 3.1.1 Wave 1 独立复核后的剩余项

Wave 1 已形成可用基线，但以下项目仍属于后续开发，不得记为“已完成”：

1. HEP 高水位控制器必须同时核对本进程期望状态、Kamailio 实际状态和进程代际；
   Kamailio 重启后不得因控制器内存仍记录旧 revision 而漏掉重放，启动阶段默认 fail closed。
2. 高水位采样和 RPC 必须串行化，禁止 `setInterval` 触发重入、相同 revision 并发提交或恢复/降级交错。
3. HOMER NetworkPolicy 必须显式允许 route-agent 访问指标端点，同时继续只允许指定 Kamailio
   来源发送 HEP。
4. Helm 必须对 HEP、高水位控制器和 NetworkPolicy 的组合做 fail-closed 校验，禁止生成看似启用、
   实际失去保护的部署。
5. 指标必须区分 `desired_mode`、`applied_mode` 和 `pending`；告警和容量证据只使用远端确认后的
   `applied_mode`。
6. 恢复判定必须要求有效 derivative 和 warm-up window；首个样本、计数器重置或缺失数据不能直接
   触发恢复。
7. HEP 采样桶边界必须按 `core_hash()` 的实际返回区间校准，避免 102 桶只命中 101 桶。
8. HEP evidence JSON、Markdown 和配置必须绑定同一个 SHA/配置 hash。
9. Compose、Helm 和运行时必须使用同一个显式 HOMER metrics endpoint，禁止从 host/port
   再拼接出不同地址。

这些剩余项纳入 Goal 9，并作为高负载测试前置门禁。HEP/HOMER 永远是旁路观测能力，其错误、
拥塞或重启不能改变 SIP/RTP 主路径的存活。

### 3.2 Wave 2：生产化与媒体扩展

当前已经形成的基线：

- LiveKit Server/Egress/Ingress/SIP 的精确源码和部署模板；
- Tinode 三节点部署、PostgreSQL bootstrap 和租户权威；
- Valkey Sentinel；
- CloudNativePG 与 PgBouncer；
- SeaweedFS S3 兼容对象存储；
- OpenTelemetry Collector；
- KEDA 固定 worker pool；
- VictoriaMetrics；
- 录音/录像存储故障不影响 LiveKit 房间和 RustPBX 媒体的设计合同。

这些能力是终态平台的支撑面，不允许进入 RTP 热路径。

### 3.3 Wave 3：智能内容与实时 Provider

Wave 3 的最终定位不是在通信节点部署大模型，而是建立低延迟、可替换、故障隔离的 Provider 通道：

- RustPBX/LiveKit 实时 PCM tap；
- 外部实时 ASR 和实时翻译 WSS 边界；
- 离线 ASR、OCR、视频抽帧 OCR 和 AI 质检任务；
- 第三方/自建 Provider 切换；
- Provider 健康、并发、配额、熔断、降级和故障切换；
- STT -> LLM -> TTS 低延迟流水线；
- 对话 partial/final projection；
- 音频 tap、翻译、AI 分析过载时优先丢弃辅助副本，不影响主媒体。

智能内容是媒体的旁路消费者，不是媒体会话的存活依赖。

### 3.4 性能合同

[RTC Performance Contract](../capacity/rtc-performance-contract-v1.md) 已覆盖以下核心指标：

- P50/P95/P99 端到端延迟；
- 抖动、丢包、冻结、A/V sync 和 MOS；
- 连接成功率、首帧、重连和网络切换；
- 消息可靠性、顺序、重复和补发；
- 背压、过载、公平性和 noisy tenant；
- 安全开销；
- 单连接资源、带宽和每千会话成本；
- 弱网、跨地域和故障注入；
- 单机到平台的扩展效率。

本文在该合同之上增加运营级语音媒体的 PPS、codec、转码、录音和 SIP 互通合同。

## 4. VOS5000 对标口径

### 4.1 输入数据的使用方式

对话中提供的 VOS5000 类配置作为 benchmark 输入，不直接视为已验证事实：

| 全媒体并发 | 用户提供的参考配置 |
| ---: | --- |
| 500 以下 | 4 核 8 GB 云主机或任意 CPU/16 GB 物理机 |
| 2,000 以下 | 8 核 16 GB 云主机 |
| 5,000 以下 | 16 核 16 GB；物理机参考单颗 16 核 2.5 GHz Xeon E5 v4 |
| 10,000 以下 | 32 核 32 GB；物理机参考双路 16 核 2.5 GHz Xeon E5 v4 |
| 10,000 以上 | 64 核 128 GB |
| 网卡 | Intel X5xx/X7xx；最终平台建议 25 GbE 起步 |
| PPS | 用户提供口径为每 1,000 路全媒体约 100,000 PPS，但未注明 RX、TX 或 aggregate |

PPS 必须按方向解释。G.711、20 ms packetization 下：

- 每条单向 RTP 流约 50 PPS；
- 一通双向电话进入 relay 约 100 RX PPS；
- relay 转发后约 100 TX PPS；
- 每 1,000 通约 `100K RX PPS + 100K TX PPS`；
- 每 10,000 通约 `1M RX PPS + 1M TX PPS`；
- 每 1,000 通 aggregate 约 200K PPS，每 10,000 通 aggregate 约 2M PPS。

基准报文采用 G.711 64 kbps、20 ms、RTP/UDP/IPv4：

- RTP payload 为 160 B；
- IPv4 包为 `160 + 12 RTP + 8 UDP + 20 IPv4 = 200 B`；
- 计入 Ethernet header、FCS、preamble/SFD 和 IFG 后，线速约 238 B/packet。

| 并发 | RX PPS | TX PPS | Aggregate PPS | IPv4 RX/TX | 线速 RX/TX | 线速 Aggregate |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 100K | 100K | 200K | 160 Mbps/方向 | 190.4 Mbps/方向 | 380.8 Mbps |
| 5,000 | 500K | 500K | 1M | 800 Mbps/方向 | 952 Mbps/方向 | 1.904 Gbps |
| 10,000 | 1M | 1M | 2M | 1.6 Gbps/方向 | 1.904 Gbps/方向 | 3.808 Gbps |

10K relay 的正确表达是：约 `1M RX PPS + 1M TX PPS`，全双工 NIC 每方向约 1.9 Gbps，
主机 RX+TX 记账约 3.8 Gbps。不能把 aggregate 3.8 Gbps 误写成单方向端口负载。

该基线不含 RTCP、RTX、VLAN、IPv6 和网络录音副本。SRTP 通常不增加 RTP 包数，但会增加每包
字节和加解密 CPU；最终 profile 必须单独测量。后续报告必须分别记录 RX PPS、TX PPS、
RX+TX aggregate、RX/TX bps 和线速口径。

### 4.2 角色节点参考

用户提供的另一组表格可暂时解释为：

| 角色 | 数量 | CPU | 内存 | 系统盘 | 数据盘 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 信令节点 | 3 | 16 核 | 32 GB | 200 GB | 小容量或无状态 |
| 媒体节点 | 3 | 24 核 | 48 GB | 200 GB | 需结合录音旁路复核 |
| 录音节点 | 3 | 16 核 | 64 GB | 200 GB | 约 16 TB 级 |

原始表格的数据盘列存在排版歧义，实施采购前必须用原表复核。架构结论不依赖具体数字：
信令、媒体和录音必须是独立容量池。

### 4.3 对标不是复制

VOS5000 类系统的能力来自信令、B2BUA、媒体、转码、录音、路由、计费和运维的整体协作。
iveKit 不复制其单体实现，而采用：

- 云原生控制面；
- Cell 本地实时数据面；
- RustPBX 的 Rust 控制能力；
- rtpengine 的成熟 RTP 快速路径；
- 独立 Rust 媒体处理能力；
- LiveKit 的 WebRTC 视频能力；
- 可替换 Provider 和统一治理。

## 5. 终态总体架构

```text
                         Global / Region Control Plane
                  placement, policy, config, audit, billing refs
                                      |
               Region Directory + signed snapshots / async events
                                      |
              +-----------------------+-----------------------+
              |                                               |
           Zone A                                          Zone B
              |                                               |
       +------+------+                                 +------+------+
       |   Cell A1   |                                 |   Cell B1   |
       |             |                                 |             |
  Anycast/L4/DSR                                     Anycast/L4/DSR
       |                                                     |
  Kamailio Edge Pool                                  Kamailio Edge Pool
       | SIP only                                            | SIP only
  RustPBX Control/B2BUA Pool                          RustPBX Control/B2BUA Pool
       | media graph + reservation control                    |
  RTP Fast Path Pool                                    RTP Fast Path Pool
  Cell A1 local only                                    Cell B1 local only
       |                                                     |
  +----+------------------+                             +----+------------------+
  |                       |                             |                       |
  Media Processing   Media Fork                        Media Processing   Media Fork
  + Transcoder       bounded policy                    + Transcoder       bounded policy
  Cell local              |                            Cell local              |
                    Recording Pool                                       Recording Pool
                    NVMe + uploader                                      NVMe + uploader
                          +-------------------+-------------------------------+
                                              |
                             Regional Cross-Zone Object Storage

  LiveKit/Tinode/RustDesk remain independent realtime data planes under
  the same Cell admission, observability, event and tenant authority model.

  Fault Domain C hosts quorum/witness/state replicas only; it does not
  carry the normal SIP/RTP/LiveKit/Tinode/RustDesk realtime load.
```

入口先由 Region Directory/L4 选择 Zone 和 Cell；Cell-local Kamailio 只能在本 Cell
选择 RustPBX。RTP fast path、media processing、transcoder 和 recording 也按 Cell/Zone
本地部署，正常媒体禁止跨 Zone。该规则延续现有 Kamailio release 固定
`(region, zone, cell)` 的边界；本文件新增的 rtpengine 媒体路径替代旧文档中“RTP 直达
RustPBX”的实现描述，其他 Cell 路由约束保持不变。

## 6. 组件职责

### 6.1 Kamailio

Kamailio 只负责 SIP Edge，不拥有业务呼叫：

- UDP/TCP/TLS/WSS 接入；
- SIP 消息合法性检查和拓扑隐藏；
- WebPhone Origin/JWT/identity 校验；
- ACL、限流、anti-flood 和黑白名单；
- REGISTER 路径和跨 Edge location；
- Region Directory/L4 已选定 Zone/Cell 后，本 Cell 初始 INVITE 的 RustPBX 选择；
- dialog route、Record-Route 和 Call-ID affinity；
- OPTIONS 探活；
- 预应答 failover；
- HEP 旁路采集；
- overload/503/Retry-After；
- 低基数指标。

Kamailio 不负责：

- Call/Leg 权威；
- 业务路由决策；
- RTP 包转发；
- 转码；
- 录音上传；
- AI/ASR/翻译。

Kamailio dispatcher 官方提供 round-robin、weight、relative weight、call-load 和属性哈希等算法，
但哈希算法不自动保证公平。因此 iveKit 不直接使用固定算法作为容量真相，而由 route-agent
根据签名容量快照编译相对权重，再由 component-node admission 做最终硬门。

参考：[Kamailio dispatcher 官方文档](https://kamailio.org/docs/modules/stable/modules/dispatcher.html)。

### 6.2 RustPBX

RustPBX 是语音会话和逻辑媒体图权威：

- Call、Leg、Dialog 和 provider session；
- B2BUA；
- offer/answer 策略、逻辑媒体图和 codec/security policy；
- trunk、extension、DID、route 和 LCR 结果执行；
- IVR、队列、转接、保持、恢复和桥接状态；
- 媒体资源预留；
- rtpengine/processing/transcoder 控制；
- DTMF、播放、采集和 AI tap 的控制；
- CDR 事实和 provider event reconciliation；
- owner epoch 和 dialog fencing；
- 录音策略与 evidence manifest。

RustPBX 不再承担所有 RTP 包的通用用户态复制。

### 6.3 RTP Fast Path

最终采用维护中的 rtpengine fork 作为 RTP 快速路径，优先使用内核转发：

- RTP/RTCP relay；
- IPv4/IPv6 和 NAT；
- SDP rewrite；
- SRTP/SDES/DTLS 边界；
- ICE-aware/ICE-unaware 桥接；
- QoS/TOS；
- DTMF；
- media fork；
- T.38；
- 必要时用户态转码；
- 内核不可用时受控降级到用户态，但降级后的容量声明必须单独计算。

rtpengine 负责已分配会话的 effective wire SDP、RTP/RTCP transport、ICE、DTLS/SRTP
运行态、端口、SSRC/sequence 连续性和内核转发表。rtpengine 官方文档说明了多线程、内核转发、
转码、media forking 和录音能力；iveKit fork 仍需增加 owner epoch、容量槽、低基数指标、
故障隔离和可重复构建门禁。

参考：

- [rtpengine 上游仓库](https://github.com/sipwise/rtpengine)

该链接只用于说明上游项目，不是源码身份。Goal 0 完成 source spike 后，exact source manifest
必须固定 commit/tag、archive SHA256、构建依赖和 patch base；任何 `master`/`main` 浮动引用
不得进入构建或容量证据。

### 6.4 Media Processing Pool

由 rustrtc/Rust 媒体服务承担必须解码或处理音频的会话：

- IVR 播放与采集；
- jitter buffer；
- packet reorder 和 duplicate suppression；
- packet loss concealment；
- DTMF RFC 2833/INFO/in-band；
- 音频混音和小型会议；
- AI PCM tap；
- 实时翻译旁路；
- 音量、静音和活动检测；
- codec negotiation 辅助；
- RTCP/XR 质量统计。

没有处理需求的 G.711 pass-through 呼叫不得进入该池。

### 6.5 Transcoder Pool

转码是独立容量资源，不与普通 relay 共用一个模糊 CPU 指标。

容量必须按 codec pair 预留：

- PCMU <-> PCMA；
- G.711 <-> G.722；
- G.711 <-> Opus；
- G.711 <-> G.729；
- G.711 <-> AMR-NB/AMR-WB；
- Opus <-> AMR-WB；
- T.38 <-> G.711；
- 单声道重采样和 8/16/48 kHz 转换。

每个 profile 记录：

- codec pair；
- packetization time；
- SRTP 与否；
- VAD/DTX 与否；
- 每会话 CPU；
- 每 NUMA node 安全槽位；
- P99 processing latency；
- 质量分数；
- license/capability 状态。

### 6.6 Recording Pool

Recording Pool 延续现有
[`ADR-CCAAS-3`](../adr/ccaas-3-recording-evidence.md) 的统一 `RecordingManifest` 和状态机，
覆盖 SIP、LiveKit A/V、screen、RoomComposite、RustDesk 和 IM attachment，不只覆盖 SIP fork。
录制节点是独立故障域：

- SIP 由 RTP fast path 产生有界 encoded media fork；
- LiveKit 使用 TrackEgress/Screen TrackEgress，少量 RoomComposite 独立调度；
- RustDesk 使用端侧加密 spool 和 evidence uploader；
- 录音节点写本地 NVMe spool；
- segment、checksum 和 owner epoch 先写本地恢复 journal；
- authoritative `RecordingManifest` 在 Region 跨 Zone durable store 中提交；
- 后台 uploader 上传对象存储；
- 上传成功后再执行保留、转码、缩略图、ASR/OCR 和 AI 质检；
- 磁盘高水位时停止新的 mandatory recording admission，并按已声明策略舍弃尚未 accepted 的
  非核心副本，不影响已建立主通话；
- 对象存储、数据库、scanner 或 Provider 故障不影响 RTP。

所有受管录制必须带 `consent_id`、`recording_mode`、`retention_until`、`legal_hold`、
`owner_epoch` 和 encryption key reference。mandatory/core recording 在 interaction 建立前
必须 reserve；资源不足时新 interaction fail closed。非核心录制可显式降级；已建立 interaction
遇到存储故障时主媒体继续，manifest 必须诚实收敛为 `partial`/`failed`。
已经 accepted 的 mandatory segment 不得覆盖、静默丢弃或只存在于可随 Cell 一同丢失的本地盘；
跨 Zone durable confirmation 完成前只能标记 `pending_unacknowledged`。

录制容量至少包含 spool bytes、segment rate、upload bps、object ingest IOPS、checksum、
TrackEgress、RoomComposite 和 evidence worker slots。8K 双轨 G.711 原始 payload 约
1.024 Gbps、约 11.06 TB/day，尚未计入封装、索引、副本、加密和工程余量；V2 的 recorder、
NVMe 和上传池必须按该量级独立预算。

终态将 SIP encoded fork 的执行 owner 从 ADR-CCAAS-3 初稿中的 RustPBX 调整为 rtpengine，
RustPBX 保留录音策略和逻辑媒体图权威；Region recording service 保留 authoritative manifest。
Goal 0 必须发布 ADR revision 固化该替代关系。对象存储是 Region 级跨 Zone 共享服务，不是
每个 Cell 自建对象存储孤岛。

实时线程禁止：

- `fsync`；
- 对象上传；
- 远程数据库事务；
- 病毒扫描；
- OCR/ASR；
- 同步生成完整录音文件。

## 7. 媒体控制协议

### 7.1 权威关系

权威必须分层，不能把逻辑意图和线上的传输事实混成一个“唯一 SDP 权威”：

| 层 | 权威 |
| --- | --- |
| Call/Leg/Dialog、业务状态和逻辑媒体图 | RustPBX |
| codec/security/recording/AI tap 策略 | RustPBX |
| effective wire SDP、端口、ICE、DTLS/SRTP、RTP/RTCP runtime | rtpengine |
| 被插入处理 hop 的 SSRC/sequence、jitter、DTMF、转码 runtime | Media Processing/Transcoder owner |
| 录音 segment、checksum、spool/upload 和 evidence state | RecordingManifest owner |

每个 media graph hop 都必须在协议中声明 ingress/egress、codec、SSRC/sequence owner、
DTMF owner、转码 owner、超时和故障结果。RustPBX 负责收敛这些执行事实，但不伪造执行器
已经提交的 wire state。

每个媒体命令必须包含：

- `tenant_id` 的不可逆内部句柄；
- `call_id`；
- `leg_id`；
- `cell_id`；
- `owner_node_id`；
- `owner_epoch`；
- `media_reservation_id`；
- `command_sequence`；
- `idempotency_key`；
- `expires_at`。

rtpengine 本地 agent 对 owner epoch 做 O(1) 校验。远程数据库或 Redis 不能参与每包校验。

### 7.2 命令

控制协议至少支持：

- `offer`；
- `answer`；
- `update`；
- `delete`；
- `query`；
- `block_media`；
- `unblock_media`；
- `start_forward`；
- `stop_forward`；
- `start_recording_fork`；
- `stop_recording_fork`；
- `play_media`；
- `stop_media`；
- `inject_dtmf`；
- `subscribe_quality`；
- `drain_node`。

### 7.3 超时和不确定结果

媒体命令返回以下结果：

- `committed`；
- `replayed`；
- `rejected_capacity`；
- `rejected_epoch`；
- `terminal_error`；
- `unknown`。

`unknown` 不能盲目重放副作用。RustPBX 先按 reservation/call/sequence 查询执行器状态，再决定收敛。

## 8. 热路径约束

### 8.1 SIP 热路径

允许：

- 本地内存结构；
- 预编译签名快照；
- 本地 unix socket；
- VOICE-HA-T1 profile 的 bounded same-Cell shadow quorum append；
- 受控 OPTIONS；
- 预分配对象池；
- 异步低基数计数器。

禁止：

- 动态 SQL；
- 同步 HTTP；
- 远程配置中心；
- 高基数日志；
- 每请求 JSON 大对象；
- 每请求全表扫描；
- 无界队列。

### 8.2 RTP 热路径

允许：

- kernel forwarding；
- per-core shard；
- lock-free 或 bounded queue；
- preallocated packet metadata；
- batch receive/send；
- local epoch lookup；
- sampled counters。

禁止：

- 每包日志；
- 每包分配大型对象；
- 全局 mutex；
- 每包跨 NUMA；
- 同步磁盘；
- 同步录音；
- 同步 AI；
- 同步数据库；
- 同步网络鉴权。

### 8.3 过载降级顺序

1. 保持现有音频；
2. 停止非必要实时翻译 partial；
3. 丢弃 AI/OCR/ASR 辅助副本；
4. 降低非核心录制优先级；mandatory recording 无容量时拒绝新的 interaction；
5. 限制转码新会话；
6. 拒绝新视频层；
7. 拒绝新媒体 admission；
8. 保持已建立且未故障的通话。

## 9. 容量模型

### 9.1 Capacity Vector

容量不能只用 CPU 百分比表示，也不能把不同节点上的资源假装成一个本地原子计数器。最终拆成
三类向量：

```json
{
  "interaction_demand": {
    "rtp_rx_pps": 100,
    "rtp_tx_pps": 100,
    "rx_bps": 190400,
    "tx_bps": 190400,
    "rtp_port_pairs": 2,
    "srtp_sessions": 0,
    "transcode.g711_opus": 0,
    "ivr_processing_slots": 0,
    "conference_mix_slots": 0,
    "recording_forks": 0,
    "recording_upload_bps": 0,
    "ai_tap_slots": 0
  },
  "role_supply": {
    "role": "rtp_fast_path|transcoder|recording|rustpbx",
    "safe_profile": "profile_hash",
    "available": {},
    "static_topology": {
      "cpu_cores": 0,
      "numa_nodes": 0,
      "nic_rx_queues": 0,
      "nic_tx_queues": 0
    }
  },
  "cell_delegated_quota": {
    "epoch": 0,
    "expires_at": "RFC3339",
    "role_limits": {}
  }
}
```

CPU core、NUMA node 和 NIC queue 是节点供给/拓扑属性，不按通话逐项扣减；逐通话只扣减
由已验证 profile 编译出的消费维度。跨池 reservation 采用显式 saga，不宣称分布式原子事务：

1. placement 从 Cell delegated quota 选择每个必需 role 的候选节点；
2. 对 RustPBX、RTP fast path、必需 transcoder 和必需 recording 执行 `prepare`，返回有 TTL
   的 reservation token；
3. durable coordinator 先记录 `prepared`，再写入唯一的 `commit_decision` 或 `abort_decision`；
4. 所有必需资源 prepare 成功后，状态进入 `committing` 并按固定顺序执行幂等 `commit`；
5. 前序 role 已 committed、后续 role 返回 `terminal_error` 时进入 `compensating`，按逆序执行
   幂等 `delete/release`；返回 `unknown` 时先查询事实，在超时上限内继续完成既定 decision，
   不允许把 commit 改成 abort 或创建第二份资源；
6. 只有所有必需 role 确认 committed 后状态才进入 `committed` 并创建权威 Call；全部补偿确认后
   进入 `aborted`；任何中间状态均由 journal 恢复和 sweeper 收敛；
7. 非必需录制、AI tap、RoomComposite 等返回
   显式 degraded capability，不阻止基础 interaction；
8. token 到期、owner epoch 变化或节点失联由 lease expiry 和 sweeper 回收；
9. durable reservation journal 记录 decision、prepare/commit/cancel/unknown 和补偿结果，恢复后
   与执行器逐项对账。

任一必需硬维度不足都拒绝 admission，不能先创建通话再赌资源。每个 Goal 必须验证取消顺序、
partial commit、补偿超时、未知结果收敛、泄漏回收和节点重启后的 reconciliation。

### 9.2 语音容量 Profile

| Profile | 固定工作负载 | 32 物理核终态安全目标 | 硬极限探索值 |
| --- | --- | ---: | ---: |
| V1-RTP | G.711 RTP pass-through、20 ms、无转码、无录音 | 10,000 calls | 12,000 calls |
| V1-SRTP | G.711 SRTP pass-through、20 ms、无转码、无录音 | 10,000 calls | 12,000 calls |
| V2 | G.711 SRTP、20 ms、100% 远端双流 RTP recording fork | 8,000 calls | 10,000 calls |
| V3-A | G.711 <-> Opus、20 ms、100% 双向转码 + IVR processing | 1,000 calls | 2,000 calls |
| V3-B | G.711 <-> G.729、G.711 <-> AMR-WB 等独立 codec pair | 每个 codec pair 单独签署 | 不复用 V3-A 结论 |
| V4 | AI tap + 实时 ASR/翻译旁路 | 由 tap 带宽和 Provider 槽位独立决定 | 不允许降低主媒体 V1/V2 SLO |

这些是目标，不是当前结论。只有目标硬件通过本文全部门禁后，`safe_capacity` 才能写入生产 profile。

每个 profile 必须固定并报告：

- codec pair、采样率、ptime、RTP/SRTP 和加密套件；
- IPv4/IPv6、RTCP、VLAN 和 NIC offload；
- RX PPS、TX PPS、aggregate PPS、RX bps 和 TX bps；
- recording 是本地写盘、单流 fork 还是双流远端 fork；
- 转码方向、IVR/混音比例、录音比例和 AI tap 比例；
- CPU/NUMA/NIC queue、内核、BIOS、镜像和源码 commit。

V2 的“远端双流 RTP recording fork”意味着每通额外产生约 100 TX PPS。以 8K 为例：
约 `800K RX PPS + 1.6M TX PPS = 2.4M aggregate PPS`；若实现改为本地抓包或其他复制方式，
必须建立新 profile，不能沿用 V2 容量。

### 9.3 单机资源目标

V1 参考节点：

- 32 个物理核心，关闭或单独报告 SMT 增益；
- 64 GB ECC RAM；
- 单 NUMA 优先；双 NUMA 时每个 RTP shard 固定 CPU、内存和 NIC queue；
- 25 GbE Intel X7xx 或同级多队列 NIC；
- RX/TX queue 数不低于媒体核心数的合理子集；
- 本地系统盘；
- 媒体节点不承载对象存储；
- IRQ affinity、RSS、RPS/RFS/XPS 按硬件证据配置；
- RTP 端口范围按并发和双 leg 明确计算；
- `nofile`、socket buffer、conntrack 和 ephemeral port 有显式上限。

Linux 官方文档将 RSS、RPS、RFS 和 XPS 定义为多处理器网络并行机制；若硬件 RSS 已按 CPU
正确分队列，额外 RPS 可能冗余，必须通过 profile 实测决定。

参考：[Linux Networking Scaling](https://www.kernel.org/doc/html/latest/networking/scaling.html)。

### 9.4 Cell-20K-VOICE-V1

`Cell-20K-VOICE-V1` 是纯语音 V1 relay profile，不等于混合业务 Cell：

- 3 台 V1 媒体节点；
- 每台安全容量 10K；
- Cell 正常 admission 上限 20K；
- 任意一台媒体节点故障后，剩余两台仍提供合计 20K admission capacity；
- 故障节点上的既有媒体可能中断，V1 不声明透明迁移；
- 新呼叫按剩余 headroom 决定是否接受；
- Cell 内 RustPBX 至少 3 实例；
- Kamailio 至少 2 实例，生产建议 3；
- Cell 本地 recording/transcoder 按 profile 独立扩展。

这里的 `N+1` 是节点容量 N+1，不是会话连续性 N+1。正常 20K 均匀分布时每台约 6.67K；
一台故障后，其既有会话不会自动搬到幸存节点，幸存节点只是有能力承接重建后的会话和新会话。
若要求既有媒体无损，需要另建每通 1+1 双发或媒体状态复制 profile，不由三节点容量预留自动获得。

### 9.5 VOICE-100K-V1

单 Zone 的 `VOICE-100K-V1`：

- 5 个 Cell-20K-VOICE-V1；
- 至少 15 台 V1 媒体节点；
- 等效工作容量为 10 台，Cell 本地冗余为 5 台，即平台物理口径是五组 `2+1`，不是全平台 N+1；
- Region 控制面不参与每包转发；
- 信令和控制节点独立计算；
- 录音与转码节点按业务比例独立计算。

理论最少 10 台 10K 节点只能表示无冗余裸容量，不是生产方案。终态设计采用 15 台媒体节点换取
Cell-local node-capacity N+1。它允许每个 Cell 最多损失一台容量节点，但不保证同一 Cell
连续损失两台、整个 Cell/Zone 故障后仍保有 100K，也不保证故障节点既有会话连续。
若硬件和内核优化把安全密度提升到 12K，仍需重新跑完整 profile，不能只修改配置。

该 15 台只证明一个 Zone 的纯 V1 语音安全容量，不证明带录音、监听、ASR 的 weighted voice，
更不证明 `MIX-100K-v1`。V2 单节点目标为 8K 时，三节点 Cell 在损失一台后只有 16K，
因此不得给 V2 沿用 `Cell-20K-VOICE-V1` 名称。

### 9.6 MIX-100K-v1 与双 Zone 语义

保留已批准的 [`MIX-100K-v1`](../MIX-100K双Zone与Cell架构评审.md) 和
[`ADR-CCAAS-2`](../adr/ccaas-2-dual-zone-quorum.md)：

- `MIX-100K-v1` 是 60K IM + 25K SIP voice + 10K A/V + 3K screen + 2K RustDesk 的
  互斥核心 workload，不是 100K 纯语音；
- voice 使用录音、监听/咨询和实时 ASR 的 weighted profile，不能用 V1 pass-through 直接换算；
- Zone A 和 Zone B 各自的 verified safe capacity 必须覆盖完整 `MIX-100K-v1`；
- 正常态 A/B 各承载约 50K；任一 Zone 故障后，幸存 Zone 接纳完整 100K 核心负载；
- Fault Domain C 承担 NATS/PostgreSQL/Valkey/Region Directory 的第三仲裁或见证，不承载
  大规模实时媒体；
- 故障 Zone 上已经建立的 RTP/RTC/远控会话仍可能中断；“接纳完整 100K”是 Zone-loss 后的
  新 admission capacity，不是既有会话透明迁移承诺。

若按 `VOICE-100K-V1` 构建同等 Zone-loss 能力，则 A/B 每区各需 5 个
`Cell-20K-VOICE-V1`，合计至少 30 台 V1 媒体节点。`MIX-100K-v1` 的实际节点数必须由每个
角色的实测 safe vector、weighted voice、LiveKit/Tinode/RustDesk 独立池和每 Zone 单节点故障
reserve 计算，不能从这 30 台数字推导。

## 10. 路由、负载与故障

### 10.1 初始路由

路由顺序：

1. Region placement snapshot 依据 tenant、profile、Zone/Cell headroom 和故障域选择 Zone/Cell；
2. L4/Anycast 将 SIP 流量送到已选 Cell 的 Kamailio；
3. Kamailio 验证来源、身份、速率和报文；
4. Cell route-agent 只提供本 Cell 内签名、短 TTL 的 RustPBX dispatcher snapshot；
5. Kamailio 仅从本 Cell `accepting` RustPBX 节点选择；
6. component-node admission 通过 prepare/commit/cancel saga 预留必需的 SIP、媒体、转码和
   录音容量；
7. reservation 成功后才创建权威 Call；
8. dialog 建立后固定 owner。

### 10.2 负载算法

最终算法是 capacity-aware weighted placement：

- 第一阶段的 Region placement 按 interaction demand profile 计算 Cell 可接纳性，不进入
  Kamailio dispatcher；
- 第二阶段的 RustPBX `rweight` 只在已选 Cell 内生效；
- dispatcher set/weight 按 admission profile 编译；V1、V2、V3、mandatory recording 和 AI tap
  不得共用一个全局“最小维度”权重；
- 节点 CPU 只是一个输入；
- stale snapshot 权重归零；
- draining 节点不接新呼叫；
- unhealthy 节点权重归零；
- admission 失败最多尝试第二候选；
- 不允许遍历全部节点造成重试风暴；
- 同租户大流量受 tenant budget 和 fairness gate 限制；
- Call-ID 哈希用于稳定性，不单独承担公平性。

### 10.3 故障语义

| 故障 | 已建立 interaction | 新 admission | 终态门槛 |
| --- | --- | --- | --- |
| Kamailio 单节点 | RTP 继续；TCP/TLS/WSS 连接重建；dialog 由其他 Edge 按共享 route state 接管 | L4 转到其他 Edge | SIP route RTO <= 3 s，不重复 B2BUA 副作用 |
| RustPBX owner 进程 | rtpengine 未故障时媒体继续；VOICE-HA-T1 profile 由新 owner 以更高 epoch 恢复控制 | 故障节点立即归零 | 仅对已完成 shadow commit 的 T1 会话声明 takeover RTO <= 5 s |
| RTP fast path 节点 | 该节点媒体中断；对支持端点发起 re-INVITE/ICE recovery，不宣称无损 | 新会话转到其他节点 | 恢复成功率、RTO 按 endpoint class 签署；orphan media <= 60 s 回收 |
| Recording 节点 | 主媒体继续；manifest 为 partial/failed 并保留已落盘 segment | 核心录制无 slot 时 fail closed；非核心录制显式降级 | spool RPO、segment 恢复和 checksum reconciliation 有证据 |
| 对象存储 | 主媒体继续，本地 spool 累积 | 按 spool/upload quota 决定录制 admission | 高水位前告警；耗尽前拒绝新的 mandatory recording interaction |
| PostgreSQL | 已建立媒体继续；本地签名快照和未确认恢复 spool 支撑有限离线窗口 | Region durable authority 不可用或 spool 高水位后 fail closed | grace、spool bytes/time 和恢复 reconciliation 进入 profile |
| NATS/Region durable store | 已建立媒体继续；未获跨 Zone ACK 的事实只写本地 `pending_unacknowledged` spool，telemetry 可采样丢弃 | 需要可靠事实的新 interaction fail closed | 只有 quorum-backed ACK 后才称 committed/RPO=0 |
| ASR/OCR/翻译/LLM | 主媒体继续，辅助任务 retry/failed | Provider admission 降级 | 不消耗主媒体保留容量 |

故障合同必须同时定义受影响范围、RTO、RPO、恢复成功率、re-INVITE/BYE 行为、CDR/cause、
reservation 清理和 orphan media 回收。RustPBX takeover 要同步修改当前 Kamailio 对离线
pinned owner 直接返回 481 的规则：只有确认 dialog 不存在或已终结才返回 481；可恢复窗口内必须
路由到 epoch 协调器或新 owner。

`VOICE-HA-T1` 必须在发送可见的 18x/200、状态改变的 in-dialog 2xx/NOTIFY 和 provider
commit ACK 之前，将 local/remote tag、route set、CSeq、branch/transaction final response、
auth context、offer/answer、media reservation、provider session 和 CDR event sequence 提交到
同 Cell 至少两个 RustPBX 故障域的 shadow quorum。该 bounded binary append 是 T1 profile
允许的 SIP 热路径依赖，必须计入延迟和容量；shadow quorum 不可用时停止新的 T1 admission。
未完成该提交的普通 profile 只能承诺媒体继续和 re-INVITE/重拨恢复，不能宣称 5 秒控制 takeover。

durable CDR、审计、计费事实、consent、manifest 和 outbox 与 best-effort telemetry 严格分开。
前者只有在 Region 跨 Zone quorum-backed store ACK 后才是 `committed` 且可声明 `RPO=0`；
Cell 本地 fsync 只是有界的 `pending_unacknowledged` 恢复 spool。同步 durable path 不可用时，
停止需要可靠事实的新 admission；既有 RTP 继续，未确认事实不得升级为 committed。spool 达到
高水位前必须停止新 admission，不能阻塞 RTP，也不能静默丢失。telemetry 可按已声明策略采样
或丢弃。

## 11. SIP 运营级完整性

当前 Kamailio 接入完成不等于全部 SIP 场景完成。最终互通矩阵至少覆盖：

### 11.1 基础事务

- INVITE/100/180/183/200/ACK/BYE；
- CANCEL race；
- non-2xx ACK；
- retransmission；
- UDP/TCP/TLS/WSS；
- DNS SRV/NAPTR/A/AAAA；
- OPTIONS；
- REGISTER refresh、expiry、Path 和 outbound；
- 401/407、nonce expiry、stale nonce、replay 和 credential rotation；
- offerless INVITE、late offer 和 ACK answer；
- oversized SIP message 和 fragmentation policy。

### 11.2 Early Dialog

- 183 + SDP early media；
- 100rel；
- PRACK；
- UPDATE；
- offer/answer glare；
- 491 retry 和随机退避；
- 多个 early dialog；
- forking 后多个 200 OK；
- late CANCEL。

### 11.3 Mid-dialog

- re-INVITE；
- UPDATE；
- hold/resume；
- codec change；
- media direction `sendrecv/sendonly/recvonly/inactive`；
- session timer；
- dialog owner takeover 和 epoch change；
- target refresh；
- Route/Record-Route；
- NAT 地址变化；
- dialog sequence 和 timestamp wrap。

### 11.4 转接和高级业务

- REFER；
- REFER/NOTIFY subscription state 和最终结果；
- Replaces；
- attended transfer；
- blind transfer；
- park/pickup；
- conference；
- monitor/whisper/barge；
- diversion/history-info；
- P-Asserted-Identity；
- privacy；
- 302 redirect；
- trunk failover；
- SUBSCRIBE/NOTIFY、MWI 和 BLF；
- Reason、Q.850 cause 和 SIP cause 双向映射；
- forked attempt、失败分支和最终接通分支的 CDR 收敛；
- 3xx/4xx/5xx/6xx 映射。

互通矩阵必须版本化。每个场景绑定自动化工具、输入报文、预期 SIP trace、媒体证据、
Call/Leg/Dialog 状态、CDR/cause 和资源清理断言；“人工打通一次”不算完成。

规范参考：

- [RFC 3311 SIP UPDATE](https://www.rfc-editor.org/info/rfc3311/)
- [RFC 3891 SIP Replaces](https://www.rfc-editor.org/info/rfc3891/)
- [RFC 4028 SIP Session Timers](https://www.rfc-editor.org/info/rfc4028/)

## 12. 媒体完整性

### 12.1 Codec

生产必需：

- PCMU；
- PCMA；
- G.722；
- Opus；
- telephone-event；
- T.38。

运营商扩展：

- G.729；
- AMR-NB；
- AMR-WB；
- EVS 仅在明确需求和许可条件满足时进入。

### 12.2 SDP

- payload type remap；
- `fmtp`；
- `ptime/maxptime`；
- multiple m-lines；
- RTCP mux/non-mux；
- ICE；
- DTLS fingerprint；
- SDES；
- IPv4/IPv6/NAT64；
- symmetric RTP；
- comedia；
- codec preference；
- transcoding policy；
- DTMF policy。

### 12.3 RTP/RTCP 质量

- sequence reorder；
- duplicate；
- late packet；
- burst loss；
- jitter buffer；
- packet loss concealment；
- NACK/PLI/FIR 适用场景；
- RTCP SR/RR；
- RTCP XR；
- MOS；
- one-way audio detector；
- no-media timeout；
- A/V sync 对 LiveKit；
- SRTP rekey、ROC、replay window 和长呼叫 rollover；
- ICE restart 和网络切换；
- SSRC change、collision 和 source validation；
- T.38 UDPTL、redundancy、ECM 和 fallback；
- long-call timestamp/sequence wrap；
- 2 小时 soak 和 24 小时 endurance。

## 13. 操作系统与网络优化

### 13.1 CPU/NUMA

- 识别物理核、SMT 和 NUMA；
- 媒体 worker 固定到 CPU set；
- NIC IRQ 与 media shard 对齐；
- 内存 local allocation；
- 控制线程与媒体线程隔离；
- 录音和上传线程不得抢占媒体核心；
- benchmark 禁止 CPU frequency governor 漂移；
- 记录 turbo、C-state、温度和 throttling。

### 13.2 NIC

- 多队列 RSS；
- RX/TX ring；
- IRQ affinity；
- RPS/RFS/XPS 是否启用由实测决定；
- GRO/LRO/GSO/TSO 对 UDP/RTP 的影响单独验证；
- offload 开关进入证据；
- MTU 和 fragmentation；
- RX drop、missed、no-buffer、softnet backlog；
- NIC queue fairness；
- 双网卡或 bond 的失败行为；
- 25 GbE headroom。

### 13.3 Socket

- `SO_REUSEPORT`；
- `recvmmsg/sendmmsg` 或等价 batch；
- socket receive/send buffer；
- UDP memory；
- `somaxconn`；
- `netdev_max_backlog`；
- `nf_conntrack_max`；
- file descriptor；
- port range；
- per-socket drop；
- bounded queue。

### 13.4 部署

媒体节点优先：

- bare metal 或固定独占 VM；
- `hostNetwork`；
- 不经过 Service Mesh；
- 不经过 kube-proxy NAT/conntrack 热路径；
- 静态 CPU manager；
- hugepage 仅在实验证明有效时启用；
- topology manager；
- local persistent spool；
- anti-affinity；
- PDB 不替代真实 N+1。

## 14. 可观测性

### 14.1 信令

- active dialogs；
- transactions；
- INVITE CPS；
- REGISTER/s；
- response code；
- retransmission；
- route P50/P95/P99；
- admission rejection reason；
- dispatcher destination state；
- WSS connection；
- TLS handshake；
- HEP drop；
- event-loop lag。

### 14.2 媒体

- active media sessions；
- RX/TX PPS；
- RX/TX bps；
- packet loss；
- reorder；
- duplicate；
- jitter；
- RTCP RTT；
- MOS；
- no-media；
- one-way audio；
- SRTP failure；
- transcode slots；
- per codec pair CPU；
- recording fork drop；
- kernel/user-space mode；
- NIC/softnet drops。

### 14.3 标签纪律

Prometheus 标签禁止：

- tenant ID；
- call ID；
- phone number；
- IP address；
- room ID；
- provider request ID。

高基数关联进入可采样 trace、HOMER 或受保护事件存储，不进入常驻 metrics。

### 14.4 机器可校验的指标合同

除信令和媒体指标外，合同必须覆盖：

- 每个 role/profile 的 safe、reserved、used、headroom 和 rejection reason；
- reservation prepare/commit/cancel/unknown、lease expiry、leak 和 reconciliation；
- owner epoch reject、takeover RTO、orphan media 和 CDR convergence；
- recording spool bytes/time headroom、segment rate、upload bps、object ingest、checksum failure；
- durable journal bytes/time headroom、replay lag 和 overflow admission stop；
- control queue depth/age、dropped best-effort telemetry 和 backpressure；
- NIC queue/ring、IRQ、softnet、NUMA remote access 和 CPU throttling；
- generator/SUT NTP offset 和 evidence clock quality。

每项指标在版本化 schema 中固定 type、unit、label allowlist、bucket、窗口、聚合和告警门槛；
CI 校验 dashboard/alert 只引用合同中的指标。Goal 验收必须注入已知故障并自动断言告警、
故障域分类和 runbook 路径；“人工能在五分钟内看出来”不能单独作为验收证据。

## 15. 安全和合规

- SIP ACL、mTLS、WSS JWT 和 trunk credential；
- topology hiding；
- anti-flood；
- per source/per tenant/global CPS；
- malformed SDP；
- RTP source learning 的严格策略；
- SRTP replay window；
- media hijack 防护；
- DDoS 与 UDP amplification 防护；
- management/control protocol 使用 mTLS 和短期 token；
- owner epoch 防止 stale node 写入；
- 录音 consent、retention、legal hold 和访问审计；
- HEP/日志脱敏；
- SBOM、签名、provenance、漏洞门禁；
- STIR/SHAKEN 作为运营商接入扩展 Goal，不阻塞基础 SIP/RTP 性能。

## 16. 性能验收合同

### 16.1 VOS-EQ 与 VOICE Profile 门槛

下表只适用于新建的 `VOS-EQ-*`、`Cell-20K-VOICE-V1` 和 `VOICE-100K-V1`，不覆盖既有
`MIX-100K-v1` 机器合同：

| 指标 | 门槛 |
| --- | --- |
| 呼叫成功率 | >= 99.99%，所有 attempted calls 保留在分母并完成 reconciliation |
| 新呼叫错误率 | <= 0.01%，过载点除外 |
| RTP 丢包 | 平台新增丢包 < 0.1% |
| Relay 新增延迟 | P99 < 10 ms，同机/同 Region 受控链路 |
| SIP route latency | P95 < 50 ms，P99 < 100 ms |
| PDD | 场景化，P95 < 300 ms，P99 < 500 ms |
| Jitter | 平台新增 P99 < 10 ms |
| 已建立通话保护 | 录音/存储/Provider 故障导致的媒体终止数必须为 0 |
| CPU 正常态 | <= 70% 总体，媒体核心不得持续 > 80% |
| NIC | 无持续 ring/softnet drop |
| 内存 | 2 小时无持续增长；24 小时无泄漏趋势 |
| 队列 | 所有队列有上限，过载行为可解释 |
| 线性扩展 | 每个相邻区段 marginal efficiency >= 95%，同时校验 aggregate、adjacent drop 和失败 reserve |

generator 或对端未达到资格门槛时，整轮标记 `invalid_generator_capacity`，不得事后删除失败样本
再形成 pass。VOS-EQ 和 VOICE-100K 必须新增机器可读 profile/finalizer，并复用现有 MIX
合同的证据原则：

- attempted/connected/failed/active 全量 reconciliation；
- 固定 workload、SUT、硬件、commit、image 和 failure reserve；
- 每个正式点至少三次独立重复；
- aggregate efficiency、逐区段 marginal、adjacent drop 和尾延迟公式；
- generator CPU/NIC/queue/clock qualification。

`MIX-100K-v1` 必须严格使用现有 JSON 中的 workload、owner、阈值、70% endurance、
component marginal、降级顺序、profile ID 和 SHA。本文终态把 RTP/recording owner 改为
rtpengine/RecordingManifest 后，必须发布新的 `MIX-100K-v2` 或更高 revision，并重新生成
机器合同和全部证据；不得在保留 `MIX-100K-v1` 名称/hash 的同时改变语义。

### 16.2 单机 Profile

| Campaign | Primary SUT | 固定辅助拓扑 | 可签署结论 |
| --- | --- | --- | --- |
| VOS-EQ-5K | 16 物理核 RTP fast-path node | 独立 SIP/RTP generator、RustPBX control 有充足 headroom | V1-RTP 5K fast-path density；500K RX + 500K TX PPS；约 0.952 Gbps 线速/方向 |
| VOS-EQ-10K | 32 物理核/64 GB/25 GbE RTP fast-path node | 独立 generator、RustPBX control | V1-RTP/V1-SRTP 分别 10K fast-path density；1M RX + 1M TX PPS；约 1.904 Gbps/方向 |
| VOS-EQ-V2-FP | 32 物理核 RTP fast-path node | 独立 recorder pool 必须未饱和 | 8K SRTP + 双流 recording fork 的 fast-path density |
| VOS-EQ-V2-REC | 独立 recorder node，规格由 Goal 5 profile 固定 | 独立 fast-path fork generator | ingest PPS/bps、NVMe spool、segment、checksum、upload/object ingest capacity |
| VOS-EQ-V3-PROC | 32 物理核 processing/transcoder node | 独立 fast-path 和 generator 必须未饱和 | V3-A 1K processing slots，探索 2K；其他 codec pair 单独签署 |

每个 Campaign：

1. 预热 10 分钟；
2. staircase；
3. 每档稳定 15 分钟；
4. frontier 2 小时；
5. 候选 `safe_capacity` 在对应机器合同的资源门槛内完整运行 24 小时；
6. 注入进程、NIC、磁盘、对象存储和控制面故障；
7. 输出硬件、内核、BIOS、NIC、容器、源码 commit 和镜像 digest。

`safe_capacity` 可以根据 frontier 和工程余量推导，但 24 小时 endurance 必须运行完整
`safe_capacity`，不能再乘一次 70%。frontier 只用于探索硬极限，不直接进入生产 profile。

### 16.3 扩展 Profile

- 1 节点基线；
- 2 节点；
- 4 节点；
- 8 节点；
- Cell-20K-VOICE-V1 节点容量 N+1；
- 单 Zone VOICE-100K-V1；
- 双 Zone VOICE-100K-V1 zone-loss；
- 原批准 workload 的 MIX-100K-v1；
- A/B 各完整 MIX-100K-v1 + Fault Domain C；
- noisy tenant；
- 单大租户与多小租户；
- 录音比例 0/25/50/100%；
- 转码比例 0/10/25/100%；
- SRTP 比例 0/50/100%；
- 20/30/40/60 ms ptime；
- 长呼叫和高 CPS 混合。

录音 0/25/50/100%、转码 0/10/25/100%、SRTP 0/50/100% 等比例扫描分别生成独立 profile ID
和 hash，只用于寻找曲线与边界；它们不能替代 `MIX-100K-v1` 固定的 workload 比例。

## 17. 旧性能测试是否继续

结论：继续，但重新分类，不重复把旧测试当成最终容量证明。

### 17.1 必须继续的回归

- Kamailio 1K/1.25K 受控信令；
- RustPBX direct 与 Kamailio path 对照；
- PCMU 10/600/800 受控 RTP；
- HOMER HEP fail-open、高水位和保留；
- recording ENOSPC/对象存储中断；
- LiveKit join、首帧、TURN、弱网、重连、带宽和公平性；
- Tinode 单机/复合 workload；
- Provider latency、fallback 和实时 tap；
- Cell admission、owner epoch、drain 和 failover。

这些测试是 L0/L1 回归门，不因为终态架构增加 rtpengine 就删除。

### 17.2 不再接受的结论

- 4 vCPU 服务器结果不能宣称 VOS5000 齐平；
- generator bound 不能宣称被测系统达到该容量；
- controlled same-host 不能宣称公网 QoE；
- 只测 SIP 486/503 不能宣称完整通话容量；
- 只测 RTP echo 不能宣称 B2BUA + relay + recording 完整容量；
- 平均 CPU 低不能宣称尾延迟和稳定性通过；
- 单节点通过不能宣称 100K 横向扩展通过。

### 17.3 当前服务器的用途

当前服务器继续用于：

- 回归；
- 构建；
- fault injection；
- 小规模 staircase；
- 自动化证据；
- 配置和容器验证。

它不用于：

- 32 物理核 VOS-EQ-10K 证明；
- 25 GbE PPS 证明；
- 多 NUMA/NIC queue 证明；
- 双 Zone 100K 证明。

## 18. 后续开发 Goal

以下 Goal 都服务于同一个终态架构，不是临时替代方案。

### Goal 0：源码 Spike、测试骨架与观测 Schema

目标：

- 在冻结媒体控制协议前验证上游 rtpengine/RustPBX/rustrtc 的真实能力边界，并先建立后续 Goal
  共用的可观测和测试骨架。

交付物：

- rtpengine 精确 commit/tag、archive SHA256、依赖和许可证清单；
- offer/answer/delete/query、recording fork、SRTP、ICE、DTLS 和转码 source spike；
- SIPp/RTP/media simulator 最小 harness；
- metrics contract v1、capacity evidence schema 和 profile/finalizer skeleton；
- Call/Leg/Dialog/media graph/RecordingManifest 权威边界 ADR；
- Kamailio、RustPBX、rtpengine 和 recording 的 failure matrix；
- upstream compatibility、patch queue 和 rollback 方案。

验收：

- 不使用浮动分支构建；
- spike 覆盖内核转发、用户态降级和不确定命令结果；
- 测试骨架能产生可 reconciliation 的 attempted/connected/failed/active 证据；
- metrics schema 固定 type、unit、label、bucket 和 clock metadata；
- 后续协议不存在依赖上游实际上不支持的隐含动作。

### Goal 1：媒体权威与控制协议

目标：

- 固化 RustPBX -> RTP fast path 的 owner/reservation/epoch/sequence 协议。

交付物：

- 版本化协议 schema；
- RustPBX client；
- media-node agent；
- idempotency 和 unknown reconciliation；
- mTLS/token；
- metrics；
- simulator；
- OpenAPI/SDK 内部合同。

验收：

- stale epoch 100% 拒绝；
- command replay 不重复副作用；
- prepare/commit/cancel/lease-expiry 和 unknown reconciliation 可重复验证；
- control plane 中断不影响已建立 media；
- 10 万 reservation 模型内存有界；
- 无 tenant/call 高基数 metrics。

依赖：Goal 0。

### Goal 2：rtpengine 精确源码与 iveKit fork

目标：

- 引入精确 commit 的 rtpengine，建立可维护 fork 和 OCI 供应链。

交付物：

- exact source manifest；
- overlay/patch queue；
- kernel module 与 userspace 镜像；
- amd64/arm64 构建；
- SBOM/Trivy/sign/provenance；
- owner epoch；
- capacity slot；
- drain；
- low-cardinality metrics；
- deterministic config；
- Helm/Compose。

验收：

- overlay 幂等；
- build `--network=none`；
- source/image identity 可证明；
- kernel unavailable 时明确降级；
- basic RTP/RTCP/SRTP/recording fork 通过。

依赖：Goal 0、Goal 1。

当前实现状态（2026-07-26）：

- exact source、五个维护补丁、离线 userspace 构建、TCP NG、owner fence、
  drain/capacity、低基数指标、持久 replay、Compose/Helm 和供应链证据已实现；
- 精确 userspace 镜像通过 120/120 精确源码门禁、20/20 真实
  RTP/RTCP/SDES-SRTP 与控制故障回归；
- finalizer 将旧镜像尝试保留为 identity mismatch，只晋级精确包清单镜像；
- 当前状态为 `implemented`，不是 `production_pass`；
- kernel、recording、transcoding、七项故障矩阵、签名和物理容量仍为
  `not_run`，因此 `benchmark=not_run`、`capacity_claim=none`。

机器证据：
[`../evidence/goal2-rtpengine-final-evidence-2026-07-26.json`](../evidence/goal2-rtpengine-final-evidence-2026-07-26.json)。

### Goal 3：RustPBX 媒体编排接入

目标：

- RustPBX 继续拥有 Call/Leg/Dialog 和逻辑媒体图，但将 wire SDP/transport runtime 与普通 relay
  交给 RTP fast path。

交付物：

- offer/answer/update/delete；
- re-INVITE；
- early media；
- hold/resume；
- DTMF；
- media timeout；
- reservation lifecycle；
- failure reconciliation；
- dialog shadow journal、owner takeover 和 Kamailio epoch routing；
- dual-leg CDR；
- route snapshot 与 media owner 绑定。

验收：

- 完整基础呼叫；
- CANCEL/PRACK/UPDATE；
- RustPBX owner 故障时媒体继续，控制 takeover 满足第 10.3 节；
- fast path 故障结果可解释；
- RustPBX 不同步依赖远程数据库完成每包处理；
- 录音和 AI tap 不回压主媒体。

依赖：Goal 0、Goal 1、Goal 2。

当前 IVR 连续性约束（2026-07-29）：

- 不新增第二套 IVR，也不迁移既有 IVR API、流程图、菜单、Provider、超时、转接、队列回退
  和 Call/Leg/Dialog 权威；
- 仅当既有 `app_name=ivr` 会话冻结为 processing profile 时，RustPBX 才以
  owner-fenced `offer -> commit_single_leg` 把媒体执行交给 `voice-media-rs`；
- processing pool 返回真实 caller-facing SDP，不制造 callee leg；worker 永久抑制未使用的
  B-leg 输出和转码，但继续消费 caller RTP，以执行 RFC 4733、SIP INFO、barge-in 和 gather；
- play、gather、stop、timeout、DTMF 与 terminal event 复用同一 owner epoch/command
  sequence；终态事件先进入 durable handoff，再确认 processing source；
- processing prepare/commit 失败时 fail closed，不静默退回本地媒体或 bypass；
- conference、voicemail、queue、WebRTC、recording、audio tap、offerless 和非 IVR application
  保持原路径。

源码证据：`ivekit.38` 已从固定 RustPBX/rsipstack/rustrtc 上游提交按生产顺序完整重放 38
个补丁；干净 RustPBX 库回归为 `1,911 passed / 0 failed / 1 ignored`，rsipstack 定向回归
为 `3 passed / 0 failed`。这证明既有 IVR 与非 IVR 代码回归通过，不代表服务器真实 RTP、
进程重启、过载或容量验收完成；这些仍为 `not_run`。

### Goal 4：媒体处理与转码池

目标：

- 把必须解码的媒体处理从 pass-through relay 分离。

交付物：

- codec registry；
- codec pair capacity；
- jitter/reorder/PLC；
- resampler；
- DTMF；
- IVR playback/gather；
- conference/mix；
- T.38；
- per-codec benchmarks；
- quality tests。

实现按可独立验收的 vertical slice 推进：先 G.711/Opus + IVR，再 G.729，再 AMR-NB/WB，
最后 T.38；每个 slice 都有 codec/ptime/direction/media graph/quality/capacity 合同。

验收：

- V3 1K 安全容量；
- P99 processing latency 达标；
- codec quality 不低于预设 MOS/PESQ/POLQA 门槛；
- 转码过载只拒绝新转码，不影响 V1 relay。

依赖：功能实现依赖 Goal 3；任何 V3 capacity 签署还依赖 Goal 7。

### Goal 5：统一录制与证据平面

目标：

- 以 ADR-CCAAS-3 的统一 `RecordingManifest` 完成 SIP、LiveKit、screen、RoomComposite、
  RustDesk 和 IM attachment 的录制/证据闭环。

交付物：

- recording daemon/fork consumer；
- LiveKit Egress 和 RustDesk evidence uploader adapter；
- segment/manifest/checksum/encryption；
- Cell-local recovery journal + Region cross-Zone authoritative manifest；
- owner epoch；
- local spool；
- uploader；
- high-water policy；
- consent、recording mode 和 mandatory/core admission；
- retention；
- legal hold；
- ASR/OCR/AI evidence import；
- recovery tool。

验收：

- 对象存储停止、磁盘满、uploader 崩溃时主媒体终止数为 0；
- 录音结果明确为 complete/partial/failed；
- 恢复后可续传；
- 不重复生成 evidence；
- legal-hold 与删除竞争、崩溃 segment 和 checksum reconciliation 有自动化证据；
- accepted mandatory segment 不覆盖、不静默丢弃；
- SIP V2 8K、LiveKit TrackEgress、screen 和 RustDesk 分别签署角色容量；
- mandatory recording 无资源时新 interaction fail closed，非核心录制显式降级。

依赖：功能实现依赖 Goal 2、Goal 3；容量签署还依赖 Goal 7。

### Goal 6：SIP 运营级互通

目标：

- 把 Kamailio + RustPBX 从“主路径可用”提升为完整运营级协议矩阵。

交付物：

- SIPp 场景库；
- pjsip/baresip/WebPhone/运营商模拟器；
- PRACK、UPDATE、REFER、Replaces、session timer；
- offerless/late offer、491 retry、401/407 replay；
- REFER-NOTIFY、SUBSCRIBE/NOTIFY/MWI/BLF；
- Reason/Q.850 和 forked-attempt CDR；
- forking；
- NAT/IPv6；
- T.38；
- long-call；
- malformed/fuzz；
- compatibility report。

验收：

- 本文第 11 节每项都有自动化 SIP trace、媒体和 CDR/cause 证据；
- 无状态泄漏；
- dialog owner 一致；
- 错误码和 CDR 一致；
- Kamailio failover 不重放已提交 B2BUA 副作用。

依赖：Goal 0、Goal 3；涉及 codec/T.38 的 slice 依赖 Goal 4。

### Goal 7：内核、NIC 与 NUMA 性能包

目标：

- 形成可重复的 VOS-EQ 主机调优和审计工具。

交付物：

- hardware inventory；
- BIOS/governor audit；
- IRQ/RSS/RPS/RFS/XPS planner；
- socket/sysctl planner；
- CPU pinning；
- NUMA placement；
- hostNetwork 模板；
- preflight；
- rollback；
- before/after evidence。

验收：

- 所有优化可审计、可回滚；
- 无“万能 sysctl”；
- 1/2/4/8 节点配置一致；
- VOS-EQ-5K/10K 可重复。

依赖：Goal 2。

### Goal 8：容量准入与路由升级

目标：

- 把现有 Cell capacity vector 扩展到媒体 PPS、codec、recording 和 NUMA/NIC。

交付物：

- interaction demand、role supply 和 Cell delegated quota schema v2；
- profile compiler；
- component-node probe；
- route-agent weight；
- prepare/commit/cancel/lease-expiry reservation saga；
- durable reservation journal、unknown reconciliation 和 leak sweeper；
- tenant fairness；
- Cell-20K-VOICE-V1；
- VOICE-100K-V1；
- 保持原 workload 的 MIX-100K-v1 和 A/B 各完整容量 profile。

验收：

- 任一资源维度不足均 fail closed；
- reservation 不泄漏；
- stale observation 权重归零；
- N+1 失败时不超卖；
- static NUMA/NIC topology 不被伪装为逐通话原子槽；
- marginal efficiency 门槛进入 finalizer。

依赖：schema 可在 Goal 0、Goal 1 后实现；profile 签署依赖 Goal 3 至 Goal 7。

### Goal 9：可观测性和自动诊断

目标：

- 形成按 SIP、RTP、codec、NIC、录音和 Cell 定位问题的统一证据。

交付物：

- 机器可校验 metrics contract；
- Prometheus/VictoriaMetrics；
- RTCP/XR；
- HOMER；
- OpenTelemetry control trace；
- Grafana dashboards；
- SLO alerts；
- one-way/no-media detector；
- capacity evidence pack；
- secret-safe handoff。

验收：

- 5 分钟内定位信令、媒体、网络、录音或 Provider 故障域；
- metrics 无高基数；
- HEP/trace 故障不影响呼叫；
- Kamailio 重启后控制器按远端实际状态和进程代际重放 HEP 模式；
- HEP 控制循环无重入，warm-up/计数器重置不误恢复；
- `desired_mode`、`applied_mode` 和 `pending` 可区分，告警只依据已确认状态；
- Helm/NetworkPolicy/Compose 的 HEP 组合和 endpoint fail closed 且一致；
- HEP 采样桶边界、evidence SHA 和配置 hash 受自动化合同测试保护；
- reservation、journal、spool/upload、epoch/takeover、per-pool headroom、queue 和 NTP offset
  指标完整；
- 已知故障注入能自动命中正确告警、故障域和 runbook；
- evidence 可绑定 commit、image digest、profile hash 和硬件。

依赖：Goal 0 定义 schema；Goal 1 至 Goal 8 各自实现并通过对应观测 DoD。Goal 9 是持续横切
工作，不在最后一次性补监控。

### Goal 10：独立压测 Fleet 与物理质量证据

目标：

- 建立不会被 generator 饱和、同机干扰或时钟漂移污染的独立压测基础设施。

交付物：

- caller、callee、generator、SUT 的独立主机/boot domain 拓扑；
- SIP CPS open-loop/closed-loop generator；
- RTP/SRTP/media/recording generator 与 receiver；
- 物理 mouth-to-ear、jitter、loss、MOS/PESQ/POLQA collector；
- 跨地域/弱网 fleet；
- NTP/PTP offset 采集；
- generator CPU/NIC/queue qualification；
- 可定时的进程、节点、NIC、Zone、存储和 quorum 故障注入；
- 三次重复、全量 reconciliation 和机器可读 invalidation。

验收：

- generator/receiver 在目标点保留明确 headroom；
- generator 不合格时整轮自动标记 `invalid_generator_capacity`；
- attempted call 不可事后从分母删除；
- 故障注入时刻、恢复时刻和证据时钟可关联；
- 相同 profile 三次重复结果在预设误差内。

依赖：Goal 0、Goal 7、Goal 9。

### Goal 11：VOS-EQ 与 100K 正式验收

目标：

- 形成可对外使用的单机和平台容量结论。

交付物：

- VOS-EQ-5K；
- VOS-EQ-10K；
- V2/V3；
- 1/2/4/8 scaling；
- Cell-20K-VOICE-V1 节点容量 N+1；
- 单 Zone VOICE-100K-V1；
- 双 Zone VOICE-100K-V1 zone-loss；
- 原批准 workload 的 MIX-100K-v1；
- A/B 各完整 MIX-100K-v1 + Fault Domain C；
- 24 小时 endurance；
- CAPEX/每千并发成本；
- capacity claim 签署记录。

验收：

- 每个交付物通过自身绑定的机器合同；`MIX-100K-v1` 不使用 VOS-EQ 门槛冒名覆盖；
- generator 独立且未饱和；
- 被测节点无持续 NIC/softnet drop；
- 所有 failure injection 结果符合第 10.3 节；
- 报告明确区分节点容量冗余、既有会话连续性和 Zone-loss capacity；
- 原始数据、脚本、日志、hash 和结论可复核；
- 每个结果明确标记 `component_pass`、`cell_pass`、`platform_pass`、`external_not_run`
  或 `production_pass`；
- 未通过的 profile 保持 `capacity_claim=none`；
- 本文排除的真实 PSTN/公网 TURN/生产对象存储/OCR-ASR-翻译 Provider/双 Windows endpoint
  未运行时，最高只能签署 `platform_pass + external_not_run`；
- 只有上述外部环境全部通过，才允许完整 `production_pass`。

依赖：Goal 0 至 Goal 10。

## 19. Goal 执行顺序

推荐依赖顺序：

```text
Goal 0
  |
  +--> Goal 10 测试骨架
  \--> Goal 1 --> Goal 2
                    +--> Goal 3 --> Goal 4/5/6
                    +--> Goal 7
                    \--> Goal 9 (持续横切)

Goal 3..7 --> Goal 8 profile 签署
Goal 7 + Goal 9 --> Goal 10 完整 fleet
Goal 0..10 --> Goal 11 正式验收
```

可以并行：

- Goal 4 与 Goal 5；
- Goal 6 的场景库与 Goal 3；
- Goal 7 与 Goal 3；
- Goal 9 的指标实现、dashboard 和 fault assertion 与所有功能 Goal；
- Goal 10 的 fleet 构建与 Goal 4/5/6。

不能提前：

- 未完成 Goal 0 不冻结协议或引入浮动 rtpengine 源码；
- 未完成 Goal 1 不进入正式 rtpengine 编排；
- 未完成 Goal 7 不做 VOS-EQ-10K 声明；
- 未完成 Goal 3 至 Goal 7 不签署 Goal 8 的 production profile；
- 未完成 Goal 9/10 不签署容量结论；
- 未完成 Goal 11 不使用“齐平 VOS5000”作为对外承诺。

## 20. Definition of Done

整个计划完成必须同时满足：

1. RustPBX、rtpengine、rustrtc、Kamailio 的 source identity 和 patch queue 可重复；
2. SIP 互通矩阵完整；
3. 普通 RTP relay、SRTP、转码、IVR、录音和 AI tap 各有独立容量；
4. 录音、存储和 Provider 崩溃不影响已建立媒体；
5. 单机 VOS-EQ-10K 通过；
6. Cell-20K-VOICE-V1 节点容量 N+1 通过；
7. VOICE-100K-V1 与原 workload MIX-100K-v1 分别通过，不混用容量结论；
8. 2/4/8 节点扩展效率达标；
9. A/B 每区完整 MIX-100K-v1 safe capacity 和 Fault Domain C 仲裁通过；
10. 24 小时 endurance 无泄漏和持续 drop；
11. 所有报告绑定 commit、镜像 digest、profile hash、硬件和原始证据；
12. SDK、API、事件、Webhook、部署、运维和 LED 对接文档同步；
13. 未实际运行的环境项明确标记 `not_run`；
14. 只有签署后的 profile 可以更新 `safe_capacity` 和对外容量声明；
15. 所有 attempted calls 完成 reconciliation，generator 不合格的整轮结果自动失效；
16. 每个 Goal 同步交付指标、告警、故障注入和 runbook，不把可观测性拖到最后补做；
17. 外部依赖未验收时最多为 `platform_pass + external_not_run`，不得写成 `production_pass`。

## 21. 架构决策记录

| 决策 | 结果 | 原因 |
| --- | --- | --- |
| Kamailio 是否处理 RTP | 否 | 保持 SIP Edge 轻量，避免信令和媒体故障耦合 |
| RustPBX 是否继续处理所有 RTP | 否 | 通用用户态媒体循环难以稳定达到目标 PPS |
| 是否引入 rtpengine | 是，维护 fork | 成熟内核转发、SDP、SRTP、fork、录音和转码基础能显著缩短差距 |
| rvoip 是否整体替换 RustPBX | 当前否，选择性提取 | 尚缺 iveKit owner/recovery/CDR/media-control 合同和发布级 carrier topology；详见 ADR-CCAAS-7 |
| RustPBX 是否失去媒体权威 | 否 | RustPBX 保留 Call/Leg/Dialog 和逻辑媒体图；wire SDP/transport runtime 由执行器权威 |
| 是否使用 Redis 迁移活跃媒体 | 否 | RTP 会话有本地 socket、sequence、crypto 和 kernel state，不能靠共享 KV 无损迁移 |
| 录音是否与媒体同进程 | 否 | 存储故障必须隔离 |
| 是否所有呼叫都转码 | 否 | pass-through 优先，转码是独立昂贵资源 |
| Kubernetes 是否走 Service Mesh | 媒体面禁止 | 额外 NAT、conntrack、sidecar 和抖动不利于 PPS 与尾延迟 |
| 当前 4 vCPU 服务器是否继续使用 | 是 | 用于回归和故障注入，不用于 VOS-EQ 容量证明 |
| 旧测试是否删除 | 否 | 保留为回归基线，容量结论由新 profile 替代 |
| VOICE-100K 与 MIX-100K 是否同一 profile | 否 | 前者是纯 V1 relay，后者是已批准的多业务 weighted workload |
| 双 Zone 是否各自保留完整 100K | 是 | 延续 ADR-CCAAS-2，不降低既有 Zone-loss admission 承诺 |

## 22. 与现有文档的关系

- [MIX-100K 双 Zone 与 Cell 架构评审](../MIX-100K双Zone与Cell架构评审.md)：
  继续作为 Region/Zone/Cell 和 100K 控制面基础。
- [CCaaS 十万并发容量调研](../CCaaS十万并发容量对标与架构优化调研.md)：
  继续作为竞品和容量单位背景；本文给出语音媒体终态。
- [RTC Performance Contract](../capacity/rtc-performance-contract-v1.md)：
  继续作为统一 QoE 合同；本文增加 VOS-EQ 和媒体容量维度。
- [Kamailio SIP Edge Design](kamailio-sip-edge-design.md)：
  继续作为 SIP Edge 详细设计；本文明确其不拥有媒体。
- [iveKit V3 Completion Audit](../ivekit-v3-completion-audit.md)：
  继续记录 implemented/controlled/not_run 事实。
- [rvoip 替换与能力提取审计](../adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)：
  固定 rvoip 的技术定位、可提取能力、禁止重复 runtime 的边界和未来替换门槛。

本文是后续 Goal 的总入口。若其他文档与本文在媒体职责、容量口径或故障语义上冲突，以本文终态裁决为准，
但实现状态仍以 completion audit 和机器可读 evidence 为准。
