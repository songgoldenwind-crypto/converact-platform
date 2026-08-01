from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import livekit_audio_tap_transport as transport_module
from livekit_audio_tap import LiveKitAudioTapFrame, LiveKitAudioTapTrackContext
from livekit_audio_tap_transport import create_livekit_audio_tap_sink_factory


class AuthorizationClient:
    def __init__(self, endpoint: str, retry_marker: Path) -> None:
        self.endpoint = endpoint
        self.retry_marker = retry_marker
        self.attempts = 0

    async def authorize_livekit_audio_tap(self, **_input: Any) -> dict[str, Any]:
        self.attempts += 1
        try:
            return await asyncio.to_thread(self._request)
        except Exception:
            write_marker(self.retry_marker)
            raise

    def _request(self) -> dict[str, Any]:
        request = Request(
            self.endpoint,
            data=b"{}",
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urlopen(request, timeout=1) as response:
            value = json.loads(response.read(64 * 1024))
        if not isinstance(value, dict):
            raise RuntimeError("gateway_authorization_invalid")
        return value


async def main() -> None:
    authorization_url = required_env("AUTHORIZATION_URL")
    transport_module_path, transport_source_sha256 = verify_transport_source()
    state_dir = Path(required_env("STATE_DIR")).resolve()
    events_file = Path(required_env("EVENTS_FILE")).resolve()
    ready_marker = state_dir / "gateway-transport-ready"
    outage_marker = Path(required_env("OUTAGE_MARKER")).resolve()
    retry_marker = state_dir / "gateway-retry-observed"
    output_file = state_dir / "gateway-result.json"

    converact = AuthorizationClient(authorization_url, retry_marker)
    sink_factory = create_livekit_audio_tap_sink_factory(
        converact,
        open_timeout_seconds=1,
        close_timeout_seconds=0.5,
    )
    sink = await sink_factory(track_context())
    try:
        await sink.write(audio_frame(1))
        first = await wait_for_frame(events_file, 1)
        write_marker(ready_marker)
        await wait_for(lambda: outage_marker.exists(), 30)

        await sink.write(audio_frame(2))
        second = await wait_for_frame(events_file, 2)
        report = {
            "status": "passed",
            "actual_gateway_process_restart": True,
            "gateway_process_restarted": first["pid"] != second["pid"],
            "first_gateway_pid": first["pid"],
            "second_gateway_pid": second["pid"],
            "authorization_attempts": converact.attempts,
            "delivered_sequences": [first["sequence"], second["sequence"]],
            "transport_module_path": transport_module_path,
            "transport_source_sha256": transport_source_sha256,
        }
        if (
            not report["gateway_process_restarted"]
            or report["authorization_attempts"] < 2
            or report["delivered_sequences"] != [1, 2]
        ):
            raise RuntimeError("gateway_process_recovery_invalid")
        write_json(output_file, report)
        print(json.dumps(report, separators=(",", ":")))
    finally:
        await sink.close("gateway_process_recovery_complete")


def track_context() -> LiveKitAudioTapTrackContext:
    return LiveKitAudioTapTrackContext(
        tenant_id="tenant-realtime-recovery",
        interaction_id="interaction-realtime-recovery",
        media_session_id="room-realtime-recovery",
        media_source="livekit",
        room_name="room-realtime-recovery",
        participant_id="customer-realtime-recovery",
        track_id="TR_realtime_recovery",
        track_source="microphone",
        purpose="live_translation",
        consent_ref="consent-realtime-recovery",
        source_language="en",
        target_languages=("zh-CN",),
        features=("streaming_asr", "streaming_translation"),
    )


def audio_frame(sequence: int) -> LiveKitAudioTapFrame:
    return LiveKitAudioTapFrame(
        sequence=sequence,
        received_at_micros=1_753_234_567_890_123 + sequence * 20_000,
        sample_rate_hz=16_000,
        channels=1,
        sample_count=320,
        duration_ms=20,
        pcm_s16le=bytes([sequence, 0]) * 320,
    )


async def wait_for_frame(path: Path, sequence: int) -> dict[str, int]:
    found: dict[str, int] | None = None

    def inspect() -> bool:
        nonlocal found
        if not path.exists():
            return False
        for line in path.read_text(encoding="utf-8").splitlines():
            value = json.loads(line)
            if value.get("type") == "audio_frame" and value.get("sequence") == sequence:
                found = {"pid": int(value["pid"]), "sequence": int(value["sequence"])}
                return True
        return False

    await wait_for(inspect, 30)
    if found is None:
        raise RuntimeError("gateway_frame_not_observed")
    return found


async def wait_for(predicate, timeout_seconds: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while not predicate():
        if asyncio.get_running_loop().time() >= deadline:
            raise RuntimeError("gateway_process_recovery_timeout")
        await asyncio.sleep(0.025)


def write_marker(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = secure_create(path)
    except FileExistsError:
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("gateway_marker_path_invalid")
        return
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write("ready\n")


def write_json(path: Path, value: dict[str, Any]) -> None:
    descriptor = secure_create(path)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        output.write(json.dumps(value, indent=2) + "\n")


def secure_create(path: Path) -> int:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    return os.open(path, flags, 0o600)


def verify_transport_source() -> tuple[str, str]:
    expected_sha256 = required_env("EXPECTED_TRANSPORT_SHA256").lower()
    if len(expected_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in expected_sha256
    ):
        raise RuntimeError("transport_source_sha256_invalid")
    module_path = Path(str(transport_module.__file__ or "")).resolve()
    expected_path = Path("/workspace/livekit_audio_tap_transport.py")
    if module_path != expected_path:
        raise RuntimeError("transport_module_path_invalid")
    actual_sha256 = hashlib.sha256(module_path.read_bytes()).hexdigest()
    if actual_sha256 != expected_sha256:
        raise RuntimeError("transport_source_sha256_mismatch")
    return str(module_path), actual_sha256


def required_env(name: str) -> str:
    value = str(os.getenv(name, "")).strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


asyncio.run(main())
