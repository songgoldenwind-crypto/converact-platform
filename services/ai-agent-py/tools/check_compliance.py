from __future__ import annotations

from livekit.agents import function_tool


async def run_check_compliance(
    opc_client,
    *,
    tenant_id: str,
    phone_number: str,
    timezone: str = "Asia/Shanghai",
) -> dict:
    if not tenant_id:
        return {"allowed": False, "reason": "tenant_id_missing"}
    if not phone_number:
        return {"allowed": False, "reason": "phone_number_missing"}

    result = await opc_client.check_compliance(
        tenant_id=tenant_id,
        phone_number=phone_number,
        timezone=timezone,
    )
    return {
        "allowed": bool(result.get("allowed")),
        "reason": result.get("reason"),
        "retry_after": result.get("retryAfter") or result.get("retry_after"),
        "calls_today": result.get("callsToday") or result.get("calls_today"),
    }


def create(opc_client, tenant_id: str, phone_number: str, timezone: str = "Asia/Shanghai"):
    @function_tool(
        name="check_compliance",
        description=(
            "外呼前检查号码是否允许拨打（DNC、时间窗、日频限制、租户状态）。"
            "在发起营销话术或确认客户身份之前必须调用。"
        ),
    )
    async def check_compliance_tool() -> dict:
        return await run_check_compliance(
            opc_client,
            tenant_id=tenant_id,
            phone_number=phone_number,
            timezone=timezone,
        )

    return check_compliance_tool
