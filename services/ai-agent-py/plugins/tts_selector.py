from __future__ import annotations

from config import (
    CARTESIA_API_KEY,
    COSYVOICE_URL,
    OPENAI_API_KEY,
    SPEECH_TTS_FALLBACK_PROVIDERS,
    SPEECH_TTS_PROVIDER,
)
from plugins.cosyvoice_tts import CosyVoiceTTS
from plugins.provider_runtime import normalize_provider_order, wrap_tts_candidates

_ALLOWED_PROVIDERS = {"cosyvoice", "cartesia", "openai"}


def select_tts(language: str, *, avatar_session_key: str | None = None):
    order = normalize_provider_order(
        SPEECH_TTS_PROVIDER,
        SPEECH_TTS_FALLBACK_PROVIDERS,
        allowed=_ALLOWED_PROVIDERS,
        capability="TTS",
    )
    candidates = [
        (provider, instance)
        for provider in order
        if (
            instance := _create_tts(
                provider,
                language,
                avatar_session_key,
            )
        )
        is not None
    ]
    return wrap_tts_candidates(candidates)


def _create_tts(
    provider: str,
    language: str,
    avatar_session_key: str | None,
):
    if provider == "cosyvoice":
        if not COSYVOICE_URL:
            return None
        return CosyVoiceTTS(avatar_session_key=avatar_session_key)
    if provider == "cartesia":
        if not CARTESIA_API_KEY:
            return None
        from livekit.plugins import cartesia

        voices = {
            "ja": "japanese-female-01",
            "zh": "chinese-female-01",
            "en": "9626c31c-bec5-4cca-baa8-f8ba9e84c8bc",
            "vi": "vietnamese-female-01",
        }
        return cartesia.TTS(
            model="sonic-3",
            voice=voices.get(language, voices["en"]),
            language=language,
            api_key=CARTESIA_API_KEY,
            text_pacing=False,
        )
    if provider == "openai":
        if not OPENAI_API_KEY:
            return None
        from livekit.plugins import openai

        return openai.TTS(voice="alloy", api_key=OPENAI_API_KEY)
    return None
