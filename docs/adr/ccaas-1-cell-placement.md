# ADR-CCAAS-1：Cell Placement、Interaction Owner 与 Fencing

**Status:** Proposed（2026-07-16）
**Decision owner:** Converact Fabric shared communication foundation
**Related:** [`../MIX-100K双Zone与Cell架构评审.md`](../MIX-100K双Zone与Cell架构评审.md)、[`../capacity/README.md`](../capacity/README.md)、[`../capacity/schemas/capacity-vector.schema.json`](../capacity/schemas/capacity-vector.schema.json)

## 1. 背景

Converact Fabric 要作为一套统一平台承载 100,000 个混合 active interaction。把租户固定到一个 Cell 可以简化路由，但会让大租户受单 Cell 上限约束，也会让 Cell drain 等价于迁移整个租户。

另一方面，把每次 SIP INVITE、LiveKit join、Tinode message 或 RustDesk frame 都交给全局控制面查询 PostgreSQL，会把实时能力绑定到数据库和跨 Zone 网络尾延迟。

本 ADR 决定：

- tenant 只固定 home Region。
- tenant 内按 routing partition 保持局部性。
- interaction 创建时选择 Zone、Cell 和 owner node。
- interaction 生命周期内保持 owner affinity。
- owner epoch 防止旧节点在网络分区或 failover 后继续执行命令。
- placement 热路径使用已发布快照和 Cell-local admission，不同步查询业务 PostgreSQL。

## 2. 决策摘要

```text
tenant_id
  -> home_region
  -> routing_partition_id
  -> zone_id
  -> cell_id
  -> owner_node_id
  -> owner_epoch
```

1. `home_region` 控制数据驻留和默认接入区域。
2. `routing_partition_id` 是租户内可迁移的放置单位。
3. Region Edge 按版本化 placement snapshot 选择 Zone/Cell 候选。
4. Cell Admission Service 原子预留 CapacityVector 并选择 owner node。
5. owner 通过 `owner_epoch` fencing；旧 epoch 的命令必须拒绝。
6. placement 决策写入异步 journal 和 PostgreSQL current projection，但不阻塞媒体首包。
7. Cell/data-shard 解耦，interaction 可以更换 compute Cell 而不迁移永久租户数据。

## 3. 资源模型

### 3.1 Routing partition

`routing_partition_id` 按通道定义：

| 通道 | 默认 partition key | 原因 |
| --- | --- | --- |
| SIP voice | queue/campaign/agent-pool ID | 坐席和队列状态保持局部性 |
| Tinode IM | topic bucket 或 customer-service queue | 避免一个大租户所有 topic 落同 Cell |
| LiveKit | room affinity group | 同类 room 局部化，但单 room 只属于一个 Cell |
| RustDesk | support team/device group | 授权、relay 和 companion 状态保持局部性 |
| Converact Fabric event WS | tenant/user gateway shard | 事件只发到拥有目标连接的 gateway |

小租户可以只有一个 partition；大租户按容量和组织边界增加 partition。partition 不能按每条消息随机变化。

### 3.2 Interaction owner record

```typescript
type InteractionKind =
  | 'tinode_im'
  | 'sip_voice'
  | 'livekit_av'
  | 'livekit_screen'
  | 'rustdesk_remote';

interface InteractionOwnerRecord {
  interaction_id: string;
  interaction_kind: InteractionKind;
  tenant_id: string;
  routing_partition_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_component: 'rustpbx' | 'livekit' | 'tinode' | 'rustdesk';
  owner_node_id: string;
  owner_epoch: number;
  cell_lease_epoch: number;
  profile_id: string;
  state: 'reserved' | 'active' | 'draining' | 'recovering' | 'closed';
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}
```

`interaction_id` 是全平台资源 ID；底层 LiveKit room name、SIP call ID、Tinode topic 和 RustDesk session ID 作为 provider binding，不替代它。

### 3.3 Owner epoch

`owner_epoch` 使用无符号 64 位整数语义：

```text
owner_epoch = (cell_lease_epoch << 32) | cell_local_sequence
```

- `cell_lease_epoch` 由 Region Directory 的 quorum-backed allocator 分配，Cell 重获 lease 时单调递增。
- `cell_local_sequence` 在当前 Cell lease 内单调递增。
- JavaScript/JSON 传输时使用十进制字符串，避免超过安全整数范围；数据库使用 `numeric(20,0)` 或等价 unsigned representation。
- 对外 SDK 不允许自行生成 epoch。

任何 command、callback、evidence upload 和 owner heartbeat 都携带 epoch。接收端发现低于 current epoch 时返回 `409 stale_owner_epoch`，不得执行副作用。

## 4. Placement snapshot

### 4.1 内容

Region Control Plane 周期性发布 immutable snapshot：

```typescript
interface PlacementSnapshot {
  snapshot_version: number;
  generated_at: string;
  expires_at: string;
  profile_id: string;
  regions: Array<{
    region_id: string;
    zones: Array<{
      zone_id: string;
      state: 'accepting' | 'degraded' | 'draining' | 'offline';
      cells: Array<{
        cell_id: string;
        state: 'accepting' | 'degraded' | 'draining' | 'offline';
        routing_weight: number;
        supported_interaction_kinds: InteractionKind[];
        supported_profile_ids: string[];
        capacity_vector_sequence: number;
        capacity_expires_at: string;
        dominant_utilization_ratio: number;
        capacity_dimensions: Record<string, {
          unit: string;
          safe_capacity: number;
          used: number;
          reserved: number;
        }>;
        cell_lease_epoch: number;
        admission_endpoint: string;
      }>;
    }>;
  }>;
  signature: string;
}
```

Snapshot 通过 NATS Core/JetStream、HTTPS pull 和本地原子文件三种方式分发。Edge 只接受签名有效、版本递增且未过期的 snapshot。

### 4.2 过期行为

| 状态 | 行为 |
| --- | --- |
| snapshot 有效 | 正常 placement |
| 过期 <=30 秒 | 仅选择最近健康且仍有 heartbeat 的 Cell，产生告警 |
| 过期 >30 秒 | 停止跨 Cell 新 placement；已存在 interaction 继续 owner traffic |
| Region Directory 不可用 | 已有 interaction 不受影响；新 interaction 按本地 snapshot 的时限 fail closed |

禁止在 snapshot 过期后无限继续接纳新媒体会话。

## 5. Placement 算法

### 5.1 输入

```typescript
interface PlacementRequest {
  request_id: string;
  idempotency_key: string;
  tenant_id: string;
  routing_partition_id: string;
  interaction_id: string;
  interaction_kind: InteractionKind;
  profile_id: string;
  required_capacity: Record<string, number>;
  preferred_region_id?: string;
  preferred_zone_id?: string;
}
```

`required_capacity` 来自 profile 编译器，不由未受信客户端提交。例：一个带录音和 ASR 的 SIP call 会同时预留 `voice.weighted_calls`、`rtp_legs`、`recording_slots` 和 `realtime_asr_streams`。

### 5.2 选择步骤

1. 根据 tenant directory 解析 `home_region` 和允许的 failover Region。
2. 过滤 snapshot 中已过期、offline、draining、不支持 interaction kind/profile 的 Cell。
3. 按 Zone 正常 50/50 policy、preferred Zone、故障状态和可用容量选择候选 Zone。
4. 对 `tenant_id + routing_partition_id + profile_id` 做 weighted rendezvous hashing，得到前两个候选 Cell。
5. 比较两个 Cell 的 dominant utilization：

```text
dominant_utilization(cell, request)
  = max((used[d] + reserved[d] + request[d]) / safe_capacity[d])
```

6. 选择 dominant utilization 更低且所有维度均未超过 admission threshold 的 Cell。
7. 向该 Cell Admission Service 发起一次原子 reservation RPC。
8. reservation 失败时只尝试第二候选一次；禁止无界遍历全部 Cell 形成重试风暴。
9. Cell 选择满足 profile 的 owner node，返回带 epoch 的 decision。
10. Edge 把 decision 写入本地 owner cache，并异步发布 owner journal。

### 5.3 返回

```typescript
interface PlacementDecision {
  request_id: string;
  interaction_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  owner_node_id: string;
  owner_epoch: string;
  reservation_id: string;
  reservation_expires_at: string;
  snapshot_version: number;
  endpoint: string;
  signed_placement_token: string;
}
```

`signed_placement_token` 只包含路由所需最小字段、过期时间和 profile ID。它不是用户授权 token；业务授权仍由 Converact Fabric JWT/tenant policy 决定。

## 6. Reservation 协议

### 6.1 状态机

```text
requested
  -> reserved
  -> active
  -> draining
  -> closed

reserved -> expired
active -> recovering -> active
active -> closed
```

- reservation 默认 TTL 10 秒。
- owner 在完成 SIP dialog/LiveKit room/Tinode topic/RustDesk session 创建后确认 `active`。
- 同一个 idempotency key 返回原 decision，不重复扣容量。
- reservation 过期自动释放。
- active owner 按组件 heartbeat 更新使用量，不依赖每次媒体包写目录。

### 6.2 原子性

Cell Admission Service 对 required dimensions 执行单次 compare-and-reserve：

```text
for every dimension d:
  used[d] + reserved[d] + request[d] <= safe_capacity[d]
```

只有全部维度满足才增加 reservation。禁止先扣 calls、后发现 recording slots 不足而留下部分预留。

### 6.3 热路径边界

新 interaction 允许一次 Edge -> Cell Admission RPC，但默认不允许：

- 同步查询业务 PostgreSQL。
- 同步调用 OCR/ASR/翻译/AI Provider。
- 广播到所有 Cell 寻找 owner。
- 对每个 SIP transaction、RTP packet、LiveKit track 或 IM fanout 重新 placement。

租户配置、路由和 profile 在发布时编译进入签名 snapshot。需要动态业务决策的场景使用独立 policy service、严格超时和静态 fallback，不成为所有 interaction 的默认依赖。

## 7. Owner directory 与持久化

### 7.1 三层目录

| 层 | 内容 | 一致性/用途 |
| --- | --- | --- |
| owner node memory | 当前 interaction session 和 media state | 最低延迟 |
| Cell owner cache | interaction -> node/epoch，短 TTL | command routing、node failure detection |
| regional durable projection | current owner + journal | 恢复、审计、跨 Cell lookup |

正常 command 优先使用 placement token 或 Cell cache。regional projection 是 fallback 和恢复 authority，不在每个媒体动作前查询。

### 7.2 Journal 事件

```text
placement.reserved
placement.activated
placement.reservation_expired
placement.drain_started
placement.owner_lost
placement.recovery_started
placement.owner_reassigned
placement.closed
```

事件至少包含 interaction ID、tenant、kind、Region/Zone/Cell/node、old/new epoch、profile、reason、时间和 idempotency key。PG projection 通过 outbox/consumer 幂等更新。

### 7.3 恢复缺口

placement 刚返回但 journal 尚未 durable 时：

- 客户端/Edge 持有签名 placement token。
- Cell owner cache 持有 reservation。
- Cell 在 1 秒内把 journal flush 到 regional durable bus。
- 超过 1 秒未确认 durable 的 active interaction 产生 `placement_journal_lag` 告警。
- Cell 整体在该窗口丢失时，客户端使用 interaction ID 和 token 请求重建；不承诺恢复尚未 durable 的瞬时媒体状态。

## 8. Drain

### 8.1 Cell drain

1. Control Plane 把 Cell 标记为 `draining` 并发布新 snapshot。
2. Edge 不再创建新 reservation。
3. 已 reserved 但未 active 的 interaction 可以在 TTL 内完成。
4. 已 active interaction 继续到自然结束。
5. 长生命周期 Tinode topic/gateway 按批次触发平滑 reconnect/handoff。
6. owner count 为 0 且 journal lag 为 0 后，Cell 才可下线。

### 8.2 Node drain

- RustPBX：不接新 call，等待 dialog 结束。
- LiveKit：使用原生 drain，已有 room 继续，新 room 拒绝。
- Tinode：停止新 session/topic owner，客户端分批重连。
- RustDesk hbbr：停止分配新 relay，已有 relay 自然结束。
- API/WS：连接分批发送 reconnect hint，避免同时重连。

## 9. 故障与 fencing

### 9.1 Node failure

1. Cell heartbeat 超时确认 owner node lost。
2. Cell 停止向该 node 路由 command。
3. 对可恢复 interaction 生成更高 owner epoch。
4. SIP 执行 re-INVITE/重拨策略；LiveKit 生成新 room/token 并 republish；RustDesk 重选 relay；Tinode 重连并从 durable seq 恢复。
5. 旧 node 恢复后看到更高 epoch，禁止恢复旧副作用。

### 9.2 Cell/Zone partition

- Cell lease 有限期并由第三仲裁故障域控制。
- 失去 quorum 的 Cell 在 lease 到期后停止新 admission 和 command mutation。
- 已有媒体可以按安全策略继续转发，但不得创建新持久副作用或声称仍是可控 owner。
- surviving Zone 获得更高 `cell_lease_epoch` 后才可以重建 interaction。

### 9.3 回调 fencing

RustPBX CDR、LiveKit webhook、Tinode event、RustDesk evidence callback 都必须携带 owner epoch 或可映射到 owner binding。旧 epoch 回调可以保存为审计证据，但不能覆盖 current state。

## 10. 通道适配

### 10.1 RustPBX

RustPBX Converact Fabric fork 增加：

- `node_id/cell_id/cell_lease_epoch`。
- owner-aware AMI/RWI command。
- dialog capacity/admission/drain endpoint。
- route snapshot 本地加载。
- webhook/CDR owner epoch。

Kamailio SIP Edge 保存 dialog route，确保同 dialog 回到 owner RustPBX。

### 10.2 LiveKit

LiveKit Converact Fabric fork/node selector 增加：

- room create metadata 中的 Cell、partition、profile 和 epoch。
- zone/cell-aware node filtering。
- track/bandwidth/PPS/TURN/Egress admission。
- node loss 后 room recreation 所需事件。

一个 room 仍固定在一个 LiveKit node；第一阶段不做跨节点透明 room live migration。

### 10.3 Tinode

Tinode Converact Fabric fork 增加：

- topic owner Cell/node/epoch。
- partition-aware shard selection。
- gateway 到 topic owner 的定向路由。
- reconnect 后按 durable seq 恢复。
- hot topic admission 和 fanout capacity。

### 10.4 RustDesk

RustDesk fork 增加：

- hbbs 返回 zone/cell/load-aware hbbr 列表。
- session owner/epoch。
- precise disconnect 和 relay drain。
- callback/evidence 中的 interaction ID 与 epoch。

## 11. 安全

- Placement snapshot 和 token 使用独立签名 key，支持 key ID 和轮换。
- Cell 只能为 token 中允许的 tenant/profile/kind 接纳 interaction。
- required capacity 由服务端 profile compiler 生成，防止客户端提交零成本请求。
- owner command 同时校验 tenant authorization、interaction ID 和 epoch。
- placement metadata 不包含 Provider secret、用户密码或媒体密钥。
- 所有 operator override 进入不可变审计。

## 12. 可观测性

低基数指标：

```text
placement_requests_total{region,zone,cell,kind,result}
placement_latency_seconds{region,kind}
placement_reservations{cell,kind,state}
placement_retries_total{reason}
placement_snapshot_age_seconds{region}
placement_owner_epoch_conflicts_total{component}
placement_journal_lag_seconds{cell}
cell_dominant_utilization_ratio{cell,dimension}
cell_owner_count{cell,kind}
```

`interaction_id`、`tenant_id`、`owner_node_id` 不作为 Prometheus label；它们进入 structured log/trace 和审计表。

## 13. 验收

必须覆盖：

1. 同一 idempotency key 不重复 reservation。
2. 多维 capacity 任一不足时原子拒绝且不泄漏预留。
3. weighted rendezvous 在 Cell 增删时只迁移有限 partition。
4. 大租户多个 partition 跨 Cell，单 interaction 仍保持 affinity。
5. snapshot 过期按时 fail closed。
6. stale owner epoch 的 command/callback 不覆盖 current state。
7. node、Cell、Zone 故障各重复 3 次。
8. 4/8 节点 placement 线性度和倾斜满足 profile。
9. Cell drain 不接新 interaction，旧 interaction 自然结束。
10. 1,000 SIP CPS burst 下 placement 不同步查询业务 PG。

## 14. 后果

### 正面

- 超大租户可以跨 Cell。
- Cell 扩容不要求迁移永久数据。
- placement 热路径有界且可压测。
- owner/fencing 统一覆盖语音、视频、IM 和远控。
- Cell 故障影响有界。

### 成本

- 需要 Region Directory、Cell Admission Service 和 owner journal。
- 四个开源底座需要 owner/epoch 适配。
- 故障后媒体恢复是协议级重建，不是简单 Pod 重启。

## 15. 不采用方案

| 方案 | 否决原因 |
| --- | --- |
| tenant 永久固定单 Cell | 大租户热点，迁移面过大 |
| 每次请求全局数据库选 Cell | 热路径延迟和共享上限 |
| 纯随机 Cell | partition/agent/topic 局部性差，倾斜不可控 |
| 只按 CPU 调度 | 忽略 PPS、带宽、录制、TURN、Provider slots |
| 允许多个 owner 无 fencing | 网络分区下重复命令和状态覆盖 |
| 一个 Cell 一套永久数据库 | 服务器浪费，compute/data 生命周期耦合 |

## 16. 实施边界

本 ADR 只决定协议和一致性边界，不在本轮实现 Region Directory、数据库表、RPC 或开源 fork。对应实现必须先用测试固化本 ADR 的类型、状态机和 fencing 语义。
