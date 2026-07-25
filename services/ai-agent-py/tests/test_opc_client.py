from __future__ import annotations

from types import SimpleNamespace

import pytest

from opc_client import OPCClient


class FakeAsyncClient:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict | None, dict | None]] = []

    async def request(self, method: str, url: str, *, json=None, headers=None):
        self.requests.append((method, url, json, headers))
        return SimpleNamespace(
            raise_for_status=lambda: None,
            json=lambda: {"data": {"ok": True}},
        )


@pytest.mark.asyncio
async def test_opc_client_sends_tenant_id_on_ai_agent_dispatch_actions():
    client = OPCClient()
    fake = FakeAsyncClient()
    client.client = fake

    await client.request_transfer(
        room_name="room-1",
        tenant_id="tenant-1",
        call_session_id="call-1",
        reason="high intent",
        customer_summary="wants human",
    )
    await client.end_call(
        room_name="room-1",
        tenant_id="tenant-1",
        reason="done",
        summary="complete",
    )
    await client.schedule_callback(
        room_name="room-1",
        tenant_id="tenant-1",
        callback_time="2026-06-30T10:00:00Z",
        callback_phone="+81312345678",
        summary="call back",
    )

    assert [request[2]["tenant_id"] for request in fake.requests] == [
        "tenant-1",
        "tenant-1",
        "tenant-1",
    ]
    assert [request[2]["action"] for request in fake.requests] == [
        "transfer_to_human",
        "end_call",
        "schedule_callback",
    ]


@pytest.mark.asyncio
async def test_report_turn_forwards_normalized_speech_quality_fields():
    client = OPCClient()
    fake = FakeAsyncClient()
    client.client = fake

    await client.report_turn(
        "call-1",
        "customer",
        "hello",
        stt_confidence=0.93,
        latency_ms=417,
    )

    assert fake.requests[0][2] == {
        "role": "customer",
        "content": "hello",
        "stt_confidence": 0.93,
        "latency_ms": 417,
    }
