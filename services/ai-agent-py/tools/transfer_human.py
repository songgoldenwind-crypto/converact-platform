from __future__ import annotations

from livekit.agents import function_tool


def create(opc_client, room_name: str, tenant_id: str, call_session_id: str, language: str = "ja"):
    @function_tool(
        name="transfer_to_human",
        description="当客户意向高或请求人工服务时，请求转接给人工坐席。",
    )
    async def transfer_to_human(reason: str, customer_summary: str) -> dict:
        result = await opc_client.request_transfer(
            room_name=room_name,
            tenant_id=tenant_id,
            call_session_id=call_session_id,
            reason=reason,
            customer_summary=customer_summary,
            language=language,
        )
        return result

    return transfer_to_human
