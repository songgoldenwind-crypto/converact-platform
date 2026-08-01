"""LLM tool: query enterprise knowledge base during calls."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from tool_context import ToolContext

logger = logging.getLogger("ai-agent.tools")


def create(ctx: "ToolContext"):
    """Create the query_knowledge_base callable for LLM function calling."""

    async def query_knowledge_base_tool(question: str) -> str:
        """Query the enterprise knowledge base to answer customer questions."""
        try:
            result = await ctx.converact.post(
                "/api/knowledge/ask",
                json={
                    "tenant_id": ctx.tenant_id,
                    "question": question,
                },
            )
            data = result.get("data", {})
            answer = data.get("answer", "")
            sources = data.get("sources", [])

            if not answer:
                return "知识库中未找到相关信息。"

            source_text = "".join(f"\n- {s['title']}" for s in sources[:3])
            return f"{answer}\n\n参考来源：{source_text}" if sources else answer
        except Exception as e:
            logger.warning("query_knowledge_base failed: %s", e)
            return "暂时无法查询知识库，请稍后再试。"

    return query_knowledge_base_tool
