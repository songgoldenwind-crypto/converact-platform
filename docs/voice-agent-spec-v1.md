# VoiceAgentSpec v1

> **Revision 5 边界（2026-07-31）**：本文件仍是 Voice Agent 配置结构参考；
> `ai-agent-py` 不再被视为终态跨渠道 Runtime。Channel Agent、HF
> `SpeechRuntime`、OPC AI-native Orchestrator 与 ResponseLease 以
> [Revision 5 总设计](./design/unified-communication-foundation-r5.md) 和
> [ADR-CCAAS-9](./adr/ccaas-9-channel-agent-and-speech-runtime.md) 为准。
>
> 语音 Agent 的可版本化描述。Agent 工厂（阶段 2）生成此结构；当前运行时
> `ai-agent-py` 与 Dialer 消费此结构。

## 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | string | ✅ | 全局唯一，如 `default-outbound-zh` |
| `tenant_id` | string | ✅ | 租户 ID；内置模板可为空 |
| `language` | `zh` \| `en` \| `ja` | ✅ | 决定 STT/TTS/话术语言 |
| `goal` | string | ✅ | 业务目标（供生成器与审计） |
| `status` | `draft` \| `published` | ✅ | 仅 `published` 可用于外呼 |
| `version` | number | ✅ | 递增版本号 |
| `tools` | string[] | ✅ | 启用的 tool 名 |
| `runtime.system_prompt` | string | ✅ | Agent instructions |
| `runtime.greeting` | string | ✅ | 开场白 |
| `runtime.transfer_message` | string | | 转人工话术 |
| `runtime.end_message` | string | | 结束话术 |
| `compliance.ai_disclosure` | string | | 合规披露文案 |
| `compliance.forbidden_topics` | string[] | | 禁止话题 |
| `nodes` | object[] | | 阶段 3 对话图；v1 可为 `[]` |

## 与 outbound_task 的关系

```json
{
  "strategy": {
    "language": "zh",
    "agent_spec_id": "default-outbound-zh"
  }
}
```

`agent_spec_id` 优先于 `script_id`。Dialer 将 spec id、language、tools 写入 LiveKit room metadata。

## API

| Method | Path | 说明 |
|--------|------|------|
| GET | `/api/voice-agents/specs/:id` | 获取 Spec（含内置模板） |
| GET | `/api/voice-agents/specs?tenant_id=` | 列出租户 Spec |
| POST | `/api/voice-agents/specs` | 创建 Spec |
| POST | `/api/voice-agents/generate` | 自然语言生成 Spec（draft） |
| POST | `/api/voice-agents/import-ivr` | IVR 菜单树 → Spec（含 nodes） |
| POST | `/api/voice-agents/specs/:id/publish?tenant_id=` | 发布 Spec |
| POST | `/api/call-center/calls/:id/navigate` | 通话中切换节点 |

内置模板：`default-outbound-zh`（见 `src/agent-runtime/call-center/data/default-outbound-zh.json`）。

### import-ivr

```json
POST /api/voice-agents/import-ivr
{
  "tenant_id": "t1",
  "name": "售后 IVR",
  "menus": [
    { "id": "root", "name": "主菜单", "prompt": "按1销售按2售后", "options": [
      { "key": "1", "label": "销售", "target": "sales" },
      { "key": "2", "label": "售后", "target": "support" }
    ]},
    { "id": "sales", "name": "销售", "prompt": "请描述需求", "action": "transfer_human" }
  ]
}
```

返回 draft Spec，`nodes[]` 含 `transitions`（`dtmf:*`、`keyword:*`、`intent_high`、`default`）。

### navigate（通话中）

```json
POST /api/call-center/calls/{call_session_id}/navigate
{
  "agent_spec_id": "spec-id",
  "trigger": "1",
  "customer_text": "我要售后"
}
```

`trigger` 可为 DTMF 键、`start`、`intent_high`、`default`。响应含 `current_node_id`、`message_for_agent`、`action_taken`、`reached_terminal`。会话 metadata 写入 `current_node_id`、`node_history`、`navigation_version`（乐观锁）。

`ai-agent-py` 启动时 `trigger=start` 初始化节点；`check_intent` 使用 LLM 打分（`intent_scorer.py`，阈值 0.7），失败时关键词降级；`recommendation=transfer` 时由 LLM 调 `navigate_flow(trigger=intent_high)`。`navigate_flow` 到达终端节点时自动 dispatch（`transfer_human` / `end_call`）。

## Mac 中文语音栈

见 [services/speech-host/README.md](../services/speech-host/README.md)。
