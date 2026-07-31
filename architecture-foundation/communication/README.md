# OPC 通信底座文档包

## 1. 状态结论

通信底座的设计包在文档层面已经完整：

- R5 binding objective、总设计、机器合同、Schema、traceability 和 TDD 计划齐全；
- R5 delta 共 66 条，完整继承 R4 的 362 条 requirement/status；
- Kamailio、Unified RustPBX、rvoip slice、RTPengine、`voice-media-rs`、LiveKit、
  G.729、Voice/Video handoff 和 ViLTE/AV Gateway 的 Authority 已明确；
- 当前服务器冻结、运行开关、容量和生产资格边界已显式记录。

这里的“完整”不等于实现完成。R5 当前是 `accepted architecture / target`，
`runtime_enablement=false`、`production_eligible=false`；任何未执行证据仍为
`not_run`。

## 2. Revision 5 当前权威文件

| 顺序 | 文件 | 作用 | SHA-256 |
| --- | --- | --- | --- |
| 1 | [Binding Objective](../../docs/capacity/contracts/unified-communication-foundation-r5-objective.md) | 人类可读的完整绑定目标和禁止项 | `86ec798d2aafeb9e7b7f4f413d8a8b2a61d48e9ae8328f7bbc79cc391436469f` |
| 2 | [R5 总设计](../../docs/design/unified-communication-foundation-r5.md) | 统一通信、媒体、Agent/Speech、LiveKit 和 ViLTE 总架构 | `d89b6f0115ea23772d7312c407c0b4038c91107da01d120028754f92da1c10f8` |
| 3 | [Machine Contract](../../docs/capacity/contracts/unified-communication-foundation-r5-v1.json) | 机器可验证的 Authority、故障域、Gate 和状态合同 | `00790bb78abdd0b2a78c70c0193479421cc6998ec2be629d1cdffa288fa7b544` |
| 4 | [Machine Contract Schema](../../docs/capacity/schemas/unified-communication-foundation-r5.schema.json) | R5 machine contract JSON Schema | `8f7087c6b7f9a2b93b186630df86c6d534c507819684223a197ca584369ac0ce` |
| 5 | [Traceability](../../docs/capacity/contracts/unified-communication-foundation-r5-traceability-v1.json) | R4 继承和 66 条 R5 delta 的逐项追踪 | `9d3eeed14f04d6fb4b9541a2fcf4af529b7c7a92626cc6e98c50e9404e2e8abf` |
| 6 | [Traceability Schema](../../docs/capacity/schemas/unified-communication-foundation-r5-traceability.schema.json) | 追踪矩阵 JSON Schema | `644d335dacd58ccc3a3849d8ddaa4849faca60a9f06ca2cd0a3f274e7071a6da` |
| 7 | [R5 TDD 实施计划](../../docs/design/2026-07-31-unified-communication-foundation-r5-implementation-plan.md) | R5 fault-domain、Speech/Agent、AV 和 mixed-cell 增量计划 | `ccad57bee3902d8fff84e26c7f91645ce02aede67bf3e628fb89ff989e729c4b` |
| 8 | [ADR-CCAAS-9](../../docs/adr/ccaas-9-channel-agent-and-speech-runtime.md) | Channel Agent、HF Speech Runtime 和 AI Authority | `b65d3b13a11eb903c82ee0f4ffd0e2dae9ef291abfc416544fa892097cb900dd` |
| 9 | [ADR-CCAAS-10](../../docs/adr/ccaas-10-vilte-livekit-av-participant-gateway.md) | ViLTE 与 LiveKit 双向 AV Participant Gateway | `0fc13ad3d446ea62e6592c684a98728a4acba9f064643e576486937c89f5771e` |
| 10 | [统一领域语言](../../CONTEXT.md) | Authority、Call、Media、Agent、Speech 和 Handoff 术语 | `f47c081d8b2d6790861bcb909880dd9cf389e7ca71e6fe3c8e619026b9a54977` |
| 11 | [设计导航](../../docs/design/README.md) | 文档关系和新旧裁决导航 | `a9f99b4c771f2a1e13afee93530399e15286a5d5302a832c9e246fea6b04f5d2` |

裁决优先级以 R5 总设计为准：

```text
R5 binding objective
  > R5 machine contract / traceability
  > R5 design + ADR-9/10
  > R4 machine contract / traceability
  > R4 design + ADR-5/7/8
  > 旧 AI、语音、产品和实施参考
```

## 3. Revision 4 继续绑定的文件

R5 是组合继承，不是重新抄写 R4。以下文件继续是通信底座的绑定组成部分：

### 3.1 R4 目标、机器合同和追踪

- [R4 Binding Objective](../../docs/capacity/contracts/unified-voice-foundation-r4-objective.md)
- [R4 Machine Contract](../../docs/capacity/contracts/unified-voice-foundation-r4-v1.json)
- [R4 Machine Contract Schema](../../docs/capacity/schemas/unified-voice-foundation-r4.schema.json)
- [R4 Traceability](../../docs/capacity/contracts/unified-voice-foundation-r4-traceability-v1.json)
- [R4 Traceability Schema](../../docs/capacity/schemas/unified-voice-foundation-r4-traceability.schema.json)

R5 固定继承身份：

| Artifact | 固定 SHA-256 / 数量 |
| --- | --- |
| R4 objective | `9435c3e28f46f43906d325bb325253da2ecb448d257533547740073d9132bc54` |
| R4 machine contract | `87d8bb604a78550cd298a9056913e4841805708e740a4a8fde81ddf16ccffd39` |
| R4 traceability | `ff6cfdc9253fc12e4c816c2ff2a792250ef2fafc17437213e61502c8d170ee14` |
| R4 trace rows | `362` |

### 3.2 R4 架构和实施

- [RustPBX × rvoip 整合设计](../../docs/design/rvoip-opc-communication-foundation-integration-design.md)
- [VOS5000 对标与 100K 性能计划](../../docs/design/communication-foundation-vos5000-parity-performance-plan.md)
- [ADR-CCAAS-5：Media Authority 与 RTPengine](../../docs/adr/ccaas-5-media-authority-and-rtpengine.md)
- [ADR-CCAAS-7：RustPBX 与 rvoip 能力吸收](../../docs/adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md)
- [ADR-CCAAS-8：Voice/SIP 与 LiveKit Handoff](../../docs/adr/ccaas-8-voice-livekit-bridge-handoff.md)
- [R4 TDD 实施计划](../../docs/superpowers/plans/2026-07-29-unified-voice-foundation-r4.md)

R4 中未通过、未执行或 deferred 的要求不会因为 R5 文档齐全而自动升级。

## 4. Supporting / provenance

下列资料继续提供实现事实和来源证明，但不提升为新的并列 Authority：

- `rvoip-capability-integration-v1.json` 及其 Schema；
- Goal 1–4 的机器合同、实施计划和 Evidence；
- RTPengine、RustPBX、LiveKit、录音、G.729 和容量原始 Evidence；
- 历史 Goal 1–11、Revision 3 review 和生产热修记录。

查看运行证据时必须回到原始 `docs/evidence/`、`docs/capacity/` 和测试结果，不能用本清单
代替 Evidence。

## 5. 仍未完成的事项

- R5 delta 开发尚未因文档归档自动授权；
- HF 相对原生链路的延迟、VAD、质量和成本 A/B 为 `not_run`；
- ViLTE 双向 AV、H.264、mixed-cell 和 100K 组合容量未获得生产证据；
- G.729 工程要求继续绑定，但分发/启用仍受独立法律与供应链 Gate；
- 当前生产服务器冻结策略不因本目录建立而改变。
