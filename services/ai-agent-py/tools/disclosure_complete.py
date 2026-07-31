from __future__ import annotations

from livekit.agents import function_tool


async def run_disclosure_complete(
    opc_client,
    *,
    call_session_id: str,
    tenant_id: str,
) -> dict:
    if not call_session_id:
        return {"status": "error", "error": "call_session_id_missing"}
    if not tenant_id:
        return {"status": "error", "error": "tenant_id_missing"}

    result = await opc_client.disclosure_complete(
        call_session_id=call_session_id,
        tenant_id=tenant_id,
    )
    return {
        "status": "ok",
        "state": result.get("state"),
        "consent_recorded": True,
    }


def create(opc_client, call_session_id: str, tenant_id: str):
    @function_tool(
        name="disclosure_complete",
        description=(
            "在完整播放 AI 身份披露话术并获得客户继续通话默许后调用，"
            "记录合规同意状态。未完成披露前不得进行营销内容。"
        ),
    )
    async def disclosure_complete_tool() -> dict:
        return await run_disclosure_complete(
            opc_client,
            call_session_id=call_session_id,
            tenant_id=tenant_id,
        )

    return disclosure_complete_tool
