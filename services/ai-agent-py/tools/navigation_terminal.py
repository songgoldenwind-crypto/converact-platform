from __future__ import annotations

import logging

from converact_client import ConveractClient
from tool_context import ToolContext

logger = logging.getLogger("ai-agent.tools")


async def dispatch_navigation_terminal(
    converact: ConveractClient,
    ctx: ToolContext,
    navigation: dict,
    customer_text: str,
) -> dict | None:
    if not navigation.get("reached_terminal"):
        return None

    action = navigation.get("action_taken")
    summary = customer_text or str(navigation.get("message_for_agent") or "")

    if action == "transfer_human":
        return await converact.request_transfer(
            room_name=ctx.ctx.room.name,
            tenant_id=ctx.tenant_id,
            call_session_id=ctx.call_session_id,
            reason="navigation terminal: transfer_human",
            customer_summary=summary,
            language=ctx.language,
        )

    if action == "end_call":
        return await converact.end_call(
            room_name=ctx.ctx.room.name,
            tenant_id=ctx.tenant_id,
            reason="navigation terminal: end_call",
            summary=summary,
        )

    if action == "schedule_callback":
        return {
            "hint": "请使用 schedule_callback 工具向客户确认回电时间与号码后预约。",
            "action_taken": action,
        }

    return None
