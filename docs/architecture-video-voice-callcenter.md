# Converact Platform 视频+语音呼叫中心 — 整体架构设计

> **2026-07-29 权威性修订：** 本文保留为视频/产品历史设计；所有把 RustPBX direct
> media proxy 画成 ordinary 生产数据面、删除 `services/voice-media-rs` 或由 LiveKit
> 完全接管语音处理的旧裁决均已废止。LiveKit 继续负责视频/SFU；`voice-media-rs` 是
> 现有 repo-local Rust crate/module，目标为 Unified RustPBX Process 内嵌的解码媒体
> Backend。普通 RTP Edge 默认由外部 RTPengine 执行。生产权威以
> `docs/design/rvoip-converact-communication-foundation-integration-design.md` 和
> `docs/adr/ccaas-5-media-authority-and-rtpengine.md` 为准。

> **软交换**: [RustPBX](https://github.com/restsend/rustpbx)（AI-native Rust PBX, HTTP/WebSocket/Webhook 全可编程）
> **视频服务**: [LiveKit](https://github.com/livekit/livekit)（开源 WebRTC SFU, 自托管）
> **业务核心**: Converact Platform（获客 Agent + CRM + 审批 + 记忆系统）

---

## 1. 架构总览

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           前端层 (Frontend)                              │
│                                                                         │
│  ┌──────────────────────┐         ┌──────────────────────────────────┐ │
│  │   坐席面板 (React)    │         │   客户端 (H5 / Mobile App)       │ │
│  │   @livekit/components │         │   LiveKit JS/Swift/Android SDK  │ │
│  │   + RustPBX WebPhone  │         │   + 同意弹窗 + 录音录像告知     │ │
│  └──────────────────────┘         └──────────────────────────────────┘ │
└────────────────┬──────────────────────────────────┬────────────────────┘
                 │ WebRTC                            │ WebRTC
                 ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          媒体层 (Media Plane)                            │
│                                                                         │
│  ┌──────────────────────────┐       ┌────────────────────────────────┐ │
│  │       LiveKit SFU         │       │         RustPBX                │ │
│  │  ┌────────────────────┐  │       │  ┌──────────────────────────┐ │ │
│  │  │ Room Management    │  │  SIP  │  │ SIP Proxy (B2BUA)       │ │ │
│  │  │ Video/Audio Tracks │◄─┼───────┼──┤ Media Proxy (RTP)       │ │ │
│  │  │ Screen Share       │  │ Trunk │  │ Queue / ACD             │ │ │
│  │  │ Egress (Recording) │  │       │  │ SipFlow Recording       │ │ │
│  │  │ SIP Bridge Service │──┼───────┼─►│ HTTP Router             │ │ │
│  │  └────────────────────┘  │       │  │ RWI (WebSocket)         │ │ │
│  │                          │       │  │ CDR Webhooks            │ │ │
│  └──────────────────────────┘       └──┴──────────────────────────┘─┘ │
│                                                                         │
│  ┌───────────────────────┐                                             │
│  │   Redis (共享总线)     │ ← LiveKit 内部通信 + SIP 会话状态           │
│  └───────────────────────┘                                             │
└────────────────┬──────────────────────────────────┬────────────────────┘
                 │                                  │
                 ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      AI & 业务控制层 (Control Plane)                     │
│                                                                         │
│  ┌─────────────────────┐  ┌────────────────┐  ┌─────────────────────┐ │
│  │   LiveKit AI Agent   │  │  Call Control   │  │    Converact Platform Core         │ │
│  │   (Python/Node.js)   │  │  Service (TS)   │  │                     │ │
│  │                      │  │                 │  │  Lead Acquisition   │ │
│  │  ┌───────────────┐  │  │  HTTP Router ←──┼──┤  Prospect Outreach  │ │
│  │  │ VAD (Silero)  │  │  │  Handler        │  │  Memory System      │ │
│  │  │ STT (Deepgram)│  │  │                 │  │  Approval Queue     │ │
│  │  │ LLM (GPT/Claude)│ │  RWI Client ─────┼──┤  VoiceStore         │ │
│  │  │ TTS (Cartesia)│  │  │                 │  │  Analytics / CDR    │ │
│  │  │ Avatar (Video)│  │  │  CDR Webhook ←──┼──┤  Script Engine      │ │
│  │  └───────────────┘  │  │  Receiver       │  │  Tenant / RBAC      │ │
│  └─────────────────────┘  └────────────────┘  └─────────────────────┘ │
└────────────────┬──────────────────────────────────┬────────────────────┘
                 │                                  │
                 ▼                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         数据层 (Data Plane)                              │
│                                                                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ SQLite/  │  │  Redis   │  │   S3 /   │  │  Vector DB (optional) │  │
│  │ Postgres │  │  (cache  │  │   MinIO  │  │  (memory embeddings)  │  │
│  │ (业务)   │  │  + pub)  │  │ (录音录像)│  │                       │  │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心组件职责划分

### 2.1 RustPBX — 软交换（语音主引擎）

| 职责 | 说明 |
|------|------|
| **SIP 信令** | 全栈 SIP (UDP/TCP/WS/TLS/WebRTC)，管理注册、认证、B2BUA |
| **PSTN 对接** | SIP Trunk 连接运营商（Twilio Japan / NTT / Telnyx） |
| **呼叫路由** | HTTP Router — 每个 INVITE 回调 Converact Platform，Converact Platform 返回 JSON 路由决策 |
| **队列 / ACD** | 坐席排队、优先级调度、顺序/并行振铃 |
| **实时控制 (RWI)** | WebSocket JSON 接口：外呼、转接、Hold、Whisper、Barge、PCM 注入 |
| **纯语音录音** | SipFlow 统一 SIP+RTP 采集，CDR 推送 |
| **WebRTC 网关** | 坐席 WebRTC 软电话直连 RustPBX（纯语音场景） |

**不负责**：视频处理、房间管理、屏幕共享 — 这些交给 LiveKit。

### 2.2 LiveKit — 视频服务（WebRTC SFU）

| 职责 | 说明 |
|------|------|
| **视频房间** | 创建/管理多人视频房间，选择性转发（SFU） |
| **SIP Bridge** | 接收来自 RustPBX 的 SIP 呼叫，将 PSTN 音频桥接到 LiveKit Room |
| **AI Agent Host** | LiveKit Agents 框架承载 AI 语音/视频代理 |
| **Egress** | 录制 Room 为 MP4/WebM，输出到 S3/MinIO |
| **屏幕共享** | 坐席向客户演示文档、系统界面 |
| **Token 签发** | JWT token 控制 Room 加入权限、轨道发布权限 |

**不负责**：呼叫路由决策、坐席排队、SIP 外呼发起 — 这些交给 RustPBX。

### 2.3 Converact Platform Core — 业务控制中心

| 职责 | 说明 |
|------|------|
| **路由决策** | 接收 RustPBX HTTP Router 回调，返回 AI/人工/队列/拒绝 |
| **呼叫控制编排** | 通过 RWI 发起外呼、转接、Hold；通过 LiveKit API 创建 Room |
| **坐席状态管理** | 在线/忙/空闲/离开，技能路由 |
| **AI 脚本引擎** | 生成对话策略、意向评分规则、话术变体 |
| **获客主链** | Lead Acquisition → Prospect Outreach → 触达执行 |
| **CDR 入库** | 接收 RustPBX CDR webhook + LiveKit Room events → 统一通话记录 |
| **审批 / 合规** | 高风险通话审批、录音同意管理 |

---

## 3. 关键集成点

### 3.1 RustPBX ↔ LiveKit（SIP Trunk 互联）

```
                    SIP Trunk (Audio)
    ┌──────────┐ ◄──────────────────► ┌──────────────┐
    │ RustPBX  │                      │ LiveKit SIP  │
    │ B2BUA    │   INVITE / BYE /     │ Bridge       │
    │          │   RTP Audio Stream   │              │
    └──────────┘                      └──────────────┘
         │                                   │
         │ (manages PSTN trunk)              │ (puts caller into Room)
         ▼                                   ▼
    PSTN / 运营商                         LiveKit Room
                                         (AI Agent + 坐席)
```

**配置关系**：
- RustPBX 中配置 LiveKit SIP Bridge 地址为一个 SIP Trunk peer
- LiveKit SIP 中配置 `SIP Trunk` 指向 RustPBX 的 IP（反向 outbound）
- LiveKit `Dispatch Rule` 根据被叫号码、来电号码决定加入哪个 Room

**关键流程**：当需要把纯语音通话升级到视频，RustPBX 通过 `transfer` 命令将呼叫 REFER 到 LiveKit SIP Bridge 地址，客户音频进入 LiveKit Room，然后坐席面板发送视频链接给客户。

### 3.2 RustPBX ↔ Converact Platform（HTTP Router + RWI + Webhook）

```
                  ┌─────────────┐
                  │   RustPBX   │
                  └──────┬──────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
    HTTP Router      RWI (WS)      CDR Webhook
    (每个INVITE)    (实时控制)      (通话结束)
          │              │              │
          ▼              ▼              ▼
      ┌─────────────────────────────────────┐
      │           Converact Platform Call Control           │
      │   POST /api/call-router             │
      │   WS   /api/call-control/rwi        │
      │   POST /api/webhooks/rustpbx-cdr    │
      └─────────────────────────────────────┘
```

**HTTP Router 回调格式**（RustPBX → Converact Platform）：
```json
{
  "call_id": "uuid",
  "from": "sip:+81312345678@trunk",
  "to": "sip:+81398765432@pbx",
  "headers": { "X-Tenant-Id": "tenant_abc" }
}
```

**Converact Platform 路由响应**：
```json
{
  "action": "forward",
  "targets": ["sip:ai-agent@livekit-sip"],
  "record": true,
  "metadata": { "run_id": "lead-run-123", "intent": "outbound-qualification" }
}
```

### 3.3 LiveKit ↔ Converact Platform（Server SDK + Webhooks）

```
Converact Platform (Node.js)                             LiveKit Server
     │                                         │
     ├── CreateRoom(name, options) ───────────►│
     ├── GenerateToken(identity, grants) ─────►│
     ├── ListParticipants(room) ──────────────►│
     │                                         │
     │◄── Webhook: participant_joined ─────────┤
     │◄── Webhook: track_published ────────────┤
     │◄── Webhook: room_finished ──────────────┤
     │◄── Webhook: egress_ended ───────────────┤
```

**Converact Platform 使用 `livekit-server-sdk-js`**：
- 创建房间、生成 JWT token
- 管理 AI Agent dispatch
- 接收 LiveKit webhook events → 更新 VoiceStore

---

## 4. 核心通话流程

### 4.1 AI 视频外呼（核心差异化场景）

> 客户收到链接 → 打开 H5 → 与 AI 数字人视频对话 → 高意向转人工

```
┌─────┐        ┌─────┐       ┌────────┐      ┌────────┐      ┌──────────┐
│ Converact Platform │        │RustPBX│     │LiveKit │      │AI Agent│      │ Customer │
└──┬──┘        └──┬───┘     └───┬────┘      └───┬────┘      └────┬─────┘
   │               │             │               │                │
   │ 1. 触发外呼任务│             │               │                │
   ├──────────────►│             │               │                │
   │               │ 2. originate│(SMS/WeChat)   │                │
   │               ├─────────────┼───────────────┼───────────────►│
   │               │             │               │         3. 客户点击 H5 链接
   │               │             │ 4. join Room   │                │
   │               │             │◄───────────────┼────────────────┤
   │               │             │               │                │ (WebRTC)
   │ 5. dispatch AI Agent        │               │                │
   ├─────────────────────────────┼──────────────►│                │
   │               │             │ 6. AI publishes│video + audio   │
   │               │             │◄──────────────┤                │
   │               │             │ 7. media relay │                │
   │               │             ├───────────────┼───────────────►│
   │               │             │               │      8. 对话中(STT→LLM→TTS)
   │               │             │               │◄───────────────┤
   │               │             │               ├───────────────►│
   │               │             │               │                │
   │               │             │    9. 高意向 → 转人工           │
   │◄──────────────┼─────────────┼───────────────┤                │
   │ 10. 找空闲坐席│             │               │                │
   ├──────────────►│             │               │                │
   │               │ 11. 通知坐席加入 Room        │                │
   │               │             │◄──────────────┼────(坐席 React面板)
   │               │             │ 12. 坐席接管   │                │
   │               │             ├───────────────┼───────────────►│
```

**关键点**：
- 步骤 2 可以是 SMS 发链接（日本）或 WeChat 消息发链接（国内）
- AI Agent 通过 LiveKit Agents 框架加入 Room，发布数字人视频轨道 + TTS 音频轨道
- 转人工时 AI Agent 退出、坐席加入同一 Room，客户无感切换

### 4.2 AI 语音外呼（PSTN 传统电话）

> RustPBX 外呼 → AI 实时对话 → 高意向转坐席

```
┌─────┐        ┌─────┐       ┌────────┐      ┌──────────┐
│ Converact Platform │        │RustPBX│     │LiveKit │      │ Customer │
└──┬──┘        └──┬───┘     └───┬────┘      └────┬─────┘
   │               │             │                │
   │ 1. RWI:originate            │                │
   ├──────────────►│             │                │
   │               │ 2. SIP INVITE (PSTN)         │
   │               ├─────────────┼───────────────►│
   │               │             │    3. 接听      │
   │               │◄────────────┼────────────────┤
   │               │             │                │
   │               │ 4. Bridge audio to LiveKit SIP│
   │               ├────────────►│                │
   │               │   (SIP Trunk)│               │
   │               │             │ 5. AI Agent in Room
   │               │             │    STT→LLM→TTS │
   │               │             │───audio────────┤
   │               │             │◄──audio────────┤
   │               │             │                │
   │               │  6. 意向判定高│→ 坐席接管      │
   │               │◄────────────┤                │
   │ 7. RWI:transfer             │                │
   ├──────────────►│             │                │
   │               │ 8. 坐席接听 (WebRTC/SIP)     │
   │               ├─────────────┼───────────────►│
```

**关键点**：
- 纯语音场景也经过 LiveKit Room，这样 AI Agent 可以复用同一套 STT/LLM/TTS 管道
- 如果客户在 PSTN 上且想要升级到视频 → Converact Platform 发 SMS 链接，客户打开 H5 后加入同一 Room

### 4.3 客户来电（Inbound）

```
Customer → PSTN → SIP Trunk → RustPBX → HTTP Router → Converact Platform 决策:
  ├── AI 接待 → Bridge to LiveKit Room (AI Agent)
  ├── 人工队列 → RustPBX Queue/ACD → 坐席接听
  └── IVR → RustPBX play prompts → 按键分流
```

### 4.4 视频客服（客户主动发起）

```
Customer → 点击网页/App "视频咨询" 按钮
  → Converact Platform 创建 LiveKit Room + 生成 Token
  → Customer WebRTC 加入 Room
  → Converact Platform 通知空闲坐席 → 坐席面板加入 Room
  → 视频通话开始
  → Egress 自动录制
```

---

## 5. 组件部署架构

### 5.1 Docker Compose（历史示意；生产以 `infra/livekit/` 为准）

```yaml
services:
  # --- 媒体层 ---
  rustpbx:
    image: ghcr.io/restsend/rustpbx:latest
    network_mode: host              # SIP/RTP 需要 host network
    volumes:
      - ./config/rustpbx.toml:/app/rustpbx.toml
      - ./data/recordings:/app/recordings
    environment:
      - DATABASE_URL=postgresql://opc:${POSTGRES_PASSWORD}@postgres:5432/opc

  livekit:
    image: ghcr.io/songgoldenwind-crypto/converact-livekit-server@sha256:<digest>
    network_mode: host              # WebRTC 需要 host network
    volumes:
      - ./config/livekit.yaml:/etc/livekit.yaml
    command: --config /etc/livekit.yaml

  livekit-sip:
    image: ghcr.io/songgoldenwind-crypto/converact-livekit-sip@sha256:<digest>
    network_mode: host
    environment:
      - LIVEKIT_URL=ws://localhost:7880
      - LIVEKIT_API_KEY=${LK_API_KEY}
      - LIVEKIT_API_SECRET=${LK_API_SECRET}
      - SIP_PORT=5061                # 避免和 RustPBX 5060 冲突

  livekit-egress:
    image: livekit/egress:v1.13.0
    environment:
      - EGRESS_CONFIG_FILE=/etc/egress.yaml
    volumes:
      - ./config/egress.yaml:/etc/egress.yaml

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  # --- AI 层 ---
  ai-agent:
    build: ./services/ai-agent-py
    environment:
      - LIVEKIT_URL=ws://localhost:7880
      - LIVEKIT_API_KEY=${LK_API_KEY}
      - LIVEKIT_API_SECRET=${LK_API_SECRET}
      - DEEPGRAM_API_KEY=${DEEPGRAM_KEY}
      - OPENAI_API_KEY=${OPENAI_KEY}
      - CARTESIA_API_KEY=${CARTESIA_KEY}
    depends_on: [livekit, redis]

  # --- 业务层 ---
  converact:
    build: .
    ports:
      - "3000:3000"
    environment:
      - LIVEKIT_URL=ws://localhost:7880
      - LIVEKIT_API_KEY=${LK_API_KEY}
      - LIVEKIT_API_SECRET=${LK_API_SECRET}
      - RUSTPBX_RWI_URL=ws://localhost:8080/rwi
      - RUSTPBX_API_URL=http://localhost:8080
      - REDIS_URL=redis://localhost:6379
    depends_on: [redis, rustpbx, livekit]

  # --- 存储 ---
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - ./data/minio:/data
```

### 5.2 端口规划

| 服务 | 端口 | 协议 |
|------|------|------|
| RustPBX SIP | 5060 | UDP/TCP |
| RustPBX Web Console | 8080 | HTTP |
| RustPBX RWI | 8080/rwi | WebSocket |
| RustPBX WebRTC | 8443 | WSS |
| LiveKit Server | 7880 (HTTP) / 7881 (RTC) | HTTP + UDP |
| LiveKit SIP | 5061 | UDP |
| LiveKit SIP RTP | 10000-20000 | UDP |
| Converact Platform Server | 3000 | HTTP |
| Redis | 6379 | TCP |
| MinIO | 9000/9001 | HTTP |

---

## 6. 数据模型扩展

在现有 `schema.sql` 基础上新增：

```sql
-- ===== 视频通话扩展 =====

-- 通话会话（统一语音+视频）
ALTER TABLE voice_call_sessions ADD COLUMN media_type TEXT DEFAULT 'audio';
  -- 'audio' | 'video' | 'audio_to_video' (升级)
ALTER TABLE voice_call_sessions ADD COLUMN livekit_room_name TEXT;
ALTER TABLE voice_call_sessions ADD COLUMN livekit_room_sid TEXT;
ALTER TABLE voice_call_sessions ADD COLUMN rustpbx_call_id TEXT;
ALTER TABLE voice_call_sessions ADD COLUMN transfer_chain TEXT;
  -- JSON: [{from: "ai", to: "human", at: "2026-..."}]

-- LiveKit 房间管理
CREATE TABLE livekit_rooms (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  room_name TEXT NOT NULL UNIQUE,
  room_sid TEXT,
  purpose TEXT NOT NULL,  -- 'ai_outbound' | 'video_service' | 'screen_share' | 'conference'
  status TEXT DEFAULT 'active',  -- 'active' | 'closed'
  call_session_id TEXT REFERENCES voice_call_sessions(id),
  metadata TEXT,  -- JSON
  created_at TEXT DEFAULT (datetime('now')),
  closed_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 录制记录
CREATE TABLE call_recordings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
  source TEXT NOT NULL,  -- 'livekit_egress' | 'rustpbx_sipflow'
  format TEXT NOT NULL,  -- 'mp4' | 'webm' | 'wav' | 'ogg'
  storage_url TEXT NOT NULL,  -- s3://bucket/path
  duration_ms INTEGER,
  file_size_bytes INTEGER,
  has_video INTEGER DEFAULT 0,
  egress_id TEXT,  -- LiveKit egress ID
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- AI 对话日志（每轮 turn）
CREATE TABLE ai_conversation_turns (
  id TEXT PRIMARY KEY,
  call_session_id TEXT NOT NULL REFERENCES voice_call_sessions(id),
  turn_index INTEGER NOT NULL,
  role TEXT NOT NULL,  -- 'customer' | 'ai' | 'system'
  content TEXT NOT NULL,
  stt_confidence REAL,
  intent_score REAL,
  latency_ms INTEGER,  -- STT+LLM+TTS 端到端延迟
  created_at TEXT DEFAULT (datetime('now'))
);

-- 坐席状态
CREATE TABLE agent_seats (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT DEFAULT 'offline',  -- 'online' | 'busy' | 'idle' | 'offline' | 'break'
  skills TEXT,  -- JSON array: ["japanese", "chinese", "real_estate"]
  current_call_session_id TEXT,
  livekit_identity TEXT,
  rustpbx_extension TEXT,
  last_heartbeat_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

-- 外呼任务队列
CREATE TABLE outbound_tasks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  lead_id TEXT,
  phone_number TEXT,
  channel TEXT NOT NULL,  -- 'pstn_voice' | 'video_link_sms' | 'video_link_wechat'
  status TEXT DEFAULT 'pending',  -- 'pending' | 'dialing' | 'connected' | 'completed' | 'failed'
  strategy TEXT,  -- JSON: script, language, avatar
  attempt_count INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  result TEXT,  -- JSON: {disposition, intent_score, duration_ms, transferred}
  call_session_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);
```

---

## 7. Converact Platform 新增服务模块

### 7.1 模块结构

```
src/
├── agent-runtime/
│   ├── call-center/                    # 新增：呼叫中心核心
│   │   ├── call-router.ts             # RustPBX HTTP Router 回调处理
│   │   ├── rwi-client.ts             # RustPBX RWI WebSocket 客户端
│   │   ├── seat-manager.ts           # 坐席状态管理
│   │   ├── outbound-dialer.ts        # 外呼任务调度
│   │   ├── transfer-orchestrator.ts  # AI→人工转接编排
│   │   └── cdr-receiver.ts           # CDR webhook 接收
│   │
│   ├── livekit/                       # 新增：LiveKit 集成
│   │   ├── room-manager.ts           # Room 生命周期管理
│   │   ├── token-service.ts          # JWT Token 签发
│   │   ├── webhook-handler.ts        # LiveKit event webhook
│   │   ├── egress-manager.ts         # 录制管理
│   │   └── agent-dispatcher.ts       # AI Agent 调度
│   │
│   ├── voice/                         # 现有，扩展
│   │   ├── voice-store.ts            # 扩展：video 字段
│   │   └── ...
│   │
services/
├── ai-agent-py/                       # 新增：LiveKit AI Agent
│   ├── agent.py                      # 主 Agent 入口
│   ├── plugins/
│   │   ├── stt.py                    # STT 配置 (Deepgram / Google / AmiVoice)
│   │   ├── llm.py                    # LLM 配置 (GPT-4o / Claude)
│   │   ├── tts.py                    # TTS 配置 (Cartesia / CoeFont / VOICEVOX)
│   │   └── avatar.py                # 数字人视频轨道发布
│   ├── scripts/                      # 话术脚本加载
│   │   └── loader.py
│   ├── intent_scorer.py              # 意向评分
│   ├── requirements.txt
│   └── Dockerfile
```

### 7.2 核心接口定义

```typescript
// src/agent-runtime/call-center/call-router.ts
interface CallRouterRequest {
  call_id: string;
  from: string;         // SIP URI
  to: string;           // SIP URI
  direction: 'inbound' | 'outbound';
  headers: Record<string, string>;
}

interface CallRouterResponse {
  action: 'forward' | 'queue' | 'reject' | 'ivr';
  targets?: string[];           // SIP URIs
  queue_name?: string;          // ACD 队列名
  record?: boolean;
  metadata?: Record<string, string>;
}

// src/agent-runtime/call-center/rwi-client.ts
interface RWIClient {
  connect(url: string): Promise<void>;
  originate(params: OriginateParams): Promise<string>;  // returns call_id
  transfer(callId: string, target: string): Promise<void>;
  hold(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;
  streamStart(callId: string, wsUrl: string): Promise<void>;
  injectAudio(callId: string, pcmData: Buffer): Promise<void>;
  onEvent(handler: (event: RWIEvent) => void): void;
}

// src/agent-runtime/livekit/room-manager.ts
interface RoomManager {
  createRoom(params: CreateRoomParams): Promise<RoomInfo>;
  closeRoom(roomName: string): Promise<void>;
  listParticipants(roomName: string): Promise<Participant[]>;
  removeParticipant(roomName: string, identity: string): Promise<void>;
  dispatchAIAgent(roomName: string, agentConfig: AgentConfig): Promise<void>;
}

interface CreateRoomParams {
  tenantId: string;
  purpose: 'ai_outbound' | 'video_service' | 'screen_share' | 'conference';
  callSessionId?: string;
  metadata?: Record<string, unknown>;
  maxParticipants?: number;
  emptyTimeout?: number;        // seconds
}
```

---

## 8. AI Agent 设计 (LiveKit Agents Framework)

```python
# services/ai-agent-py/agent.py

from livekit.agents import AgentSession, Agent, RtcSession
from livekit.plugins import deepgram, openai, cartesia, silero

@server.rtc_session()
async def entrypoint(ctx: RtcSession):
    """每个 Room 分配一个 AI Agent Session"""

    # 从 Room metadata 获取配置
    room_meta = json.loads(ctx.room.metadata or '{}')
    script = load_script(room_meta.get('script_id'))
    language = room_meta.get('language', 'ja')

    # 根据语言选择 STT/TTS
    stt = select_stt(language)   # ja→Google/AmiVoice, en→Deepgram, zh→Deepgram
    tts = select_tts(language)   # ja→CoeFont/VOICEVOX, en→Cartesia, zh→Cartesia

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=stt,
        llm=openai.LLM(model="gpt-4o"),
        tts=tts,
    )

    agent = Agent(
        instructions=script.system_prompt,
        tools=[
            check_intent,          # 意向评分
            transfer_to_human,     # 请求转人工
            schedule_callback,     # 预约回电
            send_material,         # 发送资料链接
        ],
    )

    # 如果是视频场景，发布数字人视频轨道
    if room_meta.get('video_enabled'):
        await publish_avatar_track(ctx.room, room_meta.get('avatar_id'))

    await session.start(agent=agent, room=ctx.room)
    await session.generate_reply(instructions=script.greeting)
```

**意向评分 & 转人工**：
```python
async def check_intent(conversation_history: str) -> dict:
    """AI function-calling: 分析对话判断意向等级"""
    # 返回 {score: 0.85, signals: ["asked_price", "confirmed_schedule"]}
    pass

async def transfer_to_human(reason: str, customer_summary: str):
    """通知 Converact Platform 编排转接"""
    await converact_api.request_transfer(
        room_name=current_room,
        reason=reason,
        summary=customer_summary,
        intent_score=latest_score,
    )
```

---

## 9. 前端架构

### 9.1 坐席面板（React + LiveKit Components）

```
frontend/
├── src/
│   ├── App.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx          # 今日概览：外呼量/接通/转化
│   │   ├── CallCenter.tsx         # 呼叫中心主界面
│   │   ├── VideoRoom.tsx          # 视频通话界面
│   │   └── OutboundQueue.tsx      # 外呼任务管理
│   ├── components/
│   │   ├── VideoPanel.tsx         # LiveKit 视频面板
│   │   ├── CallControls.tsx       # 接听/挂断/Hold/Transfer
│   │   ├── SeatStatus.tsx         # 坐席状态切换
│   │   ├── CustomerInfo.tsx       # 来电客户信息卡片
│   │   ├── ConversationLog.tsx    # 实时对话日志
│   │   └── Dialpad.tsx            # 拨号盘
│   ├── hooks/
│   │   ├── useLiveKit.ts          # LiveKit Room 连接
│   │   ├── useRustPBX.ts          # RustPBX WebRTC 软电话（纯语音）
│   │   └── useCallCenter.ts       # Converact Platform API 调用
│   └── lib/
│       ├── livekit-token.ts       # Token 请求
│       └── converact-api.ts             # REST API client
├── package.json
└── vite.config.ts
```

**技术栈**：
- React 19 + TypeScript
- `@livekit/components-react` — 视频 UI 组件
- `livekit-client` — LiveKit SDK
- Vite — 打包
- TailwindCSS — 样式

### 9.2 客户端 H5（轻量）

```html
<!-- 客户打开的 H5 页面，极简 -->
<div id="video-container"></div>
<script type="module">
  import { Room, RoomEvent } from 'livekit-client';

  const room = new Room();
  await room.connect(LIVEKIT_URL, TOKEN);

  room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
    track.attach(document.getElementById('video-container'));
  });
</script>
```

---

## 10. 配置文件模板

### 10.1 RustPBX (`config/rustpbx.toml`)

```toml
[platform]
http_addr = "0.0.0.0:8080"
log_level = "info"

[platform.database]
url = "sqlite:///app/db/rustpbx.db"

[proxy]
bind_addr = "0.0.0.0:5060"
transports = ["udp", "tcp", "ws"]

[proxy.http_router]
url = "http://converact:3000/api/call-router"
timeout_ms = 3000
fallback_action = "reject"

[proxy.media]
rtp_start = 20000
rtp_end = 30000
external_ip = "${PUBLIC_IP}"

# SIP Trunk: 连接运营商
[[proxy.trunks]]
name = "twilio-japan"
host = "pstn.twilio.com"
username = "${TWILIO_SIP_USER}"
password = "${TWILIO_SIP_PASS}"
outbound_prefix = "+81"

# SIP Trunk: 连接 LiveKit SIP Bridge
[[proxy.trunks]]
name = "livekit-bridge"
host = "127.0.0.1:5061"
transport = "udp"

[proxy.queues.default]
strategy = "sequential"
timeout_sec = 30
hold_music = "/app/audio/hold.wav"

[recording]
enabled = true
format = "wav"
storage = "local"
path = "/app/recordings"

[cdr]
webhook_url = "http://converact:3000/api/webhooks/rustpbx-cdr"
```

### 10.2 LiveKit (`config/livekit.yaml`)

```yaml
port: 7880
rtc:
  port_range_start: 10000
  port_range_end: 20000
  use_external_ip: true

redis:
  address: redis:6379

keys:
  ${LK_API_KEY}: ${LK_API_SECRET}

webhook:
  urls:
    - "http://converact:3000/api/media/webhooks/livekit"
  api_key: ${LK_API_KEY}

room:
  empty_timeout: 300
  max_participants: 10

logging:
  level: info
```

### 10.3 LiveKit Egress (`config/egress.yaml`)

```yaml
log_level: info
api_key: ${LK_API_KEY}
api_secret: ${LK_API_SECRET}
ws_url: ws://livekit:7880
s3:
  access_key: ${MINIO_ACCESS_KEY}
  secret: ${MINIO_SECRET_KEY}
  region: us-east-1
  endpoint: http://minio:9000
  bucket: recordings
  force_path_style: true
```

---

## 11. 关键技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 语音外呼引擎 | RustPBX (非 LiveKit SIP 直接外呼) | RustPBX 有完整 B2BUA + Queue/ACD + 录音，LiveKit SIP 只是桥接器 |
| 视频房间 | LiveKit (非 RustPBX) | RustPBX 不处理视频，LiveKit 是成熟 WebRTC SFU |
| AI Agent 框架 | LiveKit Agents (Python) | 成熟的 STT→LLM→TTS 管道，原生 Room participant |
| SIP↔WebRTC 桥接 | LiveKit SIP Bridge | 标准方案，将 PSTN 音频拉入 LiveKit Room |
| 前端框架 | React + @livekit/components | LiveKit 官方 UI 组件库，开发效率高 |
| 录音策略 | 双录：RustPBX SipFlow + LiveKit Egress | SipFlow 录纯语音（轻量），Egress 录视频（重量） |
| 数据库 | 保留 SQLite（≤1000 并发），超出迁 Postgres | 避免过早优化 |
| 消息总线 | Redis (Pub/Sub + Stream) | LiveKit 已依赖 Redis，复用同一实例 |

---

## 12. 执行阶段划分

### Phase 0: 基础设施搭建（1 周）

- [ ] Docker Compose 编排所有服务
- [ ] RustPBX 基础配置 + HTTP Router 回调 Converact Platform
- [ ] LiveKit 自托管 + Redis + 验证 Room 创建
- [ ] LiveKit SIP Bridge 配置对接 RustPBX trunk
- [ ] Converact Platform schema 扩展（上述 SQL）
- [ ] 验证：RustPBX 外呼 → SIP 桥接 → LiveKit Room → 能听到音频

### Phase 1: AI 语音外呼闭环（2 周）

- [ ] `rwi-client.ts` — RustPBX RWI WebSocket 客户端
- [ ] `call-router.ts` — HTTP Router 回调处理
- [ ] `cdr-receiver.ts` — CDR webhook 入库
- [ ] `ai-agent-py` — 基础 STT→LLM→TTS Agent
- [ ] `outbound-dialer.ts` — 外呼任务调度
- [ ] 端到端验证：Converact Platform 触发 → RustPBX 外呼 → LiveKit Room → AI 对话 → CDR 入库

### Phase 2: AI 视频外呼（2 周）

- [ ] AI Agent 数字人视频轨道发布
- [ ] 客户 H5 页面（LiveKit JS SDK 加入 Room）
- [ ] SMS/WeChat 发送视频链接逻辑
- [ ] `room-manager.ts` + `token-service.ts`
- [ ] LiveKit Egress 录制 MP4
- [ ] 端到端验证：SMS 链接 → H5 → 看到数字人 → 语音对话 → 录制存档

### Phase 3: 人工坐席面板（2 周）

- [ ] React 前端脚手架 (Vite + TailwindCSS)
- [ ] @livekit/components-react 视频面板
- [ ] `seat-manager.ts` — 坐席状态管理
- [ ] `transfer-orchestrator.ts` — AI→人工转接
- [ ] 坐席接听/挂断/Hold/Transfer 控件
- [ ] 屏幕共享
- [ ] 端到端验证：AI 高意向 → 坐席收到通知 → 加入视频 → 完成服务

### Phase 4: 生产级加固（2 周）

- [ ] 合规：录音同意弹窗 + "本通话由 AI 提供" 告知
- [ ] 监控：Prometheus metrics (RustPBX + LiveKit) + Grafana dashboard
- [ ] 容错：断线重连、Room 超时清理、CDR 补偿机制
- [ ] 压测：100 并发外呼 + 10 并发视频

---

## 13. 成本估算（小规模生产）

| 项目 | 规格 | 月成本 |
|------|------|--------|
| 云服务器 (媒体) | 8C16G + 公网 IP（承载 RustPBX + LiveKit） | ¥500–800 |
| 云服务器 (业务) | 4C8G（Converact Platform + AI Agent + Redis） | ¥300–500 |
| SIP Trunk (日本) | Twilio Japan / NTT（按分钟计费） | ¥0.03/分钟 |
| Deepgram STT | Pay-as-you-go | $0.0043/分钟 |
| OpenAI GPT-4o | API 调用 | ~$0.01/轮 |
| Cartesia TTS | Pay-as-you-go | $0.006/分钟 |
| S3/MinIO 存储 | 录音录像 | ¥50–200 |
| **合计**（100通/天） | | **¥1,500–2,500/月** |

---

## 14. 与现有 Converact Platform 代码的关系

| 现有资产 | 如何复用 |
|----------|----------|
| `VoiceStore` (14 张 voice 表) | 扩展字段，继续作为通话记录主表 |
| `ApprovalQueue` | 高风险外呼审批复用 |
| `Lead Acquisition` 主链 | 触达执行改为调用 `outbound-dialer` |
| `AI Script Engine` | 输出话术 → 注入 AI Agent 的 system_prompt |
| `Memory System` | 对话上下文持久化，跨 session 记忆 |
| `Channel Adapters` | 复用 WeChat adapter 发视频链接 |
| `TenantSkillStore` | 坐席技能路由数据源 |
| `voice-media-rs` | **【历史决策·已废】替换**；现保留并演进为 Unified RustPBX 进程内解码媒体 Backend，token 兼容职责可独立收口 |
| `services-bootstrap.ts` | 新增 call-center / livekit wire 注册 |

**需删除/替换**：
- **【历史决策·已废】** `services/voice-media-rs/` 由 LiveKit 完全接管；当前不得删除，
  音频处理与视频 SFU 是不同职责
- 现有 `VoiceStore.rustpbx_*` 方法 → 重写为通过 RWI client 控制

---

## 附：技术选型对比（备选方案记录）

### 方案 A（当前选择）：RustPBX + LiveKit 分工

```
RustPBX = SIP/PSTN + Queue/ACD + 纯语音录音
LiveKit = 视频SFU + AI Agent host + 视频录制
两者通过 SIP Trunk 桥接
```

✅ 各自职责清晰，RustPBX 的 ACD 能力成熟
✅ 纯语音场景不需要经过 LiveKit，资源消耗低
✅ RustPBX 的 HTTP Router 天然适配 Converact Platform 的路由决策模型

### 方案 B（备选）：LiveKit SIP 直接对接运营商

```
LiveKit SIP = 直接连 Twilio/NTT trunk
LiveKit = 全部媒体
不用 RustPBX
```

❌ LiveKit SIP 没有 ACD/Queue 能力，需要自己实现
❌ 没有 B2BUA 的呼叫转移灵活性
❌ 所有通话都经过 SFU，纯语音场景资源浪费

### 方案 C（备选）：RustPBX 做所有事 + 自己写视频

```
RustPBX = 全部
自己写 WebRTC 视频分发
```

❌ RustPBX 不处理视频
❌ 自己写 SFU 工作量巨大且不现实
