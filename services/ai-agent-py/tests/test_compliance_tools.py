import pytest

from tools.check_compliance import run_check_compliance
from tools.disclosure_complete import run_disclosure_complete


class FakeOpc:
    def __init__(self) -> None:
        self.compliance_calls: list[tuple[str, str, str]] = []
        self.disclosure_calls: list[tuple[str, str]] = []

    async def check_compliance(self, *, tenant_id: str, phone_number: str, timezone: str = "Asia/Shanghai") -> dict:
        self.compliance_calls.append((tenant_id, phone_number, timezone))
        return {"allowed": True, "callsToday": 0}

    async def disclosure_complete(self, *, call_session_id: str, tenant_id: str) -> dict:
        self.disclosure_calls.append((call_session_id, tenant_id))
        return {"state": "completed"}


@pytest.mark.asyncio
async def test_run_check_compliance_calls_opc_api():
    fake = FakeOpc()
    result = await run_check_compliance(
        fake,
        tenant_id="tenant_1",
        phone_number="+8613800138000",
        timezone="Asia/Shanghai",
    )

    assert result["allowed"] is True
    assert fake.compliance_calls == [("tenant_1", "+8613800138000", "Asia/Shanghai")]


@pytest.mark.asyncio
async def test_run_check_compliance_requires_tenant_id():
    fake = FakeOpc()
    result = await run_check_compliance(fake, tenant_id="", phone_number="+8613800138000")
    assert result["allowed"] is False
    assert result["reason"] == "tenant_id_missing"
    assert fake.compliance_calls == []


@pytest.mark.asyncio
async def test_run_disclosure_complete_records_consent():
    fake = FakeOpc()
    result = await run_disclosure_complete(
        fake,
        call_session_id="call_1",
        tenant_id="tenant_1",
    )

    assert result["status"] == "ok"
    assert result["consent_recorded"] is True
    assert fake.disclosure_calls == [("call_1", "tenant_1")]
