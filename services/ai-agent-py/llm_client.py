"""OpenAI-compatible LLM client with primary/fallback dual-stack."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

from config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MAX_TOKENS,
    DEEPSEEK_MODEL,
    DEEPSEEK_TIMEOUT_MS,
    LLM_API_KEY,
    LLM_BASE_URL,
    LLM_MAX_TOKENS,
    LLM_MODEL,
    LLM_TIMEOUT_MS,
    is_fallback_llm_configured,
    is_primary_llm_configured,
    parse_llm_extra_body,
)

logger = logging.getLogger("ai-agent.llm")

LlmTier = Literal["primary", "fallback"]

_llm_http: httpx.AsyncClient | None = None


@dataclass(frozen=True)
class LlmEndpointConfig:
    api_key: str
    base_url: str
    model: str
    max_tokens: int
    timeout_ms: int
    extra_body: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LlmCompletionResult:
    text: str
    llm_tier: LlmTier
    model: str
    warnings: list[str]


class LlmHttpError(Exception):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def read_primary_llm_config() -> LlmEndpointConfig | None:
    if not is_primary_llm_configured():
        return None
    return LlmEndpointConfig(
        api_key=LLM_API_KEY,
        base_url=LLM_BASE_URL.rstrip("/"),
        model=LLM_MODEL,
        max_tokens=LLM_MAX_TOKENS,
        timeout_ms=LLM_TIMEOUT_MS,
        extra_body=parse_llm_extra_body(),
    )


def read_fallback_llm_config() -> LlmEndpointConfig | None:
    if not is_fallback_llm_configured():
        return None
    return LlmEndpointConfig(
        api_key=DEEPSEEK_API_KEY,
        base_url=DEEPSEEK_BASE_URL.rstrip("/"),
        model=DEEPSEEK_MODEL,
        max_tokens=DEEPSEEK_MAX_TOKENS,
        timeout_ms=DEEPSEEK_TIMEOUT_MS,
        extra_body=parse_llm_extra_body(),
    )


def is_transport_error(status: int | None, exc: BaseException | None) -> bool:
    # 401/403 = misconfiguration — do not silent fallback
    if status is not None:
        if status in (401, 403):
            return False
        return status >= 500 or status == 429
    if exc is None:
        return False
    if isinstance(exc, httpx.TimeoutException):
        return True
    msg = str(exc).lower()
    return any(
        token in msg
        for token in ("timeout", "econnrefused", "connect error", "network", "abort")
    )


def extract_assistant_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices") or []
    message = (choices[0] if choices else {}).get("message") or {}
    content = message.get("content")
    if content and str(content).strip():
        return str(content).strip()
    reasoning = message.get("reasoning")
    if reasoning and str(reasoning).strip():
        logger.warning("assistant content empty but reasoning present — treat as bad response")
    raise ValueError("empty LLM assistant content")


def get_llm_http_client() -> httpx.AsyncClient:
    global _llm_http
    if _llm_http is None:
        _llm_http = httpx.AsyncClient()
    return _llm_http


async def _complete_once(
    config: LlmEndpointConfig,
    *,
    messages: list[dict[str, str]],
    **kwargs: Any,
) -> str:
    body: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "max_tokens": kwargs.pop("max_tokens", config.max_tokens),
        "stream": False,
        **config.extra_body,
    }
    if "temperature" in kwargs:
        body["temperature"] = kwargs.pop("temperature")
    body.update(kwargs)

    timeout_s = config.timeout_ms / 1000.0
    client = get_llm_http_client()
    try:
        response = await client.post(
            f"{config.base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.api_key}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=timeout_s,
        )
    except httpx.TimeoutException as exc:
        raise LlmHttpError(f"LLM API timeout after {config.timeout_ms}ms") from exc
    except httpx.HTTPError as exc:
        if is_transport_error(None, exc):
            raise LlmHttpError(str(exc)) from exc
        raise

    if not response.is_success:
        error_text = response.text
        err = LlmHttpError(
            f"LLM API error: {response.status_code} {response.reason_phrase} - {error_text}",
            status=response.status_code,
        )
        raise err

    return extract_assistant_text(response.json())


async def chat_completions_with_fallback(
    messages: list[dict[str, str]],
    **kwargs: Any,
) -> LlmCompletionResult:
    primary = read_primary_llm_config()
    fallback = read_fallback_llm_config()
    warnings: list[str] = []

    if primary is not None:
        try:
            text = await _complete_once(primary, messages=messages, **kwargs)
            return LlmCompletionResult(
                text=text,
                llm_tier="primary",
                model=primary.model,
                warnings=warnings,
            )
        except LlmHttpError as err:
            if not is_transport_error(err.status, err) or fallback is None:
                raise
            warning = f"Primary LLM ({primary.model}) unavailable: {err}"
            warnings.append(warning)
            logger.warning("primary failed, falling back: %s", warning)
        except httpx.HTTPError as err:
            if not is_transport_error(None, err) or fallback is None:
                raise
            warning = f"Primary LLM ({primary.model}) unavailable: {err}"
            warnings.append(warning)
            logger.warning("primary failed, falling back: %s", warning)

    if fallback is None:
        raise RuntimeError(
            "No LLM available: set LLM_API_KEY+LLM_BASE_URL and/or DEEPSEEK_API_KEY"
        )

    text = await _complete_once(fallback, messages=messages, **kwargs)
    return LlmCompletionResult(
        text=text,
        llm_tier="fallback",
        model=fallback.model,
        warnings=warnings,
    )


async def aclose_llm_http() -> None:
    global _llm_http
    if _llm_http is not None:
        await _llm_http.aclose()
        _llm_http = None
