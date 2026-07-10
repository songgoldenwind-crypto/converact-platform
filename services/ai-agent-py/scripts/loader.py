from __future__ import annotations

import json
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent / "data"


class Script:
    def __init__(self, data: dict) -> None:
        self.system_prompt = data["system_prompt"]
        self.greeting = data["greeting"]
        self.transfer_message = data.get("transfer_message", "正在为您转接专人客服，请稍候...")
        self.end_message = data.get("end_message", "感谢您的时间，再见！")


def load_script(script_id: str, language: str) -> Script:
    path = SCRIPTS_DIR / f"{script_id}_{language}.json"
    if not path.exists():
        fallback = SCRIPTS_DIR / f"default_{language}.json"
        path = fallback if fallback.exists() else SCRIPTS_DIR / "default_zh.json"
    return Script(json.loads(path.read_text(encoding="utf-8")))
