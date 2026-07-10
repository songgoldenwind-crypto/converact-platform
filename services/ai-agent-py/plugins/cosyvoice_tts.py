"""HTTP client TTS for CosyVoice FastAPI server.

Supports streaming: the CosyVoice server returns a complete WAV, but we
chunk the PCM data into ~100ms segments and emit them incrementally so the
avatar video source can start lip-sync inference before the full utterance
finishes. This reduces perceived latency for the digital human.
"""
from __future__ import annotations

import io
import wave
from dataclasses import dataclass

import httpx
import numpy as np
from livekit import rtc
from livekit.agents import tts, utils

from config import COSYVOICE_SPK_ID, COSYVOICE_URL
from avatar.audio_feed import feed_tts_pcm

# Chunk size for streaming: 100ms of audio at the TTS sample rate.
# Smaller = lower latency but more overhead. 100ms balances both.
_STREAM_CHUNK_MS = 100


@dataclass
class _TTSOptions:
    base_url: str
    spk_id: str
    sample_rate: int = 22050


class CosyVoiceTTS(tts.TTS):
    def __init__(
        self,
        *,
        base_url: str | None = None,
        spk_id: str | None = None,
        sample_rate: int = 22050,
        avatar_session_key: str | None = None,
    ) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=True),
            sample_rate=sample_rate,
            num_channels=1,
        )
        self._avatar_session_key = avatar_session_key
        self._opts = _TTSOptions(
            base_url=(base_url or COSYVOICE_URL).rstrip("/"),
            spk_id=spk_id or COSYVOICE_SPK_ID,
            sample_rate=sample_rate,
        )

    def synthesize(self, text: str, *, conn_options: tts.APIConnectOptions) -> tts.ChunkedStream:
        return _CosyVoiceChunkedStream(tts=self, text=text, conn_options=conn_options)


class _CosyVoiceChunkedStream(tts.ChunkedStream):
    def __init__(self, *, tts: CosyVoiceTTS, text: str, conn_options: tts.APIConnectOptions) -> None:
        super().__init__(tts=tts, input_text=text, conn_options=conn_options)
        self._tts: CosyVoiceTTS = tts

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        opts = self._tts._opts
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{opts.base_url}/inference_sft",
                json={"tts_text": self._input_text, "spk_id": opts.spk_id},
            )
            response.raise_for_status()
            wav_bytes = response.content

        with wave.open(io.BytesIO(wav_bytes), "rb") as wf:
            sample_rate = wf.getframerate()
            num_channels = wf.getnchannels()
            sample_width = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())

        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=sample_rate,
            num_channels=num_channels,
            mime_type="audio/pcm",
        )

        # Stream the PCM data in chunks rather than pushing it all at once.
        # This lets the avatar video source start MuseTalk inference on each
        # chunk as it arrives, reducing end-to-end latency.
        chunk_samples = int(sample_rate * _STREAM_CHUNK_MS / 1000)
        chunk_bytes = chunk_samples * sample_width * num_channels

        avatar_key = self._tts._avatar_session_key

        if chunk_bytes == 0:
            # Edge case: very low sample rate
            output_emitter.push(frames)
            feed_tts_pcm(frames, sample_rate, session_key=avatar_key)
        else:
            for i in range(0, len(frames), chunk_bytes):
                chunk = frames[i : i + chunk_bytes]
                output_emitter.push(chunk)
                feed_tts_pcm(chunk, sample_rate, session_key=avatar_key)

        output_emitter.flush()
