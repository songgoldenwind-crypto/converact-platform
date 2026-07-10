from __future__ import annotations

from config import (
    DEEPGRAM_API_KEY,
    FUNASR_URL,
    OPENAI_API_KEY,
    SPEECH_ASR_PROVIDER,
)


def select_stt(language: str):
    if SPEECH_ASR_PROVIDER == "funasr" and FUNASR_URL:
        from livekit.plugins import openai

        model = "sensevoice" if language == "zh" else "fun-asr-nano"
        return openai.STT(
            model=model,
            language=language,
            base_url=f"{FUNASR_URL.rstrip('/')}/v1",
            api_key="funasr",
        )

    if DEEPGRAM_API_KEY:
        from livekit.plugins import deepgram

        lang_map = {"zh": "zh", "ja": "ja", "en": "en", "vi": "vi"}
        return deepgram.STT(model="nova-3", language=lang_map.get(language, "en"))

    if OPENAI_API_KEY:
        from livekit.plugins import openai

        return openai.STT(model="gpt-4o-mini-transcribe")

    raise RuntimeError(
        "No STT configured: start FunASR (FUNASR_URL) or set DEEPGRAM_API_KEY / OPENAI_API_KEY"
    )
