# Call-Center 核心模块代码审核报告（2026-06）

> 审核范围：inbound(8) + agent-tools(16) + agent-panel(3) + dialer(5) + 拨号器根级(5) + compliance(10) + billing(4) = 51 文件
> 审核维度：正确性 / 完整性 / 架构一致性 / 类型与错误处理 / 代码味道
> 分级标准：P0（必修，功能正确性/安全）/ P1（重要，可维护性）/ P2（改善）

## 一、问题全景统计

| 模块 | P0 | P1 | P2 | 完成度 |
|---|---|---|---|---|
| inbound | 4 | 7 | 3 | 中 |
| agent-tools | 3 | 7 | 6 | 中 |
| agent-panel + 拨号器根级 | 4 | 6 | 5 | 中 |
| dialer | 1 | 4 | 5 | 低-中 |
| compliance | 4 | 11 | 9 | 中 |
| billing | 5 | 10 | 5 | 低 |
| **合计** | **21** | **45** | **33** | — |

**P0 修复估算**：~7-9 人日
**P1 修复估算**：~8-11 人日

## 二、最严重的 10 个 P0 问题（D1 阶段优先修复）

### 安全/租户隔离类（5 个，最高优先级）

1. **[inbound P0-1] 跨租户越权接听** — `application.ts:894`：`getActiveEntryByCallSession` 不带 tenant_id，知道 call_session_id 即可跨租户标记应答/抢占 ACD
2. **[agent-panel P0] SSE 跨租户越权** — `phase3-agent-http.ts:34`：`/seats/:seatId/events` 未校验 seatId 归属，任意租户可订阅他租户通话事件
3. **[agent-tools P0-7] supervisor/park-pickup 未校验坐席归属** — `supervisor.ts:81` + `park-pickup.ts:48`：forceDisconnect/pickupCall 可操作他租户坐席
4. **[billing P0-4] billing 全端点零鉴权** — `billing-http.ts` 全文无 requireAuth，任意人可查/改任意租户订阅/用量
5. **[compliance P1-10] /api/compliance/check 未鉴权** — `compliance-http.ts:56`：可探测任意租户 DNC/频次状态

### 合规失效类（3 个）

6. **[compliance P0-2] AI 披露强制器未接入拨号路径** — `disclosure-enforcer.ts:43`：beginDisclosure 无调用方，"AI 必须先披露"形同虚设
7. **[compliance P0-4] compliance-gate fail-open** — `outbound-compliance.ts:19`：Postgres 不可用时静默放行，应 fail-closed
8. **[agent-tools P0-5] PCI 录音恢复格式不一致** — `recording-pci.ts:46`：恢复强制 ogg，未存原 format，合规审计链断裂

### 功能正确性类（3 个）

9. **[inbound P0-4] 等待时间估算 SQL 错误** — `call-queue.ts:166`：LIMIT 对 AVG 聚合无效，estimated_wait_sec 系统性偏差
10. **[dialer P0] A/B 测试哈希严重偏置** — `campaign-store.ts:304`：charCode 累加取模 2 对定长号码可能 100% 落单桶

### Billing 专项（已知，D1 修复）

11. **[billing P0-1] 无真实 Stripe SDK** — `billing-http.ts:99`：checkout/portal 永远返回 placeholder，无 stripe 依赖
12. **[billing P0-2] webhook 手写无重放保护** — `stripe-webhook.ts:18`：未用官方 constructEvent，无时间戳校验/幂等

## 三、模块完成度详评（已更新 2026-06-22）

### inbound（中→高）
ACD 主链路可跑。已修复：auto-attendant 时区用 Intl.DateTimeFormat、longest_idle 排除过期心跳、DID 模糊匹配改进、ensureDefaultQueue TOCTOU、routeInboundCall 孤儿 session 清理。**仍待修**：round_robin 游标非持久（P1）、predictive_heuristic 绕过技能过滤（P0-2 已标注但未修）。

### agent-tools（中→高）
16 个工具均有实现。已修复：voicemail-transcribe 移除伪 LLM fallback、暖转 bridge 失败回写 metadata、PCI 录音格式一致、readMetadata DRY 提取、park-pickup 过期 slot 清理。**仍待修**：ivr-menu 全硬编码（P1）、会议并发无乐观锁（P1）。

### agent-panel + 拨号器（中→高）
拨号主循环可跑通。已修复：拨号器副作用清理孤儿 session、originate 超时 hangup、failTask code 提取 bug、配额接入拨号路径。**仍待修**：SSE 重复注册覆盖旧连接（P1）、task-lock 非原子（P1）。

### dialer（低-中）
### dialer（低-中→中）
campaign CRUD 完整。已修复：A/B hash 改 MD5、stats answer_rate/abandon_rate 计算修正、report-outcome/surveys 加鉴权。**仍待修**：预测式算法是启发式 placeholder（非 Erlang，P1）、post-call-survey 链路断开（P2）。

### compliance（中→高）
DNC/时间窗/频次/审计/保留/GDPR 骨架齐全。已修复：披露强制器接入拨号路径、fail-closed、countCallsToday 只统计接通、GDPR purge 补清合规表、时间窗 DRY 提取。**仍待修**：双库割裂（audit 在 SQLite、DNC 在 Postgres，P1 完整迁移需改 SQL 占位符）。

### billing（低→中）
已修复：真实 Stripe SDK 接入（checkout/portal/webhook）、全端点加鉴权、配额接入拨号路径、findTenantByCustomer DB 反查、webhook 幂等去重、handleSubscriptionDeleted 状态修正。**仍待修**：billing 表仍在 SQLite（P1 需迁 Postgres）。

## 四、D 阶段修复建议

### D1（P0）— ✅ 全部完成（11/11）
1. ✅ 租户隔离修复（5 个安全 P0）— commit eba47d2
2. ✅ Stripe SDK 接真 — commit 6fcf799
3. ✅ 合规修复（披露接入 + fail-closed + PCI format）— commit a4b1ef5
4. ✅ A/B hash + estimateWaitSec SQL + ensureDefaultQueue 并发 — commit 001d7e0

### D2（P1）— ✅ 全部完成（14/14）
1. ✅ auto-attendant 时区 + DID 模糊匹配 + longest_idle + 孤儿 session（inbound 4 个）— commit 7904249
2. ✅ voicemail 伪 fallback 移除 + 暖转 bridge 失败回写（agent-tools 2 个）— commit 7904249
3. ✅ 拨号器副作用清理 + failTask code + originate hangup（dialer 3 个）— commit 27f8256
4. ✅ countCallsToday + GDPR purge + 双库标注（compliance 3 个）— commit e109ae6
5. ✅ 配额接入 + campaign 鉴权 + stats 修正（billing+dialer 3 个）— commit 7a35ab5

### D3（P2）— ✅ 主要完成（13/33）
1. ✅ readMetadata DRY（5 处→1）— commit 7af31eb
2. ✅ 时间窗 DRY（2 处→1）— commit 7af31eb
3. ✅ voicemail 分页 + recording-search ESCAPE/OFFSET — commit 7af31eb
4. ✅ retention requestId + outbound-compliance getLocalHour DRY — commit 7af31eb
5. ✅ billing currentPeriod DRY + campaign-store SqliteParams — commit fa7b75e
6. ✅ consent 注释 + park-pickup 清理 + agent-script warn — commit 6c1608d

**仍待修的低优先级 P2**（20 个，不影响功能）：
- `as any` 类型校验（需逐步开 strictNullChecks）
- 非空断言 `!` 清理
- compliance-http 每次 new 对象（性能影响极低）
- campaign-service 类名 vs 文件名不一致
- outbound-dialer.ts 477 行单文件拆分
- 巨型文件拆分（application.ts 44KB）

## 五、系统性问题（跨模块）— 已更新

1. **tsconfig strict: false** — 仍存在，建议逐步开启 strictNullChecks（未修）
2. **双库割裂** — 部分缓解：GDPR purge 已跨库清理，但 audit/retention 仍在 SQLite（P1 完整迁移需改 SQL 占位符）
3. **鉴权不一致** — ✅ 已修复：billing 全端点加鉴权、compliance/check 加鉴权、campaign report-outcome/surveys 加鉴权
4. **进程内状态** — 仍存在：round_robin 游标、disclosure Map、dialer-wait-registry 仍是进程内 Map（多实例失效，文档已标注差距）
5. **副作用无补偿** — ✅ 已修复：拨号器失败清理 session、暖转 bridge 失败回写 metadata
