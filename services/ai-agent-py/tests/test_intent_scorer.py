import pytest

from intent_scorer import (
    TRANSFER_THRESHOLD,
    parse_intent_llm_json,
    recommendation_for_score,
    score_intent,
    score_intent_fallback,
    validate_intent_payload,
)


def test_parse_intent_llm_json_extracts_fenced_json():
    raw = parse_intent_llm_json(
        '说明\n```json\n{"score": 0.82, "signals": ["询问价格", "确认时间"]}\n```'
    )
    assert raw["score"] == 0.82
    assert raw["signals"][0] == "询问价格"


def test_validate_intent_payload_clamps_score_and_recommends_transfer():
    result = validate_intent_payload({"score": 1.5, "signals": ["  预约  ", ""]})
    assert result.score == 1.0
    assert result.recommendation == "transfer"
    assert result.source == "llm"


def test_recommendation_threshold_matches_transfer_boundary():
    assert recommendation_for_score(TRANSFER_THRESHOLD) == "transfer"
    assert recommendation_for_score(TRANSFER_THRESHOLD - 0.01) == "continue"


def test_fallback_high_intent_for_price_and_schedule():
    result = score_intent_fallback("客户很感兴趣，问多少钱，想预约这周六看房")
    assert result.score >= TRANSFER_THRESHOLD
    assert result.recommendation == "transfer"
    assert result.source == "fallback"


def test_fallback_low_intent_for_polite_decline():
    result = score_intent_fallback("不需要，别打了")
    assert result.score < TRANSFER_THRESHOLD
    assert result.recommendation == "continue"


@pytest.mark.asyncio
async def test_score_intent_uses_injected_llm():
    async def mock_llm(_system: str, user: str) -> str:
        assert "预算" in user
        return '{"score": 0.91, "signals": ["明确预算", "希望面谈"]}'

    result = await score_intent("客户说了预算，希望面谈", language="zh", llm_complete=mock_llm)
    assert result.score == 0.91
    assert result.recommendation == "transfer"
    assert result.source == "llm"


@pytest.mark.asyncio
async def test_score_intent_falls_back_when_llm_raises():
    async def broken_llm(_system: str, _user: str) -> str:
        raise RuntimeError("llm down")

    result = await score_intent("多少钱", language="zh", llm_complete=broken_llm)
    assert result.source == "fallback"
    assert result.score >= 0.0


@pytest.mark.asyncio
async def test_score_intent_empty_summary_returns_low_score():
    result = await score_intent("   ")
    assert result.score <= 0.3
    assert result.recommendation == "continue"
