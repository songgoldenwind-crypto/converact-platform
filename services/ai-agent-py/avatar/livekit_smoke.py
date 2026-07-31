from __future__ import annotations

import asyncio
import inspect
import json
import logging
import os
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Mapping

import numpy as np

from converact_env import resolve_converact_env

logger = logging.getLogger(__name__)


class AvatarLiveKitSmokeError(RuntimeError):
    """Raised when the avatar LiveKit smoke cannot be configured or run."""


@dataclass(frozen=True)
class AvatarLiveKitSmokeConfig:
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    room_name: str = "opc-avatar-smoke"
    identity: str = "opc-avatar-smoke-bot"
    sample_chunks: int = 3
    settle_seconds: float = 0.5


@dataclass
class AvatarLiveKitSmokeResult:
    ok: bool
    room_name: str
    identity: str
    steps: list[str]

    def to_json(self) -> str:
        return json.dumps(
            {
                "ok": self.ok,
                "room_name": self.room_name,
                "identity": self.identity,
                "steps": self.steps,
            },
            ensure_ascii=False,
            indent=2,
        )


RoomFactory = Callable[[AvatarLiveKitSmokeConfig, str], Awaitable[Any]]
TokenFactory = Callable[[AvatarLiveKitSmokeConfig], str]
AvatarFactory = Callable[[], Awaitable[tuple[Any, Any]]]
Sleep = Callable[[float], Awaitable[None]]


def load_avatar_livekit_smoke_config(
    env: Mapping[str, str | None] | None = None,
) -> AvatarLiveKitSmokeConfig:
    values = os.environ if env is None else env
    missing = [
        name
        for name in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
        if not _read_env(values, name)
    ]
    if missing:
        raise AvatarLiveKitSmokeError(
            "Missing required LiveKit environment variables: " + ", ".join(missing)
        )

    return AvatarLiveKitSmokeConfig(
        livekit_url=_read_env(values, "LIVEKIT_URL"),
        livekit_api_key=_read_env(values, "LIVEKIT_API_KEY"),
        livekit_api_secret=_read_env(values, "LIVEKIT_API_SECRET"),
        room_name=_read_env(values, "CONVERACT_AVATAR_SMOKE_ROOM_NAME", "converact-avatar-smoke"),
        identity=_read_env(values, "CONVERACT_AVATAR_SMOKE_IDENTITY", "converact-avatar-smoke-bot"),
        sample_chunks=_read_positive_int(values, "CONVERACT_AVATAR_SMOKE_SAMPLE_CHUNKS", 3),
        settle_seconds=_read_non_negative_float(values, "CONVERACT_AVATAR_SMOKE_SETTLE_SECONDS", 0.5),
    )


def build_livekit_join_token(config: AvatarLiveKitSmokeConfig) -> str:
    from livekit import api

    grants = api.VideoGrants(
        room_join=True,
        room=config.room_name,
        can_publish=True,
        can_subscribe=True,
        can_publish_data=True,
    )
    return (
        api.AccessToken(config.livekit_api_key, config.livekit_api_secret)
        .with_identity(config.identity)
        .with_name(config.identity)
        .with_grants(grants)
        .to_jwt()
    )


async def connect_livekit_room(config: AvatarLiveKitSmokeConfig, token: str):
    from livekit import rtc

    room = rtc.Room()
    await room.connect(config.livekit_url, token)
    return room


async def create_avatar_video_source():
    from avatar.config import load_avatar_config
    from avatar.musetalk_runner import MuseTalkRunner
    from avatar.video_source import AvatarVideoSource

    avatar_config = load_avatar_config()
    runner = MuseTalkRunner(avatar_config)
    await runner.load()
    return AvatarVideoSource(avatar_config, runner), avatar_config


async def run_avatar_livekit_smoke(
    config: AvatarLiveKitSmokeConfig,
    *,
    room_factory: RoomFactory = connect_livekit_room,
    token_factory: TokenFactory = build_livekit_join_token,
    avatar_factory: AvatarFactory = create_avatar_video_source,
    sleep: Sleep = asyncio.sleep,
) -> AvatarLiveKitSmokeResult:
    steps: list[str] = []
    room = None
    avatar = None

    token = token_factory(config)
    steps.append("build_livekit_token")

    try:
        room = await room_factory(config, token)
        steps.append("connect_room")

        avatar, avatar_config = await avatar_factory()
        await avatar.publish(room)
        steps.append("publish_avatar_video_track")

        await avatar.start()
        steps.append("start_avatar_render_loop")

        avatar.set_speaking(True)
        for index in range(config.sample_chunks):
            avatar.feed_audio(_generate_probe_audio(avatar_config, index))
            steps.append("feed_probe_audio")
            await sleep(0)
        await sleep(config.settle_seconds)
        avatar.set_speaking(False)
        steps.append("capture_probe_frames")

        return AvatarLiveKitSmokeResult(
            ok=True,
            room_name=config.room_name,
            identity=config.identity,
            steps=steps,
        )
    finally:
        cleanup_error: Exception | None = None
        if avatar is not None:
            try:
                await _maybe_await(avatar.stop())
                steps.append("stop_avatar_render_loop")
            except Exception as exc:
                cleanup_error = exc
        if room is not None and hasattr(room, "disconnect"):
            try:
                await _maybe_await(room.disconnect())
                steps.append("disconnect_room")
            except Exception as exc:
                if cleanup_error is None:
                    cleanup_error = exc
        if cleanup_error is not None:
            raise cleanup_error


async def _maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


def _generate_probe_audio(avatar_config: Any, index: int = 0) -> np.ndarray:
    sample_rate = int(getattr(avatar_config, "audio_sample_rate", 16000) or 16000)
    samples = int(getattr(avatar_config, "audio_chunk_samples", sample_rate // 10) or sample_rate // 10)
    samples = max(1, samples)
    frequency = 220.0 + index * 15.0
    t = np.arange(samples, dtype=np.float32) / np.float32(sample_rate)
    return (0.2 * np.sin(2 * np.pi * frequency * t)).astype(np.float32)


def _read_env(
    env: Mapping[str, str | None],
    name: str,
    default: str | None = None,
) -> str:
    value = resolve_converact_env(env, name)
    if value is None or str(value).strip() == "":
        if default is None:
            return ""
        return default
    return str(value).strip()


def _read_positive_int(
    env: Mapping[str, str | None],
    name: str,
    default: int,
) -> int:
    raw = _read_env(env, name, str(default))
    try:
        value = int(raw)
    except ValueError as exc:
        raise AvatarLiveKitSmokeError(f"{name} must be a positive integer") from exc
    if value < 1:
        raise AvatarLiveKitSmokeError(f"{name} must be a positive integer")
    return value


def _read_non_negative_float(
    env: Mapping[str, str | None],
    name: str,
    default: float,
) -> float:
    raw = _read_env(env, name, str(default))
    try:
        value = float(raw)
    except ValueError as exc:
        raise AvatarLiveKitSmokeError(f"{name} must be a non-negative number") from exc
    if value < 0:
        raise AvatarLiveKitSmokeError(f"{name} must be a non-negative number")
    return value


async def async_main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        config = load_avatar_livekit_smoke_config()
        logger.info("connecting avatar smoke room %s as %s", config.room_name, config.identity)
        result = await run_avatar_livekit_smoke(config)
    except AvatarLiveKitSmokeError as exc:
        logger.error("%s", exc)
        return 2
    except Exception:
        logger.exception("avatar LiveKit smoke failed")
        return 1
    print(result.to_json())
    return 0


def main() -> None:
    raise SystemExit(asyncio.run(async_main()))
