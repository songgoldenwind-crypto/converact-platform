"""
Minimal OpenAI-compatible ASR server wrapping FunASR SenseVoice (Chinese).

Mac (Apple Silicon): pip install funasr modelscope torch
  python funasr_server.py

Health: GET /health
Transcribe: POST /v1/audio/transcriptions (OpenAI format)
"""
from __future__ import annotations

import io
import os
import tempfile
import wave

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI(title="Converact FunASR Server")
_model = None


def get_model():
    global _model
    if _model is None:
        from funasr import AutoModel

        device = os.getenv("FUNASR_DEVICE", "mps")
        try:
            _model = AutoModel(
                model="iic/SenseVoiceSmall",
                vad_model="fsmn-vad",
                punc_model="ct-punc",
                device=device,
            )
        except Exception:
            _model = AutoModel(model="iic/SenseVoiceSmall", device="cpu")
    return _model


@app.get("/health")
def health():
    return {"ok": True, "service": "funasr"}


@app.post("/v1/audio/transcriptions")
async def transcribe(
    file: UploadFile = File(...),
    model: str = Form("sensevoice"),
    language: str = Form("zh"),
):
    raw = await file.read()
    suffix = ".wav"
    if file.filename and "." in file.filename:
        suffix = "." + file.filename.rsplit(".", 1)[-1]

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(raw)
        tmp_path = tmp.name

    try:
        result = get_model().generate(input=tmp_path, language=language if language != "auto" else "auto")
        text = ""
        if isinstance(result, list) and result:
            item = result[0]
            text = str(item.get("text") or item.get("sentence") or item)
        else:
            text = str(result)
        return JSONResponse({"text": text.strip()})
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("FUNASR_PORT", "8899"))
    uvicorn.run(app, host="0.0.0.0", port=port)
