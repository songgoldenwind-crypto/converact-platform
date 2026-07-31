"""
AI Video Avatar — MuseTalk-driven real-time lip-sync video track.

Publishes a digital human video track to a LiveKit room. The video frames
are generated in real-time from TTS audio using MuseTalk, providing
lip-synced talking-head animation.

Architecture:
    config.py         — env-driven configuration
    musetalk_runner.py — MuseTalk model loading + audio→frame inference
    video_source.py    — LiveKit VideoSource wrapper, 25fps publish loop
    assets/            — default avatar photo
"""
from .config import AvatarConfig, load_avatar_config

__all__ = ["AvatarConfig", "load_avatar_config"]
