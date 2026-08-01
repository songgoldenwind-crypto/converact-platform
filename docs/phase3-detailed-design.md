# Phase 3 — 人工坐席面板 + 转接编排 · 细节设计

> **目标**：AI 判断高意向后 → 转接真人坐席 → 坐席看到完整上下文 → 接入 Room 继续对话。
> **依赖**：Phase 2 AI 视频外呼闭环已通过验收。

---

## 0. 验收清单

| # | 项 | 验证方式 | 预期 |
|---|---|---|---|
| 1 | 坐席面板显示等待列表 | 登录后查看队列 | 可见当前排队通话 |
| 2 | 坐席看到 AI 对话摘要 | 接入前预览 | 显示 customer_summary + intent |
| 3 | 坐席接入通话 | 点击"接听" | 音频/视频连通 |
| 4 | AI 退出 Room | 坐席接入后 | AI participant 离开 |
| 5 | 坐席与客户正常对话 | 双向音频 + 视频 | 无延迟无回声 |
| 6 | 坐席屏幕共享 | 点击共享 | 客户看到坐席屏幕 |
| 7 | 坐席间转接 | 坐席 A → 坐席 B | 客户无感知转接 |
| 8 | 坐席 status 正确更新 | 全流程 | idle→busy→wrap_up→idle |
| 9 | 心跳超时 → 离线 | 关闭浏览器 | 90s 后 status → offline |
| 10 | 通话结束 → wrap_up | 客户挂断 | 坐席进入 wrap_up (60s) |

---

## 1. 坐席面板技术架构

### 1.1 技术栈

```
services/agent-panel/
├── package.json          # Vite + React + TailwindCSS
├── src/
│   ├── App.tsx
│   ├── pages/
│   │   ├── Login.tsx
│   │   ├── Dashboard.tsx       # 主面板
│   │   └── CallRoom.tsx        # 通话中画面
│   ├── components/
│   │   ├── QueuePanel.tsx      # 等待队列
│   │   ├── CallInfo.tsx        # 通话信息卡片
│   │   ├── TranscriptView.tsx  # 实时转录
│   │   ├── CustomerProfile.tsx # 客户信息
│   │   ├── ControlBar.tsx      # 呼叫控制按钮
│   │   ├── SeatStatus.tsx      # 个人状态切换
│   │   └── StatsBar.tsx        # 今日统计
│   ├── hooks/
│   │   ├── useLiveKit.ts
│   │   ├── useSSE.ts           # Server-Sent Events
│   │   └── useHeartbeat.ts
│   ├── store/
│   │   └── agent-store.ts     # zustand
│   └── lib/
│       ├── api.ts              # Converact Platform API client
│       └── types.ts
├── public/
└── vite.config.ts
```

### 1.2 面板 UI 布局

```
┌──────────────────────────────────────────────────────────────────┐
│  [Logo] Converact Platform Call Center                    [状态: 🟢 在线 ▾] [退出]│
├──────────┬───────────────────────────────────────────────────────┤
│          │                                                        │
│ 等待队列  │              通话主区域                                 │
│          │                                                        │
│ ┌──────┐ │  ┌────────────────────────────────────────────────┐  │
│ │客户A  │ │  │                                                │  │
│ │意向:高 │ │  │         远程视频 (客户画面)                      │  │
│ │等待:2m │ │  │                                                │  │
│ ├──────┤ │  │                                                │  │
│ │客户B  │ │  └────────────────────────────────────────────────┘  │
│ │意向:中 │ │                                                        │
│ │等待:5m │ │  ┌──────────────────┐  ┌──────────────────────────┐│
│ ├──────┤ │  │  本地视频 (坐席)   │  │  对话记录                  ││
│ │...    │ │  │                  │  │  AI: こんにちは...          ││
│ └──────┘ │  │                  │  │  客: 2LDKを探して...        ││
│          │  └──────────────────┘  │  AI: 承知しました...         ││
│ 今日统计  │                         │  [系统] 坐席接入             ││
│ 通话: 12 │  ┌────────────────────┐  │  坐席: お待たせしました...   ││
│ 转化: 3  │  │ 🎤 📹 🖥️ ⏸️ 📞 🔄│  └──────────────────────────┘│
│ 平均: 4m │  │Mic Cam Share Hold End Xfer│                        │
│          │  └────────────────────┘                                │
│          │                                                        │
│          │  ┌──────────────────────────────────────────────────┐│
│          │  │ 客户信息: 田中太郎 | +81-90-1234-5678 | 物件ID: xxx ││
│          │  │ AI摘要: 2LDKで月15万円以内、新宿周辺希望              ││
│          │  └──────────────────────────────────────────────────┘│
├──────────┴───────────────────────────────────────────────────────┤
│  [通知区域]                                                       │
└──────────────────────────────────────────────────────────────────┘
```

### 1.3 状态管理 (Zustand)

```typescript
// store/agent-store.ts
interface AgentState {
  seatId: string | null;
  status: 'idle' | 'busy' | 'wrap_up' | 'offline' | 'break';
  currentCall: CurrentCallInfo | null;
  queue: QueueItem[];
  todayStats: { calls: number; conversions: number; avgDuration: number };

  // actions
  setStatus(status: string): void;
  acceptCall(queueItemId: string): void;
  endCall(): void;
  transferCall(targetSeatId: string): void;
}

interface QueueItem {
  id: string;
  roomName: string;
  customerName: string;
  phone: string;
  intentScore: number;
  waitingSince: string;
  aiSummary: string;
  language: string;
  mediaType: 'voice' | 'video';
}

interface CurrentCallInfo {
  callSessionId: string;
  roomName: string;
  livekitToken: string;
  customerName: string;
  transcript: TranscriptEntry[];
  startedAt: string;
}
```

---

## 2. 实时通信 (SSE)

### 2.1 Converact Platform → 坐席面板通道

选择 SSE 而非 WebSocket 的原因：
- 单向推送足够 (坐席操作通过 REST API)
- 无需管理 WebSocket 生命周期
- 天然支持自动重连
- 穿越 HTTP 代理更容易

### 2.2 SSE 端点

```
GET /api/call-center/seats/:seatId/events
Headers: Authorization: Bearer {jwt}

Event types:
  - queue_update    → 队列变化 (新来电/超时移除)
  - call_assigned   → 有通话被分配给该坐席
  - call_ended      → 当前通话结束
  - transcript      → 新的对话轮次
  - transfer_request → 其他坐席请求转接给你
  - system          → 系统通知
```

### 2.3 Converact Platform SSE 实现

```typescript
// src/agent-runtime/call-center/sse-manager.ts

type SSEClient = {
  seatId: string;
  tenantId: string;
  response: ServerResponse;
  lastEventId: number;
};

class SSEManager {
  private clients = new Map<string, SSEClient>();  // seatId → client

  register(seatId: string, tenantId: string, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    this.clients.set(seatId, { seatId, tenantId, response: res, lastEventId: 0 });
    res.on('close', () => this.clients.delete(seatId));
  }

  send(seatId: string, event: string, data: unknown): void {
    const client = this.clients.get(seatId);
    if (!client) return;
    const id = ++client.lastEventId;
    client.response.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(tenantId: string, event: string, data: unknown): void {
    for (const client of this.clients.values()) {
      if (client.tenantId === tenantId) {
        this.send(client.seatId, event, data);
      }
    }
  }
}

export const sseManager = new SSEManager();
```

### 2.4 前端 SSE Hook

```typescript
// hooks/useSSE.ts
export function useSSE(seatId: string) {
  const [events, setEvents] = useState<SSEEvent[]>([]);

  useEffect(() => {
    const source = new EventSource(`/api/call-center/seats/${seatId}/events`);

    source.addEventListener('queue_update', (e) => {
      const data = JSON.parse(e.data);
      useAgentStore.getState().setQueue(data.queue);
    });

    source.addEventListener('call_assigned', (e) => {
      const data = JSON.parse(e.data);
      useAgentStore.getState().setCurrentCall(data);
    });

    source.addEventListener('transcript', (e) => {
      const data = JSON.parse(e.data);
      useAgentStore.getState().appendTranscript(data);
    });

    source.onerror = () => {
      // EventSource 自动重连
    };

    return () => source.close();
  }, [seatId]);
}
```

---

## 3. 心跳与在线状态

### 3.1 心跳协议

```
坐席面板 → Converact Platform:
  POST /api/call-center/seats/:seatId/heartbeat
  每 30s 一次

Converact Platform 检测:
  如果 last_heartbeat_at > 90s 前 → status = 'offline'
  如果当前有通话 + offline → 触发通话重新排队
```

### 3.2 前端 Heartbeat Hook

```typescript
// hooks/useHeartbeat.ts
export function useHeartbeat(seatId: string) {
  useEffect(() => {
    const interval = setInterval(async () => {
      await fetch(`/api/call-center/seats/${seatId}/heartbeat`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    }, 30_000);

    return () => clearInterval(interval);
  }, [seatId]);
}
```

### 3.3 Converact Platform 后台超时检测

```typescript
// 每 15s 扫描一次
setInterval(() => {
  const threshold = new Date(Date.now() - 90_000).toISOString();
  const offlineSeats = db.all(
    `UPDATE agent_seats SET status = 'offline'
     WHERE status NOT IN ('offline', 'break') AND last_heartbeat_at < ?
     RETURNING *`,
    threshold
  );

  for (const seat of offlineSeats) {
    if (seat.current_call_session_id) {
      requeueCall(seat.current_call_session_id);
    }
    sseManager.broadcast(seat.tenant_id, 'system', {
      type: 'seat_offline',
      seat_id: seat.id,
    });
  }
}, 15_000);
```

---

## 4. Transfer Orchestrator

### 4.1 模块职责

`src/agent-runtime/call-center/transfer-orchestrator.ts`

负责将通话从 AI/坐席 A 转移到坐席 B，管理整个转接过程。

### 4.2 转接类型

| 类型 | 说明 | 音频中断 |
|---|---|---|
| cold_transfer | AI 退出 → 坐席加入 | 有短暂静音 (< 2s) |
| warm_transfer | AI 保留 → 坐席加入 → AI 退出 | 无中断 |
| blind_transfer | 坐席 A 退出 → 坐席 B 加入 | 有短暂静音 |
| consult_transfer | 坐席 A + B 先私聊 → B 接入 | A 客户听等待音 |

### 4.3 Cold Transfer 流程 (AI → 人工)

```
1. AI Agent 调用 transfer_to_human tool
2. Converact Platform 收到 agent-dispatch 请求
3. Transfer Orchestrator:
   a. 查找匹配的 idle 坐席 (skills + language)
   b. 如果有 → 分配
   c. 如果没有 → 加入等待队列
4. 分配成功:
   a. 更新 seat.status = 'busy', seat.current_call_session_id = xxx
   b. 生成坐席 LiveKit token
   c. SSE 通知坐席 → call_assigned
   d. 坐席面板显示通话信息 + "接听"按钮
5. 坐席点击"接听":
   a. 坐席加入 LiveKit Room
   b. Converact Platform 通知 AI Agent 退出 (通过 Room metadata update 或直接 remove participant)
   c. AI 离开 Room
   d. 坐席与客户直接通话
```

### 4.4 坐席匹配算法

```typescript
function findBestSeat(tenantId: string, requirements: {
  skills?: string[];
  language: string;
  priority?: number;
}): AgentSeatRow | null {
  const candidates = seatStore.listSeats(tenantId)
    .filter(s => s.status === 'idle')
    .filter(s => {
      if (!requirements.skills?.length) return true;
      const seatSkills = JSON.parse(s.skills || '[]');
      return requirements.skills.every(skill => seatSkills.includes(skill));
    })
    .filter(s => {
      const seatLangs = JSON.parse(s.skills || '[]');
      return seatLangs.includes(requirements.language) || seatLangs.includes('*');
    });

  if (candidates.length === 0) return null;

  // 优先级：等待最久的 idle 坐席
  candidates.sort((a, b) =>
    new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime()
  );

  return candidates[0];
}
```

### 4.5 等待队列

```typescript
interface QueueEntry {
  id: string;
  roomName: string;
  callSessionId: string;
  tenantId: string;
  requirements: {
    skills: string[];
    language: string;
  };
  customerSummary: string;
  intentScore: number;
  enqueuedAt: string;
  priority: number;  // 0-9, 9 最高
}
```

**队列存储**：SQLite 表 (Phase 3 规模不需要 Redis)

```sql
CREATE TABLE IF NOT EXISTS transfer_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_name TEXT NOT NULL,
  call_session_id TEXT NOT NULL,
  required_skills TEXT DEFAULT '[]',
  language TEXT DEFAULT 'ja',
  customer_summary TEXT,
  intent_score REAL DEFAULT 0,
  priority INTEGER DEFAULT 5,
  enqueued_at TEXT NOT NULL,
  assigned_seat_id TEXT,
  assigned_at TEXT,
  expired_at TEXT,
  status TEXT DEFAULT 'waiting' CHECK(status IN ('waiting','assigned','expired','cancelled'))
);
CREATE INDEX idx_transfer_queue_status ON transfer_queue(tenant_id, status);
```

### 4.6 队列超时

```
等待 > 5 分钟 (可配置):
  → 通知 AI Agent 告知客户"坐席繁忙"
  → AI 提供选项: 继续等待 / 预约回电
  → 客户选择后处理
```

---

## 5. 坐席通话生命周期

```
         ┌──────────────────────────────────────┐
         │                                      │
         ▼                                      │
      ┌──────┐    接听通话     ┌──────┐         │
      │ idle │ ─────────────► │ busy │         │
      └──────┘                └──────┘         │
         ▲                       │              │
         │                       │ 通话结束     │
         │                       ▼              │
         │                 ┌──────────┐         │
         │  wrap_up 超时   │ wrap_up  │         │
         │  (60s) / 手动   │ (后处理)  │         │
         └─────────────────┘──────────┘         │
                                                │
      ┌──────┐                                  │
      │break │ ←── 手动切换 ────────────────────┘
      └──────┘                (仅 idle 状态可切 break)
```

### 5.1 wrap_up 后处理

通话结束后坐席进入 60s wrap_up 时间：
- 可以记录通话备注
- 可以设置客户标签
- 可以创建跟进任务
- 60s 后自动回到 idle (或手动提前结束)

```typescript
interface WrapUpData {
  notes?: string;
  tags?: string[];
  followUpAction?: 'none' | 'callback' | 'send_material' | 'create_task';
  followUpDetails?: Record<string, unknown>;
}
```

---

## 6. Phase 3 新增 Converact Platform API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/call-center/seats/:seatId/events` | SSE 事件流 |
| POST | `/api/call-center/seats/:seatId/heartbeat` | 心跳 |
| POST | `/api/call-center/seats/:seatId/status` | 切换状态 |
| POST | `/api/call-center/seats/:seatId/accept` | 接听通话 |
| POST | `/api/call-center/seats/:seatId/hangup` | 挂断 |
| POST | `/api/call-center/seats/:seatId/transfer` | 发起转接 |
| POST | `/api/call-center/seats/:seatId/wrap-up` | 提交 wrap_up 数据 |
| GET | `/api/call-center/queue` | 获取当前等待队列 |
| GET | `/api/call-center/calls/:id/context` | 获取通话上下文 (AI 摘要 + 转录) |
| POST | `/api/call-center/auth/login` | 坐席登录 |

### 6.1 `POST /api/call-center/seats/:seatId/accept`

```typescript
interface AcceptCallRequest {
  queue_entry_id: string;
}

interface AcceptCallResponse {
  call_session_id: string;
  room_name: string;
  livekit_token: string;
  customer_info: {
    name: string;
    phone: string;
  };
  ai_summary: string;
  transcript: TranscriptEntry[];
}
```

**处理逻辑**：
1. 验证 queue_entry 存在且 status = 'waiting'
2. 更新 queue_entry.status = 'assigned'
3. 更新 seat.status = 'busy'
4. 生成坐席 LiveKit Token (canPublish: true, canSubscribe: true)
5. 通过 Room metadata 通知 AI Agent 退出
6. 返回所有上下文给坐席面板

### 6.2 `POST /api/call-center/seats/:seatId/transfer`

```typescript
interface TransferRequest {
  type: 'blind' | 'warm' | 'consult';
  target_seat_id?: string;     // 指定坐席
  target_skills?: string[];    // 或按技能路由
  reason: string;
}

interface TransferResponse {
  status: 'transferred' | 'queued' | 'no_target';
  target_seat_id?: string;
}
```

---

## 7. 坐席认证

### 7.1 简化方案 (Phase 3)

```typescript
// 坐席账号存在 agent_seats 表
// 登录: user_id + password (简单 bcrypt 哈希)
// JWT token: { seat_id, tenant_id, user_id, exp }

interface LoginRequest {
  user_id: string;
  password: string;
}

interface LoginResponse {
  token: string;       // JWT, 8h 有效
  seat: {
    id: string;
    display_name: string;
    skills: string[];
  };
}
```

### 7.2 密码存储

`agent_seats` 表增加字段：

```sql
ALTER TABLE agent_seats ADD COLUMN password_hash TEXT;
```

---

## 8. AI Agent 退出协议

坐席接入后，需要 AI Agent 优雅退出：

### 8.1 通过 Room Metadata

```typescript
// Converact Platform 更新 Room metadata:
await livekitRoomClient.updateRoomMetadata(roomName, JSON.stringify({
  ...existingMeta,
  agent_should_leave: true,
  transfer_reason: "human_agent_joined",
  human_agent_name: seat.display_name,
}));
```

### 8.2 AI Agent 监听

```python
# session_handler.py
@ctx.room.on("metadata_changed")
async def on_room_metadata_changed(metadata: str):
    data = json.loads(metadata)
    if data.get("agent_should_leave"):
        # 说告别语
        await session.generate_reply(
            instructions="人間のスタッフに繋がりました。"
                        f"{data.get('human_agent_name', 'スタッフ')}がご対応します。"
                        "短い挨拶をしてから退出してください。"
        )
        await asyncio.sleep(3)  # 等告别语说完
        await ctx.room.disconnect()
```

---

## 9. Docker Compose 变更

```yaml
  agent-panel:
    build: services/agent-panel
    ports:
      - "5174:5174"
    environment:
      - VITE_API_URL=http://localhost:3000
      - VITE_LIVEKIT_URL=ws://localhost:7880
    depends_on:
      - converact
      - livekit
```

---

## 10. Phase 3 测试策略

| 测试 | 类型 | 说明 |
|---|---|---|
| Transfer Orchestrator 单元测试 | 单元 | 坐席匹配 + 队列管理 |
| SSE 推送测试 | 集成 | 连接 → 收到 event |
| 心跳超时测试 | 集成 | 停止心跳 → offline |
| 坐席接入 E2E | E2E | AI 转接 → 坐席面板显示 → 接入 → 通话 |
| 并发转接测试 | 负载 | 同时 3 个转接 → 无死锁 |
| 面板 UI 测试 | E2E (Playwright) | 登录 → 队列显示 → 接听 → 视频可见 |

---

## 11. Phase 3 → Phase 4 衔接

Phase 3 完成后，Phase 4 需要：
- 通话合规录音存档
- 监控大盘 (Grafana)
- 多实例部署 + 会话亲和
- 负载测试 (50 并发)
- 故障恢复演练
