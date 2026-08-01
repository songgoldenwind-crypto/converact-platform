# Phase 4 — 生产级加固 · 细节设计

> **目标**：全链路可观测、合规录音、故障恢复、多实例水平扩展、负载验证。
> **依赖**：Phase 3 人工坐席面板完整交付。

---

## 0. 验收清单

| # | 项 | 验证方式 | 预期 |
|---|---|---|---|
| 1 | Grafana 大盘可访问 | 浏览器打开 | 显示全部面板 |
| 2 | 通话指标实时更新 | 发起通话后观察 | 延迟 < 5s 出现 |
| 3 | 报警规则触发 | 模拟错误率 > 5% | 收到通知 |
| 4 | 录音合规审计 | 导出录音列表 | 所有通话有录音 |
| 5 | Converact Platform 双实例部署 | docker compose scale converact=2 | 无冲突正常运行 |
| 6 | Converact Platform 实例宕机恢复 | kill 一个实例 | 另一个接管，通话不中断 |
| 7 | 50 并发通话 | 负载测试脚本 | P95 延迟 < 500ms |
| 8 | DB 备份/恢复 | 执行备份 → 恢复 | 数据完整 |
| 9 | 安全审计通过 | checklist 验证 | 全部 pass |
| 10 | 文档齐全 | 运维手册审查 | 覆盖所有场景 |

---

## 1. 可观测性

### 1.1 指标体系

#### 1.1.1 业务指标 (Converact Platform 暴露)

```typescript
// src/agent-runtime/call-center/metrics.ts

interface CallCenterMetrics {
  // 计数器
  outbound_calls_total: Counter;           // labels: tenant_id, channel, status
  inbound_calls_total: Counter;            // labels: tenant_id, status
  transfers_total: Counter;                // labels: tenant_id, type, success
  ai_turns_total: Counter;                 // labels: tenant_id, role

  // 直方图
  call_duration_seconds: Histogram;        // labels: tenant_id, media_type
  transfer_wait_seconds: Histogram;        // labels: tenant_id
  ai_response_latency_ms: Histogram;       // labels: tenant_id, step (stt/llm/tts)

  // 仪表
  active_calls: Gauge;                     // labels: tenant_id
  queue_depth: Gauge;                      // labels: tenant_id
  seats_online: Gauge;                     // labels: tenant_id, status
  dialer_active: Gauge;                    // labels: tenant_id
}
```

#### 1.1.2 系统指标

| 来源 | 指标 | 说明 |
|---|---|---|
| Converact Platform Node.js | `process_cpu_seconds_total` | CPU |
| Converact Platform Node.js | `process_resident_memory_bytes` | 内存 |
| Converact Platform Node.js | `http_request_duration_seconds` | HTTP 延迟 |
| RustPBX | `/metrics` | SIP 并发/重传/延迟 |
| LiveKit | `/metrics` | Room数/参与者/带宽 |
| Redis | redis_exporter | 命中率/内存/连接 |
| MinIO | minio 内置 metrics | 存储使用/请求 |

### 1.2 指标暴露端点

```typescript
// Converact Platform Prometheus endpoint
// GET /metrics → Prometheus text format

import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

// 注册业务指标
const outboundCallsTotal = new Counter({
  name: 'callcenter_outbound_calls_total',
  help: 'Total outbound calls',
  labelNames: ['tenant_id', 'channel', 'status'],
  registers: [registry],
});

// 在 http.ts 中暴露
if (path === '/metrics') {
  const metrics = await registry.metrics();
  return { status: 200, body: metrics, contentType: 'text/plain' };
}
```

### 1.3 Grafana Dashboard

```
services/monitoring/
├── docker-compose.monitoring.yml
├── prometheus/
│   └── prometheus.yml
├── grafana/
│   ├── provisioning/
│   │   ├── datasources/
│   │   │   └── prometheus.yml
│   │   └── dashboards/
│   │       └── callcenter.json
│   └── dashboards/
│       ├── overview.json        # 总览大盘
│       ├── calls.json           # 通话详情
│       ├── ai-agent.json        # AI Agent 性能
│       └── infrastructure.json  # 基础设施
└── alertmanager/
    └── alertmanager.yml
```

### 1.4 总览大盘面板

```
┌─────────────────────────────────────────────────────────────────┐
│ Call Center Overview                              [Last 1 hour] │
├─────────────┬─────────────┬──────────────┬─────────────────────┤
│ Active Calls│ Queue Depth │ Online Seats │ Outbound Success %  │
│     12      │      3      │     8/10     │       87.3%         │
├─────────────┴─────────────┴──────────────┴─────────────────────┤
│ [Call Volume Over Time - line chart]                             │
│                                                                  │
├──────────────────────────────┬───────────────────────────────────┤
│ [Call Duration Distribution] │ [AI Response Latency P50/P95/P99] │
│ [histogram]                  │ [line chart]                       │
├──────────────────────────────┴───────────────────────────────────┤
│ [Transfer Wait Time] │ [Seat Utilization %] │ [Error Rate]       │
└──────────────────────────────────────────────────────────────────┘
```

### 1.5 报警规则

```yaml
# prometheus/alert_rules.yml
groups:
  - name: callcenter
    rules:
      - alert: HighErrorRate
        expr: rate(callcenter_outbound_calls_total{status="error"}[5m]) / rate(callcenter_outbound_calls_total[5m]) > 0.05
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "外呼错误率超过 5%"

      - alert: QueueTooDeep
        expr: callcenter_queue_depth > 10
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "等待队列深度超过 10"

      - alert: AIResponseSlow
        expr: histogram_quantile(0.95, callcenter_ai_response_latency_ms) > 3000
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "AI 响应 P95 超过 3s"

      - alert: NoOnlineSeats
        expr: callcenter_seats_online{status="idle"} == 0 and callcenter_queue_depth > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "有排队通话但无空闲坐席"

      - alert: LiveKitDown
        expr: up{job="livekit"} == 0
        for: 30s
        labels:
          severity: critical
        annotations:
          summary: "LiveKit 服务不可达"
```

---

## 2. 合规与录音

### 2.1 录音策略

| 场景 | 录音方式 | 保留期 |
|---|---|---|
| 所有外呼 | 自动 (Egress) | 180 天 |
| 转接后人工通话 | 自动 (Egress 持续) | 180 天 |
| AI 对话文本 | ai_conversation_turns | 365 天 |
| 通话元数据 | voice_call_sessions | 永久 |

### 2.2 录音完整性校验

```typescript
// 每日定时任务: 检查所有 completed 的 session 是否有录音
async function auditRecordings() {
  const unrecorded = db.all(`
    SELECT vcs.id, vcs.tenant_id, vcs.started_at
    FROM voice_call_sessions vcs
    LEFT JOIN call_recordings cr ON cr.call_session_id = vcs.id
    WHERE vcs.status = 'completed'
      AND vcs.started_at > datetime('now', '-1 day')
      AND cr.id IS NULL
  `);

  if (unrecorded.length > 0) {
    alertManager.fire('missing_recordings', {
      count: unrecorded.length,
      sessions: unrecorded.map(s => s.id),
    });
  }
}
```

### 2.3 数据保留策略

```typescript
// 定时清理 (每日凌晨)
async function enforceRetention() {
  // 录音文件: 180 天
  const expiredRecordings = db.all(`
    SELECT * FROM call_recordings
    WHERE created_at < datetime('now', '-180 days')
  `);
  for (const rec of expiredRecordings) {
    await minio.removeObject('recordings', rec.storage_url);
    db.run('DELETE FROM call_recordings WHERE id = ?', rec.id);
  }

  // 对话文本: 365 天
  db.run(`
    DELETE FROM ai_conversation_turns
    WHERE created_at < datetime('now', '-365 days')
  `);
}
```

### 2.4 录音导出 API

```typescript
// GET /api/call-center/compliance/recordings
// Query: from, to, tenant_id, has_video
// Response: CSV 或 JSON 格式的录音元数据列表

interface ComplianceRecordingExport {
  session_id: string;
  tenant_id: string;
  started_at: string;
  duration_ms: number;
  recording_url: string;  // pre-signed
  has_video: boolean;
  participants: string[];
}
```

---

## 3. 多实例水平扩展

### 3.1 无状态化改造

Converact Platform 当前状态：
- SQLite → 单实例限制
- 内存中的 SSE 连接 → 单实例
- Dialer 定时器 → 可能重复执行

**Phase 4 方案**：

| 组件 | 改造 | 说明 |
|---|---|---|
| 数据库 | SQLite → PostgreSQL | 支持并发写入 |
| SSE | Redis Pub/Sub 分发 | 任意实例都能推送 |
| Dialer Lock | Redis 分布式锁 (已有) | 无需改造 |
| 会话亲和 | 不需要 | API 无状态 |

### 3.2 PostgreSQL 迁移

```sql
-- 迁移脚本：SQLite → PostgreSQL
-- 类型映射：
--   TEXT → TEXT
--   INTEGER → INTEGER / BIGINT
--   REAL → DOUBLE PRECISION
--   datetime('now') → NOW()
--   json() → jsonb

-- 索引保持不变
-- 增加 connection pooling (pg-pool, max 20)
```

### 3.3 Redis Pub/Sub SSE 分发

```typescript
// src/agent-runtime/call-center/sse-manager-distributed.ts
import { Redis } from 'ioredis';

class DistributedSSEManager {
  private localClients = new Map<string, SSEClient>();
  private pub: Redis;
  private sub: Redis;

  constructor() {
    this.pub = new Redis(process.env.REDIS_URL!);
    this.sub = new Redis(process.env.REDIS_URL!);
    this.sub.subscribe('sse:events');
    this.sub.on('message', (channel, message) => {
      const { seatId, event, data } = JSON.parse(message);
      this.deliverLocal(seatId, event, data);
    });
  }

  send(seatId: string, event: string, data: unknown): void {
    // 发布到 Redis → 所有实例都会收到
    this.pub.publish('sse:events', JSON.stringify({ seatId, event, data }));
  }

  private deliverLocal(seatId: string, event: string, data: unknown): void {
    const client = this.localClients.get(seatId);
    if (client) {
      client.response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  }
}
```

### 3.4 部署拓扑

```
                    ┌───────────────┐
                    │  Load Balancer│
                    │ (nginx/traefik)│
                    └───────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Converact Platform #1  │ │  Converact Platform #2  │ │  Converact Platform #3  │
        └────┬─────┘ └────┬─────┘ └────┬─────┘
             │             │             │
             └─────────────┼─────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │PostgreSQL│ │  Redis   │ │  MinIO   │
        └──────────┘ └──────────┘ └──────────┘
```

### 3.5 Health Check

```typescript
// GET /health
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime_seconds: number;
  checks: {
    database: 'ok' | 'error';
    redis: 'ok' | 'error';
    livekit: 'ok' | 'error';
    rustpbx_rwi: 'ok' | 'error';
  };
}
```

---

## 4. 故障恢复

### 4.1 故障场景与恢复策略

| 故障 | 检测 | 自动恢复 | 手动恢复 |
|---|---|---|---|
| Converact Platform 实例宕机 | health check 失败 | LB 剔除, 其他实例接管 | 重启 |
| Redis 宕机 | 连接错误 | 回退到 SQLite 锁 | 重启 Redis |
| LiveKit 宕机 | webhook 超时 | 所有通话标记中断 | 重启 LiveKit |
| RustPBX 宕机 | RWI 断连 | 暂停外呼, 重连 | 重启 RustPBX |
| PostgreSQL 宕机 | 查询失败 | 只读模式 | 恢复 DB |
| MinIO 宕机 | 上传失败 | 录音暂存本地 | 重启后补传 |

### 4.2 Circuit Breaker

```typescript
// src/agent-runtime/call-center/circuit-breaker.ts
class CircuitBreaker {
  private failures = 0;
  private lastFailure = 0;
  private state: 'closed' | 'open' | 'half_open' = 'closed';

  constructor(
    private threshold: number = 5,
    private resetTimeout: number = 30_000,
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailure > this.resetTimeout) {
        this.state = 'half_open';
      } else {
        throw new Error('Circuit breaker is open');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailure = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }
}

// 使用:
const rwiBreaker = new CircuitBreaker(3, 10_000);
const livekitBreaker = new CircuitBreaker(5, 30_000);
```

### 4.3 优雅降级

```typescript
// 当 LiveKit 不可用时:
// - 语音外呼: 退化为纯 RustPBX 录音 (无 AI, 播放预录消息)
// - 视频外呼: 禁用, 返回服务暂不可用
// - 坐席面板: 仅显示历史数据, 不能接新电话

// 当 RustPBX 不可用时:
// - 外呼: 全部暂停
// - 已有通话: 不受影响 (LiveKit Room 独立)
// - 视频链接通话: 不受影响 (不经过 PSTN)
```

---

## 5. 负载测试

### 5.1 测试工具

```
services/load-test/
├── k6/
│   ├── scenarios/
│   │   ├── outbound-voice.js     # 语音外呼并发
│   │   ├── outbound-video.js     # 视频外呼并发
│   │   ├── inbound-mixed.js      # 混合入站
│   │   └── transfer-storm.js     # 转接风暴
│   └── config.json
├── sipp/
│   ├── scenarios/
│   │   ├── uac_answer.xml        # 模拟被叫接听
│   │   ├── uac_no_answer.xml     # 模拟不接
│   │   └── uac_busy.xml          # 模拟忙
│   └── run.sh
└── README.md
```

### 5.2 K6 场景: 50 并发语音外呼

```javascript
// k6/scenarios/outbound-voice.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    outbound_voice: {
      executor: 'constant-arrival-rate',
      rate: 10,              // 每秒 10 个新任务
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 50,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

export default function () {
  const res = http.post(`${__ENV.CONVERACT_URL}/api/call-center/tasks`, JSON.stringify({
    phone_number: `+8190${Math.floor(Math.random() * 90000000 + 10000000)}`,
    channel: 'pstn_voice',
    strategy: { script_id: 'load-test', language: 'ja' },
    tenant_id: 'load-test-tenant',
  }), {
    headers: { 'Content-Type': 'application/json', 'X-API-Key': __ENV.API_KEY },
  });

  check(res, {
    'task created': (r) => r.status === 201,
  });

  sleep(1);
}
```

### 5.3 性能目标

| 指标 | 目标 | 降级阈值 |
|---|---|---|
| API 响应 P95 | < 200ms | > 500ms |
| 外呼发起延迟 | < 3s (创建到振铃) | > 10s |
| AI 首字延迟 | < 1.5s | > 3s |
| 转接等待 (有坐席时) | < 5s | > 15s |
| 系统支持并发通话 | 50 | - |
| 单 Converact Platform 实例并发连接 | 200 | > 500 |

### 5.4 瓶颈定位

```
预期瓶颈 (按优先级):
1. SQLite 写锁 → Phase 4 迁移到 PostgreSQL 解决
2. AI Agent Python GIL → 多进程 worker (LiveKit Agents 原生支持)
3. LiveKit 单节点带宽 → 多节点 + redis routing
4. RustPBX 媒体端口范围 → 扩大 RTP port range
```

---

## 6. 安全加固

### 6.1 安全 Checklist

| # | 项 | 状态 | 措施 |
|---|---|---|---|
| 1 | API 认证 | Phase 3 | JWT + API Key |
| 2 | Webhook 签名验证 | Phase 0 | HMAC-SHA256 |
| 3 | LiveKit Token 短 TTL | Phase 0 | 5min TTL |
| 4 | HTTPS 全链路 | Phase 4 | TLS 证书 |
| 5 | 数据库加密 | Phase 4 | PostgreSQL TDE |
| 6 | 录音加密存储 | Phase 4 | MinIO SSE-S3 |
| 7 | PII 脱敏日志 | Phase 4 | 电话号码脱敏 |
| 8 | Rate Limiting | Phase 4 | Redis + sliding window |
| 9 | CORS 配置 | Phase 3 | 仅允许坐席面板域名 |
| 10 | 依赖审计 | Phase 4 | npm audit |

### 6.2 Rate Limiting

```typescript
// src/agent-runtime/call-center/rate-limiter.ts
class SlidingWindowRateLimiter {
  constructor(
    private redis: Redis,
    private windowMs: number = 60_000,
    private maxRequests: number = 100,
  ) {}

  async check(key: string): Promise<boolean> {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const redisKey = `ratelimit:${key}`;

    const pipe = this.redis.pipeline();
    pipe.zremrangebyscore(redisKey, 0, windowStart);
    pipe.zadd(redisKey, now, `${now}-${Math.random()}`);
    pipe.zcard(redisKey);
    pipe.expire(redisKey, Math.ceil(this.windowMs / 1000));

    const results = await pipe.exec();
    const count = results![2][1] as number;
    return count <= this.maxRequests;
  }
}
```

### 6.3 PII 脱敏

```typescript
function maskPhone(phone: string): string {
  if (phone.length <= 4) return '****';
  return phone.slice(0, -4).replace(/\d/g, '*') + phone.slice(-4);
}

// 日志输出: +81-90-****-5678
```

---

## 7. 数据库备份

### 7.1 PostgreSQL 自动备份

```yaml
# docker-compose.monitoring.yml (追加)
  pg-backup:
    image: prodrigestivill/postgres-backup-local
    environment:
      - POSTGRES_HOST=postgres
      - POSTGRES_DB=opc
      - POSTGRES_USER=opc
      - POSTGRES_PASSWORD=${PG_PASSWORD}
      - SCHEDULE=@daily
      - BACKUP_KEEP_DAYS=30
      - BACKUP_KEEP_WEEKS=4
      - BACKUP_KEEP_MONTHS=6
    volumes:
      - ./backups:/backups
    depends_on:
      - postgres
```

### 7.2 恢复流程

```bash
# 1. 停止 Converact Platform
docker compose stop converact

# 2. 恢复备份
docker exec -i postgres psql -U converact converact < /backups/daily/converact-2026-06-15.sql

# 3. 验证
docker exec postgres psql -U converact converact -c "SELECT count(*) FROM voice_call_sessions;"

# 4. 重启 Converact Platform
docker compose start converact
```

---

## 8. 运维手册

### 8.1 日常运维

```markdown
## 每日检查
- [ ] Grafana 大盘无红色告警
- [ ] 录音审计通过 (无缺失)
- [ ] 磁盘使用 < 80%
- [ ] 备份成功

## 故障排查
- Converact Platform 500 错误 → 查 /var/log/converact/error.log → 定位模块
- 通话无声 → 检查 RustPBX 媒体端口 → LiveKit Room 状态
- 坐席掉线 → 检查心跳日志 → 网络状况
- AI 不说话 → 检查 AI Agent 容器日志 → STT/TTS API 状态

## 扩容
- 通话量增加 → scale Converact Platform instances
- 录音存储不足 → 扩展 MinIO 节点
- AI 并发不足 → 增加 AI Agent worker 数
```

### 8.2 版本发布流程

```
1. 创建 release branch
2. 运行全量测试 (npm test + e2e)
3. 构建 Docker 镜像 (tag: v{version})
4. staging 环境部署 + 验证
5. 灰度发布 (1/3 实例)
6. 观察 30 分钟
7. 全量发布
8. 发布后监控 2 小时
```

---

## 9. Docker Compose 完整 (Phase 4)

```yaml
# docker-compose.production.yml (示意，实际用 K8s 或 ECS)
services:
  converact-1:
    image: converact:${VERSION}
    environment:
      - DATABASE_URL=postgresql://opc:${PG_PASSWORD}@postgres:5432/opc
      - REDIS_URL=redis://redis:6379
      - INSTANCE_ID=converact-1
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G

  converact-2:
    image: converact:${VERSION}
    environment:
      - DATABASE_URL=postgresql://opc:${PG_PASSWORD}@postgres:5432/opc
      - REDIS_URL=redis://redis:6379
      - INSTANCE_ID=converact-2
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G

  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./certs:/etc/nginx/certs

  postgres:
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=opc
      - POSTGRES_USER=opc
      - POSTGRES_PASSWORD=${PG_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data

  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus:/etc/prometheus

  grafana:
    image: grafana/grafana:latest
    ports:
      - "3001:3000"
    volumes:
      - ./grafana:/etc/grafana/provisioning

volumes:
  pg-data:
```

---

## 10. Phase 4 完成标志

Phase 4 交付后，系统具备：

1. **可观测**：所有关键指标有采集、有大盘、有报警
2. **可审计**：通话全量录音、对话文本保留、导出合规
3. **可扩展**：PostgreSQL + Redis → 水平扩展到 3+ Converact Platform 实例
4. **可恢复**：任一组件宕机有明确恢复流程
5. **可压测**：K6 + SIPp 工具齐备，基准数据已记录
6. **可运维**：手册齐全，发布流程标准化

此后进入**持续运营阶段**：根据业务需求迭代功能，无需再做基础架构大改。
