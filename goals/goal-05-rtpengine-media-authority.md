# Goal 05 — RTPengine 与统一媒体 Authority

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G05` |
| 初始状态 | `not_run` |
| 前置 Goal | G02、G03、G04 `completed` |
| 解锁 | G06、G07、G08 |
| Authority | RTPengine ordinary fast path；Media Plan/Edge 归 Unified RustPBX；decoded processing 归 embedded `voice-media-rs` |
| 主要来源 | [ADR 5](../docs/adr/ccaas-5-media-authority-and-rtpengine.md)、[通信 R4 §6.6、§8–§9](../docs/design/rvoip-converact-communication-foundation-integration-design.md)、[VOS-EQ 计划 §7–§9](../docs/design/communication-foundation-vos5000-parity-performance-plan.md) |

## 2. Binding objective

实现一套 Logical Media Graph/Media Plan Authority 和互斥 Backend 执行路径：普通
RTP/RTCP/SRTP/NAT anchoring 长期默认由外部 RTPengine 执行；需要 decode/transcode/mix/
play/recording tap/AI tap 的 Edge 由 Unified RustPBX 进程内 `voice-media-rs` 固定 worker
shard 执行。首期不把 `voice-media-rs` 当第二个网络服务，也不把尚不存在的 Rust-native
fast path 冒充现成产品。

每个 directed Edge generation 只能有一个 writer；物理 allocation 以 immutable Backend
Binding Group generation 和 Wire Transport Bundle 为原子生命周期。

## 3. Required outcomes

1. 冻结 MediaDemand、MediaPlan、DirectedMediaEdge、BindingGroupGeneration、
   WireTransportBundle、ProcessingSession、ReservationReceipt、WriterFence 与
   RecordingManifest 类型及 O(1) hot-path identity。
2. 实现 `BackendCapabilitySet`，绑定 source/binary/config digest；能力为 unknown、
   `not_run`、过期或粒度粗于目标 Edge 时 fail closed。
3. 实现 reservation → `prepared_blocked` → durable decision → commit/revoke/abort →
   query/reconcile；prepare 到 commit 的 outbound datagram delta 必须为零。
4. 实现 initial SDP 与 active migration 两套规则；active Edge 不原地换 Backend，
   membership/backend/port/key/writer 变化创建新 generation。
5. RTPengine Adapter 覆盖 RTP/RTCP/SRTP、IPv4/IPv6、NAT、ICE bridge、SDP、QoS/TOS、
   DTMF、fork、statistics、timeout 和 userspace/kernel profile。
6. `voice-media-rs` 以 library + bounded worker shards 嵌入；G.711、Opus、G.729、
   jitter、resample、transcode、IVR、N-1 mix、conference、decoded dual-track recording
   和 AI tap 通过统一 facade。
7. DTMF 只有一个业务副作用 Authority：RTPengine/SIP INFO/in-band detector 作为 source，
   经 Leg sequence/dedup 后才推进业务；handoff grace 旧 generation 不产生副作用。
8. 一个 recording role 一个 capture owner；capture、spool、upload、object store 分离，
   upload/storage 故障不拖垮 media capture 或普通通话。
9. 实现 zero-live-ref release、terminal tombstone、partial commit compensation、unknown
   freeze/reconcile、restart leak scan 和 active-zero deletion。
10. 对算法、allocation、lock/atomic、syscall、queue、NUMA/NIC 和 P99 影响逐项审查。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-05/`：

- `media-authority-and-backend-design.md`
- `media-plan-contract-v1.json` 与 schema
- `backend-capability-contract-v1.json` 与 schema
- `atomic-binding-lifecycle-v1.json` 与 schema
- `media-demand-dtmf-recording-contract.md`
- `rtpengine-source-config-patch-lock.md`
- `voice-media-rs-embedding-plan.md`
- `fault-threat-and-complexity-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-05-media-authority-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit current RTPengine control、media-control、voice-media-rs library/binary 与录音路径。
2. 先写 capability fail-closed、generation invariants、prepare-zero-output、writer uniqueness、
   idempotency、partial failure 和 leak fixtures。
3. 以 adapter 包住现有实现，完成 RTPengine atomic lifecycle；若上游协议无法表达，则用
   exact-source patch set，固定 patch identity。
4. 嵌入 bounded `voice-media-rs` worker；先 G.711/Opus，再集成 G.729 和 decode features。
5. 实现 DTMF authority、recording source chain 与上传隔离。
6. 完成 crash/restart、unknown、port exhaustion、store slow、worker panic、recorder full、
   RTPengine loss 和 active migration 故障注入。
7. 完成真实 RTP/SRTP、互通、长稳、性能和独立审查。

## 6. Acceptance gates

- ordinary Edge 默认只由 RTPengine 写；decode-required Edge 只由 embedded worker 写；
  不存在双 SDP、双 relay、双 DTMF 或双 recording Authority。
- duplicate prepare/commit/revoke/abort/query 返回一致 receipt；same identity/different hash
  fail closed；unknown 冻结 mutation 并最终 reconcile。
- prepare ACK 到 commit ACK 前 TX=0；old revoke ACK 后 TX 永久为 0；writer 不重叠。
- cancel、timeout、crash、restart、partial commit 后 port/session/key/reservation/writer
  全部可收敛到零。
- Backend capability 与 exact source/config 绑定且 fail closed；userspace/kernel 证据分开。
- codec/AI/recording/upload/storage worker 故障不终止无关 SIP 或 ordinary relay。
- RTP/RTCP/SRTP、DTMF、hold、re-INVITE、fork、recording、mix 与 long call 有真实 Evidence。
- hot path bounded、无每包 durable I/O/HTTP/task/global scan；性能无不可解释回归。

## 7. Explicit non-goals

- 不把 RTPengine 替换为未实现的 Rust-native 服务。
- 不让 rvoip runtime、RTPengine 和 voice-media-rs 同时拥有 ordinary wire SDP。
- 不让 `voice-media-rs` 首期通过 HTTP/gRPC 成为第二媒体控制 Authority。
- 不用 codec microbenchmark 授权生产媒体容量。
- 不修改生产 RTPengine 或容器。

## 8. Completion and commit boundary

按 contracts/tests、RTPengine lifecycle、embedded media、recording/DTMF、evidence 分窄提交。
RTPengine 仍是长期默认性能底线；候选 Backend 只能在 G08 同硬件资格通过后改变新 Edge
selector。任何未证明项保持 `not_run`。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-05-rtpengine-media-authority.md`
using its manifest SHA-256 after G02/G03/G04. Obey PROGRAM-RULES.md.

Implement one Media Plan/Edge authority. Keep RTPengine as the long-term
ordinary RTP/RTCP/SRTP fast-path floor and embed voice-media-rs as bounded
in-process workers only for decode/transcode/mix/play/record/AI edges. Build
fail-closed source-bound BackendCapabilitySet and atomic binding-group
prepare/commit/revoke/abort/query/reconcile with zero output before commit,
single writer per edge generation, DTMF single authority, recording isolation,
leak recovery and active-zero deletion. Use TDD, real media and failure
evidence. Do not create or claim an existing Rust-native fast-path service,
touch production, or borrow capacity evidence.
```
