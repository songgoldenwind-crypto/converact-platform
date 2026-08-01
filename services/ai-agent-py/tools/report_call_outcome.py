"""LLM tool: report call disposition back to campaign dialer."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tool_context import ToolContext

logger = logging.getLogger("ai-agent.tools")


def create(ctx: "ToolContext"):
    async def report_call_outcome_tool(disposition: str, success: bool = True) -> str:
        """Report the call outcome to the outbound campaign engine."""
        meta = ctx.room_meta if isinstance(ctx.room_meta, dict) else {}
        campaign_id = str(meta.get("campaign_id") or "")
        contact_id = str(meta.get("campaign_contact_id") or "")
        if not campaign_id or not contact_id:
            return "当前通话未关联 Campaign，结果已记录在会话中。"

        try:
            await ctx.converact.post(
                "/api/call-center/campaigns/report-outcome",
                json={
                    "campaign_id": campaign_id,
                    "campaign_contact_id": contact_id,
                    "disposition": disposition,
                    "success": success,
                },
            )
            return f"已回传 Campaign 结果：{disposition}"
        except Exception as error:
            logger.warning("report_call_outcome failed: %s", error)
            return "Campaign 结果回传失败。"

    return report_call_outcome_tool
