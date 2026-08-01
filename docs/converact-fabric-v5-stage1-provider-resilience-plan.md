# Converact Fabric V5 阶段一 Provider 治理实施计划

**目标：** 在现有 OCR、ASR、AI 质检和翻译能力上增加产品无关、多租户、多实例安全的 profile route、配额、熔断、降级和故障切换。

**架构：** 租户策略保存每种 capability 的显式有序 route；部署 profile 保存非敏感的运行预算。每次 Provider 调用先通过 PostgreSQL governance store 原子预留配额和并发 lease，再由 route executor 执行。retryable 故障可以切换到 route 中下一个 profile，terminal 输入故障立即结束。

**技术栈：** TypeScript、Node.js、PostgreSQL FORCE RLS、现有 durable worker、`@converact/sdk`、Node test runner、Prometheus。

## 1. 文件职责

新增：

- `src/migrations/059_ivekit_provider_governance.sql`：route columns、runtime state、reservation lease、索引、RLS 和 runtime grants。
- `src/agent-runtime/collaboration/intelligence-provider-governance-store.ts`：原子 reserve/complete、配额窗口、并发 lease、熔断状态机和过期 lease 回收。
- `src/agent-runtime/collaboration/intelligence-provider-route.ts`：route 解析、Provider 构造、跳过原因和 retryable failover executor。
- `src/agent-runtime/collaboration/intelligence-provider-metrics.ts`：低基数 Provider 路由、延迟、故障切换和熔断转换指标。
- `scripts/converact-provider-governance-acceptance.ts`：受控协议与治理矩阵验收，明确不作为真实厂商证据。
- `test/converact-intelligence-provider-governance.test.ts`：状态机和 SQL 合同测试。
- `test/converact-intelligence-provider-route.test.ts`：四种 capability 的 route/failover 测试。

修改：

- `src/agent-runtime/collaboration/intelligence-provider-registry.ts`：解析并校验 quota/circuit/concurrency 配置。
- `src/agent-runtime/collaboration/intelligence-policy-store.ts`：保存四类有序 profile route，并兼容旧单 profile。
- `src/agent-runtime/collaboration/intelligence-provider-routing.ts`：由单 profile resolver 切换到 governed route provider。
- `src/agent-runtime/collaboration/attachment-processing.ts`、`quality-review.ts`、`translation-service.ts`：记录实际命中的 profile 和 failover metadata。
- `src/agent-runtime/converact/intelligence-http.ts`：运行状态和 route-safe API。
- `src/agent-runtime/converact/application.ts`：注入 governance store、指标和 route executor。
- `src/agent-runtime/collaboration/index.ts`：导出新增公共类型。
- `sdk/converact/src/intelligence-types.ts`、`sdk/converact/src/http-sdk.ts`：策略 route 和运行状态 SDK。
- `services/converact-service/source-policy.json`：加入 migration 059。
- `services/converact-service/env.example`、`services/converact-service/README.md`：运行预算和运维说明。
- `docs/converact-openapi.md`、`docs/openapi.yaml`、`docs/converact-fabric-v3-intelligence-operations.md`：API、兼容和故障处置文档。

## 2. 数据合同

### 2.1 Profile 预算

每个 profile 新增以下可选字段，均为非敏感配置：

```ts
interface IntelligenceProviderBudget {
  requests_per_minute: number; // 0 表示不限制
  requests_per_day: number;    // 0 表示不限制
  max_concurrency: number;     // 1..100
  failure_threshold: number;   // 1..100
  open_cooldown_ms: number;    // 1000..3600000
  reservation_ttl_ms: number;  // 必须大于 timeout_ms
}
```

默认值：分钟/日不限，最大并发 10，连续 3 次 retryable 失败打开 circuit，30 秒后进入 half-open，reservation TTL 为 `timeout_ms + 5000`。

### 2.2 租户 route

策略增加：

```ts
ocr_profile_ids: string[];
asr_profile_ids: string[];
quality_profile_ids: string[];
translation_profile_ids: string[];
```

数组顺序就是选择顺序。旧 `*_profile_id` 保留一个兼容版本：读取时若 route 为空则映射为单元素数组；写入新策略时第一个 route 同步回旧字段。route 最多 10 项，不允许重复、跨 capability 或未经允许的 third-party profile。

### 2.3 运行状态

`collaboration_intelligence_provider_runtime` 以 `(tenant_id, capability, profile_id)` 为主键，保存 minute/day window、请求计数、连续失败、circuit state、open until、最近成功/失败和安全错误码。

`collaboration_intelligence_provider_leases` 保存每次 reservation。活跃 lease 数决定并发；`expires_at` 允许进程崩溃后自动恢复。complete 幂等，重复回报不重复修改计数或 circuit。

两张表都启用 `ENABLE ROW LEVEL SECURITY` 和 `FORCE ROW LEVEL SECURITY`。

## 3. 实施任务

### Task 1：迁移和数据库合同

- [x] 在 `test/converact-intelligence-provider-governance.test.ts` 写失败测试，断言 migration 059 包含四个 route columns、runtime/lease 表、唯一约束、due index、FORCE RLS 和 `opc_runtime` 权限。
- [x] 运行 `node --import tsx --test test/converact-intelligence-provider-governance.test.ts`，确认因 migration 缺失失败。
- [x] 创建 `src/migrations/059_ivekit_provider_governance.sql`。先增加 route columns，并用旧 primary profile 回填；再创建 runtime/lease 表及 RLS。
- [x] 将 migration 加入 `services/converact-service/source-policy.json`，位置在 058 后、090 前。
- [x] 更新 `test/converact-standalone-migrations.test.ts`，断言 059 顺序和 standalone inclusion。
- [x] 运行 migration focused tests 和 `npm run typecheck`。

### Task 2：Profile 预算和租户 route

- [x] 在 `test/converact-intelligence-provider-registry.test.ts` 增加预算默认值、上下界、未知字段和 `reservation_ttl_ms > timeout_ms` 测试。
- [x] 在 `test/converact-intelligence-policy.test.ts` 增加 route 排序保留、重复 profile、capability 错配、third-party 未授权、旧 policy 回退测试。
- [x] 修改 registry 和 policy store 的类型、校验、SQL、decode/default。
- [x] safe profile API 只新增预算数字，不返回 URL、token env 或凭据。
- [x] 运行 registry/policy/HTTP/preflight focused tests。

### Task 3：PostgreSQL governance store

- [x] 测试 `reserve()`：成功、分钟配额、日配额、并发上限、open circuit、half-open 单探测和过期 lease 回收。
- [x] 测试 `complete()`：成功关闭 circuit；retryable 失败累计并打开；terminal 失败不打开；重复 complete 幂等。
- [x] 实现 `IntelligenceProviderGovernanceStore`，所有 read-modify-write 位于事务和 `SELECT ... FOR UPDATE` 内。
- [x] reservation 返回不透明 `lease_id`、profile id 和过期时间；不得返回 URL、token 或原文。
- [x] 使用真实 PostgreSQL 测试两个并发连接竞争最后一个配额/并发名额，只允许一个成功。

### Task 4：Governed route executor

- [x] 测试首选 profile 成功时不调用 fallback。
- [x] 测试 429、5xx、timeout 和网络故障完成失败记录并切换下一 profile。
- [x] 测试 400、非法输入、非法响应和 source-ref 错误不切换。
- [x] 测试首选 profile 因 quota/circuit/concurrency 被跳过时选择下一个，并记录安全 skip reason。
- [x] 测试 route 全部不可用时返回统一 retryable `provider_route_unavailable`，job 保持 durable retry 语义。
- [x] 为 OCR、ASR、quality 和 translation 构造每次 job 独享的 route provider；命中后把 wrapper 的 `profile_id/name/mode` 更新为实际 Provider，使现有 job 完成 SQL 记录真实 profile。

### Task 5：Worker、事件和指标接线

- [x] 修改三个 service 的输出 metadata，记录 `route_attempt_count`、`failed_over` 和安全 skip/error code，不保存 URL、token、输入正文或原始错误 body。
- [x] 新增 tenant event：`collaboration.intelligence.provider.selected`、`provider.failed_over`、`provider.circuit_changed`。
- [x] 新增 Prometheus metrics：reservation result、provider request result/latency、failover、circuit transition 和 route exhausted。
- [x] 测试通知/事件失败不回滚已经完成的 Provider 结果。
- [x] 测试 worker restart 后过期 Provider reservation 可恢复，job 不永久停留在 processing。

### Task 6：API、SDK 和文档

- [x] `GET /api/ivekit/intelligence/providers/runtime` 仅允许 system/admin，返回租户内 safe runtime snapshot。
- [x] policy GET/PUT 和 capabilities 返回 profile route；旧 SDK request 仍可工作。
- [x] SDK 增加 `listProviderRuntime()`，类型与服务端完全一致。
- [x] OpenAPI 增加 route、budget、runtime schema、统一 `provider_route_unavailable` 和逐候选 quota/circuit skip reason。
- [x] 运维文档写明自建优先、第三方 fallback、全自建、全第三方和禁止跨境 fallback 五种配置示例。

### Task 7：阶段一验收

- [x] 运行所有 intelligence/translation/attachment/quality focused tests（95/95）。
- [x] 运行 `npm run typecheck`。
- [x] 完成 `verify:converact:foundation` 的全部组成门禁：foundation tests 在允许监听端口的全仓库测试中通过，SDK build 和 dry-run pack 通过；受限沙箱内直接 wrapper 仅因 `listen EPERM` 不能原命令复现。
- [x] 运行真实 PostgreSQL fresh/upgrade/RLS/并发 reservation 验证。
- [x] 运行受控 Provider matrix，覆盖 success、429、5xx、timeout、terminal、quota、circuit、half-open 和 failover（9/9）。
- [x] 更新 `docs/converact-fabric-v5-shared-foundation-design.md` 证据矩阵，只把有当前 source-bound 证据的项目改为 `implemented`。

## 4. 阶段一完成标准

1. 四类 capability 都经过同一个治理模型，不允许只给翻译实现 failover。
2. 多实例下配额和并发不会超发；进程崩溃不会永久占用名额。
3. third-party fallback 必须在租户 route 中显式出现且 `allow_third_party=true`。
4. terminal 错误不触发故障切换，避免重复发送非法或敏感内容。
5. API、日志、事件、指标和证据均不泄漏 Provider endpoint、secret、原文或原始错误 body。
6. 真实厂商仍标记 `not_run`，受控 Provider 只证明协议、路由和恢复行为。

## 5. 独立审查整改（2026-07-15）

以下整改已完成；阶段一仍因内容识别增强任务保持 `in_progress`：

- [x] quota、concurrency、circuit 跳过返回最早 `retry_at`，未调用 Provider 的预留拒绝不得消耗业务任务尝试次数。
- [x] attachment、quality、translation 的 worker claim lease 覆盖 route 中最大 Provider reservation TTL 和 5 秒治理余量。
- [x] PostgreSQL 治理状态以 `clock_timestamp()` 为准，不由不同应用实例的本地时钟裁决配额窗口、lease 过期和 circuit cooldown。
- [x] Provider 调用成功后，治理完成回写失败不再被误判为 Provider 失败或触发 fallback；成功输出保留 `governance_completion_pending` 恢复语义。
- [x] Provider 事件先写入 FORCE RLS tenant event journal，再尝试实时发布；实时发布失败不丢失可重放记录。
- [x] route exhausted 将逐候选安全 attempt metadata、最早重试时间和 failover 尝试写入失败 job，并记录对应事件与指标。
- [x] circuit `open -> half_open -> closed|open` 转换以治理事务的明确 transition 输出为准。
- [x] SDK 与 OpenAPI 对 route-native policy write 的必填字段一致，同时保留 legacy 单 profile SDK 请求兼容。
- [x] 真实 PostgreSQL upgrade 测试从 pre-059 schema 应用 059，并覆盖 quota race 与新表跨租户 RLS。
- [x] Provider lease 历史按租户在新 reservation 时自动执行 7 天保留、小批量有界清理，并使用 partial history index。

整改验收证据：Provider/attachment/quality/translation/intelligence/event focused tests `108/108`；真实 PostgreSQL fresh、pre-059 upgrade、RLS、quota/concurrency race、IVR flow 与受控 RustPBX 均通过；TypeScript `typecheck` 通过。真实 OCR、ASR、质检和翻译厂商仍保持 `not_run`。
