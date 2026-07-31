# iveKit 通知底座运维手册

> 状态：代码、迁移、Compose/Helm 配置、受控 Provider 测试和 SDK 已完成。真实 SMTP、短信厂商、真实公网 Webhook 的发送、回执、配额和故障切换仍为 `not_run`，必须在目标环境独立验收。

## 1. 适用范围

通知模块是 OPC、LED 和其他业务服务共用的产品无关底座，支持：

- 站内通知、Webhook、SMTP 邮件、HTTP 邮件和 HTTP 短信；
- 模板草稿、不可变版本、发布、归档和多语言；
- 用户偏好、静默时间、强制通知策略；
- PostgreSQL 耐久队列、租约、重试、死信、Provider 回执和站内投影；
- endpoint 配额、熔断、主动健康检查、优先级和故障切换组；
- 管理查询、测试投递、人工重试、审计、限流、指标和保留策略。

不包含移动推送，也不实现 LED 或 OPC 的业务事件判断。业务服务只提交 `event_type`、`recipient`、`business_ref` 和模板/内容；不得直接操作 Provider 凭据或数据库表。

## 2. 生产启用顺序

1. 应用 `065`、`066`、`067`、`068`、`069`、`070`、`071`、`072` 和 `090` 迁移。
2. 为 API 使用 `opc_runtime` 最小权限角色，不使用管理员 DSN 启动长运行进程。
3. 分别生成 32 字节 base64 的内容加密密钥、HMAC 密钥、审计 IP HMAC 密钥和限流 HMAC 密钥；四者禁止复用。
4. 把密钥和 Provider credential 放入运行时 Secret，不写入 Helm `values.yaml`、Endpoint API payload、日志或仓库。
5. 创建 Endpoint 和模板，先保持投递 Worker 关闭。
6. 启用健康 Worker，确认 Endpoint 从 `unknown` 收敛为 `healthy|degraded|unhealthy`。
7. 通过 Endpoint test API 创建一次正常的耐久测试通知并观察终态。
8. 启用投递 Worker；最后按需要开启 readiness 的健康 Provider 强制门禁。

Compose 使用 `env.example`；Helm 将秘密放入 `secrets.runtimeEnvironmentSecret`，非秘密 Worker 参数放入 `config.env`。

## 3. 核心环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CONVERACT_FABRIC_NOTIFICATION_ENCRYPTION_KEY` | 空 | 32 字节 base64；加密 recipient 和 payload |
| `CONVERACT_FABRIC_NOTIFICATION_HMAC_KEY` | 空 | 32 字节 base64；稳定查找、幂等和内容指纹 |
| `CONVERACT_FABRIC_NOTIFICATION_WORKER_ENABLED` | `0` | 投递 Worker 开关；启用时两把密钥必须有效 |
| `CONVERACT_FABRIC_NOTIFICATION_INTERVAL_MS` | `5000` | 投递轮询间隔 |
| `CONVERACT_FABRIC_NOTIFICATION_BATCH_SIZE` | `25` | 每租户单轮处理上限；每次只 claim 一条 |
| `CONVERACT_FABRIC_NOTIFICATION_TENANT_LIMIT` | `100` | 单轮租户上限 |
| `CONVERACT_FABRIC_NOTIFICATION_LEASE_MS` | `120000` | 投递租约；必须大于 Provider 请求超时 |
| `CONVERACT_FABRIC_NOTIFICATION_PARTITION_COUNT` | `1` | 投递 Worker 实例分区数，范围 `1..256` |
| `CONVERACT_FABRIC_NOTIFICATION_PARTITION_INDEX` | `0` | 当前实例分区序号，范围 `0..count-1`；`count>1` 时必须显式配置 |
| `CONVERACT_FABRIC_NOTIFICATION_RETRY_DELAYS_MS` | `5000,30000,120000,600000` | 有界退避序列 |
| `CONVERACT_FABRIC_NOTIFICATION_WEBHOOK_SECRET_ENV_NAMES` | 空 | Webhook 签名密钥的 `env://` 名称 allowlist |
| `CONVERACT_FABRIC_NOTIFICATION_PROVIDER_SECRET_ENV_NAMES` | 空 | SMTP/HTTP Provider credential 名称 allowlist |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_WORKER_ENABLED` | `0` | 主动健康检查 Worker 开关 |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_INTERVAL_MS` | `60000` | 健康检查轮询间隔 |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_STALE_MS` | `300000` | Endpoint 再次变为应检查的时间 |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_LEASE_MS` | `120000` | 多实例健康检查租约 |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_TENANT_LIMIT` | `100` | 单轮租户上限 |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_BATCH_SIZE` | `25` | 每租户检查 Endpoint 上限 |
| `CONVERACT_FABRIC_NOTIFICATION_HEALTH_CONCURRENCY` | `5` | 单进程并发探针上限 |
| `CONVERACT_FABRIC_NOTIFICATION_ALLOW_CONTROLLED` | `0` | 仅受控验收允许 controlled Provider |
| `CONVERACT_FABRIC_READINESS_REQUIRE_HEALTHY_NOTIFICATION_PROVIDER` | `0` | `1` 时无健康 Provider 会阻断 readiness |

## 4. Endpoint 与健康检查

Endpoint 只保存 `env://NAME` 引用。API 返回 `secret_configured` 和 `signing_secret_configured`，不会返回引用名或值。HTTP Endpoint 默认只允许 HTTPS 和 443；需要其他端口时用 `allowed_ports` 明确列出。`allow_http` 和 `allow_private_networks` 只用于可信内网部署，启用前必须做网络隔离审查。

HTTP 主动检查支持 `health_url`、`health_method=HEAD|GET` 和 `health_timeout_ms`。探针在连接前解析 DNS 并拒绝 loopback、link-local、私网、组播和其他非公网地址；IPv6 还拒绝 site-local、ULA、NAT64 local-use、discard-only、6to4 和 documentation 等特殊用途网段。socket 直接连接已校验 IP，并为 HTTP Host 与 HTTPS SNI 保留原始主机名，整个请求不做第二次 DNS 解析。所有 HTTP Provider 禁止自动重定向，防止 SSRF 和 DNS rebinding。邮件/短信 HTTP Provider 使用 allowlist 中的 bearer credential。SMTP 使用 `verify()` 检查 DNS、连接、TLS 和认证，不发送测试邮件。

结果语义：

| 结果 | 示例 | 运行影响 |
| --- | --- | --- |
| `healthy` | 2xx、SMTP verify 成功 | 清零失败计数并关闭熔断 |
| `degraded` | DNS 暂不可用、429、405、网络超时 | 保留 Endpoint，可由运维观察；不累计硬失败阈值 |
| `unhealthy` | 401/403、5xx、危险目标、无效配置 | 累计失败；达到阈值打开 circuit |

每次 claim 使用 `FOR UPDATE SKIP LOCKED`、`worker_id` 和随机租约哈希；单个投递完成后才 claim 下一条，避免尚未开始的任务耗尽租约。完成更新必须同时匹配 worker 与租约。租约丢失只计指标，不覆盖新 owner 的结果。

## 5. 投递状态与人工重试

典型状态为 `pending -> processing -> delivered|accepted|retry_wait|uncertain|failed|dead_letter`。`accepted` 仅表示 Provider 接受，不代表最终送达；异步回执再把它推进到终态。Provider 请求超时且无法确定是否接收时进入 `uncertain`，不能自动重放。

`retry_wait.next_attempt_at` 从本次 Provider 调用完成时刻起算，再取配置退避和 `Retry-After` 的较大值；慢 Provider 不会提前消耗等待时间。该完成时刻同时写入 delivery 状态，便于按日志和指标复核实际退避。

管理 API 默认只允许 `failed/dead_letter -> retry_wait`。请求必须提交当前 `expected_state`，数据库在同一事务内校验状态、清理旧错误、重开父 Notification，并追加不可变的人工操作记录。并发变化返回 `409 revision_conflict`。

`uncertain` 只有具备 `notifications.force_delivery` 能力的管理员显式提交 `allow_uncertain=true` 才能重试。操作前必须先在 Provider 控制台按 `provider_idempotency_key`、request id 和 message id 查重；无法确认时宁可保留 `uncertain`，避免重复短信、邮件或 Webhook side effect。

Endpoint test 不是直连探针。它通过正常 Notification/Delivery 队列创建一次 `max_attempts=1` 的耐久投递，因此可验证模板、加密、Endpoint 选择、配额、签名、Worker 和审计整条链路。相同测试意图重试时复用原 `Idempotency-Key`。

## 6. 指标与告警

| 指标 | 建议告警 |
| --- | --- |
| `opc_ivekit_notification_queue_depth` | pending/retry_wait 持续增长 |
| `opc_ivekit_notification_queue_oldest_age_seconds` | 高于业务 SLA，持续 5 分钟 |
| `opc_ivekit_notification_delivery_attempts_total` | failed/dead_letter/uncertain 比例突增 |
| `opc_ivekit_notification_lease_lost_total` | 持续增长，检查慢 Provider、租约和时钟 |
| `opc_ivekit_notification_provider_reservations_total` | quota/circuit 拒绝突增 |
| `opc_ivekit_notification_provider_results_total` | Provider 失败率或错误码异常 |
| `opc_ivekit_notification_receipt_reconciliations_total` | unknown/ignored 回执异常 |
| `opc_ivekit_notification_health_probes_total` | degraded/unhealthy 连续出现 |
| `opc_ivekit_notification_health_probe_duration_seconds` | p95 接近 `health_timeout_ms` |

日志只能包含 tenant、endpoint、notification、delivery、request/correlation id 和安全错误码；不得记录 recipient、正文、credential、签名、密文或 Provider 原始响应。

Helm 可选安装 `ServiceMonitor`、`PrometheusRule` 和 Grafana dashboard ConfigMap。实际阈值、完整共享指标字典和每条告警的事故处理步骤见《iveKit 共享底座监控与告警手册》。目标集群未安装 Prometheus Operator/Grafana 时保持关闭，不影响 iveKit API 安装。

## 7. 站内事件与断线恢复

站内通知不仅写 Inbox，还在同一 PostgreSQL transaction 写入 durable tenant event：

| 事件 | 载荷范围 |
| --- | --- |
| `notification.created` | notification id、事件类型、channel、优先级、状态、业务引用和时间 |
| `notification.delivery.updated` | delivery id、channel、状态、attempt、有限错误码和时间 |
| `notification.inbox.created` | 仅目标用户可见的安全 Inbox projection |
| `notification.inbox.updated` | read/unread/archive/unarchive 和最新时间 |

事件使用稳定 SHA-256 producer key 和 tenant 部分唯一索引去重。事务提交后 WebSocket/Redis 发布同一 key；实时发布失败时，浏览器仍能通过 opaque cursor 和 `GET /api/ivekit/events` 重放。事件严格绑定目标 user audience，不包含 recipient 明文、通知密文、Provider request/message id 或原始响应。

## 8. 故障处理

### 队列积压

1. 查看 readiness、runtime heartbeat、queue depth 和 oldest age。
2. 确认至少一个实例声明 `notification_worker` 且心跳新鲜。
3. 按 Endpoint 检查健康、quota、circuit 和 Provider 错误分类。
4. 修复 Provider 后让 `retry_wait` 自动恢复；不要批量重放 `uncertain`。

### Endpoint unhealthy

1. 区分认证失败、5xx、DNS/网络退化和 SSRF 拒绝。
2. 校验 Secret allowlist 中存在引用名，运行时 Secret 中存在值。
3. 对 401/403 轮换 credential；对目标地址变化重新做公网 DNS/TLS 审核。
4. 使用 Endpoint test 验证完整链路，而不是只把健康状态手工改为 healthy。

### 多实例重复或租约丢失

1. 确认所有节点时间同步，数据库是唯一状态权威。
2. 保证 `CONVERACT_FABRIC_NOTIFICATION_LEASE_MS` 大于最坏 Provider timeout。
3. 多实例设置相同 `PARTITION_COUNT`，每个实例使用唯一且连续的 `PARTITION_INDEX`。
4. 迁移 `081_ivekit_notification_worker_partition.sql` 将 delivery 稳定映射到 1024 个逻辑 shard；实例只发现并 claim 自己负责的 shard。
5. Kubernetes 推荐启用 Helm `notificationWorker.enabled=true`。StatefulSet 从 Pod ordinal 自动生成唯一 `PARTITION_INDEX`，API Deployment 保持通知投递 Worker 关闭，避免重复扫描与无效数据库竞争。
5. 扩缩容时先部署新分区配置，再观察旧 processing lease 收敛；分区变化不会绕过 `SKIP LOCKED`、worker id 和 lease token 栅栏。
6. 不设置固定 worker id，不绕过 PostgreSQL claim。
7. Provider 侧必须支持稳定 idempotency key；不支持时超时结果必须保持 `uncertain`。

## 9. 备份、恢复与保留

通知表随主 iveKit PostgreSQL custom-format 备份进入同一 manifest。恢复默认只做 checksum、对象 inventory 和 migration 校验；执行恢复需要双确认并要求目标数据库无 public 表。恢复后先检查 `065/070/071/072/081/090` 迁移、RLS、Endpoint 数量、队列状态、worker shard 索引、事件幂等索引和 immutable operation history，再启动 Worker。

Notification、Delivery、Inbox、Receipt 和 Audit 使用各自的 typed retention policy。Legal hold 优先于到期删除。严禁通过直接 SQL 删除单条失败投递来“清队列”，这会破坏父 Notification 聚合状态和审计链。

## 10. 真实环境验收边界

| 项目 | 当前状态 | 通过证据 |
| --- | --- | --- |
| 受控 Webhook/SMTP/HTTP Provider 协议与失败分类 | 自动化通过 | 本地测试报告 |
| 真实 SMTP 发送、退信、TLS 与限速 | `not_run` | 供应商 message id、邮箱收件/退信和脱敏日志 |
| 真实短信发送、回执、配额和故障切换 | `not_run` | 厂商回执、终端接收和 quota/circuit 证据 |
| 真实公网 Webhook DNS/TLS、签名和重试 | `not_run` | 外部接收端记录、证书和故障注入报告 |
| Kubernetes 多副本 rollout/rollback 与 lease takeover | `not_run` | 目标集群部署、Pod/DB/指标和恢复记录 |

没有上述真实证据时，只能声明代码、配置和受控验收完成，不能声明真实 Provider 生产验收通过。
