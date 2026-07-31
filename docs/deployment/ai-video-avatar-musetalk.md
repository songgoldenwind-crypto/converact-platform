# AI 视频数字人部署指南（MuseTalk）

本文档说明如何从本地 fallback 模式升级到生产环境的 MuseTalk 实时口型驱动。

## 架构回顾

```
客户浏览器 (H5)                          Python Agent 进程
┌─────────────┐                        ┌──────────────────────────────────┐
│ LiveKit     │  ← video track ────── │ AgentSession                      │
│ <video>     │  ← audio track ─────── │   ├─ STT (FunASR)                │
│             │  → mic audio ────────→ │   ├─ LLM (DeepSeek)              │
│             │                        │   ├─ TTS (CosyVoice streaming)   │
│             │                        │   └─ AvatarVideoSource           │
└─────────────┘                        │       ├─ MuseTalk 实时口型生成    │
                                       │       └─ LiveKit avatar-video 轨道 │
                                       └──────────────────────────────────┘
```

## 两种运行模式

### Fallback 模式（无需 GPU，开箱即用）
- 未安装 MuseTalk 或无 GPU 时自动进入
- 发布静态照片视频轨道（无口型动画），帧数随音频时长缩放保持同步
- 用于本地开发、CI、降级保护
- 验证：`cd services/ai-agent-py && python scripts/test_avatar.py`

### 生产模式（MuseTalk 实时口型）
- 需要 CUDA GPU（建议 8GB+ 显存）
- TTS 分块输出经 `avatar/audio_feed.py` 按 `call_session_id`（ContextVar + CosyVoice 显式 session_key）路由到 `AvatarVideoSource.feed_audio()`，同进程多 job 不串音
- MuseTalk GPU 仍建议单 job 独占或限制并发 avatar 数（算力瓶颈，非音频路由问题）

## 生产部署步骤

### 1. GPU 环境准备
```bash
# 确认 CUDA 可用
nvidia-smi
python3 -c "import torch; print(torch.cuda.is_available())"
```

### 2. 安装 MuseTalk
```bash
# 克隆 MuseTalk 仓库到项目根目录上层
cd /path/to/parent
git clone https://github.com/TMElyralab/MuseTalk.git
cd MuseTalk

# 下载模型权重（参见 MuseTalk README）
# 模型放在 MuseTalk/models/ 目录下
bash download_weights.sh   # 或按官方文档手动下载
```

### 3. 安装 Python 依赖
```bash
cd services/ai-agent-py
# avatar 模块依赖 opencv + numpy（已在 requirements）
pip install opencv-python numpy
# MuseTalk 本身的依赖参见其 requirements.txt
pip install -r /path/to/MuseTalk/requirements.txt
```

### 4. 配置环境变量
```bash
# .env 或部署环境
export MUSETALK_MODEL_PATH=/path/to/MuseTalk/models
export AVATAR_DEVICE=cuda          # 自动检测，可省略
export AVATAR_WIDTH=720
export AVATAR_HEIGHT=1280
export AVATAR_FPS=25
export AVATAR_DEFAULT_IMAGE=/path/to/avatar/photo.jpg  # 可选，默认用内置占位图
```

### 5. 验证 MuseTalk 加载
```bash
cd services/ai-agent-py
python scripts/test_avatar.py
# 期望看到: is_fallback=False（表示 MuseTalk 真实加载成功）
```

### 6. 验证 LiveKit 轨道发布
```bash
# 在项目根目录执行；需要真实 LiveKit 可连
export LIVEKIT_URL=ws://localhost:7880
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret
export OPC_AVATAR_SMOKE_ROOM_NAME=opc-avatar-smoke
export OPC_AVATAR_SMOKE_IDENTITY=opc-avatar-smoke-bot
npm run smoke:media:avatar
```

这条 smoke 会生成 LiveKit join token、连接房间、以 `avatar-video` 发布数字人视频轨道、启动渲染循环、喂入几段探测音频、等待帧捕获后关闭渲染循环并断开房间。它可以在 fallback 模式下证明轨道发布链路，也可以在 GPU/MuseTalk 环境下证明真实口型轨道链路。

## 自定义数字人形象

默认使用 `avatar/assets/default.jpg`（占位图）。替换为真人正面照：
- 正面、清晰、单人、512x512 以上
- 设置 `AVATAR_DEFAULT_IMAGE` 指向新照片
- 后续可扩展为租户级 avatar_id → 照片映射（字段已在 VoiceAgentSpec.avatar_id 预留）

## 关键配置项（avatar/config.py）

| 环境变量 | 默认 | 说明 |
|---------|------|------|
| `AVATAR_WIDTH` | 720 | 视频宽度 |
| `AVATAR_HEIGHT` | 1280 | 视频高度（竖屏） |
| `AVATAR_FPS` | 25 | 帧率 |
| `AVATAR_DEVICE` | 自动检测 | cuda/mps/cpu |
| `MUSETALK_MODEL_PATH` | ../../../MuseTalk/models | 模型路径 |
| `AVATAR_DEFAULT_IMAGE` | assets/default.jpg | 默认形象 |
| `AVATAR_AUDIO_CHUNK_MS` | 100 | 音频分块（影响延迟） |
| `OPC_AVATAR_SMOKE_ROOM_NAME` | opc-avatar-smoke | LiveKit 轨道发布 smoke 房间名 |
| `OPC_AVATAR_SMOKE_IDENTITY` | opc-avatar-smoke-bot | LiveKit 轨道发布 smoke 参与人 identity |
| `OPC_AVATAR_SMOKE_SAMPLE_CHUNKS` | 3 | smoke 喂入的探测音频块数 |
| `OPC_AVATAR_SMOKE_SETTLE_SECONDS` | 0.5 | smoke 发布后等待帧捕获的时间 |

## 触发数字人的调用链

1. 外呼任务 `channel='video_link_sms'` → `outbound-dialer.ts` 创建 `ai_outbound` 房间
2. 房间 metadata 带 `avatar_enabled: true`
3. Python Agent `entrypoint()` 读取 metadata → 初始化 `AvatarVideoSource` → 以 `avatar-video` 名称发布 `LocalVideoTrack`
4. TTS 流式音频 → MuseTalk 推理 → 视频帧 → `VideoSource.capture_frame()`
5. 客户 H5 订阅 video track → 看到数字人说话

## 性能与降级

- **延迟**：TTS 流式（100ms 块）+ MuseTalk 推理（GPU 上 <40ms/帧）≈ 实时
- **背压**：帧队列满时丢弃最旧帧，优先保证低延迟
- **降级链**：MuseTalk 推理失败 → 单帧 fallback；模型加载失败 → 静态图模式；GPU 不可用 → 静态图模式。任何失败都不影响音频对话。

## 本地开发限制

- Mac MPS 可能不被 MuseTalk 完全支持，本地建议用 fallback 模式验证集成
- 真实口型效果需在 GPU 环境（生产服务器或云 GPU）验证
