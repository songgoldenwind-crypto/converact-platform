from __future__ import annotations

import re
from datetime import datetime


def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _truncate(value: str, limit: int = 160) -> str:
    text = " ".join(str(value or "").split()).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3] + "..."


def _source_label(kind: str) -> str:
    return {
        "map": "地图/本地商户",
        "directory": "公开名录",
        "social": "社媒/问答",
        "owned_list": "旧咨询/转介绍",
        "public_web": "公开网页",
    }.get(kind or "", "公开来源")


_SIGNAL_RULES = [
    {
        "key": "pricing_intent",
        "label": "主动询价/比价",
        "angle": "先确认对方是在比价格、看方案，还是只想先拿一个报价框架。",
        "pattern": re.compile(r"报价|价格|收费|询价"),
    },
    {
        "key": "booking_intent",
        "label": "愿意预约/试听",
        "angle": "先确认是否愿意预约下一次沟通、试听或到店，不要一上来讲完整方案。",
        "pattern": re.compile(r"预约|试听|到店|上门"),
    },
    {
        "key": "callback_window",
        "label": "可回拨窗口",
        "angle": "先确认方便回拨的时间窗口，再安排下一步，不要重复硬打。",
        "pattern": re.compile(r"回拨|稍后|晚点|方便的时候"),
    },
    {
        "key": "new_business",
        "label": "刚注册/新开业",
        "angle": "围绕刚注册/新开业的当下问题开口，优先讲启动期最急的事项。",
        "pattern": re.compile(r"刚注册|新开|新成立"),
    },
    {
        "key": "solution_research",
        "label": "正在比较方案",
        "angle": "先问清楚正在比较什么方案，再切入差异化价值，不先堆功能。",
        "pattern": re.compile(r"方案|咨询|比较|了解"),
    },
    {
        "key": "cooperation_intent",
        "label": "合作/采购意向",
        "angle": "先确认合作推进节奏、决策人和本轮最想解决的点。",
        "pattern": re.compile(r"合作|采购|需求|对接"),
    },
]


def _detect_need_signals(text: str) -> list[dict]:
    normalized = str(text or "")
    return [
        {
            "key": rule["key"],
            "label": rule["label"],
            "angle": rule["angle"],
        }
        for rule in _SIGNAL_RULES
        if rule["pattern"].search(normalized)
    ]


def _normalize_item(candidate: dict, index: int) -> dict:
    content = " ".join(
        str(part).strip()
        for part in [
            candidate.get("message"),
            candidate.get("source_evidence"),
            candidate.get("source_label"),
        ]
        if str(part or "").strip()
    ).strip()
    return {
        "id": str(candidate.get("candidate_id") or f"signal_item_{index + 1}"),
        "title": str(candidate.get("company_name") or candidate.get("contact_name") or candidate.get("source_task_title") or f"Public signal {index + 1}"),
        "company_name": str(candidate.get("company_name") or ""),
        "contact_name": str(candidate.get("contact_name") or ""),
        "content": content,
        "source_kind": str(candidate.get("source_kind") or ""),
        "source_label": str(candidate.get("source_label") or _source_label(str(candidate.get("source_kind") or ""))),
        "source_url": str(candidate.get("source_url") or ""),
        "source_evidence": str(candidate.get("source_evidence") or ""),
        "source_task_id": str(candidate.get("source_task_id") or ""),
        "source_task_title": str(candidate.get("source_task_title") or ""),
        "import_ready": candidate.get("import_ready") is True,
        "contact_ready": bool(candidate.get("contact_phone") or candidate.get("contact_email") or candidate.get("contact_name")),
        "missing": [str(item) for item in candidate.get("missing") or []],
    }


def _dedupe_items(items: list[dict]) -> list[dict]:
    deduped = []
    seen = set()
    for item in items:
        key = str(item.get("source_url") or f"{item.get('company_name', '')}|{item.get('source_evidence', '')}|{item.get('content', '')}").lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(item)
    return deduped


def _score_item(item: dict) -> dict:
    reasons = []
    score = 2
    if item.get("contact_ready"):
        score += 2
        reasons.append("has_contact")
    else:
        score -= 1
    if item.get("source_evidence") or item.get("source_url"):
        score += 2
        reasons.append("source_traceable")
    else:
        score -= 1
    need_signals = _detect_need_signals(str(item.get("content") or ""))
    if need_signals:
        score += 3
        reasons.append(need_signals[0]["label"])
    if item.get("import_ready"):
        score += 1
        reasons.append("import_ready")
    normalized = max(0, min(10, score))
    return {
        **item,
        "score": normalized,
        "score_reasons": reasons,
    }


def _enrich_item(item: dict) -> dict:
    need_signals = _detect_need_signals(str(item.get("content") or ""))
    primary = need_signals[0] if need_signals else None
    return {
        **item,
        "need_signals": [signal["key"] for signal in need_signals],
        "need_signal_labels": [signal["label"] for signal in need_signals],
        "message_angle": primary["angle"] if primary else "",
        "summary": _truncate(item.get("content") or item.get("source_evidence") or item.get("title") or ""),
    }


def _aggregate_need_signals(items: list[dict]) -> list[dict]:
    buckets: dict[str, dict] = {}
    for item in items:
        matches = _detect_need_signals(str(item.get("content") or ""))
        for match in matches:
            existing = buckets.get(match["key"]) or {
                "key": match["key"],
                "label": match["label"],
                "angle": match["angle"],
                "matched_count": 0,
                "examples": [],
                "evidence": "",
                "source_kinds": [],
            }
            existing["matched_count"] += 1
            if not existing["evidence"]:
                existing["evidence"] = _truncate(item.get("content") or item.get("source_evidence") or "", 140)
            if len(existing["examples"]) < 3 and item.get("company_name"):
                existing["examples"].append(item["company_name"])
            source_kind = str(item.get("source_kind") or "")
            if source_kind and source_kind not in existing["source_kinds"]:
                existing["source_kinds"].append(source_kind)
            buckets[match["key"]] = existing
    return list(buckets.values())[:8]


def _aggregate_message_angles(need_signals: list[dict]) -> list[dict]:
    return [
        {
            "key": signal["key"],
            "label": signal["label"],
            "angle": signal["angle"],
            "supporting_evidence": signal.get("evidence") or "",
        }
        for signal in need_signals[:6]
    ]


def _aggregate_sources(items: list[dict]) -> list[dict]:
    buckets: dict[str, dict] = {}
    for item in items:
        key = str(item.get("source_kind") or "public_web")
        existing = buckets.get(key) or {
            "source_kind": key,
            "source_label": str(item.get("source_label") or _source_label(key)),
            "filtered_count": 0,
            "evidence": str(item.get("source_evidence") or ""),
            "signals": [],
        }
        existing["filtered_count"] += 1
        if not existing["evidence"] and item.get("source_evidence"):
            existing["evidence"] = str(item["source_evidence"])
        for label in item.get("need_signal_labels") or []:
            if label not in existing["signals"]:
                existing["signals"].append(label)
        buckets[key] = existing
    ranked = sorted(buckets.values(), key=lambda item: item["filtered_count"], reverse=True)[:4]
    for source in ranked:
        source["reason"] = (
            f"This source has {source['filtered_count']} high-signal items."
            if source["filtered_count"] > 1
            else "This source currently has the strongest high-signal item."
        )
    return ranked


def _keyword_seeds(payload: dict, preferred_sources: list[dict], need_signals: list[dict]) -> list[str]:
    location = str(payload.get("location") or "").strip()
    industry = str(payload.get("industry") or "").strip()
    keywords: list[str] = []

    def add(value: str) -> None:
        normalized = value.strip()
        if normalized and normalized not in keywords:
            keywords.append(normalized)

    for signal in need_signals:
        label = str(signal.get("label") or "")
        if "询价" in label or "比价" in label:
            add(f"{location} {industry} 报价 咨询".strip())
        if "预约" in label or "试听" in label:
            add(f"{location} {industry} 预约 咨询".strip())
        if "回拨" in label:
            add(f"{location} {industry} 回拨 咨询".strip())
        if "刚注册" in label or "新开业" in label:
            add(f"{location} 新注册 公司".strip())

    for source in preferred_sources:
        kind = str(source.get("source_kind") or "")
        if kind == "map":
            add(f"{location} {industry} 地图 商户".strip())
        elif kind == "directory":
            add(f"{location} {industry} 企业 名录".strip())
        elif kind == "social":
            add(f"{location} {industry} 问答 讨论".strip())

    if not keywords:
        add(f"{location} {industry} 客户 咨询".strip())
    return keywords[:8]


def analyze_public_source_signals(payload: dict) -> dict:
    candidates = payload.get("candidates") or []
    raw_items = [_normalize_item(candidate, index) for index, candidate in enumerate(candidates[:12])]
    deduped_items = _dedupe_items(raw_items)
    scored_items = [_score_item(item) for item in deduped_items]
    threshold = 6
    filtered_items = [item for item in scored_items if float(item.get("score") or 0) >= threshold]
    enriched_items = [_enrich_item(item) for item in filtered_items]
    need_signals = _aggregate_need_signals(enriched_items)
    message_angles = _aggregate_message_angles(need_signals)
    preferred_sources = _aggregate_sources(enriched_items)
    quality_gate = []
    if need_signals:
        quality_gate.append(f"Prioritize leads that clearly mention {need_signals[0]['label']}.")
    if any(not item.get("contact_ready") for item in filtered_items):
        quality_gate.append("Do not import items without a direct contact channel.")
    if any(not (item.get("source_evidence") or item.get("source_url")) for item in filtered_items):
        quality_gate.append("Keep a source URL or evidence note for each imported result.")
    quality_gate.append("Keep the most concrete user wording for each need signal.")

    guidance_summary = (
        f"AI signal radar narrowed {len(raw_items)} public results down to {len(filtered_items)} high-signal candidates."
        if filtered_items
        else "Current public results still need stronger source evidence and clearer need signals."
        if raw_items
        else "No public source results are available for analysis yet."
    )

    return {
        "status": "ready",
        "generated_at": _now_iso(),
        "pipeline_version": "horizon-signal-v1",
        "worker_language": "python",
        "threshold": threshold,
        "counts": {
            "raw": len(raw_items),
            "deduped": len(deduped_items),
            "scored": len(scored_items),
            "filtered": len(filtered_items),
            "enriched": len(enriched_items),
        },
        "raw_items": raw_items,
        "deduped_items": deduped_items,
        "scored_items": scored_items,
        "filtered_items": filtered_items,
        "enriched_items": enriched_items,
        "signal_guidance": {
            "summary": guidance_summary,
            "preferred_sources": preferred_sources,
            "need_signals": need_signals,
            "message_angles": message_angles,
            "keyword_seeds": _keyword_seeds(payload, preferred_sources, need_signals),
            "quality_gate": quality_gate[:4],
            "next_action": (
                f"Prioritize {preferred_sources[0]['source_label']} for the next source pack."
                if preferred_sources
                else "Collect more traceable public results before importing the next batch."
            ),
        },
    }
