# Cell-10K 校准预算、最小部署与退出门槛

> 状态：Target / Not Run
> 版本：1.0
> 日期：2026-07-16
> 负载合同：[`profiles/cell-10k-v1.json`](profiles/cell-10k-v1.json)
> 效率合同：[`targets/mix-100k-efficiency-v1.json`](targets/mix-100k-efficiency-v1.json)
> 压测架构：[`../adr/ccaas-5-distributed-load-generation.md`](../adr/ccaas-5-distributed-load-generation.md)

## 1. 文档定位

Cell-10K 是单节点和多节点容量的第一把校准尺，不是固定生产 Cell 规格，也不是要求现实部署预装一套 10K 或 100K 的机器。

本文做三件事：

1. 把 `cell-10k-v1` 转换为每个组件必须承受的连接、CPS、PPS、码率、录制、对象写入和 Provider 负载。
2. 定义如何根据实测 `C_safe` 计算最少节点，不提前捏造服务器数量。
3. 定义 Cell-10K 何时可以退出并进入 Cell-25K/100K 曲线。

本文所有派生数字都是负载预算，不是容量通过结果。任何节点数在单节点基准前都只能是实验起点。

## 2. 精确 interaction 预算

```text
6,000 Tinode IM topics
+ 2,500 SIP voice calls
+ 1,000 LiveKit 1:1 A/V rooms
+   300 LiveKit standalone screen rooms
+   200 RustDesk remote sessions
= 10,000 pairwise-disjoint active interactions
```

| 类型 | Interactions | Participants | 备注 |
| --- | ---: | ---: | --- |
| Tinode IM | 6,000 | 12,000 | 8,000 logical identities，6,000 active topics |
| SIP voice | 2,500 | 5,000 | 两腿基线，10% 监听/咨询重叠 |
| LiveKit A/V | 1,000 | 2,000 | 两人都发 audio + camera |
| LiveKit screen | 300 | 600 | 1 screen publisher + 1 subscriber |
| RustDesk | 200 | 400 | 授权会话，活跃画面更新 |

LiveKit 的 30% A/V overlay screen 和 SIP 第三方监听/咨询是派生媒体负载，不增加 interaction total。

## 3. 连接与业务速率

| 维度 | Cell-10K target |
| --- | ---: |
| Tinode WebSocket | 9,000 |
| iveKit event WebSocket | 5,000 |
| SIP registrations | 2,500 |
| SIP over WSS | 1,000 |
| LiveKit participants | 2,600 |
| RustDesk endpoints | 400 |
| SIP steady INVITE CPS | 14 |
| SIP burst INVITE CPS | 100 for 60s |
| IM steady messages/s | 500 |
| IM burst messages/s | 2,000 for 60s |
| Hot topic | 1,000 subscribers * 10 msg/s |
| Reconnect storm | 20% clients in 60s |

500 msg/s 中：

- 95% 1:1，5% group。
- 10% 带附件引用，即平均 50 attachments/s。
- attachment 平均 512KiB、P95 5MiB、最大 25MiB。
- 平均原始附件吞吐约 25MiB/s，不含 multipart、复制、扫描和 derivative。

## 4. SIP/RTP 预算

### 4.1 基线

```text
2,500 calls
5,000 base RTP legs
PCMU 64kbps payload per direction
20ms packetization = 50 packets/s/direction
40 bytes IP/UDP/RTP header baseline
```

每个方向每条 leg：

```text
64kbps payload + 50 * 40 * 8 = 80kbps
```

5,000 legs：

```text
400Mbps ingress
400Mbps egress
800Mbps aggregate host/network payload + headers
```

10% call 增加一个临时第三媒体参与人，约 250 extra legs：

```text
20Mbps ingress + 20Mbps egress
```

所以基础 RTP 网络包络约 840Mbps aggregate。再预留 SRTP/RTCP/VLAN/tunnel、retransmission、burst 和测量余量，首轮 NIC admission envelope 使用至少约 1.1Gbps，但最终以 packet capture 和 CapacityVector 为准。

### 4.2 PPS

基线 RTP packet operations：

```text
5,000 legs * 50 packets/s * 2 directions = 500,000 packet/s
```

加 250 extra legs 后约 525,000 packet/s，未含 RTCP、SIP、kernel/tunnel operations。RustPBX 单节点优化必须同时报告 packets/s/core，不能只看 Mbps。

### 4.3 Voice recording

50% voice 录双腿独立编码 track：

```text
1,250 recordings
* 2 legs
* 64kbps
= 160Mbps
= 20MB/s
= 72GB/hour
= 1.728TB/day at full-day peak steady
```

30 分钟对象存储故障窗口需要至少 36GB 原始 voice spool；按 2 倍安全系数和 segment/manifest 开销，Cell voice recording pool 初始预留不低于 72GB 可用 NVMe。真实值由 segment/container 和重试实测修订。

### 4.4 Realtime ASR fork

20% voice 即 500 concurrent realtime ASR streams。音频 fork 不允许等待 Provider；Provider 不可用时进入 post-call queue。

## 5. LiveKit SFU/TURN 预算

### 5.1 Published/subscribed tracks

A/V：

```text
2,000 camera publishers
2,000 audio publishers
2,000 subscribed camera tracks
2,000 subscribed audio tracks
```

Screen：

```text
300 standalone screen publishers
+ 300 A/V overlay screen publishers
= 600 screen publishers

600 subscribed screen tracks
```

合计：

```text
4,600 published tracks
4,600 subscribed tracks
```

### 5.2 平均码率

profile 已固定：camera `1.5Mbps` 是一个 publisher 所有 simulcast layers 的 aggregate encoded payload，不是单层码率。

一个方向 publisher payload：

```text
camera: 2,000 * 1.5Mbps = 3,000Mbps
audio:  2,000 * 0.032Mbps =   64Mbps
screen:   600 * 2Mbps =     1,200Mbps
total:                         4,264Mbps
```

1:1 subscriber 复制得到近似相同 egress：

```text
4.264Gbps ingress
4.264Gbps egress
8.528Gbps aggregate SFU encoded payload
```

加入 25% 的协议、RTCP、重传、码率波动和测量 envelope，平均媒体网络预算约 10.66Gbps。

### 5.3 Screen peak

600 screen publisher 从 2Mbps 升到 4Mbps：

```text
extra 1.2Gbps ingress + 1.2Gbps egress
```

SFU aggregate peak payload 约 10.928Gbps，未含 TURN 和协议 envelope。

### 5.4 TURN

20% LiveKit participants 经过 TURN，即 520 participants。TURN 的实际额外 NIC/PPS 取决于这些 participants 所拥有的 track，不能只用人数乘平均值。

首轮粗 envelope：

```text
TURN aggregate forwarding ~= 20% * SFU aggregate
```

平均约增加 1.706Gbps，screen peak 约增加 2.186Gbps。加入 25% envelope 后，SFU + TURN pool 的网络预算约：

```text
average ~= 12.8Gbps
screen peak ~= 16.4Gbps
```

这说明 25GbE 是 LiveKit media node 的起始硬件级别，不代表一台 25GbE 节点已经满足 CPU、PPS、node-loss 和 headroom。

强制 100% TURN 是独立 profile，不能从 20% 结果线性猜测。

## 6. LiveKit Egress 预算

### 6.1 TrackEgress

20% A/V interactions：

```text
200 selected A/V rooms
* 2 participants
* (1 audio + 1 camera track)
= 800 concurrent A/V TrackEgress jobs
```

20% standalone screen interactions：

```text
60 concurrent screen TrackEgress jobs
```

共 860 TrackEgress jobs。

编码 payload 写入：

```text
A/V: 200 * 2 * (1.5Mbps + 0.032Mbps) = 612.8Mbps
screen: 60 * 2Mbps = 120Mbps
TrackEgress total = 732.8Mbps = 91.6MB/s
```

### 6.2 RoomComposite

1% A/V rooms：

```text
10 concurrent RoomComposite jobs
* 2.5Mbps average output
= 25Mbps = 3.125MB/s artifact payload
```

LiveKit 官方给出的 RoomComposite 常见 CPU 范围为每 job 2-6 CPU，因此 10 jobs 的实验包络是 20-60 CPU。必须使用独立 pool，实际 CPU 由 layout、codec、resolution 和 browser runtime 实测。

### 6.3 Egress 合计

```text
757.8Mbps
= 94.725MB/s artifact payload
```

不含 container、multipart、checksum、重试、对象存储复制、病毒扫描和 derivative。TrackEgress CPU/内存不能从码率直接推导，必须做单 worker density benchmark。

30 分钟完整 Egress spool 原始 payload 约 170.5GB；按 2 倍安全系数，分布式 Egress spool pool 起始 envelope 约 341GB 可用 NVMe。

## 7. RustDesk 预算

### 7.1 Sessions

```text
200 active sessions
400 endpoints
40% relay = 80 hbbr relay sessions
```

profile 的 RustDesk 码率是一个方向 application payload，hbbr host ingress + egress 约为 2 倍。

### 7.2 Office average

```text
80 * 0.8Mbps * 2 = 128Mbps aggregate relay NIC payload
```

### 7.3 High-motion peak

```text
80 * 24Mbps * 2 = 3.84Gbps aggregate relay NIC payload
```

### 7.4 Forced relay profile

100% relay：

```text
office average: 200 * 0.8 * 2 = 320Mbps
high-motion peak: 200 * 24 * 2 = 9.6Gbps
```

10% RustDesk local recording 即 20 concurrent recordings。按 office average 粗算 artifact payload 为 16Mbps/2MB/s；high-motion 录制和编码格式另设峰值窗口。

## 8. IM、文件与安全流水线

### 8.1 Tinode

核心维度：

```text
9,000 WebSocket
6,000 active topics
500 msg/s steady
2,000 msg/s burst
10,000 hot-topic deliveries/s
receipts + presence + typing
native edit/delete mutation
```

必须分别报告 inbound messages/s 和 fanout deliveries/s。只用 500 msg/s 作为 Tinode 吞吐会严重低估 hot topic 和 group fanout。

### 8.2 Attachments

```text
50 attachments/s
average 512KiB
= 25MiB/s raw intake
```

每个对象经过：

```text
multipart intake
-> true MIME
-> archive policy
-> malware scan
-> quarantine/promotion
-> thumbnail/transcode
-> OCR
```

scanner、object ingest 和 derivative worker 必须以 bytes/s、objects/s 和 queue age 三维 admission。

### 8.3 OCR

`ocr_attachment_ratio=100%`，所以 controlled OCR 路由要承受 50 files/s steady。真实 OCR Provider 未验证时只能得到 routing/backpressure pass。

## 9. Provider 与异步智能预算

### 9.1 Translation

20% business messages：

```text
500 * 20% = 100 translation messages/s
```

### 9.2 Post-call ASR

平均 call duration 180s，steady 约 14 call completions/s；80% 进入 post-call ASR。双腿音频的持续输入包络约：

```text
14 calls/s * 80% * 180 audio-s/call * 2 legs
~= 4,032 audio-seconds per wall-second
```

若按精确 `2,500 / 180` 使用未取整 CPS，则约 4,000 audio-s/s。Provider/自建 worker 可以延迟处理，但长期平均处理吞吐低于输入就会无限积压。

### 9.3 AI quality

`ai_quality_interaction_ratio=100%` 表示 10,000 interactions 最终都进入质量策略；它不是要求在同一秒调用 10,000 次模型。调度按 channel completion/message window 产生 durable jobs，并单独定义 backlog completion SLO。

### 9.4 实时与异步隔离

- realtime ASR 500 streams 有独立 quota/pool。
- post-call ASR、OCR、translation、AI quality 使用 durable queue。
- Provider 熔断和 quota 不得阻塞 SIP/RTP、LiveKit、Tinode ack 或 RustDesk control。

## 10. 对象写入与 spool 总包络

平均 artifact/intake 下界：

| 来源 | 平均 payload |
| --- | ---: |
| Voice dual-leg recording | 20MB/s |
| LiveKit Track/Composite Egress | 94.725MB/s |
| RustDesk office recording | 2MB/s |
| IM attachments | 25MiB/s，约 26.214MB/s |
| 合计 | 约 142.94MB/s |

这是单副本、未计协议/重试/扫描/derivative 的下界。满峰持续一天约 12.35TB raw payload，但现实生产应按业务时段和 duty cycle 计算月均，不能把峰值日直接乘 30。

30 分钟 outage 的 raw spool 约 257GB；按 2 倍 envelope 约 514GB，分布在 RustPBX、Egress、RustDesk edge 和 file intake 节点。spool 不能集中到一个共享盘形成单点。

## 11. 硬件校准级别

首轮统一记录物理 CPU 型号、频率、NUMA、内存通道、NIC、NVMe、kernel、IRQ 和容器限制。建议从以下可比较 class 起步：

| Class | 起始规格 | 适用 |
| --- | --- | --- |
| `RT-32` | 32 physical cores、128GiB、25GbE、local NVMe、no overcommit | RustPBX、LiveKit SFU/TURN |
| `NET-16` | 16 physical cores、64GiB、25GbE、local NVMe | SIP Edge、Tinode、iveKit WS、hbbs/hbbr |
| `WORKER-32` | 32 physical cores、128GiB、25GbE、>=1.92TB NVMe | TrackEgress、RoomComposite、recording/file workers |
| `DATA-32` | 32 physical cores、256GiB、25GbE、enterprise NVMe | shared PostgreSQL/NATS/Redis benchmark nodes |

这些不是采购要求。每个角色还要比较 16/32/64-core class：

- 32->64 core 的每核 safe density 若明显下降，先查 NUMA、lock、scheduler、memory bandwidth。
- 大节点减少服务器数，但 blast radius 和单节点恢复时间也增加。
- 选择使“每主机 safe capacity”和“每核效率”同时合理的 class，不默认越大越好。

## 12. 不预设节点数

### 12.1 角色负载向量

对角色 r，Cell-10K 需求是向量：

```text
D_r = {
  interactions,
  connections,
  CPS,
  PPS,
  Mbps,
  recording_slots,
  queue_rate,
  spool_bytes,
  ...
}
```

单节点 benchmark 得到 `C_safe_r(1)`，多节点得到 `C_safe_r(n)`。

### 12.2 Compact 最少节点

```text
N_compact(r) = min n where every dimension of C_safe_r(n) >= D_r
```

Compact 不包含完整 node/Zone failure reserve，必须标注可用性等级。

### 12.3 HA Cell 最少节点

```text
N_ha(r) = min n where C_safe_r(n after one node loss) >= D_r
```

不是简单的 `N_compact + 1`：如果 placement 不均、NIC/recording/spool 成为 dominant dimension，实际 survivor capacity 必须实测。

### 12.4 双 Zone

每个 Data Zone 的 core realtime pool 都按完整目标 core load 的 survivor capacity 配置。RoomComposite、AI 后处理等 deferable pool 可以在 Zone failure 时暂停新 admission，但必须持久化和审计降级。

## 13. 装箱规则

可以共用通用 node pool：

- SIP Edge。
- iveKit API/WS/event gateway。
- Tinode signaling（在 benchmark 证明无 noisy-neighbor 后）。
- hbbs。
- 轻量 projector/worker。

默认 dedicated/Guaranteed：

- RustPBX RTP/recording。
- LiveKit SFU/TURN。
- hbbr high-motion relay。
- TrackEgress/RoomComposite。
- shared data storage。
- 自建实时 ASR/GPU。

不允许 page cache、GC、RoomComposite browser 或病毒扫描抢占实时媒体 CPU/NUMA/NIC queue。

## 14. 校准阶段

### B0：Generator

- 每个 fleet safe generation capacity >=目标 150%。
- worker runtime <=自身 safe capacity 70%。
- 无 generator packet drop、timer drift 和 shard overlap。

### B1：单节点 upstream baseline

对每个角色求 `C_hard(1)` 和 `C_safe(1)`，输出 dominant resource 与密度。

### B2：单节点 fork candidate

使用相同 hardware/profile 比较 upstream 与 iveKit fork。每个源码改动有 flamegraph 和前后结果。

### B3：垂直 class

比较 16/32/64 physical cores，选择最佳 per-host safe capacity，同时记录 per-core retention。

### B4：水平 node pool

运行 1/2/4/8 点：

- aggregate linearity 95%/93%/91% floor。
- 每区段 marginal efficiency >=90%。
- 相邻区段下降 <=3 个百分点。

### B5：Mixed Cell-10K

所有通道、连接、媒体、录制、文件和 controlled Provider 同时达到 profile，不是各组件结果相加。

### B6：Failure

- owner node failure x3。
- Cell drain/failure x3。
- reconnect 20%/60s。
- PostgreSQL/Redis/NATS/object storage faults。
- 无 durable message/event/audit/evidence loss。

### B7：成本收敛

根据实测 `C_safe_r(n)` 重新计算最少节点和每 1,000 interaction 成本。优先优化占服务器/成本最大的 2 个角色，再重复 B2-B6。

## 15. 重点优化顺序

实际顺序由首次 budget report 决定，不能凭偏好固定。首轮特别关注：

1. LiveKit TrackEgress 的 860 jobs 和 RoomComposite 20-60 CPU 包络。
2. LiveKit SFU/TURN 约 12.8Gbps average/16.4Gbps screen-peak network envelope。
3. RustPBX 525k RTP packet/s、1,250 dual-leg recordings 和 500 realtime ASR forks。
4. object/file/evidence 约 143MB/s intake 与 30 分钟 spool。
5. post-call ASR 约 4,000 audio-s/s sustainable input。
6. Tinode hot-topic fanout 和 14,000 combined IM/event WS。
7. RustDesk forced-relay high-motion 9.6Gbps 独立 profile。

任何一个成为 dominant cost 时，都可以按 fork ADR 修改源码或拆分 worker；不能关闭功能降低预算。

## 16. Cell-10K 退出门槛

只有同时满足以下条件才从 pilot 进入更高 Cell 密度：

### 16.1 负载

- 10,000 distinct active interaction IDs 精确达到。
- 派生 connections、CPS、messages、tracks、bitrate、recording 和 Provider rates 达标。
- 2 小时 steady、60 秒 burst、70% 24 小时 endurance。

### 16.2 单节点

- 每个容量关键角色有 `C_hard/C_safe`。
- 所有必需单位资源密度已输出。
- production headroom >=20%。
- 相对上一 candidate 无超过 3% 的无解释 safe-density 回归。

### 16.3 扩展

- component pool 1/2/4/8 曲线通过。
- mixed Cell placement 无热点和全局广播。
- shared data plane 在 Cell-equivalent load 下无明显曲线弯折。

### 16.4 故障

- 单节点故障后 survivor capacity 仍满足 core load。
- stale owner epoch 无副作用。
- drain 不接受新 interaction，旧 interaction 有界完成/重建。
- durable loss count 为 0。

### 16.5 证据

- profile、fork manifest、artifact digest、hardware、generator 和 fault timeline 绑定。
- controlled 与真实环境状态分开。
- 所有 `not_run` 保持原样，不人工改 pass。

## 17. Cell-25K 与 100K

Cell-10K 通过后不立即按十个 Cell 宣称 100K。先根据最大的单节点/角色余量提高 Cell profile：

```text
Cell-10K
  -> optimize dominant roles
  -> Cell-15K/20K candidate
  -> Cell-25K candidate
```

100K 所需 Cell 数：

```text
ceil(100000 / measured Cell safe capacity)
```

如果 Cell-25K 达标，理论 endpoint 是 4 个 active-capacity Cell；双 Zone failure reserve、rolling upgrade 和 data quorum 另算。最终报告必须同时给出：

- active Cell 数。
- reserve Cell/node 数。
- 物理服务器总数。
- 每千并发成本。
- 单节点密度。
- Cell marginal efficiency。

## 18. 结论

Cell-10K 的价值不是提前告诉我们要买多少台服务器，而是把每一类真实负载换算成可测 CapacityVector，再用单节点 frontier 和 scaling curve 算出最少节点。

现实业务可以只运行很小的 Compact 或 HA Standard 拓扑；100K benchmark 则验证架构在继续增加节点/Cell 时不出现明显边际衰减。只要单节点 safe density 持续提高、Cell 增量保持接近 95%，未来即使业务增长到 100K，也是在同一底座上扩展，而不是重新换架构。
