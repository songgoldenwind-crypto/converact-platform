# Phase 1 — AI 语音外呼闭环 · 细节设计

> **目标**：OPC 触发一通外呼任务 → RustPBX 拨打 PSTN → 音频桥接到 LiveKit Room → AI Agent 对话 → CDR 写回。
> **依赖**：Phase 0 全部通过。

---

## 0. 验收清单

| # | 项 | 验证方式 | 预期 |
|---|---|---|---|
| 1 | Dialer 自动拾取 pending task | 创建 task 后等待 3s | task.status → dialing |
| 2 | RWI originate 发出 | RustPBX 日志可见 INVITE | SIPp 模拟接听 |
| 3 | 音频进入 LiveKit Room | `lk room join` 能听到 RTP 音频 | 有声 |
| 4 | AI Agent 加入 Room 并说话 | Room 中出现 ai-agent participant | TTS 音频可听 |
| 5 | 客户说话 → AI 回复 | SIPp 播放 WAV → AI 识别并回复 | STT 日志可见 |
| 6 | 通话结束 → CDR 入库 | voice_call_sessions.status = completed | DB 可查 |
| 7 | outbound_task 状态完整 | task.status = completed, result 有 duration | DB 可查 |
| 8 | ai_conversation_turns 有记录 | SELECT count(*) > 0 | 有数据 |
| 9 | 并发 5 通不冲突 | 同时创建 5 个 task | 全部成功完成 |
| 10 | 无应答重试 | SIPp 不接听 | attempt_count++ → 重新 pending |

---

## 1. RWI Client 模块设计

### 1.1 模块职责

`src/agent-runtime/call-center/rwi-client.ts`

通过 WebSocket JSON 协议连接 RustPBX RWI 接口，执行呼叫控制操作。

### 1.2 连接管理

```typescript
class RWIClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingRequests: Map<string, { resolve, reject, timer }>;
  private eventHandlers: ((event: RWIEvent) => void)[];

  constructor(private config: {
    url: string;             // ws://rustpbx:8080/rwi
    authToken?: string;      // Basic auth
    reconnectInterval: number; // 默认 5000ms
    requestTimeout: number;    // 默认 10000ms
  }) {}
}
```

### 1.3 重连策略

```
connect() → ws.onopen → 标记 connected
ws.onclose → 启动重连定时器
  重连间隔: 1s → 2s → 4s → 8s → max 30s (指数退避)
  每次重连成功 → 重置间隔为 1s
```

### 1.4 请求-响应协议

RWI 使用 JSON-over-WebSocket，每个请求带 `request_id`，响应携带相同 `request_id`。

**发送格式**：
```json
{
  "request_id": "req_uuid",
  "command": "originate",
  "params": {
    "to": "sip:+81312345678@trunk",
    "from": "+81399998888",
    "trunk": "twilio-japan",
    "timeout_sec": 30
  }
}
```

**响应格式**：
```json
{
  "request_id": "req_uuid",
  "success": true,
  "call_id": "rustpbx-call-uuid",
  "data": {}
}
```

**错误响应**：
```json
{
  "request_id": "req_uuid",
  "success": false,
  "error": "trunk_unavailable",
  "message": "No available trunk for prefix +81"
}
```

### 1.5 事件流

RustPBX 主动推送通话事件（无 request_id）：

```json
{
  "event": "call_state_change",
  "call_id": "xxx",
  "state": "ringing" | "answered" | "hangup",
  "timestamp": "...",
  "data": { "hangup_cause": "normal_clearing" }
}
```

OPC 监听这些事件用于：
- `ringing` → 更新 session.status = 'ringing'
- `answered` → 更新 session.status = 'active', started_at
- `hangup` → 触发 CDR 级别的 session 更新（CDR webhook 是最终真相）

### 1.6 核心方法

```typescript
interface RWIClient {
  connect(): Promise<void>;
  disconnect(): void;
  isConnected(): boolean;

  // 呼叫控制
  originate(params: {
    to: string;              // 被叫 SIP URI 或 E.164
    from?: string;           // 主叫号码
    trunk?: string;          // 指定 trunk name
    timeout_sec?: number;    // 振铃超时
    metadata?: Record<string, string>;  // 附加到 CDR
  }): Promise<{ call_id: string }>;

  transfer(callId: string, target: string): Promise<void>;
  hold(callId: string): Promise<void>;
  unhold(callId: string): Promise<void>;
  hangup(callId: string): Promise<void>;

  // 媒体控制
  bridge(callId: string, targetUri: string): Promise<void>;

  // 事件监听
  onEvent(handler: (event: RWIEvent) => void): void;
  offEvent(handler: (event: RWIEvent) => void): void;
}
```

### 1.7 错误处理

| 场景 | 处理 |
|---|---|
| WebSocket 未连接时调用 originate | throw `RWINotConnected` → Dialer 标记 task failed |
| originate 超时 (10s 无响应) | reject Promise → Dialer 重试 |
| RustPBX 返回 `trunk_unavailable` | Dialer 标记 task failed (reason: no_trunk) |
| RustPBX 返回 `call_limit_exceeded` | Dialer 暂停 30s 再继续 |

---

## 2. Outbound Dialer 模块设计

### 2.1 模块职责

`src/agent-runtime/call-center/outbound-dialer.ts`

定时轮询 `outbound_tasks` 表，拾取 pending 任务并编排外呼流程。

### 2.2 运行模型

```
┌─────────────────────────────────────────┐
│           OutboundDialer                 │
│                                         │
│  ┌────────┐     ┌──────────────────┐   │
│  │ Ticker │────►│  pickAndExecute  │   │
│  │ 3s间隔 │     │                  │   │
│  └────────┘     │ 1. pickTasks()   │   │
│                 │ 2. lockTask()    │   │
│                 │ 3. executeTask() │   │
│                 └──────────────────┘   │
└─────────────────────────────────────────┘
```

### 2.3 完整外呼流程 (PSTN voice)

```
executeTask(task):
  │
  ├── 1. 验证并发上限
  │   └── concurrentCalls >= maxConcurrent → skip
  │
  ├── 2. 创建 voice_call_session (status=initiated)
  │
  ├── 3. 创建 LiveKit Room (purpose=pstn_bridge)
  │   └── room_name = "{tenant}-pstn_bridge-{random}"
  │
  ├── 4. Dispatch AI Agent 到 Room
  │   └── Room metadata: {script_id, language, task_id, tenant_id}
  │
  ├── 5. 等待 AI Agent 加入 Room (timeout 10s)
  │   └── 监听 LiveKit webhook: participant_joined + identity 含 "ai-agent"
  │
  ├── 6. RWI originate → PSTN 外呼
  │   └── originate({to: phone, trunk: "twilio-japan", metadata: {task_id, tenant_id}})
  │
  ├── 7. 等待 RWI event: answered (timeout 30s)
  │   ├── answered → RWI bridge(call_id, livekit-sip) → 音频进入 Room
  │   └── no_answer / busy / reject → 标记失败，调度重试
  │
  ├── 8. 通话进行中... (AI Agent 处理)
  │   └── CDR 或 RWI hangup event → 结束
  │
  └── 9. 清理
      ├── 更新 task 状态 (由 CDR receiver 触发)
      └── concurrentCalls--
```

### 2.4 完整外呼流程 (Video Link SMS)

```
executeTask(task):
  │
  ├── 1. 创建 voice_call_session (status=initiated, media_type=video)
  │
  ├── 2. 创建 LiveKit Room (purpose=ai_outbound)
  │
  ├── 3. Dispatch AI Agent 到 Room (video_enabled=true)
  │
  ├── 4. 生成客户 H5 链接
  │   └── https://domain/video?room={room_name}&tenant_id={tenant_id}&expires_at={ts}&invite={hmac}
  │
  ├── 5. 发送 SMS (通过渠道 adapter)
  │   └── "您好，点击链接与我们的顾问视频通话: {url}"
  │
  ├── 6. 等待客户加入 Room (timeout 120s)
  │   ├── 客户加入 → 对话开始
  │   └── 超时 → 标记 failed, reason: customer_no_show
  │
  └── 7. 对话结束由 LiveKit room_finished 触发 → CDR 写入
```

### 2.5 并发控制

```typescript
class OutboundDialer {
  private maxConcurrentGlobal = parseInt(process.env.MAX_CONCURRENT_OUTBOUND || '20');
  private maxConcurrentPerTenant = 5;  // TODO: 从 tenant 配置读取
  private activeCalls = new Map<string, number>();  // tenant_id → count

  private canDialForTenant(tenantId: string): boolean {
    const totalActive = [...this.activeCalls.values()].reduce((a, b) => a + b, 0);
    if (totalActive >= this.maxConcurrentGlobal) return false;
    const tenantActive = this.activeCalls.get(tenantId) || 0;
    return tenantActive < this.maxConcurrentPerTenant;
  }
}
```

### 2.6 任务锁 (Redis)

```typescript
async lockTask(taskId: string): Promise<boolean> {
  // SETNX task:{taskId}:lock "dialer-{instanceId}" EX 60
  const result = await redis.set(`task:${taskId}:lock`, instanceId, 'EX', 60, 'NX');
  return result === 'OK';
}

async unlockTask(taskId: string): Promise<void> {
  // 仅释放自己的锁
  const owner = await redis.get(`task:${taskId}:lock`);
  if (owner === instanceId) await redis.del(`task:${taskId}:lock`);
}
```

### 2.7 时间窗口检查

```typescript
private isInDialingWindow(tenantId: string): boolean {
  // TODO: Phase 4 从 tenant 配置读取
  // 默认 09:00-18:00 JST (UTC+9)
  const now = new Date();
  const jstHour = (now.getUTCHours() + 9) % 24;
  return jstHour >= 9 && jstHour < 18;
}
```

---

## 3. AI Agent 完整设计

### 3.1 Agent 架构

```
services/ai-agent-py/
├── agent.py                  # LiveKit Agent 入口 + Worker 注册
├── session_handler.py        # 每通通话的会话管理
├── plugins/
│   ├── __init__.py
│   ├── stt_selector.py      # 按语言选择 STT provider
│   ├── tts_selector.py      # 按语言选择 TTS provider
│   └── llm_config.py        # LLM 配置
├── tools/
│   ├── __init__.py
│   ├── check_intent.py      # 意向评分 tool
│   ├── transfer_human.py    # 请求转人工 tool
│   ├── schedule_callback.py # 预约回电 tool
│   └── send_material.py     # 发送资料 tool
├── opc_client.py             # OPC HTTP API 客户端
├── scripts/
│   └── loader.py             # 话术脚本加载
├── config.py                 # 环境变量配置
├── requirements.txt
└── Dockerfile
```

### 3.2 Agent Worker 注册

```python
# agent.py
from livekit.agents import WorkerOptions, cli
from livekit.agents.worker import Worker

from session_handler import handle_session

def main():
    worker = Worker(
        WorkerOptions(
            entrypoint_fnc=handle_session,
            # 每个 worker 最多同时处理 5 个 session
            num_idle_processes=2,
            max_concurrent_sessions=5,
        )
    )
    cli.run_app(worker)

if __name__ == "__main__":
    main()
```

### 3.3 Session Handler

```python
# session_handler.py
import json
from livekit.agents import AgentSession, Agent, RtcSession
from livekit.plugins import silero

from plugins.stt_selector import select_stt
from plugins.tts_selector import select_tts
from plugins.llm_config import get_llm
from tools import check_intent, transfer_human, schedule_callback, send_material
from scripts.loader import load_script
from opc_client import OPCClient

opc = OPCClient()

async def handle_session(ctx: RtcSession):
    room_meta = json.loads(ctx.room.metadata or '{}')
    script_id = room_meta.get('script_id', 'default')
    language = room_meta.get('language', 'ja')
    task_id = room_meta.get('outbound_task_id')
    tenant_id = room_meta.get('tenant_id')
    call_session_id = room_meta.get('call_session_id')

    script = load_script(script_id, language)
    stt = select_stt(language)
    tts = select_tts(language)
    llm = get_llm()

    session = AgentSession(
        vad=silero.VAD.load(),
        stt=stt,
        llm=llm,
        tts=tts,
    )

    # 注入 OPC 上下文到 tools
    tools = [
        check_intent.create(opc, call_session_id),
        transfer_human.create(opc, ctx.room.name, tenant_id, call_session_id),
        schedule_callback.create(opc, tenant_id),
        send_material.create(opc, tenant_id),
    ]

    agent = Agent(
        instructions=script.system_prompt,
        tools=tools,
    )

    # 上报 conversation turn 的回调
    @session.on("user_speech_committed")
    async def on_user_speech(text: str):
        await opc.report_turn(call_session_id, 'customer', text)

    @session.on("agent_speech_committed")
    async def on_agent_speech(text: str):
        await opc.report_turn(call_session_id, 'ai', text)

    await session.start(agent=agent, room=ctx.room)
    await session.generate_reply(instructions=script.greeting)
```

### 3.4 STT/TTS 选择器

```python
# plugins/stt_selector.py
from livekit.plugins import deepgram, google

def select_stt(language: str):
    if language == 'ja':
        return google.STT(language='ja-JP')  # 日语用 Google
    elif language == 'zh':
        return deepgram.STT(model='nova-3', language='zh')
    else:
        return deepgram.STT(model='nova-3', language='en')
```

```python
# plugins/tts_selector.py
from livekit.plugins import cartesia

def select_tts(language: str):
    voices = {
        'ja': 'japanese-female-01',    # Cartesia 日语女声
        'zh': 'chinese-female-01',
        'en': '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc',  # Cartesia 默认英语
    }
    return cartesia.TTS(
        model='sonic-3',
        voice=voices.get(language, voices['en']),
        language=language,
    )
```

### 3.5 意向评分 Tool

```python
# tools/check_intent.py
from livekit.agents import function_tool

def create(opc_client, call_session_id):
    @function_tool(
        name="check_intent",
        description="分析当前对话判断客户意向等级。在客户表达兴趣、询问价格、确认时间时调用。"
    )
    async def check_intent(conversation_summary: str) -> dict:
        """
        Returns:
          score: 0.0-1.0 意向分
          signals: list of detected intent signals
          recommendation: 'continue' | 'transfer' | 'end'
        """
        # 实际实现：用 LLM 做 structured output
        # Phase 1 简化版：基于关键词规则
        signals = []
        score = 0.3

        positive_keywords = ['感兴趣', '多少钱', '什么时候', '可以看看', '预约',
                           'interested', 'how much', 'when', 'schedule',
                           '見たい', 'いくら', '予約', '内見']
        for kw in positive_keywords:
            if kw in conversation_summary:
                signals.append(kw)
                score += 0.15

        score = min(score, 1.0)
        recommendation = 'transfer' if score >= 0.7 else 'continue'

        await opc_client.report_intent(call_session_id, score, signals)
        return {"score": score, "signals": signals, "recommendation": recommendation}

    return check_intent
```

### 3.6 转人工 Tool

```python
# tools/transfer_human.py
from livekit.agents import function_tool

def create(opc_client, room_name, tenant_id, call_session_id):
    @function_tool(
        name="transfer_to_human",
        description="当客户意向高或请求人工服务时，请求转接给人工坐席。调用后你应告知客户'正在为您转接专人客服'。"
    )
    async def transfer_to_human(reason: str, customer_summary: str) -> dict:
        result = await opc_client.request_transfer(
            room_name=room_name,
            tenant_id=tenant_id,
            call_session_id=call_session_id,
            reason=reason,
            customer_summary=customer_summary,
        )
        return result

    return transfer_to_human
```

### 3.7 OPC Client

```python
# opc_client.py
import httpx
from config import OPC_API_URL, OPC_API_KEY

class OPCClient:
    def __init__(self):
        self.base_url = OPC_API_URL
        self.headers = {
            "Content-Type": "application/json",
            "X-API-Key": OPC_API_KEY,
        }
        self.client = httpx.AsyncClient(timeout=10.0)

    async def report_turn(self, call_session_id: str, role: str, content: str):
        await self.client.post(
            f"{self.base_url}/api/call-center/calls/{call_session_id}/turns",
            json={"role": role, "content": content},
            headers=self.headers,
        )

    async def report_intent(self, call_session_id: str, score: float, signals: list):
        await self.client.post(
            f"{self.base_url}/api/call-center/calls/{call_session_id}/intent",
            json={"intent_score": score, "signals": signals},
            headers=self.headers,
        )

    async def request_transfer(self, **kwargs) -> dict:
        resp = await self.client.post(
            f"{self.base_url}/api/livekit/agent-dispatch",
            json={
                "room_name": kwargs["room_name"],
                "action": "transfer_to_human",
                "reason": kwargs["reason"],
                "customer_summary": kwargs["customer_summary"],
                "intent_score": kwargs.get("intent_score", 0),
                "language": kwargs.get("language", "ja"),
            },
            headers=self.headers,
        )
        return resp.json()
```

### 3.8 话术脚本格式

```python
# scripts/loader.py
import json
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent / "data"

class Script:
    def __init__(self, data: dict):
        self.system_prompt = data["system_prompt"]
        self.greeting = data["greeting"]
        self.transfer_message = data.get("transfer_message", "正在为您转接专人客服，请稍候...")
        self.end_message = data.get("end_message", "感谢您的时间，再见！")

def load_script(script_id: str, language: str) -> Script:
    path = SCRIPTS_DIR / f"{script_id}_{language}.json"
    if not path.exists():
        path = SCRIPTS_DIR / "default_ja.json"
    return Script(json.loads(path.read_text()))
```

**话术文件示例** (`scripts/data/default_ja.json`):
```json
{
  "system_prompt": "あなたは不動産の案内AIアシスタントです。お客様に物件について丁寧にご説明し、内見の予約を取ることが目標です。\n\nルール：\n1. 常にです・ます調で話す\n2. お客様の質問に簡潔に答える\n3. 価格・場所・間取りについて聞かれたら具体的に答える\n4. お客様が興味を示したら check_intent を呼ぶ\n5. 意向が高ければ transfer_to_human を呼ぶ",
  "greeting": "お電話ありがとうございます。不動産のご案内をさせていただきます。どのようなお部屋をお探しですか？",
  "transfer_message": "人間のスタッフにお繋ぎします。少々お待ちください。",
  "end_message": "お時間いただきありがとうございました。またのご連絡をお待ちしております。"
}
```

---

## 4. Phase 1 新增 OPC API

### 4.1 新端点

| Method | Path | 调用方 | 说明 |
|---|---|---|---|
| POST | `/api/call-center/calls/:id/turns` | AI Agent | 上报对话轮次 |
| POST | `/api/call-center/calls/:id/intent` | AI Agent | 上报意向分 |
| POST | `/api/livekit/agent-dispatch` | AI Agent | 请求转人工/结束/回电 |
| GET | `/api/call-center/calls/:id/turns` | 坐席面板 | 获取对话历史 |

### 4.2 `POST /api/call-center/calls/:id/turns`

```typescript
interface ReportTurnRequest {
  role: 'customer' | 'ai' | 'system' | 'agent';
  content: string;
  stt_confidence?: number;
  latency_ms?: number;
}
// Response: 201 { id, turn_index }
```

### 4.3 `POST /api/livekit/agent-dispatch`

```typescript
interface AgentDispatchRequest {
  room_name: string;
  action: 'transfer_to_human' | 'end_call' | 'schedule_callback';
  reason: string;
  customer_summary: string;
  intent_score?: number;
  language?: string;
  required_skills?: string[];
  callback_time?: string;
  callback_phone?: string;
}

interface AgentDispatchResponse {
  action_taken: 'seat_assigned' | 'queued' | 'no_seats_available' | 'callback_scheduled' | 'call_ended';
  assigned_seat_id?: string;
  message_for_customer?: string;
}
```

**处理逻辑**：
- `transfer_to_human` → 调用 TransferOrchestrator (Phase 3 完整实现，Phase 1 简化为日志 + 返回 no_seats_available)
- `end_call` → 标记 session 完成
- `schedule_callback` → 创建新的 outbound_task (scheduled_at = callback_time)

---

## 5. RWI 事件到 Session 状态映射

```
RWI event          →  voice_call_sessions.status  →  outbound_tasks.status
─────────────────────────────────────────────────────────────────────────
originate sent         initiated                      dialing
ringing                ringing                        dialing
answered               active                         connected
hangup (normal)        completed                      completed
hangup (no_answer)     failed                         pending (retry)
hangup (busy)          failed                         pending (retry)
hangup (reject)        failed                         pending (retry 2h)
error                  error                          failed
```

---

## 6. Dialer 与 AI Agent 的协调时序

```
  Dialer              OPC DB            LiveKit          RustPBX         AI Agent
    │                   │                  │               │               │
    │ create session    │                  │               │               │
    ├─────────────────►│                  │               │               │
    │                   │                  │               │               │
    │ create room       │                  │               │               │
    ├──────────────────────────────────►  │               │               │
    │                   │                  │ room_started  │               │
    │                   │◄─────────────────┤               │               │
    │                   │                  │               │               │
    │ dispatch agent    │                  │               │               │
    ├──────────────────────────────────────────────────────────────────►  │
    │                   │                  │ agent_joined  │               │
    │                   │                  │◄──────────────────────────────┤
    │                   │                  │               │               │
    │ RWI originate     │                  │               │               │
    ├──────────────────────────────────────────────────►  │               │
    │                   │                  │               │ INVITE→PSTN   │
    │                   │                  │               ├──────────►    │
    │                   │                  │               │               │
    │ RWI event:answered│                  │               │               │
    │◄──────────────────────────────────────────────────── │               │
    │                   │                  │               │               │
    │ RWI bridge → livekit-sip            │               │               │
    ├──────────────────────────────────────────────────►  │               │
    │                   │                  │ SIP→Room      │               │
    │                   │                  │◄──────────────┤               │
    │                   │                  │               │               │
    │                   │                  │  audio flow ◄─────────────► │
    │                   │                  │  (AI talks to customer)      │
```

---

## 7. Redis 依赖 (Phase 1 新增)

| Key Pattern | 类型 | 用途 | TTL |
|---|---|---|---|
| `task:{id}:lock` | String | Dialer 任务锁 | 60s |
| `dialer:pause:{tenantId}` | String | 租户暂停外呼标记 | 无 (手动删除) |
| `call:active:{callId}` | Hash | 通话实时状态缓存 | 3600s |

### 7.1 OPC Redis 连接

```typescript
// src/agent-runtime/call-center/redis-client.ts
import { Redis } from 'ioredis';

let client: Redis | null = null;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }
  return client;
}
```

---

## 8. Phase 1 测试策略

### 8.1 单元测试

```typescript
// test/outbound-dialer.test.ts
test('dialer respects max concurrent limit')
test('dialer skips tasks outside dialing window')
test('dialer handles originate failure gracefully')
test('dialer retries on no_answer')
```

### 8.2 集成测试 (需要 RustPBX + LiveKit)

```typescript
// test/phase1-e2e.test.ts (手动运行，需 docker compose up)
test('full outbound call flow: create task → dial → answered → CDR')
```

### 8.3 SIPp 模拟被叫方

```xml
<!-- sipp/answer_and_talk.xml -->
<!-- 自动接听 + 播放 WAV 文件 → AI 能做 STT -->
<scenario name="answer_call">
  <recv request="INVITE"/>
  <send><![CDATA[SIP/2.0 200 OK]]></send>
  <recv request="ACK"/>
  <pause milliseconds="5000"/>
  <send><![CDATA[BYE]]></send>
</scenario>
```

---

## 9. Phase 1 → Phase 2 衔接

Phase 1 完成后 Phase 2 需要：
- AI Agent 增加 **视频轨道发布** (avatar track)
- Dialer 增加 `video_link_sms` channel 的完整实现
- 客户 H5 页面 (纯前端)
- LiveKit Egress 自动录制
