from __future__ import annotations

import asyncio
import io
import wave

import pytest
from livekit.agents import llm, stt, tts
from livekit.agents.types import APIConnectOptions
from livekit.plugins import deepgram, openai

from plugins import llm_config, stt_selector, tts_selector
from plugins import cosyvoice_tts
from plugins.cosyvoice_tts import CosyVoiceTTS, _http_timeout_seconds
from plugins.provider_runtime import (
    build_session_connect_options,
    normalize_provider_order,
)


def test_provider_order_is_explicit_bounded_and_deduplicated() -> None:
    assert normalize_provider_order(
        "funasr",
        "deepgram, openai,deepgram",
        allowed={"funasr", "deepgram", "openai"},
        capability="ASR",
    ) == ["funasr", "deepgram", "openai"]

    with pytest.raises(ValueError, match="unsupported ASR provider"):
        normalize_provider_order(
            "funasr",
            "unknown",
            allowed={"funasr", "deepgram", "openai"},
            capability="ASR",
        )


def test_stt_selector_builds_official_fallback_in_configured_order(monkeypatch) -> None:
    providers = {
        "funasr": deepgram.STT(api_key="test"),
        "deepgram": deepgram.STT(api_key="test"),
    }
    monkeypatch.setattr(stt_selector, "SPEECH_ASR_PROVIDER", "funasr")
    monkeypatch.setattr(
        stt_selector,
        "SPEECH_ASR_FALLBACK_PROVIDERS",
        "deepgram",
        raising=False,
    )
    monkeypatch.setattr(
        stt_selector,
        "_create_stt",
        lambda provider, language: providers.get(provider),
        raising=False,
    )

    selected = stt_selector.select_stt("zh", vad=object())

    assert isinstance(selected, stt.FallbackAdapter)
    assert selected._stt_instances == [providers["funasr"], providers["deepgram"]]
    assert selected._max_retry_per_stt == 0


def test_llm_selector_fails_over_without_retrying_after_output(monkeypatch) -> None:
    providers = {
        "primary": openai.LLM(model="primary", api_key="test"),
        "deepseek": openai.LLM(model="fallback", api_key="test"),
    }
    monkeypatch.setattr(
        llm_config,
        "LLM_FALLBACK_PROVIDERS",
        "deepseek",
        raising=False,
    )
    monkeypatch.setattr(
        llm_config,
        "_create_llm",
        lambda provider: providers.get(provider),
        raising=False,
    )

    selected = llm_config.get_llm()

    assert isinstance(selected, llm.FallbackAdapter)
    assert selected._llm_instances == [providers["primary"], providers["deepseek"]]
    assert selected._max_retry_per_llm == 0
    assert selected._retry_on_chunk_sent is False


def test_tts_selector_fails_over_only_before_audio_is_emitted(monkeypatch) -> None:
    providers = {
        "cosyvoice": openai.TTS(api_key="test"),
        "cartesia": openai.TTS(api_key="test"),
    }
    monkeypatch.setattr(tts_selector, "SPEECH_TTS_PROVIDER", "cosyvoice")
    monkeypatch.setattr(
        tts_selector,
        "SPEECH_TTS_FALLBACK_PROVIDERS",
        "cartesia",
        raising=False,
    )
    monkeypatch.setattr(
        tts_selector,
        "_create_tts",
        lambda provider, language, avatar_session_key: providers.get(provider),
        raising=False,
    )

    selected = tts_selector.select_tts("zh", avatar_session_key="avatar-1")

    assert isinstance(selected, tts.FallbackAdapter)
    assert selected._tts_instances == [providers["cosyvoice"], providers["cartesia"]]
    assert selected._max_retry_per_tts == 0


def test_session_provider_timeouts_are_bounded_and_disable_nested_retries() -> None:
    options = build_session_connect_options(
        {
            "AI_AGENT_STT_ATTEMPT_TIMEOUT_MS": "1800",
            "AI_AGENT_LLM_ATTEMPT_TIMEOUT_MS": "1200",
            "AI_AGENT_TTS_ATTEMPT_TIMEOUT_MS": "1500",
        }
    )

    assert options.stt_conn_options.timeout == 1.8
    assert options.llm_conn_options.timeout == 1.2
    assert options.tts_conn_options.timeout == 1.5
    assert options.stt_conn_options.max_retry == 0
    assert options.llm_conn_options.max_retry == 0
    assert options.tts_conn_options.max_retry == 0

    with pytest.raises(ValueError, match="AI_AGENT_LLM_ATTEMPT_TIMEOUT_MS"):
        build_session_connect_options({"AI_AGENT_LLM_ATTEMPT_TIMEOUT_MS": "50"})


def test_cosyvoice_http_timeout_uses_session_provider_deadline() -> None:
    options = APIConnectOptions(max_retry=0, retry_interval=0.2, timeout=1.5)

    assert _http_timeout_seconds(options) == 1.5


def test_cosyvoice_reports_non_streaming_endpoint_capability() -> None:
    provider = CosyVoiceTTS(
        base_url="http://cosyvoice.invalid",
        spk_id="speaker",
    )

    assert provider.capabilities.streaming is False


@pytest.mark.asyncio
async def test_cosyvoice_enforces_hard_session_deadline(monkeypatch) -> None:
    class SlowClient:
        def __init__(self, **_kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args) -> None:
            return None

        async def post(self, *_args, **_kwargs):
            await asyncio.sleep(0.2)
            return FakeResponse(_wav_bytes())

    class FakeResponse:
        def __init__(self, content: bytes) -> None:
            self.content = content

        def raise_for_status(self) -> None:
            return None

    monkeypatch.setattr(cosyvoice_tts.httpx, "AsyncClient", SlowClient)
    provider = CosyVoiceTTS(
        base_url="http://cosyvoice.invalid",
        spk_id="speaker",
    )
    options = APIConnectOptions(max_retry=0, retry_interval=0.2, timeout=0.05)

    with pytest.raises(TimeoutError):
        async with provider.synthesize("hello", conn_options=options) as stream:
            await stream.collect()


def _wav_bytes() -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(22_050)
        wav_file.writeframes(b"\0\0" * 2_205)
    return output.getvalue()
