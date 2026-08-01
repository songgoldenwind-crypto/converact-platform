# Goal 17 — 条件式 ViLTE 与未来电信视频

## 1. Identity

| 字段 | 值 |
| --- | --- |
| Goal ID | `G17` |
| 初始状态 | `conditional` |
| 前置 Goal | G02、G07、G08 `completed`；ViLTE 独立外部 Gate 全部满足 |
| 解锁 | ViLTE/5G New Calling 独立产品 Option |
| Authority | Operator IMS/Call、Converact IMS Control/AV Gateway、LiveKit Room/SFU 分离 |
| 主要来源 | [平台 R2 §3.4、§10.4](../docs/design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)、[ADR 10](../docs/adr/ccaas-10-vilte-livekit-av-participant-gateway.md)、[通信 R5 A0–A5](../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md) |

## 2. External start gate

运行时实现只能在以下条件全部真实存在后开始：

1. 已签运营商或大型设备商客户需求与预算；
2. 冻结目标 3GPP Release、GSMA/运营商 Profile、SIP/IMS option tags、precondition、QoS、
   emergency/regulatory 和 roaming 范围；
3. 冻结至少一组真实网络、号码/SIM、IMS trunk、证书、终端型号/固件与 browser/seat matrix；
4. 可用的互通/实验网、合法 H.264/AMR/EVS/G.729 codec 分发决定、测试窗口和责任人；
5. G02 平台安全底座、G07 Voice↔LiveKit handoff 与 G08 通信资格已通过；ViLTE 自己的
   buyer/budget/Offer/Deployment Gate 已冻结。只有明确作为 Resolve Assist 组合 Offer
   交付时，才额外要求 G16 的 Resolve Profile Gate；其他场景不依赖 Resolve 成败。

缺任一项时，只允许完成 A0 合同、harness 与接口预留，状态为 `completed_design_only` 或在
全部离线工作后 `blocked_external`；不得启动生产实现、采购或容量声明。

## 3. Binding objective

在 Gate 满足后，作为独立 Deployment Option 实现真正双向的 4G ViLTE/未来 IMS 音视频与
LiveKit 坐席互通：

```text
Operator IMS/ViLTE
  ↔ Converact IMS Control Adapter
  ↔ Converact AV Media Gateway
  ↔ LiveKit Room/Participant/WebRTC
```

LiveKit SIP 不支持视频的限制不能被绕过或掩盖；视频必须经过独立双向 AV Gateway participant。
RustPBX/Call Core 继续拥有 Converact telephony routing/business decision，LiveKit 继续拥有 Room/
WebRTC/SFU，运营商保留 IMS session authority。语音↔视频切换复用 durable generation handoff。

## 4. Required outcomes

1. 冻结四个模块：Operator Conformance Profile、IMS Control Adapter、AV Media Gateway、
   IMS Data Channel Gateway/DCS；控制、媒体和数据不能混成一个 adapter。
2. 建立 SIP/IMS/SDP corpus：audio/video m-lines、H.264 profile-level-id/packetization-mode、
   AMR/AMR-WB/EVS/G.729、precondition、UPDATE/PRACK/re-INVITE、hold/resume、fork、
   transfer、DTMF、early media、voice↔video upgrade/downgrade。
3. AV Gateway 实现 carrier→LiveKit 与 LiveKit→carrier 两个独立方向，再组成双向 four-edge
   bridge；A1/A2 结果不互相继承。
4. 实现 RTP/RTCP/SRTP、key/security domain、SSRC/timestamp/RTCP feedback、lip sync、
   jitter/loss、PLI/FIR/NACK、H.264 passthrough/transcode 和 audio codec conversion。
5. 实现 WebRTC participant lifecycle、ICE/DTLS/SRTP、publication/subscription、
   simulcast/track state 和 Room cleanup；AV gateway 是 participant，不是第二 SFU。
6. 实现 voice-only→video、video→voice、ViLTE↔LiveKit↔ordinary RTPengine 的 durable
   prepare/commit/abort/query/reconcile；新 generation、one writer、recording/billing/
   consent continuity。
7. Data Channel/DCS 作为独立授权资源，支持协商、schema、message ordering、size/rate、
   privacy 和 failure；不得把 arbitrary IMS data 当媒体 Track。
8. 完成 terminal/network/operator/browser matrix、short/30m/2h/8h、mobility/handover、
   rotation、codec/security、fault、quality、capacity 和 regulatory evidence。
9. 建立 AV、audio-only、Data Channel、recording、AI/Vision 与 mixed-cell 独立容量 profile；
   不继承 audio Bridge 或 bridge-excluded 证据。

## 5. Required artifacts

输出到 `architecture-foundation/execution/goal-17/`：

- `vilte-option-gate-and-scope.md`
- `operator-conformance-profile-v1.json` 与 schema
- `ims-control-contract-v1.json` 与 schema
- `av-media-gateway-contract-v1.json` 与 schema
- `ims-data-channel-contract-v1.json` 与 schema
- `sip-ims-sdp-corpus-manifest-v1.json` 与 schema
- `voice-video-handoff-contract.md`
- `terminal-network-interoperability-matrix.md`
- `security-regulatory-fault-review.md`
- `source-test-path-map.md`
- `2026-07-31-goal-17-vilte-tdd-plan.md`
- `evidence-index-v1.json` 与 schema
- `independent-review.md`

## 6. TDD and implementation order

1. A0：只做 exact profile、machine contracts、corpus、fake carrier + real browser harness。
2. 外部 Gate 全部验证后，先写 IMS transition/SDP/security/codec 的失败与 property tests。
3. A1：carrier video→LiveKit；A2：LiveKit video→carrier；分别真实互通和取证。
4. A3：双向 AV four-edge bridge、lip sync、passthrough/transcode。
5. A4：voice→video、video→voice、failure degradation 与回到 RTPengine。
6. Data Channel/DCS 独立接入和安全测试。
7. A5：terminal/network matrix、长稳、移动、故障、capacity、regulatory 与独立审查。

## 7. Acceptance gates

- 所有 External start gate 有可审计 Evidence；否则无 runtime code 资格。
- 真实运营商/IMS 与至少冻结终端矩阵完成互通；fake carrier 只授权 harness。
- A1/A2/A3/A4 每项有独立真实媒体、codec、security、quality、fault 和 cleanup Evidence。
- audio/video upgrade/downgrade 无双 writer、重复 billing/recording 或 orphan participant。
- lip sync、packet loss/jitter、H.264 feedback、codec conversion、mobility 和 8h long session
  达到冻结门槛。
- IMS/AV/Data Channel/LiveKit/RustPBX Authority 分离，任一附加能力故障按合同降级。
- AV capacity 使用独立 generator/profile；不继承 G07 audio 或 G08 ordinary capacity。
- 法律、频谱/电信、privacy、emergency、recording 和 codec distribution 审查通过。

## 8. Explicit non-goals

- 不在没有客户、Profile、终端和实验网时实现“通用 ViLTE”。
- 不通过 LiveKit SIP 发送视频。
- 不让 RustPBX 成为 WebRTC SFU，也不让 LiveKit 接管 IMS routing。
- 不把 IMS Data Channel 当普通 WebRTC DataStream 直接透传。
- 不用模拟器、单方向或短呼叫宣称生产 ViLTE。

## 9. Completion and commit boundary

A0 设计合同可单独提交并标记 `completed_design_only`。A1–A5 只有在外部 Gate 通过后按方向、
切换、数据和 Evidence 分窄提交。全部生产 Gate 通过才为 `completed`；否则保持
`conditional/blocked_external/not_run`。

## 10. create_goal summary

```text
Execute every clause of the binding full objective
`/Users/songjinfeng/Projects/converact-worktrees/platform/goals/goal-17-vilte-future-telecom-conditional.md`
using its manifest SHA-256 only after G02/G07/G08 and every independent ViLTE
external start gate.
Obey PROGRAM-RULES.md.

Without a signed operator/device customer, frozen 3GPP/GSMA/operator profile,
real IMS network/SIM/certificates/terminals/lab, a ViLTE buyer/Offer gate and
legal codec decisions,
complete only A0 contracts/harness and stop design-only or blocked_external.
When authorized, build separate IMS Control, bidirectional AV Gateway
participant, Data Channel/DCS and Operator Profile modules. LiveKit SIP remains
audio-only; real carrier<->LiveKit video uses independent A1/A2 then A3/A4
voice-video handoff with one writer, recording/billing/consent continuity and
return to RTPengine. Require G16 only when ViLTE is explicitly packaged with
Resolve Assist. Require real terminal/network, codec/security/lip-sync,
mobility, 8h, fault and separate AV capacity evidence. Do not touch production
or claim simulated/one-way results; unproved items remain not_run.
```
