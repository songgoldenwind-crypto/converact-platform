"""
MuseTalk runner — loads the MuseTalk model and converts audio chunks into
lip-synced video frames in real-time.

MuseTalk takes a reference face photo + an audio waveform and generates a
talking-head video frame sequence. This module wraps that into a streaming
interface: feed audio chunks in, get video frames out.

Usage:
    runner = MuseTalkRunner(config)
    await runner.load()              # load model (slow, ~10s)
    frames = runner.infer(audio_np)  # numpy audio → list of numpy frames

If MuseTalk is unavailable (model not found, no GPU), the runner degrades
gracefully — infer() returns a static frame repeated, so the video track
still publishes but without lip-sync.
"""
import asyncio
import logging
import os
from typing import Optional

import numpy as np

from .config import AvatarConfig

logger = logging.getLogger(__name__)


class MuseTalkRunner:
    """Wraps MuseTalk model for real-time audio-to-video inference."""

    def __init__(self, config: AvatarConfig):
        self.config = config
        self._loaded = False
        self._musetalk = None          # The MuseTalk inference module
        self._reference_image = None    # Preprocessed face photo (np.ndarray)
        self._reference_features = None # Cached face embeddings
        self._fallback_frame: Optional[np.ndarray] = None

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @property
    def is_fallback(self) -> bool:
        """True when running in static-image fallback (MuseTalk unavailable)."""
        return self._loaded and self._musetalk is None

    async def load(self) -> None:
        """
        Load the MuseTalk model and preprocess the reference image.

        This is slow (~10s for model weights + face detection). Called once
        at agent startup. If loading fails, falls back to static image mode.
        """
        try:
            await self._load_reference_image()
            await self._load_musetalk_model()
            self._loaded = True
            if self._musetalk is not None:
                logger.info("MuseTalk loaded on device=%s", self.config.device)
            else:
                logger.warning(
                    "MuseTalk unavailable — running in static-image fallback. "
                    "Video track will publish a still photo without lip-sync."
                )
        except Exception:
            logger.exception("Failed to load MuseTalk, falling back to static image")
            self._musetalk = None
            self._loaded = True  # Still mark loaded so we enter fallback mode

    async def _load_reference_image(self) -> None:
        """Load and preprocess the default avatar photo."""
        import cv2

        path = self.config.default_avatar_path
        if not os.path.exists(path):
            raise FileNotFoundError(
                f"Avatar reference image not found: {path}. "
                f"Place a frontal face photo at this path or set AVATAR_DEFAULT_IMAGE."
            )

        img = cv2.imread(path)
        if img is None:
            raise ValueError(f"Failed to read image: {path}")

        # MuseTalk expects RGB, resized to 256x256 face crop region
        img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        self._reference_image = img_rgb

        # Create a fallback static frame at the target resolution
        h, w = self.config.height, self.config.width
        self._fallback_frame = cv2.resize(img_rgb, (w, h))

        logger.info("Loaded avatar reference image: %s (%dx%d)", path, img.shape[1], img.shape[0])

    async def _load_musetalk_model(self) -> None:
        """
        Load the MuseTalk inference module.

        MuseTalk's API is imported dynamically so the agent can start without
        the MuseTalk package installed (fallback mode). The import path may
        vary by installation method (pip install vs git clone).
        """
        model_path = self.config.musetalk_model_path
        if not os.path.isdir(model_path):
            logger.info("MuseTalk model path not found: %s — skipping model load", model_path)
            return

        try:
            # MuseTalk's public API (v1.0+):
            # from musetalk.api import MuseTalk
            # mt = MuseTalk(model_path, device=config.device)
            # mt.preprocess(reference_image)  # face detection + crop
            import importlib
            mt_module = importlib.import_module("musetalk.api")
            MuseTalk = getattr(mt_module, "MuseTalk")

            self._musetalk = MuseTalk(
                model_path=model_path,
                device=self.config.device,
            )
            self._musetalk.preprocess(self._reference_image)
        except ImportError:
            logger.info("musetalk package not installed — running in static fallback")
        except Exception:
            logger.exception("MuseTalk model load failed — running in static fallback")
            self._musetalk = None

    def infer(self, audio: np.ndarray) -> list[np.ndarray]:
        """
        Convert an audio chunk to video frames.

        Args:
            audio: numpy float32 array, shape (N,), 16kHz mono.

        Returns:
            List of numpy uint8 arrays (HxWx3 RGB), one per video frame
            at the configured fps. In fallback mode, returns repeated
            static frames.
        """
        if not self._loaded:
            raise RuntimeError("MuseTalkRunner not loaded — call load() first")

        if self.is_fallback:
            return self._infer_fallback(audio)

        try:
            return self._infer_musetalk(audio)
        except Exception:
            logger.warning("MuseTalk inference failed, using fallback frame")
            return self._infer_fallback(audio)

    def _infer_musetalk(self, audio: np.ndarray) -> list[np.ndarray]:
        """Run MuseTalk inference: audio → lip-synced video frames."""
        # MuseTalk's inference API (v1.0+):
        # frames = mt.generate(audio, reference_features, fps=config.fps)
        frames = self._musetalk.generate(
            audio=audio,
            reference=self._reference_features,
            fps=self.config.fps,
        )
        # Resize frames to target resolution
        import cv2
        h, w = self.config.height, self.config.width
        resized = [cv2.resize(f, (w, h)) for f in frames]
        return resized

    def _infer_fallback(self, audio: np.ndarray) -> list[np.ndarray]:
        """Fallback: return static frames (no lip-sync), scaled to audio duration."""
        # Frame count scales with audio duration regardless of whether the
        # reference image loaded — so the video track stays in sync with audio
        # even in degraded modes (missing cv2, missing image, etc.).
        chunk_duration = len(audio) / self.config.audio_sample_rate
        num_frames = max(1, int(chunk_duration * self.config.fps))

        if self._fallback_frame is None:
            # Reference image unavailable — emit black frames as a last resort.
            h, w = self.config.height, self.config.width
            black = np.zeros((h, w, 3), dtype=np.uint8)
            return [black.copy() for _ in range(num_frames)]

        return [self._fallback_frame.copy() for _ in range(num_frames)]

    def get_idle_frame(self) -> np.ndarray:
        """Return a static frame for when the avatar is idle (not speaking)."""
        if self._fallback_frame is not None:
            return self._fallback_frame.copy()
        h, w = self.config.height, self.config.width
        return np.zeros((h, w, 3), dtype=np.uint8)
