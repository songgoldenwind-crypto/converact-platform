# OPC 视频+语音呼叫中心 — 实施规格

> 本文是 [`architecture-video-voice-callcenter.md`](./architecture-video-voice-callcenter.md) 的开发级补充。
> 架构文档定义「是什么」，本文定义「怎么做」。

---

## 1. 状态机定义

### 1.1 外呼任务 (`outbound_tasks.status`)

```
                 ┌─────────┐
                 │ pending │
                 └────┬────┘
                      │ dialer picks up
                      ▼
                 ┌─────────┐   RWI originate failed
                 │ dialing │ ──────────────────────► ┌────────┐
                 └────┬────┘                         │ failed │
                      │ callee answered              └────────┘
                      ▼                                   ▲
                 ┌───────────┐                            │
                 │ connected │ ───── timeout / hangup ────┘
                 └─────┬─────┘
                       │ normal end
                       ▼
                 ┌───────────┐
                 │ completed │
                 └───────────┘
```

| 状态 | 触发条件 | 后续动作 |
|------|---------|----------|
| `pending` | 创建任务 / scheduled_at 到期 | dialer 轮询拾取 |
| `dialing` | RWI `originate` 已发送 | 等待 RustPBX 事件 |
| `connected` | CDR event `answered` | AI Agent 开始对话 |
| `completed` | CDR event `hangup` / 正常结束 | 写入 result JSON |
| `failed` | originate 超时 / 被拒 / 网络错误 | attempt_count++ → 若 < max_attempts 则 30s 后重置为 pending |

**重试规则**：
- 忙音 / 无应答：30s 后重试
- 拒接：2 小时后重试
- 号码无效：标记 `failed`，不重试
- 达到 `max_attempts`：永久 `failed`

### 1.2 通话会话 (`voice_call_sessions.status`)

```
┌──────────┐     ┌──────────┐     ┌────────────┐     ┌──────────┐
│ initiated│────►│ ringing  │────►│ in_progress│────►│ completed│
└──────────┘     └────┬─────┘     └─────┬──────┘     └──────────┘
                      │                  │
                      │ no answer        │ error
                      ▼                  ▼
                 ┌──────────┐     ┌──────────┐
                 │ missed   │     │ error    │
                 └──────────┘     └──────────┘
```

| 状态 | 含义 |
|------|------|
| `initiated` | OPC 创建了 session 记录，尚未发送 SIP |
| `ringing` | INVITE 已发 / 收到 180 |
| `in_progress` | 200 OK / 已接通 |
| `completed` | BYE，正常挂断 |
| `missed` | 超时无人接听 |
| `error` | 信令错误 / 媒体建立失败 |

**附加字段**：
- `ai_handled`: boolean — 是否有 AI Agent 参与
- `transferred`: boolean — 是否发生过转接
- `transfer_chain`: JSON — 转接历史

### 1.3 坐席状态 (`agent_seats.status`)

```
┌─────────┐     ┌──────┐     ┌──────┐
│ offline │◄───►│ idle │◄───►│ busy │
└─────────┘     └──┬───┘     └──────┘
                   │ ▲
                   ▼ │
               ┌───────┐
               │ break │
               └───────┘
```

| 状态 | 含义 | ACD 可分配 |
|------|------|-----------|
| `offline` | 未登录 | ❌ |
| `idle` | 空闲等待 | ✅ |
| `busy` | 正在通话 | ❌ |
| `break` | 休息（手动设置） | ❌ |

**心跳**：坐席面板每 15s 发 heartbeat → OPC 更新 `last_heartbeat_at`。若 60s 无心跳 → 自动切 `offline`。

### 1.4 LiveKit Room 生命周期

```
┌─────────┐    participant joined    ┌────────┐    all left / timeout    ┌────────┐
│ created │ ────────────────────────►│ active │ ──────────────────────►│ closed │
└─────────┘                          └────────┘                         └────────┘
```

Room `empty_timeout`: 300s (LiveKit config)。OPC 在收到 `room_finished` webhook 后将 `livekit_rooms.status` 改为 `closed`。

---

## 2. 完整 HTTP API 契约

### 2.1 OPC 新增端点总表

| Method | Path | 调用方 | 说明 |
|--------|------|--------|------|
| POST | `/api/call-router` | RustPBX HTTP Router | 路由决策 |
| POST | `/api/webhooks/rustpbx-cdr` | RustPBX CDR | 通话结束入库 |
| POST | `/api/media/webhooks/livekit` | LiveKit Server | Room/participant 事件 |
| GET | `/api/call-center/seats` | 坐席面板 | 坐席列表 |
| PUT | `/api/call-center/seats/:id/status` | 坐席面板 | 切换状态 |
| POST | `/api/call-center/seats/:id/heartbeat` | 坐席面板 | 心跳 |
| GET | `/api/call-center/outbound-tasks` | 坐席面板 / 管理 | 外呼任务列表 |
| POST | `/api/call-center/outbound-tasks` | OPC 内部 / API | 创建外呼任务 |
| POST | `/api/call-center/outbound-tasks/:id/cancel` | 管理 | 取消任务 |
| POST | `/api/call-center/calls/originate` | 坐席面板 | 坐席手动外呼 |
| POST | `/api/call-center/calls/:id/transfer` | 坐席面板 / AI Agent | 转接 |
| POST | `/api/call-center/calls/:id/hold` | 坐席面板 | 保持 |
| POST | `/api/call-center/calls/:id/hangup` | 坐席面板 | 挂断 |
| GET | `/api/call-center/calls/:id` | 坐席面板 | 通话详情 |
| GET | `/api/call-center/calls` | 坐席面板 / 管理 | 通话记录列表 |
| POST | `/api/livekit/rooms` | OPC 内部 | 创建 Room |
| GET | `/api/livekit/token` | 坐席面板 / H5 | 获取加入 Room 的 token |
| POST | `/api/livekit/agent-dispatch` | OPC 内部 / AI Agent | 请求转人工 |
| GET | `/api/call-center/dashboard` | 坐席面板 | 今日概览数据 |

### 2.2 端点详细规格

#### `POST /api/call-router`

RustPBX 每收到一个 INVITE 就回调此端点。OPC 必须在 3s 内响应。

**Request** (from RustPBX):
```typescript
interface CallRouterRequest {
  call_id: string;              // RustPBX 分配的 UUID
  from_uri: string;             // "sip:+81312345678@trunk.twilio.com"
  to_uri: string;               // "sip:+81398765432@pbx.local"
  from_display: string;         // 来电显示名
  direction: 'inbound' | 'outbound';
  transport: 'udp' | 'tcp' | 'ws';
  trunk_name: string;           // "twilio-japan"
  headers: Record<string, string>;  // 自定义 SIP headers
  timestamp: string;            // ISO 8601
}
```

**Response** (OPC → RustPBX):
```typescript
interface CallRouterResponse {
  action: 'forward' | 'queue' | 'reject' | 'ivr' | 'voicemail';

  // action = 'forward'
  targets?: string[];           // SIP URIs: ["sip:ai-agent@livekit-sip:5061"]
  timeout_sec?: number;         // 单个 target 振铃超时，默认 30

  // action = 'queue'
  queue_name?: string;          // ACD 队列名
  priority?: number;            // 队列优先级 1-10

  // action = 'reject'
  code?: number;                // SIP status code: 486(busy) / 603(decline)
  reason?: string;

  // action = 'ivr'
  play_file?: string;           // 播放语音文件路径
  dtmf_actions?: Record<string, CallRouterResponse>;  // 按键子路由

  // 通用
  record?: boolean;             // 是否录音
  metadata?: Record<string, string>;  // 附加到 CDR
  caller_id_override?: string;  // 改写主叫号码
}
```

**路由决策逻辑** (OPC 内部):
```
1. 解析 to_uri 提取被叫号码
2. 查 tenant 配置 → 找到对应租户
3. 查 outbound_tasks 是否有匹配的进行中任务
   - 有 → forward to livekit-sip (AI Agent)
4. direction == 'inbound'?
   - 查 tenant 路由规则 (时段/号码匹配)
   - 工作时间 + 有空闲坐席 → queue
   - 非工作时间 / 无坐席 → forward to livekit-sip (AI)
   - 黑名单号码 → reject 603
5. 默认 → reject 486
```

---

#### `POST /api/webhooks/rustpbx-cdr`

通话结束时 RustPBX 推送 CDR。

**Request**:
```typescript
interface RustPBXCDR {
  call_id: string;
  from_uri: string;
  to_uri: string;
  direction: 'inbound' | 'outbound';
  start_time: string;           // ISO 8601
  answer_time: string | null;   // null = 未接听
  end_time: string;
  duration_sec: number;         // 通话时长（接听后）
  ring_duration_sec: number;
  hangup_cause: string;         // 'normal_clearing' | 'no_answer' | 'busy' | 'reject' | ...
  hangup_by: 'caller' | 'callee' | 'system';
  trunk_name: string;
  recording_url: string | null;
  metadata: Record<string, string>;  // call-router 阶段附加的
}
```

**Response**: `200 OK` (body ignored)

**OPC 处理逻辑**:
1. 通过 `call_id` 匹配 `voice_call_sessions.rustpbx_call_id`
2. 更新 session: status → `completed` / `missed`
3. 更新 duration, hangup_cause
4. 若有 recording_url → 写入 `call_recordings`
5. 若关联 outbound_task → 更新 task status 和 result

---

#### `POST /api/media/webhooks/livekit`

LiveKit Server 推送各类事件。请求带 Authorization header 用于验签。

**Request header**: `Authorization: Bearer <webhook_token>`

**验签**: 使用 `livekit-server-sdk-js` 的 `WebhookReceiver` 类验证签名。

**事件类型与处理**:

| event | 处理 |
|-------|------|
| `room_started` | 更新 livekit_rooms.room_sid |
| `room_finished` | livekit_rooms.status='closed', closed_at=now |
| `participant_joined` | 记录到 session metadata |
| `participant_left` | 若 room 仅剩 AI → 可清理 |
| `track_published` | 无特殊处理 |
| `egress_started` | 记录 egress_id 到 call_recordings |
| `egress_ended` | 更新 recording: duration, file_size, storage_url |

---

#### `POST /api/call-center/outbound-tasks`

创建外呼任务。

**Request**:
```typescript
interface CreateOutboundTaskRequest {
  tenant_id: string;
  lead_id?: string;             // 关联的线索
  phone_number: string;         // E.164 格式: "+81312345678"
  channel: 'pstn_voice' | 'video_link_sms' | 'video_link_wechat';
  strategy: {
    script_id: string;          // 话术脚本 ID
    language: 'ja' | 'en' | 'zh';
    avatar_id?: string;         // 视频数字人 ID (video 场景)
    max_duration_sec?: number;  // 最长通话时间，默认 300
    transfer_threshold?: number; // 意向分转人工阈值，默认 0.7
  };
  scheduled_at?: string;        // ISO 8601，不传=立即
  max_attempts?: number;        // 默认 3
  priority?: number;            // 1-10, 默认 5
}
```

**Response** `201`:
```typescript
interface OutboundTaskResponse {
  id: string;
  status: 'pending';
  created_at: string;
}
```

---

#### `POST /api/call-center/calls/originate`

坐席手动发起呼叫。

**Request**:
```typescript
interface ManualOriginateRequest {
  seat_id: string;
  phone_number: string;         // E.164
  video_enabled?: boolean;      // 是否创建视频 Room
  tenant_id: string;
}
```

**Response** `200`:
```typescript
interface OriginateResponse {
  call_session_id: string;
  rustpbx_call_id: string;
  livekit_room_name?: string;   // video 场景
  livekit_token?: string;       // 坐席加入 room 用的 token
}
```

---

#### `POST /api/call-center/calls/:id/transfer`

AI Agent 或坐席发起转接。

**Request**:
```typescript
interface TransferRequest {
  target_type: 'seat' | 'queue' | 'external';
  target_id?: string;           // seat_id or queue_name
  target_number?: string;       // external phone number
  reason?: string;              // 转接原因
  customer_summary?: string;    // AI 给坐席的客户概要
  intent_score?: number;        // AI 判定的意向分
  warm?: boolean;               // true=通报转(先通知坐席), false=盲转
}
```

**Response** `200`:
```typescript
interface TransferResponse {
  success: boolean;
  assigned_seat_id?: string;
  error?: string;               // e.g. "no_available_seats"
}
```

**转接执行逻辑**:
1. `target_type === 'seat'`
   - 查 target seat 是否 idle → 若否返回 error
   - RWI: `transfer(call_id, seat_extension)`
   - 若 warm: 先 RWI `whisper` 告知坐席客户情况 → 坐席确认 → 完成转接
2. `target_type === 'queue'`
   - RWI: `enqueue(call_id, queue_name)`
   - 客户听 hold music
3. `target_type === 'external'`
   - RWI: `transfer(call_id, target_number)`

---

#### `GET /api/livekit/token`

前端请求加入 LiveKit Room 的 JWT token。

**Query params**:
```
room_name: string       // 要加入的 room
identity: string        // 用户标识 (seat_id 或 customer_xxx)
role: 'agent' | 'customer'
```

**Response** `200`:
```typescript
interface TokenResponse {
  token: string;                // LiveKit JWT
  livekit_url: string;          // ws://host:7880
  room_name: string;
}
```

**Token grants by role**:
- `agent`: canPublish=true, canSubscribe=true, canPublishData=true
- `customer`: canPublish=true (audio+video), canSubscribe=true, canPublishData=false

---

#### `POST /api/livekit/agent-dispatch`

AI Agent 请求 OPC 执行转人工（从 Python agent 调用）。

**Request**:
```typescript
interface AgentDispatchRequest {
  room_name: string;
  action: 'transfer_to_human' | 'end_call' | 'schedule_callback';
  reason: string;
  customer_summary: string;
  intent_score: number;
  conversation_turns: number;
  language: string;
  // transfer_to_human specific
  required_skills?: string[];   // ["japanese", "real_estate"]
  // schedule_callback specific
  callback_time?: string;       // ISO 8601
  callback_phone?: string;
}
```

**Response** `200`:
```typescript
interface AgentDispatchResponse {
  action_taken: 'seat_assigned' | 'queued' | 'no_seats_available' | 'callback_scheduled';
  assigned_seat_id?: string;
  wait_time_estimate_sec?: number;
  message_for_customer?: string;  // AI Agent 可以向客户播报 "正在为您转接人工..."
}
```

---

#### `GET /api/call-center/dashboard`

坐席面板首页概览。

**Query params**: `tenant_id`, `date` (默认今天)

**Response** `200`:
```typescript
interface DashboardData {
  today: {
    total_outbound: number;
    connected: number;
    avg_duration_sec: number;
    transfer_rate: number;        // AI→人工 转接率
    intent_qualified: number;     // 高意向数
  };
  seats: {
    online: number;
    idle: number;
    busy: number;
  };
  queue: {
    pending_tasks: number;
    in_progress: number;
    avg_wait_sec: number;
  };
}
```

---

## 3. 实时通信协议

### 3.1 坐席面板 ↔ OPC（SSE 推送）

坐席面板打开后建立 Server-Sent Events 连接，接收实时事件。

**端点**: `GET /api/call-center/events?seat_id={id}`

**事件类型**:

```typescript
// 来电通知（AI 转人工）
interface IncomingCallEvent {
  type: 'incoming_call';
  call_session_id: string;
  room_name: string;
  customer_phone: string;
  customer_summary: string;     // AI 总结
  intent_score: number;
  language: string;
  required_action: 'accept' | 'reject';
}

// 坐席面板操作后的确认
interface CallUpdateEvent {
  type: 'call_update';
  call_session_id: string;
  status: string;               // call session 新状态
  detail: string;
}

// 外呼任务进度
interface TaskProgressEvent {
  type: 'task_progress';
  task_id: string;
  status: string;
  result?: Record<string, unknown>;
}

// 队列变化
interface QueueUpdateEvent {
  type: 'queue_update';
  queue_name: string;
  waiting: number;
  avg_wait_sec: number;
}
```

**实现**: OPC 内部使用 Redis Pub/Sub：
- Channel: `seat:{seat_id}:events`
- AI Agent / CDR receiver / dialer 发布事件到 Redis
- SSE handler 订阅该 channel 并 stream 给前端

### 3.2 AI Agent ↔ OPC（HTTP API）

AI Agent (Python) 通过 HTTP 调用 OPC：

```python
# services/ai-agent-py/opc_client.py

class OPCClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url
        self.api_key = api_key

    async def request_transfer(self, room_name: str, reason: str,
                               summary: str, score: float, skills: list[str]):
        """POST /api/livekit/agent-dispatch"""
        ...

    async def report_conversation_turn(self, call_session_id: str,
                                       role: str, content: str, score: float):
        """POST /api/call-center/calls/{id}/turns"""
        ...

    async def report_call_end(self, room_name: str, disposition: str,
                              intent_score: float, summary: str):
        """POST /api/call-center/calls/{id}/ai-result"""
        ...
```

### 3.3 OPC → AI Agent 指令

OPC 通过 LiveKit Room metadata 或 data channel 向 AI Agent 下发指令：

```typescript
// OPC 更新 Room metadata 来影响 AI Agent 行为
interface RoomMetadataUpdate {
  action?: 'stop_conversation' | 'change_script' | 'extend_timeout';
  new_script_id?: string;
  max_duration_override?: number;
}
```

AI Agent 监听 `RoomEvent.RoomMetadataChanged` 并响应。

---

## 4. 错误处理与容错

### 4.1 RustPBX HTTP Router 超时

| 场景 | 处理 |
|------|------|
| OPC 3s 内未响应 | RustPBX fallback_action = "reject" → 给来电方 486 |
| OPC 返回 5xx | 同上，reject |
| OPC 返回非法 JSON | 同上，reject |

**OPC 侧优化**：call-router handler 不做重 DB 查询，路由配置预热到内存 (Redis cache)。

### 4.2 AI Agent 崩溃

| 场景 | 检测方式 | 恢复 |
|------|---------|------|
| Agent 进程 crash | LiveKit `participant_left` webhook, identity 含 "ai-agent" 前缀 | OPC 自动 dispatch 新 Agent 到同一 Room |
| Agent 无响应 > 10s | AI Agent 内部 watchdog 定时 publish data message | OPC 检测到无 heartbeat → 重启 Agent |
| STT/LLM/TTS provider 超时 | Agent 内部 exception → fallback | Agent 播报 "请稍候" → 重试 → 3 次失败 → 转人工 |

**Agent 重连流程**：
1. OPC 收到 `participant_left` for AI Agent
2. 检查 Room 中是否仍有客户 participant
3. 若有 → 5s 内 dispatch 新 Agent（带同一 script + conversation context）
4. 新 Agent 从 OPC 获取已有 conversation_turns → 恢复上下文

### 4.3 CDR 丢失补偿

| 场景 | 检测 | 补偿 |
|------|------|------|
| CDR webhook 未收到 | 定时任务扫描 status='in_progress' 且 started_at > 10 分钟前 | 主动查 RustPBX API `/api/calls/{id}` |
| CDR 重复 | call_id 唯一约束 | INSERT OR IGNORE |
| CDR 到达时 session 不存在 | call_id 无匹配 | 创建 orphan session 记录 |

### 4.4 网络中断

| 组件 | 断线检测 | 恢复策略 |
|------|---------|----------|
| RWI WebSocket | onclose event | 指数退避重连 (1s, 2s, 4s, 8s, max 30s) |
| LiveKit Room (坐席) | disconnected event | 自动重连 (livekit-client 内建) |
| LiveKit Room (客户 H5) | disconnected event | 显示"连接中..." → 自动重连 |
| Redis 连接 | error event | ioredis 内建重连 |
| AI Agent ↔ LiveKit | Agent framework 内建 | Worker 自动 rejoin |

### 4.5 并发安全

| 操作 | 风险 | 解决 |
|------|------|------|
| 多个 dialer 同时拾取 task | 重复外呼 | Redis SETNX 锁: `task:{id}:lock` TTL 60s |
| 多个坐席同时接受转接 | 重复分配 | seat_manager 内 compare-and-swap: UPDATE WHERE status='idle' |
| CDR 和 LiveKit webhook 并发更新 session | 数据冲突 | session 更新用乐观锁: version 字段 |

---

## 5. 外呼调度器（Outbound Dialer）详设

### 5.1 轮询机制

```typescript
// src/agent-runtime/call-center/outbound-dialer.ts

class OutboundDialer {
  private interval: NodeJS.Timeout;
  private concurrentCalls = 0;
  private maxConcurrent = 5;      // 每租户最大并发外呼

  start() {
    this.interval = setInterval(() => this.tick(), 3000);
  }

  private async tick() {
    if (this.concurrentCalls >= this.maxConcurrent) return;

    const slots = this.maxConcurrent - this.concurrentCalls;
    const tasks = await this.pickTasks(slots);

    for (const task of tasks) {
      this.executeTask(task);  // fire and forget, tracked by events
    }
  }

  private async pickTasks(limit: number): Promise<OutboundTask[]> {
    // SELECT ... WHERE status='pending'
    //   AND (scheduled_at IS NULL OR scheduled_at <= now())
    //   ORDER BY priority DESC, created_at ASC
    //   LIMIT {limit}
    // + Redis lock per task
  }

  private async executeTask(task: OutboundTask) {
    this.concurrentCalls++;
    try {
      // 1. 更新 task status → dialing
      // 2. 创建 voice_call_session (status=initiated)
      // 3. 创建 livekit_room (若 video)
      // 4. Dispatch AI Agent to room
      // 5. RWI originate → bridge to livekit-sip

      if (task.channel === 'video_link_sms') {
        // 不通过 PSTN，而是：
        // a) 创建 LiveKit Room
        // b) Dispatch AI Agent
        // c) 发 SMS 包含 H5 链接
        // d) 等客户加入 Room (timeout 120s)
      } else {
        // PSTN voice:
        // a) RWI originate(phone_number)
        // b) 等 answered → bridge to livekit-sip
      }
    } catch (e) {
      // mark failed, schedule retry
    } finally {
      this.concurrentCalls--;
    }
  }
}
```

### 5.2 并发控制

- 全局最大并发：环境变量 `MAX_CONCURRENT_OUTBOUND` (默认 20)
- 每租户最大并发：tenant 配置 `max_concurrent_calls` (默认 5)
- 时间窗口限制：`outbound_window_start` / `outbound_window_end` (e.g. 09:00-18:00 JST)
- 频率限制：同一号码 2 小时内不重复呼叫

---

## 6. 转接编排器（Transfer Orchestrator）详设

### 6.1 AI → 人工 转接流程

```typescript
// src/agent-runtime/call-center/transfer-orchestrator.ts

class TransferOrchestrator {
  async handleAITransferRequest(req: AgentDispatchRequest): Promise<AgentDispatchResponse> {
    const room = await this.roomManager.getRoom(req.room_name);
    const session = await this.getSessionByRoom(room.id);

    // 1. 找可用坐席
    const seat = await this.seatManager.findAvailableSeat({
      tenant_id: session.tenant_id,
      skills: req.required_skills,
      strategy: 'least_recent_call',  // 最久没接电话的优先
    });

    if (!seat) {
      // 无可用坐席 → 排队或回调
      if (req.action === 'schedule_callback') {
        await this.scheduleCallback(session, req);
        return { action_taken: 'callback_scheduled', message_for_customer: '我们会在您方便的时间回电。' };
      }
      return { action_taken: 'no_seats_available', message_for_customer: '当前坐席全忙，请稍候...' };
    }

    // 2. 通知坐席（SSE event）
    await this.notifySeat(seat.id, {
      type: 'incoming_call',
      call_session_id: session.id,
      room_name: room.room_name,
      customer_summary: req.customer_summary,
      intent_score: req.intent_score,
      language: req.language,
    });

    // 3. 更新状态
    await this.seatManager.updateStatus(seat.id, 'busy');
    session.transferred = true;
    session.transfer_chain.push({ from: 'ai', to: seat.id, at: new Date().toISOString() });

    // 4. 生成坐席 token → 坐席面板收到事件后用 token 加入 Room
    // 5. AI Agent 收到 response 后播报 "正在为您转接专人..." → 退出 Room

    return {
      action_taken: 'seat_assigned',
      assigned_seat_id: seat.id,
      message_for_customer: '正在为您转接专人客服，请稍候...',
    };
  }
}
```

### 6.2 坐席接受/拒绝

坐席面板收到 `incoming_call` 事件后：
- **接受**: `POST /api/livekit/token?room_name=xxx&identity=seat_xxx&role=agent` → 拿 token → 加入 Room
- **拒绝/超时(20s)**: OPC 自动找下一个空闲坐席 → 重复流程。3 次全拒 → 排队或回调。

---

## 7. 测试策略

### 7.1 测试分层

| 层级 | 工具 | 范围 |
|------|------|------|
| 单元测试 | Node.js test runner | call-router 路由逻辑、seat 状态机、dialer 调度 |
| 集成测试 | Node.js + Docker | OPC ↔ Redis、OPC ↔ SQLite |
| 组件测试 | Mock RustPBX / Mock LiveKit | 完整通话流程无需真实 SIP |
| E2E 测试 | Docker Compose full stack | 真实 SIP 通话 (SIPp + LiveKit) |

### 7.2 无 PSTN 测试方案

开发阶段不连真实运营商，使用以下方案模拟：

**SIPp (SIP 压测工具)** 模拟来电/被叫方：
```bash
# 模拟客户被叫方（自动接听）
sipp -sf answer_call.xml -p 5070 -l 10

# 模拟客户来电
sipp -sf make_call.xml rustpbx:5060 -s +81312345678
```

**RustPBX 内建 WebRTC Phone** 模拟坐席接听。

**LiveKit CLI** 模拟客户加入 Room：
```bash
lk room join --room test-room --identity customer_test
```

### 7.3 关键测试用例

```typescript
// test/call-center-router.test.ts

test('inbound call → AI agent when no seats available', () => {
  // mock: all seats offline
  // input: inbound call from +81312345678
  // expect: action='forward', target='sip:ai-agent@livekit-sip:5061'
});

test('inbound call → queue when idle seat exists', () => {
  // mock: seat_001 is idle, has required skills
  // input: inbound call
  // expect: action='queue', queue_name='default'
});

test('outbound task retry on no_answer', () => {
  // mock: CDR with hangup_cause='no_answer'
  // expect: task.attempt_count++, task.status='pending', next retry in 30s
});

test('transfer orchestrator finds best seat', () => {
  // mock: 3 idle seats, one with matching skills
  // input: transfer request with required_skills=['japanese']
  // expect: assigned to the seat with 'japanese' skill
});

test('CDR compensation detects stuck sessions', () => {
  // mock: session in_progress for 15 minutes, no CDR received
  // expect: compensation job queries RustPBX and updates session
});
```

### 7.4 AI Agent 测试

```python
# services/ai-agent-py/tests/test_intent_scorer.py

def test_high_intent_triggers_transfer():
    """客户明确询问价格+确认时间 → 意向分 > 0.7 → 请求转人工"""
    turns = [
        {"role": "ai", "content": "这套公寓月租12万日元，您感兴趣吗？"},
        {"role": "customer", "content": "嗯，我想看看，这周六可以吗？"},
    ]
    score = calculate_intent_score(turns)
    assert score > 0.7

def test_low_intent_continues_conversation():
    """客户只是泛泛问问 → 继续对话"""
    turns = [
        {"role": "ai", "content": "请问您在找什么区域的房子？"},
        {"role": "customer", "content": "随便看看"},
    ]
    score = calculate_intent_score(turns)
    assert score < 0.4
```

---

## 8. Phase 0 实施手册

### 8.1 前置条件

```bash
# 开发机器要求
- Docker Desktop (macOS/Linux)
- Node.js >= 23
- Python >= 3.11
- 公网 IP 或 ngrok (SIP 测试用)

# 创建目录结构
mkdir -p config data/recordings data/minio data/db
```

### 8.2 Step 1: Redis + MinIO

```bash
# 先启动基础依赖
docker compose up -d redis minio

# 验证
redis-cli ping                     # → PONG
curl http://localhost:9001          # → MinIO Console
```

### 8.3 Step 2: LiveKit Server

```bash
# 生成 API key pair
docker run --rm livekit/generate-keys

# 写入 config/livekit.yaml (参考架构文档 §10.2)
# 写入 .env:
# LK_API_KEY=<generated>
# LK_API_SECRET=<generated>

docker compose up -d livekit

# 验证
curl http://localhost:7880          # → LiveKit Server info JSON
```

**验证 Room 创建**:
```bash
# 安装 LiveKit CLI
brew install livekit-cli   # or: go install github.com/livekit/livekit-cli/cmd/lk@latest

# 创建测试 Room
lk room create --name test-room --url http://localhost:7880 --api-key $LK_API_KEY --api-secret $LK_API_SECRET

# 加入 Room 验证
lk room join --room test-room --identity test-user --url http://localhost:7880 --api-key $LK_API_KEY --api-secret $LK_API_SECRET
```

### 8.4 Step 3: RustPBX

```bash
# 写入 config/rustpbx.toml (参考架构文档 §10.1)
# 注意：http_router.url 先改为一个 echo 服务做验证

docker compose up -d rustpbx

# 验证：Web Console
open http://localhost:8080/console

# 验证：SIP 监听
# 从另一台机器或 SIPp 发送 OPTIONS:
sipsak -s sip:test@<host_ip>:5060
# 应返回 200 OK
```

### 8.5 Step 4: LiveKit SIP Bridge

```bash
docker compose up -d livekit-sip

# 验证：SIP Bridge 监听
sipsak -s sip:test@<host_ip>:5061
# 应返回 200 OK
```

### 8.6 Step 5: RustPBX ↔ LiveKit SIP Trunk 互联

**在 RustPBX config 中**（已配置 `livekit-bridge` trunk 指向 `127.0.0.1:5061`）。

**在 LiveKit 中创建 SIP Trunk + Dispatch Rule**:
```bash
# 创建 inbound trunk (接受来自 RustPBX 的呼叫)
lk sip trunk create --url http://localhost:7880 --api-key $LK_API_KEY --api-secret $LK_API_SECRET \
  --name "rustpbx-inbound" \
  --addresses "<host_ip>"

# 创建 dispatch rule (所有呼叫进入以 call_id 命名的 Room)
lk sip dispatch-rule create --url http://localhost:7880 --api-key $LK_API_KEY --api-secret $LK_API_SECRET \
  --name "default-dispatch" \
  --rule-individual-room-prefix "call-"
```

### 8.7 Step 6: 端到端验证音频

用 RustPBX Web Console 内建 WebRTC Phone 拨打一个转到 LiveKit 的号码：

1. 打开 RustPBX Console: `http://localhost:8080/console`
2. 用内建 WebPhone 拨号（目标号码配置为转向 livekit-bridge trunk）
3. 同时用 LiveKit CLI join 对应 Room: `lk room join --room call-xxx`
4. **验收标准**：两端能互相听到音频

### 8.8 Step 7: OPC Schema 扩展

```bash
# 在 OPC 项目中执行 schema 迁移
cd /Users/songjinfeng/Desktop/opc
# 在 src/schema.sql 末尾追加新表 (参考架构文档 §6)
# 重建 DB:
rm -f data/opc.sqlite
npm run seed
```

### 8.9 Phase 0 验收标准清单

| # | 验收项 | 命令/操作 | 期望结果 |
|---|--------|----------|----------|
| 1 | Redis 可连 | `redis-cli ping` | PONG |
| 2 | MinIO Console 可访问 | `curl localhost:9001` | 200 |
| 3 | LiveKit Server 启动 | `curl localhost:7880` | JSON |
| 4 | LiveKit Room 可创建 | `lk room create --name test` | 无报错 |
| 5 | RustPBX Console 可访问 | `curl localhost:8080/console` | 200 |
| 6 | RustPBX SIP 可达 | `sipsak -s sip:test@host:5060` | 200 OK |
| 7 | LiveKit SIP 可达 | `sipsak -s sip:test@host:5061` | 200 OK |
| 8 | SIP Trunk 互通 | RustPBX WebPhone → LiveKit Room | 双向音频通 |
| 9 | OPC Schema 扩展 | `npm run seed` 无报错 | 新表可查 |
| 10 | OPC call-router 桩 | RustPBX INVITE → OPC 200 | 日志显示回调 |

---

## 9. 依赖版本锁定

### 9.1 OPC (Node.js)

```json
{
  "dependencies": {
    "livekit-server-sdk": "^2.9.0",
    "ioredis": "^5.6.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0"
  }
}
```

### 9.2 AI Agent (Python)

```
livekit-agents>=1.5.0
livekit-plugins-deepgram>=1.0.0
livekit-plugins-openai>=1.0.0
livekit-plugins-cartesia>=1.0.0
livekit-plugins-silero>=1.0.0
httpx>=0.28.0
pydantic>=2.10.0
```

### 9.3 Docker 镜像

| 服务 | 镜像 | Tag 策略 |
|------|------|----------|
| RustPBX | iveKit fixed-source image | 生产使用审核后的 immutable digest |
| LiveKit Server | `ivekit/livekit-server` | `v1.13.4-ivekit.1`，生产制品必须绑定 iveKit fork 的 digest |
| LiveKit SIP | iveKit exact-source image | `v1.7.0`，生产制品必须使用签名 digest |
| LiveKit Egress | `ivekit/livekit-egress` | `v1.13.0` 源码基线，Chart 强制 custom image digest |
| Redis | `redis` | standalone Media Core 固定 `7.4.9` |
| MinIO | `minio/minio` | `RELEASE.2025-09-07T16-13-09Z` + manifest digest |

---

## 10. 监控与可观测性

### 10.1 Metrics 采集

| 组件 | 指标来源 | 关键指标 |
|------|---------|----------|
| RustPBX | Prometheus `/metrics` | `rustpbx_active_calls`, `rustpbx_call_duration_seconds`, `rustpbx_queue_wait_seconds` |
| LiveKit | Prometheus `/metrics` | `livekit_room_count`, `livekit_participant_count`, `livekit_packet_loss_ratio` |
| OPC | 自定义 | `opc_outbound_tasks_pending`, `opc_transfer_latency_ms`, `opc_ai_intent_score_histogram` |
| AI Agent | LiveKit Agent metrics | `agent_response_latency_ms`, `agent_stt_latency_ms`, `agent_tts_latency_ms` |

### 10.2 日志格式

统一 JSON 结构化日志：

```json
{
  "ts": "2026-06-15T18:30:00.000Z",
  "level": "info",
  "service": "opc",
  "module": "call-router",
  "call_id": "uuid",
  "tenant_id": "tenant_abc",
  "msg": "routing decision: forward to AI",
  "duration_ms": 12
}
```

### 10.3 告警规则

| 规则 | 条件 | 严重度 |
|------|------|--------|
| 外呼成功率低 | connected / dialing < 30% (5 分钟窗口) | warning |
| CDR 丢失 | in_progress session > 10 分钟无 CDR | critical |
| AI Agent 无响应 | Agent participant_left 且 Room 仍有客户 | critical |
| 队列等待过长 | avg_wait > 60s | warning |
| LiveKit 丢包高 | packet_loss > 5% | warning |
| RustPBX 并发上限 | active_calls > 700 | warning |

---

## 11. 安全与合规

### 11.1 认证

| 通信路径 | 认证方式 |
|---------|----------|
| 前端 → OPC API | Bearer Token (JWT, 坐席登录后颁发) |
| 客户 H5 → LiveKit | 一次性 JWT (room+identity 绑定, 30 min TTL) |
| RustPBX → OPC | 固定 API Key (Header: `X-PBX-Key`) |
| LiveKit → OPC webhook | HMAC 签名验证 (livekit-server-sdk 内建) |
| OPC → RustPBX RWI | WebSocket + Basic Auth |
| OPC → LiveKit API | API Key + Secret |
| AI Agent → OPC | 内网固定 API Key |

### 11.2 录音合规

**日本**：
- 通话开始前播放提示音："この通話は品質向上のため録音されています"
- AI 场景额外告知："こちらはAIによる自動音声サービスです"
- 录音文件 3 年保留后自动删除

**中国**：
- "本通话将被录音" 提示
- 个人信息保护法：录音数据加密存储，不出境

### 11.3 数据隔离

- 所有表含 `tenant_id` 字段
- API 层强制 tenant 过滤
- LiveKit Room 名含 tenant 前缀: `{tenant_id}-{purpose}-{uuid}`
- 录音存储路径含 tenant: `s3://recordings/{tenant_id}/{date}/{call_id}.mp4`

---

## 12. 部署检查清单（上线前）

- [ ] 所有环境变量已配置 (`.env.production`)
- [ ] RustPBX SIP trunk 运营商鉴权通过
- [ ] LiveKit external_ip 配置正确
- [ ] 防火墙开放：5060/udp, 5061/udp, 7881/udp, 10000-20000/udp, 3000/tcp, 7880/tcp
- [ ] SSL 证书配置（WebRTC 要求 HTTPS origin）
- [ ] MinIO bucket 创建 + 权限配置
- [ ] Redis 密码保护
- [ ] OPC API key 生成并分发
- [ ] 监控告警 webhook 配置 (Slack/企微)
- [ ] 合规录音提示音文件上传
- [ ] 压测通过 (100 并发语音 + 10 并发视频)
- [ ] 数据备份策略确认 (SQLite WAL + 定时 dump)
