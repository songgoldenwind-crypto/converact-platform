from __future__ import annotations

from livekit.agents import function_tool


def create(opc_client, room_name: str, tenant_id: str, language: str = "ja"):
    @function_tool(
        name="schedule_callback",
        description="客户希望稍后再联系时，预约回电时间。",
    )
    async def schedule_callback(callback_time: str, callback_phone: str, customer_summary: str) -> dict:
        return await opc_client.schedule_callback(
            room_name=room_name,
            tenant_id=tenant_id,
            callback_time=callback_time,
            callback_phone=callback_phone,
            summary=customer_summary,
            language=language,
        )

    return schedule_callback
