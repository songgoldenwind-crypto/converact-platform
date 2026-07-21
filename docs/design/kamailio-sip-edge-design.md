# Kamailio SIP Edge 执行级设计

> 日期：2026-07-21  
> 上位设计：`communication-foundation-production-completion.md`  
> 目标：完成 Cell 本地、无远程热路径、可 drain 和可审计的 SIP Edge

## 1. 边界

Kamailio 负责 SIP 接入、基础安全、事务代理、RustPBX pool 选择、初始失败重试和 dialog
affinity。RustPBX 继续负责 B2BUA、IVR、ACD、queue、conference、RWI、RTP/SRTP 和 CDR。

Kamailio 不负责：

- 改写业务路由和 IVR 决策；
- 在已接通后把 B2BUA 会话迁移到另一 RustPBX；
- 同步查询 tenant 数据库；
- 承担 RTP relay；
- 代替 Cell admission 的权威容量判断。

## 2. 进程拓扑

每个 Cell/Zone 部署：

```text
L4 VIP
  +-> kamailio-0 ----+
  +-> kamailio-1 ----+-> RustPBX StatefulSet/headless Service
         ^
         |
  route-agent sidecar
    - polls component-node /v1/state
    - validates Cell lease and capacity
    - signs/verifies snapshot
    - atomically writes dispatcher.list
    - calls loopback-only JSON-RPC dispatcher reload
```

JSON-RPC 只监听 Pod loopback，NetworkPolicy 和配置同时拒绝非 `127.0.0.1` 来源。Kamailio
自身没有 PostgreSQL、Redis 或 iveKit API 凭据。

生产镜像固定为上游 `kamailio/kamailio@6.0.7` 源码构建，源码归档 SHA-256、模块集合、
amd64/arm64 buildx、SBOM 和 provenance 由 `infra/ivekit/kamailio/` 固化。历史
`kamailio/kamailio:5.8` 镜像引用无对应制品，不得继续使用；部署只接受 iveKit registry
中的 `@sha256:` 引用。

## 3. 路由快照

### 3.1 Envelope

```text
ivekit-kamailio-route-v1.<key_id>.<base64url_hmac_sha256>
<canonical-json-body>
```

HMAC 覆盖第二行的原始字节。reader 支持当前 key 和一个 previous key；writer 只使用 current
key。快照最大 4 MiB、最多 1,024 个 RustPBX 节点、TTL 1-300 秒。

### 3.2 Body

```json
{
  "schema_version": "1.0.0",
  "sequence": 1,
  "region_id": "region-a",
  "zone_id": "zone-a",
  "cell_id": "cell-a",
  "cell_lease_epoch": 7,
  "generated_at": "2026-07-21T00:00:00.000Z",
  "expires_at": "2026-07-21T00:00:10.000Z",
  "edge_replica_count": 2,
  "pools": [{
    "pool_id": 100,
    "profile_id": "cell-10k-v1",
    "nodes": [{
      "node_id": "rustpbx-a-0",
      "sip_uri": "sip:rustpbx-a-0.rustpbx-headless:5060;transport=udp",
      "pin_set_id": 10000,
      "state": "accepting",
      "safe_capacity": 2500,
      "used": 800,
      "reserved": 50,
      "routing_weight": 100,
      "priority": 10
    }]
  }]
}
```

先计算每个节点的 `headroom = safe_capacity - used - reserved`，再按 pool 内最大 headroom
归一化：`routing_weight = clamp(1, 100, round(100 * headroom / max_headroom))`。
`headroom <= 0` 的节点不进入新呼叫 pool。权重只负责减少倾斜；RustPBX component admission
仍做全局精确授权。

### 3.3 单调性和失效

- reader 拒绝 Cell identity、lease epoch 或 topology 不匹配的快照。
- sequence 必须严格递增；相同 body 的续租也产生更高 sequence。
- 原子写使用同目录临时文件、`fsync`、`rename` 和目录 `fsync`。
- HMAC、schema、边界或生成时间非法时保留 last-known-good 并上报告警。
- last-known-good 过期后，Kamailio 停止新 INVITE；已有 pin set 保留。
- Cell lease epoch 增加时立即拒绝旧 epoch 快照。

## 4. Dispatcher 编译

每个 pool 生成一个新呼叫 set，每个节点生成一个独占 pin set：

```text
100 sip:rustpbx-a-0... 8 10 duid=rustpbx-a-0;rweight=100;pinset=10000;node=rustpbx-a-0
100 sip:rustpbx-a-1... 8 10 duid=rustpbx-a-1;rweight=75;pinset=10001;node=rustpbx-a-1
10000 sip:rustpbx-a-0... 8 10 duid=rustpbx-a-0-pin;node=rustpbx-a-0
10001 sip:rustpbx-a-1... 8 10 duid=rustpbx-a-1-pin;node=rustpbx-a-1
```

flag `8` 使 OPTIONS probing 持续执行。`draining` 节点不写入 set 100，但继续保留独占 pin
set。`offline` 节点的 pin set 使用 inactive+probing，确保旧 dialog 明确失败而不是漂移。

新呼叫使用 dispatcher 算法 11 的 relative-weight 分发。算法 10 的 call-load map 在活动呼叫
存在时不能安全 reload，因此明确不采用。更新采用以下规则：

1. route-agent 原子替换完整 dispatcher 文件后调用受限 loopback RPC reload；
2. draining 节点从新呼叫 set 删除，但独占 pin set保留；
3. offline 节点的独占 pin set保留为 inactive+probing；
4. 节点彻底退役且没有 owner dialog 后，下一快照才删除其 pin set；
5. schema 或配置结构变化通过滚动替换 Edge Pod完成。

pin set ID 由控制面稳定分配并随节点身份持久，不能按列表顺序生成。测试必须证明热更新不会
删除仍有 owner dialog 的 pin set。

## 5. SIP 路由状态机

### 5.1 初始请求

1. `REQINIT`：Max-Forwards、sanity、消息大小、方法白名单和来源 ACL。
2. REGISTER：按 trunk/终端策略执行 digest 或 mTLS；不允许匿名公网注册。
3. 初始 INVITE：快照 freshness gate、Cell state gate、per-source/per-trunk rate limit。
4. `ds_select_dst(pool, 11, limit)` 按剩余容量相对权重选择候选，并记录
   `duid/node/pinset`。
5. `dlg_manage()`、`record_route()`，把 pin set、Cell epoch 和 Edge schema 写入 Record-Route；
   topoh 对路由和拓扑信息进行掩码。
6. 添加内部 `X-IveKit-*` header 给 RustPBX，离开信任边界前删除外部伪造的同名 header。
7. `t_relay()`。

### 5.2 后续请求

- CANCEL 和负响应 ACK 复用原 transaction destination。
- 有 To-tag 的请求先 `loose_route()`，读取 topology-hidden pin set。
- pin set、epoch 或 node 不合法时返回 481，不回退到新呼叫 pool。
- 同 dialog 的 re-INVITE、UPDATE、INFO、PRACK 和 REFER 只发送到 pin owner。

### 5.3 初始失败重试

仅以下情况在尚未收到 2xx 时调用 `ds_next_dst()`：

- transport failure；
- 408；
- 500、502、503、504。

401/407 由鉴权状态机处理；403、404、480、486、487、488 和其他业务 4xx 原样返回。已经收到
2xx 或 dialog confirmed 后禁止换节点。

所有候选失败返回 503，并带有有界 `Retry-After`。不得把失败请求同步转到另一 Cell，跨 Zone
接管必须由更高 Cell lease epoch 的新快照授权。

## 6. 健康、drain 与恢复

### 6.1 双门健康

节点只有同时满足下列条件才进入新呼叫 set：

- component-node `/v1/state`：lease fresh、recovery complete、state 为 accepting/degraded；
- Kamailio OPTIONS：达到连续成功阈值。

component state决定管理意图，OPTIONS 决定网络可达性。任一失败都停止新流量。

### 6.2 阈值

- OPTIONS 每 2 秒一次，超时 500 ms；
- 连续 3 次失败进入 inactive；
- 连续 2 次成功恢复；
- degraded 节点降低 `routing_weight`，但不低于一个保底权重；
- snapshot TTL 默认 10 秒，route-agent poll 默认 1 秒。

### 6.3 Pod 终止

preStop 顺序：

1. component-node `POST /v1/drain`；
2. route-agent 发布不含该节点的新呼叫快照；
3. readiness 失败，L4 不再分配新连接；
4. 等待 active dialog 为零或 termination grace 到期；
5. 停止 Kamailio/RustPBX。

## 7. 安全

- 外部入口支持 UDP/TCP/TLS/WSS，生产至少启用 TLS 1.2；弱 cipher 禁止。
- carrier trunk 使用 mTLS 或源网段 ACL + digest；WebPhone 使用短期凭据。
- `pike`、`htable` 和分层 token bucket 分别限制来源 IP、trunk 和全局 CPS。
- `topoh` 隐藏 Via、Route、Record-Route、Contact 和内部 host；密钥来自 Secret。
- 移除外部 `X-IveKit-Node-ID`、`X-IveKit-Cell-*` 和 owner header，再由 Edge 重建。
- JSON-RPC、metrics 和 dispatcher 文件不暴露公网。
- 日志不记录完整号码、Authorization、SDP、token 或用户可识别 Call-ID。

## 8. 指标与告警

route-agent 暴露：

- `ivekit_kamailio_snapshot_valid`、`snapshot_age_seconds`、`snapshot_sequence`；
- `ivekit_kamailio_route_nodes{state}`、`route_reload_total{result}`；
- `ivekit_kamailio_route_poll_duration_seconds{result}`；
- `ivekit_kamailio_route_rejections_total{reason}`。

Kamailio 暴露：

- request/response/transaction/CPS；
- active/early/failed dialog；
- dispatcher active/inactive/trying destination；
- OPTIONS latency/failure；
- failover attempt/exhaustion；
- rate-limit、sanity、ACL 和 stale-snapshot rejection。

必须提供：快照过期、无可用 RustPBX、超过一半 destination down、failover exhaustion、重传异常、
5xx 异常、dialog pin 失败和 CPS/transaction 饱和告警。

## 9. 部署

- 正式 Helm 使用 Kamailio Deployment，默认两副本、zone/hostname spread、PDB minAvailable=1。
- RustPBX 使用 StatefulSet 和 headless Service，稳定 Pod 名即 component node ID。
- SIP/TLS/WSS Service 与 loopback RPC/metrics Service 分离；RPC 不创建 Kubernetes Service。
- RTP 仍直达 RustPBX，不经过 Kamailio。
- Compose 提供两个 RustPBX 和一个 Kamailio 的受控拓扑，不宣称 HA。
- 镜像必须绑定 digest；Kamailio 配置、route-agent 和 snapshot schema 进入交付 manifest。

## 10. 自动化验收

代码完成必须覆盖：

1. snapshot canonicalization、HMAC、key rotation、大小/节点/TTL/sequence 边界；
2. accepting/degraded/draining/offline 到 dispatcher/pin set 的编译；
3. 旧 dialog 的 pin set 不被热更新删除；
4. stale snapshot 拒绝新 INVITE但保留 pin set；
5. 初始 transport/408/5xx 重试，业务 4xx 不重试；
6. BYE/re-INVITE 固定 owner；
7. OPTIONS down/up 阈值和 component state 双门；
8. drain 和滚动发布顺序；
9. TLS/WSS、拓扑隐藏、伪造 header、ACL 和限流配置；
10. Compose/Helm render、PDB、spread、NetworkPolicy、ServiceMonitor、PrometheusRule；
11. SIPp 受控双 RustPBX 路由和单节点故障场景；
12. 交付包 hash、secret scan 和文档状态一致。

物理 CPS、长稳、真实运营商、双 Zone 和节点扩展曲线在后续压测 Goal 中执行，本目标不把静态或
受控结果升级为物理容量结论。
