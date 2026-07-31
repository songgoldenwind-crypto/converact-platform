from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest

from livekit_audio_tap import (
    LiveKitAudioTap,
    LiveKitAudioTapContext,
    LiveKitAudioTapFrame,
    LiveKitAudioTapTrackContext,
    livekit_audio_tap_context_from_metadata,
)


class FakeRoom:
    def __init__(self) -> None:
        self.name = "room-1"
        self.remote_participants: dict[str, FakeParticipant] = {}
        self.handlers: dict[str, list] = {}

    def on(self, event: str, callback):
        self.handlers.setdefault(event, []).append(callback)
        return callback

    def off(self, event: str, callback) -> None:
        self.handlers.get(event, []).remove(callback)

    def emit(self, event: str, *args) -> None:
        for callback in list(self.handlers.get(event, [])):
            callback(*args)


class FakeParticipant:
    def __init__(self, identity: str) -> None:
        self.identity = identity
        self.track_publications: dict[str, FakePublication] = {}


class FakePublication:
    def __init__(self, sid: str, track, source: str = "microphone") -> None:
        self.sid = sid
        self.track = track
        self.source = source


class FakeAudioStream(AsyncIterator):
    def __init__(self) -> None:
        self.queue: asyncio.Queue[object] = asyncio.Queue()
        self.closed = False

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.queue.get()
        if item is None:
            raise StopAsyncIteration
        return item

    async def aclose(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.queue.put_nowait(None)

    def push(self, marker: int, duration_ms: int = 20) -> None:
        samples = 16 * duration_ms
        frame = SimpleNamespace(
            data=memoryview(bytes([marker]) * samples * 2),
            sample_rate=16_000,
            num_channels=1,
            samples_per_channel=samples,
        )
        self.queue.put_nowait(SimpleNamespace(frame=frame))


class FakeSink:
    def __init__(self, blocked: bool = False) -> None:
        self.frames: list[LiveKitAudioTapFrame] = []
        self.closed_reason = ""
        self.write_started = asyncio.Event()
        self.release = asyncio.Event()
        if not blocked:
            self.release.set()

    async def write(self, frame: LiveKitAudioTapFrame) -> None:
        self.write_started.set()
        await self.release.wait()
        self.frames.append(frame)

    async def close(self, reason: str) -> None:
        self.closed_reason = reason
        self.release.set()


def context() -> LiveKitAudioTapContext:
    return LiveKitAudioTapContext(
        tenant_id="tenant-1",
        interaction_id="interaction-1",
        media_session_id="room-1",
        purpose="live_translation",
        consent_ref="consent-1",
        source_language="en",
        target_languages=("zh-CN",),
        features=("streaming_asr", "streaming_translation"),
    )


def test_audio_tap_context_requires_explicit_enablement_and_consent() -> None:
    metadata = {
        "tenant_id": "tenant-1",
        "media_call_id": "call-1",
        "language": "en",
    }
    assert livekit_audio_tap_context_from_metadata(metadata, "room-1") is None

    metadata["realtime_audio_tap"] = {
        "enabled": True,
        "purpose": "live_translation",
        "consent_ref": "consent-1",
        "target_languages": ["zh-CN", "ja"],
    }
    parsed = livekit_audio_tap_context_from_metadata(metadata, "room-1")
    assert parsed == LiveKitAudioTapContext(
        tenant_id="tenant-1",
        interaction_id="call-1",
        media_session_id="room-1",
        purpose="live_translation",
        consent_ref="consent-1",
        source_language="en",
        target_languages=("zh-CN", "ja"),
        features=("streaming_asr", "streaming_translation"),
    )

    metadata["realtime_audio_tap"] = {
        "enabled": True,
        "purpose": "live_captions",
    }
    with pytest.raises(ValueError, match="consent_ref"):
        livekit_audio_tap_context_from_metadata(metadata, "room-1")


@pytest.mark.asyncio
async def test_livekit_audio_tap_standardizes_pcm_and_never_backpressures_track() -> None:
    room = FakeRoom()
    participant = FakeParticipant("customer-1")
    track = SimpleNamespace(kind="audio")
    publication = FakePublication("track-1", track)
    stream = FakeAudioStream()
    sink = FakeSink(blocked=True)
    events: list[dict] = []
    stream_options: list[dict] = []

    def audio_stream_factory(_track, **options):
        stream_options.append(options)
        return stream

    async def sink_factory(track_context: LiveKitAudioTapTrackContext):
        assert track_context.participant_id == "customer-1"
        assert track_context.track_id == "track-1"
        return sink

    tap = LiveKitAudioTap(
        room=room,
        context=context(),
        sink_factory=sink_factory,
        audio_stream_factory=audio_stream_factory,
        is_audio_track=lambda value: value.kind == "audio",
        max_buffered_audio_ms=40,
        frame_size_ms=20,
        on_event=events.append,
    )
    await tap.start()
    room.emit("track_subscribed", track, publication, participant)
    stream.push(1)
    await asyncio.wait_for(sink.write_started.wait(), timeout=1)
    for marker in range(2, 8):
        stream.push(marker)
    await wait_until(lambda: any(
        event["type"] == "livekit_audio_tap.frame_dropped" for event in events
    ))
    sink.release.set()
    await wait_until(lambda: len(sink.frames) >= 3)
    await tap.stop()

    assert stream_options == [{
        "capacity": 2,
        "sample_rate": 16_000,
        "num_channels": 1,
        "frame_size_ms": 20,
    }]
    assert [frame.pcm_s16le[0] for frame in sink.frames] == [1, 6, 7]
    assert all(frame.sample_rate_hz == 16_000 for frame in sink.frames)
    assert all(frame.channels == 1 for frame in sink.frames)
    assert all(frame.duration_ms == 20 for frame in sink.frames)
    assert sum(
        int(event.get("dropped_duration_ms", 0))
        for event in events
        if event["type"] == "livekit_audio_tap.frame_dropped"
    ) == 80
    assert stream.closed is True
    assert sink.closed_reason == "worker_draining"


@pytest.mark.asyncio
async def test_livekit_audio_tap_isolates_tracks_and_closes_on_unpublish_and_reconnect() -> None:
    room = FakeRoom()
    participant_a = FakeParticipant("customer-a")
    participant_b = FakeParticipant("customer-b")
    track_a = SimpleNamespace(kind="audio")
    track_b = SimpleNamespace(kind="audio")
    publication_a = FakePublication("track-a", track_a)
    publication_b = FakePublication("track-b", track_b)
    participant_a.track_publications[publication_a.sid] = publication_a
    participant_b.track_publications[publication_b.sid] = publication_b
    room.remote_participants = {
        participant_a.identity: participant_a,
        participant_b.identity: participant_b,
    }
    streams = {
        id(track_a): FakeAudioStream(),
        id(track_b): FakeAudioStream(),
    }
    created_sinks: dict[tuple[str, str], list[FakeSink]] = {}

    def audio_stream_factory(track, **_options):
        return streams[id(track)]

    async def sink_factory(track_context: LiveKitAudioTapTrackContext):
        sink = FakeSink()
        created_sinks.setdefault(
            (track_context.participant_id, track_context.track_id), []
        ).append(sink)
        return sink

    tap = LiveKitAudioTap(
        room=room,
        context=context(),
        sink_factory=sink_factory,
        audio_stream_factory=audio_stream_factory,
        is_audio_track=lambda value: value.kind == "audio",
    )
    await tap.start()
    await wait_until(lambda: tap.active_track_count == 2 and len(created_sinks) == 2)

    room.emit("track_unsubscribed", track_a, publication_a, participant_a)
    await wait_until(lambda: created_sinks[("customer-a", "track-a")][0].closed_reason != "")
    assert created_sinks[("customer-a", "track-a")][0].closed_reason == "track_unsubscribed"
    assert created_sinks[("customer-b", "track-b")][0].closed_reason == ""

    room.emit("reconnecting")
    await wait_until(lambda: tap.active_track_count == 0)
    assert created_sinks[("customer-b", "track-b")][0].closed_reason == "room_reconnecting"

    streams[id(track_a)] = FakeAudioStream()
    streams[id(track_b)] = FakeAudioStream()
    room.emit("reconnected")
    await wait_until(lambda: tap.active_track_count == 2)
    assert len(created_sinks[("customer-a", "track-a")]) == 2
    assert len(created_sinks[("customer-b", "track-b")]) == 2

    await tap.stop()
    assert all(sink.closed_reason for sinks in created_sinks.values() for sink in sinks)


@pytest.mark.asyncio
async def test_livekit_audio_tap_ignores_non_audio_tracks() -> None:
    room = FakeRoom()
    participant = FakeParticipant("customer-1")
    track = SimpleNamespace(kind="video")
    publication = FakePublication("track-video", track, source="camera")
    called = False

    async def sink_factory(_context):
        nonlocal called
        called = True
        return FakeSink()

    tap = LiveKitAudioTap(
        room=room,
        context=context(),
        sink_factory=sink_factory,
        audio_stream_factory=lambda *_args, **_kwargs: FakeAudioStream(),
        is_audio_track=lambda value: value.kind == "audio",
    )
    await tap.start()
    room.emit("track_subscribed", track, publication, participant)
    await asyncio.sleep(0)
    await tap.stop()

    assert called is False


async def wait_until(predicate, timeout: float = 1.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.005)

    await asyncio.wait_for(poll(), timeout=timeout)
