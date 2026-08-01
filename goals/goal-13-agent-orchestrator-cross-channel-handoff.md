# Goal 13 — AI-native Orchestrator 与跨渠道接管

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G13` |
| 初始状态 | `not_run` |
| 前置 Goal | G09、G10 `completed`；G12 `speech_runtime_core_completed` |
| 解锁 | G14、G15；仅在 Resolve Offer 纳入 Agent 能力时为 G16 提供资格 |
| Authority | Converact Agent Runtime；框架只执行有界 AgentRun |
| 主要来源 | [平台 R2 §4、§8–§10](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[通信 R5 S3](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md)、[Resolve Profile R1 §10.3–§11](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

建立渠道和 Profile 无关的 AI-native Orchestrator：其永久状态属于 EngagementRef/ProfileBindingRef/
Task/ContextRevision/AgentRelease/Policy/ActionProposal/Handoff/Evaluation，Pi、Nanobot、LiveKit Agents、Active Call 或
未来框架只作为 `InteractiveKernelAdapter`、`RealtimeChannelAdapter`、
`SpecialistExecutorAdapter`、`LongGoalStepAdapter` 执行有界 AgentRun。

SpeechRuntime 继续独立；框架不能形成第二套 SIP、Room、媒体、Agent、Memory、Cron、Queue、
Action Ledger 或业务 Authority。跨 SIP/LiveKit/文本的人机接管使用稳定 Engagement/Task/Interaction 和
generation-scoped ResponseLease/OutputLease，迟到输出 fail closed。

## 3. Required outcomes

1. 实现 Task/WorkItem/AgentRun/RunEnvelope/ContextRevision/AgentRelease/ModelRoute/
   ToolCapability/Policy/AutonomyLevel/Checkpoint 与 HandoffProposal contracts。
2. RunEnvelope 固定 tenant/engagement/profile/task/interaction、release/context/tool digests、deadline、
   token/cost/fanout budget、cancel、region、consent 和 trace。
3. AgentRun 只允许返回 Response、Action、Handoff、Evidence、Memory、TaskDecomposition
   Proposal；Authority 验证后才生效。
4. 实现 ResponseLease 管理单次 runtime response generation；对外输出仍必须同时满足 G10
   OutputLease。stale context/release/response/output generation 全部被 fence。
5. 实现 Pi/Nanobot/LiveKit Agents/Active Call capability inventory 与 bounded adapters；
   local memory/session/cron/queue 不成为企业状态。
6. 实现 Customer Agent、Copilot、Profile Specialist、Supervisor、Knowledge Agent 的独立
   policy/permission；Resolution Agent 只是首个 Profile Specialist，不存在全工具超级 Agent。
7. 实现 human↔AI、AI↔AI specialist、SIP↔LiveKit↔text 的 prepare/commit/abort/query/
   reconcile handoff；一个 stable Engagement/Task/Interaction，旧 generation 不重放 output/action。
8. 实现 A0–A4 自治等级按 release/task/tenant/channel/customer/tool 联合决定；A5 只在隔离研究。
9. Agent 只拿短期 scoped capability，不持 RustPBX、LiveKit、DB 或第三方管理凭据。
10. 实现 bounded concurrency/queue/retry/fanout、budget exhaustion、cancellation、framework
    crash/timeout、model/provider failover 与 human fallback。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-13/`：

- `ai-native-orchestrator-design.md`
- `agent-run-envelope-v1.json` 与 schema
- `task-context-release-contract-v1.json` 与 schema
- `response-lease-contract-v1.json` 与 schema
- `framework-adapter-capability-v1.json` 与 schema
- `cross-channel-handoff-contract-v1.json` 与 schema
- `autonomy-and-capability-policy.md`
- `threat-failure-and-complexity-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-13-orchestrator-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit current Agent/Active/Pi/Nanobot/LiveKit code after G00 and G12 parity decisions。
2. 先写 run budget、lease exclusivity、stale context/output、proposal-only、capability expiry、
   cancel/timeout 和 handoff race 的失败/property tests。
3. 实现 framework-neutral domain/orchestrator 和 fake bounded adapter。
4. 逐个接入需要保留的框架能力；每个 adapter 可独立启停/回滚。
5. 实现 SIP/LiveKit/text 与 human/AI handoff，接 G10 OutputLease 与 G12 Speech events。
6. 注入 provider/framework crash、partition、late output、budget exhaustion、unknown action；
   验证 Human Communication 与 Engagement 读取/人工处置继续。
7. 完成长会话 generation rotation、容量、安全和独立审查。

## 6. Acceptance gates

- 删除任一 Agent framework 不改变 Engagement/Profile/Task/Action/Context/Release 的持久语义。
- 框架不能直接写业务状态或发外部副作用；Proposal schema/policy/tenant/dedup fail closed。
- 每个 response/output scope 只有有效 generation；迟到文本/TTS/DataStream 被丢弃并计数。
- handoff 中 stable Engagement/Task/Interaction 不变，旧 owner 不重发 Unknown action 或重复答复。
- framework local memory/cron/queue 清空后可从 Converact checkpoint 恢复。
- A0–A4 权限、预算、deadline、cancel、short-lived capability 和审计可验证。
- framework/model/Speech 故障不终止 Human Communication 或 Engagement 人工主链；AI Endpoint
  场景使用明确降级。
- bounded queue/fanout/cost、30m/2h/8h rotation 和跨渠道 recovery 有 Evidence。

## 7. Explicit non-goals

- 不把 HF SpeechRuntime 变成 Agent Orchestrator。
- 不把 LiveKit Agents、Pi、Nanobot 或 Active Call 整体设为平台 Authority。
- 不创建全租户、全工具、全渠道超级 Agent。
- 不在本 Goal 自动执行外部 Action；只产生 Proposal，G14 执行。
- 不以聊天演示替代 crash、handoff、lease、cost 和恢复 Evidence。

## 8. Completion and commit boundary

按 domain/contracts、framework adapters、handoff、failure/capacity Evidence 分窄提交。所有
框架必须可替换、可旁路；没有 parity/evidence 的能力保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-13-agent-orchestrator-cross-channel-handoff.md`
using its manifest SHA-256 after G09/G10 and the G12 speech runtime core gate.
Obey PROGRAM-RULES.md.

Build the profile-neutral AI-native Orchestrator around durable Engagement,
ProfileBinding, Task, AgentRun, RunEnvelope, ContextRevision, AgentRelease, policy, budgets,
ResponseLease and structured Handoff. Pi, Nanobot, LiveKit Agents, Active Call
and future frameworks remain bounded replaceable adapters; their local memory,
cron, queue and sessions never become authority. Support human/AI and
SIP/LiveKit/text handoff with stable Engagement/Task/Interaction, scoped OutputLease,
stale-generation fencing and proposal-only outputs. Prove cancellation,
budgets, short-lived credentials, crash/provider failure, long-generation
rotation and human fallback. Do not execute external actions yet or touch
production. Anything unproved remains not_run.
```
