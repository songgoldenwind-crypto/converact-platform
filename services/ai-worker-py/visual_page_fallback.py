from __future__ import annotations

import base64
import html
import os
import re
from datetime import datetime
from typing import Any
from urllib.request import Request, urlopen

try:
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    Image = None

try:
    import pytesseract  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    pytesseract = None


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _normalize_text(value: Any) -> str:
    return re.sub(r"[ \t\f\v]+", " ", html.unescape(str(value or ""))).strip()


def _normalize_multiline(value: Any) -> str:
    text = str(value or "").replace("\r", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def _strip_tags(value: Any) -> str:
    text = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", " ", str(value or ""), flags=re.I | re.S)
    text = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<noscript\b[^<]*(?:(?!</noscript>)<[^<]*)*</noscript>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<svg\b[^<]*(?:(?!</svg>)<[^<]*)*</svg>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|section|article|li|h1|h2|h3|h4|h5|h6|button|a|span)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return _normalize_multiline(text)


def _extract_regions_from_html(raw_html: str, page_title: str) -> list[dict[str, Any]]:
    rules = [
        ("heading", r"<h1[^>]*>([\s\S]*?)</h1>"),
        ("subheading", r"<h2[^>]*>([\s\S]*?)</h2>"),
        ("cta", r"<button[^>]*>([\s\S]*?)</button>"),
        ("cta", r"<a\b[^>]*>([\s\S]*?)</a>"),
        ("body", r"<p[^>]*>([\s\S]*?)</p>"),
        ("list", r"<li[^>]*>([\s\S]*?)</li>"),
    ]
    regions: list[dict[str, Any]] = []
    seen: set[str] = set()
    for region_kind, pattern in rules:
        for match in re.finditer(pattern, raw_html, flags=re.I):
            text = _normalize_text(_strip_tags(match.group(1)))
            if len(text) < 4:
                continue
            dedupe_key = f"{region_kind}:{text}"
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            regions.append(
                {
                    "region_id": f"layout_region_{len(regions) + 1}",
                    "region_kind": region_kind,
                    "text": text,
                    "confidence": 0.82 if region_kind in {"heading", "cta"} else 0.72,
                    "bounding_box": None,
                    "source": "html_layout",
                }
            )
            if len(regions) >= 12:
                return regions
    if not regions and page_title:
        regions.append(
            {
                "region_id": "layout_region_1",
                "region_kind": "page_title",
                "text": _normalize_text(page_title),
                "confidence": 0.6,
                "bounding_box": None,
                "source": "html_layout",
            }
        )
    return regions


def _extract_regions_from_text(rendered_text: str) -> list[dict[str, Any]]:
    if not rendered_text:
        return []
    lines = [line for line in _normalize_multiline(rendered_text).split("\n") if len(line) >= 4]
    regions: list[dict[str, Any]] = []
    for index, line in enumerate(lines[:8]):
        region_kind = "body"
        if index == 0 and len(line) <= 60:
            region_kind = "heading"
        regions.append(
            {
                "region_id": f"text_region_{index + 1}",
                "region_kind": region_kind,
                "text": line,
                "confidence": 0.58 if region_kind == "heading" else 0.52,
                "bounding_box": None,
                "source": "visible_text_fallback",
            }
        )
    return regions


def _decode_base64_blob(value: str) -> bytes:
    encoded = str(value or "").strip()
    if not encoded:
        return b""
    if encoded.startswith("data:"):
        encoded = encoded.split(",", 1)[1] if "," in encoded else ""
    return base64.b64decode(encoded, validate=False)


def _load_screenshot_bytes(screenshot_ref: dict[str, Any] | None) -> bytes:
    if not isinstance(screenshot_ref, dict):
        return b""
    for field in ("image_base64", "base64", "data_url"):
        value = str(screenshot_ref.get(field) or "").strip()
        if value:
            try:
                return _decode_base64_blob(value)
            except Exception:
                continue
    file_path = str(
        screenshot_ref.get("local_path")
        or screenshot_ref.get("path")
        or screenshot_ref.get("file_path")
        or ""
    ).strip()
    if file_path and os.path.exists(file_path):
        try:
            with open(file_path, "rb") as handle:
                return handle.read()
        except Exception:
            return b""
    remote_url = str(
        screenshot_ref.get("url")
        or screenshot_ref.get("href")
        or screenshot_ref.get("file_url")
        or ""
    ).strip()
    if remote_url.startswith(("http://", "https://")):
        try:
            request = Request(remote_url, headers={"User-Agent": "Converact AI Worker/1.0"})
            with urlopen(request, timeout=5) as response:
                return response.read()
        except Exception:
            return b""
    return b""


def _extract_ocr_regions(screenshot_ref: dict[str, Any] | None) -> tuple[list[dict[str, Any]], str, str]:
    if Image is None or pytesseract is None:
        return [], "", "html_layout_fallback"
    image_bytes = _load_screenshot_bytes(screenshot_ref)
    if not image_bytes:
        return [], "", "html_layout_fallback"
    try:
        from io import BytesIO

        image = Image.open(BytesIO(image_bytes))
        raw = pytesseract.image_to_data(image, output_type=pytesseract.Output.DICT)
    except Exception:
        return [], "", "html_layout_fallback"
    items: list[dict[str, Any]] = []
    line_map: dict[tuple[int, int, int], dict[str, Any]] = {}
    for index in range(len(raw.get("text", []))):
        text = _normalize_text(raw["text"][index])
        if not text:
            continue
        confidence = float(raw.get("conf", ["0"])[index] or 0)
        if confidence < 20:
            continue
        key = (
            int(raw.get("block_num", [0])[index] or 0),
            int(raw.get("par_num", [0])[index] or 0),
            int(raw.get("line_num", [0])[index] or 0),
        )
        line = line_map.get(key)
        if not line:
            line = {
                "region_id": f"ocr_region_{len(line_map) + 1}",
                "region_kind": "ocr_line",
                "text_parts": [],
                "confidence_values": [],
                "bounding_box": {
                    "x": int(raw.get("left", [0])[index] or 0),
                    "y": int(raw.get("top", [0])[index] or 0),
                    "width": int(raw.get("width", [0])[index] or 0),
                    "height": int(raw.get("height", [0])[index] or 0),
                },
                "source": "ocr",
            }
            line_map[key] = line
        line["text_parts"].append(text)
        line["confidence_values"].append(confidence)
        box = line["bounding_box"]
        box["x"] = min(box["x"], int(raw.get("left", [0])[index] or 0))
        box["y"] = min(box["y"], int(raw.get("top", [0])[index] or 0))
        box["width"] = max(box["width"], int(raw.get("left", [0])[index] or 0) + int(raw.get("width", [0])[index] or 0) - box["x"])
        box["height"] = max(box["height"], int(raw.get("top", [0])[index] or 0) + int(raw.get("height", [0])[index] or 0) - box["y"])
    for line in list(line_map.values())[:12]:
        text = _normalize_text(" ".join(line.pop("text_parts", [])))
        if not text:
            continue
        confidence_values = line.pop("confidence_values", [])
        items.append(
            {
                **line,
                "text": text,
                "confidence": round(sum(confidence_values) / len(confidence_values) / 100.0, 2) if confidence_values else 0.0,
            }
        )
    recognized_text = _normalize_multiline("\n".join(item["text"] for item in items))
    return items, recognized_text, "pytesseract_ocr"


def _merge_regions(primary: list[dict[str, Any]], secondary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[str] = set()
    for region in [*primary, *secondary]:
        text = _normalize_text(region.get("text"))
        if not text:
            continue
        key = f"{region.get('region_kind', 'region')}::{text}"
        if key in seen:
            continue
        seen.add(key)
        merged.append(
            {
                "region_id": str(region.get("region_id") or f"region_{len(merged) + 1}"),
                "region_kind": str(region.get("region_kind") or "region"),
                "text": text,
                "confidence": round(float(region.get("confidence") or 0), 2),
                "bounding_box": region.get("bounding_box"),
                "source": str(region.get("source") or "layout"),
            }
        )
        if len(merged) >= 12:
            break
    return merged


def _build_visual_chunks(layout_regions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    for index, region in enumerate(layout_regions[:8]):
        text = _normalize_text(region.get("text"))
        if not text:
            continue
        chunks.append(
            {
                "chunk_id": f"visual_chunk_{index + 1}",
                "chunk_index": index,
                "text": text,
                "region_kind": str(region.get("region_kind") or "region"),
                "confidence": round(float(region.get("confidence") or 0), 2),
                "source": str(region.get("source") or "layout"),
            }
        )
    return chunks


def extract_visual_page_fallback(payload: dict[str, Any]) -> dict[str, Any]:
    source_url = str(payload.get("url") or payload.get("source_url") or "").strip()
    screenshot_ref = payload.get("screenshot_ref") if isinstance(payload.get("screenshot_ref"), dict) else {}
    rendered_html = str(payload.get("rendered_html") or "")
    rendered_text = _normalize_multiline(
        payload.get("rendered_text")
        or payload.get("clean_text")
        or payload.get("recognized_text")
        or ""
    )
    crawl_markdown = _normalize_multiline(payload.get("markdown") or "")
    page_title = _normalize_text(payload.get("page_title") or payload.get("title") or source_url)
    fallback_reason = _normalize_text(payload.get("fallback_reason") or "dom_low_confidence")
    if not source_url and not screenshot_ref:
        return {
            "status": "invalid_input",
            "source_url": "",
            "page_title": "",
            "screenshot_ref": screenshot_ref,
            "visual_chunks": [],
            "recognized_text": "",
            "layout_regions": [],
            "fallback_reason": fallback_reason,
            "confidence_summary": {
                "overall_confidence": 0,
                "region_count": 0,
                "low_confidence_regions": 0,
                "engine": "invalid_input",
                "explanation": "需要 source_url 或 screenshot_ref 才能生成可见页面 fallback。",
            },
            "worker_language": "python",
            "generated_at": _now_iso(),
            "error": "source_url or screenshot_ref is required",
        }

    ocr_regions, ocr_text, engine = _extract_ocr_regions(screenshot_ref)
    layout_regions = _extract_regions_from_html(rendered_html, page_title)
    if not layout_regions:
        layout_regions = _extract_regions_from_text(rendered_text or crawl_markdown or page_title)
    merged_regions = _merge_regions(ocr_regions, layout_regions)
    visual_chunks = _build_visual_chunks(merged_regions)
    recognized_text = _normalize_multiline(
        ocr_text
        or "\n".join(chunk.get("text", "") for chunk in visual_chunks)
        or rendered_text
        or crawl_markdown
        or page_title
    )
    overall_confidence = round(
        sum(float(region.get("confidence") or 0) for region in merged_regions) / len(merged_regions),
        2,
    ) if merged_regions else 0
    low_confidence_regions = sum(1 for region in merged_regions if float(region.get("confidence") or 0) < 0.5)
    return {
        "status": "ready" if (recognized_text or visual_chunks or merged_regions) else "empty",
        "source_url": source_url,
        "page_title": page_title,
        "screenshot_ref": screenshot_ref,
        "visual_chunks": visual_chunks,
        "recognized_text": recognized_text,
        "layout_regions": merged_regions,
        "fallback_reason": fallback_reason,
        "confidence_summary": {
            "overall_confidence": overall_confidence,
            "region_count": len(merged_regions),
            "low_confidence_regions": low_confidence_regions,
            "engine": engine,
            "explanation": "优先走截图 OCR；如果当前没有可读截图，就退回页面布局块和可见文本做可解释 fallback。",
        },
        "worker_language": "python",
        "generated_at": _now_iso(),
    }
