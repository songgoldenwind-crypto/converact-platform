from __future__ import annotations

from dataclasses import dataclass, field

from converact_client import ConveractClient
from scripts.loader import Script, load_script


@dataclass
class VoiceAgentNode:
    id: str
    name: str
    prompt: str = ""
    transitions: dict[str, str] = field(default_factory=dict)


@dataclass
class VoiceAgentSpec:
    id: str
    language: str
    system_prompt: str
    greeting: str
    goal: str
    tools: list[str]
    transfer_message: str
    end_message: str
    nodes: list[VoiceAgentNode] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict) -> VoiceAgentSpec:
        runtime = data.get("runtime") or {}
        nodes = []
        for raw in data.get("nodes") or []:
            if not isinstance(raw, dict):
                continue
            nodes.append(
                VoiceAgentNode(
                    id=str(raw.get("id", "")),
                    name=str(raw.get("name", "")),
                    prompt=str(raw.get("prompt", "")),
                    transitions=dict(raw.get("transitions") or {}),
                )
            )
        return cls(
            id=str(data.get("id", "unknown")),
            language=str(data.get("language", "zh")),
            system_prompt=str(runtime.get("system_prompt") or data.get("system_prompt", "")),
            greeting=str(runtime.get("greeting") or data.get("greeting", "")),
            goal=str(data.get("goal", "")),
            tools=list(data.get("tools") or []),
            transfer_message=str(
                runtime.get("transfer_message") or data.get("transfer_message", "正在为您转接人工客服，请稍候。")
            ),
            end_message=str(runtime.get("end_message") or data.get("end_message", "感谢您的时间，再见。")),
            nodes=nodes,
        )

    def build_instructions(self, current_node_id: str | None = None) -> str:
        if not self.nodes:
            return self.system_prompt
        active = current_node_id or (self.nodes[0].id if self.nodes else "root")
        node = next((item for item in self.nodes if item.id == active), None)
        node_hint = f"\n\n当前节点：[{active}] {node.name if node else ''}\n{node.prompt if node else ''}"
        return self.system_prompt + node_hint

    def as_script(self) -> Script:
        return Script(
            {
                "system_prompt": self.system_prompt,
                "greeting": self.greeting,
                "transfer_message": self.transfer_message,
                "end_message": self.end_message,
            }
        )


async def resolve_agent_spec(
    *,
    converact: ConveractClient,
    agent_spec_id: str | None,
    script_id: str,
    language: str,
) -> tuple[Script, VoiceAgentSpec | None]:
    if agent_spec_id:
        spec = await fetch_voice_agent_spec(agent_spec_id, converact=converact)
        if spec:
            return spec.as_script(), spec
    return load_script(script_id, language), None


async def fetch_voice_agent_spec(spec_id: str, *, converact: ConveractClient) -> VoiceAgentSpec | None:
    data = await converact.get_voice_agent_spec(spec_id)
    if not data:
        return None
    return VoiceAgentSpec.from_dict(data)
