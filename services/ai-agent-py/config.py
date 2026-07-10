"""Environment configuration for ai-agent-py."""
from __future__ import annotations

import json
import os

OPC_API_URL = os.getenv("OPC_API_URL", "http://localhost:3000")
OPC_API_KEY = os.getenv("OPC_API_KEY", "dev-opc-key")
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "secret")

# Primary LLM — self-hosted Qwen3.6-27B (OpenAI-compatible)
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "")
LLM_MODEL = os.getenv("LLM_MODEL", "Qwen3.6-27B")
LLM_API_KEY = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY", "Qwen3.6-27B")
LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "8192"))
LLM_TIMEOUT_MS = int(os.getenv("LLM_TIMEOUT_MS", "60000"))

# Fallback LLM — DeepSeek (used when primary transport fails)
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")
_deepseek_model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
DEEPSEEK_MODEL = "deepseek-reasoner" if _deepseek_model == "pro" else _deepseek_model
DEEPSEEK_MAX_TOKENS = int(os.getenv("DEEPSEEK_MAX_TOKENS", "8192"))
DEEPSEEK_TIMEOUT_MS = int(os.getenv("DEEPSEEK_TIMEOUT_MS", "60000"))

# Cloud speech fallbacks
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY", "")
CARTESIA_API_KEY = os.getenv("CARTESIA_API_KEY", "")

# Self-hosted Chinese speech (Plan B on Mac host)
SPEECH_ASR_PROVIDER = os.getenv("SPEECH_ASR_PROVIDER", "funasr").lower()
SPEECH_TTS_PROVIDER = os.getenv("SPEECH_TTS_PROVIDER", "cosyvoice").lower()
FUNASR_URL = os.getenv("FUNASR_URL", "http://127.0.0.1:8899")
COSYVOICE_URL = os.getenv("COSYVOICE_URL", "http://127.0.0.1:50000")
COSYVOICE_SPK_ID = os.getenv("COSYVOICE_SPK_ID", "中文女")


def parse_llm_extra_body() -> dict:
    raw = os.getenv("LLM_EXTRA_BODY")
    default: dict = {"chat_template_kwargs": {"enable_thinking": False}}
    if not raw:
        return default
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else default
    except json.JSONDecodeError:
        return default


def is_primary_llm_configured() -> bool:
    return bool(os.getenv("LLM_API_KEY") and os.getenv("LLM_BASE_URL"))


def is_fallback_llm_configured() -> bool:
    return bool(DEEPSEEK_API_KEY)


def is_llm_configured() -> bool:
    return is_primary_llm_configured() or is_fallback_llm_configured()
