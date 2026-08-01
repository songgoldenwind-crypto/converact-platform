from __future__ import annotations

from dataclasses import dataclass

from livekit.agents import JobContext
from converact_client import ConveractClient


@dataclass(frozen=True)
class ToolContext:
    converact: ConveractClient
    ctx: JobContext
    tenant_id: str
    call_session_id: str
    language: str
    agent_spec_id: str
    room_meta: dict
