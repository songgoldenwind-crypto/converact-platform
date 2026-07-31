from __future__ import annotations

from livekit.agents import function_tool

from intent_scorer import score_intent


async def run_check_intent(
    opc_client,
    call_session_id: str,
    conversation_summary: str,
    language: str = "zh",
) -> dict:
    result = await score_intent(conversation_summary, language=language)
    await opc_client.report_intent(call_session_id, result.score, result.signals)
    return {
        "score": result.score,
        "signals": result.signals,
        "recommendation": result.recommendation,
        "source": result.source,
    }


def create(opc_client, call_session_id: str, language: str = "zh"):
    @function_tool(
        name="check_intent",
        description="分析当前对话判断客户意向等级。在客户表达兴趣、询问价格、确认时间时调用。",
    )
    async def check_intent_tool(conversation_summary: str) -> dict:
        return await run_check_intent(opc_client, call_session_id, conversation_summary, language)

    return check_intent_tool
