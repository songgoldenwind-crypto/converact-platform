# Call-Center 剩余 12 子模块审核报告（2026-06-22）

> 审核范围：analytics(6) + chatwoot(4) + knowledge(6) + events(1) + omnichannel(8) + qm(6) + routing(1) + ivr(1) + webhooks(6) + wfm(6) + white-label(4) + data(1) = 50 文件

## 问题全景统计

| 模块 | P0 | P1 | P2 | 完成度 |
|---|---|---|---|---|
| analytics | 1 | 5 | 5 | 中 |
| chatwoot | 2 | 3 | 2 | 低 |
| knowledge | 1 | 5 | 7 | 低 |
| events | 1 | 1 | 2 | 低 |
| omnichannel | 3 | 10 | 6 | 中 |
| qm | 2 | 6 | 4 | 中 |
| routing | 0 | 5 | 2 | 中 |
| ivr | 0 | 4 | 4 | 中偏高 |
| webhooks | 2 | 4 | 7 | 中 |
| wfm | 2 | 4 | 6 | 低-中 |
| white-label | 1 | 2 | 6 | 中 |
| data | 0 | 1 | 3 | 中-高 |
| **合计** | **15** | **50** | **54** | — |

## 最严重的系统性问题：跨租户越权 + 零认证（10 个 P0）

**这是与第一轮审核相同的安全模式**——模块的 HTTP 路由没有 `requireAuth`，`tenant_id` 从 body/query 取，store 层 SQL 不带 `tenant_id` 过滤。受影响模块：

| 模块 | P0 | 问题 |
|---|---|---|
| omnichannel | 3 | webhook 端点零认证 + tenant_id 从 body 取 + Facebook token 在 URL |
| qm | 2 | 全端点无认证 + evaluation IDOR |
| knowledge | 1 | 全路由无认证 + listDocuments/deleteDocument IDOR |
| webhooks | 2 | test 端点跨租户 + update/delete 无租户隔离 |
| wfm | 2 | 表不在 db.ts + scheduler 跨日越界 |
| white-label | 1 | resolveByDomain 泄露 tenant_id + 域名无唯一约束 |
| chatwoot | 2 | routeChatwootApi 死代码 + 硬编码 default 租户 |
| events | 1 | NatsPublisher 全模块死代码 |

## 死代码模块（2 个）

- **chatwoot/**：`routeChatwootApi` 全仓无调用，HTTP 入口永不生效
- **events/**：`NatsPublisher`/`createNatsPublisher` 全仓无引用，实际 NATS 走 `infra/nats-client.ts`
