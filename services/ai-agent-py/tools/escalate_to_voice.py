from __future__ import annotations

from livekit.agents import function_tool


def create(opc_client, tenant_id: str, conversation_id: str = ""):
    @function_tool(
        name="escalate_to_voice",
        description="文字渠道客户高意向或请求通话时，创建外呼任务升级到语音。",
    )
    async def escalate_to_voice(
        phone_number: str,
        agent_spec_id: str = "",
        reason: str = "",
    ) -> dict:
        return await opc_client.escalate_omni_to_voice(
            tenant_id=tenant_id,
            conversation_id=conversation_id,
            phone_number=phone_number,
            agent_spec_id=agent_spec_id or None,
            reason=reason,
        )

    return escalate_to_voice
