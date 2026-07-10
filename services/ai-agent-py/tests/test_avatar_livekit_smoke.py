from types import SimpleNamespace

import pytest

from avatar.livekit_smoke import (
    AvatarLiveKitSmokeConfig,
    AvatarLiveKitSmokeError,
    load_avatar_livekit_smoke_config,
    run_avatar_livekit_smoke,
)


def test_avatar_livekit_smoke_config_requires_livekit_credentials():
    with pytest.raises(AvatarLiveKitSmokeError, match="LIVEKIT_URL"):
        load_avatar_livekit_smoke_config({})


def test_avatar_livekit_smoke_config_reads_env_overrides():
    config = load_avatar_livekit_smoke_config(
        {
            "LIVEKIT_URL": "ws://livekit.example:7880",
            "LIVEKIT_API_KEY": "api-key",
            "LIVEKIT_API_SECRET": "api-secret",
            "OPC_AVATAR_SMOKE_ROOM_NAME": "avatar-room",
            "OPC_AVATAR_SMOKE_IDENTITY": "avatar-bot",
            "OPC_AVATAR_SMOKE_SAMPLE_CHUNKS": "4",
            "OPC_AVATAR_SMOKE_SETTLE_SECONDS": "0.25",
        }
    )

    assert config.livekit_url == "ws://livekit.example:7880"
    assert config.room_name == "avatar-room"
    assert config.identity == "avatar-bot"
    assert config.sample_chunks == 4
    assert config.settle_seconds == 0.25


def test_avatar_livekit_smoke_config_rejects_invalid_chunk_count():
    with pytest.raises(AvatarLiveKitSmokeError, match="OPC_AVATAR_SMOKE_SAMPLE_CHUNKS"):
        load_avatar_livekit_smoke_config(
            {
                "LIVEKIT_URL": "ws://livekit.example:7880",
                "LIVEKIT_API_KEY": "api-key",
                "LIVEKIT_API_SECRET": "api-secret",
                "OPC_AVATAR_SMOKE_SAMPLE_CHUNKS": "0",
            }
        )


@pytest.mark.asyncio
async def test_avatar_livekit_smoke_publishes_frames_and_cleans_up():
    events = []

    async def fake_room_factory(config, token):
        events.append(("connect", config.livekit_url, token))

        async def disconnect():
            events.append(("disconnect",))

        return SimpleNamespace(disconnect=disconnect)

    def fake_token_factory(config):
        events.append(("token", config.room_name, config.identity))
        return "jwt-token"

    class FakeAvatar:
        async def publish(self, room):
            events.append(("publish", room is not None))

        async def start(self):
            events.append(("start",))

        def set_speaking(self, speaking):
            events.append(("speaking", speaking))

        def feed_audio(self, audio):
            events.append(("feed", len(audio), str(audio.dtype)))

        async def stop(self):
            events.append(("stop",))

    async def fake_avatar_factory():
        avatar_config = SimpleNamespace(audio_sample_rate=16000, audio_chunk_samples=160)
        return FakeAvatar(), avatar_config

    async def fake_sleep(seconds):
        events.append(("sleep", seconds))

    result = await run_avatar_livekit_smoke(
        AvatarLiveKitSmokeConfig(
            livekit_url="ws://livekit.example:7880",
            livekit_api_key="api-key",
            livekit_api_secret="api-secret",
            room_name="avatar-room",
            identity="avatar-bot",
            sample_chunks=2,
            settle_seconds=0.1,
        ),
        room_factory=fake_room_factory,
        token_factory=fake_token_factory,
        avatar_factory=fake_avatar_factory,
        sleep=fake_sleep,
    )

    assert result.ok
    assert result.room_name == "avatar-room"
    assert result.identity == "avatar-bot"
    assert result.steps == [
        "build_livekit_token",
        "connect_room",
        "publish_avatar_video_track",
        "start_avatar_render_loop",
        "feed_probe_audio",
        "feed_probe_audio",
        "capture_probe_frames",
        "stop_avatar_render_loop",
        "disconnect_room",
    ]
    assert events == [
        ("token", "avatar-room", "avatar-bot"),
        ("connect", "ws://livekit.example:7880", "jwt-token"),
        ("publish", True),
        ("start",),
        ("speaking", True),
        ("feed", 160, "float32"),
        ("sleep", 0),
        ("feed", 160, "float32"),
        ("sleep", 0),
        ("sleep", 0.1),
        ("speaking", False),
        ("stop",),
        ("disconnect",),
    ]


@pytest.mark.asyncio
async def test_avatar_livekit_smoke_disconnects_room_when_avatar_stop_fails():
    events = []

    async def fake_room_factory(config, token):
        events.append(("connect",))

        async def disconnect():
            events.append(("disconnect",))

        return SimpleNamespace(disconnect=disconnect)

    class FailingStopAvatar:
        async def publish(self, room):
            events.append(("publish",))

        async def start(self):
            events.append(("start",))

        def set_speaking(self, speaking):
            events.append(("speaking", speaking))

        def feed_audio(self, audio):
            events.append(("feed", len(audio)))

        async def stop(self):
            events.append(("stop",))
            raise RuntimeError("stop failed")

    async def fake_avatar_factory():
        avatar_config = SimpleNamespace(audio_sample_rate=16000, audio_chunk_samples=160)
        return FailingStopAvatar(), avatar_config

    async def fake_sleep(seconds):
        events.append(("sleep", seconds))

    with pytest.raises(RuntimeError, match="stop failed"):
        await run_avatar_livekit_smoke(
            AvatarLiveKitSmokeConfig(
                livekit_url="ws://livekit.example:7880",
                livekit_api_key="api-key",
                livekit_api_secret="api-secret",
                room_name="avatar-room",
                identity="avatar-bot",
                sample_chunks=1,
                settle_seconds=0,
            ),
            room_factory=fake_room_factory,
            token_factory=lambda _config: "jwt-token",
            avatar_factory=fake_avatar_factory,
            sleep=fake_sleep,
        )

    assert ("stop",) in events
    assert ("disconnect",) in events
