from __future__ import annotations

import html
import re
from datetime import datetime
from typing import Any


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _normalize_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def _normalize_multiline(value: Any) -> str:
    text = str(value or "").replace("\r", "")
    text = re.sub(r"\n{3,}", "\n\n", text)
    lines = [_normalize_text(line) for line in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def _strip_tags(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"<script\b[^<]*(?:(?!</script>)<[^<]*)*</script>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<style\b[^<]*(?:(?!</style>)<[^<]*)*</style>", " ", text, flags=re.I | re.S)
    text = re.sub(r"<br\s*/?>", "\n", text, flags=re.I)
    text = re.sub(r"</(p|div|section|article|li|h1|h2|h3|h4|h5|h6|button|a|span)>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return _normalize_multiline(text)


def _unique(items: list[str], limit: int = 8) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        normalized = _normalize_text(item)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        result.append(normalized)
        if len(result) >= limit:
            break
    return result


def _collect_text_blocks(payload: dict[str, Any]) -> list[str]:
    visual_packet = payload.get("visual_page_fallback_packet") if isinstance(payload.get("visual_page_fallback_packet"), dict) else {}
    visual_chunks = visual_packet.get("visual_chunks") if isinstance(visual_packet, dict) else []
    blocks: list[str] = [
        payload.get("rendered_text") or "",
        payload.get("clean_text") or "",
        payload.get("markdown") or "",
        visual_packet.get("recognized_text") if isinstance(visual_packet, dict) else "",
    ]
    if isinstance(visual_chunks, list):
        blocks.extend(chunk.get("text") for chunk in visual_chunks if isinstance(chunk, dict))
    return _unique([_normalize_multiline(_strip_tags(block)) for block in blocks if block], 10)


def _extract_markdown_heading(markdown: str) -> str:
    match = re.search(r"^\s*#\s+(.+)$", str(markdown or ""), flags=re.M)
    return _normalize_text(match.group(1) if match else "")


def _extract_first_line(text_blocks: list[str]) -> str:
    for block in text_blocks:
        for line in block.split("\n"):
            normalized = _normalize_text(line)
            if 4 <= len(normalized) <= 80:
                return normalized
    return ""


def _extract_headline(payload: dict[str, Any], text_blocks: list[str]) -> str:
    rendered_page = payload.get("rendered_page_read_packet") if isinstance(payload.get("rendered_page_read_packet"), dict) else {}
    crawl_packet = payload.get("crawl_markdown_packet") if isinstance(payload.get("crawl_markdown_packet"), dict) else {}
    visual_packet = payload.get("visual_page_fallback_packet") if isinstance(payload.get("visual_page_fallback_packet"), dict) else {}
    candidates = [
        rendered_page.get("page_meta", {}).get("h1") if isinstance(rendered_page.get("page_meta"), dict) else "",
        crawl_packet.get("metadata", {}).get("h1") if isinstance(crawl_packet.get("metadata"), dict) else "",
        _extract_markdown_heading(payload.get("markdown") or ""),
        _normalize_text(payload.get("page_title") or ""),
    ]
    if isinstance(visual_packet.get("visual_chunks"), list):
        for chunk in visual_packet.get("visual_chunks"):
            if not isinstance(chunk, dict):
                continue
            region_kind = _normalize_text(chunk.get("region_kind"))
            if region_kind in {"hero_text", "heading", "title"}:
                candidates.append(chunk.get("text") or "")
    candidates.append(_extract_first_line(text_blocks))
    for candidate in candidates:
        normalized = _normalize_text(candidate)
        if normalized and len(normalized) <= 120:
            return normalized
    return ""


def _extract_html_ctas(rendered_html: str) -> list[str]:
    matches: list[str] = []
    for match in re.finditer(r"<(?:a|button)\b[^>]*>([\s\S]*?)</(?:a|button)>", str(rendered_html or ""), flags=re.I):
        text = _normalize_text(_strip_tags(match.group(1)))
        if text:
            matches.append(text)
    return matches


def _extract_cta_blocks(payload: dict[str, Any], text_blocks: list[str]) -> list[dict[str, Any]]:
    cta_pattern = re.compile(r"(立即咨询顾问|立即咨询|领取报价|获取报价|立即预约|预约试听|电话咨询|马上联系|免费试用|免费诊断|获取方案|联系顾问|加微信|立即沟通)")
    candidates = _unique(
        _extract_html_ctas(payload.get("rendered_html") or "")
        + [match.group(1) for block in text_blocks for match in cta_pattern.finditer(block)],
        5,
    )
    blocks: list[dict[str, Any]] = []
    for index, label in enumerate(candidates):
        action_hint = "push_to_consult"
        if re.search(r"报价|方案", label):
            action_hint = "push_to_quote"
        elif re.search(r"预约|试听", label):
            action_hint = "push_to_booking"
        elif re.search(r"试用|诊断", label):
            action_hint = "push_to_trial"
        blocks.append(
            {
                "block_id": f"cta_block_{index + 1}",
                "label": label,
                "action_hint": action_hint,
                "evidence": label,
            }
        )
    return blocks


def _extract_faq_blocks(text_blocks: list[str]) -> list[dict[str, Any]]:
    faq_pattern = re.compile(r"(多少钱|怎么收费|靠谱吗|多久|要准备什么|怎么选|适合谁|有什么区别|如何开始|是否支持|能不能[^，。；;\n]{0,12})")
    matches = _unique([match.group(1) for block in text_blocks for match in faq_pattern.finditer(block)], 4)
    return [
        {
            "faq_id": f"faq_block_{index + 1}",
            "question": question,
            "answer_hint": "页面里已经在围绕这个顾虑做承接，后续开口可先接这句疑问。",
            "evidence": question,
        }
        for index, question in enumerate(matches)
    ]


def _extract_proof_points(text_blocks: list[str]) -> list[dict[str, Any]]:
    proof_keywords = [
        ("案例证明", r"案例|成功案例|客户案例"),
        ("口碑评价", r"评价|口碑|好评|真实反馈"),
        ("资质背书", r"资质|认证|许可证|官方"),
        ("经验积累", r"\d+\s*年|多年经验|长期服务"),
        ("客户规模", r"\d+\s*家|\d+\s*位客户|\d+\+"),
    ]
    points: list[dict[str, Any]] = []
    seen: set[str] = set()
    for label, pattern in proof_keywords:
        evidence = ""
        for block in text_blocks:
            match = re.search(pattern, block)
            if match:
                evidence = _normalize_text(match.group(0))
                break
        if not evidence or evidence in seen:
            continue
        seen.add(evidence)
        points.append(
            {
                "proof_id": f"proof_point_{len(points) + 1}",
                "label": label,
                "detail": evidence,
                "evidence": evidence,
            }
        )
        if len(points) >= 4:
            break
    return points


def _extract_contact_blocks(rendered_html: str, text_blocks: list[str]) -> list[dict[str, Any]]:
    combined_text = "\n".join(text_blocks + [_strip_tags(rendered_html)])
    blocks: list[dict[str, Any]] = []
    phone_match = re.search(r"((?:\+?86[-\s]?)?1[3-9]\d{9}|0\d{2,3}[-\s]?\d{7,8})", combined_text)
    email_match = re.search(r"([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})", combined_text)
    wechat_match = re.search(r"(?:微信|wechat|vx)(?:号)?[:：]?\s*([A-Za-z0-9_-]{5,24})", combined_text, flags=re.I)
    if phone_match:
        blocks.append({"contact_id": "contact_block_1", "channel": "phone", "value": _normalize_text(phone_match.group(1)), "evidence": phone_match.group(1)})
    if email_match:
        blocks.append({"contact_id": f"contact_block_{len(blocks) + 1}", "channel": "email", "value": _normalize_text(email_match.group(1)), "evidence": email_match.group(1)})
    if wechat_match:
        blocks.append({"contact_id": f"contact_block_{len(blocks) + 1}", "channel": "wechat", "value": _normalize_text(wechat_match.group(1)), "evidence": wechat_match.group(1)})
    return blocks[:4]


def extract_page_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    text_blocks = _collect_text_blocks(payload)
    page_title = _normalize_text(payload.get("page_title") or payload.get("rendered_page_read_packet", {}).get("page_title") or payload.get("crawl_markdown_packet", {}).get("metadata", {}).get("page_title") or "")
    rendered_html = str(payload.get("rendered_html") or payload.get("rendered_page_read_packet", {}).get("rendered_html") or "")
    headline = _extract_headline(payload, text_blocks)
    cta_blocks = _extract_cta_blocks(payload, text_blocks)
    faq_blocks = _extract_faq_blocks(text_blocks)
    proof_points = _extract_proof_points(text_blocks)
    contact_blocks = _extract_contact_blocks(rendered_html, text_blocks)
    offer_summary = _normalize_text(
        payload.get("offer_summary")
        or (
            f"这页主打「{headline}」"
            + (f"，优先把访客推进到「{cta_blocks[0]['label']}」" if cta_blocks else "")
            + (f"，并用「{proof_points[0]['detail']}」做证明" if proof_points else "")
        )
    )
    evidence_summary = _normalize_text(
        payload.get("evidence_summary")
        or f"已从页面里抽出 {len(cta_blocks)} 个 CTA、{len(faq_blocks)} 个 FAQ、{len(proof_points)} 条证明点和 {len(contact_blocks)} 个联系方式。"
    )
    status = "ready" if any([headline, cta_blocks, faq_blocks, proof_points, contact_blocks, offer_summary]) else "empty"
    return {
        "status": status,
        "source_url": _normalize_text(payload.get("url") or payload.get("source_url") or ""),
        "page_title": page_title,
        "page_headline": headline or page_title,
        "cta_blocks": cta_blocks,
        "faq_blocks": faq_blocks,
        "proof_points": proof_points,
        "contact_blocks": contact_blocks,
        "offer_summary": offer_summary,
        "evidence_summary": evidence_summary,
        "worker_language": "python",
        "generated_at": _now_iso(),
    }
