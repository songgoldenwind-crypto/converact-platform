"""Bounded LiveKit audio-tap transport to the internal OPC PCM gateway."""
from __future__ import annotations

import asyncio
import json
import struct
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from urllib.parse import urlsplit

from livekit_audio_tap import (
    LiveKitAudioTap,
    LiveKitAudioTapFrame,
    LiveKitAudioTapSink,
    LiveKitAudioTapSinkFactory,
    LiveKitAudioTapTrackContext,
    livekit_audio_tap_context_from_metadata,
)
from opc_client import OPCClient


LIVEKIT_AUDIO_TAP_PROTOCOL = "ivekit.livekit-audio-tap.v1"
_PCM_HEADER = struct.Struct(">4sBBBBQQII")


class _WebSocket(Protocol):
    subprotocol: str | None

    async def send(self, data: str | bytes) -> None: ...

    async def close(self) -> None: ...


WebSocketConnect = Callable[..., Awaitable[_WebSocket]]


async def start_configured_livekit_audio_tap(
    *,
    room: Any,
    metadata: Any,
    opc: OPCClient,
    on_event: Callable[[dict[str, Any]], Any] | None = None,
    tap_factory: Callable[..., LiveKitAudioTap] = LiveKitAudioTap,
) -> LiveKitAudioTap | None:
    context = livekit_audio_tap_context_from_metadata(
        metadata,
        str(getattr(room, "name", "")),
    )
    if context is None:
        return None
    config = metadata["realtime_audio_tap"]
    frame_size_ms = _integer_option(
        config.get("frame_size_ms"),
        default=20,
        allowed={10, 20, 40, 50, 100},
    )
    max_buffered_audio_ms = _integer_option(
        config.get("max_buffered_audio_ms"),
        default=1_000,
        minimum=frame_size_ms,
        maximum=10_000,
    )
    tap = tap_factory(
        room=room,
        context=context,
        sink_factory=create_livekit_audio_tap_sink_factory(opc),
        max_buffered_audio_ms=max_buffered_audio_ms,
        frame_size_ms=frame_size_ms,
        shutdown_timeout_seconds=1.0,
        on_event=on_event,
    )
    try:
        await tap.start()
    except Exception:
        stop = getattr(tap, "stop", None)
        if callable(stop):
            try:
                await stop()
            except Exception:
                pass
        raise
    return tap


def create_livekit_audio_tap_sink_factory(
    opc: OPCClient,
    *,
    connect: WebSocketConnect | None = None,
    open_timeout_seconds: float = 5.0,
    close_timeout_seconds: float = 1.0,
    max_reconnect_attempts: int = 8,
    reconnect_delays_seconds: tuple[float, ...] = (0.05, 0.2, 0.5, 1.0, 2.0),
) -> LiveKitAudioTapSinkFactory:
    if (
        opc is None
        or not 0.1 <= open_timeout_seconds <= 30
        or not 0.05 <= close_timeout_seconds <= 10
        or not isinstance(max_reconnect_attempts, int)
        or not 0 <= max_reconnect_attempts <= 10
        or not reconnect_delays_seconds
        or any(delay < 0 or delay > 10 for delay in reconnect_delays_seconds)
    ):
        raise ValueError("livekit_audio_tap_transport_invalid")
    connector = connect or _connect_websocket

    async def factory(
        context: LiveKitAudioTapTrackContext,
    ) -> LiveKitAudioTapSink:
        sink = _GatewayAudioTapSink(
            opc=opc,
            context=context,
            connect=connector,
            open_timeout_seconds=open_timeout_seconds,
            close_timeout_seconds=close_timeout_seconds,
            max_reconnect_attempts=max_reconnect_attempts,
            reconnect_delays_seconds=reconnect_delays_seconds,
        )
        await sink.start()
        return sink

    return factory


def encode_livekit_audio_tap_frame(frame: LiveKitAudioTapFrame) -> bytes:
    if (
        frame.sample_rate_hz != 16_000
        or frame.channels != 1
        or not 0 <= frame.sequence < 2**64
        or not 0 <= frame.received_at_micros < 2**64
        or not 160 <= frame.sample_count <= 16_000
        or len(frame.pcm_s16le) != frame.sample_count * 2
        or frame.duration_ms != frame.sample_count // 16
        or not 10 <= frame.duration_ms <= 1_000
    ):
        raise ValueError("livekit_audio_tap_frame_invalid")
    return _PCM_HEADER.pack(
        b"LAT1",
        1,
        1,
        1,
        0,
        frame.sequence,
        frame.received_at_micros,
        frame.sample_rate_hz,
        frame.sample_count,
    ) + frame.pcm_s16le


class _GatewayAudioTapSink:
    def __init__(
        self,
        *,
        opc: OPCClient,
        context: LiveKitAudioTapTrackContext,
        connect: WebSocketConnect,
        open_timeout_seconds: float,
        close_timeout_seconds: float,
        max_reconnect_attempts: int,
        reconnect_delays_seconds: tuple[float, ...],
    ) -> None:
        self._opc = opc
        self._context = context
        self._connect = connect
        self._open_timeout_seconds = open_timeout_seconds
        self._close_timeout_seconds = close_timeout_seconds
        self._max_reconnect_attempts = max_reconnect_attempts
        self._reconnect_delays_seconds = reconnect_delays_seconds
        self._socket: _WebSocket | None = None
        self._reconnects_used = 0
        self._closed = False
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        async with self._lock:
            if self._closed:
                raise RuntimeError("livekit_audio_tap_transport_closed")
            try:
                self._socket = await self._connect_new()
                return
            except Exception:
                await self._discard_socket()

            while self._reconnects_used < self._max_reconnect_attempts:
                delay = self._reconnect_delays_seconds[
                    min(self._reconnects_used, len(self._reconnect_delays_seconds) - 1)
                ]
                self._reconnects_used += 1
                if delay:
                    await asyncio.sleep(delay)
                try:
                    self._socket = await self._connect_new()
                    self._reconnects_used = 0
                    return
                except Exception:
                    await self._discard_socket()
            raise RuntimeError("livekit_audio_tap_transport_unavailable")

    async def write(self, frame: LiveKitAudioTapFrame) -> None:
        payload = encode_livekit_audio_tap_frame(frame)
        async with self._lock:
            if self._closed or self._socket is None:
                raise RuntimeError("livekit_audio_tap_transport_closed")
            try:
                await self._socket.send(payload)
                self._reconnects_used = 0
                return
            except Exception:
                await self._discard_socket()

            while self._reconnects_used < self._max_reconnect_attempts:
                delay = self._reconnect_delays_seconds[
                    min(self._reconnects_used, len(self._reconnect_delays_seconds) - 1)
                ]
                self._reconnects_used += 1
                if delay:
                    await asyncio.sleep(delay)
                try:
                    self._socket = await self._connect_new()
                    await self._socket.send(payload)
                    self._reconnects_used = 0
                    return
                except Exception:
                    await self._discard_socket()
            raise RuntimeError("livekit_audio_tap_transport_unavailable")

    async def close(self, reason: str) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            socket = self._socket
            self._socket = None
            if socket is None:
                return
            try:
                await socket.send(json.dumps({
                    "protocol": LIVEKIT_AUDIO_TAP_PROTOCOL,
                    "event": "end",
                    "reason": _safe_reason(reason),
                }, separators=(",", ":")))
            except Exception:
                pass
            try:
                await asyncio.wait_for(
                    socket.close(),
                    timeout=self._close_timeout_seconds,
                )
            except (TimeoutError, Exception):
                pass

    async def _connect_new(self) -> _WebSocket:
        authorization = _validate_authorization(
            await self._opc.authorize_livekit_audio_tap(
                tenant_id=self._context.tenant_id,
                call_id=self._context.interaction_id,
                participant_id=self._context.participant_id,
                track_id=self._context.track_id,
            )
        )
        socket = await self._connect(
            authorization["gateway_url"],
            subprotocols=[LIVEKIT_AUDIO_TAP_PROTOCOL],
            open_timeout=self._open_timeout_seconds,
            close_timeout=self._close_timeout_seconds,
            compression=None,
            max_size=65_536,
            ping_interval=20,
            ping_timeout=10,
        )
        selected_protocol = getattr(socket, "subprotocol", LIVEKIT_AUDIO_TAP_PROTOCOL)
        if selected_protocol != LIVEKIT_AUDIO_TAP_PROTOCOL:
            await _close_quietly(socket, self._close_timeout_seconds)
            raise RuntimeError("livekit_audio_tap_protocol_mismatch")
        try:
            await socket.send(json.dumps({
                "protocol": LIVEKIT_AUDIO_TAP_PROTOCOL,
                "event": "start",
                "authorization": authorization["token"],
                "media_session_id": self._context.media_session_id,
                "participant_id": self._context.participant_id,
                "track_id": self._context.track_id,
                "audio": {
                    "encoding": "pcm_s16le",
                    "sample_rate_hz": 16_000,
                    "channels": 1,
                },
            }, separators=(",", ":")))
        except Exception:
            await _close_quietly(socket, self._close_timeout_seconds)
            raise
        return socket

    async def _discard_socket(self) -> None:
        socket = self._socket
        self._socket = None
        if socket is not None:
            await _close_quietly(socket, self._close_timeout_seconds)


async def _connect_websocket(url: str, **options: Any) -> _WebSocket:
    from websockets.asyncio.client import connect

    return await connect(url, **options)


async def _close_quietly(socket: _WebSocket, timeout: float) -> None:
    try:
        await asyncio.wait_for(socket.close(), timeout=timeout)
    except (TimeoutError, Exception):
        pass


def _validate_authorization(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise RuntimeError("livekit_audio_tap_authorization_invalid")
    token = value.get("token")
    gateway_url = value.get("gateway_url")
    audio = value.get("audio")
    parsed = urlsplit(gateway_url if isinstance(gateway_url, str) else "")
    if (
        not isinstance(token, str)
        or not 1 <= len(token) <= 8_192
        or value.get("protocol") != LIVEKIT_AUDIO_TAP_PROTOCOL
        or parsed.scheme not in {"ws", "wss"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or bool(parsed.fragment)
        or audio != {
            "encoding": "pcm_s16le",
            "sample_rate": 16_000,
            "channels": 1,
        }
    ):
        raise RuntimeError("livekit_audio_tap_authorization_invalid")
    return {"token": token, "gateway_url": gateway_url}


def _safe_reason(value: Any) -> str:
    text = str(value or "closed").strip()
    if not text or len(text) > 128 or any(ord(char) < 32 for char in text):
        return "closed"
    return text


def _integer_option(
    value: Any,
    *,
    default: int,
    minimum: int | None = None,
    maximum: int | None = None,
    allowed: set[int] | None = None,
) -> int:
    number = default if value is None else value
    if (
        isinstance(number, bool)
        or not isinstance(number, int)
        or (minimum is not None and number < minimum)
        or (maximum is not None and number > maximum)
        or (allowed is not None and number not in allowed)
    ):
        raise ValueError("livekit_audio_tap_transport_limits_invalid")
    return number
