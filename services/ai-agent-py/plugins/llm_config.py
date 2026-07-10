from __future__ import annotations

from config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MODEL,
    is_fallback_llm_configured,
    is_primary_llm_configured,
    parse_llm_extra_body,
)


def get_llm():
    """Return LiveKit OpenAI-compatible LLM for voice sessions.

    Uses primary (27B) when LLM_API_KEY+LLM_BASE_URL are set; otherwise DeepSeek.
    ``extra_body`` is supported by livekit.plugins.openai.LLM (>=1.0) for
    provider-specific fields such as ``chat_template_kwargs.enable_thinking``.
    """
    if is_primary_llm_configured():
        api_key, base_url, model = LLM_API_KEY, LLM_BASE_URL, LLM_MODEL
    elif is_fallback_llm_configured():
        api_key, base_url, model = DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, DEEPSEEK_MODEL
    else:
        raise RuntimeError(
            "Set LLM_API_KEY+LLM_BASE_URL (primary) and/or DEEPSEEK_API_KEY (fallback)"
        )

    from livekit.plugins import openai

    return openai.LLM(
        model=model,
        base_url=base_url,
        api_key=api_key,
        extra_body=parse_llm_extra_body(),
    )
