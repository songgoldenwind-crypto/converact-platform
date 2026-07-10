# OPC 存量代码 vs 修订计划 v3 — Gap 分析

> **日期**: 2026-06-21（首次） · 2026-06-29（按 `docs/design/README.md` 准绳重扫陈旧项）
> **目的**: 逐项对照 `revised-master-plan.md` v3 与现有代码，确定每个模块的 **保留 / 重构 / 新建 / 废弃** 决策。
>
> **关联文档**（见 `docs/design/README.md`）：[修订版总规划](./revised-master-plan.md)（对照基准） · [实现级架构规格](./architecture-v3.md) · [安全与合规](./security-design.md) · [指标与可观测](./metrics-design.md) · [战略北极星](./super-contact-center-platform-vision.md) · [本目录导航与治理](./README.md)
>
> **重扫校准（2026-06-29，核查日期=2026-06-29）**：
> - **`src/ws.ts` 已存在**（不再"缺失/新建"）——L25/L50/L240 中"WS 层不存在/需新建 `src/ws.ts`"的断言已陈旧；现状 WebSocket 服务已落地，WS 替代 SSE 与 Redis PubSub 中继以 `architecture-v3.md` §4 内嵌校准为准
> - **`Kamailio` infra config**（L210）按已废/延后表统一为【延后·v2.0+】，不再"Sprint 11"（与 `revised-master-plan.md` §移除表一致）
> - **§3.1 废弃数=4** 与明细不符：明细仅 3 项废弃（Chatwoot client L160、Chatwoot handler L161、Kong config L209）。统一为 3 项废弃（总数 138-1=137？以明细为准，统计见下）
> - 其余"❌ 不存在"等行未本次机全量重扫，下个 Sprint 启动重跑 `ls`/`grep` 校准

---

## 1. 总体概况

### 1.1 现有代码统计

| 层 | 文件数 | 主要技术 | 状态 |
|---|---|---|---|
| OPC Core (TypeScript) | ~515 | Node.js raw HTTP + SQLite | 活跃 |
| AI Agent (Python) | ~24 | LiveKit Agents SDK + DeepSeek | 活跃 |
| Frontend (React) | ~15 | Vite + TailwindCSS | 基础框架 |
| Infra | ~10 | Docker Compose + Helm 骨架 | 部分可用 |
| Tests | ~134 | node:test + tsx | 覆盖不均 |

### 1.2 架构级偏差（红色警报）

| 偏差 | 影响 | 修复优先级 |
|------|------|-----------|
| **数据库是 SQLite**，无 Postgres 驱动 | 不支持并发、不支持行锁、无法多租户隔离 | **P0 — Sprint 1** |
| **WebSocket 层不存在**（`src/ws.ts` 缺失）【陈旧·已落地于 2026-06，核查日期=2026-06-29】 | 无实时通知、无来电弹屏、无状态广播 | **P0 — Sprint 1**（已完成） |
| **合规引擎不存在** | 外呼无法律保障，上线即违规 | **P0 — Sprint 1** |
| **Redis 未用于 AI Agent 热路径** | tool call 延迟 200ms+，体验差 | **P1 — Sprint 2** |
| **多个 HTTP 模块未挂载**（billing/wfm/知识库等） | 功能存在但不可访问 | **P1 — Sprint 2** |
| **无用户注册/登录 API** | 无法自助 onboarding | **P1 — Sprint 2** |

---

## 2. 逐模块分析

### 2.1 数据层

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| 数据库引擎 | `node:sqlite` (内置) | PostgreSQL 16 | **重写** `src/db.ts` |
| 连接管理 | 单文件 `data/opc.sqlite` | PgPool + 连接池 | **新建** |
| Schema 管理 | 代码内 migration 函数 | 独立 migration 文件 | **重构** |
| 多租户隔离 | 表内 `tenant_id` 列 | 同上 + RLS 策略 | **增强** |
| 测试模式 | 内存 SQLite | 测试容器 or 内存 SQLite 保留 | **保留** 仅 unit test |
| 依赖包 | 无 | `pg` + `@types/pg` | **新增** |

### 2.2 实时层

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| WebSocket 服务 | 【已落地于 2026-06，核查日期=2026-06-29】`src/ws.ts` 已存在 | `ws` 库 + JWT 鉴权 + 租户广播 | **已新建** `src/ws.ts`（见 `architecture-v3.md` §4 现状校准） |
| 来电弹屏推送 | ❌ 不存在 | WS 事件 `call.incoming` | **新建** |
| 坐席状态广播 | ❌ 不存在 | WS 事件 `seat.status_changed` | **新建** |
| Redis PubSub | `redis-client.ts` 存在但未用 | 多实例 WS 广播中继 | **重构** |
| 断线重连 | — | 客户端自动重连 + 消息补发 | **新建** |

### 2.3 认证与鉴权

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| JWT 验证 | ✅ `src/middleware/auth.ts` RS256 + JWKS | 保留 | **保留** |
| API Key 认证 | ✅ `X-API-Key` | 保留 | **保留** |
| 用户注册 | ❌ 不存在 | `POST /api/auth/register` | **新建** |
| 用户登录 | ❌ 不存在 | `POST /api/auth/login` (bcrypt + JWT) | **新建** |
| RBAC | ⚠️ 有 5 种角色但无细粒度权限 | 路由级权限检查 | **增强** |
| 租户创建 | ⚠️ `tenant-core.ts` 存在 | 注册时自动创建 | **重构** 对接 |

### 2.4 合规引擎

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| compliance-gate | ❌ 不存在 | 时间窗口 + 频率 + DNC | **新建** |
| disclosure-enforcer | ❌ 不存在 | AI 通话前强制播放 | **新建** |
| consent-tracker | ❌ 不存在 | 录音同意追踪 | **新建** |
| DNC 黑名单 | ❌ 不存在 | 永久跳过名单 | **新建** |

### 2.5 AI Agent (Python)

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| OutboundVoiceAgent | ✅ `session_handler.py` | 保留并增强 | **保留** |
| InboundVoiceAgent | ❌ 不存在 | Sprint 4 新增 | **新建** |
| TextChannelAgent | ❌ 不存在 | Sprint 9 新增 | **新建** |
| `check_intent` tool | ✅ 已接入 | 保留 | **保留** |
| `transfer_to_human` tool | ✅ 已接入 | 增强（WebSocket 通知） | **重构** |
| `navigate_flow` tool | ✅ 已接入 | 保留 | **保留** |
| `query_knowledge` tool | ⚠️ 代码存在但**未接入** session | Sprint 6 接入 | **修复** |
| `schedule_callback` tool | ✅ 已接入 | 保留 | **保留** |
| `send_material` tool | ⚠️ 仅 log，无真实功能 | Sprint 9 接真实渠道 | **重构** |
| `disclosure_complete` tool | ❌ 不存在 | Sprint 1 合规 | **新建** |
| `check_compliance` tool | ❌ 不存在 | Sprint 1 合规 | **新建** |
| `generate_summary` tool | ❌ 不存在 | Sprint 5 通话摘要 | **新建** |
| `analyze_sentiment` tool | ❌ 不存在 | Sprint 10 情感分析 | **新建** |
| Redis session cache | ❌ 每次 HTTP 查 DB | 启动加载 Redis + 异步落库 | **新建** |
| STT Plugin | ✅ FunASR / Deepgram / OpenAI | 保留 | **保留** |
| TTS Plugin | ✅ CosyVoice / Cartesia / OpenAI | 保留 | **保留** |
| Room metadata 驱动 | ✅ 读取 spec/language/tenant | 保留 | **保留** |

### 2.6 呼叫中心核心

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| 外呼拨号 | ✅ `outbound-dialer.ts` | 保留，Sprint 8 升级预测拨号 | **保留** |
| 坐席管理 | ✅ `seat-store.ts` 3 种状态 | 扩展到 6+ 种 | **增强** |
| 转人工编排 | ✅ `transfer-orchestrator.ts` | 增强 WebSocket 通知 | **重构** |
| 来电路由 | ✅ `call-router.ts` 基础路由 | Sprint 4 升级 ACD 引擎 | **重构** |
| CDR 接收 | ✅ `cdr-receiver.ts` | 保留 | **保留** |
| RWI Client | ✅ `rwi-client.ts` RustPBX WS | 保留 | **保留** |
| Egress 录音 | ✅ `egress-manager.ts` | 保留 | **保留** |
| Voice Agent Spec | ✅ 完整的 CRUD + 导航 | 保留 | **保留** |
| ACD 引擎 | ❌ 不存在 | Sprint 4 技能路由 | **新建** |
| 呼入队列 | ❌ 不存在 | Sprint 4 | **新建** |
| 队列回呼 | ❌ 不存在 | Sprint 4 | **新建** |
| DID 管理 | ❌ 不存在 | Sprint 4 | **新建** |
| 通话保持/恢复 | ❌ 不存在 | Sprint 5 | **新建** |
| 监听/强插/耳语 | ❌ 不存在 | Sprint 5 | **新建** |
| Wallboard | ❌ 不存在 | Sprint 5 | **新建** |

### 2.7 质检 (QM)

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| QM Store | ✅ `qm-store.ts` | 保留 | **保留** |
| QM Evaluator | ✅ `qm-evaluator.ts` LLM 评分 | 保留 | **保留** |
| QM HTTP | ✅ `qm-http.ts` | ⚠️ 存在但可能未挂载 | **修复挂载** |
| QM Policy | ✅ `qm-policy.ts` | 保留 | **保留** |
| 人工质检 | ❌ 不存在 | Sprint 6 | **新建** |
| 质检申诉 | ❌ 不存在 | Sprint 6 | **新建** |

### 2.8 知识库

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| Knowledge Store | ✅ `knowledge-store.ts` | 保留 | **保留** |
| Knowledge Retriever | ✅ `knowledge-retriever.ts` | 保留 | **保留** |
| Agent Assist | ✅ `agent-assist.ts` | 保留 | **保留** |
| Knowledge HTTP | ✅ `knowledge-http.ts` | ⚠️ 可能未挂载 | **修复挂载** |

### 2.9 计费

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| Billing Store | ✅ `billing-store.ts`（SQLite，目标迁 Postgres） | 保留 | **保留** |
| Stripe Webhook | ✅ `stripe-webhook.ts` — 已接真 Stripe SDK（commit 6fcf799），用官方 `constructEvent` + 幂等去重 | 保留 | **已升级** |
| Billing HTTP | ✅ `billing-http.ts` — 已加鉴权 + 真实 Stripe checkout/portal（commit 6fcf799 + eba47d2），无 STRIPE_SECRET_KEY 时回退 mock | 修复挂载 | **已修复** |
| Plan Definitions | ✅ `plan-definitions.ts` — 已加 `stripePriceId` 映射（`STRIPE_PRICE_PRO`/`STRIPE_PRICE_ENTERPRISE`） | 保留 | **已升级** |

### 2.10 WFM

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| WFM Store | ✅ `wfm-store.ts` | 保留 | **保留** |
| Forecast (SES) | ✅ `forecast.ts` | 保留，后续可升级 OR-Tools | **保留** |
| Scheduler (贪心) | ✅ `scheduler.ts` | Sprint 8 升级 OR-Tools | **重构** |
| WFM HTTP | ✅ `wfm-http.ts` | ⚠️ 可能未挂载 | **修复挂载** |

### 2.11 全渠道

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| Chatwoot Client | ✅ `chatwoot-client.ts` | 延后（计划用 adapter 模式） | **废弃** |
| Chatwoot Handler | ✅ `chatwoot-webhook-handler.ts` | 延后 | **废弃** |
| Channel Adapter Registry | ✅ `channel-adapter-registry.ts` | 保留作为基础 | **保留** |
| Email Adapter | ✅ `email-adapter.ts` | Sprint 9 完善 | **重构** |
| WeCom Adapter | ✅ `wecom-adapter.ts` | Sprint 9 完善 | **重构** |
| Web Chat Widget | ❌ 不存在 | Sprint 9 | **新建** |
| WhatsApp Adapter | ❌ 不存在 | Sprint 9 | **新建** |
| SMS Adapter | ❌ 不存在 | Sprint 9 | **新建** |
| 统一收件箱 | ❌ 不存在 | Sprint 9 | **新建** |

### 2.12 开放平台

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| Webhook Store | ✅ `webhook-store.ts` | 保留 | **保留** |
| Webhook Dispatcher | ✅ `webhook-dispatcher.ts` | 保留 | **保留** |
| Webhook HTTP | ✅ `webhook-http.ts` | ⚠️ 可能未挂载 | **修复挂载** |
| White-label Store | ✅ `white-label-store.ts` | 保留 | **保留** |
| White-label HTTP | ✅ `white-label-http.ts` | ⚠️ 可能未挂载 | **修复挂载** |
| NATS Publisher | ✅ `nats-publisher.ts` | Sprint 11 启用 | **保留** |
| OpenAPI Spec | ✅ `docs/openapi.yaml` | 保留 | **保留** |
| JS SDK | ✅ `sdk/javascript/` | 保留 | **保留** |

### 2.13 前端

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| 登录页 | ✅ `LoginPage.tsx` | 保留 | **保留** |
| Dashboard | ✅ `DashboardPage.tsx` | 增强（Wallboard 数据） | **重构** |
| 通话记录 | ✅ `CallRecordsPage.tsx` | 保留 | **保留** |
| QM 看板 | ✅ `QmDashboardPage.tsx` | 增强（雷达图/趋势） | **重构** |
| 坐席管理 | ✅ `AgentSeatsPage.tsx` | 增强（6 种状态） | **重构** |
| 设置页 | ✅ `SettingsPage.tsx` | 保留 | **保留** |
| WebRTC 坐席面板 | ❌ 不存在 | Sprint 3 | **新建** |
| 外呼任务 UI | ❌ 不存在 | Sprint 2 | **新建** |
| Voice Agent Spec UI | ❌ 不存在 | Sprint 2 | **新建** |
| 来电弹屏 | ❌ 不存在 | Sprint 3 | **新建** |
| Wallboard 大屏 | ❌ 不存在 | Sprint 5 | **新建** |
| 知识库管理 UI | ❌ 不存在 | Sprint 6 | **新建** |
| 报表页面 | ❌ 不存在 | Sprint 7 | **新建** |
| 全渠道收件箱 | ❌ 不存在 | Sprint 9 | **新建** |

### 2.14 基础设施

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| Docker Compose (dev) | ✅ `docker-compose.callcenter.yml` | 重构（去掉 Chatwoot，Postgres 对齐） | **重构** |
| Docker Compose (prod) | ✅ `infra/docker-compose.production.yml` | 对齐新架构 | **重构** |
| Helm Chart | ⚠️ 骨架 | Sprint 11 完善 | **保留** |
| Kong config | ✅ `infra/config/kong.yml` | 延后（不用 Kong） | **废弃** |
| Kamailio config | ✅ `infra/config/kamailio.cfg` | 【延后·v2.0+】（与 `revised-master-plan.md` §移除表一致，不再 Sprint 11） | **废弃**（config 文件保留作回滚参考，但不再启用） |
| NATS config | ✅ `infra/config/nats.conf` | Sprint 11 启用 | **保留** |

### 2.15 Legacy（获客域）

| 项目 | 现状 | 计划要求 | 决策 |
|------|------|---------|------|
| `lead-acquisition/` | 大量代码（50+ 文件） | 文档已归档，代码保留 | **冻结** 不动 |
| `prospect-outreach/` | 活跃测试 | CI 保留 | **冻结** 不动 |
| `geo-intelligence/` | 完整模块 | 不在当前计划 | **冻结** 不动 |

---

## 3. 决策汇总

### 3.1 数量统计

| 决策 | 模块数 |
|------|--------|
| **保留** (直接可用) | 38 |
| **增强/重构** (修改后可用) | 18 |
| **新建** (完全新写) | 42 |
| **修复** (代码存在但有 bug/未挂载) | 7 |
| **废弃** (不再使用) | 4 |
| **冻结** (不动) | 3 |

### 3.2 Sprint 1 必须解决的 Gap

1. **新建** `src/db-pg.ts` — Postgres 连接池 + migration runner
2. **新建** `src/ws.ts` — WebSocket 服务 + 鉴权 + 广播（【已落地于 2026-06，核查日期=2026-06-29】）
3. **新建** `src/agent-runtime/call-center/compliance/` — 合规引擎 3 文件
4. **新建** `POST /api/auth/register` + `POST /api/auth/login`
5. **重构** `docker-compose.callcenter.yml` — 去掉 Chatwoot，opc 连 Postgres
6. **新增依赖** `pg`, `ws`, `bcrypt`（或 Node.js 原生 crypto scrypt）
7. **修复** 所有未挂载的 HTTP 模块（billing/knowledge/wfm/webhooks/white-label）

### 3.3 可直接复用的核心资产

以下代码已验证可用且与计划方向一致：
- AI Agent 完整的 STT/TTS/VAD 插件体系 + 5 个 tool
- Voice Agent Spec 系统（CRUD + 节点导航 + IVR 导入）
- RustPBX RWI 集成 + CDR 接收
- LiveKit 集成（Room/Token/Egress/Agent Dispatch）
- 外呼任务管理 + 拨号器
- 意向评分 + QM 评分系统
- 前端基础框架 + API Client

---

## 4. 迁移风险

| 风险 | 缓解 |
|------|------|
| SQLite → Postgres 迁移可能破坏现有测试 | 保留 SQLite 作为 unit test 模式，Postgres 仅集成/E2E |
| 新增 WebSocket 可能与现有 HTTP 端口冲突 | WS 复用 :3000 端口，upgrade 协议 |
| 合规引擎可能影响现有外呼流程 | 通过 feature flag 逐步启用 |
| 多模块挂载可能引起路由冲突 | 统一路由前缀：`/api/call-center/*` |
| Legacy 代码体积大影响 typecheck 速度 | `tsconfig` 排除 lead-acquisition（或独立 project reference） |

---

## 变更记录

| 版本/日期 | 作者 | 变更内容 |
|-----------|------|---------|
| 2026-06-21 | - | 初始 gap 分析（对照 revised-master-plan v3） |
| 2026-06-29 | OPC Team | 按 `docs/design/README.md` §3/§4 准绳重扫：(1) `src/ws.ts` 三处断言（§1.2 架构偏差 / §2.2 实时层 / §3.2 Sprint 1 Gap）改为"已落地"，附核查日期=2026-06-29；(2) Kamailio config 从"保留·Sprint 11"改为"废弃·延后 v2.0+"（使 §3.1 废弃=4 与明细 4 项对齐，消除原统计矛盾）；(3) 头部加 `<关联文档>` block 与重扫校准段。其余"❌ 不存在"行未本轮全量重扫，下个 Sprint 重跑。 |
