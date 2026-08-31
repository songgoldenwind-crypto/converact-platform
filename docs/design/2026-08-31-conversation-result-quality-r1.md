# Conversation Result & Quality R1

> 状态：`accepted_design / implementation_not_run / production_not_run`
>
> 日期：2026-08-31
>
> 范围：AI 外呼首个功能闭环的 final transcript、业务结果、质检与 Bad Case

## 1. 目标与当前差距

D7 要把一次电话 Interaction 的最终对话证据变成可查询、可重试、可审计的 Rust 权威：

- final transcript segment 按稳定 ID、source event 与 generation 幂等写入；
- outcome 使用 Agent Release 固定的 schema revision 校验；
- summary、intent、disposition 和结构化业务字段形成独立版本投影；
- evaluation 使用固定 rubric revision，平台重新计算总分和 Bad Case；
- transcript、outcome、evaluation 任一异步链失败都不影响已建立通话，也不触发重拨；
- 旧 TypeScript QM/API 只作为兼容基线，完成 writer switch 前不是新对象权威。

当前 Rust Worker 仅持有 `final_transcript_segments` 和 bounded outcome code；旧 TypeScript
`qm_evaluations` 使用自由 JSON、`call_session_id` 和运行时建表。它们不能证明完整投影或生产资格。

## 2. Authority

| 领域 | 唯一 Authority | 规则 |
| --- | --- | --- |
| Call/Leg/CDR | RustPBX | 提供电话事实，不写业务 outcome 或 QM |
| final transcript observation | Converact Conversation Evidence Store | Active Call/Speech 只上报 final segment |
| outcome schema 与 evaluation rubric | immutable Agent Release | 运行中不能跟随 `latest` |
| business outcome | Converact Result Core + Store | 模型只能提出候选，Core 校验后提交 |
| evaluation/Bad Case | Converact Quality Core + Store | Core 复算总分和派生 Bad Case |
| Campaign 联系人状态 | AI Outbound Core | 只消费已提交 outcome receipt |
| Dashboard/API | Rust read projection | 不能成为第二 writer |

`InteractionId` 是跨 AI/human/AI 的稳定聚合键；`CallAttemptId` 标识一次物理拨号；
`ChannelAgentSessionId` 只用于来源关联，不能替代前两者。

## 3. 领域对象

### 3.1 FinalTranscriptSegment

每段必须包含 tenant、`TranscriptSegmentId`、`InteractionId`、`CallAttemptId`、可选 `CallId`、
source `EventId`、speaker、language、`ExecutionGeneration`、单调 segment sequence、bounded final
text、start/end monotonic offset、observed wall time、retention policy ref 和 canonical payload hash。

- partial/delta 不落 durable 表；
- exact `(tenant, segment_id, payload_hash)` replay 返回原 receipt；
- 同 ID 不同 payload、重复 sequence 不同 segment、负/倒序时间 fail closed；
- 迟到旧 generation 可保存为审计 segment，但标记 `historical`，不能改变当前 owner 或执行 Tool；
- `Debug`、错误、metric 和 receipt 不包含 transcript text。

### 3.2 ConversationResult

结果以 `(tenant, interaction_id, result_revision)` 版本化：

- source `AgentReleaseId`、Outcome Schema Revision 和 transcript snapshot digest；
- bounded summary artifact/text policy；
- closed intent/disposition/outcome code；
- schema-validated bounded attributes；
- confidence 使用有限精度整数基点，不使用浮点作为幂等输入；
- producer、created time、canonical payload hash 和 immutable receipt。

新版本只能引用同一 Interaction/Attempt/Release，revision 必须连续。旧版本不可原地覆盖。

### 3.3 Evaluation

`EvaluationId` 绑定 result revision、`EvaluationRubricRevisionId` 和 evaluator release：

- rubric 固定 dimension ID、权重、required evidence、pass/warn/fail threshold；
- evaluator 只返回每维整数基点分、evidence segment refs、violation codes 与建议；
- Core 校验维度全集、引用归属和分值范围，并按固定权重重新计算 overall；
- `BadCase` 由 overall threshold、强制 violation 或人工标记派生，模型不能直接决定；
- evaluation 可由更高 rubric revision 重跑，但旧结果保持不可变；
- 人工 appeal/override 后续使用独立 receipt，不改写原 evaluation。

## 4. 生命周期与异步隔离

```text
collecting_final_segments
  -> transcript_finalized
  -> result_pending
  -> result_projected
  -> evaluation_pending
  -> evaluated

任一异步 effect unknown -> reconcile_required
确定性无足够证据       -> incomplete（可补偿，不伪造）
```

Call terminal、CDR、Agent close、最后一段 transcript 和 Tool receipt 可以乱序。Completion
Coordinator 只在显式 observed flags 满足策略时冻结 transcript snapshot；不假设某个 webhook 最后。
摘要/结果/QM 使用 durable job + prepare/finalize/query receipt。队列满或 Provider 故障只积压 D7，
不能反压 RTP/SIP、结束媒体或创建新拨号。

## 5. PostgreSQL 与 API

新增 additive 表：

- `converact_conversation_transcript_segments`；
- `converact_conversation_snapshots`；
- `converact_conversation_results`；
- `converact_conversation_evaluations`；
- `converact_conversation_bad_cases`；
- `converact_conversation_projection_commands/receipts`。

全部以 tenant 作为复合键并启用/强制 RLS；payload 与 receipt 不可变；claim 使用 bounded batch、
database clock、lease/fence 和 `FOR UPDATE SKIP LOCKED`。文本列受长度和 retention 约束，列表查询不
默认返回全文。

首轮 Rust canonical API：

- `GET /internal/voice-agent/interactions/{id}/result`；
- `GET /internal/voice-agent/interactions/{id}/transcript?cursor=&limit=`；
- `GET /internal/voice-agent/interactions/{id}/evaluations`；
- `GET /internal/voice-agent/quality/bad-cases?cursor=&limit=`。

分页必须有界、tenant-bound，详情权限和 transcript retention 分开检查。旧 TS API 在迁移期映射只读
响应；禁止双写同一新实体。

## 6. 安全、隐私与可维护性

- transcript/summary 是敏感数据，不进入普通日志、metric、panic 或 Debug；
- Agent Release 明确 retention、redaction、region、consent 和可见角色；
- Prompt、Provider metadata、音频和 secret 不进入 result payload；
- provider/evaluator 崩溃由独立 Worker 隔离，RustPBX 和活动媒体无依赖；
- evaluation 失败不删除 transcript/outcome，Dashboard 以独立状态显示积压；
- 热路径不做全表扫描、全 transcript 复制或同步 LLM/QM 调用。

## 7. 精准验证与状态

首轮仅证明：

- Rust ID、bounded model、payload hash、rubric calculation 和 Bad Case derivation；
- PostgreSQL schema/CAS/idempotency/receipt 的静态和受控合同；
- Worker 在 duplicate、out-of-order、stale generation、provider unknown 下收敛；
- Rust API tenant isolation、bounded pagination 和无全文列表响应。

物理 PostgreSQL、真实 Active Call/Speech/RustPBX、真实 LLM evaluator、真实 UI、性能、容量、
长稳、生产部署和旧 writer switch 在有直接证据前保持 `not_run`。
