from __future__ import annotations

import asyncio
import json
import struct

import pytest
from websockets.asyncio.server import serve

from livekit_audio_tap import LiveKitAudioTapFrame, LiveKitAudioTapTrackContext
from livekit_audio_tap_transport import (
    LIVEKIT_AUDIO_TAP_PROTOCOL,
    create_livekit_audio_tap_sink_factory,
    encode_livekit_audio_tap_frame,
    start_configured_livekit_audio_tap,
)
from converact_client import ConveractClient


def track_context() -> LiveKitAudioTapTrackContext:
    return LiveKitAudioTapTrackContext(
        tenant_id="tenant-1",
        interaction_id="call-1",
        media_session_id="room-1",
        media_source="livekit",
        room_name="room-1",
        participant_id="customer-1",
        track_id="TR_microphone",
        track_source="microphone",
        purpose="live_translation",
        consent_ref="consent-1",
        source_language="en",
        target_languages=("zh-CN",),
        features=("streaming_asr", "streaming_translation"),
    )


def audio_frame(sequence: int = 7) -> LiveKitAudioTapFrame:
    return LiveKitAudioTapFrame(
        sequence=sequence,
        received_at_micros=1_753_234_567_890_123,
        sample_rate_hz=16_000,
        channels=1,
        sample_count=320,
        duration_ms=20,
        pcm_s16le=b"\x01\x02" * 320,
    )


@pytest.mark.asyncio
async def test_converact_client_requests_one_track_authorization_with_tenant_scope() -> None:
    client = ConveractClient.__new__(ConveractClient)
    requests: list[dict] = []

    async def request(method, path, *, json_body=None, extra_headers=None):
        requests.append({
            "method": method,
            "path": path,
            "json_body": json_body,
            "extra_headers": extra_headers,
        })
        return {
            "token": "track-token",
            "gateway_url": "ws://converact:3010/api/ivekit/realtime-audio-tap/livekit",
            "protocol": LIVEKIT_AUDIO_TAP_PROTOCOL,
            "audio": {
                "encoding": "pcm_s16le",
                "sample_rate": 16_000,
                "channels": 1,
            },
        }

    client._request_json = request
    result = await client.authorize_livekit_audio_tap(
        tenant_id="tenant-1",
        call_id="call-1",
        participant_id="customer-1",
        track_id="TR_microphone",
    )

    assert result["token"] == "track-token"
    assert requests == [{
        "method": "POST",
        "path": "/api/ivekit/media/calls/call-1/realtime-audio-tap-authorizations",
        "json_body": {
            "participant_id": "customer-1",
            "track_id": "TR_microphone",
        },
        "extra_headers": {"X-Tenant-Id": "tenant-1"},
    }]


def test_pcm_frame_encoding_matches_livekit_gateway_wire_format() -> None:
    frame = audio_frame()
    encoded = encode_livekit_audio_tap_frame(frame)

    assert len(encoded) == 32 + len(frame.pcm_s16le)
    assert struct.unpack(">4sBBBBQQII", encoded[:32]) == (
        b"LAT1",
        1,
        1,
        1,
        0,
        frame.sequence,
        frame.received_at_micros,
        16_000,
        320,
    )
    assert encoded[32:] == frame.pcm_s16le


@pytest.mark.asyncio
async def test_transport_reauthorizes_and_retries_current_frame_after_disconnect() -> None:
    converact = FakeConveractClient()
    first = FakeWebSocket(fail_first_binary=True)
    second = FakeWebSocket()
    sockets = [first, second]
    connect_calls: list[dict] = []

    async def connect(url: str, **options):
        connect_calls.append({"url": url, **options})
        return sockets.pop(0)

    factory = create_livekit_audio_tap_sink_factory(
        converact,
        connect=connect,
        max_reconnect_attempts=1,
        reconnect_delays_seconds=(0,),
    )
    sink = await factory(track_context())
    frame = audio_frame()
    await sink.write(frame)
    await sink.close("track_unsubscribed")

    assert len(converact.authorization_calls) == 2
    assert [call["subprotocols"] for call in connect_calls] == [
        [LIVEKIT_AUDIO_TAP_PROTOCOL],
        [LIVEKIT_AUDIO_TAP_PROTOCOL],
    ]
    first_start = json.loads(first.sent[0])
    second_start = json.loads(second.sent[0])
    assert first_start["authorization"] == "track-token-1"
    assert second_start["authorization"] == "track-token-2"
    assert first_start["audio"] == {
        "encoding": "pcm_s16le",
        "sample_rate_hz": 16_000,
        "channels": 1,
    }
    assert second.sent[1] == encode_livekit_audio_tap_frame(frame)
    assert json.loads(second.sent[2]) == {
        "protocol": LIVEKIT_AUDIO_TAP_PROTOCOL,
        "event": "end",
        "reason": "track_unsubscribed",
    }
    assert first.closed is True
    assert second.closed is True


@pytest.mark.asyncio
async def test_transport_resets_reconnect_budget_after_a_successful_recovery() -> None:
    converact = FakeConveractClient()
    first = FakeWebSocket(fail_first_binary=True)
    second = FakeWebSocket()
    third = FakeWebSocket()
    sockets = [first, second, third]

    async def connect(_url: str, **_options):
        return sockets.pop(0)

    factory = create_livekit_audio_tap_sink_factory(
        converact,
        connect=connect,
        max_reconnect_attempts=1,
        reconnect_delays_seconds=(0,),
    )
    sink = await factory(track_context())
    await sink.write(audio_frame(7))

    second.fail_next_binary()
    await sink.write(audio_frame(8))
    await sink.close("track_unsubscribed")

    assert len(converact.authorization_calls) == 3
    assert second.sent[-1] == encode_livekit_audio_tap_frame(audio_frame(8))
    assert third.sent[1] == encode_livekit_audio_tap_frame(audio_frame(8))
    assert all(socket.closed for socket in (first, second, third))


@pytest.mark.asyncio
async def test_transport_waits_for_a_bounded_gateway_restart_during_start() -> None:
    converact = FakeConveractClient()
    recovered = FakeWebSocket()
    attempts = 0

    async def connect(_url: str, **_options):
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise ConnectionError("gateway restarting")
        return recovered

    factory = create_livekit_audio_tap_sink_factory(
        converact,
        connect=connect,
        max_reconnect_attempts=2,
        reconnect_delays_seconds=(0,),
    )
    sink = await factory(track_context())
    await sink.write(audio_frame())
    await sink.close("track_unsubscribed")

    assert attempts == 3
    assert len(converact.authorization_calls) == 3
    assert recovered.sent[1] == encode_livekit_audio_tap_frame(audio_frame())


@pytest.mark.asyncio
async def test_default_restart_budget_covers_eight_bounded_reconnect_attempts() -> None:
    converact = FakeConveractClient()
    recovered = FakeWebSocket()
    attempts = 0

    async def connect(_url: str, **_options):
        nonlocal attempts
        attempts += 1
        if attempts < 9:
            raise ConnectionError("gateway still restarting")
        return recovered

    factory = create_livekit_audio_tap_sink_factory(
        converact,
        connect=connect,
        reconnect_delays_seconds=(0,),
    )
    sink = await factory(track_context())
    await sink.close("track_unsubscribed")

    assert attempts == 9
    assert len(converact.authorization_calls) == 9


@pytest.mark.asyncio
async def test_transport_recovers_after_a_loopback_gateway_listener_restart() -> None:
    first_received = asyncio.Event()
    second_received = asyncio.Event()
    first_messages: list[str | bytes] = []
    second_messages: list[str | bytes] = []

    async def first_handler(socket) -> None:
        async for message in socket:
            first_messages.append(message)
            if isinstance(message, bytes):
                first_received.set()

    async def second_handler(socket) -> None:
        async for message in socket:
            second_messages.append(message)
            if isinstance(message, bytes):
                second_received.set()

    first_server = await serve(
        first_handler,
        "127.0.0.1",
        0,
        subprotocols=[LIVEKIT_AUDIO_TAP_PROTOCOL],
    )
    port = first_server.sockets[0].getsockname()[1]
    converact = FakeConveractClient(gateway_url=f"ws://127.0.0.1:{port}/audio-tap")
    factory = create_livekit_audio_tap_sink_factory(
        converact,
        max_reconnect_attempts=8,
        reconnect_delays_seconds=(0.01,),
    )
    sink = await factory(track_context())
    await sink.write(audio_frame(7))
    await asyncio.wait_for(first_received.wait(), timeout=1)

    first_server.close()
    await first_server.wait_closed()

    write_task = asyncio.create_task(sink.write(audio_frame(8)))
    await asyncio.sleep(0.03)
    second_server = await serve(
        second_handler,
        "127.0.0.1",
        port,
        subprotocols=[LIVEKIT_AUDIO_TAP_PROTOCOL],
    )
    try:
        await asyncio.wait_for(write_task, timeout=1)
        await asyncio.wait_for(second_received.wait(), timeout=1)
        await sink.close("track_unsubscribed")
    finally:
        if not write_task.done():
            write_task.cancel()
        second_server.close()
        await second_server.wait_closed()

    assert first_messages[1] == encode_livekit_audio_tap_frame(audio_frame(7))
    assert second_messages[1] == encode_livekit_audio_tap_frame(audio_frame(8))
    assert len(converact.authorization_calls) >= 2


@pytest.mark.asyncio
async def test_configured_tap_starts_only_when_room_metadata_explicitly_enables_it() -> None:
    room = type("Room", (), {"name": "room-1"})()
    created: list[FakeTap] = []

    def tap_factory(**options):
        tap = FakeTap(options)
        created.append(tap)
        return tap

    disabled = await start_configured_livekit_audio_tap(
        room=room,
        metadata={"tenant_id": "tenant-1", "media_call_id": "call-1"},
        converact=FakeConveractClient(),
        tap_factory=tap_factory,
    )
    assert disabled is None
    assert created == []

    enabled = await start_configured_livekit_audio_tap(
        room=room,
        metadata={
            "tenant_id": "tenant-1",
            "media_call_id": "call-1",
            "language": "en",
            "realtime_audio_tap": {
                "enabled": True,
                "purpose": "live_captions",
                "consent_ref": "consent-1",
            },
        },
        converact=FakeConveractClient(),
        on_event=lambda _event: None,
        tap_factory=tap_factory,
    )
    assert enabled is created[0]
    assert enabled.started is True
    assert enabled.options["context"].interaction_id == "call-1"
    assert enabled.options["max_buffered_audio_ms"] == 1_000
    assert callable(enabled.options["sink_factory"])


class FakeConveractClient:
    def __init__(
        self,
        *,
        gateway_url: str = (
            "ws://converact:3010/api/ivekit/realtime-audio-tap/livekit"
        ),
    ) -> None:
        self.authorization_calls: list[dict] = []
        self.gateway_url = gateway_url

    async def authorize_livekit_audio_tap(self, **input):
        self.authorization_calls.append(input)
        sequence = len(self.authorization_calls)
        return {
            "token": f"track-token-{sequence}",
            "gateway_url": self.gateway_url,
            "protocol": LIVEKIT_AUDIO_TAP_PROTOCOL,
            "audio": {
                "encoding": "pcm_s16le",
                "sample_rate": 16_000,
                "channels": 1,
            },
        }


class FakeWebSocket:
    def __init__(self, *, fail_first_binary: bool = False) -> None:
        self.sent: list[str | bytes] = []
        self.closed = False
        self._fail_first_binary = fail_first_binary

    async def send(self, data: str | bytes) -> None:
        self.sent.append(data)
        if isinstance(data, bytes) and self._fail_first_binary:
            self._fail_first_binary = False
            raise ConnectionError("socket reset")

    async def close(self) -> None:
        self.closed = True

    def fail_next_binary(self) -> None:
        self._fail_first_binary = True


class FakeTap:
    def __init__(self, options: dict) -> None:
        self.options = options
        self.started = False

    async def start(self) -> None:
        self.started = True
