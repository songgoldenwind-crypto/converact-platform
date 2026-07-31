# Mac 中文语音服务（方案 B）

在 **宿主机** 运行 FunASR + CosyVoice，Docker 里的 `ai-agent` / `opc` 通过 `host.docker.internal` 访问。

## 1. FunASR（ASR）

```bash
cd services/speech-host
python3 -m venv .venv-funasr
source .venv-funasr/bin/activate
pip install -r requirements-funasr.txt

# 首次会下载 SenseVoiceSmall 模型（约 1GB）
export FUNASR_DEVICE=mps   # Apple Silicon；Intel Mac 用 cpu
python funasr_server.py
```

验证：

```bash
curl http://127.0.0.1:8899/health
```

## 2. CosyVoice（TTS）

CosyVoice 依赖较重，需单独克隆官方仓库：

```bash
git clone https://github.com/FunAudioLLM/CosyVoice.git ~/CosyVoice
# 按官方 README 下载 CosyVoice2-0.5B 到 pretrained_models/

export COSYVOICE_ROOT=~/CosyVoice
export COSYVOICE_MODEL_DIR=~/CosyVoice/pretrained_models/CosyVoice2-0.5B

cd services/speech-host
source .venv-funasr/bin/activate   # 或独立 venv，需 torch + cosyvoice 依赖
pip install fastapi uvicorn  # + CosyVoice requirements.txt

python cosyvoice_server.py
```

验证：

```bash
curl -X POST http://127.0.0.1:50000/inference_sft \
  -H 'Content-Type: application/json' \
  -d '{"tts_text":"您好，这是语音测试。","spk_id":"中文女"}' \
  --output /tmp/test.wav
afplay /tmp/test.wav
```

> CosyVoice 未就绪时，服务返回 503；可先只测 FunASR + DeepSeek LLM，TTS 临时用 `SPEECH_TTS_PROVIDER=cartesia` + API Key。

## 3. AI Agent 环境变量

```bash
export DEEPSEEK_API_KEY=sk-...
export LLM_BASE_URL=https://api.deepseek.com/v1
export LLM_MODEL=deepseek-chat

export SPEECH_ASR_PROVIDER=funasr
export FUNASR_URL=http://127.0.0.1:8899

export SPEECH_TTS_PROVIDER=cosyvoice
export COSYVOICE_URL=http://127.0.0.1:50000

# Docker 内 ai-agent 访问宿主机 Mac 服务：
export FUNASR_URL=http://host.docker.internal:8899
export COSYVOICE_URL=http://host.docker.internal:50000
```

## 4. 与 callcenter compose 一起启动

```bash
# 终端 1：FunASR
cd services/speech-host && source .venv-funasr/bin/activate && FUNASR_DEVICE=mps python funasr_server.py

# 终端 2：CosyVoice（可选，配置好后）
COSYVOICE_ROOT=~/CosyVoice python cosyvoice_server.py

# 终端 3：全栈
export DEEPSEEK_API_KEY=sk-...
npm run dev:callcenter
```

## 5. 资源参考

| 组件 | 显存/内存 | Mac M 系列 |
|------|-----------|------------|
| FunASR SenseVoice | ~2GB | MPS 可用 |
| CosyVoice2-0.5B | ~4–6GB | MPS 可用，首包较慢 |
| DeepSeek API | 云 | 无本地要求 |
