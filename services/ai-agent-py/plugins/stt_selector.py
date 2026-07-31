from __future__ import annotations

from typing import Any

from config import (
    DEEPGRAM_API_KEY,
    FUNASR_URL,
    OPENAI_API_KEY,
    SPEECH_ASR_FALLBACK_PROVIDERS,
    SPEECH_ASR_PROVIDER,
)
from plugins.provider_runtime import normalize_provider_order, wrap_stt_candidates

_ALLOWED_PROVIDERS = {"funasr", "deepgram", "openai"}


def select_stt(language: str, *, vad: Any = None):
    order = normalize_provider_order(
        SPEECH_ASR_PROVIDER,
        SPEECH_ASR_FALLBACK_PROVIDERS,
        allowed=_ALLOWED_PROVIDERS,
        capability="ASR",
    )
    candidates = [
        (provider, instance)
        for provider in order
        if (instance := _create_stt(provider, language)) is not None
    ]
    return wrap_stt_candidates(candidates, vad=vad)


def _create_stt(provider: str, language: str):
    if provider == "funasr":
        if not FUNASR_URL:
            return None
        from livekit.plugins import openai

        model = "sensevoice" if language == "zh" else "fun-asr-nano"
        return openai.STT(
            model=model,
            language=language,
            base_url=f"{FUNASR_URL.rstrip('/')}/v1",
            api_key="funasr",
        )
    if provider == "deepgram":
        if not DEEPGRAM_API_KEY:
            return None
        from livekit.plugins import deepgram

        language_map = {"zh": "zh", "ja": "ja", "en": "en", "vi": "vi"}
        return deepgram.STT(
            model="nova-3",
            language=language_map.get(language, "en"),
            api_key=DEEPGRAM_API_KEY,
            interim_results=True,
            no_delay=True,
        )
    if provider == "openai":
        if not OPENAI_API_KEY:
            return None
        from livekit.plugins import openai

        return openai.STT(
            model="gpt-4o-mini-transcribe",
            language=language,
            api_key=OPENAI_API_KEY,
        )
    return None
