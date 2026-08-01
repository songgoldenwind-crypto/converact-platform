from __future__ import annotations

import logging

from livekit.agents import function_tool
from tool_context import ToolContext

from tools.navigation_terminal import dispatch_navigation_terminal

logger = logging.getLogger("ai-agent.tools")


def create(tool_ctx: ToolContext):
    @function_tool(
        name="navigate_flow",
        description="在语音导航节点图中切换流程。客户说选项数字/关键词，或意向变化时调用。",
    )
    async def navigate_flow_tool(trigger: str, customer_text: str = "") -> dict:
        if not tool_ctx.agent_spec_id:
            return {"error": "agent_spec_id is required for navigation"}
        try:
            navigation = await tool_ctx.converact.navigate_flow(
                call_session_id=tool_ctx.call_session_id,
                agent_spec_id=tool_ctx.agent_spec_id,
                trigger=trigger,
                customer_text=customer_text,
            )
            result = {**navigation}
            dispatch = await dispatch_navigation_terminal(
                tool_ctx.converact, tool_ctx, navigation, customer_text
            )
            if dispatch is not None:
                result["terminal_dispatch"] = dispatch
            return result
        except Exception as error:
            logger.warning("navigate_flow failed for %s: %s", tool_ctx.call_session_id, error)
            return {"error": str(error)}

    return navigate_flow_tool
