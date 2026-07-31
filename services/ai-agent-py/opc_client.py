"""HTTP client for OPC call-center APIs."""
from __future__ import annotations

import logging
from urllib.parse import quote

import httpx

from config import CONVERACT_API_KEY, CONVERACT_API_URL

logger = logging.getLogger("ai-agent.opc")


class OPCClient:
    def __init__(self) -> None:
        self.base_url = CONVERACT_API_URL.rstrip("/")
        self.headers = {
            "Content-Type": "application/json",
            "X-API-Key": CONVERACT_API_KEY,
        }
        self.client = httpx.AsyncClient(timeout=10.0)

    async def _request_json(
        self,
        method: str,
        path: str,
        *,
        json_body: dict | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> dict:
        response = await self.client.request(
            method,
            f"{self.base_url}{path}",
            json=json_body,
            headers={**self.headers, **(extra_headers or {})},
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, dict) and "data" in payload:
            data = payload["data"]
            return data if isinstance(data, dict) else {"data": data}
        return payload if isinstance(payload, dict) else {"data": payload}

    async def authorize_livekit_audio_tap(
        self,
        *,
        tenant_id: str,
        call_id: str,
        participant_id: str,
        track_id: str,
    ) -> dict:
        return await self._request_json(
            "POST",
            (
                f"/api/ivekit/media/calls/{quote(call_id, safe='')}"
                "/realtime-audio-tap-authorizations"
            ),
            json_body={
                "participant_id": participant_id,
                "track_id": track_id,
            },
            extra_headers={"X-Tenant-Id": tenant_id},
        )

    async def get_voice_agent_spec(self, spec_id: str) -> dict | None:
        try:
            return await self._request_json("GET", f"/api/voice-agents/specs/{spec_id}")
        except httpx.HTTPStatusError as error:
            if error.response.status_code == 404:
                return None
            logger.warning("failed to fetch voice agent spec %s: %s", spec_id, error)
            raise
        except httpx.HTTPError as error:
            logger.warning("failed to fetch voice agent spec %s: %s", spec_id, error)
            return None

    async def report_turn(
        self,
        call_session_id: str,
        role: str,
        content: str,
        *,
        stt_confidence: float | None = None,
        latency_ms: int | None = None,
    ) -> None:
        if not call_session_id:
            return
        payload = {"role": role, "content": content}
        if stt_confidence is not None:
            payload["stt_confidence"] = stt_confidence
        if latency_ms is not None:
            payload["latency_ms"] = latency_ms
        try:
            await self._request_json(
                "POST",
                f"/api/call-center/calls/{call_session_id}/turns",
                json_body=payload,
            )
        except httpx.HTTPError as error:
            logger.warning("failed to report turn for %s: %s", call_session_id, error)

    async def report_intent(self, call_session_id: str, score: float, signals: list[str]) -> None:
        if not call_session_id:
            return
        try:
            await self._request_json(
                "POST",
                f"/api/call-center/calls/{call_session_id}/intent",
                json_body={"intent_score": score, "signals": signals},
            )
        except httpx.HTTPError as error:
            logger.warning("failed to report intent for %s: %s", call_session_id, error)

    async def request_transfer(
        self,
        *,
        room_name: str,
        tenant_id: str,
        call_session_id: str,
        reason: str,
        customer_summary: str,
        language: str = "zh",
        intent_score: float = 0,
    ) -> dict:
        return await self._request_json(
            "POST",
            "/api/livekit/agent-dispatch",
            json_body={
                "tenant_id": tenant_id,
                "room_name": room_name,
                "action": "transfer_to_human",
                "call_session_id": call_session_id,
                "reason": reason,
                "customer_summary": customer_summary,
                "intent_score": intent_score,
                "language": language,
            },
        )

    async def end_call(self, room_name: str, tenant_id: str, reason: str, summary: str) -> dict:
        return await self._request_json(
            "POST",
            "/api/livekit/agent-dispatch",
            json_body={
                "tenant_id": tenant_id,
                "room_name": room_name,
                "action": "end_call",
                "reason": reason,
                "customer_summary": summary,
            },
        )

    async def schedule_callback(
        self,
        room_name: str,
        tenant_id: str,
        callback_time: str,
        callback_phone: str,
        summary: str,
        language: str = "zh",
    ) -> dict:
        return await self._request_json(
            "POST",
            "/api/livekit/agent-dispatch",
            json_body={
                "tenant_id": tenant_id,
                "room_name": room_name,
                "action": "schedule_callback",
                "reason": "customer requested callback",
                "customer_summary": summary,
                "callback_time": callback_time,
                "callback_phone": callback_phone,
                "language": language,
            },
        )

    async def navigate_flow(
        self,
        *,
        call_session_id: str,
        agent_spec_id: str,
        trigger: str,
        customer_text: str = "",
    ) -> dict:
        return await self._request_json(
            "POST",
            f"/api/call-center/calls/{call_session_id}/navigate",
            json_body={
                "trigger": trigger,
                "agent_spec_id": agent_spec_id,
                "customer_text": customer_text,
            },
        )

    async def check_compliance(
        self,
        *,
        tenant_id: str,
        phone_number: str,
        timezone: str = "Asia/Shanghai",
    ) -> dict:
        return await self._request_json(
            "POST",
            "/api/compliance/check",
            json_body={
                "tenant_id": tenant_id,
                "phone_number": phone_number,
                "timezone": timezone,
            },
        )

    async def disclosure_complete(self, *, call_session_id: str, tenant_id: str) -> dict:
        return await self._request_json(
            "POST",
            f"/api/compliance/calls/{call_session_id}/disclosure-complete",
            json_body={"tenant_id": tenant_id},
        )

    async def get_session_cache(self, call_session_id: str) -> dict:
        return await self._request_json(
            "GET",
            f"/api/call-center/calls/{call_session_id}/session-cache",
        )

    async def patch_session_cache(self, call_session_id: str, fields: dict) -> dict:
        return await self._request_json(
            "PATCH",
            f"/api/call-center/calls/{call_session_id}/session-cache",
            json_body=fields,
        )

    async def aclose(self) -> None:
        await self.client.aclose()
