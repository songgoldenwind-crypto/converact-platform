# Phase 2 — AI 视频外呼 · 细节设计

> **目标**：数字人视频轨道 + 客户 H5 页面 + Egress 录制 + SMS 链接触达。
> **依赖**：Phase 1 AI 语音外呼闭环已通过验收。

---

## 0. 验收清单

| # | 项 | 验证方式 | 预期 |
|---|---|---|---|
| 1 | AI Agent 发布视频轨道 | `lk room join` 看到 video track | 数字人画面 |
| 2 | 客户 H5 打开视频画面 | 浏览器打开 H5 链接 | 看到数字人 + 听到声音 |
| 3 | 客户麦克风已启用 | H5 页面授权后 | AI 能识别客户语音 |
| 4 | SMS 发送成功 | 创建 video task | Twilio 回执 delivered |
| 5 | 120s 超时未加入 | 不点击链接 | task.status = failed, reason: no_show |
| 6 | Egress 录制保存 | 视频通话结束后 | MinIO 中可下载 .mp4 |
| 7 | 录制时长准确 | 对比 session duration 与录制 duration | 误差 < 2s |
| 8 | H5 页面兼容性 | Chrome/Safari/WeChat内置浏览器 | 都能正常视频 |
| 9 | 并发 3 路视频不卡顿 | 同时 3 个视频 task | 所有画面流畅 |
| 10 | Room 关闭后资源释放 | 通话结束 | LiveKit Room 已销毁 |

---

## 1. 数字人方案选型

### 1.1 方案对比

| 方案 | 延迟 | 质量 | 成本 | 适用 |
|---|---|---|---|---|
| A. 预渲染口型动画 | ~300ms | 中 | 低 | MVP 首选 |
| B. 实时 AI Avatar (HeyGen/D-ID) | ~800ms | 高 | 高 | 付费升级 |
| C. 静态图片 + 嘴型叠加 | ~200ms | 低 | 极低 | 最低成本 |

**Phase 2 选择方案 A**：使用 LiveKit 的 video track + TTS 音频驱动口型同步的预渲染方案。

### 1.2 Avatar 渲染器

```
services/ai-agent-py/avatar/
├── renderer.py       # 将 TTS 音频帧映射到口型关键帧
├── video_source.py   # LiveKit VideoSource 封装
├── assets/
│   └── default.mp4   # 默认数字人素材（各口型关键帧）
└── config.py         # 分辨率/帧率配置
```

### 1.3 Video Track 发布

```python
# avatar/video_source.py
from livekit.rtc import VideoSource, VideoFrame
import numpy as np

class AvatarVideoSource:
    def __init__(self, config):
        self.source = VideoSource(
            width=config.width,      # 720
            height=config.height,    # 1280 (竖屏)
            fps=config.fps,          # 25
        )
        self.frames = self._load_frames(config.asset_path)
        self.current_frame_idx = 0
        self.is_speaking = False

    def _load_frames(self, path: str) -> list[np.ndarray]:
        """加载数字人素材帧（静默 + 说话口型序列）"""
        # 从 MP4 提取帧 → numpy arrays
        ...

    async def publish(self, room):
        """发布 video track 到 room"""
        track = await room.local_participant.publish_track(
            self.source,
            name="avatar-video",
        )
        return track

    def set_speaking(self, speaking: bool):
        """切换说话/静默状态"""
        self.is_speaking = speaking

    async def render_loop(self):
        """25fps 渲染循环"""
        while True:
            if self.is_speaking:
                frame = self._get_speaking_frame()
            else:
                frame = self._get_idle_frame()
            self.source.capture_frame(VideoFrame(
                width=self.source.width,
                height=self.source.height,
                type=VideoFrame.Type.ARGB,
                data=frame.tobytes(),
            ))
            await asyncio.sleep(1.0 / self.source.fps)
```

### 1.4 TTS 驱动口型同步

```python
# session_handler.py (Phase 2 扩展)
async def handle_session(ctx: RtcSession):
    # ... 基础初始化 ...

    avatar = AvatarVideoSource(avatar_config)
    await avatar.publish(ctx.room)
    asyncio.create_task(avatar.render_loop())

    @session.on("agent_started_speaking")
    def on_speak_start():
        avatar.set_speaking(True)

    @session.on("agent_stopped_speaking")
    def on_speak_stop():
        avatar.set_speaking(False)

    # ... 后续对话逻辑不变 ...
```

---

## 2. 客户 H5 页面

### 2.1 技术栈

```
services/customer-h5/
├── package.json          # Vite + React
├── src/
│   ├── App.tsx           # 入口
│   ├── pages/
│   │   └── CallRoom.tsx  # 视频通话页
│   ├── components/
│   │   ├── VideoPlayer.tsx
│   │   ├── Controls.tsx  # 麦克风/挂断
│   │   └── WaitingScreen.tsx
│   ├── hooks/
│   │   └── useLiveKit.ts # LiveKit React SDK
│   └── lib/
│       └── token.ts      # JWT 解码 (只读, 不存储)
├── public/
│   └── index.html
└── vite.config.ts
```

### 2.2 页面流程

```
URL: https://{domain}/video?room={room_name}&tenant_id={tenant_id}&expires_at={ts}&invite={hmac}

1. 解析 URL → room + tenant_id + invite
2. 调用 `/api/media/livekit/join` 换取短期 LiveKit token
3. 请求摄像头+麦克风权限
4. 连接 LiveKit Room
5. 订阅 remote video track (数字人)
6. 发布 local audio track (麦克风)
7. 可选: 发布 local video track (客户摄像头)
8. 对话中...
9. Room closed → 显示结束画面
```

### 2.3 页面 UI 设计

```
┌─────────────────────────────────────┐
│                                     │
│         ┌─────────────────┐         │
│         │                 │         │
│         │   数字人 Video   │         │
│         │   (remote)      │         │
│         │                 │         │
│         └─────────────────┘         │
│                                     │
│  ┌─────────────────────────────┐    │
│  │  字幕区 (AI 说的内容)        │    │
│  │  "お部屋をお探しですか？"     │    │
│  └─────────────────────────────┘    │
│                                     │
│      ┌────┐    ┌────┐    ┌────┐     │
│      │ 🎤 │    │ 📹 │    │ 📞 │     │
│      │Mute│    │ Cam│    │End │     │
│      └────┘    └────┘    └────┘     │
│                                     │
└─────────────────────────────────────┘
```

### 2.4 LiveKit 连接

```tsx
// hooks/useLiveKit.ts
import { useRoom, useRemoteTracks, useLocalParticipant } from '@livekit/react';

export function useLiveKitRoom(token: string, serverUrl: string) {
  const room = useRoom({
    token,
    serverUrl,
    options: {
      adaptiveStream: true,
      dynacast: true,
      publishDefaults: {
        audioPreset: { maxBitrate: 32_000 },
      },
    },
  });

  const remoteTracks = useRemoteTracks();
  const localParticipant = useLocalParticipant();

  return { room, remoteTracks, localParticipant };
}
```

### 2.5 Token 生成 (Converact Platform 侧)

H5 URL 由 Converact Platform Dialer 通过 `LiveKitMediaModule.joins.prepareJoin` 生成；浏览器链接里不放 LiveKit token：

```typescript
const customerPlan = await media.joins.prepareJoin('webrtc', {
  tenantId,
  roomName: room.room_name,
  identity: `customer-${taskId}`,
  role: 'customer',
  media: 'video'
});

const h5Url = `${H5_BASE_URL}${customerPlan.joinPath}`;
```

### 2.6 微信/浏览器兼容性

| 环境 | WebRTC 支持 | 注意事项 |
|---|---|---|
| Chrome/Edge | 完整 | 无限制 |
| Safari (iOS) | 完整 | 需要 HTTPS |
| 微信内置浏览器 (iOS) | 部分 | 需用 WKWebView，限制较多 |
| 微信内置浏览器 (Android) | X5 内核 | 基本支持，需测试 |
| LINE 内置浏览器 | 有限 | 建议跳转系统浏览器 |

**策略**：检测环境，不支持 WebRTC 的环境显示提示 "请在浏览器中打开此链接"。

---

## 3. SMS 触达通道

### 3.1 设计

```typescript
// src/agent-runtime/call-center/sms-sender.ts

interface SMSSender {
  send(params: {
    to: string;           // E.164 格式手机号
    body: string;         // 短信内容
    tenant_id: string;
  }): Promise<{ success: boolean; message_sid?: string; error?: string }>;
}
```

### 3.2 Provider 抽象

```typescript
interface SMSProvider {
  name: string;
  send(to: string, body: string, from: string): Promise<SMSResult>;
}

class TwilioSMSProvider implements SMSProvider {
  name = 'twilio';
  // Twilio REST API
}

class VonageSMSProvider implements SMSProvider {
  name = 'vonage';
  // Vonage SMS API
}
```

### 3.3 短信模板

```typescript
const SMS_TEMPLATES = {
  video_call_invite: {
    ja: "【{company}】ご案内のビデオ通話をご用意しました。下記リンクからご参加ください。\n{url}\n有効期限: 5分",
    zh: "【{company}】为您准备了视频通话，请点击链接加入：\n{url}\n有效期5分钟",
    en: "[{company}] Your video call is ready. Join here:\n{url}\nValid for 5 minutes",
  },
};
```

### 3.4 发送时机

```
Dialer → executeTask (video_link_sms):
  1. 创建 LiveKit Room
  2. 部署 AI Agent (含 avatar)
  3. 生成客户 token → H5 URL
  4. 发送 SMS
  5. 启动 120s 等待计时器
```

---

## 4. Egress 自动录制

### 4.1 录制策略

| 条件 | 动作 |
|---|---|
| 客户加入视频 Room | 启动 Room Composite Egress |
| 通话结束 (Room 关闭) | Egress 自动结束 → 文件保存到 MinIO |
| 语音外呼 | 仅 Track Composite (audio only) |

### 4.2 启动录制 (Converact Platform 侧)

```typescript
// src/agent-runtime/livekit/egress-controller.ts
import { EgressClient, EncodedFileOutput, EncodedFileType } from 'livekit-server-sdk';

export class EgressController {
  private client: EgressClient;

  constructor() {
    const config = readLiveKitConfig();
    this.client = new EgressClient(config.url!, config.apiKey!, config.apiSecret!);
  }

  async startRoomComposite(roomName: string, callSessionId: string): Promise<string> {
    const output: EncodedFileOutput = {
      fileType: EncodedFileType.MP4,
      filepath: `recordings/{tenant_id}/{call_session_id}/{time}.mp4`,
      s3: {
        accessKey: process.env.MINIO_ACCESS_KEY!,
        secret: process.env.MINIO_SECRET_KEY!,
        bucket: 'recordings',
        endpoint: process.env.MINIO_ENDPOINT || 'http://minio:9000',
        forcePathStyle: true,
      },
    };

    const info = await this.client.startRoomCompositeEgress(
      roomName,
      { file: output },
      {
        layout: 'grid',
        customBaseUrl: undefined,
        audioOnly: false,
      }
    );

    return info.egressId;
  }

  async startAudioOnly(roomName: string): Promise<string> {
    const output: EncodedFileOutput = {
      fileType: EncodedFileType.OGG,
      filepath: `recordings/{tenant_id}/{call_session_id}/{time}.ogg`,
      s3: { /* same as above */ },
    };

    const info = await this.client.startRoomCompositeEgress(
      roomName,
      { file: output },
      { audioOnly: true }
    );

    return info.egressId;
  }
}
```

### 4.3 Egress 完成 → Webhook 处理

```typescript
// src/agent-runtime/livekit/webhook-handler.ts (扩展)
case 'egress_ended': {
  const egress = event.egressInfo!;
  if (egress.status === 'EGRESS_COMPLETE') {
    const file = egress.fileResults?.[0];
    // 写入 call_recordings 表
    db.run(`INSERT INTO call_recordings (
      id, tenant_id, call_session_id, source, format,
      storage_url, duration_ms, file_size_bytes, has_video, egress_id, created_at
    ) VALUES (?, ?, ?, 'livekit_egress', ?, ?, ?, ?, ?, ?, ?)`, [
      randomUUID(),
      tenantId,
      callSessionId,
      file.filename.endsWith('.mp4') ? 'mp4' : 'ogg',
      file.location,    // S3/MinIO path
      file.duration,
      file.size,
      !file.filename.endsWith('.ogg'),
      egress.egressId,
      new Date().toISOString(),
    ]);
  }
}
```

---

## 5. LiveKit Room Metadata 扩展

Phase 2 room metadata 增加视频相关字段：

```json
{
  "tenant_id": "t_xxx",
  "call_session_id": "cs_xxx",
  "outbound_task_id": "ot_xxx",
  "script_id": "real-estate-ja",
  "language": "ja",
  "media_type": "video",
  "avatar_config": {
    "asset": "default",
    "resolution": "720x1280",
    "fps": 25
  },
  "egress_config": {
    "auto_record": true,
    "format": "mp4"
  }
}
```

---

## 6. Phase 2 新增 Converact Platform API

| Method | Path | 说明 |
|---|---|---|
| POST | `/api/call-center/tasks` | 创建视频外呼任务 (channel=video_link_sms) |
| GET | `/api/call-center/recordings/:id/url` | 生成录制文件的临时下载 URL |
| GET | `/api/call-center/calls/:id/recording` | 获取通话录制列表 |
| POST | `/api/livekit/egress/start` | 手动启动录制 (坐席用) |

### 6.1 `GET /api/call-center/recordings/:id/url`

```typescript
interface RecordingUrlResponse {
  url: string;          // 预签名 S3 URL
  expires_in: number;   // 过期时间 (秒)
  format: string;       // mp4 / ogg
  has_video: boolean;
}
```

生成 MinIO pre-signed URL：
```typescript
import { Client as MinioClient } from 'minio';

async function getRecordingUrl(recordingId: string): Promise<RecordingUrlResponse> {
  const row = db.get('SELECT * FROM call_recordings WHERE id = ?', recordingId);
  const url = await minio.presignedGetObject('recordings', row.storage_url, 3600);
  return { url, expires_in: 3600, format: row.format, has_video: row.has_video };
}
```

---

## 7. Docker Compose 变更

Phase 2 在 `docker-compose.callcenter.yml` 增加：

```yaml
  customer-h5:
    build: services/customer-h5
    ports:
      - "5173:5173"
    environment:
      - VITE_LIVEKIT_URL=ws://localhost:7880
    depends_on:
      - livekit
```

---

## 8. Phase 2 测试策略

| 测试 | 类型 | 说明 |
|---|---|---|
| Avatar renderer 单元测试 | 单元 | 帧生成 + 口型切换 |
| H5 页面渲染测试 | E2E (Playwright) | 打开链接 → 看到视频 |
| SMS 发送 mock 测试 | 单元 | Provider 接口正确调用 |
| Egress 触发测试 | 集成 | Room 创建 → Egress 启动 |
| 录制文件完整性 | 手动 | 下载 MP4 验证可播放 |

---

## 9. Phase 2 → Phase 3 衔接

Phase 2 完成后，Phase 3 需要：
- 人工坐席的 React 前端面板
- 转接编排器 (Transfer Orchestrator) 的完整实现
- 坐席加入已有 Room 的流程
- 坐席间转接 / 三方会议
