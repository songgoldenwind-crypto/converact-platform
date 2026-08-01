# Converact Fabric 集成事件与签名 Webhook 运维手册

更新日期：2026-07-15

## 1. 范围与权威

本手册适用于 Converact Platform、LED 和后续产品消费 Converact Fabric 共享通信事件。`ivekit_tenant_events` 是唯一领域事件 journal；HTTP replay、WebSocket 和签名 Webhook 是三种投递方式，不是三套状态权威。

Webhook Bridge 不使用旧 call-center `/api/webhooks/*` 或 SQLite。migration 073 保存产品中立的订阅、单调 cursor、重试时间和 lease；实际网络投递复用 Notification 的加密队列、HMAC、SSRF 防护、配额、熔断、故障切换、重试和死信。

## 2. 接入顺序

1. 通过 Notification 管理 API 创建 active Webhook Endpoint，签名密钥只保存为 `env://NAME` 引用。
2. Endpoint `event_allowlist` 为空表示由租户策略允许所有事件；非空时只允许列出的精确事件名。
3. 调用 `GET /api/ivekit/events/catalog` 读取当前 schema、family 和 pattern 规则。
4. 使用 `POST /api/ivekit/events/webhook-subscriptions` 和稳定 `Idempotency-Key` 创建订阅。
5. 接收方先部署 durable inbox，再启用 `CONVERACT_FABRIC_EVENT_WEBHOOK_WORKER_ENABLED=1`。
6. 观察 heartbeat、lag、Notification queue 和测试事件，再开放业务 Worker 消费 inbox。

订阅模式只允许精确事件名或尾部 `.*`，每个订阅 1–64 个模式。全局 `*`、中间通配符和正则表达式均拒绝。Endpoint allowlist 是最终上限，订阅通配符不能扩大它。

## 3. 投递合同

请求头：

| Header | 说明 |
| --- | --- |
| `x-ivekit-timestamp` | Unix 秒；签名时间窗默认 300 秒 |
| `x-ivekit-signature` | `v1=<HMAC-SHA256 hex>` |
| `x-ivekit-delivery` | 稳定 Delivery ID，接收方防重放主键 |
| `x-ivekit-event` | event type |
| `x-ivekit-event-id` | tenant journal event ID |
| `x-ivekit-idempotency-key` | Converact Fabric Provider 投递幂等键 |

签名输入为 `${timestamp}.${rawBody}`。必须在解析 JSON 前对原始 UTF-8 body 验签。SDK `verifyIveKitWebhook()` 同时校验：

- body 为 2 字节至 1 MiB；
- secret 为 32–4096 字节；
- tolerance 为 30–3600 秒；
- 签名格式和 HMAC；
- outer delivery 与 inner event 的 tenant/event type 一致；
- visibility scope/ref 组合和 audience 类型；
- schema version 为 1。

## 4. Durable Inbox

`IveKitWebhookReplayStore.claim()` 收到完整已验证 envelope、`body_sha256`、delivery/event/tenant ID 和过期时间。生产实现必须在一个 PostgreSQL transaction 或 Redis 原子操作中完成：

1. 以 `(tenant_id, delivery_id)` 唯一插入 inbox；
2. 保存 event ID、body hash、验证后的 envelope 和状态 `pending`；
3. 相同 ID、相同 hash 返回 `false`；
4. 相同 ID、不同 hash 记录安全冲突并拒绝；
5. 事务提交后才向 Converact Fabric 返回 200。

默认 replay retention 为 7 天，可配置 1 小时至 90 天，必须覆盖 Converact Fabric Delivery 的最大重试与人工恢复窗口。签名时间窗只防旧请求，不替代持久去重。禁止使用进程内 Set、单实例内存缓存或“处理完成后再写去重”的顺序。

HTTP handler 只负责验签和入箱。LED 业务 Worker 从 inbox 异步消费，使用 `tenant_id + business_ref` 绑定自己的订单/工单；Converact Fabric 不执行 LED 业务状态变化。

## 5. 响应与重试

| 接收方响应 | Converact Fabric 语义 |
| --- | --- |
| `2xx` | 已持久接收或重复，Delivery 完成 |
| `3xx` | 禁止重定向，终态失败 |
| `400/401/403/404/422` | 请求或接收配置错误，终态失败 |
| `408/425/429/5xx` | 可重试；429 遵守 `Retry-After` |
| 超时/连接断开 | Provider 结果不确定，进入 `uncertain`，先对账再人工处理 |

接收方签名密钥服务或 durable inbox 故障都应返回 503，重复 claim 应返回 200。只有密钥已读取但签名、时间戳或 envelope 非法时返回 401。不要对合法重复返回 409，也不要在 inbox 未提交时返回 2xx。

## 6. Worker 与多实例

Bridge Worker 默认关闭，并要求 Notification delivery runtime 已启用。关键参数：

- `CONVERACT_FABRIC_EVENT_WEBHOOK_INTERVAL_MS=5000`
- `CONVERACT_FABRIC_EVENT_WEBHOOK_TENANT_LIMIT=100`
- `CONVERACT_FABRIC_EVENT_WEBHOOK_SUBSCRIPTION_LIMIT=25`
- `CONVERACT_FABRIC_EVENT_WEBHOOK_EVENT_BATCH_SIZE=100`
- `CONVERACT_FABRIC_EVENT_WEBHOOK_LEASE_MS=120000`
- `CONVERACT_FABRIC_EVENT_WEBHOOK_RETRY_DELAYS_MS=5000,30000,120000,600000`

多实例使用 tenant discovery、`FOR UPDATE SKIP LOCKED`、随机 lease hash 和 worker fencing。Worker 扫描事件后按 pattern 过滤；过滤事件也推进 cursor。只有所有匹配事件均成功创建幂等 Notification 后才提交新 cursor。崩溃后可重复创建请求，但 Notification 幂等键绑定 `subscription_id + event_id`，不会生成第二条 Delivery。

## 7. 兼容策略

| 变化 | 兼容要求 |
| --- | --- |
| 新 event type/family | additive；旧订阅不受影响，family wildcard 可自动接收 |
| 现有 payload 新增可选字段 | additive；接收方忽略未知字段 |
| 字段删除、改名或含义变化 | 禁止在 schema v1 原地修改；发布新 event type 或 schema version |
| visibility 收紧 | 允许；不得扩大历史私有事件可见范围 |
| business reference 缺失 | 接收方按 event ID 入箱，不得猜测业务对象 |
| unknown schema version | 持久隔离并告警，不执行业务副作用 |

## 8. 监控与事故处理

主要指标：

- `opc_ivekit_event_webhook_operations_total{result}`：claimed、scanned、projected、filtered、failed、lease_lost、worker_error；
- `opc_ivekit_event_webhook_oldest_event_age_seconds`：最近批次观察到的最老事件年龄；
- Notification queue depth/age、delivery attempts、provider health 和 lease loss 指标。

`IveKitEventWebhookLag` 触发时先查 runtime heartbeat、订阅 `status/next_attempt_at/last_event_id` 与 journal head，再查 Notification queue 和 Endpoint health。`IveKitEventWebhookFailures` 按 failed、lease_lost、worker_error 分流。不得手工把 cursor 跳到 head；确需放弃事件必须经过变更审批、导出待放弃 ID 并留下不可变审计。

Endpoint 密钥轮换通过创建/更新 secret ref 后执行测试投递；不在日志打印旧值或新值。暂停订阅会保留 cursor，恢复后继续追赶；archive 不可恢复，应创建新订阅并明确起始策略。

## 9. 验收边界

本地自动化覆盖 catalog、migration、RLS/lease/store、订阅服务、Worker、HTTP/SDK、HMAC、篡改、过期、重复、OpenAPI、Compose/Helm 和 V5 controlled full-chain。公网 DNS/TLS、真实 LED receiver、跨区域延迟、目标 Kubernetes 多副本和 Notification 商业 Provider 仍需目标环境执行，状态必须保持 `not_run`。
