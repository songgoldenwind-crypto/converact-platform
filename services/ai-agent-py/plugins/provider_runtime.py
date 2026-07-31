"""Bounded provider fallback policy for LiveKit voice sessions."""
from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Any

from livekit.agents import llm, stt, tts
from livekit.agents.types import APIConnectOptions
from livekit.agents.voice.agent_session import SessionConnectOptions

from voice_latency_metrics import record_voice_provider_transition


def normalize_provider_order(
    primary: str,
    fallbacks: str,
    *,
    allowed: set[str],
    capability: str,
) -> list[str]:
    result: list[str] = []
    for raw in [primary, *fallbacks.split(",")]:
        name = str(raw or "").strip().lower()
        if not name:
            continue
        if name not in allowed:
            raise ValueError(f"unsupported {capability} provider: {name}")
        if name not in result:
            result.append(name)
    if not result:
        raise ValueError(f"at least one {capability} provider is required")
    if len(result) > 4:
        raise ValueError(f"{capability} provider chain must contain at most four providers")
    return result


def build_session_connect_options(
    env: Mapping[str, str] | None = None,
) -> SessionConnectOptions:
    return SessionConnectOptions(
        stt_conn_options=_connect_options(provider_attempt_timeout("stt", env)),
        llm_conn_options=_connect_options(provider_attempt_timeout("llm", env)),
        tts_conn_options=_connect_options(provider_attempt_timeout("tts", env)),
        max_unrecoverable_errors=_bounded_integer(
            env,
            "AI_AGENT_MAX_UNRECOVERABLE_PROVIDER_ERRORS",
            default=3,
            minimum=1,
            maximum=20,
        ),
    )


def provider_attempt_timeout(
    capability: str,
    env: Mapping[str, str] | None = None,
) -> float:
    defaults = {"stt": 2_000, "llm": 1_200, "tts": 1_500}
    if capability not in defaults:
        raise ValueError(f"unsupported provider timeout capability: {capability}")
    milliseconds = _bounded_integer(
        env,
        f"AI_AGENT_{capability.upper()}_ATTEMPT_TIMEOUT_MS",
        default=defaults[capability],
        minimum=100,
        maximum=30_000,
    )
    return milliseconds / 1_000


def wrap_stt_candidates(
    candidates: list[tuple[str, stt.STT]],
    *,
    vad: Any,
) -> stt.STT:
    if not candidates:
        raise RuntimeError("No configured STT provider is available")
    if len(candidates) == 1:
        return candidates[0][1]
    adapter = stt.FallbackAdapter(
        stt=[provider for _, provider in candidates],
        vad=vad,
        attempt_timeout=provider_attempt_timeout("stt"),
        max_retry_per_stt=0,
        retry_interval=0.2,
    )
    _bind_availability(
        adapter,
        event_name="stt_availability_changed",
        event_provider_attribute="stt",
        capability="asr",
        candidates=candidates,
    )
    return adapter


def wrap_llm_candidates(candidates: list[tuple[str, llm.LLM]]) -> llm.LLM:
    if not candidates:
        raise RuntimeError("No configured LLM provider is available")
    if len(candidates) == 1:
        return candidates[0][1]
    adapter = llm.FallbackAdapter(
        llm=[provider for _, provider in candidates],
        attempt_timeout=provider_attempt_timeout("llm"),
        max_retry_per_llm=0,
        retry_interval=0.2,
        retry_on_chunk_sent=False,
    )
    _bind_availability(
        adapter,
        event_name="llm_availability_changed",
        event_provider_attribute="llm",
        capability="llm",
        candidates=candidates,
    )
    return adapter


def wrap_tts_candidates(candidates: list[tuple[str, tts.TTS]]) -> tts.TTS:
    if not candidates:
        raise RuntimeError("No configured TTS provider is available")
    if len(candidates) == 1:
        return candidates[0][1]
    adapter = tts.FallbackAdapter(
        tts=[provider for _, provider in candidates],
        max_retry_per_tts=0,
    )
    _bind_availability(
        adapter,
        event_name="tts_availability_changed",
        event_provider_attribute="tts",
        capability="tts",
        candidates=candidates,
    )
    return adapter


def _connect_options(timeout: float) -> APIConnectOptions:
    return APIConnectOptions(max_retry=0, retry_interval=0.2, timeout=timeout)


def _bounded_integer(
    env: Mapping[str, str] | None,
    name: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    source = os.environ if env is None else env
    raw = str(source.get(name) or default).strip()
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be between {minimum} and {maximum}")
    return value


def _bind_availability(
    adapter: Any,
    *,
    event_name: str,
    event_provider_attribute: str,
    capability: str,
    candidates: list[tuple[str, Any]],
) -> None:
    names_by_provider = {id(provider): name for name, provider in candidates}

    def on_availability_changed(event: Any) -> None:
        provider = getattr(event, event_provider_attribute, None)
        name = names_by_provider.get(id(provider))
        if name is None:
            return
        record_voice_provider_transition(
            capability=capability,
            provider=name,
            available=getattr(event, "available", False) is True,
        )

    adapter.on(event_name, on_availability_changed)
