from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

from realtime_pipeline import (
    LATENCY_BUDGETS_MS,
    aec_warmup_seconds,
    build_turn_handling,
    extract_conversation_turn,
    extract_voice_latency_observations,
    vad_load_options,
)


def test_session_handler_uses_livekit_1_6_event_contract() -> None:
    source = (Path(__file__).parents[1] / "session_handler.py").read_text()

    assert 'session.on("conversation_item_added")' in source
    assert 'session.on("agent_state_changed")' in source
    assert "agent_started_speaking" not in source
    assert "agent_stopped_speaking" not in source


def test_telephony_turn_handling_uses_bounded_low_latency_defaults() -> None:
    options = build_turn_handling({"media_source": "sip"})

    assert options == {
        "turn_detection": "vad",
        "endpointing": {"mode": "fixed", "min_delay": 0.35, "max_delay": 1.5},
        "interruption": {
            "enabled": True,
            "mode": "vad",
            "discard_audio_if_uninterruptible": True,
            "min_duration": 0.35,
            "min_words": 0,
            "resume_false_interruption": True,
            "false_interruption_timeout": 1.0,
        },
        "preemptive_generation": {
            "enabled": True,
            "preemptive_tts": False,
            "max_speech_duration": 8.0,
            "max_retries": 2,
        },
    }


def test_runtime_tuning_is_clamped_and_does_not_enable_preemptive_tts_by_default() -> None:
    options = build_turn_handling(
        {
            "media_source": "webrtc",
            "voice_runtime": {
                "endpointing_min_ms": -1,
                "endpointing_max_ms": 99_000,
                "interruption_min_ms": 5,
                "false_interruption_timeout_ms": 99_000,
                "preemptive_tts": True,
                "preemptive_max_retries": 99,
            },
        }
    )

    assert options["endpointing"] == {
        "mode": "fixed",
        "min_delay": 0.15,
        "max_delay": 4.0,
    }
    assert options["interruption"]["min_duration"] == 0.1
    assert options["interruption"]["false_interruption_timeout"] == 3.0
    assert options["preemptive_generation"]["preemptive_tts"] is True
    assert options["preemptive_generation"]["max_retries"] == 4


def test_vad_is_tuned_for_16khz_streaming_and_loaded_once_by_worker() -> None:
    assert vad_load_options({"media_source": "sip"}) == {
        "sample_rate": 16_000,
        "min_speech_duration": 0.08,
        "min_silence_duration": 0.35,
        "prefix_padding_duration": 0.4,
        "max_buffered_speech": 60.0,
        "activation_threshold": 0.55,
        "force_cpu": True,
    }
    assert aec_warmup_seconds({"media_source": "sip"}) == 0.8
    assert aec_warmup_seconds({"media_source": "webrtc"}) == 2.0


def test_extract_conversation_turn_uses_final_heard_text_and_latency() -> None:
    item = SimpleNamespace(
        type="message",
        role="assistant",
        text_content="Only the part the caller heard",
        interrupted=True,
        transcript_confidence=None,
        metrics={"e2e_latency": 0.742, "llm_node_ttft": 0.2},
    )

    turn = extract_conversation_turn(SimpleNamespace(item=item))

    assert turn == {
        "role": "ai",
        "content": "Only the part the caller heard",
        "interrupted": True,
        "latency_ms": 742,
    }


def test_extract_conversation_turn_keeps_customer_confidence_and_eou_latency() -> None:
    item = SimpleNamespace(
        type="message",
        role="user",
        text_content="I need help",
        interrupted=False,
        transcript_confidence=0.91,
        metrics={"end_of_turn_delay": 0.438, "transcription_delay": 0.2},
    )

    turn = extract_conversation_turn(SimpleNamespace(item=item))

    assert turn == {
        "role": "customer",
        "content": "I need help",
        "interrupted": False,
        "stt_confidence": 0.91,
        "latency_ms": 438,
    }


def test_extract_conversation_turn_rejects_partial_or_non_message_events() -> None:
    assert extract_conversation_turn(SimpleNamespace(item=SimpleNamespace(type="function_call"))) is None
    assert extract_conversation_turn(SimpleNamespace(item=SimpleNamespace(
        type="message",
        role="system",
        text_content="hidden",
    ))) is None
    assert extract_conversation_turn(SimpleNamespace(item=SimpleNamespace(
        type="message",
        role="assistant",
        text_content="   ",
    ))) is None


def test_extract_customer_voice_latency_observations() -> None:
    item = SimpleNamespace(
        type="message",
        role="user",
        metrics={
            "transcription_delay": 0.2,
            "end_of_turn_delay": 0.438,
        },
    )

    observations = extract_voice_latency_observations(
        SimpleNamespace(item=item),
        media_source="rustpbx",
    )

    assert observations == [
        {
            "stage": "asr_final",
            "media_source": "rustpbx",
            "duration_ms": 200,
            "budget_ms": LATENCY_BUDGETS_MS["asr_final_p95"],
            "within_budget": True,
        },
        {
            "stage": "end_of_turn",
            "media_source": "rustpbx",
            "duration_ms": 438,
            "budget_ms": LATENCY_BUDGETS_MS["end_of_turn_p95"],
            "within_budget": True,
        },
    ]


def test_extract_assistant_voice_latency_observations_and_budget_failures() -> None:
    item = SimpleNamespace(
        type="message",
        role="assistant",
        metrics={
            "llm_node_ttft": 0.351,
            "tts_node_ttfb": 0.287,
            "e2e_latency": 1.201,
        },
    )

    observations = extract_voice_latency_observations(
        SimpleNamespace(item=item),
        media_source="webrtc",
    )

    assert observations == [
        {
            "stage": "llm_first_token",
            "media_source": "webrtc",
            "duration_ms": 351,
            "budget_ms": LATENCY_BUDGETS_MS["llm_first_token_p95"],
            "within_budget": False,
        },
        {
            "stage": "tts_first_audio",
            "media_source": "webrtc",
            "duration_ms": 287,
            "budget_ms": LATENCY_BUDGETS_MS["tts_first_audio_p95"],
            "within_budget": True,
        },
        {
            "stage": "speech_to_speech",
            "media_source": "webrtc",
            "duration_ms": 1201,
            "budget_ms": LATENCY_BUDGETS_MS["speech_to_speech_p95"],
            "within_budget": False,
        },
    ]


def test_voice_latency_observations_reject_invalid_values_and_bound_labels() -> None:
    item = SimpleNamespace(
        type="message",
        role="assistant",
        metrics={
            "llm_node_ttft": float("nan"),
            "tts_node_ttfb": -1,
            "e2e_latency": 3_601,
        },
    )

    assert extract_voice_latency_observations(
        SimpleNamespace(item=item),
        media_source="tenant-supplied-value",
    ) == []
    assert extract_voice_latency_observations(
        SimpleNamespace(item=SimpleNamespace(
            type="message",
            role="assistant",
            metrics={"e2e_latency": 0.5},
        )),
        media_source="tenant-supplied-value",
    ) == [
        {
            "stage": "speech_to_speech",
            "media_source": "unknown",
            "duration_ms": 500,
            "budget_ms": LATENCY_BUDGETS_MS["speech_to_speech_p95"],
            "within_budget": True,
        }
    ]
    assert extract_voice_latency_observations(
        SimpleNamespace(item=SimpleNamespace(type="function_call")),
        media_source="sip",
    ) == []
