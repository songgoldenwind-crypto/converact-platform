"""LLM-based customer intent scoring for voice agents."""
from __future__ import annotations

import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from config import is_llm_configured
from llm_client import chat_completions_with_fallback

logger = logging.getLogger("ai-agent.intent")

TRANSFER_THRESHOLD = 0.7

LlmComplete = Callable[[str, str], Awaitable[str]]


@dataclass(frozen=True)
class IntentScoreResult:
    score: float
    signals: list[str]
    recommendation: str
    source: str


def recommendation_for_score(score: float) -> str:
    return "transfer" if score >= TRANSFER_THRESHOLD else "continue"


def parse_intent_llm_json(text: str) -> dict[str, Any]:
    trimmed = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", trimmed, flags=re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else trimmed
    payload = json.loads(candidate)
    if not isinstance(payload, dict):
        raise ValueError("intent LLM response must be a JSON object")
    return payload


def validate_intent_payload(raw: dict[str, Any]) -> IntentScoreResult:
    score = float(raw.get("score", 0))
    score = max(0.0, min(1.0, score))
    signals = [str(item).strip() for item in (raw.get("signals") or []) if str(item).strip()][:10]
    return IntentScoreResult(
        score=score,
        signals=signals,
        recommendation=recommendation_for_score(score),
        source="llm",
    )


def score_intent_fallback(conversation_summary: str) -> IntentScoreResult:
    signals: list[str] = []
    score = 0.25
    positive_keywords = [
        "感兴趣",
        "多少钱",
        "什么时候",
        "可以看看",
        "预约",
        "interested",
        "how much",
        "when",
        "schedule",
        "見たい",
        "いくら",
        "予約",
        "内見",
    ]
    negative_keywords = ["不需要", "别打了", "挂断", "not interested", "no thanks", "結構です"]
    text = conversation_summary or ""
    for kw in negative_keywords:
        if kw in text:
            signals.append(kw)
            score -= 0.2
    for kw in positive_keywords:
        if kw in text:
            signals.append(kw)
            score += 0.15
    score = max(0.0, min(1.0, score))
    return IntentScoreResult(
        score=score,
        signals=signals,
        recommendation=recommendation_for_score(score),
        source="fallback",
    )


def build_intent_system_prompt(language: str) -> str:
    lang = (language or "zh").lower()
    if lang == "ja":
        return (
            "あなたは音声外呼の意向分析器です。会話要約から顧客の購入/予約意向を 0.0〜1.0 で評価してください。"
            "JSON のみ返す: {\"score\": number, \"signals\": [\"根拠1\", \"根拠2\"]}"
            "0.7 以上は転送/次アクションに値する高意向。"
        )
    if lang == "en":
        return (
            "You score outbound-call purchase intent from 0.0 to 1.0."
            'Return JSON only: {"score": number, "signals": ["reason1", "reason2"]}.'
            "Scores >= 0.7 indicate high intent worthy of transfer or next step."
        )
    return (
        "你是外呼意向分析器。根据对话摘要评估客户购买/预约意向，分数 0.0〜1.0。"
        '只返回 JSON：{"score": number, "signals": ["依据1", "依据2"]}。'
        "0.7 及以上视为高意向，适合转人工或推进下一步。"
    )


async def default_llm_complete(system_prompt: str, user_prompt: str) -> str:
    result = await chat_completions_with_fallback(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.1,
        response_format={"type": "json_object"},
    )
    return result.text


async def score_intent(
    conversation_summary: str,
    *,
    language: str = "zh",
    llm_complete: LlmComplete | None = None,
) -> IntentScoreResult:
    summary = str(conversation_summary or "").strip()
    if not summary:
        return IntentScoreResult(
            score=0.2,
            signals=["empty_summary"],
            recommendation="continue",
            source="fallback",
        )

    try:
        if llm_complete is not None:
            raw_text = await llm_complete(build_intent_system_prompt(language), summary)
        elif is_llm_configured():
            raw_text = await default_llm_complete(build_intent_system_prompt(language), summary)
        else:
            return score_intent_fallback(summary)
        return validate_intent_payload(parse_intent_llm_json(raw_text))
    except Exception as error:
        logger.warning("LLM intent scoring failed, using fallback: %s", error)
        return score_intent_fallback(summary)
