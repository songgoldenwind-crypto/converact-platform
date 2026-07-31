"""LLM tool: load campaign script variant for outbound calls."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tool_context import ToolContext

logger = logging.getLogger("ai-agent.tools")


def create(ctx: "ToolContext", campaign_id: str | None = None):
    async def get_campaign_script_tool() -> str:
        """Load the active campaign script / agent spec for this call."""
        meta = ctx.room_meta if isinstance(ctx.room_meta, dict) else {}
        cid = campaign_id or str(meta.get("campaign_id") or "")
        variant = str(meta.get("ab_variant") or "A")
        if not cid:
            spec_id = str(meta.get("agent_spec_id") or "")
            return f"未关联 Campaign，使用默认话术 {spec_id or 'default'}。"

        try:
            result = await ctx.opc.get(f"/api/call-center/campaigns/{cid}")
            campaign = result.get("campaign") or result.get("data", {}).get("campaign") or {}
            spec_a = campaign.get("agent_spec_id_a", "")
            spec_b = campaign.get("agent_spec_id_b", "")
            spec_id = spec_b if variant == "B" and spec_b else spec_a
            return f"Campaign「{campaign.get('name', cid)}」变体 {variant}，话术 ID：{spec_id}"
        except Exception as error:
            logger.warning("get_campaign_script failed: %s", error)
            return "暂时无法加载 Campaign 话术。"

    return get_campaign_script_tool
