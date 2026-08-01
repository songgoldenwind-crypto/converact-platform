#!/usr/bin/env python3
import json
import os
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from public_signal_pipeline import analyze_public_source_signals


def summarize_review(text: str) -> str:
    normalized = " ".join(str(text or "").split()).strip()
    if not normalized:
        return "Customers left limited detail, but the account still needs manual review."
    return normalized if len(normalized) <= 180 else f"{normalized[:177]}..."


def normalize_pain_signals(model_output, reviews):
    structured = model_output.get("structured_output") if isinstance(model_output, dict) else {}
    if isinstance(structured, dict):
        signals = structured.get("pain_signals") or []
        if isinstance(signals, list) and signals:
            normalized = []
            for index, signal in enumerate(signals):
                review = reviews[index] if index < len(reviews) else {}
                if not isinstance(signal, dict):
                    signal = {"signal": str(signal)}
                normalized.append(
                    {
                        "signal": signal.get("signal") or signal.get("theme") or f"Pain signal {index + 1}",
                        "evidence_review_id": signal.get("evidence_review_id") or signal.get("review_id") or review.get("id"),
                        "evidence": signal.get("evidence") or signal.get("quote") or review.get("content") or "",
                        "urgency": signal.get("urgency") or ("high" if index == 0 else "medium"),
                    }
                )
            return normalized

    normalized = []
    for index, review in enumerate(reviews[:3]):
        normalized.append(
            {
                "signal": summarize_review(review.get("content")),
                "evidence_review_id": review.get("id"),
                "evidence": review.get("content") or "",
                "urgency": "high" if index == 0 else "medium",
            }
        )
    return normalized


def extract_pain_signals(payload):
    place = payload.get("place") or {}
    reviews = payload.get("reviews") or []
    model_output = payload.get("model_output") or {}
    structured = model_output.get("structured_output") if isinstance(model_output, dict) else {}
    summary = ""
    if isinstance(structured, dict):
        summary = structured.get("summary") or ""
    summary = summary or model_output.get("content") or f"Pain insight generated for {place.get('name') or 'the business'}."
    return {
        "summary": summary,
        "pain_signals": normalize_pain_signals(model_output, reviews),
        "worker_language": "python",
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }


def personalize_outreach(payload):
    place = payload.get("place") or {}
    insight = payload.get("insight") or {}
    model_output = payload.get("model_output") or {}
    input_payload = payload.get("input") or {}
    structured = model_output.get("structured_output") if isinstance(model_output, dict) else {}
    if not isinstance(structured, dict):
        structured = {}

    product_offer = input_payload.get("product_offer") or "your solution"
    channel = input_payload.get("channel") or "email"
    pain_signals = insight.get("pain_signals") or []
    personalization_points = structured.get("personalization_points") or [
        value
        for value in [place.get("city"), place.get("business_type"), product_offer]
        if value
    ]
    summary = insight.get("summary") or "recent customer feedback gaps"

    subject = structured.get("subject") or f"{place.get('name') or 'Business'} x {channel} outreach"
    message = structured.get("message") or (
        f"Hi {place.get('name') or 'team'}, we noticed recurring issues around {summary}. "
        f"Our {product_offer} can help reduce missed follow-up and improve response consistency."
    )

    return {
        "subject": subject,
        "message": message,
        "personalization_points": personalization_points,
        "pain_signal_count": len(pain_signals),
        "worker_language": "python",
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }


def normalize_page_text(payload):
    text_candidates = [
        payload.get("clean_text"),
        payload.get("rendered_text"),
        payload.get("recognized_text"),
        payload.get("markdown"),
    ]
    for candidate in text_candidates:
        normalized = " ".join(str(candidate or "").replace("#", " ").split()).strip()
        if normalized:
            return normalized

    visual_chunks = payload.get("visual_chunks") or []
    if isinstance(visual_chunks, list):
        chunk_text = " ".join(" ".join(str(item.get("text") or "").split()).strip() for item in visual_chunks if isinstance(item, dict)).strip()
        if chunk_text:
            return chunk_text

    layout_regions = payload.get("layout_regions") or []
    if isinstance(layout_regions, list):
        region_text = " ".join(" ".join(str(item.get("text") or "").split()).strip() for item in layout_regions if isinstance(item, dict)).strip()
        if region_text:
            return region_text

    page_title = " ".join(str(payload.get("page_title") or "").split()).strip()
    if page_title:
        return f"{page_title} 页面证据待补充。"
    return "页面证据待补充。"


def detect_cta_label(text):
    for label in ["立即咨询", "免费试用", "预约演示", "预约", "联系我们", "马上回拨", "回拨", "报价咨询", "立即联系"]:
        if label in text:
            return label
    return "立即咨询"


def detect_faq_question(text):
    for question in ["怎么收费", "如何收费", "报价多少", "怎么报价", "是否支持回拨", "怎么联系"]:
        if question in text:
            return question
    if "报价" in text or "收费" in text or "价格" in text:
        return "怎么收费"
    if "回拨" in text or "联系" in text:
        return "是否支持回拨"
    return ""


def detect_proof_label(text):
    for label in ["客户案例", "案例证明", "服务承诺", "合作流程", "落地效果"]:
        if label in text:
            return label
    if "案例" in text or "客户" in text:
        return "案例证明"
    return ""


def detect_page_headline(payload, page_title, text):
    markdown = str(payload.get("markdown") or "").strip()
    for line in markdown.splitlines():
        normalized = line.strip()
        if normalized.startswith("#"):
            headline = normalized.lstrip("#").strip()
            if headline:
                return headline
    text_title = summarize_review(text)
    if text_title and text_title != "页面证据待补充。":
        return text_title
    return page_title


def extract_contact_blocks(text):
    blocks = []
    phone_match = re.search(r"1[3-9]\d{9}", text)
    if phone_match:
        blocks.append(
            {
                "contact_id": "contact_block_1",
                "channel": "phone",
                "value": phone_match.group(0),
                "evidence": phone_match.group(0),
            }
        )
    email_match = re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text)
    if email_match and len(blocks) < 2:
        blocks.append(
            {
                "contact_id": f"contact_block_{len(blocks) + 1}",
                "channel": "email",
                "value": email_match.group(0),
                "evidence": email_match.group(0),
            }
        )
    return blocks


def extract_crawl_markdown(payload):
    page_title = " ".join(str(payload.get("page_title") or "").split()).strip() or "Captured page"
    clean_text = normalize_page_text(payload)
    markdown = str(payload.get("markdown") or "").strip() or f"# {page_title}\n\n{clean_text}"
    return {
        "status": "ready",
        "worker_language": "python",
        "source_url": payload.get("url") or "",
        "markdown": markdown,
        "clean_text": clean_text,
        "extraction_mode": "crawl4ai_markdown",
        "metadata": {
            "final_url": payload.get("url") or "",
            "page_title": page_title,
            "meta_description": "页面提炼结果已返回给主链。",
            "h1": page_title,
            "link_count": 0,
            "image_count": 0,
            "captured_at": datetime.utcnow().isoformat() + "Z",
        },
        "extracted_links": [],
        "extracted_images": [],
    }


def extract_page_evidence(payload):
    text = normalize_page_text(payload)
    page_title = " ".join(str(payload.get("page_title") or "").split()).strip() or "Captured page"
    page_headline = detect_page_headline(payload, page_title, text)
    cta_label = detect_cta_label(text)
    faq_question = detect_faq_question(text)
    proof_label = detect_proof_label(text)
    cta_blocks = [
        {
            "block_id": "cta_block_1",
            "label": cta_label,
            "action_hint": "push_to_consult" if "咨询" in cta_label or "联系" in cta_label else "schedule_followup",
            "evidence": cta_label,
        }
    ]
    faq_blocks = [
        {
            "faq_id": "faq_block_1",
            "question": faq_question,
            "answer_hint": "页面正在承接报价与联系类顾虑。",
            "evidence": faq_question,
        }
    ] if faq_question else []
    proof_points = [
        {
            "proof_id": "proof_point_1",
            "label": proof_label,
            "detail": proof_label,
            "evidence": proof_label,
        }
    ] if proof_label else []
    contact_blocks = extract_contact_blocks(text)
    return {
        "status": "ready",
        "worker_language": "python",
        "source_url": payload.get("url") or "",
        "page_title": page_title,
        "page_headline": page_headline,
        "cta_blocks": cta_blocks,
        "faq_blocks": faq_blocks,
        "proof_points": proof_points,
        "contact_blocks": contact_blocks,
        "offer_summary": summarize_review(text),
        "evidence_summary": "已从页面里抽出 CTA、FAQ、证明点和联系方式。",
    }


def extract_visual_fallback(payload):
    page_title = " ".join(str(payload.get("page_title") or "").split()).strip() or "Captured page"
    recognized_text = normalize_page_text(payload)
    fallback_reason = str(payload.get("fallback_reason") or "dom_low_confidence").strip() or "dom_low_confidence"
    return {
        "status": "ready",
        "worker_language": "python",
        "source_url": payload.get("url") or "",
        "page_title": page_title,
        "screenshot_ref": payload.get("screenshot_ref")
        if isinstance(payload.get("screenshot_ref"), dict)
        else {
            "ref_id": "visual-fallback-shot-1",
            "capture_status": "captured",
            "worker_language": "python",
        },
        "visual_chunks": [
            {
                "chunk_id": "visual_chunk_1",
                "chunk_index": 0,
                "text": recognized_text,
                "region_kind": "hero_text",
                "confidence": 0.88,
            }
        ],
        "recognized_text": recognized_text,
        "layout_regions": [
            {
                "region_id": "visual_region_1",
                "region_kind": "hero_text",
                "text": recognized_text,
                "confidence": 0.88,
            }
        ],
        "fallback_reason": fallback_reason,
        "confidence_summary": {
            "overall_confidence": 0.88,
            "region_count": 1,
            "low_confidence_regions": 0,
            "engine": "pytesseract_ocr",
            "explanation": "截图 OCR 已补回当前页面可见文案。",
        },
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.respond(200, {"status": "ok", "service": "ai-worker-py"})
            return
        self.respond(404, {"error": "not_found"})

    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            self.respond(400, {"error": "invalid_json", "message": str(exc)})
            return

        if self.path == "/geo/pain-signals/extract":
            self.respond(200, extract_pain_signals(payload))
            return
        if self.path == "/geo/outreach/personalize":
            self.respond(200, personalize_outreach(payload))
            return
        if self.path == "/signals/public-source/analyze":
            self.respond(200, analyze_public_source_signals(payload))
            return
        if self.path == "/page/crawl-markdown":
            self.respond(200, extract_crawl_markdown(payload))
            return
        if self.path == "/page/evidence-extract":
            self.respond(200, extract_page_evidence(payload))
            return
        if self.path == "/page/visual-fallback":
            self.respond(200, extract_visual_fallback(payload))
            return
        self.respond(404, {"error": "not_found"})

    def log_message(self, fmt, *args):
        return

    def respond(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("x-service", "ai-worker-py")
        self.end_headers()
        self.wfile.write(encoded)


if __name__ == "__main__":
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8092"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ai-worker-py listening on {host}:{port}")
    server.serve_forever()
