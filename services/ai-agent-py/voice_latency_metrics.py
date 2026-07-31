"""Low-cardinality Prometheus metrics for the realtime voice pipeline."""
from __future__ import annotations

import json
from math import isfinite
import os
import socket
import threading
from typing import Any, Mapping

from prometheus_client import Counter, Histogram


VOICE_STAGE_LATENCY_SECONDS = Histogram(
    "opc_ai_voice_stage_latency_seconds",
    "Committed LiveKit voice-turn latency by bounded pipeline stage",
    ("stage", "media_source"),
    buckets=(0.05, 0.1, 0.15, 0.2, 0.3, 0.35, 0.5, 0.75, 1, 1.2, 1.5, 2, 3, 5, 10),
)
VOICE_LATENCY_BUDGET_EXCEEDED = Counter(
    "opc_ai_voice_latency_budget_exceeded_total",
    "Voice latency observations exceeding the configured stage budget",
    ("stage", "media_source"),
)
VOICE_PROVIDER_TRANSITIONS = Counter(
    "opc_ai_voice_provider_transitions_total",
    "LiveKit voice provider availability changes observed by fallback adapters",
    ("capability", "provider", "state"),
)

_ALLOWED_STAGES = frozenset(
    {
        "asr_final",
        "end_of_turn",
        "llm_first_token",
        "tts_first_audio",
        "speech_to_speech",
    }
)
_ALLOWED_MEDIA_SOURCES = frozenset(
    {"sip", "rustpbx", "pstn", "telephony", "webrtc", "unknown"}
)
_ALLOWED_PROVIDER_CAPABILITIES = frozenset({"asr", "llm", "tts"})
_ALLOWED_PROVIDERS = frozenset(
    {"funasr", "deepgram", "openai", "primary", "deepseek", "cosyvoice", "cartesia"}
)
_MAX_OBSERVATIONS = 5
_MAX_DATAGRAM_BYTES = 4_096
_MAX_DURATION_MS = 3_600_000
_DEFAULT_UDP_HOST = "127.0.0.1"
_DEFAULT_UDP_PORT = 9_125

_sender_socket: socket.socket | None = None
_sender_pid: int | None = None
_server: VoiceLatencyMetricsDatagramServer | None = None
_server_lock = threading.Lock()


def record_voice_latency_observations(
    observations: list[dict[str, Any]],
    *,
    histogram: Any | None = None,
    violations: Any | None = None,
    udp_target: tuple[str, int] | None = None,
) -> bool:
    normalized = _normalize_observations(observations)
    if histogram is not None or violations is not None:
        if histogram is None or violations is None:
            raise ValueError("histogram and violations must be provided together")
        _apply_observations(normalized, histogram, violations)
        return True
    if not normalized:
        return True

    target = udp_target or (voice_metrics_udp_host(), voice_metrics_udp_port())
    _validate_udp_target(*target)
    return _send_datagram(normalized, target)


def record_voice_provider_transition(
    *,
    capability: str,
    provider: str,
    available: bool,
    udp_target: tuple[str, int] | None = None,
) -> bool:
    transition = _normalize_provider_transition(
        {
            "kind": "provider_transition",
            "capability": capability,
            "provider": provider,
            "state": "available" if available else "unavailable",
        }
    )
    target = udp_target or (voice_metrics_udp_host(), voice_metrics_udp_port())
    _validate_udp_target(*target)
    return _send_datagram(transition, target)


def prometheus_port(env: Mapping[str, str] | None = None) -> int:
    return _configured_port(
        env,
        name="AI_AGENT_PROMETHEUS_PORT",
        default=9_090,
    )


def voice_metrics_udp_host(env: Mapping[str, str] | None = None) -> str:
    source = os.environ if env is None else env
    host = str(
        source.get("AI_AGENT_VOICE_METRICS_UDP_HOST") or _DEFAULT_UDP_HOST
    ).strip()
    if host != _DEFAULT_UDP_HOST:
        raise ValueError("AI_AGENT_VOICE_METRICS_UDP_HOST must be the IPv4 loopback address")
    return host


def voice_metrics_udp_port(env: Mapping[str, str] | None = None) -> int:
    return _configured_port(
        env,
        name="AI_AGENT_VOICE_METRICS_UDP_PORT",
        default=_DEFAULT_UDP_PORT,
    )


class VoiceLatencyMetricsDatagramServer:
    def __init__(
        self,
        *,
        host: str,
        port: int,
        histogram: Any = VOICE_STAGE_LATENCY_SECONDS,
        violations: Any = VOICE_LATENCY_BUDGET_EXCEEDED,
        provider_transitions: Any = VOICE_PROVIDER_TRANSITIONS,
    ) -> None:
        if host != _DEFAULT_UDP_HOST:
            raise ValueError("voice metrics server must bind to the IPv4 loopback address")
        if not 0 <= port <= 65_535:
            raise ValueError("voice metrics server port must be between 0 and 65535")
        self._host = host
        self._configured_port = port
        self._histogram = histogram
        self._violations = violations
        self._provider_transitions = provider_transitions
        self._socket: socket.socket | None = None
        self._thread: threading.Thread | None = None
        self._stopped = threading.Event()

    @property
    def port(self) -> int:
        if self._socket is None:
            return self._configured_port
        return int(self._socket.getsockname()[1])

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        receiver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 262_144)
        receiver.bind((self._host, self._configured_port))
        receiver.settimeout(0.2)
        self._socket = receiver
        self._stopped.clear()
        self._thread = threading.Thread(
            target=self._serve,
            name="voice-latency-metrics",
            daemon=True,
        )
        self._thread.start()

    def close(self) -> None:
        self._stopped.set()
        receiver = self._socket
        self._socket = None
        if receiver is not None:
            receiver.close()
        thread = self._thread
        self._thread = None
        if thread is not None:
            thread.join(timeout=1)

    def _serve(self) -> None:
        receiver = self._socket
        if receiver is None:
            return
        while not self._stopped.is_set():
            try:
                payload, source = receiver.recvfrom(_MAX_DATAGRAM_BYTES + 1)
            except socket.timeout:
                continue
            except OSError:
                return
            if source[0] != _DEFAULT_UDP_HOST or len(payload) > _MAX_DATAGRAM_BYTES:
                continue
            try:
                decoded = json.loads(payload.decode("ascii"))
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                continue
            try:
                if isinstance(decoded, list):
                    observations = _normalize_observations(decoded)
                    _apply_observations(observations, self._histogram, self._violations)
                else:
                    transition = _normalize_provider_transition(decoded)
                    self._provider_transitions.labels(
                        capability=transition["capability"],
                        provider=transition["provider"],
                        state=transition["state"],
                    ).inc()
            except (TypeError, ValueError):
                continue


def start_voice_latency_metrics_server() -> VoiceLatencyMetricsDatagramServer:
    global _server
    with _server_lock:
        if _server is None:
            _server = VoiceLatencyMetricsDatagramServer(
                host=voice_metrics_udp_host(),
                port=voice_metrics_udp_port(),
            )
            _server.start()
        return _server


def _configured_port(
    env: Mapping[str, str] | None,
    *,
    name: str,
    default: int,
) -> int:
    source = os.environ if env is None else env
    raw = str(source.get(name) or default).strip()
    try:
        port = int(raw)
    except ValueError as error:
        raise ValueError(f"{name} must be an integer") from error
    if not 1 <= port <= 65_535:
        raise ValueError(f"{name} must be between 1 and 65535")
    return port


def _validate_udp_target(host: str, port: int) -> None:
    if host != _DEFAULT_UDP_HOST:
        raise ValueError("voice metrics UDP target must use the IPv4 loopback address")
    if not 1 <= port <= 65_535:
        raise ValueError("voice metrics UDP target port must be between 1 and 65535")


def _normalize_observations(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list) or len(raw) > _MAX_OBSERVATIONS:
        raise ValueError("voice latency observations must be a bounded list")

    normalized: list[dict[str, Any]] = []
    for observation in raw:
        if not isinstance(observation, dict):
            raise ValueError("voice latency observation must be an object")
        stage = observation.get("stage")
        media_source = observation.get("media_source")
        duration_raw = observation.get("duration_ms")
        within_budget = observation.get("within_budget")
        if stage not in _ALLOWED_STAGES:
            raise ValueError("unsupported voice latency stage")
        if media_source not in _ALLOWED_MEDIA_SOURCES:
            raise ValueError("unsupported voice latency media source")
        if isinstance(duration_raw, bool) or not isinstance(duration_raw, (int, float)):
            raise ValueError("voice latency duration must be numeric")
        duration_ms = float(duration_raw)
        if not isfinite(duration_ms) or not 0 <= duration_ms <= _MAX_DURATION_MS:
            raise ValueError("voice latency duration is outside the accepted range")
        if not isinstance(within_budget, bool):
            raise ValueError("voice latency budget result must be boolean")
        normalized.append(
            {
                "stage": stage,
                "media_source": media_source,
                "duration_ms": duration_ms,
                "within_budget": within_budget,
            }
        )
    return normalized


def _apply_observations(
    observations: list[dict[str, Any]],
    histogram: Any,
    violations: Any,
) -> None:
    for observation in observations:
        labels = {
            "stage": observation["stage"],
            "media_source": observation["media_source"],
        }
        histogram.labels(**labels).observe(observation["duration_ms"] / 1_000)
        if observation["within_budget"] is False:
            violations.labels(**labels).inc()


def _normalize_provider_transition(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict) or raw.get("kind") != "provider_transition":
        raise ValueError("unsupported voice metrics datagram")
    capability = raw.get("capability")
    provider = raw.get("provider")
    state = raw.get("state")
    if capability not in _ALLOWED_PROVIDER_CAPABILITIES:
        raise ValueError("unsupported voice provider capability")
    if provider not in _ALLOWED_PROVIDERS:
        raise ValueError("unsupported voice provider")
    if state not in {"available", "unavailable"}:
        raise ValueError("unsupported voice provider state")
    return {
        "kind": "provider_transition",
        "capability": capability,
        "provider": provider,
        "state": state,
    }


def _send_datagram(payload_value: Any, target: tuple[str, int]) -> bool:
    payload = json.dumps(
        payload_value,
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    if len(payload) > _MAX_DATAGRAM_BYTES:
        return False
    sender = _get_sender_socket()
    try:
        return sender.sendto(payload, target) == len(payload)
    except (BlockingIOError, OSError):
        return False


def _get_sender_socket() -> socket.socket:
    global _sender_pid, _sender_socket
    pid = os.getpid()
    if _sender_socket is None or _sender_pid != pid:
        if _sender_socket is not None:
            _sender_socket.close()
        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sender.setblocking(False)
        sender.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 65_536)
        _sender_socket = sender
        _sender_pid = pid
    return _sender_socket
