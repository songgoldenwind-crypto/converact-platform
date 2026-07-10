import pytest

from intent_scorer import IntentScoreResult
from tools.check_intent import run_check_intent


class FakeOpc:
    def __init__(self) -> None:
        self.intents: list[tuple[str, float, list[str]]] = []

    async def report_intent(self, call_session_id: str, score: float, signals: list[str]) -> None:
        self.intents.append((call_session_id, score, signals))


@pytest.mark.asyncio
async def test_run_check_intent_reports_score_without_navigation(monkeypatch):
    fake = FakeOpc()

    async def mock_score(_summary: str, *, language: str = "zh", llm_complete=None):
        return IntentScoreResult(
            score=0.88,
            signals=["mock"],
            recommendation="transfer",
            source="llm",
        )

    monkeypatch.setattr("tools.check_intent.score_intent", mock_score)
    result = await run_check_intent(fake, "call-1", "客户想预约", "zh")

    assert result["score"] == 0.88
    assert result["recommendation"] == "transfer"
    assert result["source"] == "llm"
    assert fake.intents == [("call-1", 0.88, ["mock"])]
