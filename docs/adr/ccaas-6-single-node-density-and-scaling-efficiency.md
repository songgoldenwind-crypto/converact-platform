# ADR-CCAAS-6：单节点密度优先与近恒定边际扩展

**Status:** Proposed（2026-07-16）
**Decision owner:** Converact Fabric shared communication foundation
**Related:** [`../capacity/schemas/scaling-efficiency.schema.json`](../capacity/schemas/scaling-efficiency.schema.json)、[`../capacity/targets/mix-100k-efficiency-v1.json`](../capacity/targets/mix-100k-efficiency-v1.json)、[`../capacity/profiles/cell-10k-v1.json`](../capacity/profiles/cell-10k-v1.json)、[`ccaas-1-cell-placement.md`](ccaas-1-cell-placement.md)、[`ccaas-5-distributed-load-generation.md`](ccaas-5-distributed-load-generation.md)

## 1. 背景修正

100,000 并发是 Converact Fabric 的架构上限验证，不是现实中每套平台的默认常态负载，也不是要求客户从第一天预购完整 100K 服务器。

本项目真正优先优化：

1. 单节点在完整功能、SLO、故障余量和安全约束下能承载尽可能高的 safe capacity。
2. 增加同构节点或 Cell 时，新增容量接近首节点/首 Cell 的容量，不被全局锁、共享数据库、广播、跨 Cell 协调和控制面逐渐吞噬。
3. 在前两项成立后，证明扩展曲线能够到达 100,000 active interactions。

因此目标不再是简单的：

```text
找到足够多的服务器，让总数达到 100000
```

而是词典序目标：

```text
maximize single-node safe density
  -> maximize marginal capacity retention
  -> reach 100k with minimum practical node count
```

达到 100K 但单机密度低或扩容曲线明显弯折，架构验收仍然失败。

## 2. 决策

### 2.1 优先级

机器合同固定优先级：

```json
[
  "single_node_safe_density",
  "marginal_capacity_retention",
  "endpoint_concurrency"
]
```

100K endpoint 不能覆盖前两项失败。

### 2.2 不预分配 100K

- 小规模部署按实测需求和 safe capacity 启动最小 Cell/数据面。
- 增长时按 CapacityVector dominant resource 扩容。
- Egress、RoomComposite、OCR/ASR/AI 和离线 worker 可独立弹性扩缩。
- 双 Zone 商业 HA 仍保留 Zone failure reserve；低等级非 HA 环境可以缩小拓扑，但不能宣称同一可用性等级。
- 所有部署形态保持同一 Converact Fabric public API/SDK/event/webhook，不为小部署维护阉割版业务合同。

## 3. 为什么总并发不是首要优化指标

下面两套平台都可能达到 100K：

```text
Platform A: 10 nodes * 10k useful capacity
Platform B: 100 nodes * 1k useful capacity
```

只看总量会认为二者等价，但 B 的服务器、网络、发布、故障域、数据库连接、监控和运维成本高一个数量级。更糟的是，如果 B 每增加一台只能贡献 700、500、300 的容量，继续扩容最终会撞上共享瓶颈。

因此必须同时发布：

- 单节点 hard/safe capacity。
- 每物理核、GiB、网卡和成本单位的 safe capacity。
- `C(1), C(2), C(4), C(8)` 曲线。
- 每个扩容区段的 marginal efficiency。
- Cell 和 shared data plane 的独立曲线。

## 4. 容量定义

### 4.1 Profile-equivalent capacity

对一个固定 workload profile，把所有负载维度按相同比例 `lambda` 放大或缩小：

```text
interactions
connections
CPS/messages
RTP legs/tracks
bitrate/PPS
TURN/relay
recording/evidence
Provider streams
failure/reconnect
```

`profile-equivalent active interactions` 是满足完整比例时的 interaction 数。不能只增加空闲 WebSocket 或关闭录制来扩大数字。

### 4.2 Hard capacity

`C_hard(n)`：在 n 个同构单位上，仍满足功能和质量 SLO 的最大 profile-equivalent load，但尚未扣除生产 headroom。

hard capacity 用于看源码和硬件极限，不用于生产 admission。

### 4.3 Safe capacity

`C_safe(n)`：在相同功能/SLO 下，同时保留：

- 声明的 production headroom。
- 节点或 Zone 故障所需 reserve。
- burst、reconnect 和测量误差余量。

本合同首版单节点 production headroom 为 20%。双 Zone 核心负载正常每 Zone 不超过其 safe capacity 的约 50%，使一个 Zone 能接管目标核心负载。

“榨取单机”指提高 `C_hard` 和 `C_safe` 的资源效率，不是把生产 headroom 从 20% 降到 0。

## 5. 单节点密度

### 5.1 必测角色

- SIP Edge。
- RustPBX voice/RTP/recording。
- LiveKit SFU/TURN。
- LiveKit Egress。
- Tinode IM。
- Converact Fabric realtime API/WS/event edge。
- RustDesk hbbs/hbbr。
- recording/evidence worker。
- shared PostgreSQL/Redis/NATS/object-ingest service。

### 5.2 必报指标

通用：

```text
profile interactions / physical core
safe capacity / GiB
safe capacity / host
safe capacity / 1000 cost units
```

角色指标：

```text
RTP legs / physical core
packet operations / physical core
subscribed tracks / physical core
WebSocket connections / physical core
messages/s / physical core
relay Mbps / physical core
recording slots / physical core
```

成本单位必须记录价格日期、地区、购买模式和网络费用，不能把临时云折扣写成永久架构能力。

### 5.3 搜索方法

每个节点先 step ramp 找到 SLO 边界，再 binary search：

```text
25% -> 50% -> 70% -> 85% -> 95% candidate load
                       |
                 bracket failure
                       |
               binary search frontier
```

每个候选至少运行稳定窗口；最终点至少重复 3 次，取成功运行中的最低容量。测试必须使用合格 generator。

### 5.4 优化闭环

```text
baseline
  -> identify dominant resource
  -> flamegraph/lock/allocation/syscall/network profile
  -> one source-level hypothesis
  -> correctness and failure gates
  -> same-profile benchmark
  -> keep or revert
```

优先改源码而不是堆节点的信号：

- CPU hot path 有明显 allocation/copy/lock/timer 消耗。
- NIC 未满但 packet/s 或 syscall 饱和。
- shared queue、actor、topic、room 或 dialog registry 串行化。
- 录制、日志或指标写入实时路径。
- 单节点扩展到更多核时自身利用率明显下降。
- 组件只报告 CPU，无法按真实 dominant dimension admission。

### 5.5 退出规则

单节点优化不是无限期打磨。满足下列条件才记录当前 frontier：

1. 连续两个有证据的源码实验对 safe capacity 的提升都小于 3%。
2. profiling 没有新的可操作 dominant software bottleneck。
3. 继续优化需要专用硬件/kernel bypass，已进入独立成本与运维 ADR。
4. 当前结果满足产品成本目标和后续 scaling gate。

只满足第 1 条但仍有明显全局锁，不得退出。

## 6. 横向扩展公式

令 `C_safe(n)` 为 n 个同构节点/Cell 的 safe capacity。

### 6.1 聚合线性度

```text
L(n) = C_safe(n) / (n * C_safe(1))
```

- `1.00`：完全线性。
- `0.90`：n 个单位只获得理论线性容量的 90%。
- 总协调税为 `1 - L(n)`。

### 6.2 区段边际效率

从 a 个单位增加到 b 个单位：

```text
M(a,b) = (C_safe(b) - C_safe(a)) / ((b - a) * C_safe(1))
```

它回答的是：新增每个单位实际贡献了首单位容量的多少。

例如：

```text
C(1) = 10k
C(2) = 19.5k
C(4) = 37.5k

M(1,2) = 0.95
M(2,4) = (37.5 - 19.5) / (2 * 10) = 0.90
```

### 6.3 “边际不减”的工程定义

严格数学上的完全不减会受测量噪声和必要协调影响。本项目定义为“不显著衰减”：

- component node pool 每个区段 `M >= 0.90`。
- Cell 和 shared data plane 每个区段 `M >= 0.95`。
- component 相邻区段下降不超过 3 个百分点。
- Cell/shared-data 相邻区段下降不超过 2 个百分点。
- 曲线一旦持续下弯，先消除共享瓶颈，再增加服务器。

## 7. 首版曲线门槛

### 7.1 Component pool

| 节点数 | 最低 aggregate linearity |
| ---: | ---: |
| 1 | 100% |
| 2 | 95% |
| 4 | 93% |
| 8 | 91% |

每个 `1->2`、`2->4`、`4->8` 区段还必须满足边际效率和下降幅度门槛。

### 7.2 Cell

| Cell 数 | 最低 aggregate linearity |
| ---: | ---: |
| 1 | 100% |
| 2 | 98% |
| 4 | 97% |
| 8 | 96% |
| 10 | 95% |

Cell 门槛比节点池更严格，因为 Cell 的目的就是隔离计算所有权和局部协调。增加 Cell 后仍发生明显全局税，说明 Cell 边界没有真正成立。

### 7.3 Shared data plane

PostgreSQL、Redis、NATS、object ingest、owner directory 和 event fanout 使用同样的 Cell-equivalent load 点。它们不能隐藏在 Cell 总结果中。

数据面失败时优先：

- 移除同步热路径。
- partition/shard。
- tenant/time/hash 分区。
- batch/outbox/append-only。
- local cache/snapshot。
- 避免全局广播和高基数 fanout。

## 8. 保持边际效率的架构规则

### 8.1 禁止全局 per-interaction coordination

正常 interaction 热路径不得：

- 查询全局 PostgreSQL owner。
- 对所有 Cell 广播找 owner。
- 获取 Region-wide lock。
- 同步等待 OCR/ASR/AI/对象存储。
- 把 packet/message/frame 经全局 control service 转发。

### 8.2 Hierarchical placement

```text
Region snapshot
  -> Cell admission
  -> node owner
  -> local session state
```

只有 interaction 创建/恢复经过 placement；生命周期内保持 owner affinity。

### 8.3 Compute Cell 与 data shard 解耦

增加计算 Cell 不要求复制一套完整数据库。durable data 按 tenant/time/hash shard 扩展，Cell 通过路由访问对应 shard。这样既避免每 Cell 数据孤岛，也避免单个全局数据库吞掉扩容收益。

### 8.4 广播预算

- presence、event 和配置使用目标 shard/fanout，不做 all-Cell broadcast。
- metrics/log/trace 走异步 observation plane。
- placement snapshot 是低频 publish，不随每个 interaction 更新全量表。
- cache invalidation 使用 partition key 和版本，不全局清空。

### 8.5 有界重试

扩容时失败重试不能随节点数增长：

- placement 最多尝试两个候选 Cell。
- owner lookup 使用 placement token/cache，不遍历节点。
- event consumer partition 有单 owner 和 epoch。
- Provider failover 使用有界 route chain。

## 9. 服务器最少化目标

服务器数量优化是约束优化：

```text
minimize:
  physical hosts + cost + network + operational units

subject to:
  workload SLO
  tenant isolation
  recording/security/audit
  node failure reserve
  Zone failure reserve
  rolling upgrade
  marginal efficiency gates
```

不能通过以下方式减少节点：

- 把 PostgreSQL、NATS、SFU、RTP、Egress 全塞到一个故障域。
- 取消 N+1/Zone reserve。
- 用 vCPU overcommit 承载实时媒体。
- 让 RoomComposite 抢占 SFU/RTP。
- 关闭录制、SRTP、TURN、审计或 Provider backpressure。

允许：

- 小部署把轻量 API/WS/worker 合理装箱到通用池。
- 低负载时关闭空闲 Egress/AI worker。
- 同硬件上用 Guaranteed QoS 和 NUMA/CPU pinning 提高装箱率。
- 通过源码优化减少 media/IM/relay 节点。
- 随实际需求增加 Cell，不预留 100K 全套计算节点。

## 10. 部署形态

### 10.1 Compact

用途：开发、内部验证、小客户。

- 单 Region/单 Cell。
- 可以降低 HA 副本和故障承诺。
- 保持完整 public API 和功能合同。
- 不宣称双 Zone production SLO。

### 10.2 HA Standard

用途：常规生产，实际负载远低于 100K。

- 双 Data Zone + 第三 quorum fault domain。
- 每 Zone 按实际 peak 和增长窗口配置，不按 100K 固定预置。
- core realtime 保持 Zone failure reserve。
- deferable worker 按 backlog 弹性扩展。

### 10.3 Scale

用途：大型客户和 100K benchmark。

- 多 Cell。
- data shard 和 event partition 随 Cell-equivalent load 扩展。
- 每次增加节点/Cell 都产生 scaling curve evidence。
- 达到 100K 后继续以服务器数、每千并发成本和边际效率评价，不只写总数。

## 11. Autoscaling

### 11.1 Scale out

按 CapacityVector dominant utilization，而不是平均 CPU：

```text
max((used[d] + reserved[d]) / safe_capacity[d])
```

一般环境在 65% 持续窗口开始准备扩容；双 Zone core pool 正常运行还要满足约 50% Zone capacity 约束。阈值由启动时间、room/call 时长和预热成本修订。

### 11.2 Scale in

- 先停止新 placement。
- 完成 reservation。
- 既有 interaction 自然结束或按协议重建。
- recording/evidence/spool 完成移交。
- owner epoch fencing 后移除节点。

不以强杀进程作为常规缩容。

## 12. 曲线弯折排查

当 `M(a,b)` 下降时按顺序定位：

1. generator 是否仍有 50% 总体 headroom。
2. load balancer/Edge 是否单点。
3. placement 是否倾斜或 hot partition。
4. 组件是否有全局 registry/lock/leader。
5. PostgreSQL connection/WAL/index/hot row。
6. Redis single key/pubsub/global Lua。
7. NATS subject/consumer/storage leader。
8. object ingest/spool/uploader。
9. NIC/PPS/conntrack/IRQ/NUMA。
10. metrics/logging high-cardinality 或同步 exporter。

找到上游组件内部瓶颈时直接按 ADR-CCAAS-4 修改源码。不能以“多加几台抵消”关闭问题。

## 13. 发布回归

每个容量关键 release：

- 单节点 safe density 相对上一 production release 不得无解释下降超过 3%。
- 2/4/8 节点曲线至少跑受影响区段。
- 协议、安全或正确性修复允许有必要成本，但必须发布新容量证据和服务器预算。
- 改变硬件 class、codec、profile、headroom 或故障 reserve 后，不能和旧曲线直接比较。

## 14. 与 Cell-10K/25K 的关系

`Cell-10K` 是第一把校准尺，不是最终 Cell 规格：

- 用它确保所有通道、录制、Provider、故障和证据能在一个 Cell 内同时运行。
- 找出每个角色的 dominant resource。
- 形成单节点和 1/2/4/8 节点曲线。

通过源码和部署优化后，目标是让同等硬件下一个 Cell 的 safe capacity 继续上升，评估 `Cell-25K` 甚至更高密度。100K 最终所需 Cell 数由实测 `C_safe(Cell)` 决定：

```text
required_cells = ceil(100000 / C_safe(Cell))
```

仍需叠加双 Zone failure reserve，不能把 benchmark cell 数直接当生产总节点数。

## 15. Evidence

每条曲线保存：

```text
hardware class
profile and fork manifest
C_hard and C_safe
headroom/failure reserve
raw CapacityVector samples
dominant resource timeline
generator qualification
SLO result
flamegraph/lock/allocation/network profiles
server count and cost basis
L(n) and M(a,b)
```

每个点至少三次。合同采用成功运行中的最低值，防止只挑最好一次。

## 16. 验收标准

本 ADR 的实现验收：

1. 所有容量关键角色都有单节点 `C_hard/C_safe`。
2. 每个角色输出单位资源密度，而不只输出并发数。
3. 组件节点池通过 1/2/4/8 曲线和 90% 边际门槛。
4. Cell/shared data plane 通过最高 2 个百分点下降容差和 95% 边际门槛。
5. 一个曲线弯折时 evidence 能定位到具体 dominant dimension/partition/lock/queue。
6. Compact、HA Standard 和 Scale 使用同一 public contract。
7. 实际部署不预置 100K，但可以按 measured safe capacity 逐步扩展。
8. 100K endpoint 通过时同时给出所用物理节点、每千并发成本、failure reserve 和完整曲线。

## 17. 结论

Converact Fabric 的竞争力不来自“理论上能加服务器”，而来自每台服务器够强、每增加一台都继续有效。

100K 的作用是把这两项能力推到足够远，暴露小规模看不到的全局瓶颈。现实部署则根据实际峰值启用需要的 Cell 和 worker，不承担空闲 100K 资源成本。

这也决定了后续源码工作的判断标准：优化 RustPBX、LiveKit、Tinode、RustDesk，不是为了形成更多 fork，而是为了提高单节点 safe density，保持新增节点和新增 Cell 的边际容量近似恒定，并最终用更少的服务器走完整条 100K 扩展曲线。
