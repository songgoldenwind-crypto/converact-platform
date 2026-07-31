# OPC AI 通信平台 — 完整架构设计 v3

> **历史实现规格声明（2026-07-31）**：本文保留 Sprint 1–12 和既有代码对照价值；
> 通信、媒体、Channel Agent、HF Speech Runtime、ViLTE 与 AI-native Authority 已由
> [统一通信底座 Revision 5](./unified-communication-foundation-r5.md) 覆盖。冲突处以
> Revision 5 为准。
>
> **版本**: v3.1（按 `docs/design/README.md` 准绳标注现状/目标态差异并补互链）
> **日期**: 2026-06-29
> **状态**: 执行级规格（**可直接编码** caveat：见下方「现状校准」段——§3/§4 的若干"现状"项与 spec 目标态存在差距，已在正文相应位置就地标注 `【现状】`）
> **覆盖范围**: Sprint 1-12 全部架构决策
>
> **关联文档**（见 `docs/design/README.md`）：[修订版总规划](./revised-master-plan.md)（Sprint 6-12 见其各 Sprint 任务表） · [产品设计](./product-design.md) · [安全与合规](./security-design.md) · [指标与可观测](./metrics-design.md) · [战略北极星](./super-contact-center-platform-vision.md) · [Gap 分析](./gap-analysis.md) · [本目录导航与治理](./README.md)
>
> **现状校准（2026-06-29，核查日期=2026-06-29）**：本文 §3 / §4 / §14 等处含写于 2026-06-22 的内嵌「现状校准」笔记（见 L239/L647 等），已较充分。本次仅按 README §4 准绳在头部补总纲，并就地强化两处易被误解为目标态-vs-现实现差：
> - **§4 实时层**：spec 是 WebSocket + Redis PubSub（多实例）；**现状**部分仍为 SSE 单实例（`sse-manager.ts`），`roundRobinCursor`/`pendingDisclosures`/`dialerWaitRegistry` 仍是进程内 Map（见 §4.3 Redis gap 表与 §14 L1377、附录 L1427）
> - **§3 数据库**：spec 是 Postgres Day-1；**现状** SQLite 仍是业务主库（`src/server.ts` 无条件创建），Postgres 仅在设 `DATABASE_URL` 时启用且仅服务 auth/compliance 子集，billing/audit/inbound 仍用 SQLite（见 L1398 / L1425 校准）
> 文档原文已含上述内嵌校准；本次未改写 spec，仅头部汇总提醒读者以"内嵌现状校准 + 本段"为现状真值。

---

## 目录

1. [分层架构](#1-分层架构)
2. [模块边界与依赖图](#2-模块边界与依赖图)
3. [数据库架构](#3-数据库架构)
4. [实时层（WebSocket + Redis PubSub）](#4-实时层)
5. [AI Agent 架构](#5-ai-agent-架构)
6. [合规引擎](#6-合规引擎)
7. [认证与鉴权](#7-认证与鉴权)
8. [呼入/呼出引擎](#8-呼入呼出引擎)
9. [全渠道架构](#9-全渠道架构)
10. [部署拓扑](#10-部署拓扑)
11. [Sprint 1-12 功能规格](#11-sprint-功能规格)
12. [API 总表](#12-api-总表)
13. [事件总表](#13-事件总表)
14. [目录结构规范](#14-目录结构规范)

---

## 1. 分层架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        客户端层 (Client)                         │
│  React SPA · WebRTC (LiveKit SDK) · Web Chat Widget · Mobile   │
└───────────────────────────────┬─────────────────────────────────┘
                                │ HTTP / WebSocket / WebRTC
┌───────────────────────────────▼─────────────────────────────────┐
│                      接入层 (Gateway)                            │
│  OPC Core (Node.js :3000)                                       │
│  ┌─────────┐ ┌──────────┐ ┌───────────┐ ┌─────────────────┐   │
│  │ HTTP API│ │WebSocket │ │ Auth MW   │ │ Rate Limiter    │   │
│  └─────────┘ └──────────┘ └───────────┘ └─────────────────┘   │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      业务层 (Domain)                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ Call Ctr │ │ AI Agent │ │Compliance│ │ Billing/WFM/...  │  │
│  │ (呼入/出) │ │(Py Worker)│ │ (合规门)  │ │  (增值模块)       │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      媒体层 (Media)                              │
│  ┌──────────┐ ┌──────────────┐ ┌────────────┐ ┌─────────────┐ │
│  │ RustPBX  │ │ LiveKit SFU  │ │ SIP Bridge │ │ Egress      │ │
│  │ SBC/ACD  │ │ 音视频房间    │ │ PSTN互通   │ │ 录音/合流   │ │
│  └──────────┘ └──────────────┘ └────────────┘ └─────────────┘ │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      数据层 (Data)                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │PostgreSQL│ │  Redis   │ │  MinIO   │ │  NATS (Sprint11) │  │
│  │ 主数据库  │ │ 缓存/PubSub│ │ 对象存储  │ │  事件总线        │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 分层原则

| 层 | 职责 | 不可做 |
|---|---|---|
| 客户端 | UI 渲染、用户交互、WebRTC 媒体 | 不直接访问数据库 |
| 接入层 | 协议转换、认证、限流、路由 | 不含业务逻辑 |
| 业务层 | 领域逻辑、编排、状态管理 | 不直接操作 SQL（通过 Store） |
| 媒体层 | 音视频处理、SIP 信令、录音 | 不持久化业务数据 |
| 数据层 | 持久化、缓存、消息传递 | 不含业务规则 |

---

## 2. 模块边界与依赖图

```mermaid
graph LR
    subgraph OPC["OPC Core (Node.js)"]
        HTTP[HTTP Router]
        WS[WebSocket Server]
        Auth[Auth Middleware]
        
        subgraph Domain["业务模块"]
            CC[Call Center]
            Compliance[合规引擎]
            QM[质检 QM]
            KB[知识库]
            Billing[计费]
            WFM[WFM 排班]
            Webhooks[Webhook]
            WhiteLabel[白标]
            Omni[全渠道]
            Report[报表]
        end
        
        subgraph Store["数据访问层 (Store)"]
            PgPool[PgPool]
            RedisClient[Redis Client]
        end
    end
    
    HTTP --> Auth --> Domain
    WS --> Auth
    Domain --> Store
    CC --> WS
    CC --> Compliance
```

### 模块间通信规则

| 从 | 到 | 方式 | 示例 |
|---|---|---|---|
| HTTP Handler | Store | 直接调用 | `seatStore.list(tenantId)` |
| HTTP Handler | 业务模块 | 直接调用 | `transferOrchestrator.execute(...)` |
| 业务模块 | WebSocket | `wsBroadcast(tenantId, event, data)` | 来电通知 |
| 业务模块 | AI Agent | LiveKit Agent Dispatch | 创建 room + 派发 |
| AI Agent | OPC | HTTP callback + Redis | tool call 结果写回 |
| OPC | RustPBX | HTTP API / RWI WebSocket | 拨号/路由指令 |
| RustPBX | OPC | HTTP webhook | 来电/CDR 事件 |

---

## 3. 数据库架构

### 3.1 连接管理

```typescript
// src/db-pg.ts
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                    // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export { pool };
export const query = (text: string, params?: unknown[]) => pool.query(text, params);
export const getClient = () => pool.connect();
```

### 3.2 Migration 策略

```
src/migrations/
├── 001_init.sql              # 基础表
├── 002_call_center.sql       # 呼叫中心核心表
├── 003_compliance.sql        # 合规表
├── 004_inbound_acd.sql       # 呼入 ACD
├── 005_agent_tools.sql       # 坐席工具扩展
├── 006_qm_knowledge.sql      # QM + 知识库
├── 007_billing_report.sql    # 计费 + 报表
├── 008_outbound_advanced.sql # 高级外呼
├── 009_omnichannel.sql       # 全渠道
├── 010_platform.sql          # 开放平台
├── 011_audit_gdpr.sql        # 审计 + GDPR
└── 012_ml_features.sql       # ML 预测
```

运行器：启动时按序号顺序执行（幂等，`IF NOT EXISTS`）。

### 3.3 完整 Schema（Sprint 1-3 核心表）

```sql
-- ============== 租户与认证 ==============

CREATE TABLE tenants (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    plan_code   TEXT NOT NULL DEFAULT 'free',
    settings    JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'operator',
    name        TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, email)
);

-- ============== 呼叫中心核心 ==============

CREATE TABLE voice_call_sessions (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    from_number     TEXT,
    to_number       TEXT,
    status          TEXT NOT NULL DEFAULT 'initiated',
    media_type      TEXT NOT NULL DEFAULT 'audio',
    livekit_room_name TEXT,
    livekit_room_sid  TEXT,
    ai_handled      BOOLEAN NOT NULL DEFAULT FALSE,
    transferred     BOOLEAN NOT NULL DEFAULT FALSE,
    transfer_chain  JSONB DEFAULT '[]',
    intent_score    REAL,
    duration_sec    INTEGER,
    disposition     TEXT,
    notes           TEXT,
    tags            JSONB DEFAULT '[]',
    summary         TEXT,
    metadata        JSONB DEFAULT '{}',
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_calls_tenant_created ON voice_call_sessions(tenant_id, created_at DESC);
CREATE INDEX idx_calls_status ON voice_call_sessions(status) WHERE status NOT IN ('completed', 'failed');

CREATE TABLE agent_seats (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    user_id     TEXT REFERENCES users(id),
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'offline'
                CHECK (status IN ('online', 'busy', 'away', 'training', 'break', 'wrap_up', 'offline')),
    skills      JSONB NOT NULL DEFAULT '[]',
    current_call_id TEXT,
    last_heartbeat TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_seats_tenant_status ON agent_seats(tenant_id, status);
-- ⚠️ 枚举一致性校准（2026-06-22）：
-- 上方 CHECK 用 'online' 表示空闲，但代码实际用 'idle'。
-- agent_seats.status 在 5 处定义了 4 套枚举：
--   1. schema.sql:2378     → offline, idle, busy, break (4 态)
--   2. db.ts:921           → offline, idle, busy, break, away, training, lunch, wrap_up (8 态)
--   3. architecture-v3:232 → offline, online, busy, away, training, break, wrap_up (7 态)
--   4. implementation-spec:78 → offline, idle, busy, break (4 态)
-- ACD 路由按 'idle' 过滤（types.ts:95 AGENT_SEAT_AVAILABLE_STATUSES = Set(['idle'])）
-- 目标：统一为 db.ts 的 8 态，'online' 废弃改为 'idle'。待 P1 修复。

CREATE TABLE outbound_tasks (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    spec_id     TEXT,
    campaign_id TEXT,
    phone_numbers JSONB NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'running', 'paused', 'completed', 'cancelled')),
    progress    JSONB NOT NULL DEFAULT '{"total":0,"completed":0,"failed":0}',
    schedule    JSONB,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at  TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
);

CREATE TABLE ai_conversation_turns (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
    role        TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content     TEXT NOT NULL,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_turns_session ON ai_conversation_turns(call_session_id, timestamp);

-- ============== 合规 ==============

CREATE TABLE compliance_dnc_list (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    phone_number TEXT NOT NULL,
    reason      TEXT,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(tenant_id, phone_number)
);

CREATE TABLE compliance_call_log (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    called_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    result      TEXT NOT NULL
);
CREATE INDEX idx_compliance_log_phone_day ON compliance_call_log(tenant_id, phone_number, called_at);

CREATE TABLE compliance_consent (
    id              TEXT PRIMARY KEY,
    call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
    consent_type    TEXT NOT NULL CHECK (consent_type IN ('recording', 'ai_disclosure')),
    status          TEXT NOT NULL CHECK (status IN ('granted', 'denied', 'pending')),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============== 录音 ==============

CREATE TABLE call_recordings (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
    egress_id       TEXT,
    storage_path    TEXT,
    duration_sec    INTEGER,
    file_size_bytes BIGINT,
    status          TEXT NOT NULL DEFAULT 'recording',
    started_at      TIMESTAMPTZ,
    ended_at        TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============== Voice Agent Spec ==============

CREATE TABLE voice_agent_specs (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'zh',
    version     INTEGER NOT NULL DEFAULT 1,
    status      TEXT NOT NULL DEFAULT 'draft',
    system_prompt TEXT,
    greeting    TEXT,
    nodes       JSONB DEFAULT '[]',
    edges       JSONB DEFAULT '[]',
    tools       JSONB DEFAULT '[]',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============== LiveKit Rooms ==============

CREATE TABLE livekit_rooms (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL,
    call_session_id TEXT REFERENCES voice_call_sessions(id),
    room_name       TEXT NOT NULL UNIQUE,
    room_sid        TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============== 计费 ==============

CREATE TABLE tenant_quota_limits (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    max_value   INTEGER NOT NULL,
    current_value INTEGER NOT NULL DEFAULT 0,
    period      TEXT NOT NULL DEFAULT 'monthly',
    UNIQUE(tenant_id, metric, period)
);

CREATE TABLE billing_subscriptions (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id) UNIQUE,
    plan_code   TEXT NOT NULL,
    stripe_subscription_id TEXT,
    status      TEXT NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMPTZ,
    current_period_end   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE billing_usage (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    metric      TEXT NOT NULL,
    quantity    REAL NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_usage_tenant_metric ON billing_usage(tenant_id, metric, recorded_at DESC);
```

### 3.4 Sprint 4+ 扩展表（按需 migration）

```sql
-- Sprint 4: 呼入 ACD
CREATE TABLE call_queues (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    strategy    TEXT NOT NULL DEFAULT 'longest_idle',
    max_wait_sec INTEGER DEFAULT 300,
    max_size    INTEGER DEFAULT 50,
    overflow_target TEXT,
    music_url   TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE queue_members (
    queue_id    TEXT NOT NULL REFERENCES call_queues(id),
    seat_id     TEXT NOT NULL REFERENCES agent_seats(id),
    priority    INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (queue_id, seat_id)
);

CREATE TABLE did_numbers (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT REFERENCES tenants(id),
    number      TEXT NOT NULL UNIQUE,
    label       TEXT,
    route_type  TEXT NOT NULL DEFAULT 'queue',
    route_target TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE queue_entries (
    id          TEXT PRIMARY KEY,
    queue_id    TEXT NOT NULL REFERENCES call_queues(id),
    call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
    position    INTEGER NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0,
    entered_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    answered_at TIMESTAMPTZ,
    abandoned_at TIMESTAMPTZ
);

-- Sprint 5: 坐席工具扩展
CREATE TABLE disposition_codes (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    code        TEXT NOT NULL,
    label       TEXT NOT NULL,
    category    TEXT,
    is_active   BOOLEAN DEFAULT TRUE,
    UNIQUE(tenant_id, code)
);

CREATE TABLE call_dispositions (
    call_session_id TEXT PRIMARY KEY REFERENCES voice_call_sessions(id),
    disposition_code TEXT NOT NULL,
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sprint 6: QM
CREATE TABLE qm_evaluations (
    id              TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES tenants(id),
    call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
    evaluator       TEXT NOT NULL DEFAULT 'llm',
    scores          JSONB NOT NULL DEFAULT '{}',
    violations      JSONB NOT NULL DEFAULT '[]',
    summary         TEXT,
    recommendation  TEXT,
    overall_score   REAL NOT NULL DEFAULT 0,
    status          TEXT NOT NULL DEFAULT 'completed',
    appeal_status   TEXT,
    evaluated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_qm_tenant ON qm_evaluations(tenant_id, evaluated_at DESC);

-- Sprint 6: 知识库
CREATE TABLE knowledge_bases (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE knowledge_documents (
    id          TEXT PRIMARY KEY,
    kb_id       TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    tenant_id   TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    chunks      JSONB DEFAULT '[]',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sprint 7: 报表
CREATE TABLE report_schedules (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    frequency   TEXT NOT NULL,
    recipients  JSONB NOT NULL DEFAULT '[]',
    filters     JSONB DEFAULT '{}',
    is_active   BOOLEAN DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sprint 8: Campaign
CREATE TABLE campaigns (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'progressive',
    spec_id     TEXT REFERENCES voice_agent_specs(id),
    spec_variant_b TEXT,
    status      TEXT NOT NULL DEFAULT 'draft',
    settings    JSONB NOT NULL DEFAULT '{}',
    stats       JSONB NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sprint 9: 全渠道
CREATE TABLE channel_conversations (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    channel     TEXT NOT NULL,
    external_id TEXT,
    contact_id  TEXT,
    assigned_seat_id TEXT REFERENCES agent_seats(id),
    status      TEXT NOT NULL DEFAULT 'open',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE channel_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES channel_conversations(id),
    direction       TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    content         TEXT NOT NULL,
    content_type    TEXT NOT NULL DEFAULT 'text',
    sender          TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sprint 10: Webhook 订阅
CREATE TABLE webhook_subscriptions (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL REFERENCES tenants(id),
    url         TEXT NOT NULL,
    events      JSONB NOT NULL DEFAULT '[]',
    secret      TEXT NOT NULL,
    is_active   BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sprint 11: 审计
CREATE TABLE audit_logs (
    id          TEXT PRIMARY KEY,
    tenant_id   TEXT NOT NULL,
    user_id     TEXT,
    action      TEXT NOT NULL,
    resource    TEXT NOT NULL,
    resource_id TEXT,
    details     JSONB DEFAULT '{}',
    ip_address  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_audit_tenant_time ON audit_logs(tenant_id, created_at DESC);
```

---

## 4. 实时层

### 4.1 WebSocket 服务设计

```typescript
// src/ws.ts — 核心结构
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { verifyToken } from './middleware/auth.js';
import { redis } from './redis.js';

interface WsClient {
  ws: WebSocket;
  tenantId: string;
  userId: string;
  role: string;
}

const clients = new Map<string, Set<WsClient>>();  // tenantId → clients

export function initWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  
  wss.on('connection', async (ws, req) => {
    const token = new URL(req.url!, 'http://x').searchParams.get('token');
    const auth = await verifyToken(token);
    if (!auth) { ws.close(4001, 'unauthorized'); return; }
    
    const client: WsClient = { ws, tenantId: auth.tenantId, userId: auth.userId, role: auth.role };
    addClient(client);
    ws.send(JSON.stringify({ type: 'connected', userId: auth.userId }));
    ws.on('close', () => removeClient(client));
    ws.on('pong', () => { /* heartbeat alive */ });
  });
  
  // 30s heartbeat
  setInterval(() => {
    wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.ping(); });
  }, 30000);
  
  // Redis PubSub — 多实例广播
  const sub = redis.duplicate();
  sub.subscribe('ws:broadcast');
  sub.on('message', (_, msg) => {
    const { tenantId, event, data } = JSON.parse(msg);
    broadcastLocal(tenantId, event, data);
  });
}

export function wsBroadcast(tenantId: string, event: string, data: unknown) {
  // 本实例广播
  broadcastLocal(tenantId, event, data);
  // 多实例 → Redis PubSub
  redis.publish('ws:broadcast', JSON.stringify({ tenantId, event, data }));
}
```

### 4.2 WebSocket 事件协议

| 事件类型 | 方向 | Payload | 触发时机 |
|---------|------|---------|---------|
| `connected` | S→C | `{userId}` | 连接建立 |
| `call.incoming` | S→C | `{callId, from, customerSummary, intentScore}` | 转人工时 |
| `call.answered` | S→C | `{callId, seatId}` | 坐席接听 |
| `call.ended` | S→C | `{callId, duration, disposition}` | 通话结束 |
| `seat.status_changed` | S→C | `{seatId, oldStatus, newStatus}` | 坐席状态变化 |
| `seat.heartbeat_timeout` | S→C | `{seatId}` | 心跳超时 |
| `queue.update` | S→C | `{queueId, waiting, avgWait}` | 队列变化 |
| `qm.alert` | S→C | `{callId, score, violations}` | 质检低分告警 |
| `notification` | S→C | `{title, body, level}` | 通用通知 |
| `assist.suggestion` | S→C | `{callId, suggestion, source}` | 坐席辅助推荐 |

### 4.3 Redis Session Cache 设计

```
Key 结构:
├── session:{callSessionId}     → Hash { state, currentNode, variables, turns }
├── seat:status:{tenantId}      → Hash { seatId → status }
├── compliance:daily:{phone}:{date} → Counter (TTL 24h)
├── queue:waiting:{queueId}     → Sorted Set (score=enterTime, member=callId)
└── ws:broadcast                → PubSub channel
```

**⚠️ 实现状态校准（2026-06-22）**：

| Redis Key / 状态 | 目标用途 | 实现状态 | 差距 |
|---|---|---|---|
| `session:{callSessionId}` | 通话 session cache | ✅ 已实现（`redis-session-cache.ts`） | — |
| `seat:status:{tenantId}` | 坐席状态 Hash | ⚠️ 仍用 DB 查询（`seat-store.ts`） | P1 |
| `compliance:daily:{phone}:{date}` | 频次计数 Counter | ❌ 用 Postgres `COUNT(*)`（`compliance-store.ts:61`） | P1 |
| `queue:waiting:{queueId}` | 排队 Sorted Set | ❌ 用 SQLite `queue_entries` 表 | P2 |
| `ws:broadcast` | PubSub 广播 | ⚠️ SSE 单实例实现（`sse-manager.ts`），未走 Redis PubSub | P1：多实例失效 |
| `roundRobinCursor` | ACD 轮询游标 | ❌ 进程内 `Map`（`acd-engine.ts:8`） | P1：多实例失效 |
| `pendingDisclosures` | AI 披露状态 | ❌ 进程内 `Map`（`disclosure-enforcer.ts:43`） | P1：多实例失效 |
| `dialerWaitRegistry` | 拨号等待 | ❌ 进程内 `Map`（`dialer-wait-registry.ts:6`） | P1：多实例失效 |

> **结论**：Redis session cache 已落地，但 5 处关键运行态仍是进程内 Map/DB 查询，多实例水平扩展会失真。`src/redis.ts` 文件不存在——实际 Redis 客户端在 `src/agent-runtime/call-center/redis-client.ts`（ioredis + `OPC_USE_MEMORY_REDIS=1` 时退回 MemoryRedis）。

**AI Agent 读写时序**:
```
1. OPC 创建 call session → 写 Postgres + 写 Redis session:{id}
2. AI Agent 启动 → Redis GET session:{id} (5ms)
3. AI Agent tool call → Redis SET session:{id} fields (5ms)
4. AI Agent fire-and-forget → HTTP POST /api/.../persist (异步落库 Postgres)
5. 通话结束 → OPC 从 Redis 读最终状态 → 写 Postgres → DEL session:{id}
```

---

## 5. AI Agent 架构

### 5.1 Agent 类型系统

```python
# services/ai-agent-py/agents/base.py
from livekit.agents import Agent, AgentSession, function_tool

class BaseOPCAgent(Agent):
    """所有 OPC Agent 的基类"""
    
    def __init__(self, session_id: str, tenant_id: str, **kwargs):
        self.session_id = session_id
        self.tenant_id = tenant_id
        self.redis = RedisSessionCache(session_id)
        super().__init__(**kwargs)
    
    async def on_session_start(self):
        """从 Redis 加载 session state"""
        self.state = await self.redis.load()
    
    async def on_session_end(self):
        """持久化最终状态到 Postgres（通过 OPC API）"""
        await self.opc.persist_session(self.session_id, self.state)


# services/ai-agent-py/agents/outbound.py
class OutboundVoiceAgent(BaseOPCAgent):
    """AI 外呼坐席"""
    tools = [
        check_compliance,    # S1: 合规检查
        disclosure_complete, # S1: 披露确认
        navigate_flow,       # 存量: 话术导航
        check_intent,        # 存量: 意向检测
        transfer_to_human,   # 存量: 转人工
        schedule_callback,   # 存量: 预约回电
        query_knowledge,     # S6: 知识库查询
        generate_summary,    # S5: 通话摘要
        report_call_outcome, # S8: 回传 campaign 结果
    ]


# services/ai-agent-py/agents/inbound.py  (Sprint 4)
class InboundVoiceAgent(BaseOPCAgent):
    """AI 呼入坐席"""
    tools = [
        route_to_queue,       # 路由到队列
        play_ivr_menu,        # 播放 IVR 菜单
        query_knowledge,      # 知识库
        transfer_to_human,    # 转人工
        lookup_crm_contact,   # CRM 查询
        generate_summary,     # 通话摘要
    ]


# services/ai-agent-py/agents/text.py  (Sprint 9)
class TextChannelAgent(BaseOPCAgent):
    """文字渠道 AI"""
    tools = [
        query_knowledge,
        escalate_to_voice,
        send_template_message,
        sync_to_crm,
    ]
```

### 5.2 Tool 契约规范

每个 tool 必须遵循：

```python
@function_tool
async def tool_name(
    ctx: RunContext,          # LiveKit 提供的上下文
    param1: str,             # 明确类型，不用 **kwargs
    param2: int | None = None,
) -> dict:
    """
    一句话描述功能（LLM 会读这个 docstring）。
    
    Args:
        param1: 参数说明
        param2: 可选参数说明
    """
    # 1. 先操作 Redis（同步返回给 LLM，< 10ms）
    await redis.hset(f"session:{ctx.session_id}", ...)
    
    # 2. 异步通知 OPC（fire-and-forget，不阻塞 LLM）
    asyncio.create_task(opc.notify(...))
    
    # 3. 返回结构化结果
    return {"status": "ok", "data": ...}
```

### 5.3 Room Metadata 协议

AI Agent 从 LiveKit Room metadata 读取配置：

```json
{
  "tenant_id": "t_xxx",
  "call_session_id": "cs_xxx",
  "agent_type": "outbound | inbound | text",
  "spec_id": "spec_xxx",
  "language": "zh",
  "campaign_id": "camp_xxx",
  "variant": "A",
  "tools": ["check_intent", "transfer_to_human", ...],
  "customer": {
    "phone": "+8613800138000",
    "name": "张三",
    "crm_id": "crm_xxx"
  }
}
```

---

## 6. 合规引擎

### 6.1 模块结构

```
src/agent-runtime/call-center/compliance/
├── index.ts                    # 导出
├── compliance-gate.ts          # 外呼前检查（时间/频率/DNC）
├── disclosure-enforcer.ts      # AI 披露强制播放
├── consent-tracker.ts          # 录音同意追踪
└── compliance-store.ts         # DNC + 通话记录持久化
```

### 6.2 Compliance Gate 接口

```typescript
interface ComplianceCheckResult {
  allowed: boolean;
  reason?: 'time_window' | 'frequency_limit' | 'dnc_blocked' | 'tenant_suspended';
  retryAfter?: Date;  // 时间窗口限制时，何时可重试
}

async function checkOutboundCompliance(
  tenantId: string,
  phoneNumber: string,
  timezone?: string,
): Promise<ComplianceCheckResult>;
```

**检查链（严格顺序）**:
1. 租户是否被暂停 → 拒绝
2. 号码是否在 DNC 黑名单 → 永久拒绝
3. 当前是否在合规时间窗口 (09:00-21:00 本地时间) → 延迟
4. 今日是否已拨打 ≥ 3 次 → 今日跳过
5. 全部通过 → 允许拨打

### 6.3 Disclosure Enforcer

```typescript
interface DisclosureConfig {
  audioUrl: string;         // 披露语音文件 URL（MinIO）
  durationMs: number;       // 语音时长（用于计时确认）
  text: string;            // 文字备份
  language: string;
}

// AI Agent 通话开始时的流程:
// 1. Agent 进入 room → 立即播放 disclosure audio
// 2. 等待播放完成（durationMs + 500ms buffer）
// 3. AI Agent 调用 disclosure_complete() tool
// 4. OPC 记录 consent（ai_disclosure: granted）
// 5. 正式开始对话
```

---

## 7. 认证与鉴权

### 7.1 API 设计

```
POST /api/auth/register
  Body: { email, password, name, tenantName }
  Response: { token, user: { id, email, role }, tenant: { id, name, plan } }
  逻辑: 创建 tenant → 创建 user(owner) → 签发 JWT → 初始化配额

POST /api/auth/login
  Body: { email, password }
  Response: { token, user, tenant }
  逻辑: 验证密码 → 签发 JWT (24h TTL)

GET /api/auth/me
  Header: Authorization: Bearer <token>
  Response: { user, tenant, permissions }
```

### 7.2 JWT Payload

```json
{
  "sub": "user_id",
  "tid": "tenant_id",
  "role": "owner",
  "iat": 1719000000,
  "exp": 1719086400
}
```

### 7.3 路由权限矩阵

| 路径模式 | 最低角色 | 说明 |
|---------|---------|------|
| `POST /api/auth/*` | 无（公开） | 注册/登录 |
| `GET /api/call-center/*` | viewer | 只读 |
| `POST /api/call-center/seats/*` | operator | 坐席操作 |
| `POST /api/call-center/outbound-tasks` | operator | 创建任务 |
| `*/settings`, `*/billing` | admin | 管理 |
| `*/tenants`, `*/plans` | owner | 租户设置 |
| `X-API-Key` 系统调用 | system | AI Agent / RustPBX |

---

## 8. 呼入/呼出引擎

### 8.1 呼入流程（Sprint 4）

```mermaid
sequenceDiagram
    participant PSTN as 客户电话
    participant RPX as RustPBX
    participant OPC as OPC Core
    participant Q as 队列引擎
    participant WS as WebSocket
    participant Agent as 坐席

    PSTN->>RPX: SIP INVITE
    RPX->>OPC: POST /api/call-router {from, to, did}
    OPC->>OPC: DID → tenant → 路由规则查找
    
    alt AI IVR 分流
        OPC->>RPX: route_to_livekit (AI InboundAgent)
        Note over RPX: AI 处理来电
    else 直接排队
        OPC->>RPX: route_to_queue {queueId, music}
        OPC->>Q: enqueue(callId, queueId, priority)
        Q->>Q: 找到最佳坐席 (ACD 策略)
        Q->>WS: call.incoming {callId, from, summary}
        WS->>Agent: 来电弹屏
        Agent->>OPC: POST /accept-call {callId}
        OPC->>RPX: bridge(callId, agentSipUri)
    end
```

### 8.2 ACD 路由策略

```typescript
type AcdStrategy = 
  | 'longest_idle'      // 最长空闲时间
  | 'least_calls'       // 今日最少通话
  | 'skill_priority'    // 技能匹配 + 优先级
  | 'round_robin';      // 轮询

interface AcdEngine {
  findBestSeat(
    queueId: string,
    requiredSkills?: string[],
    vipPriority?: number,
  ): Promise<AgentSeat | null>;
}
```

### 8.3 外呼升级（Sprint 8 — 预测拨号）

```typescript
interface PredictiveDialer {
  // 核心参数
  targetAbandonRate: number;    // 目标弃呼率 (默认 3%)
  maxConcurrentDials: number;   // 最大并发拨号
  
  // 自适应算法
  calculateDialLevel(): number; // 根据坐席空闲率动态调整
  onCallAnswered(): void;       // 接通 → 寻找空闲坐席
  onCallAbandoned(): void;      // 弃呼 → 降低拨号速率
  onAgentFree(): void;          // 坐席空闲 → 触发新拨号
}
```

---

## 9. 全渠道架构

### 9.1 ChannelAdapter 接口

```typescript
// src/agent-runtime/channels/channel-adapter.ts
interface ChannelAdapter {
  readonly channelType: 'webchat' | 'whatsapp' | 'sms' | 'email' | 'wechat';
  
  // 接收消息（外部 webhook → OPC）
  handleIncoming(payload: unknown): Promise<IncomingMessage>;
  
  // 发送消息（OPC → 外部）
  sendMessage(conversationId: string, message: OutgoingMessage): Promise<void>;
  
  // 验证 webhook 签名
  verifySignature(headers: Record<string, string>, body: string): boolean;
}

interface IncomingMessage {
  externalId: string;
  channel: string;
  from: string;
  content: string;
  contentType: 'text' | 'image' | 'file' | 'audio';
  metadata?: Record<string, unknown>;
}
```

### 9.2 渠道对接方式

| 渠道 | 接入方式 | Adapter 实现 |
|------|---------|-------------|
| Web Chat | 自建 JS Widget → OPC WS | `webchat-adapter.ts` |
| WhatsApp | WhatsApp Cloud API webhook | `whatsapp-adapter.ts` |
| SMS | Twilio/阿里云 webhook | `sms-adapter.ts` |
| Email | IMAP 轮询 + SMTP 发送 | `email-adapter.ts` (已有基础) |
| 微信 | 公众号消息 webhook | `wechat-adapter.ts` (已有 wecom 基础) |

---

## 10. 部署拓扑

### 10.1 开发环境 (docker-compose)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: opc
      POSTGRES_USER: opc
      POSTGRES_PASSWORD: opc_dev
    volumes: [postgres_data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U opc"]
  
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
  
  minio:
    image: minio/minio
    ports: ["9000:9000", "9001:9001"]
    command: server /data --console-address ":9001"
  
  livekit:
    image: livekit/livekit-server:v1.8
    ports: ["7880:7880"]
    command: --config /etc/livekit.yaml
  
  livekit-sip:
    image: livekit/sip
    ports: ["5061:5061/udp"]
  
  livekit-egress:
    image: livekit/egress
  
  rustpbx:
    image: ghcr.io/restsend/rustpbx
    ports: ["5060:5060/udp", "8080:8080"]
  
  opc:
    build: .
    ports: ["3000:3000"]
    depends_on: [postgres, redis, minio, livekit, rustpbx]
    environment:
      DATABASE_URL: postgres://opc:opc_dev@postgres:5432/opc
      REDIS_URL: redis://redis:6379
      MINIO_ENDPOINT: minio:9000
      # ... LiveKit, RustPBX configs
  
  ai-agent:
    build: ./services/ai-agent-py
    depends_on: [opc, redis, livekit]
    environment:
      OPC_API_URL: http://opc:3000
      REDIS_URL: redis://redis:6379
      LIVEKIT_URL: ws://livekit:7880
```

### 10.2 生产环境拓扑

```
                    ┌─────────────┐
                    │  CDN / LB   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌───▼────┐ ┌────▼────┐
        │  OPC ×3   │ │Frontend│ │ AI Agent│
        │  (K8s Pod)│ │ (Nginx)│ │  ×N     │
        └─────┬─────┘ └────────┘ └────┬────┘
              │                        │
    ┌─────────┼────────────────────────┼─────┐
    │         │        Data Layer      │     │
    │  ┌──────▼──────┐ ┌──────┐ ┌─────▼───┐ │
    │  │ Postgres HA │ │Redis │ │ LiveKit │ │
    │  │ (主+从)     │ │Cluster│ │ Cluster │ │
    │  └─────────────┘ └──────┘ └─────────┘ │
    │         ┌──────┐ ┌──────────┐          │
    │         │MinIO │ │ RustPBX  │          │
    │         │ ×3   │ │   ×2     │          │
    │         └──────┘ └──────────┘          │
    └────────────────────────────────────────┘
```

---

## 11. Sprint 功能规格

### Sprint 1: 地基

**目标**: Postgres + Auth + WebSocket + 合规引擎

**交付清单**:

| 编号 | 任务 | 文件 | 验证标准 |
|------|------|------|---------|
| S1-1 | Postgres 连接池 + migration runner | `src/db-pg.ts`, `src/migrations/001_init.sql` | 启动时自动建表 |
| S1-2 | 用户注册 API | `src/auth-http.ts` | 注册后返回 JWT |
| S1-3 | 用户登录 API | `src/auth-http.ts` | 登录后返回 JWT |
| S1-4 | WebSocket 服务 | `src/ws.ts` | 连接后收到 `connected` |
| S1-5 | 租户广播 | `src/ws.ts` | 同租户所有客户端收到事件 |
| S1-6 | Compliance Gate | `compliance/compliance-gate.ts` | 时间窗/频率/DNC 检查通过 |
| S1-7 | Disclosure Enforcer | `compliance/disclosure-enforcer.ts` | 强制播放测试通过 |
| S1-8 | Consent Tracker | `compliance/consent-tracker.ts` | 同意/拒绝可记录 |
| S1-9 | Docker Compose 更新 | `docker-compose.callcenter.yml` | `docker compose up` 全栈拉起 |
| S1-10 | 现有测试迁移通过 | — | `npm test` 全绿 |

**新增依赖**: `pg`, `ws`

**API 变更**:
```
NEW  POST /api/auth/register
NEW  POST /api/auth/login
NEW  GET  /api/auth/me
NEW  WS   /ws?token=xxx
NEW  POST /api/compliance/check    (内部调用)
NEW  GET  /api/compliance/dnc      (管理接口)
NEW  POST /api/compliance/dnc      (添加黑名单)
```

---

### Sprint 2: 完整 Demo 链路

**目标**: 注册 → 创建话术 → AI 外呼 → 看到结果

**交付清单**:

| 编号 | 任务 | 文件 | 验证标准 |
|------|------|------|---------|
| S2-1 | 租户 Onboarding（自动建 free plan + 种子数据）| `src/auth-http.ts` | 注册后 dashboard 立即可用 |
| S2-2 | Voice Agent Spec 管理前端 | `frontend/src/pages/SpecEditorPage.tsx` | 从模板创建话术 < 2 分钟 |
| S2-3 | 外呼任务 UI | `frontend/src/pages/OutboundTaskPage.tsx` | 上传号码→启动任务 |
| S2-4 | 通话结果实时报告 | 前端 + WebSocket | 通话结束后报告自动刷新 |
| S2-5 | Redis Session Cache | `src/redis.ts` + AI Agent | tool call 延迟 < 50ms |
| S2-6 | 修复 HTTP 模块挂载 | `src/http.ts` | billing/knowledge/wfm/webhooks API 可访问 |
| S2-7 | E2E 测试 | `test/e2e-demo.test.ts` | 注册→创建→拨号→检查结果 |

---

### Sprint 3: 转人工 + 坐席工作台

**目标**: AI 转人工 → 坐席浏览器接听 → 来电弹屏

**交付清单**:

| 编号 | 任务 | 验证标准 |
|------|------|---------|
| S3-1 | TransferOrchestrator WebSocket 化 | 转接延迟 < 3 秒 |
| S3-2 | 坐席 WebRTC 面板 (LiveKit React) | 浏览器接听/挂断 |
| S3-3 | 来电弹屏（客户信息卡片）| 坐席看到摘要+意向分 |
| S3-4 | 坐席状态扩展 (6 种) | 状态联动 WS 广播 |
| S3-5 | 桌面推送通知 | Notification API |
| S3-6 | 点击拨号 | 通话记录一键拨号 |
| S3-7 | Egress 录音自动化 | 通话自动录音到 MinIO |
| S3-8 | 选择性录音（按规则启停）| 合规录音控制 |

---

### Sprint 4: 呼入 ACD

**目标**: 来电 → IVR → 排队 → ACD → 坐席接听

> **⚠️ IVR 实现状态校准（2026-06-22）**：
> 运行时 IVR 菜单当前硬编码（`agent-tools/ivr-menu.ts:16` `DEFAULT_MENUS`，仅一个"销售/客服/语音信箱"三分支菜单）。
> `ivr/ivr-marketplace-store.ts` 提供了 marketplace 层的可配置组件安装，但运行时 `getIvrMenu` 仍只返回硬编码默认值。
> DB 持久化的租户级 IVR 菜单待实现（P1）。

**新文件**:
```
src/agent-runtime/call-center/inbound/
├── inbound-router.ts      # DID → tenant → 路由
├── acd-engine.ts          # ACD 策略引擎
├── call-queue.ts          # 队列管理
├── queue-callback.ts      # 队列回呼
├── did-store.ts           # DID 号码管理
└── auto-attendant.ts      # 自动话务员
```

---

### Sprint 5: 坐席全工具 + 主管

**新文件**:
```
src/agent-runtime/call-center/agent-tools/
├── call-hold.ts           # 保持/恢复
├── call-transfer.ts       # 盲转/协商转
├── conference.ts          # 三方会议
├── park-pickup.ts         # 驻留/拾取
├── supervisor.ts          # 监听/强插/耳语
├── wallboard.ts           # 实时大屏数据
├── disposition.ts         # 处置码管理
├── voicemail.ts           # 语音信箱
├── voicemail-transcribe.ts # 语音信箱转写
#   ⚠️ voicemail-transcribe 实现状态校准（2026-06-22）：
#   ASR 主路径（Whisper API HTTP 调用）已实现 ✅
#   LLM fallback 是伪实现 ❌ — 把录音 URL 字符串发给文本 LLM（DeepSeek），
#   文本模型无法解析音频，产出的是臆造内容。需移除或替换为真实 ASR（P1）
├── agent-script.ts        # 通话脚本引导
└── auto-summary.ts        # LLM 通话摘要
```

---

### Sprint 6-12: 参见 revised-master-plan.md 各 Sprint 任务表

（功能规格同结构：模块路径 + API + 验证标准）

---

## 12. API 总表

### 12.1 认证

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| POST | `/api/auth/register` | 公开 | S1 |
| POST | `/api/auth/login` | 公开 | S1 |
| GET | `/api/auth/me` | Bearer | S1 |
| POST | `/api/auth/refresh` | Bearer | S2 |

### 12.2 呼叫中心

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET | `/api/call-center/dashboard` | viewer | 存量 |
| GET/POST | `/api/call-center/seats` | operator | 存量 |
| PUT | `/api/call-center/seats/:id/status` | operator | 存量 |
| GET/POST | `/api/call-center/outbound-tasks` | operator | 存量 |
| POST | `/api/call-center/outbound-tasks/:id/start` | operator | S2 |
| GET | `/api/call-center/calls` | viewer | 存量 |
| GET | `/api/call-center/calls/:id` | viewer | 存量 |
| POST | `/api/call-center/calls/:id/hold` | operator | S5 |
| POST | `/api/call-center/calls/:id/transfer` | operator | S5 |
| POST | `/api/call-center/calls/:id/conference` | operator | S5 |

### 12.3 呼入

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET/POST | `/api/call-center/queues` | admin | S4 |
| GET | `/api/call-center/queues/:id/status` | viewer | S4 |
| GET/POST | `/api/call-center/did-numbers` | admin | S4 |
| POST | `/api/call-router` | system (RustPBX) | 存量 |

### 12.4 合规

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| POST | `/api/compliance/check` | system | S1 |
| GET/POST | `/api/compliance/dnc` | admin | S1 |
| DELETE | `/api/compliance/dnc/:id` | admin | S1 |

### 12.5 QM

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET | `/api/qm/evaluations` | viewer | 存量 |
| POST | `/api/qm/evaluations/:id/appeal` | operator | S6 |
| POST | `/api/qm/manual-evaluate` | admin | S6 |

### 12.6 知识库

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET/POST | `/api/knowledge/bases` | admin | 存量 |
| POST | `/api/knowledge/bases/:id/documents` | admin | 存量 |
| POST | `/api/knowledge/search` | operator | 存量 |

### 12.7 计费

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| POST | `/api/billing/checkout` | admin | 存量 |
| GET | `/api/billing/subscription` | admin | 存量 |
| GET | `/api/billing/usage` | admin | 存量 |
| POST | `/api/billing/webhooks/stripe` | 公开(签名验证) | 存量 |

### 12.8 全渠道 (Sprint 9)

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET | `/api/channels/conversations` | operator | S9 |
| GET | `/api/channels/conversations/:id/messages` | operator | S9 |
| POST | `/api/channels/conversations/:id/send` | operator | S9 |
| POST | `/api/channels/webhooks/:channel` | 公开(签名验证) | S9 |

### 12.9 报表 (Sprint 7)

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET | `/api/reports/calls` | viewer | S7 |
| GET | `/api/reports/agents` | viewer | S7 |
| GET | `/api/reports/sla` | viewer | S7 |
| GET | `/api/reports/export` | admin | S7 |
| POST | `/api/reports/schedules` | admin | S7 |

### 12.10 开放平台 (Sprint 10)

| Method | Path | Auth | Sprint |
|--------|------|------|--------|
| GET/POST | `/api/webhooks/subscriptions` | admin | 存量 |
| GET/PUT | `/api/settings/white-label` | owner | 存量 |
| GET | `/api/docs` | 公开 | S10 |

---

## 13. 事件总表

### 13.1 WebSocket 事件

| 事件 | 数据 | 接收方 | Sprint |
|------|------|--------|--------|
| `connected` | `{userId}` | 连接者 | S1 |
| `call.incoming` | `{callId, from, summary, intentScore}` | 可用坐席 | S3 |
| `call.answered` | `{callId, seatId}` | 全租户 | S3 |
| `call.ended` | `{callId, duration, disposition}` | 全租户 | S3 |
| `call.on_hold` | `{callId, seatId}` | 全租户 | S5 |
| `seat.status_changed` | `{seatId, old, new}` | 全租户 | S1 |
| `queue.update` | `{queueId, waiting, avgWait}` | 全租户 | S4 |
| `qm.alert` | `{callId, score, violations}` | admin | S6 |
| `assist.suggestion` | `{callId, text, source}` | 当前坐席 | S6 |
| `notification` | `{title, body, level, action}` | 指定用户 | S2 |
| `task.progress` | `{taskId, completed, total}` | 创建者 | S2 |

### 13.2 Webhook 外部事件

| 事件 | 触发 | Sprint |
|------|------|--------|
| `call.started` | 通话开始 | S10 |
| `call.completed` | 通话结束 | S10 |
| `call.transferred` | 转接发生 | S10 |
| `qm.evaluation_completed` | QM 评分完成 | S10 |
| `campaign.completed` | Campaign 结束 | S10 |

### 13.3 NATS 内部事件 (Sprint 11)

| Subject | 数据 | 消费者 |
|---------|------|--------|
| `opc.call.ended` | call session 全量 | QM Worker, Analytics |
| `opc.qm.scored` | evaluation result | Notification, Webhook |
| `opc.seat.timeout` | seat info | ACD Engine |

---

## 14. 目录结构规范

### 14.1 最终目标结构

```
opc/
├── docs/design/               # 设计文档
├── frontend/                  # React SPA
│   └── src/
│       ├── api/              # API Client + hooks
│       ├── components/       # 通用组件
│       ├── layouts/          # 布局
│       └── pages/            # 页面（按路由）
├── infra/                    # 部署配置
├── sdk/javascript/           # JS SDK
├── services/
│   └── ai-agent-py/         # Python AI Agent
│       ├── agents/           # Agent 类型定义 (NEW)
│       ├── plugins/          # STT/TTS/LLM 插件
│       ├── tools/            # function_tool 定义
│       └── tests/
├── src/                      # OPC Core (Node.js)
│   ├── migrations/           # SQL migrations (NEW)
│   ├── middleware/           # auth, rate-limit
│   ├── agent-runtime/
│   │   └── call-center/      # 18 子模块（校准 2026-06-22）
│   │       ├── agent-panel/  # 坐席面板 SSE + 转接队列 (Phase 3)
│   │       ├── agent-tools/  # 坐席工具集 16 文件 (hold/transfer/conference/supervisor/voicemail/...)
│   │       ├── analytics/    # 仪表盘 + 意图预测 + 屏幕录制 + 批量分析
│   │       ├── billing/      # 计费 Stripe SDK + 订阅/用量/配额
│   │       ├── chatwoot/     # Chatwoot 集成 (消息/Webhook/自动回复)
│   │       ├── compliance/   # 合规引擎 (DNC/时间窗/披露/同意/审计/保留/NATS)
│   │       ├── data/         # 数据文件 (默认外呼 AI Agent 模板 JSON)
│   │       ├── dialer/       # 外呼活动管理 (campaign/predictive/post-call-survey)
│   │       ├── events/       # NATS 事件发布 (可选)
│   │       ├── inbound/      # 呼入 ACD 引擎 (ACD/队列/DID/自动话务员/呼入路由)
│   │       ├── ivr/          # IVR 组件市场
│   │       ├── knowledge/    # 知识库 + LLM 检索 + 座席实时辅助
│   │       ├── omnichannel/  # 全渠道 6 通道 (web_chat/sms/email/wechat/whatsapp/facebook)
│   │       ├── qm/           # 质检 (LLM 5 维评分 + 自动评估 + 告警)
│   │       ├── routing/      # 启发式多因子加权路由
│   │       ├── webhooks/     # Webhook 基础设施 (订阅/签名/投递/重试)
│   │       ├── wfm/          # 劳动力管理 (预测/排班/遵守度)
│   │       └── white-label/  # 白标 (品牌配置/邮件模板)
│   ├── auth-http.ts          # 认证路由
│   ├── call-center-http.ts   # 呼叫中心路由
│   ├── db-pg.ts              # Postgres 连接 (可选，设 DATABASE_URL 时启用)
│   ├── db.ts                 # SQLite 主库 (当前业务主库，目标迁移到 Postgres)
│   ├── redis-session-cache.ts # Redis 通话 session cache
│   ├── http.ts               # 主 HTTP 入口
│   └── server.ts             # 启动入口
├── test/                     # 测试
├── docker-compose.callcenter.yml
├── package.json
└── tsconfig.json
```

### 14.2 命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| Store 文件 | `{entity}-store.ts` | `seat-store.ts` |
| HTTP 路由 | `{domain}-http.ts` | `call-center-http.ts` |
| 类型定义 | `{domain}/types.ts` | `inbound/types.ts` |
| Migration | `{NNN}_{description}.sql` | `004_inbound_acd.sql` |
| 测试 | `{module}.test.ts` | `acd-engine.test.ts` |
| AI Agent Tool | `tools/{action}.py` | `tools/route_to_queue.py` |

---

## 附录：与旧 technical-design.md 的差异

| 维度 | 旧版 (v2) | 本版 (v3) |
|------|-----------|-----------|
| 数据库 | SQLite + 未来 Postgres | **Postgres Day 1**, SQLite 仅 unit test | ⚠️ **现状校准**：SQLite 仍是业务主库（`src/server.ts:11` 无条件创建），Postgres 仅在设 `DATABASE_URL` 时启用且仅服务 auth/compliance 子集。billing/audit/inbound 仍用 SQLite。 |
| API Gateway | Kong | **去掉**, OPC 自带 | ✅ 已落地（`src/middleware/auth.ts`） |
| 实时通知 | 无 | **WebSocket + Redis PubSub** | ⚠️ SSE 已实现（`sse-manager.ts`），Redis PubSub 部分实现（session cache 已用 Redis，roundRobinCursor/pendingDisclosures/dialerWaitRegistry 仍是进程内 Map） |
| 认证 | Keycloak | **自签 JWT + bcrypt** | ✅ 已落地（`src/middleware/auth.ts`） |
| AI Agent 状态 | HTTP 每次查 DB | **Redis cache + 异步落库** | ⚠️ session cache 已用 Redis（`redis-session-cache.ts`），异步落库部分实现 |
| 呼入能力 | 未规划 | **ACD + 队列 + IVR** | ✅ 已落地（`inbound/` 8 文件） |
| 坐席工具 | 3 种状态 | **14 项 + 8 项主管** | ✅ 已落地（`agent-tools/` 16 文件） |
| 全渠道 | 【已废】Chatwoot | **ChannelAdapter 自建** | ✅ 已落地（`omnichannel/` 8 文件，6 渠道） |
| 合规 | 无 | **合规引擎 Day 1** | ⚠️ 骨架已落地（`compliance/` 10 文件），但 disclosure-enforcer 未接入拨号路径（P0 已修，commit a4b1ef5）、双库割裂（audit 在 SQLite、DNC 在 Postgres） |
| Sprint 规划 | 按技术模块 | **按商业里程碑** | ✅ 已落地 |

---

## 变更记录

| 版本 | 日期 | 作者 | 变更内容 |
|------|------|------|---------|
| v3.0 | 2026-06-21 | - | 初始完整架构 v3（Sprint 1-12 规格全决策，含 2026-06-22 内嵌现状校准笔记） |
| v3.1 | 2026-06-29 | OPC Team | 按 `docs/design/README.md` §4 准绳：(1) 头部加 `<关联文档>` block 与「现状校准」总纲段，强化 §4 SSE-vs-WS / §3 SQLite-vs-Postgres 的现状-vs-spec 差异提醒（正文已有内嵌校准 L239/L647/L1398/L1425 等，未改写 spec）；(2) 附录「全渠道」行 Chatwoot 加 `【已废】` 前缀；(3) 状态从「可直接编码」加 caveat 指向现状校准段。未改 §1-§13 任何目标态规格与内嵌现状笔记。 |
