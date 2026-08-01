# Goal 04 — 强制 G.729 Exact-source Codec

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G04` |
| 初始状态 | `not_run` |
| 前置 Goal | G03 `completed` |
| 解锁 | G05 集成、G07/G08 对应 codec profile |
| Authority | Unified Codec Registry；对外只有 `G729/8000` |
| 主要来源 | [通信 R4 §10](../docs/design/rvoip-converact-communication-foundation-integration-design.md)、[VOS-EQ 计划](../docs/design/communication-foundation-vos5000-parity-performance-plan.md) |

## 2. Binding objective

以固定、可审计的 exact source 实现生产级 G.729 工程。RTP/SDP wire codec identity 必须只有
`G729/8000`；G.729A、G.729AB、Annex B/VAD/CNG 是内部 mode 或协商参数，不得注册成并列
wire codec。工程实现、互通、质量和性能强制完成；专利/法律/供应链审查只控制分发与
enablement，不能取消代码和测试。

## 3. Required outcomes

1. 固定上游 repository、commit、tree/file hash、license、补丁、compiler、target、feature、
   build flags、native/unsafe/FFI 边界与可复现产物；禁止浮动 branch/tag。
2. 冻结统一 `CodecRegistry`、format/fmtp、payload type、packetization、sample/clock、frame、
   SID、erasure、PLC、DTMF 与 transcoder contracts。
3. 支持 G.729A 与 G.729AB internal modes；Annex B offer/answer、VAD、SID/CNG、mode switch、
   silence 与 mixed speech/SID packet 行为明确。
4. 建立标准/授权 test vectors、round-trip、bit-exact 适用项、malformed/truncated packet、
   fuzz/property 和 deterministic fixture。
5. 建立真实 SIP/RTP peer 互通矩阵：ptime、payload remap、Annex B on/off、re-INVITE、
   hold/resume、DTMF、packet loss/reorder/jitter 与 long call。
6. 建立音质 Gate：reference speech、中文/英文、男女声、噪声、双讲、串音、PLC 和 tandem
   transcode；原始音频、评分工具与 license/consent 可审计。
7. 建立性能 Gate：encode/decode/transcode 的 CPU、wall time、allocation、memory、tail
   latency 与并发；相同 source/hardware/config/workload 比较，不线性外推。
8. 建立 legal/distribution policy：build、test、package、ship、runtime-enable 分离；
   未获分发决定时功能可保持 build/test complete 但 production enablement 关闭。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-04/`：

- `g729-source-and-supply-chain-lock.md`
- `g729-codec-contract-v1.json` 与 schema
- `g729-test-vector-manifest-v1.json` 与 schema
- `g729-interoperability-matrix.md`
- `g729-quality-and-performance-protocol.md`
- `g729-legal-distribution-gate.md`
- `native-unsafe-ffi-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-04-g729-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit existing codec crates and G.729 candidates; record keep/wrap/rewrite/reject with evidence。
2. 先锁 source，再写 registry/SDP/RTP/vector/malformed/Annex B 失败测试。
3. 实现最小 encoder/decoder 和 mode/fmtp adapter，不复制第二套 codec identity。
4. 完成 fuzz、sanitizer/Miri 可适用检查、memory ownership 和 worker crash isolation。
5. 接入统一 media facade；ordinary passthrough 不得无故解码。
6. 完成真实 peer、音质、长稳、丢包与同硬件性能 Evidence。
7. 独立审查算法正确性、复杂度、供应链、法律边界与默认 enablement。

## 6. Acceptance gates

- SDP/RTP/API/metrics 中 wire identity 只有 `G729/8000`；A/AB/AB+Annex B 仅为内部 mode。
- 10-octet speech、2-octet SID、packetization、timestamp、fmtp 和 Annex B 行为通过 corpus。
- 标准/合法 vectors、malformed/fuzz、loss/jitter/reorder、re-INVITE/hold/DTMF 全部有结果。
- 至少两个独立真实 peer 或明确记录缺失的外部互通阻塞；不得用同库 loopback冒充。
- 音质、长通话、memory safety、tail latency、CPU/allocation 与目标容量有原始 Evidence。
- `voice-media-rs` 故障可隔离；codec crash 不拖垮 Call authority。
- 分发/enablement 遵循 legal Gate；工程完成状态与法律生产资格分开。

若外部 peer 或法律决定缺失，适用部分保持 `not_run`/`blocked_external`；不得降低工程 Gate。

## 7. Explicit non-goals

- 不将 G.729A、G.729AB 注册成独立 RTP codec。
- 不从二进制、不可追踪压缩包或未知授权来源复制代码。
- 不因“专利”术语暂停工程，也不擅自声称可商业分发。
- 不用 microbenchmark 替代真实 RTP/转码容量。
- 不同时保留两个生产 G.729 encoder/decoder Authority。

## 8. Completion and commit boundary

建议按 source lock/tests、implementation、media integration、evidence/legal policy 分窄提交。
只有工程 Gate 全通过才可标记 codec engineering `completed`；production enablement 独立记录。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-04-g729-exact-source-codec.md`
using its manifest SHA-256 after G03 completes. Obey
PROGRAM-RULES.md.

Implement mandatory exact-source G.729 engineering with one external
`G729/8000` wire identity and G.729A/G.729AB/Annex-B internal modes. Lock
source, hashes, build, license and FFI boundaries; use TDD for SDP/RTP,
vectors, SID/CNG, malformed traffic, loss/jitter, hold/DTMF and mode changes.
Prove independent-peer interoperability, quality, long-run safety and
same-hardware performance. Legal review controls distribution/runtime
enablement only and must remain separate from engineering completion. Do not
touch production or claim unproved evidence.
```
