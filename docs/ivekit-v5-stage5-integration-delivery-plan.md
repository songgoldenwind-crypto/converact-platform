# iveKit V5 Stage 5 全链路集成与交付计划

> 状态：代码、部署配置、自动化验收和交付文档完成；真实环境验收保持 `not_run`  
> 范围：让 OPC、LED 和后续产品只通过稳定 API、SDK、事件、Webhook 与部署包消费 iveKit  
> 不包含：LED/OPC 订单、工程师、支付、质检处置等业务逻辑，也不补做已标记为 `not_run` 的真实外部环境验收

## 1. 完成目标

Stage 5 结束时，接入研发应能完成以下工作而无需读取 iveKit 数据库、Provider 配置或 OPC call-center 代码：

1. 使用 `@opc/ivekit-sdk` 调用全部 V5 公共能力；
2. 使用 HTTP replay、WebSocket 或签名 Webhook 消费同一套 tenant event；
3. 验证 Webhook 时间戳、HMAC、event/delivery id，并用外部持久化 claim 防重放；
4. 通过 `tenant_id + business_ref` 绑定 LED 业务对象；
5. 从 source-bound delivery bundle 部署 standalone iveKit，执行 migration、升级、备份恢复和验收；
6. 在结果中明确区分 automated、controlled、real_environment 和 `not_run`。

完成口径仍为代码、PostgreSQL migration、API、SDK、OpenAPI、事件/Webhook schema、部署配置、自动化验收和文档全部完成。真实供应商、物理 Windows、PSTN/RTP、公网弱网和目标 Kubernetes 只保留可执行验收入口，不伪报通过。

## 2. 架构决定

### 2.1 事件权威

`ivekit_tenant_events` 是唯一领域事件 journal。HTTP replay 和 WebSocket 继续使用现有游标、可见性与保留合同；Stage 5 不建立第二套领域事件表。

### 2.2 Webhook 投递权威

事件 Webhook 不复用旧 call-center `/api/webhooks/*` 和 SQLite 表。新增 PostgreSQL-only subscription/offset：

- subscription 绑定一个已配置的 notification webhook endpoint；
- 精确事件名或尾部 `.*` family pattern 决定可投递范围；
- subscription 以 PostgreSQL lease、`FOR UPDATE SKIP LOCKED` 和单调 event cursor 支持多实例；
- bridge worker 把 journal event 投影为 notification webhook delivery；
- notification 的幂等、加密、SSRF、HMAC、重试、死信、配额、熔断、健康检查和人工重放继续作为唯一投递实现；
- 幂等键绑定 `subscription_id + tenant_event_id`，worker 在通知创建成功后才推进 cursor。

### 2.3 接收方合同

Webhook body 使用版本化 envelope，包含 `schema_version`、`event_id`、`event_type`、`tenant_id`、`occurred_at`、`business_ref`、`visibility` 和安全 `data`。签名覆盖 `x-ivekit-timestamp + '.' + rawBody`。SDK 提供验证 helper，但 replay claim 由 LED 使用 PostgreSQL/Redis 等共享存储实现，SDK 不把进程内 Set 冒充生产防重放。

## 3. 实施任务

### 3.1 事件目录与兼容规则

- [x] 定义稳定的 event family、versioned integration envelope 和 webhook delivery envelope；
- [x] 增加 `GET /api/ivekit/events/catalog` 与 SDK；
- [x] catalog 声明 exact/trailing-wildcard 订阅语法、最大 payload、签名版本和兼容策略；
- [x] 对新增事件遵守 additive payload，破坏性变更只能增加 schema version 或新 event type。

### 3.2 Durable event webhook bridge

- [x] migration 073 建立 tenant-scoped subscription、幂等、revision、cursor、lease、RLS 和 worker discovery；
- [x] subscription store/service 完成 create/list/get/update/archive、pattern 校验和 endpoint 绑定；
- [x] bridge batch 完成 tenant discovery、lease claim、journal scan、pattern filter、幂等通知创建、cursor 推进和 fencing；
- [x] runtime worker 默认关闭，配置启用时要求 notification 加密/HMAC key；
- [x] 指标覆盖 claim、lag、projected、filtered、lease loss 和 error，标签保持低基数；
- [x] HTTP 管理面只允许 owner/admin/system，并对 mutation 使用 `Idempotency-Key`、revision、限流和审计。

### 3.3 SDK、OpenAPI 与接收方验证

- [x] TypeScript SDK 增加 catalog、subscription 管理和 typed envelope；
- [x] SDK 增加 Web Crypto HMAC verifier、时间窗口检查和外部 durable inbox claim port；
- [x] OpenAPI 覆盖所有新路径、请求、响应、header、outbound webhook 和错误；
- [x] 提供 LED Node backend 示例，示例不读取内部表、不保存明文 secret、不把重复投递当新业务事件。

### 3.4 V5 交付包与验收

- [x] delivery manifest 从 V3 固定能力列表升级为完整 V5 capability/acceptance matrix；
- [x] 纳入 Stage 1-5 计划、通知/监控/备份/Webhook runbook、OpenAPI 和 LED 示例；
- [x] 更新 standalone source graph、migration manifest、Compose/Helm/env、SBOM 和 release contract 输入；
- [x] 增加全链路受控验收：统一业务引用、IM/文件/质检/媒体/远控/Voice/通知事件、cursor、签名与 durable inbox；
- [x] 验收结果绑定完整 source commit、artifact SHA-256、环境分类和明确 `not_run` 原因。

### 3.5 文档与最终审计

- [x] 更新 V5 总设计能力矩阵，关闭已完成的 `partial/missing`；
- [x] 更新 LED 集成指南、SDK README、OpenAPI 说明、部署与运维索引；
- [x] 编写事件/Webhook 接收 runbook、版本兼容表和故障处理流程；
- [x] 更新完成审计，列出实现证据与所有真实环境边界。

## 4. 自动化门禁

1. migration/store/service/worker 的单元和 PostgreSQL 合同测试；
2. subscription 跨租户、revision、幂等、lease takeover、cursor 和重启恢复；
3. Webhook success、duplicate、stale timestamp、wrong HMAC、redirect、429、5xx、timeout、dead-letter；
4. SDK/OpenAPI/event schema 一致性和 secret-safety；
5. standalone context build、migration ordering、delivery tamper rejection；
6. root typecheck、SDK build/dry-run pack、三套 Compose render 和 `git diff --check`；
7. 能运行的受控全链路验收必须通过；真实环境项目只允许 `not_run`，不得自动升级状态。

## 5. 环境边界

以下项目只补齐部署/验收入口，本阶段不声明真实通过：真实 OCR/ASR/AI/翻译供应商效果与配额、真实 Tinode 多客户端长稳、真实 LiveKit TURN/Egress/弱网媒体、两台 Windows RustDesk 物理操作、真实 PSTN/WSS/RTP/物理音频、商业 SMTP/短信回执、公网 Webhook DNS/TLS 和目标 Kubernetes 多副本/监控/恢复演练。

## 6. 最终本地验收记录（2026-07-15）

- Stage 5 delivery/event/Webhook 聚合门禁 `52/52`，0 fail、0 skip；
- 仓库 `test/*.test.ts` 全量回归以 exit code 0 完成；首次回归发现并关闭录屏双处理任务回读、SDK 示例发布断言和外呼测试固定等待三个问题；
- 根 `npm run typecheck` 与 `@opc/ivekit-sdk` build 通过；SDK dry-run pack 为 83 个文件，包含编译后的 Webhook verifier 和 LED receiver 示例；
- standalone context 验证通过：309 个允许源码文件、8 个 runtime package、7 个编译入口，未带入 OPC 产品域；
- production、infra/ivekit、standalone service 三套 Compose `config --quiet` 通过；
- 本机隔离 PostgreSQL harness `6/6` 通过，覆盖 fresh migration、OPC upgrade、RLS、Tinode inbox/projector、IVR 和受控 RustPBX；
- `git diff --check` 通过，新增内容未发现真实凭据；delivery bundle 的哈希、额外文件、秘密材料、篡改和环境证据防伪测试通过；
- controlled full-chain 只标记 `full_chain=passed`，所有真实环境 gate 继续为 `not_run`。

## 7. 最终架构复审关闭项（2026-07-15）

1. 修复 migration 068 的 SQL 语法错误，并增加逐文件 migration 回归；
2. Helm 多副本启动时强制要求 S3/MinIO 共享对象存储，缺少配置会在进程启动阶段 fail closed；
3. Notification 与 Retention worker 改为逐条 claim、处理完成后再 claim 下一条，避免慢外部调用导致批量预占租约过期；
4. Webhook、HTTP Email/SMS 和健康探针在 DNS 校验后把实际 socket 固定到已校验 IP，同时保留原 Host 与 TLS SNI，关闭二次解析造成的 DNS rebinding 窗口；
5. Provider tenant event 改为只持久化一次，再广播已落库事件，避免默认路径产生重复 durable journal；
6. `secure_files`、`media_recordings` 和 `tenant_events` 补齐真实 Retention handler；连同既有 Notification、Audit 和 Collaboration，共六类均具备有界批处理、legal hold 和可重试收敛，文件与录制执行对象先删；
7. Policy evidence 改为结构化字段脱敏：UUID、message/attachment id、checksum 与 hash 保持可追溯，自由文本继续去除手机号和邮箱。该问题由全仓随机失败暴露，新增确定性回归并连续复跑 50 次通过。
8. Provider event 将 durable append 与 realtime publish 分离；数据库写入失败会向上返回，只有已落库后的实时广播失败才允许由 replay 恢复；
9. Media QoS/connection 的显式 journal 与 WebSocket 发布共享固定长度 SHA-256 幂等键和相同 audience，两次发布最多形成一条 durable event；QoS 键包含 `sampled_at`，同一 connection revision 内的重复降级/恢复周期不会互相吞并；
10. HTTP Endpoint IPv6 分类增加 NAT64 local-use、discard-only、site-local、6to4、documentation、ULA、link-local、multicast 等非全局网段拒绝；
11. Retention 把绝对 `retention_until`/`expires_at` 与策略 age 分开：显式截止时间直接和 run start 比较，只有缺少显式截止时间才使用 `created_at/occurred_at <= cutoff_at`；Secure File 同时存在两个截止时间时取更早者；
12. tenant-event selector 在 migration 068 中排除 active legal hold，所有批量候选按未 hold 优先排序，避免 held tenant/record 占满有限窗口；真实 PostgreSQL 使用 `tenant_limit=1` 的行为断言通过；
13. Notification retry/backoff 改为从 Provider 调用完成时刻起算，慢请求不再提前消耗配置退避或 `Retry-After`。
