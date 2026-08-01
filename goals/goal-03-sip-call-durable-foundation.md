# Goal 03 — SIP 与 Durable Call Foundation

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G03` |
| 初始状态 | `not_run` |
| 前置 Goal | G00、G02 `completed` |
| 解锁 | G04、G05、G06、G07 |
| Authority | Unified RustPBX 拥有 Native Call/Leg/业务 Dialog 与 durable effect |
| 主要来源 | [通信 R4 §1、§6–§7](../docs/design/rvoip-converact-communication-foundation-integration-design.md)、[R4 实施路线](../docs/design/communication-foundation-vos5000-parity-performance-plan.md)、[通信 R5 F0](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md) |

## 2. Binding objective

建立不依赖具体 `rsipstack` 或 rvoip 类型的 `SipFoundation`、统一 Call/Leg 模型和 durable
Effect/Receipt 事实账本。保证 INVITE/REGISTER 等 wire 行为、100 Trying 时限、transaction/dialog
恢复、幂等副作用、rolling schema、clock、drain 和 single-process fault domain 可验证，为后续
rvoip 逐层吸收和媒体切换提供稳定外观。

本 Goal 不替换完整 SIP 栈，也不允许两套业务 Call Authority 并存。

## 3. Required outcomes

1. 冻结 `CallId`、`LegId`、`ProtocolDialogId`、`TransactionId`、`MediaSessionId`、
   `InteractionId` 与 correlation/tenant/owner epoch/generation 规则；SIP Call-ID 不等于业务 CallId。
2. 冻结 `SipFoundation` 的 ingress/egress、originate/answer/terminate、provisional/final、
   transaction/dialog、SDP、timer、DNS/transport 和 error/hangup-cause 接口。
3. 建立 wire freeze corpus：INVITE、ACK、BYE、CANCEL、REGISTER、OPTIONS、re-INVITE、
   UPDATE、PRACK、REFER、NOTIFY、100rel、fork、auth、DTMF 与 malformed traffic。
4. 建立 `SipEffect`、`EffectReceipt`、idempotency key、query/reconcile、unknown、
   accepted/completed/state-observed 与 durable effect ledger。
5. 建立 INVITE ingress 的 100 Trying budget、durable-store SLO、overload/load-shed 和
   fail-closed/temporary-unavailable 行为；不因同步持久化无限阻塞 SIP。
6. 建立 Call actor/registry 的 bounded mailbox、owner fencing、recovery scope、timer
   restoration、duplicate/reorder、split-brain prevention 和 orphan reconciliation。
7. 建立 rolling schema、monotonic timer、wall-clock audit、clock jump/skew、drain、
   new-call placement、active-zero 和 restart contract。
8. 隔离 native/unsafe parser、worker crash、panic、OOM pressure 和 blocking call，证明单个
   协议/媒体 worker 故障不摧毁整个进程的既有 Call registry。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-03/`：

- `sip-call-foundation-design.md`
- `sip-foundation-contract-v1.json` 与 schema
- `call-leg-state-machine-v1.json` 与 schema
- `sip-effect-receipt-contract-v1.json` 与 schema
- `wire-freeze-corpus-manifest-v1.json` 与 schema
- `recovery-clock-drain-contract.md`
- `fault-and-threat-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-03-sip-call-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit current rsipstack/RustPBX/rvoip-facing types and call paths;标出兼容层与删除门槛。
2. 先写 ID、state transition、wire corpus、100 Trying、receipt 与 recovery 失败测试。
3. 以最小接口包住当前生产实现；业务层不得泄漏底层 SIP 类型。
4. 实现 durable effect ledger、query/reconcile 和 crash/restart replay。
5. 完成 overload、store latency、clock jump、duplicate/reorder、node loss 与 drain 测试。
6. 运行真实 SIP peer/interoperability 与长呼叫控制测试，再做容量/延迟基线。
7. 独立审查 Authority、wire compatibility、复杂度和故障域。

## 6. Acceptance gates

- 同一业务 Call 的多 Dialog/Leg、fork、transfer、CANCEL/BYE race 和 re-INVITE 状态无歧义。
- wire-freeze corpus 在变更前后语义相同；差异必须有显式版本与兼容决定。
- 100 Trying、final response 和 overload 行为达到合同预算并有原始 latency distribution。
- duplicate、reorder、timeout、unknown、crash/restart 不产生重复外部副作用或重复 CDR。
- durable store 慢/不可用时行为有界；已建立 Call 的媒体不依赖同步 store。
- restart、rolling upgrade、clock skew/jump、drain 与 active-zero 可重复验证。
- 热路径没有全局扫描、无界 mailbox、每消息数据库往返或不可解释分配回归。
- 当前实现、目标实现与 production eligibility 状态分开；无借用 rvoip benchmark。

## 7. Explicit non-goals

- 不在本 Goal 替换 parser/transport/transaction/dialog 全栈。
- 不实现 codec、RTPengine fast path、LiveKit bridge 或 AI。
- 不让 Kamailio 的 Edge Authority 进入 RustPBX。
- 不以“Exactly Once”描述网络；使用 idempotent effect + observation/reconcile。
- 不删除 rsipstack 或重复实现，直到 G06 drain/active-zero Gate。

## 8. Completion and commit boundary

按 contract/corpus、tests、foundation implementation、recovery/evidence 分窄提交。建议最终
状态提交意图：`feat(voice): establish durable sip call foundation`。任何未证明项保持
`not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-03-sip-call-durable-foundation.md`
using its manifest SHA-256 after G00 and G02 complete. Obey PROGRAM-RULES.md.

With TDD, establish a stable SipFoundation, unified Call/Leg identifiers and
state machine, wire-freeze corpus, durable SipEffect/Receipt ledger,
100-Trying/store-SLO behavior, owner fencing, recovery, clock, rolling-schema
and drain contracts. Wrap the current implementation first; do not replace the
whole SIP stack or create a second Call authority. Prove bounded overload,
duplicate/reorder/crash/restart behavior, interoperability and hot-path
performance. Do not touch production or delete rsipstack yet. Anything
unproved remains not_run.
```
