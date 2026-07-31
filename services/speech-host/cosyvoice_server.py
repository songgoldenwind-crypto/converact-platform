"""
Minimal CosyVoice FastAPI shim for OPC ai-agent CosyVoiceTTS client.

Requires CosyVoice repo + models — see README.md for setup.
Fallback: returns 503 until CosyVoice is installed.

POST /inference_sft  { "tts_text": "...", "spk_id": "中文女" }
"""
from __future__ import annotations

import io
import os

from fastapi import FastAPI
from fastapi.responses import Response, JSONResponse

app = FastAPI(title="OPC CosyVoice Server")
_cosyvoice = None


def get_cosyvoice():
    global _cosyvoice
    if _cosyvoice is None:
        cosyvoice_root = os.getenv("COSYVOICE_ROOT", "")
        if not cosyvoice_root:
            raise RuntimeError("Set COSYVOICE_ROOT to your CosyVoice clone path")
        import sys

        sys.path.insert(0, cosyvoice_root)
        from cosyvoice.cli.cosyvoice import CosyVoice2

        model_dir = os.getenv("COSYVOICE_MODEL_DIR", os.path.join(cosyvoice_root, "pretrained_models/CosyVoice2-0.5B"))
        _cosyvoice = CosyVoice2(model_dir)
    return _cosyvoice


@app.get("/health")
def health():
    ready = bool(os.getenv("COSYVOICE_ROOT"))
    return {"ok": ready, "service": "cosyvoice"}


@app.post("/inference_sft")
async def inference_sft(body: dict):
    text = str(body.get("tts_text") or "")
    spk_id = str(body.get("spk_id") or "中文女")
    if not text:
        return JSONResponse({"error": "tts_text required"}, status_code=400)
    if not os.getenv("COSYVOICE_ROOT"):
        return JSONResponse(
            {"error": "CosyVoice not configured. Set COSYVOICE_ROOT and install models — see services/speech-host/README.md"},
            status_code=503,
        )

    import torch
    import torchaudio

    model = get_cosyvoice()
    chunks = []
    for _, output in enumerate(model.inference_sft(text, spk_id)):
        chunks.append(output["tts_speech"])

    if not chunks:
        return JSONResponse({"error": "synthesis failed"}, status_code=500)

    audio = torch.cat(chunks, dim=1)
    buf = io.BytesIO()
    torchaudio.save(buf, audio, model.sample_rate, format="wav")
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("COSYVOICE_PORT", "50000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
