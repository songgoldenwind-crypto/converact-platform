# Phase 0 — 基础设施搭建 · 细节设计

> 本文为 Phase 0 的模块级设计。每一节可作为独立的开发任务单元。
> 依赖文档：[`architecture-video-voice-callcenter.md`](./architecture-video-voice-callcenter.md)、[`implementation-spec.md`](./implementation-spec.md)

---

## 0. Phase 0 目标与验收

**交付目标**：6 个服务能以 Docker Compose 方式在一台机器上跑起来，并验证 RustPBX ↔ LiveKit SIP 桥接能双向传递音频。

**验收清单**（全部 pass 才算完成）：

| # | 项 | 验证命令/操作 | 预期 |
|---|---|---|---|
| 1 | OPC schema 含新表 | `npm run dev` → `SELECT name FROM sqlite_master` | 5 张新表 |
| 2 | call-router 返回合法 JSON | `curl -X POST localhost:3000/api/call-router -d '{...}'` | 200 + action 字段 |
| 3 | CDR webhook 入库 | `curl -X POST localhost:3000/api/webhooks/rustpbx-cdr -d '{...}'` | 200 |
| 4 | LiveKit webhook 不报错 | `curl -X POST localhost:3000/api/media/webhooks/livekit -d '{"event":"room_started",...}'` | 200 |
| 5 | seat CRUD | `POST /api/call-center/seats + GET` | 正确写入读出 |
| 6 | outbound task CRUD | `POST /api/call-center/outbound-tasks + GET` | pending 状态 |
| 7 | LiveKit token 可签发 | `GET /api/livekit/token?room_name=x&identity=y&role=agent` | JWT |
| 8 | Docker 全栈可启动 | `docker compose -f docker-compose.callcenter.yml up` | 0 crash |
| 9 | RustPBX console 可访问 | `curl localhost:8080/console` | HTML |
| 10 | SIP Trunk 互通 | RustPBX WebPhone 拨号 → LiveKit Room 有音频 | 双向听到声 |

---

## 1. 网络拓扑与端口布局

### 1.1 Docker Compose 网络

```
┌─────────────────────────────────────────────────────────────────┐
│                  docker network (bridge)                          │
│                                                                   │
│  ┌─────────┐  ┌──────────┐  ┌────────────┐  ┌─────────────────┐│
│  │  redis   │  │  minio   │  │  livekit   │  │  livekit-sip    ││
│  │  :6379   │  │ :9000/01 │  │ :7880/7881 │  │  :5061/udp      ││
│  └─────────┘  └──────────┘  └────────────┘  └─────────────────┘│
│                                                                   │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────┐             │
│  │ livekit-egress│  │   rustpbx   │  │    opc     │             │
│  │  (internal)   │  │ :5060 :8080 │  │   :3000    │             │
│  └──────────────┘  └─────────────┘  └────────────┘             │
│                                                                   │
│  ┌────────────┐                                                  │
│  │  ai-agent  │  (Phase 1 实际接入，Phase 0 只启动桩)            │
│  └────────────┘                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 服务间通信矩阵

| 源 → 目标 | 协议 | 端口 | 用途 |
|---|---|---|---|
| rustpbx → opc | HTTP POST | 3000 | call-router 回调 + CDR webhook |
| opc → rustpbx | HTTP/WS | 8080 | 管理 API + RWI |
| rustpbx → livekit-sip | SIP/RTP | 5061 + 50000-50100 | 音频桥接 |
| livekit-sip → livekit | gRPC over Redis | 6379 | 信令 + room join |
| livekit → opc | HTTP POST | 3000 | webhook events |
| opc → livekit | HTTP | 7880 | Room API + Token 验证 |
| livekit → redis | TCP | 6379 | 房间状态 + 消息总线 |
| livekit-egress → livekit | WebSocket | 7880 | 加入 Room 录制 |
| livekit-egress → minio | HTTP | 9000 | 上传录制文件 |
| ai-agent → livekit | WebSocket | 7880 | 加入 Room 发布音视频 |
| ai-agent → opc | HTTP | 3000 | 转接请求 + 状态上报 |

### 1.3 宿主机端口暴露

| 宿主端口 | 容器 | 必须暴露 | 原因 |
|---|---|---|---|
| 3000 | opc | ✅ | 开发调试 + 坐席面板访问 |
| 5060/udp+tcp | rustpbx | ✅ | PSTN trunk + 测试工具接入 |
| 5061/udp+tcp | livekit-sip | ✅ | RustPBX 到 SIP Bridge |
| 7880 | livekit | ✅ | WebRTC 客户端连接 |
| 7881/udp | livekit | ✅ | WebRTC media (UDP) |
| 8080 | rustpbx | ✅ | Web Console + RWI |
| 9000, 9001 | minio | 可选 | 录制文件管理 |
| 6379 | redis | 可选 | 本地调试 |

---

## 2. RustPBX 配置细节设计

### 2.1 配置文件结构 (`config/rustpbx.toml`)

```toml
#═══════════════════════════════════════════════
# 平台基础
#═══════════════════════════════════════════════
[platform]
http_addr = "0.0.0.0:8080"     # Web Console + API + RWI 共用端口
log_level = "info"

[platform.database]
url = "sqlite:///app/db/rustpbx.db"   # RustPBX 自身的数据（分机、CDR等）

#═══════════════════════════════════════════════
# SIP 代理核心
#═══════════════════════════════════════════════
[proxy]
bind_addr = "0.0.0.0:5060"     # SIP 信令监听
transports = ["udp", "tcp"]    # 不开 TLS/WSS（开发环境）

#═══════════════════════════════════════════════
# HTTP 路由器 — 每个 INVITE 回调 OPC
#═══════════════════════════════════════════════
[proxy.http_router]
url = "http://host.docker.internal:3000/api/call-router"
timeout_ms = 3000              # OPC 必须 3s 内响应
fallback_action = "reject"     # 超时/错误 → 拒绝来电

#═══════════════════════════════════════════════
# 媒体 RTP 配置
#═══════════════════════════════════════════════
[proxy.media]
rtp_start = 20000              # RTP 端口范围（RustPBX 自用）
rtp_end = 30000
# external_ip = "1.2.3.4"     # 生产时设置公网 IP

#═══════════════════════════════════════════════
# SIP Trunk — LiveKit SIP Bridge
# RustPBX 把需要 AI 处理的呼叫 forward 到这里
#═══════════════════════════════════════════════
[[proxy.trunks]]
name = "livekit-bridge"
host = "livekit-sip"           # docker compose service name
port = 5061
transport = "udp"

#═══════════════════════════════════════════════
# 队列 / ACD（人工坐席排队用）
#═══════════════════════════════════════════════
[proxy.queues.default]
strategy = "sequential"        # sequential | parallel | round_robin
timeout_sec = 30               # 振铃超时
hold_music = "/app/audio/hold.wav"

#═══════════════════════════════════════════════
# 录音
#═══════════════════════════════════════════════
[recording]
enabled = true
format = "wav"
storage = "local"
path = "/app/recordings"

#═══════════════════════════════════════════════
# CDR Webhook — 通话结束后推送
#═══════════════════════════════════════════════
[cdr]
webhook_url = "http://host.docker.internal:3000/api/webhooks/rustpbx-cdr"
```

### 2.2 HTTP Router 回调时序

```
     PSTN caller                RustPBX              OPC /api/call-router
         │                         │                         │
         ├── SIP INVITE ──────────►│                         │
         │                         │── POST {call_id,...} ──►│
         │                         │                         │── 路由决策
         │                         │◄── {action, targets} ───┤
         │                         │                         │
         │   (action=forward)      │                         │
         │                         ├── SIP INVITE ──► target │
         │◄── 180 Ringing ────────┤                         │
```

**超时行为**：
- OPC 3s 未响应 → RustPBX 给来电方 `486 Busy Here`
- OPC 返回 5xx → 同上
- OPC 返回非 JSON → 同上
- OPC 返回 `action=reject` → 使用返回的 `code` (默认 603)

### 2.3 CDR Webhook 时序

```
    RustPBX                    OPC /api/webhooks/rustpbx-cdr
       │                              │
       │ (call ends: BYE received)    │
       │── POST CDR JSON ────────────►│
       │                              │── upsert voice_call_sessions
       │                              │── insert call_recordings (如有)
       │                              │── update outbound_tasks (如匹配)
       │◄── 200 OK ──────────────────┤
```

**CDR 推送重试**：RustPBX 内置重试 3 次，间隔 5s/10s/30s。OPC 用 `rustpbx_call_id` UNIQUE 约束保证幂等。

---

## 3. LiveKit 配置细节设计

### 3.1 LiveKit Server (`config/livekit.yaml`)

```yaml
port: 7880                     # HTTP + WebSocket signaling
rtc:
  tcp_port: 7881              # WebRTC media over TCP fallback
  port_range_start: 50000     # UDP media ports
  port_range_end: 50100
  use_external_ip: false      # 开发环境用 docker bridge IP

redis:
  address: redis:6379         # 集群通信 + room state

keys:
  devkey: secret              # API Key: API Secret 键值对

webhook:
  api_key: devkey
  urls:
    - http://opc:3000/api/media/webhooks/livekit   # OPC Media Core 接收事件

room:
  empty_timeout: 300          # 空 Room 5 分钟后自动销毁
  max_participants: 10        # 每 Room 最多 10 人

logging:
  level: info
```

### 3.2 LiveKit SIP Bridge 配置

LiveKit SIP 服务通过 **环境变量** 配置（无 yaml）：

| 环境变量 | 值 | 说明 |
|---|---|---|
| `LIVEKIT_URL` | `ws://livekit:7880` | 连接主 LiveKit server |
| `LIVEKIT_API_KEY` | `devkey` | 认证 |
| `LIVEKIT_API_SECRET` | `secret` | 认证 |
| `SIP_PORT` | `5061` | SIP 信令监听端口 |

**SIP Trunk 创建**（通过 LiveKit API 或 CLI，Phase 0 验证步骤）：

```bash
# 创建 inbound trunk: 接受来自 RustPBX 的呼叫
lk sip trunk create \
  --name "rustpbx-inbound" \
  --inbound-addresses "rustpbx"

# 创建 dispatch rule: 来电按 call_id 进入独立 Room
lk sip dispatch-rule create \
  --name "default" \
  --rule-individual-room-prefix "call-"
```

### 3.3 LiveKit ↔ RustPBX SIP Trunk 互联数据流

```
┌────────────────┐          ┌──────────────────┐         ┌────────────────┐
│    RustPBX     │  SIP/RTP │  LiveKit SIP Svc  │  Redis  │  LiveKit SFU   │
│  (5060 UDP)    │◄────────►│   (5061 UDP)     │◄───────►│  (7880/7881)   │
└────────────────┘          └──────────────────┘         └────────────────┘
                                     │                           │
                                     │     participant join      │
                                     └──────────────────────────►│
                                                                 │
                                                           ┌─────┴─────┐
                                                           │ LiveKit   │
                                                           │ Room      │
                                                           │           │
                                                           │ [SIP Participant]
                                                           │ [AI Agent]
                                                           │ [坐席]
                                                           └───────────┘
```

**SIP 呼叫进入 LiveKit 的流程**：
1. RustPBX `forward` 到 `sip:x@livekit-sip:5061`
2. LiveKit SIP 收到 INVITE → 查 Dispatch Rule → 创建/加入 Room `call-{id}`
3. 音频双向流：RTP (RustPBX ↔ SIP Svc) + WebRTC (SIP Svc ↔ Room participants)

**编解码协商**：
- RustPBX ↔ LiveKit SIP: `PCMU` (G.711 μ-law) — 最大兼容性
- LiveKit SIP ↔ Room: 内部 Opus 转码
- Room ↔ 客户端: Opus

---

## 4. OPC Call Router 模块设计

### 4.1 模块职责

`src/agent-runtime/call-center/call-router.ts`

接收 RustPBX 的每一通来电路由请求，返回决策。**无副作用**（不写 DB），保证 < 50ms 响应。

### 4.2 决策树

```
decideCallRoute(request):
  │
  ├── direction == 'outbound'?
  │   └── YES → forward to livekit-bridge (AI Agent 处理)
  │             metadata: { call_id, direction, outbound_task_id? }
  │
  └── direction == 'inbound'
      │
      ├── 提取 tenant_id (header > default)
      │   └── null → reject 603 "missing tenant"
      │
      ├── 查 idle seats count
      │   ├── > 0 → queue "default" (RustPBX ACD 派发给坐席)
      │   └── == 0 → forward to livekit-bridge (AI Agent 接待)
      │
      └── (Future: 黑名单/时段/VIP 规则)
```

### 4.3 接口约定

**输入** (RustPBX POST body):
```json
{
  "call_id": "550e8400-e29b-41d4-a716-446655440000",
  "from_uri": "sip:+81312345678@trunk.twilio.com",
  "to_uri": "sip:+81398765432@pbx.local",
  "from_display": "田中太郎",
  "direction": "inbound",
  "transport": "udp",
  "trunk_name": "twilio-japan",
  "headers": {
    "X-Tenant-Id": "tenant_abc123"
  },
  "timestamp": "2026-06-15T18:30:00Z"
}
```

**输出** (OPC 响应):
```json
{
  "action": "forward",
  "targets": ["sip:livekit-bridge@livekit-sip:5061"],
  "record": true,
  "timeout_sec": 30,
  "metadata": {
    "call_id": "550e8400-...",
    "direction": "inbound",
    "tenant_id": "tenant_abc123",
    "routed_to": "ai_agent"
  }
}
```

### 4.4 性能要求

- 响应时间 p99 < 50ms（不查 DB 复杂表，seat 数量预期 < 100）
- 无状态：每次请求独立查询当前 seat 状态
- 幂等：同一 call_id 重复请求（RustPBX retry）返回相同结果

---

## 5. CDR Receiver 模块设计

### 5.1 模块职责

`src/agent-runtime/call-center/cdr-receiver.ts`

接收 RustPBX 通话结束时推送的 CDR，更新 `voice_call_sessions` + `call_recordings` + `outbound_tasks`。

### 5.2 处理流程

```
ingestRustpbxCdr(cdr):
  │
  ├── 1. 解析 tenant_id (cdr.metadata.tenant_id || default)
  │
  ├── 2. 用 cdr.call_id 查找已有 voice_call_sessions
  │   ├── 找到 → 更新状态为 completed/failed
  │   └── 未找到 → 创建新 session (orphan CDR 补偿)
  │
  ├── 3. 判断 answered?
  │   ├── YES (answer_time != null) → status = completed
  │   └── NO → status = failed (missed)
  │
  ├── 4. 有 recording_url?
  │   └── YES → INSERT call_recordings (source=rustpbx_sipflow)
  │
  └── 5. 有 metadata.outbound_task_id?
      └── YES → 更新 outbound_tasks:
          ├── answered → status=completed
          └── not answered → attempt_count++
              ├── < max_attempts → status=pending (待重试)
              └── >= max_attempts → status=failed (永久失败)
```

### 5.3 CDR 幂等保证

- `voice_call_sessions` 通过 `rustpbx_call_id` 唯一查找
- 同一 call_id 的 CDR 重复到达时：update 已有记录（覆盖写），不会重复创建
- `call_recordings` 通过 call_session_id + source 去重（同一 session 只有一条 rustpbx_sipflow 记录）

### 5.4 CDR 丢失补偿策略

Phase 0 暂不实现定时补偿。Phase 4 生产加固阶段增加：

```
每 5 分钟扫描:
  SELECT * FROM voice_call_sessions
  WHERE status = 'active'
    AND started_at < datetime('now', '-10 minutes')
```

找到后主动查 RustPBX API `/api/calls/{rustpbx_call_id}` 获取最终状态。

---

## 6. Agent Seat Store 模块设计

### 6.1 模块职责

`src/agent-runtime/call-center/seat-store.ts`

管理坐席的注册、状态变更、技能匹配查询。

### 6.2 数据模型

```sql
agent_seats:
  id            TEXT PRIMARY KEY     -- "seat_xxx"
  tenant_id     TEXT NOT NULL        -- 租户隔离
  user_id       TEXT NOT NULL        -- 用户标识 (UNIQUE per tenant)
  display_name  TEXT NOT NULL        -- 显示名
  status        TEXT                 -- offline | idle | busy | break
  skills        TEXT (JSON array)    -- ["japanese", "chinese", "real_estate"]
  current_call_session_id TEXT       -- 正在处理的通话
  livekit_identity TEXT              -- LiveKit participant identity
  rustpbx_extension TEXT             -- RustPBX 分机号
  last_heartbeat_at TEXT             -- 最后心跳时间
```

### 6.3 状态转换规则

```
offline ──[login/heartbeat]──► idle
idle    ──[assigned call]────► busy
busy    ──[call ended]───────► idle
idle    ──[manual break]─────► break
break   ──[resume]───────────► idle
*       ──[heartbeat timeout]► offline (60s 无心跳)
*       ──[explicit logout]──► offline
```

**心跳机制**：
- 前端每 15s POST `/api/call-center/seats/:id/heartbeat`
- OPC 更新 `last_heartbeat_at`
- 若 60s 无心跳 → 自动切 offline（Phase 0 不实现自动扫描，Phase 4 加定时任务）

### 6.4 坐席选择算法

```typescript
findAvailableSeat(tenantId, requiredSkills):
  1. SELECT * WHERE tenant_id=? AND status='idle'
  2. 若 requiredSkills 非空 → 过滤: seat.skills 必须包含全部 required
  3. 返回第一个匹配的 (Phase 0 简单 FIFO)
  4. Phase 3 扩展为 least_recent_call / round_robin / skill_priority
```

---

## 7. Outbound Task Store 模块设计

### 7.1 模块职责

`src/agent-runtime/call-center/outbound-task-store.ts`

外呼任务的 CRUD 和状态管理。Phase 0 只提供存储层，Phase 1 加上 Dialer 定时拾取。

### 7.2 任务生命周期

```
创建 → pending
        │
        ├── Dialer 拾取 (Phase 1)
        │   └── dialing → connected → completed
        │                         └── failed (达到 max_attempts)
        │
        └── 手动取消 → cancelled
```

### 7.3 拾取查询（Phase 1 Dialer 使用）

```sql
SELECT * FROM outbound_tasks
WHERE tenant_id = ?
  AND status = 'pending'
  AND (scheduled_at IS NULL OR scheduled_at <= datetime('now'))
ORDER BY priority DESC, created_at ASC
LIMIT ?
```

**并发安全**：Phase 1 使用 Redis SETNX 锁 `task:{id}:lock` (TTL 60s)。Phase 0 不涉及并发拾取。

### 7.4 重试策略

| hangup_cause | 等待时间 | 说明 |
|---|---|---|
| `no_answer` | 30s | 对方没接 |
| `busy` | 30s | 占线 |
| `reject` / `decline` | 2 小时 | 被拒 |
| `invalid_number` | 不重试 | 号码无效 |
| `network_error` | 60s | 网络问题 |

Phase 0 仅在 CDR 入库时 `attempt_count++` + 重置 status 为 pending；不实现延迟等待（Phase 1 Dialer 在拾取时检查 `updated_at` 距当前的间隔）。

---

## 8. LiveKit Room Store 模块设计

### 8.1 模块职责

`src/agent-runtime/livekit/room-store.ts`

管理 LiveKit Room 在 OPC 侧的注册表。Room 创建/激活/关闭的生命周期。

### 8.2 Room 命名规范

```
{tenant_id}-{purpose}-{random8}
```

例：`tenant_abc-ai_outbound-k7f2m9x1`

**原因**：
- `tenant_id` 前缀方便日志过滤和权限校验
- `purpose` 便于 Dashboard 统计
- 8 位随机避免冲突

### 8.3 Room Purpose 枚举

| purpose | 场景 | 典型参与者 |
|---|---|---|
| `ai_outbound` | AI 视频外呼（发 SMS 链接） | AI Agent + 客户 |
| `pstn_bridge` | PSTN 语音桥接到 LiveKit | SIP participant + AI Agent |
| `video_service` | 客户主动发起视频咨询 | 客户 + 坐席 |
| `screen_share` | 坐席屏幕共享演示 | 坐席 + 客户 |
| `conference` | 多方会议 | 多坐席 + 客户 |

### 8.4 Room 与 Call Session 的关联

```
voice_call_sessions.livekit_room_name ──► livekit_rooms.room_name
livekit_rooms.call_session_id ──────────► voice_call_sessions.id
```

**双向关联**：
- 创建 Room 时，如果指定 `call_session_id` → 同步更新 session 的 `livekit_room_name`
- LiveKit webhook `room_finished` → 关闭 Room 记录

### 8.5 LiveKit Server SDK 调用

```typescript
// 连接 LiveKit Server
const client = new RoomServiceClient(url, apiKey, apiSecret);

// 创建 Room
await client.createRoom({
  name: roomName,
  emptyTimeout: 300,            // 空 Room 5 分钟销毁
  metadata: JSON.stringify({...})
});

// 删除 Room (cleanup)
await client.deleteRoom(roomName);
```

**降级**：若 `LIVEKIT_URL` 未配置 → `createLiveKitRoomClient()` 返回 null → 不调用 LiveKit API，仅写本地 DB。开发时可以不启动 LiveKit 容器也能运行 OPC。

---

## 9. LiveKit Token Service 模块设计

### 9.1 模块职责

`src/agent-runtime/livekit/token-service.ts`

为前端（坐席面板 / 客户 H5）签发加入 LiveKit Room 的 JWT token。

### 9.2 Token 权限模型

| 角色 | canPublish | canSubscribe | canPublishData | TTL |
|------|-----------|-------------|----------------|-----|
| `agent` (坐席) | ✅ audio+video | ✅ | ✅ | 30 min |
| `customer` (客户) | ✅ audio+video | ✅ | ❌ | 30 min |

### 9.3 Token Metadata

每个 token 的 `metadata` 字段包含：
```json
{
  "tenant_id": "tenant_abc",
  "role": "agent"
}
```

AI Agent 和其他 Room participant 可以读取此 metadata 做身份判断。

### 9.4 降级模式

未配置 LiveKit API Key/Secret 时 → 返回 dev token:
```
dev-token:{room_name}:{identity}:{role}
```

前端收到 `configured: false` 时显示 "LiveKit 未连接" 提示，不实际连接 WebRTC。

---

## 10. LiveKit Webhook Handler 模块设计

### 10.1 模块职责

`src/agent-runtime/livekit/webhook-handler.ts`

接收 LiveKit Server 推送的事件，更新 OPC 数据。

### 10.2 验签

LiveKit webhook 请求带 `Authorization` header，使用 HMAC-SHA256 签名。OPC 用 `WebhookReceiver` 验证：

```typescript
const receiver = new WebhookReceiver(apiKey, apiSecret);
const event = await receiver.receive(rawBody, authHeader);
```

**降级**：API Key 未配置 → 跳过验签，直接 JSON.parse。仅允许开发环境。

### 10.3 事件处理表

| event | OPC 动作 |
|---|---|
| `room_started` | `livekit_rooms.status = 'active'`，更新 `room_sid` |
| `room_finished` | `livekit_rooms.status = 'closed'`，`closed_at = now` |
| `participant_joined` | (Phase 0: 仅日志) |
| `participant_left` | (Phase 0: 仅日志) |
| `track_published` | (Phase 0: 忽略) |
| `egress_started` | (Phase 0: 忽略) |
| `egress_ended` | 写入 `call_recordings` (source=livekit_egress) |

### 10.4 Egress 录制入库逻辑

```
egress_ended:
  1. 从 event 提取 room.name
  2. 查 livekit_rooms → 获取 call_session_id
  3. 提取 fileResults[0]:
     - location → storage_url
     - duration → duration_ms
     - size → file_size_bytes
     - fileType → format
  4. INSERT call_recordings (has_video=1, source=livekit_egress)
```

---

## 11. Schema 迁移设计

### 11.1 新增表

| 表名 | 行数估算 (Phase 0) | 主索引策略 |
|---|---|---|
| `livekit_rooms` | < 100 | `room_name` UNIQUE + `tenant_id, status` |
| `call_recordings` | < 100 | `call_session_id` + `created_at DESC` |
| `ai_conversation_turns` | < 1000 | `call_session_id, turn_index` |
| `agent_seats` | < 20 | `tenant_id, user_id` UNIQUE |
| `outbound_tasks` | < 500 | `tenant_id, status, priority DESC, created_at ASC` |

### 11.2 现有表扩展

`voice_call_sessions` 新增 6 列：

| 列 | 类型 | 默认值 | 用途 |
|---|---|---|---|
| `media_type` | TEXT | `'audio'` | audio / video / audio_to_video |
| `livekit_room_name` | TEXT | `''` | 关联 LiveKit Room |
| `livekit_room_sid` | TEXT | `''` | LiveKit Room SID |
| `transfer_chain` | TEXT (JSON) | `'[]'` | 转接历史 |
| `ai_handled` | INTEGER | 0 | 是否有 AI 参与 |
| `transferred` | INTEGER | 0 | 是否发生过转接 |

### 11.3 迁移安全性

- 使用 `ALTER TABLE ADD COLUMN ... DEFAULT` — SQLite 支持，不锁表
- 新表用 `CREATE TABLE IF NOT EXISTS` — 幂等
- 在 `db.ts` 的 `migrateCallCenterSchema()` 中执行
- 列存在性检测通过 `PRAGMA table_info` — 不会重复添加

---

## 12. HTTP 路由挂载设计

### 12.1 架构

```
http.ts (主路由文件)
  │
  ├── /api/webhooks/wecom → 原有 WeChat handler
  │
  ├── routeCallCenterApi() ← call-center-http.ts (新)
  │   ├── /api/call-router
  │   ├── /api/webhooks/rustpbx-cdr
  │   ├── /api/media/webhooks/livekit
  │   ├── /api/livekit/*
  │   └── /api/call-center/*
  │
  └── ...原有路由继续...
```

### 12.2 设计原则

- `call-center-http.ts` 是**纯路由分发**层，不含业务逻辑
- 业务逻辑全在 `application.ts`（Command pattern）
- `routeCallCenterApi` 返回 `undefined` 表示"没匹配到"，主路由继续尝试后续规则
- rawBody 传递：webhook 端点需要原始字符串做签名验证

### 12.3 认证设计

| 端点 | 认证方式 | 实现 |
|---|---|---|
| `/api/call-router` | `X-PBX-Key` header | `verifyRustpbxWebhookKey()` |
| `/api/webhooks/rustpbx-cdr` | `X-PBX-Key` header | 同上 |
| `/api/media/webhooks/livekit` | `Authorization` header (HMAC) | `WebhookReceiver` |
| `/api/call-center/*` | (Phase 0: 无认证) | Phase 3 加 seat JWT |
| `/api/livekit/token` | (Phase 0: 无认证) | Phase 3 加坐席登录态 |

---

## 13. Docker Compose 设计细节

### 13.1 启动顺序

```
redis → livekit → livekit-sip → livekit-egress → rustpbx → opc → ai-agent
```

使用 `depends_on` 保证顺序，但不做健康检查（Phase 0 简化）。

### 13.2 数据持久化

| Volume | 挂载到 | 数据内容 |
|---|---|---|
| `redis_data` | redis:/data | 缓存（丢失无影响） |
| `minio_data` | minio:/data | 录音录像文件 |
| `rustpbx_data` | rustpbx:/app/db | PBX 配置和 CDR |
| `rustpbx_recordings` | rustpbx:/app/recordings | 音频录音 |
| `opc_data` | opc:/data | SQLite 业务数据 |

### 13.3 环境变量模板

`.env` 文件（开发环境）：
```env
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
LIVEKIT_SIP_BRIDGE_TARGET=sip:livekit-bridge@livekit-sip:5061
RUSTPBX_WEBHOOK_KEY=dev-pbx-key
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
OPC_API_KEY=dev-opc-key
```

### 13.4 Host Network 问题

**开发环境**：不用 `network_mode: host`。用 Docker 默认 bridge + 端口映射。

**原因**：macOS Docker Desktop 不支持 host network；bridge 模式通过 `host.docker.internal` 让容器访问宿主机 OPC（开发模式 OPC 跑在宿主机上）。

**生产环境**：Linux 下 RustPBX 和 LiveKit 使用 `network_mode: host`（SIP/RTP 需要宽端口范围）。

---

## 14. 开发调试工具清单

### 14.1 SIP 测试

| 工具 | 用途 | 安装 |
|---|---|---|
| `sipsak` | SIP OPTIONS 探测 | `brew install sipsak` |
| `SIPp` | SIP 压测/模拟来电 | `brew install sipp` |
| RustPBX WebPhone | 内建浏览器软电话 | 访问 `http://localhost:8080/console` |

### 14.2 LiveKit 测试

| 工具 | 用途 | 安装 |
|---|---|---|
| `lk` (LiveKit CLI) | 创建 Room/加入/trunk 管理 | `brew install livekit-cli` |
| LiveKit Meet | 浏览器加入 Room 调试 | `https://meet.livekit.io` (指向本地) |

### 14.3 API 测试

```bash
# call-router 测试
curl -s -X POST http://localhost:3000/api/call-router \
  -H "Content-Type: application/json" \
  -H "X-PBX-Key: dev-pbx-key" \
  -d '{
    "call_id": "test-001",
    "from_uri": "sip:+81311112222@trunk",
    "to_uri": "sip:+81333334444@pbx",
    "direction": "inbound",
    "headers": {}
  }' | jq .

# CDR 测试
curl -s -X POST http://localhost:3000/api/webhooks/rustpbx-cdr \
  -H "Content-Type: application/json" \
  -H "X-PBX-Key: dev-pbx-key" \
  -d '{
    "call_id": "test-001",
    "direction": "inbound",
    "start_time": "2026-06-15T10:00:00Z",
    "answer_time": "2026-06-15T10:00:05Z",
    "end_time": "2026-06-15T10:03:00Z",
    "duration_sec": 175,
    "hangup_cause": "normal_clearing",
    "metadata": {}
  }' | jq .

# 创建坐席
curl -s -X POST http://localhost:3000/api/call-center/seats \
  -H "Content-Type: application/json" \
  -d '{"tenant_id":"t1","user_id":"u1","display_name":"Agent 1","skills":["japanese"]}' | jq .

# 创建外呼任务
curl -s -X POST http://localhost:3000/api/call-center/outbound-tasks \
  -H "Content-Type: application/json" \
  -d '{
    "tenant_id": "t1",
    "phone_number": "+81312345678",
    "channel": "pstn_voice",
    "strategy": {"script_id": "demo", "language": "ja"}
  }' | jq .

# 获取 token
curl -s "http://localhost:3000/api/livekit/token?room_name=test-room&identity=agent1&role=agent" | jq .
```

---

## 15. Phase 0 → Phase 1 衔接点

Phase 0 完成后，Phase 1 需要新增的模块和能力：

| Phase 1 模块 | 依赖 Phase 0 | 新增内容 |
|---|---|---|
| `rwi-client.ts` | RustPBX 已运行 | WebSocket 连接 + originate/transfer/hangup |
| `outbound-dialer.ts` | outbound-task-store | 定时器 + Redis 锁 + RWI 调用 |
| `ai-agent-py` 完整版 | LiveKit + Room | STT→LLM→TTS + function calling |
| CDR 实时更新 | cdr-receiver | event 类型扩展 (answered → active) |
| Transfer orchestrator | seat-store + room-store | AI → OPC → RWI transfer |

**Phase 0 留给 Phase 1 的接口契约**：
- `/api/call-router` 的 metadata 中 `outbound_task_id` — Dialer 写入，CDR 读取
- `outbound_tasks.status` 状态机 — Dialer 驱动
- `livekit_rooms.room_name` 格式 — AI Agent 通过 room metadata 获取上下文
- `ai_conversation_turns` 表 — AI Agent 写入，坐席面板读取
