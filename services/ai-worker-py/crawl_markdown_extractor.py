from __future__ import annotations

import asyncio
import html
import re
from datetime import datetime
from typing import Any
from urllib.parse import urljoin
from urllib.request import Request, urlopen

try:
    from crawl4ai import AsyncWebCrawler  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    AsyncWebCrawler = None


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _normalize_text(value: str) -> str:
    return re.sub(r"[ \t\f\v]+", " ", html.unescape(str(value or ""))).strip()


def _normalize_multiline(value: str) -> str:
    text = str(value or "").replace("\r", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def _strip_tags(value: str) -> str:
    text = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", " ", str(value or ""), flags=re.I | re.S)
    text = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<noscript\b[^<]*(?:(?!</noscript>)<[^<]*)*</noscript>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<svg\b[^<]*(?:(?!</svg>)<[^<]*)*</svg>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|section|article|li|h1|h2|h3|h4|h5|h6)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return _normalize_multiline(text)


def _extract_title(raw_html: str) -> str:
    match = re.search(r"<title[^>]*>([\s\S]*?)</title>", raw_html, flags=re.I)
    return _normalize_text(match.group(1) if match else "")


def _extract_meta(raw_html: str, name: str) -> str:
    escaped = re.escape(name)
    patterns = [
        rf'<meta[^>]+name=["\']{escaped}["\'][^>]+content=["\']([^"\']*)["\'][^>]*>',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+name=["\']{escaped}["\'][^>]*>',
        rf'<meta[^>]+property=["\']{escaped}["\'][^>]+content=["\']([^"\']*)["\'][^>]*>',
        rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]+property=["\']{escaped}["\'][^>]*>',
    ]
    for pattern in patterns:
        match = re.search(pattern, raw_html, flags=re.I)
        if match:
            return _normalize_text(match.group(1))
    return ""


def _extract_canonical_url(raw_html: str, final_url: str) -> str:
    match = re.search(r'<link[^>]+rel=["\']canonical["\'][^>]+href=["\']([^"\']+)["\'][^>]*>', raw_html, flags=re.I)
    if not match:
        match = re.search(r'<link[^>]+href=["\']([^"\']+)["\'][^>]+rel=["\']canonical["\'][^>]*>', raw_html, flags=re.I)
    if not match:
        return ""
    return urljoin(final_url, match.group(1).strip())


def _extract_h1(raw_html: str) -> str:
    match = re.search(r"<h1[^>]*>([\s\S]*?)</h1>", raw_html, flags=re.I)
    return _normalize_text(_strip_tags(match.group(1) if match else ""))


def _extract_links(raw_html: str, final_url: str) -> list[dict[str, Any]]:
    results = []
    for match in re.finditer(r'<a\b[^>]*href=["\']([^"\']+)["\'][^>]*>([\s\S]*?)</a>', raw_html, flags=re.I):
        href = urljoin(final_url, match.group(1).strip())
        text = _normalize_text(_strip_tags(match.group(2)))
        if not href:
            continue
        results.append(
            {
                "url": href,
                "text": text,
            }
        )
        if len(results) >= 12:
            break
    return results


def _extract_images(raw_html: str, final_url: str) -> list[dict[str, Any]]:
    results = []
    for match in re.finditer(r'<img\b[^>]*src=["\']([^"\']+)["\'][^>]*>', raw_html, flags=re.I):
        tag = match.group(0)
        src = urljoin(final_url, match.group(1).strip())
        alt_match = re.search(r'alt=["\']([^"\']*)["\']', tag, flags=re.I)
        alt = _normalize_text(alt_match.group(1) if alt_match else "")
        if not src:
            continue
        results.append(
            {
                "src": src,
                "alt": alt,
            }
        )
        if len(results) >= 12:
            break
    return results


def _replace_anchor(match: re.Match[str], final_url: str) -> str:
    href = urljoin(final_url, match.group(1).strip())
    text = _normalize_text(_strip_tags(match.group(2)))
    return f"[{text}]({href})" if text else href


def _replace_image(match: re.Match[str], final_url: str) -> str:
    tag = match.group(0)
    src = urljoin(final_url, match.group(1).strip())
    alt_match = re.search(r'alt=["\']([^"\']*)["\']', tag, flags=re.I)
    alt = _normalize_text(alt_match.group(1) if alt_match else "")
    return f"![{alt}]({src})"


def _replace_heading(match: re.Match[str]) -> str:
    level = max(1, min(int(match.group(1) or "1"), 6))
    text = _normalize_text(_strip_tags(match.group(2)))
    return f"\n{'#' * level} {text}\n" if text else "\n"


def _replace_block(match: re.Match[str]) -> str:
    text = _normalize_text(_strip_tags(match.group(2)))
    if not text:
        return "\n"
    tag = match.group(1).lower()
    if tag == "li":
        return f"\n- {text}\n"
    return f"\n{text}\n"


def _build_markdown(raw_html: str, final_url: str) -> str:
    markdown = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", " ", raw_html, flags=re.I | re.S)
    markdown = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", " ", markdown, flags=re.I | re.S)
    markdown = re.sub(r"<noscript\b[^<]*(?:(?!</noscript>)<[^<]*)*</noscript>", " ", markdown, flags=re.I | re.S)
    markdown = re.sub(r"<svg\b[^<]*(?:(?!</svg>)<[^<]*)*</svg>", " ", markdown, flags=re.I | re.S)
    markdown = re.sub(
        r"<img\b[^>]*src=[\"']([^\"']+)[\"'][^>]*>",
        lambda match: _replace_image(match, final_url),
        markdown,
        flags=re.I,
    )
    markdown = re.sub(
        r"<a\b[^>]*href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</a>",
        lambda match: _replace_anchor(match, final_url),
        markdown,
        flags=re.I,
    )
    markdown = re.sub(r"<h([1-6])[^>]*>([\s\S]*?)</h\1>", _replace_heading, markdown, flags=re.I)
    markdown = re.sub(r"<(p|div|section|article|li)[^>]*>([\s\S]*?)</\1>", _replace_block, markdown, flags=re.I)
    markdown = re.sub(r"<br\s*/?>", "\n", markdown, flags=re.I)
    markdown = re.sub(r"<[^>]+>", " ", markdown)
    return _normalize_multiline(markdown)


def _fetch_html(url: str, timeout_ms: int = 7000) -> tuple[str, str]:
    request = Request(
        url,
        headers={
            "User-Agent": "Converact AI Worker/1.0",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urlopen(request, timeout=max(timeout_ms / 1000.0, 1)) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        raw_html = response.read().decode(charset, errors="replace")
        return raw_html, response.geturl()


def _extract_with_regex(url: str, timeout_ms: int = 7000) -> dict[str, Any]:
    raw_html, final_url = _fetch_html(url, timeout_ms=timeout_ms)
    page_title = _extract_title(raw_html) or final_url
    clean_text = _strip_tags(raw_html)
    extracted_links = _extract_links(raw_html, final_url)
    extracted_images = _extract_images(raw_html, final_url)
    metadata = {
        "final_url": final_url,
        "page_title": page_title,
        "meta_description": _extract_meta(raw_html, "description") or _extract_meta(raw_html, "og:description"),
        "h1": _extract_h1(raw_html),
        "canonical_url": _extract_canonical_url(raw_html, final_url),
        "text_length": len(clean_text),
        "link_count": len(extracted_links),
        "image_count": len(extracted_images),
        "captured_at": _now_iso(),
    }
    return {
        "status": "ready" if clean_text else "empty",
        "source_url": url,
        "markdown": _build_markdown(raw_html, final_url),
        "clean_text": clean_text,
        "extraction_mode": "html_clean_fallback",
        "metadata": metadata,
        "extracted_links": extracted_links,
        "extracted_images": extracted_images,
        "worker_language": "python",
        "generated_at": _now_iso(),
    }


def _extract_with_crawl4ai(url: str, timeout_ms: int = 7000) -> dict[str, Any] | None:
    if AsyncWebCrawler is None:
        return None

    async def _run() -> dict[str, Any]:
        async with AsyncWebCrawler(verbose=False) as crawler:  # type: ignore[misc]
            result = await crawler.arun(url=url, timeout=max(timeout_ms / 1000.0, 1))
            final_url = str(getattr(result, "url", "") or getattr(result, "final_url", "") or url)
            markdown = str(
                getattr(getattr(result, "markdown_v2", None), "raw_markdown", "")
                or getattr(result, "markdown", "")
                or ""
            )
            clean_text = _normalize_multiline(
                str(
                    getattr(getattr(result, "markdown_v2", None), "fit_markdown", "")
                    or getattr(result, "fit_markdown", "")
                    or getattr(result, "cleaned_text", "")
                    or ""
                )
            )
            metadata = getattr(result, "metadata", {}) or {}
            links = metadata.get("links") if isinstance(metadata, dict) else []
            images = metadata.get("images") if isinstance(metadata, dict) else []
            title = ""
            if isinstance(metadata, dict):
                title = _normalize_text(metadata.get("title") or metadata.get("page_title") or "")
            if not title:
                title = final_url
            extracted_links = []
            for item in links if isinstance(links, list) else []:
                if isinstance(item, dict):
                    href = str(item.get("href") or item.get("url") or "").strip()
                    if href:
                        extracted_links.append({"url": urljoin(final_url, href), "text": _normalize_text(item.get("text") or "")})
                if len(extracted_links) >= 12:
                    break
            extracted_images = []
            for item in images if isinstance(images, list) else []:
                if isinstance(item, dict):
                    src = str(item.get("src") or item.get("url") or "").strip()
                    if src:
                        extracted_images.append({"src": urljoin(final_url, src), "alt": _normalize_text(item.get("alt") or "")})
                if len(extracted_images) >= 12:
                    break
            normalized_metadata = {
                "final_url": final_url,
                "page_title": title,
                "meta_description": _normalize_text(metadata.get("description") or metadata.get("meta_description") or "") if isinstance(metadata, dict) else "",
                "h1": _normalize_text(metadata.get("h1") or "") if isinstance(metadata, dict) else "",
                "canonical_url": str(metadata.get("canonical_url") or metadata.get("canonical") or "").strip() if isinstance(metadata, dict) else "",
                "text_length": len(clean_text),
                "link_count": len(extracted_links),
                "image_count": len(extracted_images),
                "captured_at": _now_iso(),
            }
            return {
                "status": "ready" if (markdown or clean_text) else "empty",
                "source_url": url,
                "markdown": _normalize_multiline(markdown),
                "clean_text": clean_text or _normalize_multiline(markdown),
                "extraction_mode": "crawl4ai_markdown",
                "metadata": normalized_metadata,
                "extracted_links": extracted_links,
                "extracted_images": extracted_images,
                "worker_language": "python",
                "generated_at": _now_iso(),
            }

    try:
        return asyncio.run(_run())
    except Exception:
        return None


def extract_crawl_markdown(payload: dict[str, Any]) -> dict[str, Any]:
    source_url = str(payload.get("url") or payload.get("source_url") or "").strip()
    if not source_url:
        return {
            "status": "invalid_input",
            "source_url": "",
            "markdown": "",
            "clean_text": "",
            "extraction_mode": "invalid_input",
            "metadata": {},
            "extracted_links": [],
            "extracted_images": [],
            "worker_language": "python",
            "generated_at": _now_iso(),
            "error": "source_url is required",
        }

    timeout_ms = int(payload.get("timeout_ms") or payload.get("request_timeout_ms") or 7000)
    result = _extract_with_crawl4ai(source_url, timeout_ms=timeout_ms)
    if result:
        return result
    try:
        return _extract_with_regex(source_url, timeout_ms=timeout_ms)
    except Exception as exc:
        return {
            "status": "error",
            "source_url": source_url,
            "markdown": "",
            "clean_text": "",
            "extraction_mode": "html_clean_fallback",
            "metadata": {
                "captured_at": _now_iso(),
            },
            "extracted_links": [],
            "extracted_images": [],
            "worker_language": "python",
            "generated_at": _now_iso(),
            "error": str(exc),
        }
