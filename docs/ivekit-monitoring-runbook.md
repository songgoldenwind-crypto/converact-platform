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
| `opc_ivekit_ivr_pending_actions_total` | Counter | `kind,result,error_code` | IVR durable action 结果 |
| `rustpbx_sip_endpoint_running_transactions` / `rustpbx_sip_endpoint_active_transaction_limit` | Gauge | 无业务标签 | SIP 活动事务占用与硬上限 |
| `rustpbx_sip_endpoint_incoming_queue_depth` / `rustpbx_sip_endpoint_incoming_queue_capacity` | Gauge | 无业务标签 | 有界事务队列占用 |
| `rustpbx_sip_transport_connections_active` / `rustpbx_sip_transport_connection_limit` | Gauge | 无业务标签 | TCP/TLS/WebSocket 连接占用 |
| `rustpbx_sip_endpoint_active_limit_rejections_total` / `rustpbx_sip_endpoint_incoming_queue_rejections_total` / `rustpbx_sip_transport_connection_limit_rejections_total` | Counter | 无业务标签 | 显式过载拒绝证据 |

### 3.5 安全和运维

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

### IveKitIvrActionFailures

按 action kind 和错误码检查音频资源、输入收集、queue/transfer/webhook 依赖。发布中的 IVR revision 不可原地修改，修复应产生新 revision。

### IveKitRetentionFailure

检查 legal hold、对象删除 Provider、数据库 lease 和 category policy。外部对象删除失败时不能先删数据库 authority；恢复后由 durable worker 重试。

### IveKitBackupJobFailed

检查 Job 日志、PVC/对象存储空间、`pg_dump`、manifest/checksum 和 Secret 引用。一次新备份成功不等于事故关闭，必须执行独立 restore 验证。

## 5. Dashboard 面板

`iveKit Shared Foundation Operations` 提供 16 个面板：API 请求与 5xx、通知队列深度/年龄/投递/健康、集成 Webhook 延迟与操作结果、Tinode 同步延迟与干预队列、智能 Provider 路由、LiveKit 丢包、Voice uncertain 与事件延迟、数据保留和限流拒绝。

Dashboard 只有共享底座指标，不包含 OPC/LED 订单、客户、坐席绩效等业务指标。业务团队可以在自己的 dashboard 中引用 iveKit 指标，但不能修改共享底座标签合同。

## 6. 验收状态

本地自动化已验证规则 YAML、dashboard JSON、指标名称、Helm 资源开关、Service selector 和交付包白名单。当前机器没有 Helm/Prometheus Operator/Grafana 运行环境，因此以下项目保持 `not_run`：

- 目标 Kubernetes `helm lint/template/upgrade/rollback`；
- Prometheus Operator 实际发现和规则加载；
- Alertmanager 路由、静默和通知接收；
- Grafana sidecar 自动导入和真实历史数据展示；
- 真实 LiveKit/Tinode/RustPBX/Provider 故障触发与恢复演练。

这些环境项不影响配置代码完成，但发布验收不得把静态解析结果写成真实集群通过。
