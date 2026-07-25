"""Non-blocking LiveKit subscribed-audio tap.

Each remote audio track is normalized by the LiveKit RTC SDK to mono PCM16 and
copied into an independent bounded queue. Slow or failed auxiliary consumers
can lose tap frames, but they cannot pause the RTC track reader.
"""
from __future__ import annotations

import asyncio
import inspect
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol


RealtimeSpeechPurpose = Literal["live_captions", "live_translation"]


@dataclass(frozen=True)
class LiveKitAudioTapContext:
    tenant_id: str
    interaction_id: str
    media_session_id: str
    purpose: RealtimeSpeechPurpose
    consent_ref: str
    source_language: str
    target_languages: tuple[str, ...]
    features: tuple[str, ...]


@dataclass(frozen=True)
class LiveKitAudioTapTrackContext:
    tenant_id: str
    interaction_id: str
    media_session_id: str
    media_source: Literal["livekit"]
    room_name: str
    participant_id: str
    track_id: str
    track_source: str
    purpose: RealtimeSpeechPurpose
    consent_ref: str
    source_language: str
    target_languages: tuple[str, ...]
    features: tuple[str, ...]


@dataclass(frozen=True)
class LiveKitAudioTapFrame:
    sequence: int
    received_at_micros: int
    sample_rate_hz: Literal[16000]
    channels: Literal[1]
    sample_count: int
    duration_ms: int
    pcm_s16le: bytes


class LiveKitAudioTapSink(Protocol):
    async def write(self, frame: LiveKitAudioTapFrame) -> None: ...

    async def close(self, reason: str) -> None: ...


LiveKitAudioTapSinkFactory = Callable[
    [LiveKitAudioTapTrackContext],
    Awaitable[LiveKitAudioTapSink],
]
AudioStreamFactory = Callable[..., AsyncIterator[Any]]
AudioTrackPredicate = Callable[[Any], bool]
AudioTapEventHandler = Callable[[dict[str, Any]], Any]


def livekit_audio_tap_context_from_metadata(
    metadata: Any,
    room_name: str,
) -> LiveKitAudioTapContext | None:
    if not isinstance(metadata, dict):
        return None
    config = metadata.get("realtime_audio_tap")
    if not isinstance(config, dict) or config.get("enabled") is not True:
        return None
    purpose = str(config.get("purpose") or "live_captions").strip()
    default_features = ["streaming_asr"]
    if purpose == "live_translation":
        default_features.append("streaming_translation")
    raw_features = config.get("features", default_features)
    context = LiveKitAudioTapContext(
        tenant_id=_required_text(metadata.get("tenant_id"), "tenant_id"),
        interaction_id=_required_text(
            config.get("call_id")
            or metadata.get("media_call_id")
            or metadata.get("call_session_id"),
            "interaction_id",
        ),
        media_session_id=_required_text(room_name, "media_session_id"),
        purpose=purpose,
        consent_ref=_required_text(config.get("consent_ref"), "consent_ref"),
        source_language=_required_text(
            config.get("source_language") or metadata.get("language") or "auto",
            "source_language",
        ),
        target_languages=_text_tuple(
            config.get("target_languages", []),
            "target_languages",
            maximum=16,
        ),
        features=_text_tuple(raw_features, "features", maximum=8),
    )
    _validate_context(context)
    return context


class LiveKitAudioTap:
    def __init__(
        self,
        *,
        room: Any,
        context: LiveKitAudioTapContext,
        sink_factory: LiveKitAudioTapSinkFactory,
        audio_stream_factory: AudioStreamFactory | None = None,
        is_audio_track: AudioTrackPredicate | None = None,
        max_buffered_audio_ms: int = 1_000,
        frame_size_ms: int = 20,
        shutdown_timeout_seconds: float = 1.0,
        on_event: AudioTapEventHandler | None = None,
    ) -> None:
        if not room or not callable(sink_factory):
            raise ValueError("livekit_audio_tap_invalid")
        _validate_context(context)
        if (
            not isinstance(max_buffered_audio_ms, int)
            or max_buffered_audio_ms < frame_size_ms
            or max_buffered_audio_ms > 10_000
            or frame_size_ms not in {10, 20, 40, 50, 100}
            or not 0.05 <= shutdown_timeout_seconds <= 30
        ):
            raise ValueError("livekit_audio_tap_limits_invalid")
        self._room = room
        self._context = context
        self._sink_factory = sink_factory
        self._audio_stream_factory = audio_stream_factory or _livekit_audio_stream
        self._is_audio_track = is_audio_track or _livekit_is_audio_track
        self._frame_size_ms = frame_size_ms
        self._max_frames = max(1, max_buffered_audio_ms // frame_size_ms)
        self._shutdown_timeout_seconds = shutdown_timeout_seconds
        self._on_event = on_event
        self._tracks: dict[tuple[str, str], _TrackPump] = {}
        self._control_tasks: set[asyncio.Task[Any]] = set()
        self._lock = asyncio.Lock()
        self._started = False
        self._stopping = False
        self._handlers = {
            "track_subscribed": self._on_track_subscribed,
            "track_unsubscribed": self._on_track_unsubscribed,
            "track_unpublished": self._on_track_unpublished,
            "participant_disconnected": self._on_participant_disconnected,
            "reconnecting": self._on_reconnecting,
            "reconnected": self._on_reconnected,
            "disconnected": self._on_disconnected,
        }

    @property
    def active_track_count(self) -> int:
        return len(self._tracks)

    async def start(self) -> None:
        if self._started:
            return
        if self._stopping:
            raise RuntimeError("livekit_audio_tap_closed")
        self._started = True
        for event, handler in self._handlers.items():
            self._room.on(event, handler)
        await self._scan_existing_tracks()

    async def stop(self) -> None:
        if self._stopping:
            return
        self._stopping = True
        if self._started:
            for event, handler in self._handlers.items():
                try:
                    self._room.off(event, handler)
                except (KeyError, ValueError):
                    pass
        for task in list(self._control_tasks):
            task.cancel()
        if self._control_tasks:
            await asyncio.gather(*self._control_tasks, return_exceptions=True)
        await self._close_all("worker_draining")
        self._started = False

    def _on_track_subscribed(
        self,
        track: Any,
        publication: Any,
        participant: Any,
    ) -> None:
        self._schedule(self._ensure_track(track, publication, participant))

    def _on_track_unsubscribed(
        self,
        _track: Any,
        publication: Any,
        participant: Any,
    ) -> None:
        self._schedule(
            self._close_key(_track_key(participant, publication), "track_unsubscribed")
        )

    def _on_track_unpublished(self, publication: Any, participant: Any) -> None:
        self._schedule(
            self._close_key(_track_key(participant, publication), "track_unpublished")
        )

    def _on_participant_disconnected(self, participant: Any) -> None:
        self._schedule(
            self._close_participant(
                _participant_identity(participant),
                "participant_disconnected",
            )
        )

    def _on_reconnecting(self) -> None:
        self._schedule(self._close_all("room_reconnecting"))

    def _on_reconnected(self) -> None:
        self._schedule(self._scan_existing_tracks())

    def _on_disconnected(self, _reason: Any = None) -> None:
        self._schedule(self._close_all("room_disconnected"))

    async def _scan_existing_tracks(self) -> None:
        if self._stopping:
            return
        participants = getattr(self._room, "remote_participants", {})
        for participant in list(getattr(participants, "values", lambda: [])()):
            publications = getattr(participant, "track_publications", {})
            for publication in list(getattr(publications, "values", lambda: [])()):
                track = getattr(publication, "track", None)
                if track is not None:
                    await self._ensure_track(track, publication, participant)

    async def _ensure_track(
        self,
        track: Any,
        publication: Any,
        participant: Any,
    ) -> None:
        if self._stopping or not self._is_audio_track(track):
            return
        key = _track_key(participant, publication)
        async with self._lock:
            if self._stopping or key in self._tracks:
                return
            track_context = LiveKitAudioTapTrackContext(
                **self._context.__dict__,
                media_source="livekit",
                room_name=_required_text(getattr(self._room, "name", ""), "room_name"),
                participant_id=key[0],
                track_id=key[1],
                track_source=_safe_source(getattr(publication, "source", "")),
            )
            try:
                stream = self._audio_stream_factory(
                    track,
                    capacity=self._max_frames,
                    sample_rate=16_000,
                    num_channels=1,
                    frame_size_ms=self._frame_size_ms,
                )
                pump = _TrackPump(
                    key=key,
                    context=track_context,
                    stream=stream,
                    sink_factory=self._sink_factory,
                    max_frames=self._max_frames,
                    shutdown_timeout_seconds=self._shutdown_timeout_seconds,
                    emit=self._emit,
                    request_close=lambda reason: self._schedule(
                        self._close_key(key, reason)
                    ),
                )
                self._tracks[key] = pump
                pump.start()
            except Exception as error:
                self._emit({
                    "type": "livekit_audio_tap.track_failed",
                    "participant_id": key[0],
                    "track_id": key[1],
                    "reason": _safe_reason(error),
                })
                return
        self._emit({
            "type": "livekit_audio_tap.track_started",
            "participant_id": key[0],
            "track_id": key[1],
        })

    async def _close_key(self, key: tuple[str, str], reason: str) -> None:
        async with self._lock:
            pump = self._tracks.pop(key, None)
        if pump is None:
            return
        await pump.close(reason)
        self._emit({
            "type": "livekit_audio_tap.track_ended",
            "participant_id": key[0],
            "track_id": key[1],
            "reason": reason,
        })

    async def _close_participant(self, participant_id: str, reason: str) -> None:
        keys = [key for key in self._tracks if key[0] == participant_id]
        await asyncio.gather(
            *(self._close_key(key, reason) for key in keys),
            return_exceptions=True,
        )

    async def _close_all(self, reason: str) -> None:
        keys = list(self._tracks)
        await asyncio.gather(
            *(self._close_key(key, reason) for key in keys),
            return_exceptions=True,
        )

    def _schedule(self, awaitable: Awaitable[Any]) -> None:
        if self._stopping:
            if inspect.iscoroutine(awaitable):
                awaitable.close()
            return
        task = asyncio.create_task(awaitable)
        self._control_tasks.add(task)

        def completed(done: asyncio.Task[Any]) -> None:
            self._control_tasks.discard(done)
            if done.cancelled():
                return
            error = done.exception()
            if error is not None:
                self._emit({
                    "type": "livekit_audio_tap.control_failed",
                    "reason": _safe_reason(error),
                })

        task.add_done_callback(completed)

    def _emit(self, event: dict[str, Any]) -> None:
        if not self._on_event:
            return
        payload = {
            "room_name": str(getattr(self._room, "name", "")),
            **event,
        }
        try:
            result = self._on_event(payload)
            if inspect.isawaitable(result):
                task = asyncio.create_task(result)
                task.add_done_callback(_consume_task_exception)
        except Exception:
            pass


class _TrackPump:
    def __init__(
        self,
        *,
        key: tuple[str, str],
        context: LiveKitAudioTapTrackContext,
        stream: AsyncIterator[Any],
        sink_factory: LiveKitAudioTapSinkFactory,
        max_frames: int,
        shutdown_timeout_seconds: float,
        emit: AudioTapEventHandler,
        request_close: Callable[[str], None],
    ) -> None:
        self._key = key
        self._context = context
        self._stream = stream
        self._sink_factory = sink_factory
        self._queue: asyncio.Queue[LiveKitAudioTapFrame] = asyncio.Queue(
            maxsize=max_frames
        )
        self._shutdown_timeout_seconds = shutdown_timeout_seconds
        self._emit = emit
        self._request_close = request_close
        self._sink: LiveKitAudioTapSink | None = None
        self._capture_task: asyncio.Task[Any] | None = None
        self._send_task: asyncio.Task[Any] | None = None
        self._sequence = 0
        self._closing = False

    def start(self) -> None:
        self._capture_task = asyncio.create_task(self._capture())
        self._send_task = asyncio.create_task(self._send())

    async def close(self, reason: str) -> None:
        if self._closing:
            return
        self._closing = True
        close_stream = getattr(self._stream, "aclose", None)
        if callable(close_stream):
            try:
                await asyncio.wait_for(
                    close_stream(),
                    timeout=self._shutdown_timeout_seconds,
                )
            except (TimeoutError, Exception):
                pass
        current = asyncio.current_task()
        tasks = [
            task
            for task in (self._capture_task, self._send_task)
            if task is not None and task is not current and not task.done()
        ]
        for task in tasks:
            task.cancel()
        if tasks:
            try:
                await asyncio.wait_for(
                    asyncio.gather(*tasks, return_exceptions=True),
                    timeout=self._shutdown_timeout_seconds,
                )
            except TimeoutError:
                pass
        if self._sink:
            try:
                await asyncio.wait_for(
                    self._sink.close(reason),
                    timeout=self._shutdown_timeout_seconds,
                )
            except (TimeoutError, Exception):
                pass

    async def _capture(self) -> None:
        reason = "track_stream_ended"
        try:
            async for event in self._stream:
                if self._closing:
                    break
                frame = _normalize_frame(event, self._sequence)
                self._sequence += 1
                if frame is None:
                    self._emit_drop("invalid_pcm_frame", 0)
                    continue
                self._offer(frame)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            reason = "track_stream_failed"
            self._emit({
                "type": "livekit_audio_tap.track_failed",
                "participant_id": self._key[0],
                "track_id": self._key[1],
                "reason": _safe_reason(error),
            })
        finally:
            if not self._closing:
                self._request_close(reason)

    async def _send(self) -> None:
        try:
            self._sink = await self._sink_factory(self._context)
            while not self._closing:
                frame = await self._queue.get()
                await self._sink.write(frame)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self._emit({
                "type": "livekit_audio_tap.sink_failed",
                "participant_id": self._key[0],
                "track_id": self._key[1],
                "reason": _safe_reason(error),
            })
            if not self._closing:
                self._request_close("sink_failed")

    def _offer(self, frame: LiveKitAudioTapFrame) -> None:
        if self._queue.full():
            try:
                dropped = self._queue.get_nowait()
                self._emit_drop("queue_overflow", dropped.duration_ms)
            except asyncio.QueueEmpty:
                pass
        try:
            self._queue.put_nowait(frame)
        except asyncio.QueueFull:
            self._emit_drop("queue_overflow", frame.duration_ms)

    def _emit_drop(self, reason: str, duration_ms: int) -> None:
        self._emit({
            "type": "livekit_audio_tap.frame_dropped",
            "participant_id": self._key[0],
            "track_id": self._key[1],
            "reason": reason,
            "dropped_duration_ms": duration_ms,
        })


def _normalize_frame(event: Any, sequence: int) -> LiveKitAudioTapFrame | None:
    frame = getattr(event, "frame", event)
    try:
        sample_rate = int(getattr(frame, "sample_rate"))
        channels = int(getattr(frame, "num_channels"))
        sample_count = int(getattr(frame, "samples_per_channel"))
        pcm = bytes(getattr(frame, "data"))
    except (TypeError, ValueError):
        return None
    if (
        sample_rate != 16_000
        or channels != 1
        or sample_count <= 0
        or len(pcm) != sample_count * 2
    ):
        return None
    duration_ms = round(sample_count * 1_000 / sample_rate)
    if duration_ms <= 0 or duration_ms > 1_000:
        return None
    return LiveKitAudioTapFrame(
        sequence=sequence,
        received_at_micros=time.time_ns() // 1_000,
        sample_rate_hz=16_000,
        channels=1,
        sample_count=sample_count,
        duration_ms=duration_ms,
        pcm_s16le=pcm,
    )


def _livekit_audio_stream(track: Any, **options: Any) -> AsyncIterator[Any]:
    from livekit import rtc

    return rtc.AudioStream.from_track(track=track, **options)


def _livekit_is_audio_track(track: Any) -> bool:
    from livekit import rtc

    return getattr(track, "kind", None) == rtc.TrackKind.KIND_AUDIO


def _track_key(participant: Any, publication: Any) -> tuple[str, str]:
    return (
        _participant_identity(participant),
        _required_text(getattr(publication, "sid", ""), "track_id"),
    )


def _participant_identity(participant: Any) -> str:
    return _required_text(getattr(participant, "identity", ""), "participant_id")


def _required_text(value: Any, field: str) -> str:
    text = str(value or "").strip()
    if not text or len(text) > 256 or any(ord(char) < 32 for char in text):
        raise ValueError(f"livekit_audio_tap_{field}_invalid")
    return text


def _safe_source(value: Any) -> str:
    text = str(value or "unknown").strip().lower()
    return text[:64] if text else "unknown"


def _safe_reason(error: Any) -> str:
    text = str(error or "unknown").strip()
    return text[:128] if text else "unknown"


def _text_tuple(value: Any, field: str, *, maximum: int) -> tuple[str, ...]:
    if not isinstance(value, (list, tuple)) or len(value) > maximum:
        raise ValueError(f"livekit_audio_tap_{field}_invalid")
    result: list[str] = []
    for item in value:
        text = _required_text(item, field)
        if text not in result:
            result.append(text)
    return tuple(result)


def _validate_context(context: LiveKitAudioTapContext) -> None:
    _required_text(context.tenant_id, "tenant_id")
    _required_text(context.interaction_id, "interaction_id")
    _required_text(context.media_session_id, "media_session_id")
    _required_text(context.consent_ref, "consent_ref")
    _required_text(context.source_language, "source_language")
    if (
        len(context.target_languages) > 16
        or any(
            _required_text(language, "target_languages") != language
            for language in context.target_languages
        )
        or len(context.features) > 8
        or any(
            feature not in {
                "streaming_asr",
                "streaming_translation",
                "language_detection",
                "speaker_diarization",
                "word_timestamps",
            }
            for feature in context.features
        )
    ):
        raise ValueError("livekit_audio_tap_context_invalid")
    if context.purpose not in {"live_captions", "live_translation"}:
        raise ValueError("livekit_audio_tap_purpose_invalid")
    if "streaming_asr" not in context.features:
        raise ValueError("livekit_audio_tap_features_invalid")
    if context.purpose == "live_translation" and (
        "streaming_translation" not in context.features
        or not context.target_languages
    ):
        raise ValueError("livekit_audio_tap_translation_invalid")


def _consume_task_exception(task: asyncio.Task[Any]) -> None:
    if not task.cancelled():
        task.exception()
