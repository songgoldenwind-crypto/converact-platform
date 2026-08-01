# Converact Fabric 通信底座文档清单

## Revision 5 当前权威集

1. [Binding Objective](../capacity/contracts/unified-communication-foundation-r5-objective.md)
2. [R5 总设计](../design/unified-communication-foundation-r5.md)
3. [Machine Contract](../capacity/contracts/unified-communication-foundation-r5-v1.json)
4. [Machine Contract Schema](../capacity/schemas/unified-communication-foundation-r5.schema.json)
5. [Traceability](../capacity/contracts/unified-communication-foundation-r5-traceability-v1.json)
6. [Traceability Schema](../capacity/schemas/unified-communication-foundation-r5-traceability.schema.json)
7. [R5 TDD 实施计划](../design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md)
8. [ADR-CCAAS-9：Channel Agent 与 Speech Runtime](../adr/ccaas-9-channel-agent-and-speech-runtime.md)
9. [ADR-CCAAS-10：ViLTE 与 LiveKit AV Gateway](../adr/ccaas-10-vilte-livekit-av-participant-gateway.md)
10. [统一领域语言](../../CONTEXT.md)
11. [设计导航](../design/README.md)

通信的上位业务关联由 [平台范围 R2](../design/2026-07-31-ai-native-multimodal-communications-execution-platform-r2.md)
与 [ADR-CCAAS-11](../adr/ccaas-11-engagement-platform-and-resolution-profile.md) 定义；
它们不改变 R5 的 SIP/媒体 Authority、性能 Gate 或 machine contract。

R5 delta 共 66 条，完整继承 R4 的 362 条 requirement/status。R5 当前是
`accepted architecture / target`，不是 production eligibility 声明。

## Revision 4 继续绑定的文件

### 目标、合同和追踪

- [R4 Binding Objective](../capacity/contracts/unified-voice-foundation-r4-objective.md)
- [R4 Machine Contract](../capacity/contracts/unified-voice-foundation-r4-v1.json)
- [R4 Machine Contract Schema](../capacity/schemas/unified-voice-foundation-r4.schema.json)
- [R4 Traceability](../capacity/contracts/unified-voice-foundation-r4-traceability-v1.json)
- [R4 Traceability Schema](../capacity/schemas/unified-voice-foundation-r4-traceability.schema.json)

### 架构和实施

- [RustPBX × rvoip 整合设计](../design/rvoip-converact-communication-foundation-integration-design.md)
- [VOS5000 对标与 100K 性能计划](../design/communication-foundation-vos5000-parity-performance-plan.md)
- [ADR-CCAAS-5：Media Authority 与 RTPengine](../adr/ccaas-5-media-authority-and-rtpengine.md)
- [ADR-CCAAS-7：RustPBX 与 rvoip 能力吸收](../adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)
- [ADR-CCAAS-8：Voice/SIP 与 LiveKit Handoff](../adr/ccaas-8-voice-livekit-bridge-handoff.md)
- [R4 TDD 实施计划](../plans/2026-07-29-unified-voice-foundation-r4.md)

## 固定继承身份

| Artifact | SHA-256 / 数量 |
| --- | --- |
| R4 objective | `9435c3e28f46f43906d325bb325253da2ecb448d257533547740073d9132bc54` |
| R4 machine contract | `87d8bb604a78550cd298a9056913e4841805708e740a4a8fde81ddf16ccffd39` |
| R4 traceability | `ff6cfdc9253fc12e4c816c2ff2a792250ef2fafc17437213e61502c8d170ee14` |
| R4 trace rows | `362` |
| R5 delta rows | `66` |

R4/R5 的未通过、`not_run` 或 deferred 要求不会因为文档集中存放而自动升级。
