# iveKit 共享底座监控与告警手册

> 适用范围：OPC、LED 及其他业务复用的 iveKit 独立通信底座  
> 不包含：业务域 KPI、移动端推送指标、真实供应商 SLA 替代承诺

## 1. 交付内容

iveKit API 通过 `GET /metrics` 暴露 Prometheus 指标。独立 Helm Chart 提供三类可选资源：

| 资源 | Values 开关 | 作用 |
| --- | --- | --- |
| ServiceMonitor | `monitoring.serviceMonitor.enabled` | 发现 API Service 并抓取 `/metrics` |
| PrometheusRule | `monitoring.prometheusRule.enabled` | 安装 API、通知、Tinode、Provider、媒体、Voice、IVR、保留和备份告警 |
| Grafana ConfigMap | `monitoring.grafanaDashboard.enabled` | 由 Grafana sidecar 导入共享底座运维大盘 |

源文件位于：

- `services/ivekit-service/helm/ivekit/files/prometheus-rules.yaml`；
- `services/ivekit-service/helm/ivekit/files/grafana-dashboard.json`。

两份文件不依赖 Helm。普通 Prometheus 可以把规则文件加入 `rule_files`，Grafana 可以直接导入 dashboard JSON。

## 2. 启用前提

Chart 默认关闭监控 CRD，防止目标集群未安装依赖时阻断 iveKit 部署。启用前确认：

1. 集群已经安装 Prometheus Operator 的 `ServiceMonitor` 和 `PrometheusRule` CRD；
2. Prometheus 有权限发现 iveKit 所在 namespace；
3. Grafana sidecar 按 `grafana_dashboard=1` 发现 ConfigMap，或由运维手工导入 JSON；
4. Prometheus 抓取网络能访问 iveKit ClusterIP 的 `http` 端口；
5. `kube-state-metrics` 已安装，否则 `IveKitBackupJobFailed` 没有输入序列；
6. `/metrics` 只向监控网络开放，不通过公网 Ingress 暴露。

示例 values：

```yaml
monitoring:
  serviceMonitor:
    enabled: true
    interval: 30s
    scrapeTimeout: 10s
    labels:
      release: kube-prometheus-stack
  prometheusRule:
    enabled: true
    labels:
      release: kube-prometheus-stack
  grafanaDashboard:
    enabled: true
    labels:
      grafana_dashboard: "1"
```

部署后检查：

```bash
kubectl -n <namespace> get servicemonitor,prometheusrule,configmap
kubectl -n <namespace> port-forward svc/<release>-ivekit 3000:3000
curl -fsS http://127.0.0.1:3000/metrics
```

## 3. 指标字典

### 3.1 API 与进程

| 指标 | 类型 | 关键标签 | 用途 |
| --- | --- | --- | --- |
| `opc_http_requests_total` | Counter | `method,path,status` | 请求量和 5xx 比例 |
| `opc_http_request_duration_seconds` | Histogram | `method,path` | API 延迟分位数 |
| `opc_node_nodejs_eventloop_lag_p99_seconds` | Gauge | 无业务 ID | Node.js 事件循环阻塞 |
| `up` | Gauge | Prometheus target 标签 | 抓取目标可用性 |

### 3.2 通知

| 指标 | 类型 | 关键标签 | 用途 |
| --- | --- | --- | --- |
| `opc_ivekit_notification_queue_depth` | Gauge | `state` | pending/processing/retry_wait 等队列深度 |
| `opc_ivekit_notification_queue_oldest_age_seconds` | Gauge | `state` | 最老待处理投递等待时间 |
| `opc_ivekit_notification_delivery_attempts_total` | Counter | `channel,provider,result,error_code` | delivered/accepted/retry/uncertain/failed/dead-letter |
| `opc_ivekit_notification_health_probes_total` | Counter | `channel,provider,outcome,code` | Endpoint 主动健康检查 |
| `opc_ivekit_notification_health_probe_duration_seconds` | Histogram | `channel,provider,outcome` | Provider 健康探测延迟 |
| `opc_ivekit_notification_provider_reservations_total` | Counter | `channel,result,reason` | 配额、熔断和半开探针 |
| `opc_ivekit_notification_lease_lost_total` | Counter | `channel` | 多 worker fencing 冲突 |
| `opc_ivekit_notification_receipt_reconciliations_total` | Counter | `result` | 异步回执收敛结果 |
| `opc_ivekit_event_webhook_operations_total` | Counter | `result` | 集成事件扫描、过滤、投递、失败和租约丢失 |
| `opc_ivekit_event_webhook_oldest_event_age_seconds` | Gauge | 无 | 最近批次观察到的最老事件年龄 |

### 3.3 IM、文件和智能内容

| 指标 | 类型 | 关键标签 | 用途 |
| --- | --- | --- | --- |
| `opc_ivekit_tinode_delivery_queue_messages` | Gauge | `status` | Tinode 出站队列 |
| `opc_ivekit_tinode_delivery_queue_lag_seconds` | Gauge | 无 | 最老出站消息延迟 |
| `opc_ivekit_tinode_inbound_cursor_lag_sequences` | Gauge | 无 | 入站 sequence 游标差 |
| `opc_ivekit_tinode_inbound_dead_letters` | Gauge | `state` | 入站可重试/终态死信 |
| `opc_ivekit_tinode_file_blocked_messages` | Gauge | `state` | 文件安全等待或终态阻断 |
| `opc_ivekit_intelligence_provider_requests_total` | Counter | `capability,profile_id,result,error_code` | OCR/ASR/翻译/质检请求结果 |
| `opc_ivekit_intelligence_provider_failovers_total` | Counter | bounded profile labels | Provider 故障切换 |
| `opc_ivekit_intelligence_provider_routes_exhausted_total` | Counter | `capability` | 路由全部不可用 |
| `opc_ivekit_intelligence_provider_circuit_transitions_total` | Counter | bounded state labels | 熔断状态变化 |

### 3.4 LiveKit、Voice 与 IVR

| 指标 | 类型 | 关键标签 | 用途 |
| --- | --- | --- | --- |
| `opc_ivekit_media_qos_packet_loss_ratio` | Histogram | `track_source` | 真实客户端上报丢包分布 |
| `opc_ivekit_media_qos_rtt_seconds` | Histogram | `track_source` | 真实客户端上报 RTT |
| `opc_ivekit_media_qos_transitions_total` | Counter | `event_type` | 防抖后的质量状态变化 |
| `opc_ivekit_voice_commands_total` | Counter | `adapter,kind,result,error_code` | RustPBX/SIP 命令结果 |
| `opc_ivekit_voice_uncertain_commands_total` | Counter | `adapter,kind` | 结果不确定、需要对账的命令 |
| `opc_ivekit_voice_provider_event_lag_seconds` | Histogram | `adapter,event_type` | Provider 事件处理延迟 |
| `opc_ivekit_voice_reconciliations_total` | Counter | `adapter,result` | Voice 状态对账 |
| `opc_ivekit_voice_audio_tap_events_total` | Counter | `media_source,event_type,reason` | RustPBX/LiveKit 实时 PCM 旁路连接、会话、丢弃、投影和失败 |
| `opc_ivekit_voice_audio_tap_dropped_seconds_total` | Counter | `media_source,reason` | 为保护主媒体路径而丢弃的旁路音频秒数 |
| `opc_ai_voice_stage_latency_seconds` | Histogram | `stage,media_source` | AI Agent 已提交 turn 的 ASR final、端点判定、LLM 首 token、TTS 首音频和端到端语音延迟 |
| `opc_ai_voice_latency_budget_exceeded_total` | Counter | `stage,media_source` | 超过对应阶段延迟预算的样本数 |
| `opc_ivekit_ivr_pending_actions_total` | Counter | `kind,result,error_code` | IVR durable action 结果 |
| `rustpbx_sip_endpoint_running_transactions` / `rustpbx_sip_endpoint_active_transaction_limit` | Gauge | 无业务标签 | SIP 活动事务占用与硬上限 |
| `rustpbx_sip_endpoint_incoming_queue_depth` / `rustpbx_sip_endpoint_incoming_queue_capacity` | Gauge | 无业务标签 | 有界事务队列占用 |
| `rustpbx_sip_transport_connections_active` / `rustpbx_sip_transport_connection_limit` | Gauge | 无业务标签 | TCP/TLS/WebSocket 连接占用 |
| `rustpbx_sip_endpoint_active_limit_rejections_total` / `rustpbx_sip_endpoint_incoming_queue_rejections_total` / `rustpbx_sip_transport_connection_limit_rejections_total` | Counter | 无业务标签 | 显式过载拒绝证据 |

### 3.5 Kamailio SIP Edge

| 指标 | 类型 | 关键标签 | 用途 |
| --- | --- | --- | --- |
| `ivekit_kamailio_snapshot_valid` / `ivekit_kamailio_snapshot_age_seconds` | Gauge | Pod | Cell 本地签名路由快照新鲜度 |
| `ivekit_kamailio_new_call_nodes` | Gauge | Pod | 当前可接收新呼叫的 RustPBX 数量 |
| `ivekit_kamailio_route_nodes` | Gauge | `state` | accepting/degraded/draining/offline 节点数 |
| `ivekit_kamailio_route_reload_total` | Counter | `result` | dispatcher 原子发布后的 reload 结果 |
| `ivekit_kamailio_core_metrics_up` | Gauge | Pod | loopback Kamailio 指标是否被 route-agent 安全代理 |
| `ivekit_kamailio_hep_mode` | Gauge | `mode` | 最近一次确认写入 Kamailio 的 full/sampled/off 状态；尚未确认时三个 mode 均为 0 |
| `ivekit_kamailio_hep_desired_mode` | Gauge | `mode` | 控制器根据 HOMER 压力选择的目标状态，三个 mode 中恰有一个为 1 |
| `ivekit_kamailio_hep_control_pending` | Gauge | Pod | 目标状态或 revision 尚未由 Kamailio 确认 |
| `ivekit_kamailio_hep_collector_up` | Gauge | Pod | route-agent 最近一次 HOMER metrics 抓取是否成功 |
| `ivekit_kamailio_hep_observation_valid` | Gauge | Pod | queue/CPU/packet/gap 是否均来自可比较的连续 scrape；为 0 时禁止向 full 恢复 |
| `ivekit_kamailio_hep_collector_queue_ratio` | Gauge | Pod | HOMER worker queue 使用比例 |
| `ivekit_kamailio_hep_collector_cpu_cores` | Gauge | Pod | HOMER 进程使用的 CPU core 数 |
| `ivekit_kamailio_hep_collector_packets_per_second` | Gauge | Pod | HOMER HEP 接收速率 |
| `ivekit_kamailio_hep_collector_processing_gap_per_second` | Gauge | Pod | HEP 接收与处理速率的正差 |
| `ivekit_kamailio_hep_control_apply_failures_total` | Counter | Pod | authenticated loopback RPC 应用失败 |
| `ivekit_kamailio_hep_transitions_total` | Counter | Pod | 成功应用的 HEP 模式切换 |
| `kamailio_core_ivekit_dispatch_failures` | Counter | 无业务标签 | 初始 INVITE 候选耗尽 |
| `kamailio_core_ivekit_pin_failures` | Counter | 无业务标签 | dialog owner pin/epoch 无法兑现 |
| `kamailio_core_ivekit_webphone_auth_failures` | Counter | 无业务标签 | WSS Origin/JWT/subject/From 身份拒绝 |
| `kamailio_core_ivekit_webphone_assertion_failures` | Counter | 无业务标签 | Edge 无法签发短期内部断言 |
| `kamailio_core_ivekit_webphone_registrations` | Counter | 无业务标签 | RustPBX 2xx 后成功保存的 WebPhone location |
| `kamailio_core_ivekit_webphone_location_save_failures` | Counter | 无业务标签 | RustPBX 已接受但 Edge usrloc 保存失败 |
| `kamailio_core_ivekit_webphone_delivery_misses` | Counter | 无业务标签 | RustPBX 发起呼叫但 Edge 无可用 WebPhone location |
| `kamailio_core_ivekit_dmq_rejects` | Counter | 无业务标签 | 非专用端口或非允许来源的 KDMQ 拒绝 |

### 3.6 安全和运维

| 指标 | 类型 | 关键标签 | 用途 |
| --- | --- | --- | --- |
| `opc_ivekit_rate_limit_rejections_total` | Counter | `route,scope` | 多实例分布式限流拒绝 |
| `opc_ivekit_retention_runs_total` | Counter | `category,result` | 数据保留任务结果 |
| `opc_ivekit_retention_records_total` | Counter | `category,result` | 删除、保留、跳过数量 |
| `kube_job_status_failed` | kube-state-metrics | Kubernetes Job 标签 | 备份 CronJob 失败 |

任何指标都不能加入 tenant、用户、号码、邮箱、notification、message、session、call、delivery 或文件 ID 标签。这些标识只能进入受权限控制的日志、审计和 PostgreSQL 查询，否则会造成高基数与隐私泄漏。

## 4. 告警与处置

### IveKitApiUnavailable

先检查 Deployment 可用副本、readiness、PostgreSQL 连接和 migration 状态，再检查 Service/ServiceMonitor selector。不要仅重启 Pod 掩盖 migration 或数据库故障。

### IveKitApiHighErrorRate

按 route/status 查看 API 指标和结构化错误码；结合 `/readyz` 判断数据库、配置或 Provider 依赖。确认错误只集中在单个 Provider 路由时，优先切换或熔断 Provider。

### IveKitEventLoopLagHigh

检查 CPU throttling、同步计算、超大 JSON、日志阻塞和并发设置。先保留 profile/metrics 证据，再滚动替换异常实例。

### IveKitNotificationQueueStalled

检查 worker heartbeat、`OPC_IVEKIT_NOTIFICATION_WORKER_ENABLED`、lease、Provider health、配额和熔断。允许过期 processing lease 被其他实例接管，不直接修改 worker_id/lease 字段。

### IveKitEventWebhookLag

检查 `event_webhook_worker` heartbeat、`OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED`、订阅的 `last_event_id/next_attempt_at/status` 和租约。随后比较 `ivekit_tenant_events` 最新 ID；若游标正常推进但通知仍延迟，继续检查 endpoint 健康与通知队列，不能直接跳游标丢弃事件。

### IveKitEventWebhookFailures

先区分 `failed`、`lease_lost` 和 `worker_error`。`failed` 检查 Endpoint 是否仍为 active webhook、secret ref、DNS/TLS、配额和熔断；`lease_lost` 检查批次耗时与 lease 配置；`worker_error` 检查 PostgreSQL 和 migration 073。修复后让持久游标自动重试，不手工复制投递。

### IveKitNotificationDeadLetters

通过管理 API 查询 delivery 的安全错误投影。修复配置后使用带 actor、expected state 和幂等 operation ID 的手工 retry；`uncertain` 必须先查 Provider 或回执，禁止盲重发。

### IveKitNotificationProviderUnhealthy

检查 DNS/TLS、凭据引用、Provider quota、HTTP/SMTP probe code 和最近 endpoint revision。确认备用 endpoint 健康后再调整优先级或暂停故障 endpoint。

### IveKitTinodeDeliveryLag

检查 Tinode 可用性、outbound worker heartbeat、队列状态和文件安全门禁。区分 Provider 网络失败与附件仍在扫描/转码，不绕过 quarantine。

### IveKitTinodeInboundDeadLetters

按 dead-letter API/数据库安全投影定位 provider sequence 和错误码，修复后使用 replay 操作。唯一约束和 cursor authority 必须保留，不能删 cursor 强制全量重放。

### IveKitFileSecurityBlockedTerminal

检查真实 MIME、扫描结果、quarantine 原因和 derivative job。恶意或 MIME 冲突文件保持隔离；只有误报复核后才能创建新的受审计处理操作。

### IveKitIntelligenceRouteExhausted

检查 capability policy、profile health、minute/day/concurrency quota、circuit 和 secret resolver。真实 Provider 未配置时，该告警说明相关功能不可用，不得用 controlled Provider 冒充生产恢复。

### IveKitMediaPacketLossHigh

确认客户端确实持续上报 QoS，再检查 TURN、UDP/TCP 路径、区域、带宽和终端网络。该指标不能替代真实双端媒体、录制和弱网验收。

### IveKitVoiceCommandUncertain

立即运行 Voice reconciliation，核对 RustPBX RWI/AMI/CDR 和当前 call snapshot。命令可能已执行，禁止重复 originate、transfer、hangup 或录音操作。

### IveKitVoiceProviderEventLag

检查 RustPBX webhook/Router/CDR 队列、worker heartbeat、数据库锁和时钟偏差。先恢复事件消费，再判断是否需要 call reconciliation。

### IveKitKamailioRouteSnapshot

`IveKitKamailioSnapshotExpired` 表示该 Edge 已对新呼叫 fail-closed。先比较 route-agent
`/readyz`、component-node `/v1/state`、Cell lease epoch、节点时钟和
`ivekit_kamailio_route_reload_total`。签名、Cell/Zone/epoch 或 sequence 不一致时不得跳过校验；恢复
Cell admission authority 或正确密钥后等待新快照发布。已有 dialog 继续走保留的 pin set，不要为恢复
新呼叫而重启仍承载会话的 RustPBX。

### IveKitKamailioCoreMetrics

`IveKitKamailioCoreMetricsUnavailable` 表示 route-agent 可抓取，但 loopback `127.0.0.1:5065/metrics`
不可读。检查 Kamailio 进程、xhttp_prom、共享网络命名空间和 1 MiB 响应上限。RPC/metrics 端口不得临时
发布为 Service 或宿主机公网端口；修复 sidecar/配置后确认 `ivekit_kamailio_core_metrics_up=1`，再验证
failover 和 pin counter 连续。

### IveKitKamailioHepHighWater

`IveKitKamailioHepCollectorUnavailable` 表示 route-agent 无法读取 HOMER `/metrics`。先检查
collector Pod、metrics Service/NetworkPolicy、DNS、TCP 端口和 1 MiB 响应上限；不要为了恢复
诊断链路重启仍承载通话的 Kamailio。控制器会先 sampled，连续失败达到门槛后 off，SIP readiness
保持独立。

`IveKitKamailioHepControlFailure` 表示新的 mode/bucket/revision 未完整应用，
`IveKitKamailioHepControlPending` 表示 desired 与已确认 applied 状态持续不一致。检查 loopback RPC
token 文件、`127.0.0.1:5065/RPC`、共享网络命名空间和 htable 模块；控制器会重试同一目标状态，
并在 Kamailio 重启导致 revision 归零后自动重放。route-agent 单独重启时，新控制器会先确认
`off`，待两次可比较的 healthy 样本完成导数预热和恢复迟滞后才逐级放宽；如果重启后直接看到
`full` 且 `observation_valid=0`，应视为保护失效。禁止手工递增 revision。恢复后确认 pending=0、
apply failure counter 不再增加，并依次观察
`off -> sampled -> full`，不应跳过恢复迟滞。

`IveKitKamailioHepTraceDisabled` 表示 HEP 已进入 off。结合 queue、CPU、packet rate、processing
gap 和 collector-up 判断是 collector 过载还是抓取失败。off 只丢失诊断副本，不应降低呼叫成功率；
若 SIP 同时异常，按独立的 route snapshot、RustPBX pool、系统 CPU/网络和数据库告警排查。事故结束
前保存 mode revision、transition counter 和同一时间窗的 HOMER 指标，禁止通过临时打开全量 trace
制造二次过载。

### IveKitKamailioRouteCapacity

`IveKitKamailioNoAvailableRustPbx` 和 `IveKitKamailioMajorityDestinationsDown` 先按
accepting/degraded/draining/offline 分解。对比 component lease、recovery、safe headroom 与 OPTIONS
状态：管理状态不健康时修复 Cell synchronizer，只有 OPTIONS 失败时检查 DNS、Pod/host 网络、5060
ACL 和 RustPBX 进程。禁止把 draining 节点手工改回 pool；扩容后必须由更高 sequence 的签名快照纳入。

### IveKitKamailioRouteReload

`IveKitKamailioRouteReloadFailure` 说明 dispatcher 文件已准备但 loopback JSON-RPC 未激活。核对 RPC
token 是否与渲染配置来自同一 Secret、端口是否为 5065、文件 UID/GID 与 Kamailio parser 结果。route-agent
会重试同一 sequence，不应手工增加 sequence 或直接覆盖 dispatcher。reload 成功且快照仍新鲜后再结束事故。

### IveKitKamailioFailover

`IveKitKamailioFailoverExhausted` 表示一个未接通 INVITE 的有限候选全部发生 transport、408 或允许的
5xx。保存对应时间窗的 OPTIONS、RustPBX admission/503、L4 分配和 counter 增量；确认不是重传风暴或
全节点容量耗尽。业务 4xx 不应触发该计数，已收到 2xx 的 dialog 也不得换 owner。

### IveKitKamailioDialogPin

`IveKitKamailioDialogPinFailure` 表示 BYE、re-INVITE、UPDATE、INFO、PRACK 或 REFER 无法回到原
RustPBX owner。检查 Record-Route/topoh key、pin set 是否在 drain 后被误删、Cell epoch 是否提前切换、
原节点是否已离线。不能回退到新呼叫 pool；必要时明确终止该 dialog 并保留审计，修复发布/退役顺序。

### IveKitKamailioWebPhone

`IveKitKamailioWebPhoneAuthFailures` 先按同一时间窗检查允许的 HTTPS Origin、extension session
issuer/audience、Edge 与 API 的时钟、JWT 文件挂载和 SIP From 是否等于 session subject。不要把 token
或完整 WSS URL写入日志、工单和抓包附件。只在确认不是攻击流量后，再让客户端申请新 session 并重连。
同时核对 LoadBalancer、Ingress、WAF 和 CDN 已关闭 query-string 访问日志或对 `token` 做不可逆脱敏；
Kamailio 不记录 URI 并不能阻止上游代理泄露查询参数。

`IveKitKamailioWebPhoneLocationSaveFailure` 表示 RustPBX 已返回 2xx，但 Edge `save("location")` 失败。
检查 REGISTER Contact/Path、registrar/usrloc 内存、Pod 资源和 Kamailio parser 日志；该状态不能通过
伪造 location 或跳过 RustPBX 鉴权修复。恢复后执行真实 WSS REGISTER、同连接 refresh、unregister，
再从另一 Edge 验证 RustPBX 到浏览器的 Path/location 投递和 `ivkwp` dialog BYE。

内部断言签发失败应视为 fail-closed：WSS 请求返回 503，但既有 RTP 媒体不应被 Edge 主动终止。
浏览器握手 token 只绑定连接，后续请求使用新的 30 秒内部断言；不要为解决长通话问题延长或持久化
浏览器 token。

### IveKitKamailioDmq

`IveKitKamailioDmqRejected` 表示 KDMQ 到达了错误端口或来源不在 `dmq_source_cidrs`。确认 UDP 5066
只由 headless DMQ Service、Kamailio StatefulSet peer 和 NetworkPolicy 使用，bootstrap 地址端口与
`server_port` 一致，且至少两个稳定 ordinal 可解析。公网 SIP Service 不得增加 5066，也不要临时扩大
CIDR 来消除告警；无法解释的外部 KDMQ 应按状态注入尝试调查。

DMQ 只复制已鉴权 usrloc，不复制 WSS JWT htable。单 Edge Compose 关闭 DMQ，因此不能用 Compose
结果证明跨 Edge location 恢复。目标 Kubernetes 还需验证 Pod 重启、Edge A 注册后由 Edge B 投递、
双 bootstrap 重建和非法来源拒绝。

### IveKitRustPbxSipCapacity

`IveKitRustPbxSipTransactionSaturation`、`IveKitRustPbxSipQueueSaturation` 和
`IveKitRustPbxSipTransportSaturation` 分别表示事务、入站队列或可靠连接达到预警水位。
先按 Cell/Pod 比较占用、CPU、内存、timer task 和请求到达率，确认是流量倾斜、慢下游、
重传风暴还是单节点密度上限，再执行 drain、placement 重平衡或横向扩容。不得只调大硬上限。

`IveKitRustPbxSipOverloadRejections` 表示至少一个严格上限已经触发；保留 503、
`Retry-After`、SIPp/网关统计和同时间窗容量快照。扩容后还要确认队列、finished cache 和连接数
回落且没有容量槽泄漏。当前告警模板和静态发现已验证，真实 Prometheus 发现、Alertmanager
投递及 SIPp 过载恢复仍为 `not_run`。

### IveKitRustPbxRecordingQueue

`IveKitRustPbxRecordingQueueDrops` 表示有界录音捕获队列已满。RustPBX 会丢弃录音副本来保护
实时 RTP 转发，不会让编解码或磁盘 I/O 反压通话；因此该告警同时意味着证据可能不完整，不能
只扩容后静默关闭。立即保存 `rustpbx_media_recording_queue_drops_total` 的 `reason`、
`rustpbx_media_recording_worker_threads`、工作队列容量、CPU、磁盘延迟、spool 水位和对应录音 manifest，
停止向该 Pod 接纳新的录音会话，再检查编码器、分片写入和 uploader。
容量值只用于吸收短暂抖动；持续过载应增加录音 worker/节点或修复存储瓶颈，不得无限调大队列。

当前源码补丁、静态发现和告警合同已验证；真实 RTP 连续性、队列溢出、录音缺口标记和恢复仍为
`not_run`，必须在服务器媒体基准中补齐。

### IveKitRustPbxSessionCleanup

`IveKitRustPbxSessionCleanupDegraded` 表示会话已经从实时媒体状态中移除，但播放轨道、MCU 或桥接
资源的后台清理超过截止时间，或者有界清理并发已耗尽。实时命令循环不会等待这些对象，现有通话
和新呼叫应继续；该告警不等于通话中断，但可能留下需要操作系统最终回收的资源。

保存 `rustpbx_media_session_cleanup_total` 的 `outcome`、Pod CPU/内存/FD、媒体任务数、磁盘挂载延迟
和同时间窗会话销毁速率。先停止向异常 Pod 接纳新会话并 drain，再排查卡住的播放源、MCU 任务、
文件系统或驱动。不要单纯调大清理并发；只有确认是正常突发且单任务延迟健康时，才调整
`media_session_cleanup_concurrency`。真实超时注入和 RTP 连续性验收仍为 `not_run`。

### IveKitRealtimeAudioTapFailure

`IveKitRealtimeAudioTapFailure` 表示 RustPBX 或 LiveKit 的辅助 PCM 旁路出现 session/gateway 失败。
先按 `media_source`、`event_type` 和有界 `reason` 分解，检查授权 grant、签发 Pod、headless DNS、
AI Agent、Provider 路由/熔断和旁路 WebSocket。主 SIP/RTP/WebRTC 媒体不依赖旁路，不能为了恢复
字幕或翻译而重启仍承载会话的 RustPBX、LiveKit 或 API Pod；先确认主媒体连续，再修复旁路消费者。

### IveKitRealtimeAudioTapDroppingAudio

`IveKitRealtimeAudioTapDroppingAudio` 表示辅助消费者持续跟不上输入。比较
`provider_start_buffer_overflow`、`provider_queue_overflow`、`provider_write_failed` 和
`transport_error`，同时检查 Provider 首包延迟、并发配额、CPU、AI Agent event loop 和 3010 网络。
系统故意丢弃最老旁路帧而不反压 LiveKit `AudioStream` 或 RustPBX RTP。缓冲只吸收短抖动；持续
丢帧应扩容 Provider/gateway、降低旁路功能或熔断故障 Provider，不得无限增大
`PRESTART_BUFFER_MS`/`max_buffered_audio_ms`。

### IveKitRealtimeAudioTapReplayAttempt

`IveKitRealtimeAudioTapReplayAttempt` 是安全事件。立即定位签发时间窗、worker identity、call/grant、
签发 Pod 和来源网络，撤销对应 grant 并检查 AI Agent/内部网络是否泄露 token。Kubernetes token
绑定签发 Pod 的派生密钥，同 Pod nonce store 拒绝第二次消费；不得通过改成普通 ClusterIP、共享
实例密钥或关闭 nonce 校验来“恢复”。只有确认根密钥泄露时才协调滚动轮换 HMAC Secret，轮换前要
考虑正在建立的旁路连接；既有主媒体会话不应被终止。

### OpcAIAgentVoiceStageLatencyHigh

该告警按 `stage` 和 `media_source` 判断五分钟窗口 P95：ASR final `350 ms`、端点判定 `500 ms`、
LLM 首 token `350 ms`、TTS 首音频 `300 ms`、speech-to-speech `1.2 s`。先确认是哪一段超预算，
再检查 Provider 区域/配额/流式能力、网络 RTT、VAD endpointing、AI Agent CPU throttling 和有界旁路
丢弃；不能只看总延迟后盲目扩大缓冲。

LiveKit job 子进程用非阻塞 UDP 向同 Pod/容器的 `127.0.0.1:9125` 发送最多 4 KiB、最多五条的固定
标签观测，worker 父进程聚合后由 `9090/metrics` 暴露。UDP 发送失败、collector 端口冲突或
Prometheus 抓取失败只允许丢失监控样本，不得阻断 ASR/LLM/TTS、SIP/RTP/WebRTC 或终止会话。
故障期间先用主媒体 QoS、Provider 请求和 turn 日志交叉确认，禁止为了恢复监控而重启仍承载会话的
媒体节点。

### OpcAIAgentVoiceProviderUnavailable

该告警表示 ASR、LLM 或 TTS 的某个候选 Provider 在最近五分钟内被 LiveKit Agents
`FallbackAdapter` 标记为不可用。先按 `capability` 和 `provider` 核对凭据、配额、429、网络 RTT、
服务端首包时间和区域状态，再确认后备 Provider 是否已经接管。不要通过增加嵌套重试掩盖故障：
默认每个候选只尝试一次，ASR/LLM/TTS 单次上限分别为 `2000/1200/1500 ms`，故障切换只允许在
尚未产生可见转写、文本 token 或音频时发生，避免重复内容和语音拼接。

`opc_ai_voice_provider_transitions_total{capability,provider,state}` 只有固定能力、Provider 和状态
标签，不得加入 tenant、call、room、号码或文本。该计数通过与分段延迟相同的 loopback UDP 旁路
汇聚；指标丢失不能阻断 Provider 或主媒体。若所有候选都不可用，应优先恢复至少一个 Provider 或
执行已批准的人工接管，不要重启 LiveKit/RustPBX 媒体节点。

### IveKitIvrActionFailures

按 action kind 和错误码检查音频资源、输入收集、queue/transfer/webhook 依赖。发布中的 IVR revision 不可原地修改，修复应产生新 revision。

### IveKitRetentionFailure

检查 legal hold、对象删除 Provider、数据库 lease 和 category policy。外部对象删除失败时不能先删数据库 authority；恢复后由 durable worker 重试。

### IveKitBackupJobFailed

检查 Job 日志、PVC/对象存储空间、`pg_dump`、manifest/checksum 和 Secret 引用。一次新备份成功不等于事故关闭，必须执行独立 restore 验证。

## 5. Dashboard 面板

`iveKit Shared Foundation Operations` 提供共享底座面板：API 请求与 5xx、通知队列深度/年龄/投递/健康、集成 Webhook 延迟与操作结果、Tinode 同步延迟与干预队列、智能 Provider 路由、LiveKit 丢包、实时 PCM 旁路失败/丢弃、AI Agent 五段语音延迟、Voice uncertain 与事件延迟、数据保留、限流拒绝，以及 Kamailio Edge 健康、RustPBX pool 和路由失败。

Dashboard 只有共享底座指标，不包含 OPC/LED 订单、客户、坐席绩效等业务指标。业务团队可以在自己的 dashboard 中引用 iveKit 指标，但不能修改共享底座标签合同。

## 6. 验收状态

本地自动化已验证规则 YAML、dashboard JSON、指标名称、Helm 资源开关、Service selector、Helm
3.18.4 lint/template、Compose config 和交付包白名单。以下真实环境项目保持 `not_run`：

- 目标 Kubernetes `helm upgrade/rollback` 与真实双 Zone 调度；
- Prometheus Operator 实际发现和规则加载；
- Alertmanager 路由、静默和通知接收；
- Grafana sidecar 自动导入和真实历史数据展示；
- 真实 LiveKit/Tinode/RustPBX/Provider 故障触发与恢复演练。

这些环境项不影响配置代码完成，但发布验收不得把静态解析结果写成真实集群通过。
