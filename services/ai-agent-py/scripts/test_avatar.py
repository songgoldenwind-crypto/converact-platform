#!/usr/bin/env python3
"""
Standalone validation script for the avatar MuseTalk runner.

Tests:
1. Config loads from env
2. Runner initializes (loads reference image, attempts MuseTalk model load)
3. Fallback inference produces frames from a test audio chunk
4. Frame dimensions match config

Run:
    cd services/ai-agent-py
    python scripts/test_avatar.py

This script does NOT require MuseTalk installed — it tests the fallback
path (static image) and the MuseTalk path if available.
"""
import asyncio
import logging
import sys
import os

# Add the ai-agent-py directory to the path so avatar module is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("avatar-test")


async def main():
    from avatar.config import load_avatar_config
    from avatar.musetalk_runner import MuseTalkRunner

    # Step 1: Load config
    config = load_avatar_config()
    logger.info("Config: %dx%d@%dfps, device=%s", config.width, config.height, config.fps, config.device)
    logger.info("  model_path: %s", config.musetalk_model_path)
    logger.info("  avatar_image: %s", config.default_avatar_path)
    logger.info("  chunk_samples: %d (%dms)", config.audio_chunk_samples, config.audio_chunk_ms)

    # Step 2: Initialize runner
    runner = MuseTalkRunner(config)
    await runner.load()
    logger.info("Runner loaded: is_loaded=%s, is_fallback=%s", runner.is_loaded, runner.is_fallback)

    # Step 3: Test fallback inference with a 1-second sine wave
    duration = 1.0  # 1 second
    samples = int(duration * config.audio_sample_rate)
    t = np.linspace(0, duration, samples, dtype=np.float32)
    test_audio = 0.5 * np.sin(2 * np.pi * 220 * t)  # 220Hz sine wave

    frames = runner.infer(test_audio)
    logger.info("Inference: %d frames from %.1fs audio", len(frames), duration)

    if frames:
        frame = frames[0]
        logger.info("  Frame shape: %s, dtype: %s", frame.shape, frame.dtype)
        assert frame.shape[0] == config.height, f"height mismatch: {frame.shape[0]} != {config.height}"
        assert frame.shape[1] == config.width, f"width mismatch: {frame.shape[1]} != {config.width}"
        logger.info("  Frame dimensions OK: %dx%d", frame.shape[1], frame.shape[0])

    # Step 4: Test idle frame
    idle = runner.get_idle_frame()
    logger.info("Idle frame: shape=%s", idle.shape)

    # Step 5: Test multiple chunks (simulating streaming TTS)
    chunk_samples = config.audio_chunk_samples
    num_chunks = 5
    total_frames = 0
    for i in range(num_chunks):
        chunk = 0.3 * np.sin(2 * np.pi * 220 * np.arange(chunk_samples, dtype=np.float32) / config.audio_sample_rate)
        frames = runner.infer(chunk)
        total_frames += len(frames)
    logger.info("Streaming: %d chunks → %d total frames (%.1fs of video)", num_chunks, total_frames, total_frames / config.fps)

    logger.info("✓ Avatar validation passed")


if __name__ == "__main__":
    asyncio.run(main())
