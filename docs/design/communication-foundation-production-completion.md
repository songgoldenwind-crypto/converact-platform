# 通信底座生产完备性总设计

> 日期：2026-07-21  
> 范围：iveKit/OPC/LED 共用的 IM、语音、视频通信底座  
> 状态：执行基线；物理容量和真实公网媒体验收不在本轮目标内

## 1. 设计裁决

通信底座只有同时满足以下四层，才可以标记为完成：

1. 功能能力完整：IM、SIP、音视频、屏幕共享、录制和 Provider 适配可用。
2. 单组件生产化：有界资源、健康检查、drain、指标、告警和安全配置完整。
3. 集群生产化：节点选择、会话归属、故障语义、横向扩展和双 Zone 部署完整。
4. 交付可验证：正式 Compose/Helm、自动化受控测试、升级回滚和运维文档一致。

历史文档中“Kamailio 延后到 v2.0+”只适用于早期千路以内 MVP，不再适用于
`MIX-100K + Cell + 双 Zone` 目标。生产架构以本文、
`CCaaS十万并发容量对标与架构优化调研.md` 和
`adr/ccaas-1-cell-placement.md` 为准。

本轮完成代码和受控故障测试，不据此宣称 10 万并发、真实 PSTN、真实 TURN 或生产
Kubernetes 已通过。物理压测在本设计全部落地后单独立项。

## 2. 核心不变量

### 2.1 控制面与数据面

- SIP INVITE、RTP 包、LiveKit track 转发和 Tinode 消息 fanout 的热路径不得同步访问
  PostgreSQL、对象存储或远程 iveKit HTTP API。
- PostgreSQL 是业务和配置 authority；Cell 本地签名快照是实时路由输入。
- Redis/NATS 用于协调和异步事件，不得成为每个 RTP 包或每个订阅者 fanout 的同步跳点。
- 录音、Egress、附件、OCR/ASR 和对象上传失败不得反压已建立的通话、房间或 IM 会话。

### 2.2 Owner 与 fencing

- 每个 SIP dialog、LiveKit room、Tinode topic 都有唯一 owner node 和 owner epoch。
- 新会话只进入 `accepting` 或有剩余容量的 `degraded` 节点。
- `draining` 节点不接新会话，但继续服务已有 owner；`offline` 节点不得接收新副作用。
- 旧 epoch 回调只能进入审计，不得覆盖当前状态。
- 不承诺把已建立的 RTP/B2BUA 会话透明迁移到另一 RustPBX；节点故障必须显式表现为
  断线、重连、重建或失败，不能伪造连续性。

### 2.3 过载

- 每个组件使用容量向量而非单一 CPU 指标。
- admission 是权威硬门；负载均衡只负责减少倾斜，不能绕过 admission。
- 所有队列有上限，超限必须拒绝、降级或丢弃非关键副本，并产生低基数指标。
- 扩容以 safe capacity 和会话 drain 为依据，不直接按瞬时 CPU 缩容实时节点。

## 3. 目标拓扑

```text
Global/Regional discovery
          |
          +---------------- Cell A / Zone A ----------------+
          |                                                  |
Carrier/WebPhone -> L4 -> Kamailio Edge -> RustPBX pool -> RTP/PSTN
Browser/App      -> L4 -> LiveKit signal -> LiveKit SFU pool
Browser/App      -> L4 -> Tinode client  -> Tinode cluster
WebRTC fallback  -> L4 -> TURN pool
                              |
                Cell admission + component-node sidecars
                              |
                signed local routing/capacity snapshots

Shared but off hot path: HA PostgreSQL, HA Redis, NATS JetStream,
object storage, Prometheus, logs and audit storage.
```

Cell A/Zone B 部署相同角色。一个 Zone 故障时，控制面只在获得更高 lease epoch 后把新会话
切到存活 Zone；已有媒体按各组件实际恢复能力重连或终止。

## 4. 当前状态审计

| 领域 | 已有能力 | 尚缺能力 | 当前裁决 |
| --- | --- | --- | --- |
| SIP/语音 | RustPBX fork、route snapshot、owner epoch、component admission、录音隔离、容量指标 | 正式 Kamailio Edge、多 RustPBX 分发、dialog pin、drain/failover、双 Zone、Edge 指标 | 部分完成 |
| IM | Tinode 完整业务接入、三节点容量模板、topic owner/fencing、fanout 热路径补丁、持久同步 worker | 正式 Chart 仍为单副本 Recreate；稳定集群发现、连接 drain、重连恢复、数据面指标和告警未统一 | 部分完成 |
| 视频 | LiveKit owner hook、SFU 小房间优化、Egress 独立池和伸缩、媒体 QoS | 正式 LiveKit SFU 集群、Redis HA、独立 TURN、SIP 池、node drain/reconnect、数据面监控未形成完整交付 | 部分完成 |
| 共享调度 | Cell placement、capacity vector、lease、component-node sidecar、owner fencing | 三个通信入口尚未全部消费相同状态；缺统一发布/drain 顺序 | 部分完成 |
| 监控 | iveKit API、业务队列、RustPBX 热路径和 Egress 告警 | Kamailio、Tinode server、LiveKit server、TURN、LiveKit SIP 的数据面指标和 SLO 不完整 | 部分完成 |

容量目录中的 StatefulSet 是设计和受控测试材料，不能替代正式交付 Chart。正式 Chart、默认
values、交付包和监控规则必须使用同一拓扑和同一镜像身份。

## 5. 语音与 SIP

### 5.1 负载均衡

- 每个 Cell 至少两个 Kamailio Edge，位于 L4 LoadBalancer 后。
- Kamailio 从本地签名快照加载 RustPBX pool，不在 INVITE 热路径请求数据库或 HTTP。
- 新 INVITE 使用 Kamailio dispatcher 相对权重算法，节点 `duid` 为稳定 component node ID，
  `rweight` 由 `voice.weighted_calls` 的全局剩余 safe capacity 计算。
- 每个 RustPBX 另有一个只包含自身的 pin set。初始选择后将 pin set 写入受 topology hiding
  保护的 Record-Route；BYE、re-INVITE、UPDATE 和 INFO 始终回到原 owner。
- RustPBX 本地 component admission 仍是最终权威，防止快照传播延迟造成超卖。

### 5.2 故障与 drain

- OPTIONS 探活与 component-node lease 同时健康才允许新流量。
- 连接失败、408、500、502、503、504 可在未接通前尝试下一节点；业务 4xx 不重试。
- 收到 2xx 后禁止换 owner。owner 失效时由终端重拨或上层恢复流程处理。
- drain 时从新呼叫 pool 移除，但保留 pin set，直到 active dialog 为零或运维强制结束。
- 路由快照过期时拒绝新 INVITE并返回 503/Retry-After，已有 dialog 继续走 pin set。

详细契约见 `docs/design/kamailio-sip-edge-design.md`。

## 6. Tinode IM

### 6.1 负载与归属

- 正式部署使用至少三副本 StatefulSet、headless cluster Service 和独立 client Service。
- WebSocket 一旦建立自然固定在接入 Pod；新连接由 L4 Service 分配。
- group topic 使用 iveKit owner registry；publish、metadata mutation 和 timer 只在 owner 执行。
- P2P/channel 保持 Tinode 原生语义，不用 iveKit mirror 代替 Tinode cluster 协议。
- 附件直接进入对象存储，Tinode 只承载 metadata；iveKit 审计和内容处理走 durable outbox。

### 6.2 故障与扩缩容

- Pod readiness 同时要求 Tinode `/health` 和 component-node lease 为 ready。
- drain 先停止新 WebSocket，再等待 session/topic owner 释放，最后终止 Pod。
- Pod 故障后客户端通过同一 Service 重连，并按 Tinode durable sequence 恢复。
- scale-out 使用稳定 ordinal 和显式 cluster topology；scale-in 必须先迁移 topic owner，不允许
  Kubernetes 直接删除仍有 owner 的 Pod。
- PostgreSQL 必须是外部 HA 服务；本地 RWO botdata 不能作为消息 authority。

### 6.3 必须补充的指标

- active WebSocket/session、连接建立/断开/重连总数。
- 本地/远程 topic 数、owner mismatch/fence rejection。
- fanout recipients、fanout duration、cluster RPC latency/error。
- store query latency/error、outbound queue depth、inbound cursor lag。
- component capacity、draining、lease freshness 和 reconnect storm。

## 7. LiveKit 视频

### 7.1 角色拆池

- LiveKit SFU、TURN、LiveKit SIP、Track Egress、RoomComposite Egress 分别部署和扩容。
- SFU 使用外部 HA Redis router；room 创建后固定到一个 LiveKit owner node。
- TURN 使用独立 coturn 池和独立带宽容量，不与 SFU CPU admission 混算。
- Egress 保持现有独立 pool、bounded spool、KEDA/HPA 和存储故障隔离。

### 7.2 入口和恢复

- 信令入口由 L4/Ingress 分发，LiveKit Redis router 和稳定 node ID 完成 room owner 路由。
- SFU readiness 必须结合 node admission；drain 后停止新 room，已有 room继续到自然结束。
- SFU 丢失时客户端按 reconnect policy 重连并重新发布 track；第一阶段不承诺透明 room migration。
- TURN 节点丢失时 ICE restart 选择新 relay；已失效 allocation 不伪造连续性。
- LiveKit SIP 为独立无媒体 authority 的 worker pool，至少两副本并通过 Redis/LiveKit 协调。

### 7.3 必须补充的指标

- node/room/participant/publisher/subscriber/track 数。
- ingress/egress bitrate、packet/s、NACK/PLI/FIR、丢包和 RTT。
- room routing failure、node unavailable、reconnect/ICE restart。
- TURN allocation、relay session、带宽、端口耗尽和认证失败。
- LiveKit SIP active calls、dispatch latency/error、Redis connectivity。
- Egress pending/active/spool/storage 指标继续沿用现有合同。

## 8. 数据与共享依赖

- 生产 values 禁止内置单副本 PostgreSQL、Redis、NATS 和对象存储作为 HA 声明。
- Tinode PostgreSQL 与 iveKit PostgreSQL 可共享运维集群，但必须使用独立数据库、角色、连接池
  和容量预算。
- LiveKit Redis 与通用缓存逻辑隔离 keyspace 和资源预算；Region 故障时按 LiveKit 支持的恢复
  语义处理，不假设 Redis 数据自动跨 Region 一致。
- NATS JetStream 承担异步事件和审计投影，不参与 RTP/SIP/Tinode ACK 热路径。
- 备份、恢复和数据保留使用外部 durable authority；节点本地盘只允许 cache/spool。

## 9. 统一监控与 SLO

### 9.1 低基数标签

允许：`component`、`region`、`zone`、`cell`、`node`、`pool`、`transport`、`result`、
`reason`。禁止 tenant、用户、号码、call、room、topic、message 和文件 ID。

### 9.2 最低告警集合

| 组件 | 告警 |
| --- | --- |
| Kamailio | 无可用 RustPBX、快照过期、OPTIONS 大面积失败、CPS/transaction/5xx/重传异常、dialog pin 失败 |
| RustPBX | admission/事务/连接/录音队列饱和、Router/CDR lag、owner fence、FD/CPU/RTP 端口水位 |
| Tinode | 节点少于 quorum、cluster RPC 失败、连接/重连风暴、topic owner mismatch、fanout/store 延迟 |
| LiveKit | 可用 SFU 节点不足、Redis router 失败、room/track 饱和、重连异常、媒体质量下降 |
| TURN | allocation/端口/带宽饱和、认证失败、节点不足 |
| SIP/Egress | worker 不足、任务积压、失败率、spool 水位和存储不可用 |

### 9.3 SLO 计算

- SIP：INVITE 成功率和路由 P99，按可控平台错误排除业务拒绝。
- IM：连接成功率、send-to-ack P99、durable sequence 恢复成功率。
- 视频：join P99、track publish/subscribe 成功率、非终端网络导致的 reconnect 比例。
- 控制面：placement/admission/snapshot freshness；控制面短时不可用不影响已建立会话。

## 10. 发布与回滚顺序

1. 发布兼容旧节点的新控制面和快照 schema reader。
2. 发布新 sidecar/Edge，保持旧快照 schema 双读。
3. 扩容新数据面节点并设为 `draining`，完成健康与恢复检查。
4. 切为 `accepting`，观察容量和错误指标。
5. 将旧节点设为 `draining`，等待 owner 清零。
6. 删除旧节点，最后停止旧 schema writer。

回滚只允许回到能读取当前快照、owner epoch 和事件 schema 的版本。数据库 migration 继续采用
expand/contract，不把 restore 当作普通应用回滚。

## 11. 开发目标顺序

### Goal A：Kamailio 与多 RustPBX

完成本地签名路由快照、dispatcher/pin set、健康检查、drain、失败重试、TLS/WSS、拓扑隐藏、
限流、Compose/Helm、指标、告警和受控双节点故障测试。

### Goal B：Tinode 正式集群

把三节点容量模板提升为正式 Chart；补齐 cluster config、stable identity、连接 drain、owner 迁移、
数据面指标、告警和受控重连/节点故障测试。

### Goal C：LiveKit/TURN/SIP 正式集群

把 LiveKit owner StatefulSet、独立 coturn、LiveKit SIP 和现有 Egress pool 纳入正式 Chart；补齐
Redis HA 外部合同、drain/reconnect、指标、告警和受控故障测试。

### Goal D：统一交付与故障演练

统一 Compose/Helm/SDK/运维文档和 release manifest，完成快照过期、单节点故障、drain、Redis
短暂不可用、对象存储不可用的自动化受控验收。

## 12. 代码完成标准

- 正式 Chart 不再用 RustPBX/Tinode/LiveKit 单副本模板代表生产集群。
- 三个通信域都消费稳定 node ID、Cell/Zone、lease、capacity 和 drain 状态。
- 所有实时路由在本地完成，远程控制面故障不会阻断已有会话。
- 每个故障规则都有自动化测试、指标、告警和 runbook。
- Compose、Helm、交付包、fork manifest、审计文档和默认值无冲突。
- typecheck、相关 Node/Go/Rust 测试、Helm lint/template 和配置语法测试通过。
- 真实负载、真实 PSTN、真实 TURN 公网链路和目标双 Zone 集群仍明确标记 `not_run`，留给后续
  物理压测与环境验收 Goal。
