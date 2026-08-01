"""Provider-neutral realtime voice pipeline policy for LiveKit Agents.

The media transport and conversation authority stay in LiveKit/Converact. ASR, LLM,
and TTS implementations can change without changing turn or audit semantics.
"""
from __future__ import annotations

from math import isfinite
from typing import Any


LATENCY_BUDGETS_MS = {
    "end_of_turn_p95": 500,
    "asr_final_p95": 350,
    "llm_first_token_p95": 350,
    "tts_first_audio_p95": 300,
    "speech_to_speech_p95": 1_200,
}

_VOICE_LATENCY_FIELDS = {
    "user": (
        ("transcription_delay", "asr_final", "asr_final_p95"),
        ("end_of_turn_delay", "end_of_turn", "end_of_turn_p95"),
    ),
    "assistant": (
        ("llm_node_ttft", "llm_first_token", "llm_first_token_p95"),
        ("tts_node_ttfb", "tts_first_audio", "tts_first_audio_p95"),
        ("e2e_latency", "speech_to_speech", "speech_to_speech_p95"),
    ),
}
_VOICE_MEDIA_SOURCES = {"sip", "rustpbx", "pstn", "telephony", "webrtc"}


def build_turn_handling(room_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Build bounded turn settings; room metadata may tune but not disable limits."""
    metadata = room_meta if isinstance(room_meta, dict) else {}
    tuning = metadata.get("voice_runtime")
    tuning = tuning if isinstance(tuning, dict) else {}
    telephony = str(metadata.get("media_source") or "").lower() in {
        "sip",
        "rustpbx",
        "telephony",
        "pstn",
    }

    default_endpoint_min = 350 if telephony else 250
    default_endpoint_max = 1_500 if telephony else 1_200
    default_interruption = 350 if telephony else 250

    endpoint_min_ms = _bounded_number(
        tuning.get("endpointing_min_ms"), default_endpoint_min, 150, 1_000
    )
    endpoint_max_ms = _bounded_number(
        tuning.get("endpointing_max_ms"), default_endpoint_max, 500, 4_000
    )
    endpoint_max_ms = max(endpoint_max_ms, endpoint_min_ms)

    return {
        "turn_detection": "vad",
        "endpointing": {
            "mode": "fixed",
            "min_delay": endpoint_min_ms / 1_000,
            "max_delay": endpoint_max_ms / 1_000,
        },
        "interruption": {
            "enabled": True,
            "mode": "vad",
            "discard_audio_if_uninterruptible": True,
            "min_duration": _bounded_number(
                tuning.get("interruption_min_ms"), default_interruption, 100, 1_500
            )
            / 1_000,
            "min_words": int(
                _bounded_number(tuning.get("interruption_min_words"), 0, 0, 4)
            ),
            "resume_false_interruption": True,
            "false_interruption_timeout": _bounded_number(
                tuning.get("false_interruption_timeout_ms"), 1_000, 500, 3_000
            )
            / 1_000,
        },
        "preemptive_generation": {
            "enabled": tuning.get("preemptive_generation") is not False,
            # Opt-in because it can synthesize output for a turn that changes.
            "preemptive_tts": tuning.get("preemptive_tts") is True,
            "max_speech_duration": _bounded_number(
                tuning.get("preemptive_max_speech_seconds"), 8, 2, 20
            ),
            "max_retries": int(
                _bounded_number(tuning.get("preemptive_max_retries"), 2, 0, 4)
            ),
        },
    }


def vad_load_options(room_meta: dict[str, Any] | None = None) -> dict[str, Any]:
    """Return the worker-prewarm VAD profile used by SIP and WebRTC sessions."""
    metadata = room_meta if isinstance(room_meta, dict) else {}
    tuning = metadata.get("voice_runtime")
    tuning = tuning if isinstance(tuning, dict) else {}
    return {
        "sample_rate": 16_000,
        "min_speech_duration": _bounded_number(
            tuning.get("vad_min_speech_ms"), 80, 50, 500
        )
        / 1_000,
        "min_silence_duration": _bounded_number(
            tuning.get("vad_min_silence_ms"), 350, 200, 1_000
        )
        / 1_000,
        "prefix_padding_duration": _bounded_number(
            tuning.get("vad_prefix_padding_ms"), 400, 200, 1_000
        )
        / 1_000,
        "max_buffered_speech": 60.0,
        "activation_threshold": _bounded_number(
            tuning.get("vad_activation_threshold"), 0.55, 0.35, 0.85
        ),
        "force_cpu": True,
    }


def aec_warmup_seconds(room_meta: dict[str, Any] | None = None) -> float:
    metadata = room_meta if isinstance(room_meta, dict) else {}
    tuning = metadata.get("voice_runtime")
    tuning = tuning if isinstance(tuning, dict) else {}
    telephony = str(metadata.get("media_source") or "").lower() in {
        "sip",
        "rustpbx",
        "telephony",
        "pstn",
    }
    default_ms = 800 if telephony else 2_000
    return _bounded_number(tuning.get("aec_warmup_ms"), default_ms, 0, 3_000) / 1_000


def extract_conversation_turn(event: Any) -> dict[str, Any] | None:
    """Normalize a committed LiveKit conversation item for Converact persistence."""
    item = _field(event, "item")
    if _field(item, "type") != "message":
        return None

    role = _field(item, "role")
    converact_role = "customer" if role == "user" else "ai" if role == "assistant" else None
    if converact_role is None:
        return None

    content = _field(item, "text_content")
    if not isinstance(content, str) or not content.strip():
        return None

    result: dict[str, Any] = {
        "role": converact_role,
        "content": content.strip(),
        "interrupted": _field(item, "interrupted") is True,
    }
    confidence = _finite_number(_field(item, "transcript_confidence"))
    if converact_role == "customer" and confidence is not None and 0 <= confidence <= 1:
        result["stt_confidence"] = confidence

    metrics = _field(item, "metrics")
    if isinstance(metrics, dict):
        latency_key = "end_of_turn_delay" if converact_role == "customer" else "e2e_latency"
        latency_seconds = _finite_number(metrics.get(latency_key))
        if latency_seconds is not None and 0 <= latency_seconds <= 3_600:
            result["latency_ms"] = round(latency_seconds * 1_000)
    return result


def extract_voice_latency_observations(
    event: Any,
    *,
    media_source: Any,
) -> list[dict[str, Any]]:
    """Return bounded, low-cardinality latency samples from a committed turn."""
    item = _field(event, "item")
    if _field(item, "type") != "message":
        return []

    role = _field(item, "role")
    fields = _VOICE_LATENCY_FIELDS.get(role)
    metrics = _field(item, "metrics")
    if fields is None or not isinstance(metrics, dict):
        return []

    normalized_source = _normalize_media_source(media_source)
    observations: list[dict[str, Any]] = []
    for field, stage, budget_key in fields:
        duration_seconds = _finite_number(metrics.get(field))
        if duration_seconds is None or not 0 <= duration_seconds <= 3_600:
            continue
        duration_ms = round(duration_seconds * 1_000)
        budget_ms = LATENCY_BUDGETS_MS[budget_key]
        observations.append(
            {
                "stage": stage,
                "media_source": normalized_source,
                "duration_ms": duration_ms,
                "budget_ms": budget_ms,
                "within_budget": duration_ms <= budget_ms,
            }
        )
    return observations


def _field(value: Any, name: str) -> Any:
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if isfinite(number) else None


def _bounded_number(value: Any, default: float, minimum: float, maximum: float) -> float:
    number = _finite_number(value)
    if number is None:
        number = float(default)
    return min(max(number, minimum), maximum)


def _normalize_media_source(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in _VOICE_MEDIA_SOURCES else "unknown"
