# Goal 08 — 通信 VOS-EQ 与 100K 生产资格

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G08` |
| 初始状态 | `not_run` |
| 前置 Goal | G03–G07 `completed` |
| 解锁 | G17；为 G12 Native adapter 与选择 Native/Bridge Option 的 G16 提供对应资格 |
| Authority | Capacity profile/finalizer 只签署其固定 workload；不改变运行时 Authority |
| 主要来源 | [VOS5000/100K 完全体计划](../docs/design/communication-foundation-vos5000-parity-performance-plan.md)、[通信 R5 Evidence](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md) |

## 2. Binding objective

在 exact hardware、独立负载发生器、真实 SIP/RTP/SRTP/LiveKit 依赖与不可变 Evidence 下，
证明通信底座的功能完整、故障隔离、长稳、单机密度、近线性扩展和 100K 平台能力。性能第一，
但普通语音、SRTP、录音、转码、G.729、Bridge、Speech/AI tap、AV 和 mixed-cell 必须使用
独立 profile；不能用缺少功能的快路径数字、上游 benchmark 或线性外推替代。

所有目标在实际通过前仍是 `not_run`，当前 safe capacity 保持 `none`。

## 3. Required outcomes

1. 冻结 profile/finalizer schema、SUT/source/image/config/model/hardware/kernel/BIOS/NIC/NUMA/
   clock/workload/seed/failure reserve 和 raw evidence identity。
2. 建立合格独立 SIP/RTP/RTCP/SRTP/LiveKit generator/receiver fleet；generator CPU/NIC/
   queue/clock 留有 headroom，不能与 SUT 共用瓶颈。
3. 独立执行 V1-RTP、V1-SRTP、V2 recording、V3-A G.711↔Opus、V3-B G.729 codec pair、
   V4 AI tap、VOICE-LIVEKIT-BRIDGE-V1 与 V3-MICRO。
4. 执行 VOS-EQ-5K、VOS-EQ-10K、VOS-EQ-V2-FP/REC、VOS-EQ-V3-PROC；目标分别按绑定
   计划执行，不把探索 frontier 写成 safe capacity。
5. 执行 1/2/4/8 node、Cell-20K-VOICE-V1 N+1、单 Zone VOICE-100K-V1、双 Zone
   zone-loss、原 workload MIX-100K-v1 及需要新 Authority 时的新 revision。
6. 执行 short、30m、2h、8h、24h safe-capacity endurance、高 CPS+长呼叫、noisy tenant、
   多/单租户、recording/transcode/SRTP/ptime 比例矩阵。
7. 注入进程、node、Cell/Zone、NIC、DNS、PKI/KMS、store、object store、recording、
   provider、clock、config、RTPengine、LiveKit 与 worker fault。
8. 建立 performance regression budget：CPU/packet、PPS、P99、loss、allocation、memory、
   syscall、timer lag、setup/PDD、control queue、NIC/softnet 和 marginal efficiency。
9. 输出 CAPEX、每千并发成本、failure reserve、节点容量冗余与既有会话连续性的区别。

## 4. Binding target gates

以下是待证明目标，不是当前结论：

| 指标 | 目标 |
| --- | --- |
| 呼叫成功率 | `>=99.99%`，全部 attempted calls 在分母并 reconciliation |
| 新呼叫错误率 | `<=0.01%`，明确过载点除外 |
| 平台新增 RTP loss | `<0.1%` |
| Relay 新增延迟 | 同 Region 受控链路 `P99 <10ms` |
| SIP route | `P95 <50ms`、`P99 <100ms` |
| PDD | `P95 <300ms`、`P99 <500ms` |
| 平台新增 jitter | `P99 <10ms` |
| 录音/存储/Provider 故障导致媒体终止 | `0` |
| 正常 CPU | 总体 `<=70%`；媒体核心不持续 `>80%` |
| 扩展 | 相邻区段 marginal efficiency `>=95%`，含 failure reserve |
| 内存 | 2h 无持续增长；24h 无泄漏趋势 |

V1 32 物理核目标为 10K calls，V2 为 8K，V3-A 为 1K safe/2K frontier；这些只有在完整
硬件和 workload Gate 通过后才能签署。

## 5. Required artifacts

输出到 `architecture-foundation/execution/goal-08/`：

- `communication-qualification-master-plan.md`
- `capacity-profile-v1.schema.json`
- `evidence-finalizer-v1.schema.json`
- `generator-qualification-contract-v1.json` 与 schema
- `fault-and-endurance-matrix-v1.json` 与 schema
- `performance-regression-budget.md`
- `fleet-topology-and-runbook.md`
- `source-test-path-map.md`
- `2026-07-31-goal-08-vos-eq-100k-tdd-plan.md`
- `signed-profile-index-v1.json` 与 schema
- `capacity-and-continuity-report.md`
- `independent-review.md`

原始输出放受控 Evidence 存储并以 immutable digest 引用；不得把 secret/SDP key 入库。

## 6. Execution order

1. Audit 旧 benchmark，分类 regression-only、invalid、superseded 或可复用 harness。
2. 先用故意不合格 generator/evidence fixture 证明 finalizer fail closed。
3. 校准 generator、clock、network 与 instrumentation，再跑单功能 correctness/interoperability。
4. 依次执行 single-node staircase、frontier、24h safe capacity、fault/endurance。
5. 执行多节点 marginal scaling、Cell N+1、Zone-loss、100K 与 mixed-cell。
6. 每个正式点至少三次独立重复；失败样本不得从分母删除。
7. 独立团队/审查者复核配置、原始数据、公式、容量声明和不可继承边界。

## 7. Acceptance gates

- generator/receiver 在目标点合格；否则整轮 `invalid_generator_capacity`。
- 每个 profile 固定完整身份并通过自身 finalizer；任何 config/backend mix 改变生成新 hash。
- safe capacity 在完整门槛运行 24h；frontier 和 microbench 不授权生产。
- VOS-EQ-10K、Cell-20K N+1、VOICE-100K 单/双 Zone 与 MIX profile 各自通过，未互相冒名。
- Bridge 四路径、G.729、recording、processing、AI tap 各自 Evidence 不继承 ordinary RTP。
- failed/attempted/connected/active、resource、CDR、billing、recording 与 reservation 全量对账。
- 故障结果区分 new-call admission、existing-session continuity 和 recovery；不将容量 N+1
  描述成媒体无损 1+1。
- 只有签署 profile 更新 `safe_capacity`；其余保持 `none/not_run`。

## 8. Explicit non-goals

- 不用当前 4 vCPU 服务器签署 VOS-EQ。
- 不在本 Goal 修改生产容器、内核或网络。
- 不把 486/503、RTP echo、codec microbench 或单节点通过宣传为完整 100K。
- 不把双 Zone admission 能力宣传为故障会话零中断。
- 不使用 rvoip、RTPengine、LiveKit 或厂商公开数字作为 Converact 结果。

## 9. Completion and commit boundary

Harness/finalizer、单 profile Evidence、fleet Evidence 与最终容量声明分开提交。G08 只有在所有
绑定必需 profile 通过独立复核后为 `completed`；某 profile 失败时可保持其他真实结果，但
不能签署总体 100K。

## 10. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-08-communication-vos-eq-100k-qualification.md`
using its manifest SHA-256 after G03-G07 complete. Obey PROGRAM-RULES.md.

Produce exact-hardware, independent-generator, immutable evidence for complete
SIP/RTP/SRTP/media function, faults, long runs, VOS-EQ single-node density,
near-linear scaling, Cell N+1, single/dual-Zone VOICE-100K and the separately
bound MIX workload. Ordinary RTP, SRTP, recording, processing, G.729,
Voice-LiveKit bridge, AI tap and microbench profiles never inherit one another.
Qualify generators, run at least three repeats and 24h at safe capacity, inject
real faults, reconcile every attempted call/resource/billing/recording fact,
and independently review claims. Current capacity remains none until a profile
passes its finalizer. Do not touch production or borrow upstream benchmarks;
anything unproved remains not_run.
```
