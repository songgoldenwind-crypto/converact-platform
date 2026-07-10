# AI 视频数字人设计方案

## 概述

在现有 Python LiveKit Agent 上增加 MuseTalk 实时口型驱动的数字人视频轨道发布能力。客户通过 H5 加入 LiveKit 房间后，不仅听到 AI 语音，还能看到数字人实时说话的口型视频。

## 架构

```
客户浏览器 (H5)                          Python Agent 进程
┌─────────────┐                        ┌──────────────────────────────────┐
│ LiveKit     │  ← video track ────── │ AgentSession                      │
│ <video>     │  ← audio track ─────── │   ├─ STT (FunASR)                │
│             │  → mic audio ────────→ │   ├─ LLM (DeepSeek)              │
│             │                        │   ├─ TTS (CosyVoice streaming)   │
│             │                        │   └─ AvatarVideoSource (NEW)     │
└─────────────┘                        │       ├─ MuseTalk 实时口型生成    │
                                       │       └─ LiveKit VideoSource 发布 │
                                       └──────────────────────────────────┘
```

## 新增组件

### 1. `services/ai-agent-py/avatar/` 目录

- `musetalk_runner.py` — MuseTalk 模型加载 + 实时推理（音频帧 → 口型视频帧）
- `video_source.py` — 封装 LiveKit VideoSource，25fps 发布循环
- `config.py` — 分辨率/帧率/模型路径/默认形象配置
- `assets/default.jpg` — 默认数字人照片基准

### 2. TTS 流式改造

`plugins/cosyvoice_tts.py` — `streaming=False` → `streaming=True`，返回分块音频流

### 3. session_handler.py 扩展

在 `entrypoint()` 里初始化 AvatarVideoSource，发布 video track，连接 TTS 音频流到 MuseTalk

### 4. TS 后端小改动

voice-agent-spec-store 读取 avatar_id，room metadata 带 avatar_enabled

## 数据流

1. 客户说话 → STT 流式识别
2. LLM 生成回复文本
3. TTS 流式合成 → 100ms 音频块
4. 每个音频块 → MuseTalk 推理 → 25fps 视频帧
5. 视频帧 → LiveKit VideoSource 发布
6. 客户浏览器订阅 video track 实时播放

## 错误处理

- MuseTalk 推理失败 → 降级到静态照片
- GPU 不可用 → 降级到音量驱动口型切换
- TTS 流式失败 → 回退到整句合成

## 本地开发验证

1. MuseTalk 独立验证：测试音频 + 默认照片 → 生成视频帧
2. LiveKit 集成验证：帧发布到 room，浏览器订阅看到视频
