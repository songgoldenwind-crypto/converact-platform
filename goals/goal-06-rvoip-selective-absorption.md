# Goal 06 — rvoip 选择性吸收与重复实现收敛

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G06` |
| 初始状态 | `not_run` |
| 前置 Goal | G03、G05 `completed` |
| 解锁 | G08；为后续维护提供唯一 SIP/媒体底层 |
| Authority | Unified RustPBX 保持 Call/业务 Authority；只吸收低层 rvoip slice |
| 主要来源 | [ADR 7](../docs/adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)、[通信 R4 §2、§7–§8、§14](../docs/design/rvoip-converact-communication-foundation-integration-design.md) |

## 2. Binding objective

以可测量的逐层资格流程吸收 rvoip 中真正优于现有实现的 parser/serializer、SDP、transport、
transaction、dialog、RTP primitive、jitter 或 codec primitive。rvoip 不是第二个 PBX、
Endpoint/Orchestrator、Call registry、media runtime 或生产节点；不能因为同为 Rust 或上游
公开 benchmark 就假定组合后更快。

目标是超过或等于两者中可证明的优点，同时减少双 Authority 和维护歧义；代码重复本身不是
删除理由，正确性、功能完整、故障隔离、可维护性和同条件性能才是决定依据。

## 3. Required outcomes

1. 固定 rvoip exact source commit、crate/dependency graph、feature、license、unsafe/native、
   maintenance health 与上游测试；只 vendor/absorb 经批准的 slice。
2. 为每个候选建立 `keep_current`、`wrap_rvoip`、`absorb_source`、`rewrite` 或 `reject`
   decision，记录功能、RFC、错误接受范围、复杂度、allocation、lock、syscall、性能、维护、
   安全和迁移成本。
3. 建立 shadow harness：同一真实/模糊 SIP corpus 同时进入 current 与 rvoip；shadow 不发
   response、不建第二 transaction/dialog、不修改状态或计费。
4. 逐层迁移顺序固定为 parser/serializer/SDP → transport/DNS → transaction → dialog；
   每层单独 wire diff、interoperability、fuzz、recovery 和性能 Gate。
5. 业务层只依赖 G03 `SipFoundation`；不得暴露 rsipstack/rvoip 高层类型。
6. RTP/media primitive 只能进入 G05 embedded worker 内部；ordinary RTPengine 与 Wire SDP
   Authority 不改变。
7. 每次晋级只移动 new calls；old calls 由旧实现继续到 drain，按 source/backend/version
   观测；active-zero 后才允许删除。
8. 删除前证明 source reference、feature、test、metric、runbook、schema 和 rollback 全部
   收敛；保留迁移 tombstone 与可审计 benchmark。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-06/`：

- `rvoip-source-and-slice-inventory.md`
- `slice-decision-matrix-v1.json` 与 schema
- `shadow-corpus-contract-v1.json` 与 schema
- `sip-layer-migration-state-machine.md`
- `compatibility-performance-protocol.md`
- `drain-active-zero-deletion-plan.md`
- `supply-chain-native-safety-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-06-rvoip-absorption-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit current call graph and exact candidate symbols after G00 index is current。
2. 锁定 source，先为 shadow no-side-effect、wire equivalence 和 differential fuzz 写失败测试。
3. 只接入 parser/serializer/SDP shadow；达到 Gate 后再选择 keep/absorb/reject。
4. transport、transaction、dialog 每层单独重复 shadow→canary new calls→drain→active-zero。
5. RTP/jitter/codec primitive 在 embedded media 测试域单独 A/B；不得更改 ordinary selector。
6. 对每层运行 malformed/fuzz、真实 peer、NAT/DNS/TLS、fork/race/recovery、long call、
   same-hardware performance 和 failure isolation。
7. 删除失败的一套之前做独立 review；删除只是最终结果，不是完成指标。

## 6. Acceptance gates

- Shadow 在任何输入下无外部 response、timer owner、dialog、port、CDR、billing 或 recording
  副作用。
- 每个吸收 slice 的功能/RFC corpus 不低于现有实现，且性能比较固定相同硬件、source、
  build、traffic 和功能。
- 错误接受/拒绝差异、serializer wire diff 与 SDP negotiation 全部显式裁决。
- transaction/dialog fork、CANCEL/BYE、100rel、auth、DNS/transport failover、restart 与
  timer race 有真实 Evidence。
- 没有 rvoip Endpoint/Orchestrator/Call registry/registrar/proxy 高层进入产品 Authority。
- new-call canary、rollback、old-call drain、active-zero 与 deletion reference scan 通过。
- 最终每个领域只有一套权威实现；被拒绝 slice 保留理由，不为“融合”而强行采用。
- 任何性能或功能未证明项保持 `not_run`，上游 claim 仅为调研输入。

## 7. Explicit non-goals

- 不把 rvoip 44 个 crate 全部平铺进产品 Workspace。
- 不一次性删除 rsipstack/rustrtc/audio-codec 或重写全部 SIP/RTP。
- 不引入 rvoip 高层 session/orchestrator/client 作为第二产品核心。
- 不用代码行数减少代替正确性和可维护性。
- 不在 active calls 上原地热换协议或媒体实现。

## 8. Completion and commit boundary

每层至少使用独立提交：source lock/harness、shadow、canary、drain、delete。只有所有已选择
slice 完成且重复 Authority active-zero，G06 才能 `completed`；明确 reject 的 slice 不阻塞，
但必须有 Evidence。未评估 slice 保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-06-rvoip-selective-absorption.md`
using its manifest SHA-256 after G03/G05. Obey PROGRAM-RULES.md.

Selectively evaluate and absorb only low-level rvoip slices. Lock exact source,
build, license and unsafe boundaries; decide keep/wrap/absorb/rewrite/reject for
each slice using RFC/functionality, differential fuzz, maintenance, failure
isolation and same-hardware performance evidence. Run no-side-effect shadow
first, then parser/SDP, transport, transaction and dialog as separate
new-call canary/drain/active-zero migrations. Keep Unified RustPBX as Call
authority and RTPengine as ordinary media authority; reject rvoip high-level
runtime/orchestrator. Do not delete old code until active-zero and reference
scan. Upstream claims never authorize production; unproved items remain
not_run.
```
