# ADR-CCAAS-5：分布式通信负载生成与证据可信性

**Status:** Proposed（2026-07-16）
**Decision owner:** Converact Fabric shared communication foundation
**Related:** [`../capacity/README.md`](../capacity/README.md)、[`../capacity/profiles/cell-10k-v1.json`](../capacity/profiles/cell-10k-v1.json)、[`../capacity/profiles/mix-100k-v1.json`](../capacity/profiles/mix-100k-v1.json)、[`ccaas-1-cell-placement.md`](ccaas-1-cell-placement.md)、[`ccaas-4-open-source-fork-governance.md`](ccaas-4-open-source-fork-governance.md)

## 1. 背景

MIX-100K 同时包含 SIP/RTP、Tinode IM、Converact Fabric event WebSocket、LiveKit A/V/屏幕/TURN/Egress、RustDesk rendezvous/relay/文件和录制，以及 OCR/ASR/翻译/AI 异步负载。单个压测进程无法真实产生这些流量，也很容易比被测平台更早耗尽 CPU、网卡、文件句柄或调度器。

如果 generator 已饱和，会出现危险的假象：

- 服务端 CPU 很低，看起来还有大量容量。
- CPS、message rate 或 bitrate 实际低于 profile，但并发连接数字已经达到目标。
- generator event loop 延迟导致客户端超时，被误判为服务端延迟。
- 单台 generator 网卡丢包，被误判为 SFU/RTP/relay 丢包。
- orchestrator 为每条消息或 packet 协调，自己成为全局瓶颈。
- 同一个 interaction 被多个工具重复统计，得到虚假的 100k。

本 ADR 决定一套 profile-driven、分布式、可校准、可核对的负载生成架构。它先证明 generator 有能力产生目标负载，再证明系统能够承受负载。

## 2. 官方工具能力结论

### 2.1 LiveKit

LiveKit 官方 `lk load-test` 可以通过 Go SDK 模拟 publisher/subscriber，发送循环 720p 视频和目标码率音频，并支持多台 generator。官方同时提醒 generator 必须有足够 CPU、带宽和文件句柄。官方示例主要针对一个大 room，不等价于 Converact Fabric 的大量 1:1 小 room、独立 screen room、overlay screen、TURN 和 Egress 混合负载。

裁决：复用其媒体生成和协议实现，但增加 Converact Fabric 多 room 编排、profile shard、屏幕素材、强制 TURN、Egress correlation 和 generator telemetry；上游 CLI 结构不满足时允许 fork。

### 2.2 SIPp

SIPp 适合 SIP 性能场景、CPS、并发 call 和 RTD 统计，但官方说明它采用单线程 event loop，timer resolution、recv/scheduler loops 和 watchdog 都会影响高负载结果，并建议负载过大时使用多台机器。

裁决：SIPp 负责可重复 SIP scenario 和一部分 RTP replay；每个进程有明确 safe generation capacity，跨多个 worker 分片。真实双向 RTP、SRTP、录制和媒体质量另由 Converact Fabric media twin 补齐，不能只测 INVITE/200/BYE。

### 2.3 Tinode

Tinode 官方目录提供 Tsung/Gatling 的 rudimentary load tests，可测连接、订阅、发布和单 hot topic。它不是 Converact Fabric 的完整 IM profile，缺少完整 receipts、presence、typing、attachment、native mutation、投影、断线恢复和统一 interaction ID 证据。

裁决：保留官方场景作 baseline；生产容量使用 Converact Fabric Tinode generator。优先复用 native protocol/SDK，必要时 fork 官方 loadtest 或实现 Go generator。

### 2.4 RustDesk

RustDesk Server 官方仓库提供 hbbs/hbbr 构建和运行能力，但没有与 MIX-100K 对应的官方 rendezvous/relay 容量工具和公开方法。

裁决：建立两条测试车道：

1. protocol-level synthetic fleet 产生大规模 ID/rendezvous、relay、office motion、高动态峰值和文件传输流量。
2. 两台或多台真实 Windows 验证授权、控制、剪贴板、文件、多屏、录屏、断开、重连和审计正确性。

synthetic fleet 用于容量，Windows fleet 用于真实功能；两者不能互相冒充。

## 3. 决策摘要

```text
Profile + Fork Manifest + Fault Plan
                |
        Load Run Compiler
                |
      immutable Run Manifest
                |
   +------------+-------------+-------------+
   |            |             |             |
 SIP/RTP     IM/WS         LiveKit       RustDesk
 Fleet       Fleet         Fleet         Fleet
   |            |             |             |
   +------------+-------------+-------------+
                |
           Converact Fabric SUT
                |
     independent observation plane
                |
        Evidence Validator
```

1. Profile compiler 把 interaction 和派生连接拆成互斥 shard。
2. orchestrator 只发布 run phase、租约和 barrier，不处理 packet/message/frame。
3. 每个 fleet 独立生成协议真实流量并报告自己的 CapacityVector。
4. generator 与 SUT 使用独立 compute pool；大规模测试使用独立网络出口或至少独立可观测 NIC/queue。
5. generator safe capacity 总和至少达到目标的 150%，运行时单 worker 不超过已校准 safe capacity 的 70%。
6. 客户端、服务端和独立网络观测三方核对计数。
7. generator 未通过资格门槛时，本轮结果自动标记 `invalid_generator_capacity`，不能用于容量结论。

## 4. Run Manifest

每轮运行先生成 immutable manifest：

```typescript
interface LoadRunManifest {
  run_id: string;
  profile_id: string;
  profile_sha256: string;
  fork_manifest_id: string;
  fork_manifest_sha256: string;
  sut_release_id: string;
  generator_release_id: string;
  seed: string;
  run_epoch: string;
  topology: GeneratorTopology;
  shards: LoadShard[];
  phases: LoadPhase[];
  faults: FaultAction[];
  expected_totals: ExpectedTotals;
  start_not_before: string;
  evidence_prefix: string;
}
```

manifest 生成后禁止修改。需要改变任何数量、码率、场景或故障时间时创建新 run ID。

### 4.1 确定性 ID

interaction ID：

```text
<run_id>/<interaction_kind>/<ordinal>
```

connection、participant、track、recording、message 和 evidence ID 从 interaction ID 派生。generator 不随机创建未登记 interaction。

### 4.2 Shard

```typescript
interface LoadShard {
  shard_id: string;
  interaction_kind: string;
  ordinal_start: number;
  ordinal_end_exclusive: number;
  expected_interactions: number;
  required_protocols: string[];
  assigned_fleet: string;
  lease_epoch: string;
  seed: string;
}
```

shard 区间不得重叠。validator 检查：

```text
union(shard interaction IDs) == profile expected IDs
intersection(all shards) == empty
count(distinct active interaction IDs) == profile total
```

worker 丢失后新 worker 只能用更高 `lease_epoch` 接管 shard。旧 worker 恢复后必须停止产生新动作，避免双发。

## 5. 控制架构

### 5.1 Orchestrator

orchestrator 只负责：

- compile profile。
- 发布 manifest。
- 分配 shard lease。
- phase barrier。
- 故障时间线。
- 收集低频 worker heartbeat。
- 宣布 run stop/finalize。

禁止 orchestrator：

- 代理 SIP、RTP、WebRTC、Tinode 或 RustDesk 数据。
- 为每个 message 请求下一个动作。
- 在每个 interaction 上同步写 PostgreSQL。
- 聚合所有原始 metrics 后再转发。

orchestrator 故障时，当前 phase 在有界 lease 内继续；禁止生成新 phase。恢复后从 durable run state 继续，不能重置 shard epoch。

### 5.2 Fleet coordinator

每类协议有多个 coordinator，负责：

- 把大 shard 切为 worker-local range。
- 分发 credential/token batch。
- 控制该 fleet ramp 和 rate。
- 收集 worker health，不代理数据。
- 在 worker 超过安全门槛时停止加压并报告 under-generation。

coordinator 不得成为单点。其故障不影响已建立媒体和连接；新 interaction 暂停而不是重复创建。

### 5.3 Worker

worker 直接连接 SUT endpoint，并独立输出：

- assigned/created/active/closed interaction count。
- target/actual CPS、message/s、packet/s、frame/s、bitrate。
- connection error、protocol error、timeout、reconnect。
- local CPU、memory、GC、event-loop lag、file descriptors、NIC bytes/PPS/drop。
- shard lease epoch 和最后 ordinal。
- local monotonic clock 与 wall clock offset。

## 6. Generator Fleet

### 6.1 SIP signaling fleet

场景至少覆盖：

- REGISTER refresh 和 expiration。
- UDP、TCP、TLS、WSS 比例。
- INVITE/100/180/183/200/ACK/BYE。
- CANCEL、486、503、timeout 和 retransmission。
- re-INVITE/UPDATE、hold/resume、transfer、DTMF。
- 监听、咨询和转接带来的额外 dialog/leg。
- node/Cell/Zone 故障后的 reconnect/retry。

SIPp 每个 process 在单独 calibration 中确定 safe CPS 和 active-call 上限。watchdog major/minor、timer drift 或 scheduler lag 超门槛时，该 process 不再分配 shard。

### 6.2 RTP/media twin fleet

SIP 建链不等于语音媒体通过。media twin 必须：

- 发送/接收 PCMU 20ms packetization。
- 按 profile 开启 SRTP。
- 使用带 speech/silence/DTMF 的可重复音频样本，不只发零 payload。
- 序列号、timestamp、SSRC 和 RTCP 合法。
- 统计双向 packet、loss、late、duplicate、jitter 和音频 continuity hash。
- 对录音抽样做 source/recorded waveform correlation。
- 注入 loss、delay、jitter 和 reorder。

SIPp 内置媒体不足时允许修改 SIPp 或使用独立 Rust/Go media twin；工具选择不能降低真实媒体要求。

### 6.3 Tinode IM fleet

每个 shard 按 profile 产生：

- WebSocket connect/login/subscription。
- 1:1 和 group topic。
- publish、ack、delivery/read receipt。
- presence 和 typing。
- attachment reference 和 secure-file correlation。
- native edit/delete mutation。
- reconnect、resume、duplicate delivery 和 out-of-order network input。
- 1,000 subscriber hot topic（Cell-10K）及其 10 message/s。

worker 保存每个消息的 deterministic ID 和 expected recipient set，但不把全部高基数状态写入 Prometheus。最终通过 compact journal/hash 核对 accepted、durable、projected、delivered 和 mutated state。

### 6.4 Converact Fabric event WebSocket fleet

独立于 Tinode WS，验证：

- 5,000/50,000 concurrent event WS。
- tenant/user authorization。
- sequence、resume cursor 和 replay。
- interaction、audit、notification、recording 和 Provider events。
- gateway drain、reconnect storm 和 slow consumer。

slow consumer 按 profile 单独分组，不能让所有客户端都无限读取从而掩盖 backpressure。

### 6.5 LiveKit fleet

Cell-10K 至少产生：

- 1,000 个 1:1 A/V room，2,000 participants。
- 300 个独立 screen room，600 participants。
- 30% A/V room 叠加 screen track，但不增加 interaction count。
- Opus 32kbps publisher audio。
- 720p30、平均 1.5Mbps、simulcast camera video。
- 1080p15、平均 2Mbps、峰值 4Mbps screen video。
- 20% TURN participants 和一次全量 forced-TURN 独立 profile。
- TrackEgress、RoomComposite 和 object-storage failure。
- join、publish、subscribe、mute、quality change、reconnect 和 room rebuild。

官方 `lk load-test` 可以作为媒体 worker 基础，但必须扩展为多小 room 和 profile shard。每个 worker 报告实际 encoded bytes/packets，不接受只声明分辨率却没有达到目标码率。

### 6.6 RustDesk fleet

synthetic worker 必须运行真实 hbbs/hbbr wire path，而不是向 relay 端口写随机 bytes。场景：

- endpoint registration/heartbeat。
- controller-target rendezvous。
- direct success 和 40% forced relay。
- 平均 800kbps office trace。
- 24Mbps high-motion peak trace。
- input/clipboard/control message。
- bounded file transfer。
- disconnect、relay failure 和 reconnect。
- owner epoch/authorization revoke。

真实 Windows lane 复用相同 interaction ID，只抽取受控子集做行为验收，不和 synthetic session 重复计数。

### 6.7 Recording/evidence fleet

它不伪造录制成功，而是验证真实产物：

- voice encoded-fork 50%。
- LiveKit track 20%。
- RoomComposite 1%。
- screen track 20%。
- RustDesk local upload 10%。

observer 根据 RecordingManifest 核对 accepted、spooled、uploaded、quarantined、scanned、ready/failed。对象存储 sink 可以受控注入 latency、5xx、timeout 和 bandwidth cap，但 bytes 必须真实流过 uploader。

### 6.8 Intelligence/Provider fleet

在真实 Provider 尚不可用时，controlled providers 仍按真实协议合同产生：

- streaming ASR partial/final、slow stream、disconnect。
- OCR attachment result、timeout 和 malformed response。
- translation batch/stream latency、quota 和 failover。
- AI quality asynchronous result、rate limit 和 circuit breaker。

controlled pass 只能证明平台 backpressure/routing，不证明真实 OCR/ASR/翻译/AI 质量或供应商容量。

## 7. Generator 资格校准

### 7.1 Sink calibration

正式压 SUT 前，每个 worker type 先对一个无业务逻辑的高速 sink 或 loopback peer 运行相同协议/码率，测出 generator 自身：

- max connections。
- max CPS/message/s/packet/s/frame/s。
- max ingress/egress Mbps。
- event-loop/timer drift。
- CPU、memory、GC 和 NIC drop。

safe generation capacity 是满足 generator SLO 时的容量，不是进程 crash limit。

### 7.2 运行 headroom

正式运行满足：

```text
sum(generator safe capacity) >= 1.5 * profile target
worker assigned load <= 0.70 * worker safe capacity
worker CPU P95 <= 0.60
worker NIC utilization P95 <= 0.70
worker memory P95 <= 0.70
generator packet drop == 0 at host interface
```

允许极短的 CPU 峰值超过 60%，但不能影响 timer、packet 或 rate。任何 fleet 没有 50% 总体余量时，本轮不得用于找 SUT 上限。

### 7.3 单 worker 故障预算

单 worker 承担的目标负载不超过该 fleet 总目标的 20%。一个 worker 故障时：

- 已建立 connection/media 按协议断开并触发预期 reconnect。
- replacement 使用更高 shard lease epoch。
- validator 区分计划内 generator failure 与 SUT failure。
- 不允许悄悄降低目标负载继续计时。

## 8. 网络与时间

### 8.1 网络隔离

- generator 不和 SUT media node 共用物理主机。
- generator NIC、交换机端口和云带宽限制必须记录。
- 大规模媒体至少使用 25GbE generator host；实际数量由校准结果决定。
- generator 与 SUT 的跨 Zone 流量单列，不把云出口限速当作组件容量。
- TURN/relay 测试必须确认数据确实经过 TURN/hbbr，不靠配置意图推断。

### 8.2 时间

- 所有 host 使用 chrony/PTP 或等价同步。
- steady 测试时 wall-clock offset 目标 <=2ms；超过 10ms 的 run 不用于跨机 P99 latency。
- latency 同时记录 sender monotonic、receiver monotonic 和 trace span；跨机 wall clock 只在 offset 合格时使用。

## 9. 运行阶段

```text
preflight
  -> credential/token preload
  -> connection ramp
  -> interaction ramp
  -> media/rate stabilization
  -> steady 120m
  -> burst 60s
  -> recovery
  -> node faults x3
  -> Cell drain/fault x3
  -> Zone/quorum faults x3 where applicable
  -> graceful close
  -> evidence reconciliation
```

24 小时 endurance 独立运行在 70% profile，不和 2 小时 peak steady 混成一个平均值。

### 9.1 Barrier

phase 只在所有 fleet 达到门槛后开始：

```text
active_count within [target, target]
actual_rate within target tolerance
media bitrate and PPS stable
generator health qualified
SUT warmup complete
```

连接达到而消息/媒体未达到时，不能进入 steady。

### 9.2 Rate tolerance

- active interaction、connection、participant：目标必须精确达到；故障窗口单列。
- steady CPS/message/s：每 60 秒窗口在目标的 99%-101%。
- burst CPS/message/s：每 1 秒窗口报告，60 秒总量在 98%-102%。
- media average bitrate：每 track/session 按 profile 容差核对，不能只核对 aggregate。
- high-motion peak：独立窗口触发，不要求全时保持峰值。

## 10. 故障注入

fault runner 使用 manifest 时间线，只调用基础设施或组件公开的受控故障入口：

- kill one owner node。
- drain one node/Cell。
- isolate one Cell control link。
- fail one Data Zone。
- PostgreSQL/Redis/NATS leader failure。
- object storage latency/5xx/outage。
- Provider timeout/quota/failover。
- generator worker failure。
- reconnect 20% clients over 60 seconds。

fault runner 不走业务热路径，不直接修改数据库状态伪造故障。每次 action 有 request、ack、observed effect 和 recovery timestamp。

## 11. 三方核对

### 11.1 Generator truth

- attempted、connected、active、sent、acked、received、closed。
- media bytes/packets/frame/hash。
- shard/ordinal/lease epoch。

### 11.2 SUT truth

- owner journal。
- CapacityVector samples。
- component protocol metrics。
- database/outbox/event/recording state。
- admission and rejection reason。

### 11.3 Independent truth

- load balancer/NIC flow counters。
- packet capture sample。
- object storage bytes/object count。
- database WAL/write metrics。
- NATS stream sequence。

最终 validator 不能只信任一侧。例如 generator 说发送成功、服务端没有 accepted 记录时必须成为 mismatch，而不是按 generator 数字计入吞吐。

## 12. Generator 失效判定

满足任一条件，run 标记 invalid 或降级为 diagnostic：

- 任一 fleet under-generate 超过 tolerance。
- worker CPU/NIC/memory 持续超过校准门槛。
- SIPp watchdog major trigger 或持续 minor trigger。
- event-loop/timer drift 破坏 CPS/latency。
- generator host packet drop。
- shard overlap、lease split-brain 或 interaction ID 重复。
- 生成器版本、配置、素材或 source commit 未进入 manifest。
- orchestrator 重启导致 phase 或 ordinal 重放。
- generator 与 SUT 共享资源形成不可分离争用。

invalid run 可以用于调试，不能产生 `component_pass/cell_pass/platform_pass`。

## 13. Evidence bundle 增量

在基础 evidence bundle 上增加：

```text
load-run-manifest.json
generator-topology.json
generator-capacity-baselines.json
generator-capacity-vectors.jsonl
shard-leases.jsonl
phase-timeline.jsonl
rate-conformance.json
interaction-reconciliation.json
network-observation.json
generator-errors.jsonl
media-quality-samples/
synthetic-vs-real-environment.json
```

summary 必须明确：

- target 和 actual。
- generator headroom。
- SUT safe/hard capacity。
- 哪些是真实协议，哪些是 controlled provider。
- 哪些 external dependencies 为 `not_run`。

## 14. 实现边界

建议代码结构：

```text
tools/converact-loadgen/
  compiler/
  orchestrator/
  common/
  sip/
  rtp/
  tinode/
  converact-ws/
  livekit/
  rustdesk/
  provider/
  observer/
  validator/
  fixtures/
```

工具本身独立发布，生成 `generator_release_id`。修改 LiveKit CLI、Tinode loadtest、SIPp 或 RustDesk protocol driver 时，也进入 fork manifest，不使用浮动 upstream branch。

## 15. Cell-10K Generator 初始拓扑

以下是校准起点，不是固定服务器承诺：

| Fleet | 初始 worker host | 最低网络 | 原因 |
| --- | ---: | ---: | --- |
| SIP signaling | 2 | 10GbE | 避免 SIPp 单 event loop 成为结论 |
| RTP media twin | 2 | 10/25GbE | 5,000 RTP legs、双向 packet 和质量核对 |
| Tinode + event WS | 2 | 10GbE | 14,000 WS、500 msg/s 和 reconnect |
| LiveKit media | 4 | 25GbE | 720p/screen/simulcast 产生约多 Gbps 真实流量 |
| RustDesk synthetic | 2 | 10GbE | direct/relay、office/high-motion、文件 |
| Provider/object sink | 2 | 10GbE | 录制上传和 Provider fault 不争用 media generator |
| Orchestrator/observer | 3 small nodes | 1/10GbE | quorum、metrics 和 evidence，不承载业务流量 |

每个 fleet 先做校准；容量足够时可以减少 host，容量不足时增加。MIX-100K worker 数量由 Cell-10K 的实测 safe generation capacity 推导，不按表格简单乘十。

## 16. 验收标准

ADR 实现完成需证明：

1. `cell-10k-v1` 和 `mix-100k-v1` 都能编译为无重叠 shard。
2. 每个 fleet 有独立 safe generation capacity 证据。
3. generator 总 safe capacity >= target 的 150%。
4. steady、burst、media bitrate 和 active count 达到 tolerance。
5. generator worker 故障不会产生 duplicate interaction 或 stale shard writer。
6. 三方计数可以核对 interaction、message、packet、recording 和 evidence。
7. controlled 与真实环境状态分开报告。
8. invalid generator run 无法被 evidence validator 标记为 pass。

## 17. 结论

Converact Fabric 的 100K 证据不是“一条命令跑出 100000”这么简单。真正可信的压测平台必须把每个 interaction 编译成互斥 shard，让多类 generator 以真实协议产生足量负载，并持续证明 generator 自己没有饱和。

官方工具可以复用，但不能限制目标：LiveKit CLI、Tinode loadtest、SIPp 或 RustDesk 缺少的多 Cell、真实媒体、录制、epoch、故障和证据能力，直接在 Converact Fabric 工具或对应 fork 中补齐。

## 18. 官方依据

检索日期：2026-07-16。

1. LiveKit 官方 benchmark 与 `lk load-test`：https://docs.livekit.io/transport/self-hosting/benchmark/
2. Tinode 官方 loadtest、Tsung/Gatling 场景和实验说明：https://github.com/tinode/chat/tree/master/loadtest
3. SIPp 官方性能测试、event loop、timer 和 watchdog 说明：https://sipp.readthedocs.io/en/latest/perftest.html
4. SIPp 官方统计与 RTD：https://sipp.readthedocs.io/en/latest/statistics.html
5. RustDesk Server 官方仓库与 hbbs/hbbr 构建边界：https://github.com/rustdesk/rustdesk-server
