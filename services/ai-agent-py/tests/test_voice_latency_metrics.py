from __future__ import annotations

from pathlib import Path
import time

import pytest
from prometheus_client import REGISTRY

from voice_latency_metrics import (
    VoiceLatencyMetricsDatagramServer,
    prometheus_port,
    record_voice_latency_observations,
    record_voice_provider_transition,
    voice_metrics_udp_host,
    voice_metrics_udp_port,
)


class _MetricChild:
    def __init__(self) -> None:
        self.observed: list[float] = []
        self.increments = 0

    def observe(self, value: float) -> None:
        self.observed.append(value)

    def inc(self) -> None:
        self.increments += 1


class _Metric:
    def __init__(self) -> None:
        self.children: dict[tuple[str, ...], _MetricChild] = {}

    def labels(self, **labels: str) -> _MetricChild:
        return self.children.setdefault(tuple(labels.values()), _MetricChild())


def test_records_histograms_and_only_counts_budget_failures() -> None:
    histogram = _Metric()
    violations = _Metric()

    record_voice_latency_observations(
        [
            {
                "stage": "llm_first_token",
                "media_source": "sip",
                "duration_ms": 340,
                "budget_ms": 350,
                "within_budget": True,
            },
            {
                "stage": "tts_first_audio",
                "media_source": "sip",
                "duration_ms": 420,
                "budget_ms": 300,
                "within_budget": False,
            },
        ],
        histogram=histogram,
        violations=violations,
    )

    assert histogram.children[("llm_first_token", "sip")].observed == [0.34]
    assert histogram.children[("tts_first_audio", "sip")].observed == [0.42]
    assert ("llm_first_token", "sip") not in violations.children
    assert violations.children[("tts_first_audio", "sip")].increments == 1


def test_prometheus_worker_settings_are_bounded() -> None:
    assert prometheus_port({}) == 9090
    assert prometheus_port({"AI_AGENT_PROMETHEUS_PORT": "19090"}) == 19090
    assert voice_metrics_udp_host({}) == "127.0.0.1"
    assert voice_metrics_udp_port({}) == 9125
    assert voice_metrics_udp_port({"AI_AGENT_VOICE_METRICS_UDP_PORT": "19125"}) == 19125

    with pytest.raises(ValueError, match="AI_AGENT_PROMETHEUS_PORT"):
        prometheus_port({"AI_AGENT_PROMETHEUS_PORT": "70000"})
    with pytest.raises(ValueError, match="loopback"):
        voice_metrics_udp_host({"AI_AGENT_VOICE_METRICS_UDP_HOST": "0.0.0.0"})
    with pytest.raises(ValueError, match="AI_AGENT_VOICE_METRICS_UDP_PORT"):
        voice_metrics_udp_port({"AI_AGENT_VOICE_METRICS_UDP_PORT": "0"})


def test_session_handler_starts_datagram_collector_before_worker() -> None:
    source = (Path(__file__).parents[1] / "session_handler.py").read_text()

    server_index = source.index("start_voice_latency_metrics_server()")
    worker_index = source.index("cli.run_app(")
    assert server_index < worker_index


def test_datagram_collector_moves_child_observations_to_parent_metrics() -> None:
    histogram = _Metric()
    violations = _Metric()
    server = VoiceLatencyMetricsDatagramServer(
        host="127.0.0.1",
        port=0,
        histogram=histogram,
        violations=violations,
    )
    server.start()
    try:
        sent = record_voice_latency_observations(
            [
                {
                    "stage": "asr_final",
                    "media_source": "sip",
                    "duration_ms": 200,
                    "budget_ms": 350,
                    "within_budget": True,
                }
            ],
            udp_target=("127.0.0.1", server.port),
        )
        deadline = time.monotonic() + 1
        while ("asr_final", "sip") not in histogram.children and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        server.close()

    assert sent is True
    assert histogram.children[("asr_final", "sip")].observed == [0.2]


def test_datagram_collector_updates_the_scraped_prometheus_registry() -> None:
    server = VoiceLatencyMetricsDatagramServer(host="127.0.0.1", port=0)
    server.start()
    try:
        sent = record_voice_latency_observations(
            [
                {
                    "stage": "speech_to_speech",
                    "media_source": "webrtc",
                    "duration_ms": 800,
                    "budget_ms": 1_200,
                    "within_budget": True,
                }
            ],
            udp_target=("127.0.0.1", server.port),
        )
        deadline = time.monotonic() + 1
        value = None
        while value is None and time.monotonic() < deadline:
            value = REGISTRY.get_sample_value(
                "opc_ai_voice_stage_latency_seconds_count",
                {"stage": "speech_to_speech", "media_source": "webrtc"},
            )
            time.sleep(0.01)
    finally:
        server.close()

    assert sent is True
    assert value == 1


def test_datagram_collector_records_bounded_provider_transitions() -> None:
    histogram = _Metric()
    violations = _Metric()
    transitions = _Metric()
    server = VoiceLatencyMetricsDatagramServer(
        host="127.0.0.1",
        port=0,
        histogram=histogram,
        violations=violations,
        provider_transitions=transitions,
    )
    server.start()
    try:
        sent = record_voice_provider_transition(
            capability="llm",
            provider="deepseek",
            available=False,
            udp_target=("127.0.0.1", server.port),
        )
        deadline = time.monotonic() + 1
        labels = ("llm", "deepseek", "unavailable")
        while labels not in transitions.children and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        server.close()

    assert sent is True
    assert transitions.children[labels].increments == 1
