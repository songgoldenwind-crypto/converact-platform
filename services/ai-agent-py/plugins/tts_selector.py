from __future__ import annotations

from config import CARTESIA_API_KEY, COSYVOICE_URL, OPENAI_API_KEY, SPEECH_TTS_PROVIDER
from plugins.cosyvoice_tts import CosyVoiceTTS


def select_tts(language: str, *, avatar_session_key: str | None = None):
    if SPEECH_TTS_PROVIDER == "cosyvoice" and COSYVOICE_URL:
        return CosyVoiceTTS(avatar_session_key=avatar_session_key)

    if CARTESIA_API_KEY:
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
        )

    if OPENAI_API_KEY:
        from livekit.plugins import openai

        return openai.TTS(voice="alloy")

    raise RuntimeError(
        "No TTS configured: start CosyVoice (COSYVOICE_URL) or set CARTESIA_API_KEY / OPENAI_API_KEY"
    )
