"""Bridge CosyVoice TTS PCM chunks into AvatarVideoSource.feed_audio (per session)."""
from __future__ import annotations

import contextvars
import logging
from typing import Callable, Optional

logger = logging.getLogger(__name__)

Feeder = Callable[[bytes, int], None]
_feeders: dict[str, Feeder] = {}
_avatar_session_ctx: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "avatar_audio_session_key",
    default=None,
)


def bind_avatar_audio_session(session_key: Optional[str]) -> None:
    """Bind the current async job to an avatar audio session key."""
    _avatar_session_ctx.set(session_key)


def register_avatar_audio_feed(session_key: str, feeder: Optional[Feeder]) -> None:
    if feeder is None:
        _feeders.pop(session_key, None)
    else:
        _feeders[session_key] = feeder


def resolve_avatar_audio_session_key(explicit: Optional[str] = None) -> Optional[str]:
    if explicit:
        return explicit
    return _avatar_session_ctx.get()


def feed_tts_pcm(
    pcm_bytes: bytes,
    sample_rate: int,
    session_key: Optional[str] = None,
) -> None:
    if not pcm_bytes:
        return
    key = resolve_avatar_audio_session_key(session_key)
    if not key:
        return
    feeder = _feeders.get(key)
    if feeder is None:
        return
    try:
        feeder(pcm_bytes, sample_rate)
    except Exception:
        logger.debug("avatar audio feed skipped for session %s", key, exc_info=True)
