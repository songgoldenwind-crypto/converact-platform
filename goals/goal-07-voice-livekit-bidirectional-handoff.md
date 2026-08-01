# Goal 07 — Voice/SIP/PSTN ↔ LiveKit 双向切换

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G07` |
| 初始状态 | `not_run` |
| 前置 Goal | G03、G05 `completed`；所用 codec slice 已完成 |
| 解锁 | G08；为 G10/G12/G16 的 RustPBX↔LiveKit 音频桥 Option 提供资格 |
| Authority | RustPBX 拥有电话 Call；LiveKit 拥有 Room/WebRTC；Converact Fabric Bridge Coordinator 拥有切换 |
| 主要来源 | [ADR 8](../docs/adr/ccaas-8-voice-livekit-bridge-handoff.md)、[通信 R4 §1.6](../docs/design/rvoip-converact-communication-foundation-integration-design.md)、[VOS-EQ Voice-LiveKit](../docs/design/communication-foundation-vos5000-parity-performance-plan.md) |

## 2. Binding objective

实现一个 durable、idempotent、可恢复的双向 Bridge/Handoff：新呼叫与 active Call 均可在
Voice/SIP/PSTN 和 LiveKit Room/browser 之间建立或切换，并可反复回到 RTPengine ordinary
fast path。业务 `InteractionId/CallId/CDR/rating session/root RecordingManifest` 在切换中
稳定；每次切换创建新 bridge/Edge/Binding generation，不复活已 revoke generation。

当前 LiveKit SIP 视频能力不能被假定存在：SIP bridge 只承载音频；Room 中的视频轨道始终由
LiveKit 管理。用户体验可从 SIP 音频切到 LiveKit 音频+视频并返回，但 RustPBX 不成为第二
视频 SFU。

## 3. Required outcomes

1. 实现 `prepare/commit/abort/query/reconcile` Bridge state machine、bridge head CAS、
   owner epoch、generation、attempt、terminal tombstone 和 crash recovery。
2. 四条路径独立实现并取证：`V2L_NEW`、`L2V_NEW`、`V2L_ACTIVE`、`L2V_ACTIVE`；任何方向
   或 new/active 结果不得互相继承。
3. 每条双向 audio Edge generation 一个 writer、一个 billing key/rating session；
   candidate commit 前 TX=0，old revoke ACK 后 TX 永久为 0。
4. 强类型 command token 绑定 tenant/interaction/bridge/generation/operation/idempotency/
   expiry/key；cancel 与 webhook 使用 hash、sequence、pinned issuer 和 bounded reorder。
5. participant、SIP leg、port pair、Backend allocation、reservation、writer、pending command、
   receipt 的资源模型有界；final cleanup 幂等且全部归零。
6. 处理 RTP/SRTP、ICE/DTLS、BUNDLE/MID、codec/transcode、DTMF、early media、hold/resume、
   mute、blind/consultative transfer、browser reconnect、Room end、SIP BYE 与竞态。
7. Recording 在同一 root manifest 下形成连续 source segment chain；consent、coverage gap、
   checksum、retention 与 legal hold 可审计，上传故障不影响通话。
8. LiveKit/RTPengine/RustPBX/store/recording/network 故障各自定位；失败回退普通 RTPengine，
   不重复 CDR、计费、录音或 DTMF 副作用。
9. 测量 switch gap/loss/reorder/duplicate；不具备 blocked gate 时明确使用 break-before-make，
   不宣称 seamless/zero-loss。
10. 完成短通话、30 分钟、2 小时、8 小时和同一 Call 32 次 V2L↔L2V 往返。

## 4. Required artifacts

输出到 `architecture-foundation/execution/goal-07/`：

- `voice-livekit-handoff-design.md`
- `bridge-state-machine-v1.json` 与 schema
- `bridge-command-token-v1.json` 与 schema
- `bridge-webhook-reconcile-v1.json` 与 schema
- `recording-billing-continuity-contract.md`
- `four-path-evidence-contract-v1.json` 与 schema
- `security-fault-resource-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-07-voice-livekit-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 5. TDD and implementation order

1. Audit current bridge/placement/admission/room/participant contracts and真实 API capability。
2. 先写 state-machine property tests：new generation、one winner、no overlapping writer、
   cancel wins、terminal cannot revive、cleanup zero。
3. 实现 Fake LiveKit/RTPengine harness 和 crash/reorder/duplicate fixtures；其结果仅授权合同。
4. 依次实现 V2L_NEW、L2V_NEW、V2L_ACTIVE、L2V_ACTIVE，每条独立 feature gate/canary。
5. 接入 recording/billing/DTMF/transfer 和回到 ordinary RTPengine。
6. 用真实 RustPBX、livekit-sip、LiveKit、browser、SIP/RTP peer 完成媒体与故障测试。
7. 完成长通话、32 往返和独立 `VOICE-LIVEKIT-BRIDGE-V1` 容量准备，再独立审查。

## 6. Acceptance gates

- 相同 idempotency/hash 只产生一个 generation/participant/billing/recording intent；冲突
  hash fail closed。
- 相反方向并发 command 恰好一个 CAS winner；loser 不分配资源、不打开 writer。
- 32 次 alternating round trip 中始终一个 Call/CDR/rating/root manifest；每个旧
  generation terminal 且六类资源归零，最终 cleanup 全局归零。
- switch gap/loss、音质、DTMF、hold/transfer、reconnect、token renewal 和 recording gap
  有真实分布，不隐瞒 break-before-make。
- forged/expired token、webhook duplicate/reorder/conflict、receipt loss、crash/restart、
  provider timeout 与 orphan recovery 全部收敛。
- Human Communication 在 optional Room/video/AI/recording upload 故障时按合同继续或回退。
- 四条 path 各自有真实媒体、功能、故障、计费/录音、长稳 Evidence；mock/readiness、
  ordinary RTP 和 bridge-excluded 容量不得继承。
- LED 或其他客户应用适配问题只形成明确接口需求，不修改不归 Converact 管理的代码。

## 7. Explicit non-goals

- 不让 LiveKit 拥有 RustPBX Call/route/billing/recording decision。
- 不让 RustPBX 实现第二套 Room/SFU/ICE/DTLS/WebRTC。
- 不宣称 SIP 可承载 LiveKit 视频；ViLTE 在 G17。
- 不以一次单向短呼叫证明双向 active handoff 或长稳。
- 不修改生产容器或 LED 代码。

## 8. Completion and commit boundary

四条 path 与 recording/security/evidence 分窄提交。只有四条 path 全部达到自身 Gate，G07
才 `completed`；任何一条未跑均保持 `not_run`，不得用整体平均掩盖。

## 9. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-07-voice-livekit-bidirectional-handoff.md`
using its manifest SHA-256 after G03/G05 and required codecs. Obey
PROGRAM-RULES.md.

Build one durable idempotent prepare/commit/abort/query/reconcile bridge for
V2L_NEW, L2V_NEW, V2L_ACTIVE and L2V_ACTIVE. RustPBX retains telephony Call
authority; LiveKit retains Room/WebRTC/SFU; each switch creates new fenced
bridge/media generations with one writer, billing key and recording source
chain. Prove token/webhook security, CAS races, crash/orphan recovery,
DTMF/hold/transfer, return to RTPengine, real switch gap/loss, short/30m/2h/8h
calls and 32 alternating round trips with zero final resources. SIP bridge is
audio only; Room video stays LiveKit. Do not modify production or LED. Every
path needs its own evidence; unproved items remain not_run.
```
