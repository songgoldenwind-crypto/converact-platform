"""
Avatar configuration — resolution, framerate, model paths, defaults.

All settings are env-overridable so the same code runs in local-dev (CPU/MPS)
and production (CUDA) without code changes.
"""
import os
from dataclasses import dataclass, field


def _detect_device() -> str:
    """
    Auto-detect the best available compute device.

    Order: explicit AVATAR_DEVICE env > CUDA > Apple MPS > CPU.
    This lets the same code run on a production CUDA box and a local Mac
    without code changes. Detection is best-effort — if torch isn't
    installed, defaults to "cpu" (the MuseTalk runner falls back to a
    static image anyway).
    """
    explicit = os.getenv("AVATAR_DEVICE")
    if explicit:
        return explicit
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda"
        if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
            return "mps"
    except ImportError:
        pass
    return "cpu"


@dataclass
class AvatarConfig:
    # --- Video output ---
    width: int = int(os.getenv("AVATAR_WIDTH", "720"))
    height: int = int(os.getenv("AVATAR_HEIGHT", "1280"))  # portrait
    fps: int = int(os.getenv("AVATAR_FPS", "25"))

    # --- MuseTalk model ---
    # Path to the MuseTalk model checkpoint directory.
    # In production this is a mounted volume; locally it's a clone of the repo.
    musetalk_model_path: str = os.getenv(
        "MUSETALK_MODEL_PATH",
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "MuseTalk", "models"),
    )
    # Device: "cuda" (production), "mps" (Mac), "cpu" (fallback, very slow).
    # Auto-detected unless AVATAR_DEVICE is set explicitly.
    device: str = field(default_factory=_detect_device)

    # --- Avatar image ---
    # Default avatar photo used as the driving reference for MuseTalk.
    # Must be a frontal face photo, preferably 512x512 or larger.
    default_avatar_path: str = os.getenv(
        "AVATAR_DEFAULT_IMAGE",
        os.path.join(os.path.dirname(__file__), "assets", "default.jpg"),
    )

    # --- Audio chunking ---
    # MuseTalk processes audio in chunks. Smaller chunks = lower latency but
    # more overhead. 100ms (1600 samples @ 16kHz) is a good balance.
    audio_chunk_ms: int = int(os.getenv("AVATAR_AUDIO_CHUNK_MS", "100"))
    audio_sample_rate: int = 16000

    # --- Performance ---
    # Buffer size for the frame queue between MuseTalk and LiveKit VideoSource.
    # Too small → stuttering; too large → latency. 25 frames = 1s @ 25fps.
    frame_buffer_size: int = 25

    # --- Fallback ---
    # If MuseTalk fails to load or GPU is unavailable, fall back to a static
    # image (no lip-sync). The video track still publishes, just no animation.
    enable_fallback: bool = True

    @property
    def audio_chunk_samples(self) -> int:
        """Samples per audio chunk = sample_rate * chunk_ms / 1000."""
        return int(self.audio_sample_rate * self.audio_chunk_ms / 1000)


def load_avatar_config() -> AvatarConfig:
    """Load avatar config from environment variables."""
    return AvatarConfig()
