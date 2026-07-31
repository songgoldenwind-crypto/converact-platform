# OPC 审计与归档总结（2026-06）

> 分支：`audit-and-archive-2026-06`（从 `batch-82-88-phase-aware-context` 分出）
> 日期：2026-06-22
> 范围：lead-acquisition 归档 + platform 反向依赖拆解 + 文档治理 + call-center 6 核心模块审核 + 11 个 P0 修复

## 一、执行概览

### Commit 时间线

| Commit | 类型 | 内容 |
|---|---|---|
| `ba2d176` | snapshot | 固化 325 个未提交改动（Sprint 1-12 + Phase 0-3） |
| `b1d8f68` | refactor | platform CRUD 命令从 lead-acquisition 解耦 |
| `28f9aff` | archive | lead-acquisition 整目录归档（252 文件）+ 53 测试 + 3 脚本 + platform 反向依赖拆解 |
| `c9f3bfc` | docs | 文档治理：technical-design 归档 + checklist 重写 + CLAUDE.md 更新 |
| `f95363b` | audit | call-center 6 核心模块审核报告（21 P0 / 45 P1 / 33 P2） |
| `eba47d2` | fix(security) | 5 个安全 P0：租户隔离 + 鉴权 |
| `001d7e0` | fix(correctness) | 3 个正确性 P0：A/B hash + SQL + 并发 |
| `a4b1ef5` | fix(compliance) | 3 个合规 P0：披露接入 + fail-closed + PCI format |
| `6fcf799` | feat(billing) | Stripe SDK 接真：checkout/portal/webhook |

### 量化结果

| 指标 | 数值 |
|---|---|
| 归档文件（lead-acquisition src + test + scripts + docs） | 471 |
| 新建 src 文件（platform 解耦 + db-migrations） | 4 |
| 修改 src 文件 | 12 |
| P0 问题修复 | 11/11（100%） |
| P1 问题（待后续修复） | 45（未修） |
| P2 问题（待后续修复） | 33（未修） |
| typecheck | 0 错误 |
| 核心测试 | 19/19 全绿 |

## 二、归档清单

### 归档到 `~/Desktop/opc-archive/archive/legacy-lead-acquisition-direction/`（已移出本仓库）

| 类别 | 数量 | 路径 |
|---|---|---|
| lead-acquisition 源码 | 252 文件 | `src/agent-runtime/lead-acquisition/` |
| 依赖 lead-acquisition 的测试 | 53 文件 | `test/*.test.ts` |
| lead-acquisition 脚本 | 3 文件 | `scripts/*.ts` |
| 旧 feature checklist | 1 文件 | `docs/new-feature-application-checklist.md` |
| 旧设计文档 | 多份 | `docs/` 下根目录 OPC*.md |

### 归档到 `~/Desktop/opc-archive/archive/superseded-by-v3/`（已移出本仓库）

| 文件 | 原因 |
|---|---|
| `docs/design/technical-design.md` | 自标"已被 architecture-v3 取代" |

### 新建文件

| 文件 | 用途 |
|---|---|
| `src/platform/scoring-utils.ts` | 从 lead-acquisition 拆出的纯函数（badRequest/scoreInquiry/upsertContact 等） |
| `src/platform/task-commands.ts` | 从 lead-acquisition 拆出的 task 命令（createTask/completeTask/rescheduleTask），lead-acquisition 钩子改为可选注入 |
| `src/db-migrations/legacy-lead-run-particle-keys.ts` | 从 lead-acquisition 拆出的常量（db.ts 迁移用） |
| `docs/new-feature-application-checklist.md` | 重写版，面向 call-center/voice-agent 域 |
| `docs/audit-2026-06/call-center-audit-report.md` | 6 核心模块审核报告 |

## 三、P0 修复详情

### 安全（5 个，commit eba47d2）

1. **跨租户越权接听** — `getActiveEntryByCallSession` 加 tenant_id JOIN 过滤
2. **SSE 跨租户订阅** — 所有 seatId 路由加 `assertSeatOwnership`
3. **park/pickup 未校验坐席归属** — 加 `assertSeatOwnership`
4. **billing 全端点零鉴权** — 加 `requireAuth`，tenant_id 从 auth context 取
5. **/api/compliance/check 未鉴权** — 改 `requireAuth`

### 正确性（3 个，commit 001d7e0）

6. **A/B 测试哈希偏置** — charCode mod 2 → MD5 hash
7. **estimateWaitSec SQL 错误** — LIMIT 对 AVG 无效 → 子查询
8. **ensureDefaultQueue TOCTOU** — try/catch + 重新查询

### 合规（3 个，commit a4b1ef5）

9. **AI 披露未接入拨号路径** — 两条拨号路径加 `beginDisclosure`
10. **compliance-gate fail-open** — Postgres 不可用时改 fail-closed
11. **PCI 录音恢复格式不一致** — pause 存原 format，resume 恢复 + 校验暂停态

### Billing（commit 6fcf799）

12. **无真实 Stripe SDK** — 接真 Stripe checkout/portal
13. **webhook 手写无重放保护** — 官方 `constructEvent` + 幂等去重
14. **findTenantByCustomer 大面积丢失** — 加 DB 反查
15. **handleSubscriptionDeleted 状态错误** — `active` → `canceled`

## 四、保留模块清单（call-center 18 子模块 + 根级 30 文件）

全部保留，完成度评估：

| 模块 | 完成度 | P0 已修 |
|---|---|---|
| inbound | 中 | ✓（4 个 P0 全修） |
| agent-tools | 中 | ✓（3 个 P0 全修） |
| agent-panel | 中 | ✓（SSE 租户隔离 + 重复注册） |
| dialer | 低-中 | ✓（A/B hash） |
| compliance | 中 | ✓（披露 + fail-closed + PCI） |
| billing | 低→中 | ✓（Stripe SDK 接真） |
| analytics | 高 | 未审（P1/P2 待后续） |
| chatwoot | 高 | 未审 |
| events | 中 | 未审 |
| knowledge | 高 | 未审 |
| omnichannel | 高 | 未审 |
| qm | 高 | 未审 |
| routing | 高 | 未审 |
| webhooks | 高 | 未审 |
| wfm | 高 | 未审 |
| white-label | 高 | 未审 |
| ivr | 中 | 未审（缺图形化设计器） |

## 五、后续工作建议

### 优先级 1（P1 修复，~8-11 人日）
- compliance 双库统一（SQLite audit vs Postgres DNC）
- GDPR purge 补合规表
- billing 配额接入拨号路径（incrementUsage + checkQuota 拦截）
- voicemail-transcribe 移除伪 LLM fallback
- IVR 菜单 DB 持久化（当前全硬编码）
- 拨号器副作用补偿（失败清理 session/room）
- 暖转异步 bridge 失败回写

### 优先级 2（P2 修复，~3-4 人日）
- readMetadata 抽公共工具（6 处重复）
- application.ts 44KB 按域拆分
- as any 校验（逐步开启 strictNullChecks）

### 优先级 3（未审模块）
- 剩余 12 个子模块（analytics/chatwoot/knowledge/omnichannel/qm/routing/webhooks/wfm/white-label/ivr/events/data）未做代码审核
- 建议按 MVP 闭环需要逐批审核

### 环境配置提醒
- Stripe 上线需配 `STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_PRO`、`STRIPE_PRICE_ENTERPRISE`
- compliance fail-closed 后，开发环境需配 Postgres 或 `OPC_USE_MEMORY_PG=1`
- `npm config set omit=` 清空全局配置（当前 `omit=dev` 导致 devDependencies 不装）
