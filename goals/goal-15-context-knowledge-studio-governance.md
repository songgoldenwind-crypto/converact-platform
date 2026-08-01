# Goal 15 — Context、Knowledge、Playbook、Eval 与治理

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G15` |
| 初始状态 | `not_run` |
| 前置 Goal | G12 `speech_runtime_core_completed`；G13、G14 `completed` |
| 解锁 | 仅在 Resolve Offer 纳入 Agent/Knowledge/B2/B3 时为 G16 提供对应资格 |
| Authority | Converact Context/Knowledge/AgentRelease/Evaluation；Evidence 仍归 Evidence Catalog |
| 主要来源 | [平台 R2 §4、§8–§10](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 §13–§14、W6–W7](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

建立 Profile 无关、可追溯、可遗忘、可评测、可发布和可回滚的 AI-native
Context/Knowledge/Playbook/AgentRelease 基础，使模型与框架可替换而产品行为仍可解释。
Memory 是带 provenance、scope、
consent、retention、confidence 和 supersede 的 Proposal/record，不是框架聊天记录；
Playbook 必须由 Evidence 和 Outcome 支撑并经审核发布。

只建设支撑已售 Profile/Offer 的最小治理界面，不先做通用低代码 AI Studio。B2 来源化
Copilot 和 B3 限定 OCR 是 Resolve Profile 的 Optional，只有在独立质量/ROI Gate 且至少
两家转正客户购买时才进入 Resolve V1。

## 3. Required outcomes

1. 实现 immutable ContextRevision：input refs、policy、release、retrieval result、redaction、
   consent、region、digest 和 clock uncertainty；不复制全数据库快照。
2. 实现 MemoryProposal→review/policy→MemoryRecord，支持 subject/tenant/engagement/profile/task scope、
   provenance、confidence、expiry、retention、legal hold、supersede、delete/tombstone。
3. 实现 Knowledge source ingest、chunk/claim/provenance、ACL/tenant/region、version、citation、
   freshness、revocation、poisoning detection 和 retrieval Evidence。
4. 实现 PlaybookCandidate→Eval→Review→Published/Rejected/Retired；从成功案例提取时保持
   source Evidence/Outcome，不将 correlation 冒充因果。
5. 实现 immutable AgentRelease：prompt/policy/model route/tool capabilities/knowledge/
   speech/vision/eval digests；online mutable config 不得改变已运行 generation 的身份。
6. 建立 offline/online eval：golden set、adversarial/noise/locale、safety、grounding、
   action policy、handoff、latency、cost、non-regression 与 statistical confidence。
7. 实现 shadow→canary→progressive rollout→rollback；stale release output fenced，rollback
   不重放 action；完整 audit/approval。
8. 建立 red-team：prompt/tool injection、data exfiltration、cross-tenant retrieval、poisoned
   Evidence、PII/secret leakage、unsafe advice、hallucinated citation 和 approval bypass。
9. Resolve Profile 的 B2 只输出给专家的来源化建议，默认 A1；B3 只对冻结设备画面/字段
   做 OCR，结果作为 EvidenceProposal，低置信人工确认；其他 Profile 不自动继承其资格。
10. 建立质量/成本/Outcome 反馈，防止用模型评分取代客户结果；failure 可旁路，Human
    Communication 与 Engagement Core 不依赖 Studio。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-15/`：

- `context-knowledge-governance-design.md`
- `context-revision-contract-v1.json` 与 schema
- `memory-and-retention-contract-v1.json` 与 schema
- `knowledge-provenance-contract-v1.json` 与 schema
- `playbook-lifecycle-v1.json` 与 schema
- `agent-release-and-eval-contract-v1.json` 与 schema
- `shadow-canary-rollback-runbook.md`
- `b2-copilot-b3-ocr-qualification.md`
- `red-team-threat-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-15-context-governance-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit existing AI-native/memory/knowledge/studio code;过时设计可删除候选，但先 trace。
2. 先写 provenance/ACL/retention/delete、immutable release、citation、poisoning、rollback、
   stale output 和 cross-tenant failure tests。
3. 实现 ContextRevision/Memory/Knowledge minimum deep modules。
4. 实现 Playbook/Eval/Release registry 与 fake shadow/canary。
5. 接真实 Speech/Agent/Action Evidence；只为已售 Profile 能力建立 release。
6. 在 Resolve Profile 内分别 Gate B2 Copilot 与 B3 OCR；失败只关闭对应 Optional，不影响
   Resolve Pilot A/B1 或其他 Profile。
7. 执行 red-team、rollback drill、long-run cost/quality 和独立治理审查。

## 6. Acceptance gates

- 每个 Context/Memory/Knowledge/Playbook/Output 都可追溯到版本化 source/policy/release。
- delete/retention/legal hold/region/ACL/cross-tenant 行为正确且可恢复审计。
- citation 指向真实 Evidence；撤销/过期/污染 source 不继续被检索为权威。
- AgentRelease immutable；shadow 无副作用，canary 有明确 cohort，rollback 可重复且不重放
  Action。
- eval 同时覆盖质量、安全、grounding、latency、cost、handoff 和业务 non-regression。
- red-team 高风险项关闭；Prompt/Evidence/Log 不泄露密钥或跨租户内容。
- Resolve B2/B3 各自有至少两家转正客户购买与独立 Gate 才 production eligible；否则保持
  optional/not_run，且状态不得外推到其他 Profile。
- Knowledge/Studio/AI 故障不影响 Human Communication、Evidence truth 或 Action Ledger。

## 7. Explicit non-goals

- 不做通用低代码 Studio、多 Agent 市场、自治 Prompt 自发布。
- 不把框架 memory、向量库或搜索索引当业务 Authority。
- 不自动把成功对话变成生产 Playbook。
- 不因 Resolve B2/B3 失败阻塞已通过的 Pilot A/B1、横向治理内核或其他 Profile。
- 不永久保存原始音视频或完整 Prompt，除非单独 consent/retention policy。

## 8. Completion and commit boundary

按 Context/Memory、Knowledge/Playbook、Eval/Release、B2、B3、red-team/rollback Evidence
分窄提交。B2/B3 可分别 `not_run/blocked_external`；G15 的基础治理完成状态不得冒充这些
Optional 已售或 production eligible。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-15-context-knowledge-studio-governance.md`
using its manifest SHA-256 after the G12 speech runtime core gate and G13-G14.
Obey PROGRAM-RULES.md.

Build provenance-aware immutable ContextRevision, scoped Memory, ACL/retention
Knowledge, Evidence-backed Playbook lifecycle, immutable AgentRelease, eval,
shadow/canary/rollback and red-team governance. Keep framework memory and
indexes non-authoritative; enforce tenant/region/consent/deletion/legal-hold,
citations, poisoning protection and stale-release fencing. Build only the
minimal governance UI for sold Profile capabilities. Resolve B2 sourced
Copilot and B3 bounded OCR require separate quality/ROI gates and purchase by
at least two converted customers; either may remain not_run without harming
the horizontal core, Pilot A/B1 or other Profiles. Prove rollback and AI
failure isolation; do not create a generic low-code studio or touch production.
```
