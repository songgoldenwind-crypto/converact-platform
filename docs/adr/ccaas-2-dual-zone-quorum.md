# ADR-CCAAS-2：双 Active Data Zone 与第三仲裁故障域

**Status:** Proposed（2026-07-16）
**Decision owner:** Converact Fabric shared communication foundation
**Related:** [`ccaas-1-cell-placement.md`](ccaas-1-cell-placement.md)、[`../capacity/profiles/mix-100k-v1.json`](../capacity/profiles/mix-100k-v1.json)、[`../MIX-100K双Zone与Cell架构评审.md`](../MIX-100K双Zone与Cell架构评审.md)

## 1. 背景

Converact Fabric 的商业级目标是在单 Region 内使用两个 Active Data Zone 正常各承载约 50% 流量，任一 Zone 故障后由另一 Zone 接纳完整 `MIX-100K-v1` 核心负载。

两个实时 Zone 不能直接等于两个仲裁节点。NATS JetStream、Redis Sentinel、PostgreSQL failover coordinator 等系统都需要多数派才能在网络分区下同时保证一致性和 fencing。纯 A/B 对称部署无法区分“对方宕机”和“双方网络断开”，自动双主会产生 split brain。

本 ADR 将实时容量和仲裁容量分开：

- Zone A/B 承载完整实时计算和数据副本。
- Fault Domain C 承担第三投票、必要第三副本和见证。
- C 不承担 RustPBX、LiveKit、Tinode WebSocket 或 RustDesk 大规模实时流量。

## 2. 决策摘要

```text
Region R1
├── Data Zone A: 100k safe core capacity + state replicas
├── Data Zone B: 100k safe core capacity + state replicas
└── Quorum Fault Domain C: third votes/replicas/witness, no full media pool
```

1. A/B 正常各承载约 50,000 active interaction。
2. A/B 各自的 verified safe capacity 必须覆盖完整 100,000 核心 profile。
3. C 是独立故障域，不与 A 或 B 共电源、宿主机、交换机和控制面故障。
4. NATS durable stream 使用 R=3，跨 A/B/C。
5. Redis HA 使用至少三个 Sentinel；关键 Redis 数据至少有跨 Zone replica。
6. PostgreSQL 使用跨 Zone synchronous standby 和 quorum-backed failover/fencing。
7. Cell compute 与这些 durable shard 解耦。
8. Zone 故障后停止非核心在线计算，保护 voice、IM、A/V、screen 和远控接纳。

## 3. 故障域定义

### 3.1 Data Zone

Data Zone 必须具有独立：

- 计算节点和媒体 NIC。
- L4 ingress 和公网出口路径。
- RustPBX、LiveKit、Tinode、RustDesk、API/WS/worker 节点池。
- PostgreSQL/Redis/NATS 数据副本。
- 本地临时录制 spool。
- DNS/LB 健康检查目标。

跨 Zone 可以共享 Region 对象存储、证书 authority、镜像仓库和观测后端，但这些共享项必须有自己的 HA 合同。

### 3.2 Quorum Fault Domain C

C 至少承载：

- NATS JetStream 第三 replica/member。
- Redis Sentinel 第三投票；按 Redis 类别决定是否同时承载第三 data replica。
- PostgreSQL failover coordinator/DCS 第三投票或等价托管仲裁。
- Region Directory lease/epoch quorum member。
- 必要的低流量监控与 synthetic probe。

C 不需要承载：

- 50,000 或 100,000 媒体 interaction。
- LiveKit SFU/TURN 主流量。
- RustPBX RTP。
- RustDesk hbbr 主流量。
- Tinode 90k WebSocket。

如果基础设施提供商没有第三可用区，可以使用独立机房或托管 quorum 服务；跨 Region witness 必须验证 RTT 和分区行为。

## 4. Region 容量合同

### 4.1 Safe capacity

```text
SafeCapacity(A, mix-100k-v1-core) >= 100,000
SafeCapacity(B, mix-100k-v1-core) >= 100,000
NormalLoad(A) ≈ 50,000
NormalLoad(B) ≈ 50,000
```

`safe capacity` 已包含单节点资源门槛：

- CPU 持续 <=65%。
- NIC 持续 <=60% verified usable throughput。
- RTP/WebRTC/RustDesk 丢包满足 SLO。
- recording/TURN/provider slots 有明确 admission。
- 组件 P99 满足 profile。

因此 Zone 故障后 surviving Zone 到达 100,000 时仍在 safe boundary 内，不是运行到进程崩溃极限。

### 4.2 Core 与 deferable workload

Zone failover 时必须继续：

- SIP 新呼叫和必要录音。
- Tinode message ACK、持久化和 fanout。
- LiveKit 基础 A/V、screen 和必要 TrackEgress。
- RustDesk 授权、P2P 和 relay。
- interaction command、审计、outbox 和安全策略。

可以排队或暂停：

- 新 RoomComposite Egress。
- post-call ASR、OCR、翻译和 AI 质检。
- 离线转码、缩略图和报表。
- retention cleanup 和非紧急备份。
- 非必要索引、数据导出和批量 webhook replay。

`mix-100k-v1` 的 `counts_as_core_admission` 字段决定 reservation 是否必须在 Zone failover safe capacity 中预留。

## 5. 流量入口

### 5.1 正常状态

- Region DNS/GTM 返回 A/B 两个健康 ingress。
- L4/SIP/WebSocket ingress 尽量保持客户端 Zone affinity。
- 新 interaction 的 placement 在 A/B 间维持约 50/50，并受 CapacityVector 约束。
- 同一 interaction 的媒体固定在 owner Zone，不经另一个 Zone 绕行。
- 跨 Zone 只传控制、复制、事件和恢复所需状态。

### 5.2 Zone 故障

1. 多来源健康检查确认 Zone unavailable。
2. Region Directory 发布新 snapshot，故障 Zone 全部 Cell `offline`。
3. DNS/LB 停止新流量进入故障 Zone。
4. surviving Zone 接纳新 interaction。
5. 受影响 active media 按通道执行 re-INVITE、room rebuild、Tinode reconnect 或 RustDesk relay reselection。
6. deferable workload 自动暂停或只入 durable queue。
7. 故障恢复后先进入 `draining/recovering`，完成数据追平和 synthetic test 后逐步恢复 50/50。

禁止 Zone 恢复后立即一次性迁回 50,000 interaction。

## 6. PostgreSQL

### 6.1 数据库分组

至少分离：

| 数据库组 | 内容 |
| --- | --- |
| Converact Fabric authority shards | tenant/config/interaction/command/audit/outbox |
| Tinode shards | message/topic/subscription/read state |
| RustPBX configuration/CDR | PBX 配置、CDR projection；实时 dialog 不依赖 PG 恢复 |
| operational metadata | capacity evidence、deployment、fork release、backup catalog |

不同组可以使用同一 PostgreSQL HA 平台，但必须有独立 database、role、pool、WAL/IO budget 和扩展路径。

### 6.2 一致性

以下 acknowledged write 目标 RPO=0：

- Tinode 已向客户端确认 durable 的业务消息。
- interaction command 幂等记录。
- consent、授权、审计和策略裁决。
- recording/evidence manifest 状态。
- outbox event。

自建 PostgreSQL 基线：

- primary 在 A 或 B。
- synchronous standby 在另一个 Data Zone。
- `synchronous_commit=on` 或经证明满足 remote durable flush 的等价设置。
- failover coordinator 使用第三仲裁域 fencing。
- 旧 primary 恢复时先隔离、rewind/reseed，不允许直接重新接收写入。

Zone 间同步不可用时，RPO=0 数据默认停止 ACK 或进入客户端可重试路径，不能自动降成异步复制却继续声称零丢失。

### 6.3 可用性

- PG leader loss 检测、fencing 和 promotion 目标 RTO <=30 秒。
- PgBouncer/客户端必须重新解析 primary，不缓存旧地址无限重试。
- 每个进程池设置连接预算；增加 API/worker pod 不允许把 PG max connections 线性耗尽。
- 高频 telemetry 不写 OLTP。
- 大租户按 `data_shard_id` 分片，不按 `cell_id` 分片。

## 7. NATS

### 7.1 部署

- 至少 3 个 JetStream-enabled member，分布 A/B/C。
- durable stream 使用 R=3。
- 每个 member 使用独立本地 SSD/store directory。
- Cell 实时非持久 subject 与 regional durable stream 使用不同 account/subject policy 和资源预算。
- 不使用共享 NFS 作为 JetStream store。

### 7.2 流分类

| 类型 | NATS 模式 | 示例 |
| --- | --- | --- |
| durable authority event | JetStream R3 | outbox、owner journal、audit delivery |
| replayable integration | JetStream R3 | webhook、notification、provider job event |
| ephemeral realtime hint | Core NATS | presence hint、WS shard wake-up |
| high-rate telemetry | 不进入 JetStream authority | metrics/log pipeline |

### 7.3 故障语义

- A 丢失，B+C 构成 quorum。
- B 丢失，A+C 构成 quorum。
- C 丢失，A+B 构成 quorum。
- 任意网络分区只有多数派接受 durable write。
- 失去多数派时 durable publish 失败并进入 PG outbox backlog；不得在两个少数派分别接受写入。

## 8. Redis

Redis 按职责分离，不用一个全局实例同时承担所有功能：

| Redis group | 用途 | 数据性质 |
| --- | --- | --- |
| LiveKit Redis | room data/message bus/node stats | 实时协调，故障影响媒体控制 |
| routing/presence Redis | owner cache、presence、rate limit | 可重建但需要低 RTO |
| worker cache Redis | 非 authority cache/lock | 可降级 |

每组生产基线：

- 至少 1 primary + 2 replicas，跨 A/B/C；或提供同等故障语义的托管 Redis。
- 至少 3 Sentinel，跨 A/B/C。
- 客户端必须支持 Sentinel/cluster discovery。
- authority 仍在 PostgreSQL/JetStream，不把仅存在 Redis 的数据写成 durable。
- Redis failover 必须验证 LiveKit、owner cache 和 rate limit 客户端是否正确重连。

## 9. 对象存储

对象存储承载录音、视频 track、RustDesk evidence、附件、衍生物和 evidence bundle。

生产必须满足：

- Region 内多故障域冗余。
- multipart upload、checksum、versioning/object lock（按合规策略）。
- 每个 tenant/purpose 的访问策略和 encryption key boundary。
- write throughput 覆盖 profile 的 voice/video/evidence 数据量。
- 上传成功仅在对象持久化并校验 checksum 后确认。
- metadata 与对象状态通过幂等 reconciliation 收敛。

当前单节点 MinIO compose 只用于开发/受控验收，不进入双 Zone 生产结论。自建可使用 distributed MinIO/其他 S3-compatible 集群，托管可使用云对象存储；选择必须通过相同合同。

## 10. Kubernetes 与调度

推荐第一阶段：一个受管或自建的 Region 级 Kubernetes control plane，A/B 使用独立 node pools 和严格 topology constraints，C 使用小型 quorum node pool。

必须：

- control plane 自身跨故障域 HA。
- RustPBX/LiveKit/hbbr/PG/NATS 使用 dedicated 或 Guaranteed QoS。
- LiveKit hostNetwork 且 one media pod per node。
- zone/cell/node labels 由受信 admission policy 注入，不由 workload 任意伪造。
- PDB 不能阻止紧急故障恢复，也不能把 planned drain 误当成故障。
- 自动扩容节点完成镜像、配置、证书、端口和 synthetic interaction 后才进入 accepting。

若 on-prem 两个 Zone 使用两个独立 Kubernetes cluster，Region Directory 和公开 API 仍保持一套平台；本 ADR 的 Zone/Cell/owner 合同不变。

## 11. 网络与带宽

每个 Zone 的网络都按完整 profile 规划：

- G.711 voice 约 4 Gbps ingress + 4 Gbps egress。
- 1:1 A/V 约 30 Gbps video/方向，加音频和协议余量。
- screen 平均约 6 Gbps/方向，峰值约 12 Gbps/方向。
- TURN 按 20% planning ratio 和 100% forced TURN 子测试。
- RustDesk relay 按 relay ratio × measured bitrate。
- 录制上传与客户端媒体出口分开计量。

要求：

- 聚合带宽不能经过单一 25GbE LB/NAT 节点。
- UDP PPS、conntrack、SNAT port、跨 Zone 带宽和公网 egress 分别验证。
- 媒体 node 尽量直达公网或经可水平扩展 L4/relay，不走通用 HTTP ingress。
- 任何单网络设备故障不能让整个 Zone 失去入口。

## 12. 故障矩阵

| 故障 | Majority | 新 durable write | 新 interaction | Active media |
| --- | --- | --- | --- | --- |
| 单 node | 保持 | 继续 | 其他 node 接纳 | owner 受影响部分重建 |
| Zone A lost | B+C | 继续 | Zone B 接纳 | A 中会话按协议恢复 |
| Zone B lost | A+C | 继续 | Zone A 接纳 | B 中会话按协议恢复 |
| Domain C lost | A+B | 继续 | A/B 正常 | 不受影响，尽快恢复 C |
| A/B 之间断开，C 仅连 A | A+C | A 接受，B fencing | Zone A 接纳 | B 已有媒体可有限继续，禁止新 mutation |
| A/B 之间断开，C 仅连 B | B+C | B 接受，A fencing | Zone B 接纳 | A 已有媒体可有限继续，禁止新 mutation |
| 仅剩一个故障域 | 无 | 停止 authority write | 停止需 durable owner 的新交互 | 已有媒体按安全策略继续/结束 |

## 13. RPO/RTO

| 数据/能力 | RPO | RTO/恢复目标 |
| --- | ---: | ---: |
| acknowledged IM message | 0 | PG failover <=30s，客户端幂等重试 |
| command/consent/audit/outbox | 0 | <=30s |
| recording manifest | 0 after ACK | uploader 可重试，reconcile <=5min |
| presence/typing/cache | 可丢 | <=60s 重建 |
| active RTP/WebRTC/RustDesk frame | 不持久化 | 客户端/协议重建，按 SLO 统计 |
| new interaction admission | 不适用 | Zone/node 故障后 <=30s |
| post-call Provider jobs | 0 durable job | provider 恢复后继续，允许 backlog |

## 14. 安全与运维

- Zone failover、leader promotion、fencing 和 operator override 全部审计。
- C 只开放仲裁所需端口，不作为公开媒体入口。
- backup 与 HA 分开：副本不是备份，PG/NATS/对象存储都要离线恢复演练。
- 定期执行 restore 到隔离环境并验证租户、消息、审计和对象 checksum。
- 证书、token、signing key 跨 Zone 可用，但 secret 分发有版本和撤销。
- 发布采用 Cell canary，禁止同时升级 A/B 同类全部 owner node。

## 15. 验收

1. A/B 正常 50/50 下通过 `mix-100k-v1` 2 小时 steady。
2. 单独证明 A 和 B 各自可以承载完整核心 profile。
3. A/B/C 每个故障域分别断开 3 次。
4. 验证多数派写入和少数派 fencing，不出现双主。
5. PG、NATS、Redis leader failover 均满足 RPO/RTO。
6. Zone failure 后新 interaction <=30 秒恢复接纳。
7. deferred workload 不抢占核心容量，恢复后 backlog 可收敛。
8. Zone 恢复后分批 re-balance，无重连风暴。
9. 对象存储达到录制吞吐并完成 checksum/reconcile。
10. 24 小时 70% endurance 期间执行一次 C 故障和一次 planned Cell drain。

## 16. 后果

### 正面

- 双 Zone 可以安全自动 failover，不依赖猜测对方是否宕机。
- 第三故障域不复制完整媒体池，控制服务器成本。
- durable RPO 与实时媒体恢复语义分开，承诺可验证。
- Cell 扩容不导致每 Cell 一套数据库。

### 成本

- 必须增加第三仲裁位置和状态节点。
- 跨 Zone synchronous write 增加写延迟。
- Zone 故障时非核心任务需要显式降级。
- 需要维护完整故障演练和 fencing 证据。

## 17. 不采用方案

| 方案 | 否决原因 |
| --- | --- |
| 纯双节点自动 failover | 无多数派，网络分区会 split brain 或停止服务 |
| 正常每 Zone 80% | 另一 Zone 故障后无法接管完整目标 |
| 第三 Zone 也部署完整媒体 | 当前目标下成本过高，仲裁不需要媒体容量 |
| 所有职责共用一个 Redis | 故障和热点相互放大 |
| PG 异步复制仍承诺 RPO=0 | acknowledged write 可能丢失 |
| Zone 故障后等待 HPA 临时扩容 | 媒体节点预热赶不上确定性突发 |

## 18. 实施边界

本 ADR 不在本轮选择具体云厂商，也不把 compose 单点改写成已生产化。实现阶段必须分别提交 PostgreSQL、NATS、Redis、对象存储和 Kubernetes 的部署 ADR/清单，并通过本文故障矩阵。
