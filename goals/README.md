# Converact Architecture Foundation — Goal 执行总表

本目录把平台 R2、通信 R5/R4 与首个 Resolve Profile R1 拆成 18 个可独立启动、按依赖
验收的 Goal。

目标不是“把功能列表平均切成 18 份”，而是让每个 Goal 都拥有明确 Authority、
前置条件、失败边界、Evidence 和完成 Gate。后一 Goal 不得用前一 Goal 的计划或厂商
宣传代替真实验收。

## 1. 启动规则

每次只启动一个 Goal：

1. 读取 [PROGRAM-RULES.md](./PROGRAM-RULES.md)；
2. 读取目标 Markdown 全文；
3. 在 [manifest.json](./manifest.json) 中核对文件 SHA-256、依赖和状态；
4. 检查 [amendments/](./amendments/) 是否有明确绑定该 Goal 的 additive amendment；如有，
   校验其 frozen inputs、运行 resolver/test，并把实际读取的 Goal bytes 交给该 amendment 的
   objective builder；builder 必须同时输出 base Goal 与 amendment 的 path/SHA-256；
5. 调用 `create_goal`，objective 使用 builder 完整输出；没有 amendment 时使用目标文件末尾的
   `create_goal summary`，不得手工遗漏适用条款或 binding identity；
6. 持续执行到全部 Gate 通过，或在完成所有离线工作后记录不可避免的外部阻塞；
7. 只有前置 Goal 达到文件规定的完成状态，才能启动下一 Goal。

创建这些文件不自动启动开发，也不改变服务器、容器或 Feature Flag。

当前 G10、G12、G13、G14、G15、G16 另受
[2026-08-09 AI Interaction/Speech/Action program amendment](./amendments/2026-08-09-ai-speech-action-program-amendment-v1.md)
约束。它保持 base Goal 和已冻结 manifest 不变，仅在未来启动对应 Goal 时追加
InteractionExecutionPolicy、SpeechModePolicy、ConversationPerception、HF overlap-only、
Disclosure/Consent、主动 Handoff、Human collaboration、MCP Tool Adapter、可信 Context、
跨层 Eval、商业 Outcome KPI 和 provider-exit/全成本条款。

## 2. 执行顺序

| 顺序 | Goal | 核心结果 | 启动条件 |
| --- | --- | --- | --- |
| 00 | [执行基线与全量追踪](./goal-00-execution-baseline-and-traceability.md) | 统一两个工作树、旧 Goal/R4/R5/R2/R1 的事实和执行根 | 无 |
| 01 | [平台、Profile 领域与首发商业 Gate](./goal-01-product-domain-commercial-gates.md) | Platform Contract + Resolve Profile/Pilot/ROI Market Gate | Goal 00 |
| 02 | [平台、安全与可观测基础](./goal-02-platform-foundation-security-observability.md) | Tenant/Identity/Consent/Event/Audit/Billing/DR 基础 | Goal 00、Goal 01 Contract gate |
| 03 | [SIP 与 Durable Call Foundation](./goal-03-sip-call-durable-foundation.md) | SipFoundation、Effect/Receipt、恢复与故障隔离 | Goal 00、02 |
| 04 | [强制 G.729 工程](./goal-04-g729-exact-source-codec.md) | 一个 `G729/8000` wire codec，A/AB/Annex B 完整 | Goal 03 |
| 05 | [RTPengine 与媒体 Authority](./goal-05-rtpengine-media-authority.md) | Atomic lifecycle、Fast Path、decoded-media seam | Goal 02–04 |
| 06 | [rvoip 选择性吸收](./goal-06-rvoip-selective-absorption.md) | Shadow、逐层替换、单一 SIP/媒体 Authority | Goal 03、05 |
| 07 | [Voice/SIP ↔ LiveKit 双向切换](./goal-07-voice-livekit-bidirectional-handoff.md) | Durable audio bridge、反复切换、录音/计费连续 | Goal 03、05；使用已完成 codec slice |
| 08 | [通信 VOS-EQ/100K 资格](./goal-08-communication-vos-eq-100k-qualification.md) | 长稳、故障、容量、主机性能和通信生产证据 | Goal 03–07 |
| 09 | [Engagement/Evidence/Outcome Core 与 Resolution Profile](./goal-09-resolution-evidence-outcome-core.md) | EngagementItem、Profile、Evidence、OutcomeClaim、API/恢复 | Goal 01 Platform Contract、02 |
| 10 | [人工/AI 协作与 Overlay](./goal-10-human-ai-collaboration-overlay.md) | Profile-neutral Interaction、Workspace、Handoff、电话+视频主链 | Core: Goal 09；RustPBX 音频桥: Goal 07 |
| 11 | [最小 Connector 与 Pilot A](./goal-11-minimal-connector-pilot-a.md) | 一个 CRM/FSM Effect/Receipt 和完整 Tracer Pilot A | Goal 01 Market gate、02、09、10 |
| 12 | [HF Speech Runtime Core 与 Resolve B1 翻译](./goal-12-speech-runtime-hf-translation.md) | 通用 Speech contract；B1 是首个 Profile qualification | Core: Goal 09、10；B1: Goal 11；Native adapter: Goal 08 |
| 13 | [AI-native Orchestrator 与跨渠道接管](./goal-13-agent-orchestrator-cross-channel-handoff.md) | AgentRun/Task/Context、ResponseLease、Agent/Human handoff | Goal 09、10、Goal 12 Core |
| 14 | [Action 与 Durable Workflow](./goal-14-action-durable-workflow.md) | Proposal→Intent→Receipt、审批、reconcile、compensation | Goal 02、09、13；真实动作另需 Profile Gate |
| 15 | [Context、Knowledge、Studio 与 Governance](./goal-15-context-knowledge-studio-governance.md) | Memory/Playbook/Eval/Release/Shadow/Canary/rollback | Goal 12 Core、13、14 |
| 16 | [Resolve Assist V1、商业化与生产闭环](./goal-16-v1-pilot-commercial-production.md) | 3 Pilot/2 转年约、ROI、70% 毛利；只签署首个 Profile | Resolve Market、11、B1 与适用平台 Gate |
| 17 | [条件式 ViLTE/未来电信](./goal-17-vilte-future-telecom-conditional.md) | IMS/ViLTE AV Gateway/Data Channel 的独立条件式 Option | Goal 02、07、08 + 自身商业/实验网 Gate |

## 3. 依赖图

```text
G00 → G01(platform contract) → G02
                    ├→ G03 → G04 → G05 → G06
                    │                  └→ G07 → G08
                    └→ G09 → G10 → G11
                         G01(resolve market) ───┘

G09 + G10 ───────────────────────────→ G12(core) → G13
G11 ─────────────────────────────────→ G12(resolve B1)
G08 ─────────────────────────────────→ G12(native/bridge adapter qualification)
G02 + G09 + G13 ─────────────────────→ G14 → G15

Resolve market + G11 + B1 + applicable platform gates ──> G16
G02 + G07 + G08 + operator/profile/lab/business gate ──> G17
```

图只表示最强顺序。具体 Goal 文件中的依赖表是最终裁决。

G11/G16 是首个 Resolve Profile 的外部商业路线。若其真实依赖缺失而进入
`blocked_external`，不依赖该 Profile 的 Horizontal Platform Goal 可以按自己的 Gate 继续；
不得伪造市场证据，也不得把后续工作偷换成第二个未经批准的 Profile。

## 4. 完成语义

Goal 只能使用以下结果：

| 状态 | 含义 |
| --- | --- |
| `completed` | 全部适用 Gate 有直接证据，Required Artifact 已提交 |
| `completed_design_only` | 文件明确允许设计完成，但不授予 runtime/production |
| `blocked_external` | 所有离线工作完成，仍缺文件列明的真实外部条件 |
| `not_run` | 没有执行或证据不足 |
| `rejected` | Stop Gate 触发，路线停止且原因可审计 |
| `conditional` | 外部启动 Gate 尚未满足，只允许文件规定的设计/接口工作 |

不能用“代码已写”“测试大部分通过”或“上游宣称很快”替代 `completed`。

机器可读顺序、依赖、初始状态和文件哈希见 [manifest.json](./manifest.json)，结构约束见
[manifest.schema.json](./manifest.schema.json)。

## 5. 全局来源

- [通信 R5 总设计](../docs/design/unified-communication-foundation-r5.md)
- [AI-native 多模态通信与业务执行平台 R2](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)
- [ADR-CCAAS-11：Engagement 与 Resolution Profile](../docs/adr/ccaas-11-engagement-platform-and-resolution-profile.md)
- [通信 R5 Machine Contract](../docs/capacity/contracts/unified-communication-foundation-r5-v1.json)
- [通信 R5 Traceability](../docs/capacity/contracts/unified-communication-foundation-r5-traceability-v1.json)
- [通信 R5 TDD 计划](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md)
- [通信 R4 整合设计](../docs/design/rvoip-converact-communication-foundation-integration-design.md)
- [R4 VOS5000/100K 计划](../docs/design/communication-foundation-vos5000-parity-performance-plan.md)
- [Resolve Assist 垂直 Profile R1](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)

旧 Goal 0–11 和既有 G01–G07 代码只作为实现事实与需求来源，必须经 Goal 00 映射后才能
进入新执行线。

这 18 个 Goal 覆盖 Horizontal Foundation、首个 Resolve Profile 和一个条件式 ViLTE
Option，不声称穷举未来所有 Contact Center、Agent、咨询、运营或 OEM Profile。新增 Profile
必须建立新的 Goal/合同，不能塞进 G16 冒充原范围。
