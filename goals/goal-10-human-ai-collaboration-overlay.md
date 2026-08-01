# Goal 10 — 人工/AI 协作、Workspace 与 Overlay 主链

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G10` |
| 初始状态 | `not_run` |
| 前置 Goal | Core：G09 `completed`；RustPBX↔LiveKit 音频桥 qualification：另需 G07 `completed` |
| 解锁 | G11、G12、G13 |
| Authority | Converact Interaction/Collaboration；Engagement 只做稳定绑定；外部平台输出只做 Projection |
| 主要来源 | [平台 R2 §4、§7、§9](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 §7.7、§8、§11](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md) |

## 2. Binding objective

实现不依赖 AI、Native RustPBX 或 100K 资格才能完成、与业务 Profile 解耦的人工
Engagement 协作主链：稳定 Interaction、CommunicationSession、Participant、Profile-aware
Workspace、电话保持、免 App additive video、结构化 Evidence 与 Handoff。Resolve 是首个 tracer，但通用 Collaboration 不得把
所有 Interaction 强制解释为故障处理。
在此基础上冻结 Converact-generated 输出的范围化 `OutputLease`，为后续 AI 接管、字幕、翻译和
Copilot 提供 generation fencing；对外部 PBX/CCaaS 的人工、提示音或 Bot 只维护
`ExternalOutputProjection`，未经 mute/floor/hold 能力资格不得声称全局 fence。

## 3. Required outcomes

1. 实现 EngagementRef、ProfileBindingRef、Interaction、CommunicationSession、Participant、
   OwnershipLease、SessionRef 和 Timeline；一个 Session 只属于一个 Interaction，一个
   Interaction 在同一时刻绑定一个 Engagement。
2. 实现 Profile-aware Workspace shell：身份/业务对象、当前渠道、参与者、Evidence、步骤、
   Task、风险、Consent、质量、成本、Handoff 和外部投影；Profile 插槽提供售后/未来业务
   字段，不复制 CRM 全功能，也不建立行业 Fork。
3. 实现 Overlay additive video 流程：外部电话保持原音频，发送一次性免 App 链接，授权后
   加入 LiveKit video/screen；失败时电话继续，RustPBX 不处理 Room video track，也不是
   此路径的前置。
4. 实现 `OutputLeaseKey(interaction,audience,channel,modality,semantic_scope)`、versioned
   scope registry、audience membership generation、TTL、owner generation 和 fence token。
5. 支持 `AI_ACTIVE/HUMAN_ACTIVE/JOINT_ASSIST_HUMAN_OUTPUT/SYSTEM_HOLD`；字幕与翻译只能
   作为来源语义派生，不得夹带业务答复。
6. 实现 `ExternalOutputProjection` 的 source revision/staleness；只有 Adapter capability
   通过时才允许 mute/floor/hold promise，否则客户侧 AI TTS fail closed。
7. 实现结构化 HandoffArtifact：已验证身份/事实/Evidence、尝试、Receipt、未完成 Task、
   等待/SLA、风险、情绪、语言/媒体、建议来源和接管 generation。
8. 实现 human↔AI/team ownership prepare/commit/abort/query/reconcile；旧 owner 的迟到输出
   被 fence，Unknown action 不因接管重发。
9. 实现长会话 timeline、participant/reconnect、link expiry/renewal、browser background、
   Wi-Fi/cellular switch、recording/consent continuity 和 cleanup。
10. 证明 AI、Speech、Knowledge、Action、Evidence upload 不可用时人工主链仍可用。
11. 只有 Offer 选择 RustPBX↔LiveKit 音频互通/切换时，才在 G07 通过后增加对应 Channel
    Qualification；该结果与 Overlay additive-video core、普通 Room 和外部 PBX profile 分开。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-10/`：

- `collaboration-overlay-design.md`
- `interaction-session-contract-v1.json` 与 schema
- `output-lease-and-scope-registry-v1.json` 与 schema
- `external-output-projection-v1.json` 与 schema
- `handoff-artifact-v1.json` 与 schema
- `workspace-user-journey-and-accessibility.md`
- `additive-video-security-contract.md`
- `fault-threat-and-complexity-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-10-collaboration-overlay-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit current Collaboration/assignment/workspace/call/video code and retain user-owned changes。
2. 先写 Engagement/Interaction/session membership、Profile slot isolation、lease overlap、
   stale generation、external projection 和 additive-video rollback 的失败/property tests。
3. 实现 profile-neutral human-only Interaction/Workspace/Evidence flow，再加载 Resolution
   Profile tracer。
4. 先以外部电话 Projection + LiveKit Room 完成无 AI additive-video；若选择 RustPBX 音频桥，
   再接 G07 并形成独立 qualification。
5. 实现 OutputLease/Handoff/ownership 与 late output fencing。
6. 注入 Room/link/token/browser/network/DB/Event/AI/recording failure，运行长会话。
7. 完成真实用户旅程、accessibility、安全、质量和独立审查。

## 6. Acceptance gates

- Human-only 从电话到 additive video、Evidence、Handoff 的主链不调用 Speech/LLM。
- Room/video/link/AI 故障不终止电话；回退、状态和用户提示符合合同。
- 同一重叠 OutputLease scope 只有一个 owner；分区/过期时 Converact 输出 fail closed。
- 迟到 generation 不输出字幕/TTS/DataStream，不重复 Action 或 Handoff。
- 外部平台输出 capability unknown 时 UI 显示 stale/uncontrolled，不虚假承诺全局静音。
- Handoff 可由新 owner 仅凭结构化对象继续，不依赖自由文本摘要。
- Workspace shell 在至少两个 synthetic Profile fixture 下不混用字段、状态或权限；synthetic
  fixture 只证明 Profile 隔离，不是第二 Profile 的市场资格。
- tenant/participant/token/consent/recording 权限隔离，链接一次性且可撤销。
- short/30m/2h/8h、background/reconnect/network switch 和 cleanup 有 Evidence。
- RustPBX↔LiveKit 音频桥未通过 G07 时保持 `not_run`，不影响 Overlay additive-video core；
  bridge Evidence 也不能冒充外部 Provider/Room profile 资格。

## 7. Explicit non-goals

- 不实现完整 Agent reasoning、HF Speech、自动 Action 或通用低代码 Workspace builder。
- 不同时实现多个可销售 Profile；第二个 synthetic fixture 只验证平台边界。
- 不替换客户 PBX/CCaaS/CRM/FSM、LiveKit Room/SFU。
- 不让 AI 成为人工通话依赖。
- 不默认给 Overlay 外部输出加 fence。
- 不修改 LED 代码；Converact contract 与客户适配点单独记录。

## 8. Completion and commit boundary

按 contracts、human-only tracer、additive video、OutputLease/Handoff、long-run Evidence 分窄
提交。任何未证明能力保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-10-human-ai-collaboration-overlay.md`
using its manifest SHA-256 after G09. Obey PROGRAM-RULES.md. G07 is required
only for the separately qualified RustPBX-to-LiveKit audio bridge option.

Build the profile-neutral human-first Engagement-bound
Interaction/CommunicationSession, expert workspace shell, structured
Evidence/Handoff and additive-video Overlay flow. Use Resolve as the first
tracer without making Resolution the platform root. Preserve external
PSTN/SIP audio while LiveKit owns Room video, and prove optional video/AI failures do
not break the call. Add scoped OutputLease with audience/channel/modality/
semantic-scope generations and fence stale Converact outputs; represent external
PBX/CCaaS human/bot output only as a possibly stale projection unless adapter
mute/floor/hold capability is proven. Use TDD, real short/30m/2h/8h journeys,
security and cleanup evidence. Do not modify LED or depend on AI for the human
main path. Keep any RustPBX audio bridge behind its G07 gate; unproved items
remain not_run.
```
