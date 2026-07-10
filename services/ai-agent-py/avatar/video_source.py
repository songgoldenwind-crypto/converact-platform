"""
AvatarVideoSource — publishes a LiveKit video track driven by MuseTalk.

This wraps livekit.rtc.VideoSource and runs a render loop that:
1. Consumes video frames from an asyncio.Queue (fed by MuseTalkRunner output)
2. Publishes them at the configured fps via VideoSource.capture_frame()
3. Falls back to a static idle frame when no audio is playing

When TTS generates audio, the session handler pushes audio chunks to
AvatarVideoSource.feed_audio(), which runs MuseTalk inference and enqueues
the resulting frames.

Usage:
    avatar = AvatarVideoSource(config, musetalk_runner)
    await avatar.publish(room)            # publish video track
    await avatar.start()                  # start render loop
    avatar.feed_audio(audio_chunk)        # feed TTS audio → MuseTalk → frames
    avatar.set_speaking(False)            # back to idle frame
"""
import asyncio
import logging
from typing import Optional

import numpy as np

from .config import AvatarConfig
from .musetalk_runner import MuseTalkRunner

logger = logging.getLogger(__name__)


class AvatarVideoSource:
    """LiveKit video track publisher driven by MuseTalk lip-sync."""

    def __init__(self, config: AvatarConfig, runner: MuseTalkRunner):
        self.config = config
        self.runner = runner
        self._source = None        # livekit.rtc.VideoSource
        self._track = None         # published video track
        self._frame_queue: asyncio.Queue[np.ndarray] = asyncio.Queue(
            maxsize=config.frame_buffer_size
        )
        self._is_speaking = False
        self._render_task: Optional[asyncio.Task] = None
        self._running = False

    @property
    def is_published(self) -> bool:
        return self._track is not None

    async def publish(self, room) -> None:
        """
        Create and publish the avatar video track to a LiveKit room.

        Args:
            room: livekit.rtc.Room — the room to publish to.
        """
        from livekit.rtc import LocalVideoTrack, TrackPublishOptions, TrackSource, VideoSource

        self._source = VideoSource(
            width=self.config.width,
            height=self.config.height,
            fps=self.config.fps,
        )

        # Publish as a camera-sourced named track so browsers can distinguish
        # the digital human from screen share tracks.
        track = LocalVideoTrack.create_video_track("avatar-video", self._source)
        self._track = await room.local_participant.publish_track(
            track,
            TrackPublishOptions(source=TrackSource.SOURCE_CAMERA),
        )
        logger.info(
            "Avatar video track published: %dx%d@%dfps",
            self.config.width, self.config.height, self.config.fps,
        )

    async def start(self) -> None:
        """Start the 25fps render loop as a background task."""
        if self._render_task is not None:
            logger.warning("Avatar render loop already started")
            return
        self._running = True
        self._render_task = asyncio.create_task(self._render_loop())
        logger.info("Avatar render loop started")

    async def stop(self) -> None:
        """Stop the render loop."""
        self._running = False
        if self._render_task is not None:
            self._render_task.cancel()
            try:
                await self._render_task
            except asyncio.CancelledError:
                pass
            self._render_task = None
        logger.info("Avatar render loop stopped")

    def set_speaking(self, speaking: bool) -> None:
        """Toggle speaking/idle state. When idle, shows a static frame."""
        self._is_speaking = speaking

    def feed_audio(self, audio: np.ndarray) -> None:
        """
        Feed a TTS audio chunk to MuseTalk and enqueue the resulting frames.

        This runs MuseTalk inference synchronously (GPU is fast enough for
        real-time at MuseTalk's 520fps). If the frame queue is full, frames
        are dropped to avoid blocking the TTS pipeline.

        Args:
            audio: numpy float32, 16kHz mono.
        """
        if not self._is_speaking:
            return

        try:
            frames = self.runner.infer(audio)
            for frame in frames:
                try:
                    self._frame_queue.put_nowait(frame)
                except asyncio.QueueFull:
                    # Drop oldest frame to make room — prefer recent frames
                    # for lower latency.
                    try:
                        self._frame_queue.get_nowait()
                        self._frame_queue.put_nowait(frame)
                    except asyncio.QueueEmpty:
                        pass
        except Exception:
            logger.warning("Failed to infer avatar frames from audio chunk")

    async def _render_loop(self) -> None:
        """
        Render loop: pop frames from the queue and publish them at the
        configured fps. When the queue is empty, show the idle frame.
        """
        from livekit.rtc import VideoFrame, VideoBufferType

        idle_frame = self.runner.get_idle_frame()
        frame_interval = 1.0 / self.config.fps

        while self._running:
            try:
                frame = await asyncio.wait_for(
                    self._frame_queue.get(),
                    timeout=frame_interval,
                )
            except asyncio.TimeoutError:
                # No frames available — show idle frame
                frame = idle_frame
            except asyncio.CancelledError:
                break

            if self._source is not None:
                try:
                    rtc_frame = VideoFrame(
                        width=self.config.width,
                        height=self.config.height,
                        type=VideoBufferType.RGBA,
                        data=self._to_rgba(frame),
                    )
                    self._source.capture_frame(rtc_frame)
                except Exception:
                    logger.warning("Failed to capture avatar frame")

            await asyncio.sleep(frame_interval)

    @staticmethod
    def _to_rgba(rgb: np.ndarray) -> bytes:
        """Convert an RGB numpy array to RGBA bytes for LiveKit."""
        import numpy as np

        # Add alpha channel (fully opaque)
        h, w, _ = rgb.shape
        rgba = np.dstack([rgb, np.full((h, w, 1), 255, dtype=np.uint8)])
        return rgba.tobytes()
