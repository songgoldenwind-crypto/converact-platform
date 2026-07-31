from __future__ import annotations

from config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_FALLBACK_PROVIDERS,
    LLM_MODEL,
    is_fallback_llm_configured,
    is_primary_llm_configured,
    parse_llm_extra_body,
)
from plugins.provider_runtime import normalize_provider_order, wrap_llm_candidates

_ALLOWED_PROVIDERS = {"primary", "deepseek"}


def get_llm():
    order = normalize_provider_order(
        "primary",
        LLM_FALLBACK_PROVIDERS,
        allowed=_ALLOWED_PROVIDERS,
        capability="LLM",
    )
    candidates = [
        (provider, instance)
        for provider in order
        if (instance := _create_llm(provider)) is not None
    ]
    return wrap_llm_candidates(candidates)


def _create_llm(provider: str):
    from livekit.plugins import openai

    if provider == "primary":
        if not is_primary_llm_configured():
            return None
        return openai.LLM(
            model=LLM_MODEL,
            base_url=LLM_BASE_URL,
            api_key=LLM_API_KEY,
            extra_body=parse_llm_extra_body(),
        )
    if provider == "deepseek":
        if not is_fallback_llm_configured():
            return None
        return openai.LLM(
            model=DEEPSEEK_MODEL,
            base_url=DEEPSEEK_BASE_URL,
            api_key=DEEPSEEK_API_KEY,
        )
    return None
