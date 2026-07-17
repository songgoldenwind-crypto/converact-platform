# iveKit V5 Stage 4 语音、通知与安全运维实施计划

> 状态：代码、部署配置和本地自动化门禁完成；真实通信与目标集群验收保持 `not_run`  
> 范围：OPC、LED 及其他业务可共同复用的通信协作底座  
> 不包含：OPC/LED 业务逻辑、移动推送、真实运营商/PSTN 或物理音频设备采购与验收

## 1. 阶段目标与完成口径

Stage 4 包含三个连续工作包：

1. RustPBX、SIP、IVR、WebPhone 与呼叫能力生产化审计和回归；
2. 站内、Webhook、邮件、短信通知底座；
3. 权限、审计、限流、数据保留、监控、备份恢复和多实例部署。

统一完成口径为：代码、PostgreSQL migration、HTTP API、TypeScript SDK、durable worker、部署配置、指标、受控 Provider、自动化验收和运维文档全部完成。依赖真实 PSTN、WSS/RTP、物理音频设备、短信/邮件商业账号或目标 Kubernetes 集群的项目保持 `not_run`，不能用受控测试冒充真实环境结果，也不阻塞代码完成。

所有新增能力必须满足：

- PostgreSQL 是唯一持久化权威，不引入 SQLite；
- 每条记录和后台任务以 `tenant_id` 隔离，业务关联只使用 `business_ref`；
- 写操作要求稳定幂等键，外部副作用使用 durable outbox/claim/lease；
- Provider 超时后的结果必须进入可对账状态，不能盲目重复发送；
- 密钥仅使用 `env://` 或 secret resolver 引用，API、日志、事件和报告不得返回明文；
- 多实例通过 PostgreSQL 原子 claim、租约和幂等约束协作，不依赖进程内唯一性；
- 受控 Provider 只证明协议、错误分类、重试和状态收敛。

## 2. Voice 生产化审计结论

### 2.1 已实现且本阶段不重复开发

当前 Voice/IVR/WebPhone 底座已经具备：

- Voice profile、SIP trunk、DID、extension、route、call、participant、recording、consent、policy、parking slot 的 PostgreSQL authority 和 RLS；
- 呼入/呼出、接听、拒绝、挂断、盲转、咨询转、会议、Hold、DTMF、Park/Pickup、录音和 LiveKit SIP bridge 的 typed command；
- durable command/provider-event worker、原子 claim、lease、重试、`uncertain` 对账、幂等和 terminal-state 防重放；
- RustPBX Management、Router/CDR webhook、RWI/AMI、恢复脚本、固定源码与补丁、可复现镜像构建；
- SIPp REGISTER、OPTIONS、呼入/呼出、忙线、不可用、无应答、CANCEL、BYE 等信令场景；
- 26 类 IVR 节点、草稿/校验/发布/回滚/模拟、durable session/action、Step IVR 和 reconciliation；
- SIP.js WebPhone 短期 session plan、WSS 注册/重连、呼入呼出、远端音频、Hold、DTMF、输入输出设备切换和到期注销；
- Compose、digest-pinned Helm、健康检查、资源限制、迁移、45 项真实环境验收模板/validator/runbook 和交付包 source binding；
- SDK、headless controller、参考客户端及桌面/移动视口的受控 Chromium 验收。

2026-07-15 本轮基线重新执行 Voice/IVR/RustPBX/SIP 测试共 687 项，685 项通过、0 失败，2 项因未提供独立 PostgreSQL 环境变量而跳过。跳过项不使用 SQLite 替代。

### 2.2 明确保留为环境验收

以下项目不是待补代码：

- 真实 SIP trunk、DID、PSTN 收费呼叫；
- 真实浏览器到 RustPBX 的 WSS 注册、SDP/ICE 和双向 RTP；
- 物理麦克风、扬声器、回声消除和目标网络弱网质量；
- 真实录音对象、DTMF 媒体效果、多方会议媒体、监听/耳语/强插媒体；
- 真实 LiveKit SIP bridge 和目标 Kubernetes rollout/rollback。

锁定 RustPBX 基线虽然暴露 supervisor 协议 action，但 mixer 没有真实接通，effective capability 必须继续保持 `false`。除非上游实现或本项目完成真实 mixer 数据面并通过媒体证据，不得把协议可接受误报为功能可用。

### 2.3 本阶段 Voice 收尾任务

- [x] 审计代码、迁移、SDK、参考客户端、Compose、Helm 和交付包覆盖范围；
- [x] 重跑 Voice/IVR/RustPBX/SIP 自动化基线；
- [x] 在 Stage 4 总回归中再次执行 focused tests、typecheck、SDK build、delivery tamper gate；
- [x] 在最终交付文档中保持真实通信环境 `not_run`，引用现有 45 项 runbook，不制造伪证据。

## 3. 通知底座设计

### 3.1 领域模型

新增独立 `ivekit/notifications` 深模块，核心实体如下：

| 实体 | 责任 |
| --- | --- |
| Notification | 一次面向用户或外部联系人的逻辑通知；保存模板快照、业务关联、优先级和生命周期 |
| Delivery | 一个通知在一个 channel/provider/recipient 上的耐久投递；保存 attempt、lease、receipt、错误分类和终态 |
| Inbox Item | 站内通知投影；支持未读、已读、归档和游标分页 |
| Template | tenant-scoped、版本化、多语言模板；发布后生成不可变 revision |
| Preference | 用户对事件类型和 channel 的订阅偏好；强制安全/合规通知不可被普通用户关闭 |
| Endpoint | Webhook destination 或 provider profile；只保存 secret ref、允许事件和非敏感配置 |
| Receipt | Provider 回执或 webhook delivery observation；用于 delivered/failed 对账 |

通知输入统一包含：

```text
tenant_id, event_type, recipient, channels, locale,
business_ref, template_key/template_revision, variables,
priority, idempotency_key, requested_by, policy
```

业务服务不能直接写 provider 字段，必须通过 channel policy 和 provider resolver 选择实际 Provider。

### 3.2 Channel 能力

#### 站内通知

- tenant/user 定向、广播展开、未读计数、游标分页；
- read/unread、archive/unarchive；
- WebSocket + tenant event journal 实时通知，HTTP replay 负责断线恢复；
- 敏感 payload 只保存允许投影，不保存 provider secret 或原始凭证。

#### Webhook

- HTTPS 为生产默认，开发环境可显式允许 loopback controlled Provider；
- DNS/IP SSRF 防护、禁止 URL credential、限制端口和重定向；
- HMAC-SHA256 签名、timestamp、delivery id、event id、重放窗口；
- subscription event allowlist、暂停、密钥轮换、test delivery；
- 2xx 成功，408/425/429/5xx 和网络错误可重试，其他 4xx 终止；
- 同一 delivery id 重试，回执摘要脱敏并限制大小。

#### 邮件

- SMTP Provider 和通用 HTTP Provider 插槽；
- `to/from/reply-to/subject/text/html` 严格验证；
- 模板渲染默认转义，禁止任意代码执行和远程模板加载；
- Message-ID、accepted/rejected、退信回执投影；
- timeout/429/5xx 可重试，认证失败、地址无效等明确终止。

#### 短信

- 通用 HTTP Provider 插槽，厂商 adapter 后续按同一 port 接入；
- E.164 校验、内容长度/分段估算、签名和模板参数投影；
- Provider message id、accepted/delivered/failed 回执；
- 频率、日配额、静默时段和强制通知策略；
- 不把开发日志 sender 当作生产成功。

### 3.3 状态机与错误语义

Delivery 状态：

```text
pending -> processing -> accepted -> delivered
                   |-> retry_wait -> processing
                   |-> uncertain -> reconciled delivered/failed
                   |-> failed | cancelled | dead_letter
```

`accepted` 只表示 Provider 接受，不等于最终送达。Webhook 和无异步回执的 Provider 可在 2xx 后直接 `delivered`，但必须记录该语义。lease 丢失、超时和进程退出不得造成重复逻辑通知；所有重试复用稳定 delivery id 和 provider idempotency key。

### 3.4 HTTP API

已提供：

- `GET /api/ivekit/notifications/capabilities`
- `POST /api/ivekit/notifications`
- `GET /api/ivekit/notifications/:id`
- `GET /api/ivekit/notifications/inbox`
- `GET /api/ivekit/notifications/inbox/unread-count`
- `POST /api/ivekit/notifications/inbox/:id/read`
- `POST /api/ivekit/notifications/inbox/:id/unread`
- `POST /api/ivekit/notifications/inbox/:id/archive`
- `POST /api/ivekit/notifications/inbox/:id/unarchive`
- `GET /api/ivekit/notifications/preferences`
- `PUT /api/ivekit/notifications/preferences/:event_type/:channel`
- `GET|POST /api/ivekit/notifications/templates`
- `GET|PUT /api/ivekit/notifications/templates/:id`
- `GET /api/ivekit/notifications/templates/:id/versions`
- `POST /api/ivekit/notifications/templates/:id/publish`
- `POST /api/ivekit/notifications/templates/:id/archive`
- `GET|POST /api/ivekit/notifications/endpoints`
- `GET|PUT /api/ivekit/notifications/endpoints/:id`
- `POST /api/ivekit/notifications/endpoints/:id/test`
- `POST /api/ivekit/notifications/endpoints/:id/archive`
- `POST /api/ivekit/notifications/provider-receipts/:endpoint_id`
- `GET /api/ivekit/notifications/deliveries`
- `GET /api/ivekit/notifications/deliveries/:id`
- `POST /api/ivekit/notifications/deliveries/:id/retry`

创建、修改、发布、test 和 retry 必须有 `Idempotency-Key`。普通用户只能访问自己的 inbox/preference；admin/owner/system 才能管理模板、endpoint、全租户投递和强制策略。

### 3.5 实施结果

- [x] migration 065/070/071/072：通知、投递、站内投影、模板、偏好、Endpoint、回执、操作历史、健康租约、事件幂等和 RLS；
- [x] domain types、状态机、错误分类、加密/HMAC 和安全 canonical payload；
- [x] PostgreSQL stores、service、template renderer、preference policy 和 Provider resolver；
- [x] Webhook、SMTP、HTTP email、HTTP SMS、站内和 controlled adapters；
- [x] delivery worker、receipt reconciliation、Endpoint health、配额、熔断、故障切换和 retention；
- [x] HTTP API、SDK、OpenAPI、审计、分布式限流和 Prometheus 指标；
- [x] Notification/Delivery/Inbox 与 durable tenant event 同事务提交，稳定 producer key 去重，用户定向 WebSocket/Redis fan-out 和 HTTP replay；
- [x] Compose/Helm/env、受控 Provider 故障矩阵、delivery bundle 和运维文档；
- [x] 真实 SMTP/短信/公网 Webhook 继续标记 `not_run`，不以受控 Provider 冒充。

## 4. 安全运维底座设计

### 4.1 权限

- 保留现有 `owner/admin/operator/viewer/system` 身份角色；
- 新增集中 capability policy，把 module/action 映射到角色，路由不再各自猜测权限；
- 用户资源必须同时满足 tenant、owner/recipient 或明确 capability；
- system 调用必须携带目标 tenant，禁止隐式使用 `system` tenant 写业务数据；
- Provider webhook 使用独立认证路径，不能复用用户 JWT 权限。

### 4.2 审计

- 新增 append-only、tenant-scoped audit event；
- 记录 actor、action、resource、business_ref、request_id、result、policy decision、来源 IP 哈希和安全 metadata；
- 对关键配置、远控、文件、通知、Voice 和 Provider 操作建立覆盖清单；
- 提供游标查询、JSONL 导出、保留策略和篡改检测链；
- 明文 token、号码、邮箱、短信正文、模板 secret 和文件绝对路径不得进入审计。

### 4.3 限流、配额和防滥用

- PostgreSQL 多实例共享 token/window authority；
- 支持 tenant、actor、IP hash、route、recipient/provider 五种 key；
- 对通知创建、短信、邮件、Webhook test、登录凭证、远控授权和上传设置独立策略；
- 返回标准 `429`、`Retry-After`、limit/remaining/reset；
- system/provider webhook 也有限流，不存在无限流量旁路。

### 4.4 数据保留

- policy 按数据类别定义保留天数、legal hold 和删除批量；
- worker 先删除外部对象/派生物，再删除或匿名化数据库投影；
- 删除任务可重试、可对账、有指标和审计；
- Voice recording、LiveKit recording、IM/file、通知、事件、审计分别配置，不能共用一个粗粒度 TTL。

### 4.5 监控与就绪性

- `/livez` 只表示进程存活；`/readyz` 检查 PostgreSQL、migration、必要 Provider 配置和 worker freshness；
- `/health` 保留兼容，但不得仅用 `Boolean(pg)` 宣称数据库健康；
- 指标覆盖 HTTP latency/result、queue depth/oldest age、lease loss、retry/dead-letter、provider health/quota/circuit、notification delivery、retention 和 backup；
- 日志统一 request/correlation/event/delivery id，秘密和 PII 脱敏；
- 提供 Prometheus alert rules 和 dashboard 指标字典。

### 4.6 备份恢复

- PostgreSQL 使用 `pg_dump` custom format，生成 source/migration/schema/version/checksum manifest；
- 对象存储按 inventory/checksum 归档，不把 secret 写入备份；
- restore 进入新数据库，先校验 checksum，再迁移、RLS smoke、租户计数和关键引用完整性；
- 提供 dry-run、受控最小恢复和 RPO/RTO 报告模板；
- 备份成功不等于恢复成功，发布门禁要求最新恢复演练证据。

### 4.7 多实例部署

- worker 使用 PostgreSQL `FOR UPDATE SKIP LOCKED`/租约和稳定幂等，不使用内存 leader；
- HTTP runtime 无本地会话权威，WebSocket 事件通过 durable journal 恢复；
- Helm 增加 Deployment rolling update、PDB、HPA、topology spread、graceful shutdown 和 migration Job；
- 有状态 RustPBX、Tinode、LiveKit 和 PostgreSQL 不因 API replica 数量被错误复制；
- 自动化验收至少启动两个 worker，证明无重复副作用、lease takeover 和停止顺序。

### 4.8 实施结果

- [x] capability policy 与统一授权 helper 已接入 iveKit 新路由；
- [x] audit migration/store/service/query/export/coverage gate；
- [x] distributed rate-limit migration/store/middleware/headers/metrics；
- [x] typed retention policy、worker、对象删除 port 和 legal hold；
- [x] `/livez`、`/readyz`、worker heartbeat、queue/provider/retention 指标；
- [x] PrometheusRule、ServiceMonitor、Grafana dashboard 和共享指标/事故 runbook；
- [x] backup/restore/integrity scripts、manifest validator 和受控恢复验收；
- [x] Helm PDB/HPA/topology/migration/termination/backup CronJob 与多实例 lease 合同；
- [x] 安全、通知、监控、备份恢复和真实环境 `not_run` 文档；
- [ ] 目标 Kubernetes 的 Operator 发现、Alertmanager、Grafana 导入、rollout/rollback 和真实多副本故障演练仍为环境验收。

## 5. 测试与交付门禁

每个工作包按以下层级验证：

1. domain/state-machine 单元测试；
2. HTTP/SDK 合同和 secret-safety 测试；
3. PostgreSQL fresh/upgrade/RLS/claim/restart recovery；
4. controlled Provider success、401/403、408、409、425、429、5xx、timeout、invalid JSON、oversize；
5. 两 worker 竞争、lease takeover、幂等和 dead-letter replay；
6. Compose config、Helm template、image digest 和 migration ordering；
7. delivery bundle allowlist、checksum、SBOM、secret scan、tamper rejection；
8. 完整 focused regression、root typecheck、SDK build 和 `git diff --check`。

真实环境矩阵独立记录：

| 环境能力 | 当前状态 |
| --- | --- |
| 真实 RustPBX/PSTN/WSS/RTP/物理音频 | `not_run` |
| 真实 SMTP/邮件退信 | `not_run` |
| 真实短信厂商发送/回执/配额 | `not_run` |
| 真实公网 Webhook DNS/TLS/故障切换 | `not_run` |
| 目标 Kubernetes 多副本 rollout/rollback | `not_run` |

## 6. 执行顺序

1. [x] 固定 Voice 审计结论并保留真实环境边界；
2. [x] 通知 migration、domain、store 和站内通知；
3. [x] Webhook/邮件/短信 Provider 与 durable delivery worker；
4. [x] 通知 HTTP/SDK/事件/指标/部署/受控验收；
5. [x] 集中权限、审计和分布式限流；
6. [x] typed retention、就绪性、备份恢复和多实例部署；
7. [x] Stage 4 全回归，更新交付包和完成状态；
8. [ ] 进入 Stage 5 全链路验收与 LED 对接交付文档。

## 7. Stage 4 完成证据（2026-07-15）

- 通知、安全与运维 focused regression：核心 `128/128`，delivery/OpenAPI/release/tamper 合同 `28/28`，均为 0 fail；
- Voice、IVR、RustPBX、SIP、WebPhone 与 Contact Center regression：`341` 项，`339` pass、0 fail、2 skip；两个 skip 均要求显式的独立 PostgreSQL 验收环境，未使用 SQLite 替代；
- foundation 分量门禁：standalone HTTP `16/16`、其余 core `96/96`，SDK TypeScript build 和 dry-run pack 通过；聚合 `npm run verify:ivekit:foundation` 在当前 managed sandbox 内经 npm 子进程监听 `127.0.0.1` 时被 `EPERM` 拒绝，因此采用同一测试清单的直接分量命令取证，不把 wrapper 失败写成 passed；
- standalone build context：离线 `npm ci`、TypeScript build、302 个 source file、8 个 runtime package 和 7 个生产入口校验通过；
- 根 TypeScript typecheck、delivery bundle/tamper contract、OpenAPI parse、三套 Compose quiet render 和 `git diff --check` 纳入最终 Stage 4 交付门禁；
- 当前机器没有 Helm 和 promtool，目标 Kubernetes 的 CRD discovery、Prometheus rule evaluation、Alertmanager 路由、Grafana 导入、rollout/rollback、真实多副本故障演练保持 `not_run`；
- 真实 PSTN/WSS/RTP/物理音频、SMTP 退信、短信厂商回执和公网 Webhook DNS/TLS 继续保持 `not_run`。
