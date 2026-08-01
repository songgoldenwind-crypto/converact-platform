from __future__ import annotations

from livekit.agents import function_tool


def create(converact_client, tenant_id: str):
    @function_tool(
        name="send_material",
        description="客户索要资料时记录请求（Phase 1: 仅记录日志）。",
    )
    async def send_material(material_type: str, destination: str) -> dict:
        # Phase 1: log only; channel integration in later phases
        return {
            "status": "logged",
            "tenant_id": tenant_id,
            "material_type": material_type,
            "destination": destination,
        }

    return send_material
