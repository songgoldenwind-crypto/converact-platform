"""LLM tool: generate call summary before hangup."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tool_context import ToolContext

logger = logging.getLogger("ai-agent.tools")


def create(ctx: "ToolContext"):
    async def generate_call_summary_tool() -> str:
        """Generate a short summary of the current call for CRM notes."""
        if not ctx.call_session_id:
            return "无通话会话，无法生成摘要。"
        try:
            result = await ctx.opc.post(
                "/api/qm/evaluate",
                json={
                    "tenant_id": ctx.tenant_id,
                    "call_session_id": ctx.call_session_id,
                },
            )
            evaluation = result.get("data", result)
            summary = evaluation.get("summary", "")
            return summary or "通话摘要已记录。"
        except Exception as error:
            logger.warning("generate_call_summary failed: %s", error)
            return "暂时无法生成通话摘要。"

    return generate_call_summary_tool
