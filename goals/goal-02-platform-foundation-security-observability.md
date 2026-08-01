# Goal 02 — 平台、安全与可观测基础

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G02` |
| 初始状态 | `not_run` |
| 前置 Goal | G00 `completed`；G01 `platform_contract_gate_completed` |
| 解锁 | G03、G05、G09 |
| Authority | Tenant/Identity/Consent/Audit/Billing/Observability 平台基础 |
| 主要来源 | [平台 R2 §3–§5、§7、§10](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[Resolve Profile R1 W8](../docs/design/2026-07-31-ai-native-multimodal-resolution-platform-r1.md)、[通信 R4 §1.3–§1.5](../docs/design/rvoip-converact-communication-foundation-integration-design.md)、[通信 R5 F0](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md) |

## 2. Binding objective

先建立通信与 Engagement/Profile 都依赖的平台护栏，再增加新业务能力。实现可版本化的 Tenant、
Identity、Consent、Policy、Event、Audit、Billing、Secret/Key、Observability、Deployment
和 DR 基础，并证明数据库、事件、对象存储、PKI/KMS、DNS、配置、时钟、AI/GPU 与录音故障
不会因果性中断已经建立的人与人媒体。

平台基础不是一个热路径总线。普通 RTP/SRTP 仍必须绕开数据库、HTTP、AI 和通用 Event。

## 3. Required outcomes

1. 冻结 Tenant/Subject/Service Identity、role/capability、session/token、revocation 与 cross-
   tenant fail-closed 模型；Edge-to-Core 使用 mTLS 或等价强身份。
2. 冻结电话、视频、录音、转写、翻译、AI、工具动作各自的 Consent、purpose、retention、
   legal hold、deletion 与 region policy。
3. 建立 versioned Event envelope、outbox/inbox、idempotency、ordering scope、schema rolling
   compatibility、unknown event 和 replay contract。
4. 建立 append-only Audit 与 Effect/Receipt 关联；区分 accepted、completed、state-observed。
5. 建立 usage/billing ledger；每个 directed media-edge generation、AI run、recording segment
   和外部 action 只有一个 billing key 与 writer。
6. 建立 Secret/Key/Certificate 生命周期、rotation、redaction、core-dump 和 native/unsafe/FFI
   Gate；Evidence、日志和 Prompt 不得泄漏密钥。
7. 建立 metrics/log/trace/correlation contract，覆盖 Engagement、Profile、Interaction、
   CommunicationSession、Call、Leg、Room、Resolution、Action、AgentRun、media-edge generation
   与 owner epoch；Profile type 不进入无界高基数标签。
8. 建立 bounded worker、backpressure、bulkhead、circuit breaker、load shedding、health、
   readiness、drain、rolling deploy、backup/restore 和 DR contract。
9. 建立 monotonic/wall-clock 分工、deadline/skew/jump 行为和跨节点时钟观测。
10. 建立全 Fault Matrix：DB、event、object store、PKI/KMS、DNS、config、clock、AI/GPU、
    recording upload、provider 和 node crash。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-02/`：

- `platform-foundation-design.md`
- `platform-authority-and-data-classification.md`
- `identity-consent-policy-v1.json` 与 schema
- `event-audit-billing-contract-v1.json` 与 schema
- `observability-correlation-contract-v1.json` 与 schema
- `fault-matrix-v1.json` 与 schema
- `threat-model.md`
- `recovery-drain-and-dr-plan.md`
- `source-test-path-map.md`
- `2026-07-31-goal-02-platform-foundation-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

Goal 00 选定执行根后，TDD plan 必须列出精确实现与测试文件，禁止泛写“增加服务”。

## 5. TDD and implementation order

1. Current-state audit：复用、隔离或淘汰现有 identity/event/audit/billing/observability。
2. 先写 schema compatibility、tenant isolation、consent、idempotency 和 clock 的失败测试。
3. 实现最小 deep-module interfaces，不把所有域耦合进一个共享数据库事务。
4. 先完成 single-node crash/restart、rolling schema 和 key rotation，再完成 multi-node DR。
5. 对每个外部依赖注入 timeout、partition、duplicate、reorder、stale token 和 clock fault。
6. 在真实长媒体会话旁运行故障矩阵，确认控制/AI/录音故障不终止 Human Communication。
7. 运行安全、恢复、容量与独立评审，按单一意图提交。

## 6. Acceptance gates

- cross-tenant 数据、token、Room、Call、Evidence 和 Action 访问全部 fail closed。
- rolling N/N-1 schema/event compatibility、duplicate/reorder/replay 和 unknown 处理有测试。
- mTLS identity、rotation、revocation、过期和 PKI/KMS 故障符合合同；无长期例外。
- Audit/usage/billing 可从 Receipt 与 generation 重建，重复输入不重复计费。
- DB/Event/Object Store/AI/GPU/Recording/Config/DNS/Clock 故障不因果性中断已建立媒体；
  受影响附加能力可降级并可 reconcile。
- bounded queue/retry/fan-out 有容量与过载 Evidence；没有全局热锁、无界积压或每包外部 I/O。
- backup/restore、node loss、rolling upgrade、drain 和 region recovery 均有原始 Evidence。
- threat/failure/unsafe review 无未解决高风险项。

未完成真实故障、长稳或恢复验证的能力保持 `not_run`，不得标记 production eligible。

## 7. Explicit non-goals

- 不实现 SIP、codec、RTPengine、LiveKit handoff、Engagement/Profile 或 Agent 业务。
- 不让 Event Bus、数据库或 Observability 成为媒体转发依赖。
- 不创建第二 Call、Room、Engagement/Resolution、Recording 或 Billing Authority。
- 不修改生产容器，不用当前服务器替代可复现实验环境。
- 不一次性重写现有平台；通过小接口和兼容迁移推进。

## 8. Completion and commit boundary

按合同/schema、基础实现、fault/recovery Evidence 分成窄提交。最后提交必须只在所有适用 Gate
通过后更新 status；任何未证明项保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-02-platform-foundation-security-observability.md`
using its manifest SHA-256 after G00 and the G01 contract gate. Obey
PROGRAM-RULES.md.

Build the horizontal platform foundation before new communication or Engagement/Profile
features: tenant/identity/consent, strong Edge-to-Core identity, versioned
events, audit, billing, secrets/keys, observability, bounded workers,
deployment/drain/DR, clock and rolling-schema contracts. Use TDD and exact
source/test paths chosen after G00. Prove cross-tenant fail-closed behavior and
that DB/event/object-store/PKI/DNS/config/clock/AI/GPU/recording faults do not
causally interrupt established human media. No production changes or hot-path
global dependencies. Anything unproved remains not_run.
```
