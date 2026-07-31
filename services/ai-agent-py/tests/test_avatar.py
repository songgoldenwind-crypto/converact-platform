"""
Unit tests for the avatar module (MuseTalk-driven digital human).

These test the fallback path (static image) which runs without MuseTalk
installed — covering config loading, device detection, reference image
loading, and frame generation. The real MuseTalk inference path requires
a GPU + model weights and is validated separately via integration tests.
"""
import asyncio
import os
from types import SimpleNamespace

import numpy as np
import pytest

from avatar.config import AvatarConfig, load_avatar_config, _detect_device
from avatar.musetalk_runner import MuseTalkRunner
from avatar.video_source import AvatarVideoSource


# --- config ---

def test_load_avatar_config_defaults():
    config = load_avatar_config()
    assert config.fps == 25
    assert config.width > 0
    assert config.height > 0
    assert config.audio_sample_rate == 16000


def test_audio_chunk_samples_computed_from_ms():
    config = AvatarConfig()
    # default 100ms @ 16kHz = 1600 samples
    assert config.audio_chunk_samples == 1600


def test_detect_device_respects_explicit_env(monkeypatch):
    monkeypatch.setenv("AVATAR_DEVICE", "cpu")
    assert _detect_device() == "cpu"


def test_detect_device_returns_valid_device(monkeypatch):
    monkeypatch.delenv("AVATAR_DEVICE", raising=False)
    device = _detect_device()
    assert device in ("cuda", "mps", "cpu")


# --- runner (fallback path) ---

@pytest.fixture
def runner():
    """A loaded runner in fallback mode (no MuseTalk model installed)."""
    config = AvatarConfig()
    r = MuseTalkRunner(config)
    asyncio.run(r.load())
    return r


def test_runner_loads_in_fallback_mode(runner):
    assert runner.is_loaded
    # Without MuseTalk model weights, runner falls back to static image
    assert runner.is_fallback


def test_infer_produces_frames_matching_config_dimensions(runner):
    config = runner.config
    # 1 second of audio at 16kHz
    audio = np.zeros(config.audio_sample_rate, dtype=np.float32)
    frames = runner.infer(audio)
    assert len(frames) >= 1
    frame = frames[0]
    assert frame.shape[0] == config.height
    assert frame.shape[1] == config.width
    assert frame.shape[2] == 3
    assert frame.dtype == np.uint8


def test_infer_frame_count_scales_with_audio_duration(runner):
    config = runner.config
    # 2 seconds of audio should yield ~2x the frames of 1 second
    audio_1s = np.zeros(config.audio_sample_rate, dtype=np.float32)
    audio_2s = np.zeros(config.audio_sample_rate * 2, dtype=np.float32)
    frames_1s = runner.infer(audio_1s)
    frames_2s = runner.infer(audio_2s)
    assert len(frames_2s) > len(frames_1s)


def test_infer_before_load_raises():
    config = AvatarConfig()
    r = MuseTalkRunner(config)
    with pytest.raises(RuntimeError, match="not loaded"):
        r.infer(np.zeros(1600, dtype=np.float32))


def test_get_idle_frame_returns_valid_frame(runner):
    config = runner.config
    idle = runner.get_idle_frame()
    assert idle.shape == (config.height, config.width, 3)
    assert idle.dtype == np.uint8


def test_runner_missing_image_raises(monkeypatch):
    """If the reference image is missing, load() falls back gracefully."""
    monkeypatch.setenv("AVATAR_DEFAULT_IMAGE", "/nonexistent/path/avatar.jpg")
    config = AvatarConfig()
    r = MuseTalkRunner(config)
    # load() catches the FileNotFoundError and enters fallback mode
    asyncio.run(r.load())
    assert r.is_loaded
    # Idle frame still works (returns black frame as last resort)
    idle = r.get_idle_frame()
    assert idle.shape[2] == 3


def test_streaming_chunks_accumulate_frames(runner):
    """Simulate streaming TTS: multiple small chunks produce frames."""
    config = runner.config
    chunk = np.zeros(config.audio_chunk_samples, dtype=np.float32)
    total = 0
    for _ in range(10):
        total += len(runner.infer(chunk))
    # 10 chunks of 100ms = 1s of audio → roughly fps frames (allow rounding)
    assert total >= 10


@pytest.mark.asyncio
async def test_avatar_video_publish_uses_livekit_track_publish_options(monkeypatch, runner):
    """Avatar publish must use the current LiveKit Python SDK publish shape."""
    published = {}

    class FakeVideoSource:
        def __init__(self, width, height, fps):
            self.width = width
            self.height = height
            self.fps = fps

    class FakeLocalVideoTrack:
        @staticmethod
        def create_video_track(name, source):
            published["track_name"] = name
            published["source"] = source
            return SimpleNamespace(name=name, source=source)

    class FakeParticipant:
        async def publish_track(self, track, options):
            published["track"] = track
            published["options"] = options
            return SimpleNamespace(sid="pub_avatar")

    monkeypatch.setattr("livekit.rtc.VideoSource", FakeVideoSource)
    monkeypatch.setattr("livekit.rtc.LocalVideoTrack", FakeLocalVideoTrack)

    avatar = AvatarVideoSource(runner.config, runner)
    await avatar.publish(SimpleNamespace(local_participant=FakeParticipant()))

    assert published["track_name"] == "avatar-video"
    assert published["options"].source == 1
    assert avatar.is_published
